import type { McpConfig } from './extensions.ts';
import { DUMMY_UPSTREAM_KEY, providerNpmForProtocol } from './agent-proxy.ts';

export type JsonRecord = Record<string, unknown>;
export const object = (value: unknown): JsonRecord | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
export const dataObject = (value: unknown) => object(object(value)?.data);
export const ENGINE_AGENT = 'patent-workbench';
export const ENGINE_PROVIDER = 'patent';
export type EngineRequest = (method: string, route: string, body?: unknown, timeoutMs?: number) => Promise<unknown>;

export function enginePermissions(custom: Record<string, McpConfig> = {}) {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'case_tools_*', resource: '*', effect: 'allow' },
    ...Object.keys(custom).map(name => ({ action: `${name}_*`, resource: '*', effect: 'allow' })),
  ];
}

export function v2Config(input: {
  modelId: string; displayName: string; protocol: string; childBaseURL: string;
  contextWindow: number; maxOutput: number; mcpUrl: string; mcpToken: string;
  systemPrompt: string; customMcp?: Record<string, McpConfig>;
}) {
  const permissions = enginePermissions(input.customMcp);
  const servers = Object.fromEntries(Object.entries(input.customMcp ?? {}).map(([name, config]) => {
    const { enabled, timeout, ...rest } = config;
    return [name, { ...rest, disabled: !enabled, codemode: false, timeout: { startup: timeout, catalog: timeout, execution: timeout } }];
  }));
  return {
    $schema: 'https://opencode.ai/config.json',
    model: { providerID: ENGINE_PROVIDER, model: input.modelId },
    default_agent: ENGINE_AGENT,
    update: 'disable', share: 'disabled', snapshots: false, plugins: [], skills: [],
    formatter: false, lsp: false, websearch: false, warming: false,
    compaction: { auto: true, keep: { tokens: Math.min(20_000, Math.floor(input.contextWindow / 4)) }, buffer: Math.min(16_000, Math.max(input.maxOutput, Math.floor(input.contextWindow / 10))) },
    permissions,
    agents: {
      [ENGINE_AGENT]: { mode: 'primary', system: input.systemPrompt, permissions },
      title: { disabled: true },
      compaction: { model: { providerID: ENGINE_PROVIDER, model: input.modelId }, permissions },
    },
    mcp: { servers: {
      ...servers,
      case_tools: { type: 'remote', url: input.mcpUrl, headers: { Authorization: `Bearer ${input.mcpToken}` }, oauth: false, disabled: false, codemode: false, timeout: { startup: 30_000, catalog: 30_000, execution: 600_000 } },
    } },
    providers: { [ENGINE_PROVIDER]: {
      name: ENGINE_PROVIDER,
      package: providerNpmForProtocol(input.protocol),
      settings: { baseURL: input.childBaseURL, apiKey: DUMMY_UPSTREAM_KEY, transport: 'http' },
      headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}` },
      models: { [input.modelId]: {
        modelID: input.modelId, name: input.displayName,
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        limit: { context: input.contextWindow, output: input.maxOutput },
      } },
    } },
  };
}

// Accept additive fields and future versions when the contract is still present.
// Runtime updates additionally pass the real synthetic model/tool acceptance probe.
export function requireV2Info(value: unknown): string {
  const info = object(value);
  if (typeof info?.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(info.version) || Number(info.version.split('.')[0]) < 2 || typeof info.pid !== 'number') {
    throw Object.assign(new Error('OpenCode 服务不支持当前工作台接口。'), { code: 'runtime_incompatible' });
  }
  return info.version;
}

export function turnMarker(runId: string) { return `<!--workbench-turn:${runId}-->`; }

export async function waitV2Tools(request: EngineRequest, names: string[], signal: AbortSignal, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let connectedAt: number | undefined;
  do {
    signal.throwIfAborted();
    const response = object(await request('GET', '/api/mcp'));
    if (!Array.isArray(response?.data)) throw Object.assign(new Error('后台工具接口格式已变化。'), { code: 'runtime_incompatible' });
    const servers = response.data.map(object);
    if (names.every(name => servers.some(s => s?.name === name && object(s.status)?.status === 'connected'))) {
      connectedAt ??= Date.now();
      // OpenCode's MCP tool registry debounces its reload for 100 ms after the
      // connection event. Connected alone can still expose an empty tool list.
      // Require a stable connection window; every candidate also proves real tool calls.
      if (Date.now() - connectedAt >= 250) return;
    } else connectedAt = undefined;
    if (servers.some(s => names.includes(String(s?.name)) && ['failed', 'needs_auth'].includes(String(object(s?.status)?.status)))) break;
    await new Promise(r => setTimeout(r, 100));
  } while (Date.now() < deadline);
  throw Object.assign(new Error('案件工具或自定义 MCP 未连接，未发送模型任务。'), { code: 'mcp_not_ready' });
}

// Read the current run, newest page first. Never mistake a previous run's idle
// record for the newly accepted inbox item. The marker is persisted by OpenCode.
export async function currentV2Messages(request: EngineRequest, sessionId: string, runId: string): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [], seen = new Set<string>();
  let cursor: string | undefined, size = 0;
  for (let page = 0; page < 100; page++) {
    const query = cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=desc';
    const response = object(await request('GET', `/api/session/${encodeURIComponent(sessionId)}/message?limit=100&${query}`));
    if (!Array.isArray(response?.data)) throw Object.assign(new Error('后台消息接口格式已变化。'), { code: 'runtime_incompatible' });
    for (const raw of response.data) {
      const row = object(raw); if (!row || typeof row.id !== 'string') continue;
      size += JSON.stringify(row).length;
      if (size > 16 * 1024 * 1024) throw Object.assign(new Error('后台消息超出读取上限。'), { code: 'response_too_large' });
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.type === 'user' && typeof row.text === 'string' && row.text.includes(turnMarker(runId))) return rows.reverse();
      rows.push(row);
    }
    const next = object(response.cursor)?.next;
    if (typeof next !== 'string' || !next || next === cursor) return [];
    cursor = next;
  }
  throw Object.assign(new Error('后台消息分页超过读取上限。'), { code: 'response_too_large' });
}

export function normalizedV2Messages(rows: JsonRecord[]) {
  return rows.filter(row => row.type === 'assistant').map(row => ({
    info: { ...row, role: 'assistant' },
    parts: (Array.isArray(row.content) ? row.content : []).flatMap((raw, ordinal) => {
      const part = object(raw); if (!part) return [];
      const state = object(part.state);
      return [{ ...part, id: typeof part.id === 'string' ? part.id : String(ordinal), tool: part.name,
        ...(part.type === 'tool' ? { state: { ...state, status: state?.status === 'streaming' ? 'pending' : state?.status } } : {}),
      }];
    }),
  }));
}

export function v2Outcome(rows: JsonRecord[]): string | undefined {
  const last = rows.at(-1);
  return last?.type === 'idle' && typeof last.outcome === 'string' ? last.outcome : undefined;
}
