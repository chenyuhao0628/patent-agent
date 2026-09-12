import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-expect-error js-yaml 为当前可 resolve 的间接依赖，打包前需改为 package.json 显式依赖。
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import type { Vault } from './service.ts';
import type { ModelAPI } from '../src/model-api.ts';
import {
  assertMaxOutputFitsContext,
  assertThinkingBudget,
  buildReasoningRequest,
  BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID,
  BUILTIN_OPENCODE_GO_PROVIDER_ID,
  CONNECTION_TEST_PROMPT,
  declaredReasoningCapability,
  effectiveProtocol,
  geminiGeneratePath,
  isModelProtocol,
  isOpenCodeGoProvider,
  isOpenCodeGoUrl,
  isOpenCodeGoV41Responses,
  joinEndpoint,
  mapOpenCodeGoV41Effort,
  normalizeEffortId,
  MODEL_CONFIG_SCHEMA,
  MODEL_LIST_MAX_PAGES,
  MODEL_REQUEST_TIMEOUT_MS,
  MODEL_RESPONSE_MAX_BYTES,
  modelIdentityKey,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_MODEL_ID,
  OPENCODE_GO_PROVIDER_NAME,
  OPENCODE_GO_SOURCE_KEY,
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
  optionalUpstreamLimit,
  parseDeclaredEfforts,
  parseDshProtocol,
  parsePositiveInteger,
  presetOpenCodeGoV41Capability,
  reasoningCapabilityFor,
  requireProtocol,
  selectionUnverified,
  testOutputBudget,
  validateBaseURL,
  VENDOR_DEFAULT_LEVEL_ID,
  type ConnectionTestResult,
  type DshImportedModel,
  type DshProviderPreview,
  type LimitSource,
  type ModelConfigPublic,
  type ModelProtocol,
  type ModelSaveInput,
  type ModelSource,
  type ProviderSaveInput,
  type GeminiThinkingMode,
  type ReasoningCapability,
  type ReasoningCapabilitySource,
  type ReasoningKind,
  type ReasoningLevel,
  type ReasoningSelection,
  type RuntimeReasoning,
  type UpstreamModel,
  type UpstreamReasoning,
} from '../src/domain/models.ts';

export type { Vault, RuntimeReasoning };

export type ModelServiceOptions = {
  root: string;
  profileKey: string | (() => string);
  getVault: () => Vault;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  generation?: () => number;
  assertWritable?: (profileKey: string) => void;
  beforeCommit?: () => void | Promise<void>;
};

/** 仅主进程 agent 使用。含明文 key 与请求头，禁止经 IPC / ModelAPI 交给渲染进程。 */
export type RuntimeModelConfig = {
  profileKey: string;
  providerId: string;
  providerName: string;
  baseURL: string;
  protocol: ModelProtocol;
  modelId: string;
  displayName: string;
  contextWindow?: number;
  maxOutput?: number;
  key: string;
  headers: Record<string, string>;
  reasoning: RuntimeReasoning;
};

type StoredModel = {
  id: string;
  modelId: string;
  displayName: string;
  protocol?: ModelProtocol;
  contextWindow?: number;
  maxOutput?: number;
  contextWindowSource: LimitSource;
  maxOutputSource: LimitSource;
  reasoningLevelId?: string;
  reasoningBudgetTokens?: number;
  reasoningAdaptive?: boolean;
  reasoningIncludeThoughts?: boolean;
  reasoningOverridden?: boolean;
  reasoningCapability?: ReasoningCapability;
  reasoningOutputEffort?: string;
  geminiMode?: GeminiThinkingMode;
};

type StoredProvider = {
  id: string;
  name: string;
  baseURL: string;
  protocol?: ModelProtocol;
  encryptedKey?: string;
  models: StoredModel[];
  source?: ModelSource;
};

type StoredConfig = {
  schema: 1;
  profileKey: string;
  providers: StoredProvider[];
  defaultProviderId?: string;
  defaultModelId?: string;
};

type AccountStamp = { profileKey: string; generation: number };

class SafeRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function assertProfileKey(profileKey: string) {
  if (!profileKey || profileKey.includes('..') || path.isAbsolute(profileKey) || /[\\/]/.test(profileKey)) {
    throw new Error('账号标识无效。');
  }
}

async function atomicJSONGuarded(file: string, data: unknown, stillValid: () => boolean) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    if (!stillValid()) throw new Error('账号已切换，本次旧页面操作未保存。');
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function seedConfig(profileKey: string): StoredConfig {
  const model: StoredModel = {
    id: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID,
    modelId: OPENCODE_GO_MODEL_ID,
    displayName: OPENCODE_GO_DISPLAY_NAME,
    contextWindowSource: 'missing',
    maxOutputSource: 'missing',
    reasoningLevelId: VENDOR_DEFAULT_LEVEL_ID,
    reasoningCapability: presetOpenCodeGoV41Capability(),
  };
  const provider: StoredProvider = {
    id: BUILTIN_OPENCODE_GO_PROVIDER_ID,
    name: OPENCODE_GO_PROVIDER_NAME,
    baseURL: OPENCODE_GO_BASE_URL,
    protocol: 'openai-responses',
    models: [model],
    source: { type: 'builtin', providerKey: 'opencode-go' },
  };
  return {
    schema: MODEL_CONFIG_SCHEMA,
    profileKey,
    providers: [provider],
    defaultProviderId: provider.id,
    defaultModelId: model.id,
  };
}

function parseSource(value: unknown): ModelSource | undefined {
  const rec = asRecord(value);
  const providerKey = asString(rec?.providerKey)?.trim();
  if (!rec || !providerKey) return;
  if (rec.type === 'dsh') return { type: 'dsh', providerKey };
  if (rec.type === 'builtin' && providerKey === OPENCODE_GO_SOURCE_KEY) return { type: 'builtin', providerKey: 'opencode-go' };
}

function parseLimitSource(value: unknown, present: boolean): LimitSource {
  if (!present) return 'missing';
  if (value === 'upstream' || value === 'manual' || value === 'missing' || value === 'dsh') return value;
  return present ? 'manual' : 'missing';
}

function parseReasoningLevel(value: unknown): ReasoningLevel | undefined {
  const rec = asRecord(value);
  const id = asString(rec?.id)?.trim();
  if (!rec || !id) return;
  const source = asString(rec.source) as ReasoningCapabilitySource | undefined;
  return {
    id,
    label: asString(rec.label)?.trim() || id,
    protocolValue: asString(rec.protocolValue) ?? '',
    source: source && ['unverified', 'codex-verified', 'upstream', 'dsh', 'official-docs', 'manual', 'preset'].includes(source) ? source : 'unverified',
    hint: asString(rec.hint),
  };
}

function parseReasoningCapability(value: unknown): ReasoningCapability | undefined {
  const rec = asRecord(value);
  if (!rec) return;
  const kind = rec.kind;
  if (kind !== 'none' && kind !== 'openai-effort' && kind !== 'anthropic-thinking' && kind !== 'gemini-thinking') return;
  const levels = Array.isArray(rec.levels) ? rec.levels.map(parseReasoningLevel).filter((item): item is ReasoningLevel => !!item) : [];
  const source = asString(rec.source) as ReasoningCapabilitySource | undefined;
  return {
    supported: rec.supported === true,
    kind: kind as ReasoningKind,
    levels: levels.length ? levels : [{ id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'unverified' }],
    allowBudget: rec.allowBudget === true,
    allowAdaptive: rec.allowAdaptive === true,
    allowOff: rec.allowOff === true,
    allowIncludeThoughts: rec.allowIncludeThoughts === true,
    allowOutputEffort: rec.allowOutputEffort === true,
    outputEfforts: Array.isArray(rec.outputEfforts) ? rec.outputEfforts.map(parseReasoningLevel).filter((item): item is ReasoningLevel => !!item) : [],
    source: source && ['unverified', 'codex-verified', 'upstream', 'dsh', 'official-docs', 'manual', 'preset'].includes(source) ? source : 'unverified',
    unverified: rec.unverified !== false,
    disabledReason: asString(rec.disabledReason),
  };
}

function parseStoredModel(value: unknown, index: number): StoredModel {
  const rec = asRecord(value);
  const id = asString(rec?.id)?.trim();
  const modelId = asString(rec?.modelId)?.trim();
  if (!rec || !id || !modelId) throw new Error(`模型配置第 ${index + 1} 条格式不正确，原文件已保留。`);
  const protocol = rec.protocol === undefined || rec.protocol === null ? undefined : rec.protocol;
  if (protocol !== undefined && !isModelProtocol(protocol)) throw new Error(`模型 ${modelId} 的协议不受支持，原文件已保留。`);
  const contextWindow = rec.contextWindow === undefined || rec.contextWindow === null ? undefined : parsePositiveInteger(rec.contextWindow, '上下文窗口');
  const maxOutput = rec.maxOutput === undefined || rec.maxOutput === null ? undefined : parsePositiveInteger(rec.maxOutput, '最大输出');
  assertMaxOutputFitsContext(contextWindow, maxOutput);
  const budget = rec.reasoningBudgetTokens === undefined || rec.reasoningBudgetTokens === null ? undefined : parsePositiveInteger(rec.reasoningBudgetTokens, '思考预算');
  const geminiMode = rec.geminiMode === 'level' || rec.geminiMode === 'budget' ? rec.geminiMode : undefined;
  return {
    id,
    modelId,
    displayName: asString(rec.displayName)?.trim() || modelId,
    protocol,
    contextWindow,
    maxOutput,
    contextWindowSource: parseLimitSource(rec.contextWindowSource, contextWindow !== undefined),
    maxOutputSource: parseLimitSource(rec.maxOutputSource, maxOutput !== undefined),
    reasoningLevelId: asString(rec.reasoningLevelId)?.trim() || VENDOR_DEFAULT_LEVEL_ID,
    reasoningBudgetTokens: budget,
    reasoningAdaptive: rec.reasoningAdaptive === true,
    reasoningIncludeThoughts: rec.reasoningIncludeThoughts === true,
    reasoningOverridden: rec.reasoningOverridden === true,
    reasoningCapability: parseReasoningCapability(rec.reasoningCapability),
    reasoningOutputEffort: asString(rec.reasoningOutputEffort)?.trim(),
    geminiMode,
  };
}

function parseStoredProvider(value: unknown, index: number): StoredProvider {
  const rec = asRecord(value);
  const id = asString(rec?.id)?.trim();
  const name = asString(rec?.name)?.trim();
  if (!rec || !id || !name) throw new Error(`供应商配置第 ${index + 1} 条格式不正确，原文件已保留。`);
  const protocol = rec.protocol === undefined || rec.protocol === null || rec.protocol === ''
    ? undefined
    : rec.protocol;
  if (protocol !== undefined && !isModelProtocol(protocol)) throw new Error(`供应商「${name}」协议不受支持，原文件已保留。`);
  let baseURL: string;
  try { baseURL = validateBaseURL(asString(rec.baseURL) ?? ''); }
  catch { throw new Error(`供应商「${name}」的 API 地址无效，原文件已保留。`); }
  if (!Array.isArray(rec.models)) throw new Error(`供应商「${name}」缺少模型列表，原文件已保留。`);
  const models = rec.models.map((item, modelIndex) => parseStoredModel(item, modelIndex));
  assertUniqueModels(models, protocol);
  const encryptedKey = asString(rec.encryptedKey)?.trim();
  return {
    id,
    name,
    baseURL,
    protocol,
    encryptedKey: encryptedKey || undefined,
    models,
    source: parseSource(rec.source),
  };
}

function assertUniqueModels(models: StoredModel[], providerProtocol?: ModelProtocol) {
  const seen = new Set<string>();
  for (const model of models) {
    const key = modelIdentityKey(model.modelId, effectiveProtocol(providerProtocol, model.protocol));
    if (seen.has(key)) throw new Error(`模型 ${model.modelId} 在同一协议下重复。`);
    seen.add(key);
  }
}

/** 上游未声明协议时，同供应商已有相同 modelId 即视为已有；明确不同协议仍可并存。 */
function discoveredAlreadyPresent(
  existing: Array<{ modelId: string; protocol?: ModelProtocol }>,
  modelId: string,
  incomingProtocol: ModelProtocol | undefined,
  providerProtocol?: ModelProtocol,
): boolean {
  if (!incomingProtocol) return existing.some(model => model.modelId === modelId);
  const identity = modelIdentityKey(modelId, effectiveProtocol(providerProtocol, incomingProtocol));
  return existing.some(model => modelIdentityKey(model.modelId, effectiveProtocol(providerProtocol, model.protocol)) === identity);
}

function parseStored(raw: unknown, profileKey: string): StoredConfig {
  const rec = asRecord(raw);
  if (!rec) throw new Error('模型配置格式不正确，原文件已保留。');
  if (rec.schema !== MODEL_CONFIG_SCHEMA) throw new Error('模型配置版本不受支持，原文件已保留。');
  if (asString(rec.profileKey) !== profileKey) throw new Error('模型配置不属于当前账号。');
  if (!Array.isArray(rec.providers)) throw new Error('模型配置格式不正确，原文件已保留。');
  const providers = rec.providers.map((item, index) => parseStoredProvider(item, index));
  const defaultProviderId = asString(rec.defaultProviderId);
  const defaultModelId = asString(rec.defaultModelId);
  if (defaultProviderId && !providers.some(provider => provider.id === defaultProviderId)) {
    throw new Error('默认供应商不存在，原文件已保留。');
  }
  if (defaultModelId) {
    const provider = providers.find(item => item.id === defaultProviderId) ?? providers.find(item => item.models.some(model => model.id === defaultModelId));
    if (!provider?.models.some(model => model.id === defaultModelId)) throw new Error('默认模型不存在，原文件已保留。');
  }
  return {
    schema: MODEL_CONFIG_SCHEMA,
    profileKey,
    providers,
    defaultProviderId,
    defaultModelId,
  };
}

function modelReasoning(provider: StoredProvider, model: StoredModel): { capability: ReasoningCapability; selection: ReasoningSelection } {
  const capability = reasoningCapabilityFor(
    provider.source,
    provider.baseURL,
    provider.protocol,
    model.modelId,
    model.protocol,
    model.reasoningOverridden ? { ...model.reasoningCapability ?? unsupportedStored(provider, model), source: 'manual', supported: true, unverified: true } : model.reasoningCapability,
  );
  const selection: ReasoningSelection = {
    levelId: model.reasoningLevelId ?? VENDOR_DEFAULT_LEVEL_ID,
    budgetTokens: model.reasoningBudgetTokens,
    adaptive: model.reasoningAdaptive,
    includeThoughts: model.reasoningIncludeThoughts,
    overridden: model.reasoningOverridden === true,
    outputEffort: model.reasoningOutputEffort,
    geminiMode: model.geminiMode,
  };
  return { capability, selection };
}

function unsupportedStored(provider: StoredProvider, model: StoredModel): ReasoningCapability {
  return reasoningCapabilityFor(provider.source, provider.baseURL, provider.protocol, model.modelId, model.protocol);
}

function toPublic(stored: StoredConfig): ModelConfigPublic {
  return {
    profileKey: stored.profileKey,
    defaultProviderId: stored.defaultProviderId,
    defaultModelId: stored.defaultModelId,
    providers: stored.providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      protocol: provider.protocol,
      hasKey: Boolean(provider.encryptedKey),
      models: provider.models.map(model => {
        const reasoning = modelReasoning(provider, model);
        return {
          id: model.id,
          modelId: model.modelId,
          displayName: model.displayName,
          protocol: model.protocol,
          contextWindow: model.contextWindow,
          maxOutput: model.maxOutput,
          contextWindowSource: model.contextWindowSource,
          maxOutputSource: model.maxOutputSource,
          reasoning,
        };
      }),
      source: provider.source,
    })),
  };
}

function toDisk(stored: StoredConfig): StoredConfig {
  return {
    schema: 1,
    profileKey: stored.profileKey,
    defaultProviderId: stored.defaultProviderId,
    defaultModelId: stored.defaultModelId,
    providers: stored.providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      protocol: provider.protocol,
      encryptedKey: provider.encryptedKey,
      models: provider.models.map(model => ({ ...model })),
      source: provider.source,
    })),
  };
}

function limitSourceForSave(previous: StoredModel | undefined, next: number | undefined, kind: 'context' | 'output'): LimitSource {
  if (next === undefined) return 'missing';
  const prevVal = kind === 'context' ? previous?.contextWindow : previous?.maxOutput;
  const prevSource = kind === 'context' ? previous?.contextWindowSource : previous?.maxOutputSource;
  if ((prevSource === 'upstream' || prevSource === 'dsh') && prevVal === next) return prevSource;
  if (prevVal === next && prevSource) return prevSource;
  return 'manual';
}

function mergeSavedModels(existing: StoredModel[], incoming: ModelSaveInput[], providerProtocol?: ModelProtocol): StoredModel[] {
  const byId = new Map(existing.map(model => [model.id, model]));
  const seenIds = new Set<string>();
  const seenIdentity = new Set<string>();
  const out: StoredModel[] = [];
  for (const item of incoming) {
    const modelId = item.modelId.trim();
    if (!modelId) throw new Error('请填写模型 ID。');
    if (item.protocol !== undefined && item.protocol !== null && !isModelProtocol(item.protocol)) throw new Error('不支持的协议类型。');
    const protocol = item.protocol === null ? undefined : item.protocol;
    const previous = (item.id ? byId.get(item.id) : undefined) ?? existing.find(model => model.modelId === modelId && (model.protocol ?? providerProtocol) === (protocol ?? providerProtocol));
    const id = previous?.id ?? item.id?.trim() ?? randomUUID();
    if (seenIds.has(id)) throw new Error('模型条目重复。');
    seenIds.add(id);
    const identity = modelIdentityKey(modelId, effectiveProtocol(providerProtocol, protocol));
    if (seenIdentity.has(identity)) throw new Error(`模型 ${modelId} 在同一协议下重复。`);
    seenIdentity.add(identity);
    const contextWindow = parsePositiveInteger(item.contextWindow, '上下文窗口');
    const maxOutput = parsePositiveInteger(item.maxOutput, '最大输出');
    assertMaxOutputFitsContext(contextWindow, maxOutput);
    const budget = parsePositiveInteger(item.reasoningBudgetTokens, '思考预算');
    const overridden = item.reasoningOverridden === true;
    const effective = effectiveProtocol(providerProtocol, protocol);
    let reasoningCapability = previous?.reasoningCapability;
    if (overridden && item.reasoningLevels?.length) {
      reasoningCapability = {
        supported: true,
        kind: effective === 'anthropic-messages'
          ? 'anthropic-thinking'
          : effective === 'gemini-generate-content'
            ? 'gemini-thinking'
            : 'openai-effort',
        levels: item.reasoningLevels,
        allowBudget: item.reasoningLevels.some(level => level.id === 'budget'),
        allowAdaptive: item.reasoningLevels.some(level => level.id === 'adaptive'),
        allowOff: item.reasoningLevels.some(level => level.id === 'none'),
        allowIncludeThoughts: effective === 'gemini-generate-content',
        allowOutputEffort: item.reasoningLevels.some(level => level.id !== 'budget' && level.id !== 'adaptive' && level.id !== 'none' && level.id !== VENDOR_DEFAULT_LEVEL_ID) && effective === 'anthropic-messages',
        outputEfforts: [],
        source: 'manual',
        unverified: true,
      };
    } else if (!overridden && previous?.reasoningOverridden) {
      reasoningCapability = previous.reasoningCapability?.source === 'manual' ? undefined : previous.reasoningCapability;
    }
    if ((item.reasoningLevelId === 'budget' || item.geminiMode === 'budget') && budget !== undefined) {
      assertThinkingBudget(budget, maxOutput);
    }
    out.push({
      id,
      modelId,
      displayName: item.displayName.trim() || modelId,
      protocol,
      contextWindow,
      maxOutput,
      contextWindowSource: limitSourceForSave(previous, contextWindow, 'context'),
      maxOutputSource: limitSourceForSave(previous, maxOutput, 'output'),
      reasoningLevelId: item.reasoningLevelId?.trim() || VENDOR_DEFAULT_LEVEL_ID,
      reasoningBudgetTokens: budget,
      reasoningAdaptive: item.reasoningAdaptive === true,
      reasoningIncludeThoughts: item.reasoningIncludeThoughts === true,
      reasoningOverridden: overridden,
      reasoningCapability,
      reasoningOutputEffort: item.reasoningOutputEffort?.trim() || undefined,
      geminiMode: item.geminiMode === 'level' || item.geminiMode === 'budget' ? item.geminiMode : undefined,
    });
  }
  return out;
}

async function readLimitedBody(response: Response): Promise<string> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader && Number(lengthHeader) > MODEL_RESPONSE_MAX_BYTES) throw new SafeRequestError('上游响应过大。');
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MODEL_RESPONSE_MAX_BYTES) throw new SafeRequestError('上游响应过大。');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MODEL_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new SafeRequestError('上游响应过大。');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function httpFailure(status: number): SafeRequestError {
  if (status === 401 || status === 403) return new SafeRequestError(`认证失败（HTTP ${status}）。`, status);
  if (status === 404) return new SafeRequestError(`接口不存在（HTTP ${status}）。该协议可能不支持此接口，请手工填写。`, status);
  if (status === 429) return new SafeRequestError(`请求过于频繁（HTTP ${status}）。`, status);
  if (status >= 500) return new SafeRequestError(`上游服务错误（HTTP ${status}）。`, status);
  return new SafeRequestError(`请求失败（HTTP ${status}）。`, status);
}

function extractUsage(json: Record<string, unknown>): ConnectionTestResult['usage'] | undefined {
  const usage = asRecord(json.usage) ?? asRecord(json.usageMetadata);
  if (!usage) return;
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const details = asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details);
  const inputTokens = num(usage.input_tokens) ?? num(usage.prompt_tokens) ?? num(usage.promptTokenCount);
  const outputTokens = num(usage.output_tokens) ?? num(usage.completion_tokens) ?? num(usage.candidatesTokenCount);
  const totalTokens = num(usage.total_tokens) ?? num(usage.totalTokenCount);
  const reasoningTokens = num(usage.reasoning_tokens) ?? num(usage.reasoningTokens) ?? num(details?.reasoning_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && reasoningTokens === undefined) return;
  return { inputTokens, outputTokens, totalTokens, reasoningTokens };
}

function extractResponsesText(json: Record<string, unknown>): string {
  if (Array.isArray(json.output)) {
    const texts: string[] = [];
    for (const item of json.output) {
      const rec = asRecord(item);
      if (!rec) continue;
      const type = asString(rec.type);
      if (type === 'reasoning') continue;
      if (type && type !== 'message') continue;
      const role = asString(rec.role);
      if (role && role !== 'assistant') continue;
      if (!Array.isArray(rec.content)) continue;
      for (const part of rec.content) {
        const p = asRecord(part);
        if (p && asString(p.type) === 'output_text' && typeof p.text === 'string') texts.push(p.text);
      }
    }
    const joined = texts.join('');
    if (joined.trim()) return joined;
    throw new SafeRequestError('连接测试未返回最终文本。');
  }
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text;
  throw new SafeRequestError('连接测试未返回最终文本。');
}

function extractChatText(json: Record<string, unknown>): string {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  if (!message) throw new SafeRequestError('连接测试未返回最终文本。');
  const content = message.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        if (part.trim()) texts.push(part);
        continue;
      }
      const rec = asRecord(part);
      if (!rec) continue;
      const type = asString(rec.type);
      if (type === 'reasoning' || type === 'thinking') continue;
      if ((type === 'text' || !type) && typeof rec.text === 'string') texts.push(rec.text);
    }
    const joined = texts.join('');
    if (joined.trim()) return joined;
  }
  throw new SafeRequestError('连接测试未返回最终文本。');
}

function extractAnthropicText(json: Record<string, unknown>): string {
  const content = Array.isArray(json.content) ? json.content : [];
  const texts: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    const type = asString(rec.type);
    if (type === 'thinking' || type === 'redacted_thinking') continue;
    if (type === 'text' && typeof rec.text === 'string') texts.push(rec.text);
  }
  const joined = texts.join('');
  if (joined.trim()) return joined;
  throw new SafeRequestError('连接测试未返回最终文本。');
}

function extractGeminiText(json: Record<string, unknown>): string {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const content = asRecord(asRecord(candidates[0])?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    const rec = asRecord(part);
    if (!rec || rec.thought === true) continue;
    if (typeof rec.text === 'string') texts.push(rec.text);
  }
  const joined = texts.join('');
  if (joined.trim()) return joined;
  throw new SafeRequestError('连接测试未返回最终文本。');
}

function extractText(protocol: ModelProtocol, json: Record<string, unknown>): string {
  if (protocol === 'openai-responses') return extractResponsesText(json);
  if (protocol === 'openai-chat-completions') return extractChatText(json);
  if (protocol === 'anthropic-messages') return extractAnthropicText(json);
  if (protocol === 'gemini-generate-content') return extractGeminiText(json);
  throw new SafeRequestError('连接测试未返回最终文本。');
}

function assertCompletion(protocol: ModelProtocol, json: Record<string, unknown>): { truncated: boolean } {
  if (json.error !== undefined && json.error !== null) throw new SafeRequestError('上游返回错误状态。');
  if (protocol === 'openai-responses') {
    const status = asString(json.status);
    if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
      const reason = asString(asRecord(json.incomplete_details)?.reason);
      if (reason === 'max_output_tokens' || status === 'incomplete' && reason?.includes('max')) {
        throw new SafeRequestError('输出被截断。请增大该模型的最大输出后重试。');
      }
      if (status === 'failed' || status === 'cancelled') throw new SafeRequestError(`连接测试失败（${status}）。`);
      if (status === 'incomplete') throw new SafeRequestError('连接测试未完成（incomplete）。');
    }
  }
  if (protocol === 'openai-chat-completions') {
    const reason = asString(asRecord(Array.isArray(json.choices) ? json.choices[0] : undefined)?.finish_reason);
    if (reason === 'length') throw new SafeRequestError('输出被截断。请增大该模型的最大输出后重试。');
  }
  if (protocol === 'anthropic-messages') {
    const reason = asString(json.stop_reason);
    if (reason === 'max_tokens') throw new SafeRequestError('输出被截断。请增大该模型的最大输出后重试。');
  }
  if (protocol === 'gemini-generate-content') {
    const reason = asString(asRecord(Array.isArray(json.candidates) ? json.candidates[0] : undefined)?.finishReason);
    if (reason === 'MAX_TOKENS') throw new SafeRequestError('输出被截断。请增大该模型的最大输出后重试。');
  }
  return { truncated: false };
}

function testRequestPath(protocol: ModelProtocol, modelId: string): string {
  if (protocol === 'openai-responses') return 'responses';
  if (protocol === 'openai-chat-completions') return 'chat/completions';
  if (protocol === 'anthropic-messages') return 'messages';
  return geminiGeneratePath(modelId);
}

function testRequestBody(protocol: ModelProtocol, modelId: string, maxOutput: number, reasoning?: Record<string, unknown>): unknown {
  const prompt = CONNECTION_TEST_PROMPT;
  if (protocol === 'openai-responses') {
    return { model: modelId, input: prompt, max_output_tokens: maxOutput, store: false, ...reasoning };
  }
  if (protocol === 'openai-chat-completions') {
    return { model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: maxOutput, ...reasoning };
  }
  if (protocol === 'anthropic-messages') {
    return { model: modelId, max_tokens: maxOutput, messages: [{ role: 'user', content: prompt }], ...reasoning };
  }
  const generationConfig = { maxOutputTokens: maxOutput, ...(reasoning ?? {}) };
  return { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
}

function readLimitFields(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = optionalUpstreamLimit(rec[key]);
    if (value !== undefined) return value;
  }
}

function parseUpstreamReasoning(protocol: ModelProtocol, rec: Record<string, unknown>): UpstreamReasoning | undefined {
  const efforts = parseDeclaredEfforts(rec.supported_reasoning_efforts)
    ?? parseDeclaredEfforts(rec.reasoning_efforts)
    ?? parseDeclaredEfforts(rec.availableEfforts)
    ?? parseDeclaredEfforts(asRecord(rec.reasoning)?.efforts)
    ?? parseDeclaredEfforts(asRecord(rec.thinking)?.efforts);
  const supportedFlag = rec.supports_reasoning === true || rec.supports_extended_thinking === true
    || asRecord(rec.reasoning)?.supported === true || asRecord(rec.thinking)?.supported === true;
  const unsupported = rec.supports_reasoning === false || asRecord(rec.reasoning)?.supported === false;
  if (!efforts && !supportedFlag && !unsupported && rec.supports_extended_thinking !== true) return;
  if (protocol === 'anthropic-messages') {
    return {
      supported: unsupported ? false : true,
      kind: 'anthropic-thinking',
      allowBudget: rec.supports_extended_thinking === true,
      allowAdaptive: asRecord(rec.thinking)?.adaptive === true || rec.supports_adaptive_thinking === true,
      allowOutputEffort: Boolean(efforts?.length),
      efforts,
    };
  }
  return {
    supported: unsupported ? false : true,
    kind: protocol === 'gemini-generate-content' ? 'gemini-thinking' : 'openai-effort',
    efforts,
    allowBudget: rec.supports_thinking_budget === true,
    allowOff: efforts?.includes('none'),
  };
}

function parseUpstreamEntry(protocol: ModelProtocol, value: unknown): UpstreamModel | undefined {
  const rec = asRecord(value);
  if (!rec) return;
  if (protocol === 'gemini-generate-content') {
    const id = asString(rec.name)?.trim() || asString(rec.id)?.trim();
    if (!id) return;
    return {
      id,
      name: asString(rec.displayName)?.trim() || undefined,
      contextWindow: readLimitFields(rec, ['inputTokenLimit', 'input_token_limit']),
      maxOutput: readLimitFields(rec, ['outputTokenLimit', 'output_token_limit']),
      reasoning: parseUpstreamReasoning(protocol, rec),
    };
  }
  const id = asString(rec.id)?.trim();
  if (!id) return;
  return {
    id,
    name: asString(rec.display_name)?.trim() || asString(rec.name)?.trim() || undefined,
    contextWindow: readLimitFields(rec, ['context_window', 'context_length', 'max_model_len', 'max_input_tokens', 'inputTokenLimit']),
    maxOutput: readLimitFields(rec, ['max_output_tokens', 'max_output', 'outputTokenLimit', 'maxOutputTokens']),
    reasoning: parseUpstreamReasoning(protocol, rec),
  };
}

function parseUpstreamPage(protocol: ModelProtocol, json: Record<string, unknown>): { models: UpstreamModel[]; hasMore: boolean; cursor?: string } {
  const rows = protocol === 'gemini-generate-content'
    ? (Array.isArray(json.models) ? json.models : null)
    : (Array.isArray(json.data) ? json.data : null);
  if (!rows) throw new SafeRequestError('上游模型列表格式无法识别，请手工填写。');
  const models = rows.map(row => parseUpstreamEntry(protocol, row)).filter((row): row is UpstreamModel => !!row);
  if (protocol === 'gemini-generate-content') {
    const token = asString(json.nextPageToken)?.trim();
    return { models, hasMore: Boolean(token), cursor: token };
  }
  const lastId = asString(json.last_id)?.trim() || models.at(-1)?.id;
  return { models, hasMore: json.has_more === true, cursor: json.has_more === true ? lastId : undefined };
}

function sameOriginToken(baseURL: string, cursor: string): string {
  if (!/^https?:/i.test(cursor)) return cursor;
  let next: URL;
  try { next = new URL(cursor); }
  catch { throw new SafeRequestError('上游分页地址无效。'); }
  const base = new URL(baseURL.endsWith('/') ? baseURL : baseURL + '/');
  if (next.origin !== base.origin) throw new SafeRequestError('不接受跨源分页地址。');
  return next.searchParams.get('pageToken') || next.searchParams.get('after_id') || next.searchParams.get('after') || '';
}

function dshLimit(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    try {
      const value = parsePositiveInteger(rec[key], '限额');
      if (value !== undefined) return value;
    } catch { /* 忽略无法作为正整数的导入字段 */ }
  }
}

function pickDshModel(item: unknown): DshImportedModel | undefined {
  const model = asRecord(item);
  const id = asString(model?.id)?.trim();
  if (!model || !id) return;
  const protocol = parseDshProtocol(model.protocol ?? model.api ?? model.apiType);
  const contextWindow = dshLimit(model, ['contextWindow', 'context_window', 'max_context', 'max_input_tokens']);
  const maxOutput = dshLimit(model, ['maxOutput', 'max_output', 'max_output_tokens', 'maxOutputTokens']);
  const efforts = parseDeclaredEfforts(model.availableEfforts) ?? parseDeclaredEfforts(model.reasoningEfforts) ?? parseDeclaredEfforts(asRecord(model.reasoning)?.efforts);
  const reasoningFlag = model.reasoning;
  let reasoning: UpstreamReasoning | undefined;
  if (efforts || reasoningFlag === true || reasoningFlag === false || asRecord(reasoningFlag)) {
    reasoning = {
      supported: reasoningFlag === false ? false : true,
      efforts,
      allowBudget: model.thinkingBudget === true || asRecord(reasoningFlag)?.allowBudget === true,
      allowAdaptive: model.adaptiveThinking === true || asRecord(reasoningFlag)?.allowAdaptive === true,
    };
  }
  let reasoningLevelId: string | undefined;
  const selected = asString(model.reasoningEffort) ?? asString(asRecord(model.reasoning)?.effort);
  if (selected) reasoningLevelId = selected;
  return {
    id,
    name: asString(model.name)?.trim() || asString(model.displayName)?.trim() || id,
    protocol,
    contextWindow,
    maxOutput,
    reasoning,
    reasoningLevelId,
  };
}

function pickDshProvider(providerKey: string, raw: unknown): DshProviderPreview | undefined {
  const rec = asRecord(raw);
  if (!rec) return;
  const baseURL = asString(rec.baseURL)?.trim();
  const apiKeyEnv = asString(rec.apiKeyEnv)?.trim();
  if (!baseURL || !apiKeyEnv) return;
  const models: DshImportedModel[] = [];
  if (Array.isArray(rec.models)) {
    for (const item of rec.models) {
      const model = pickDshModel(item);
      if (model) models.push(model);
    }
  }
  return {
    providerKey,
    displayName: asString(rec.displayName)?.trim() || providerKey,
    baseURL,
    apiKeyEnv,
    protocol: parseDshProtocol(rec.protocol ?? rec.api ?? rec.apiType),
    models,
  };
}

async function readYamlFile(file: string, label: string): Promise<unknown> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error('未找到 ' + label + '。');
    throw new Error('无法读取 ' + label + '。');
  }
  try { return loadYaml(text, { schema: JSON_SCHEMA }); }
  catch { throw new Error(label + ' 不是有效的 YAML。'); }
}

async function loadDshSettings(dshDir: string): Promise<Record<string, unknown>> {
  const dir = path.resolve(dshDir);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try { stat = await fs.stat(dir); }
  catch { throw new Error('请选择有效的 DSH 目录。'); }
  if (!stat.isDirectory()) throw new Error('请选择有效的 DSH 目录。');
  const raw = await readYamlFile(path.join(dir, 'settings.yaml'), 'settings.yaml');
  const providers = asRecord(asRecord(asRecord(raw)?.['llm-pi-ai'])?.providers);
  if (!providers) throw new Error('settings.yaml 中没有 llm-pi-ai.providers。');
  return providers;
}

async function loadDshCredentialRef(dshDir: string, envName: string): Promise<string | undefined> {
  const file = path.join(path.resolve(dshDir), '.credentials.yaml');
  let raw: unknown;
  try { raw = await readYamlFile(file, '.credentials.yaml'); }
  catch (error) {
    if ((error as Error).message.startsWith('未找到 ')) return;
    throw error;
  }
  const rec = asRecord(raw);
  if (!rec) return;
  if (rec.version !== 1) throw new Error('.credentials.yaml 仅支持 version 1。');
  const refs = asRecord(rec.refs);
  const value = refs?.[envName];
  return typeof value === 'string' && value ? value : undefined;
}

export class ModelService {
  private readonly root: string;
  private readonly profileKey: string | (() => string);
  private readonly getVault: () => Vault;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly generationFn?: () => number;
  private readonly assertWritable?: (profileKey: string) => void;
  private readonly beforeCommit?: () => void | Promise<void>;
  private gate: Promise<unknown> = Promise.resolve();
  private lastProfile?: string;
  private autoGeneration = 0;
  private lastSeenGeneration?: number;
  private readonly accountControllers = new Set<AbortController>();

  constructor(opts: ModelServiceOptions) {
    this.root = opts.root;
    this.profileKey = opts.profileKey;
    this.getVault = opts.getVault;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.requestTimeoutMs ?? MODEL_REQUEST_TIMEOUT_MS;
    this.generationFn = opts.generation;
    this.assertWritable = opts.assertWritable;
    this.beforeCommit = opts.beforeCommit;
  }

  currentProfile(): string {
    return typeof this.profileKey === 'function' ? this.profileKey() : this.profileKey;
  }

  noteAccountChange() {
    const generation = this.getGeneration();
    if (this.lastSeenGeneration !== undefined && this.lastSeenGeneration !== generation) this.abortAccountRequests();
    this.lastSeenGeneration = generation;
  }

  abortRequests() {
    this.abortAccountRequests();
  }

  getGeneration(): number {
    if (this.generationFn) return this.generationFn();
    const key = this.currentProfile();
    if (this.lastProfile !== undefined && this.lastProfile !== key) this.autoGeneration++;
    this.lastProfile = key;
    return this.autoGeneration;
  }

  configPath(profileKey: string): string {
    assertProfileKey(profileKey);
    return path.join(this.root, 'profiles', profileKey, 'models.json');
  }

  asRendererAPI(selectDshDirectory?: () => Promise<string | null>): ModelAPI {
    const api: ModelAPI = {
      list: profileKey => this.list(profileKey),
      saveProvider: (profileKey, input) => this.saveProvider(profileKey, input),
      deleteProvider: (profileKey, providerId) => this.deleteProvider(profileKey, providerId),
      setDefault: (profileKey, providerId, modelEntryId) => this.setDefault(profileKey, providerId, modelEntryId),
      testConnection: (profileKey, providerId, opts) => this.testConnection(profileKey, providerId, { modelEntryId: opts?.modelEntryId }),
      listRemoteModels: (profileKey, providerId, opts) => this.listRemoteModels(profileKey, providerId, { modelEntryId: opts?.modelEntryId }),
      addDiscoveredModels: (profileKey, providerId, models) => this.addDiscoveredModels(profileKey, providerId, models),
      previewDshProviders: dshDir => this.previewDshProviders(dshDir),
      importDshProvider: (profileKey, dshDir, providerKey) => this.importDshProvider(profileKey, dshDir, providerKey),
      cancelRequest: async () => { this.abortRequests(); },
    };
    if (selectDshDirectory) api.selectDshDirectory = selectDshDirectory;
    return api;
  }

  async list(profileKey: string): Promise<ModelConfigPublic> {
    const account = this.captureAccount();
    this.assertAccount(account, profileKey);
    const stored = await this.readStored(profileKey);
    this.assertAccount(account, profileKey);
    return toPublic(stored);
  }

  async saveProvider(profileKey: string, input: ProviderSaveInput): Promise<ModelConfigPublic> {
    return this.mutate(profileKey, stored => {
      const name = input.name.trim();
      if (!name) throw new Error('请填写供应商名称。');
      if (input.protocol !== undefined && !isModelProtocol(input.protocol)) throw new Error('不支持的协议类型。');
      if (input.clearKey && typeof input.key === 'string' && input.key.trim()) throw new Error('不能同时保存并清除密钥。');
      const baseURL = validateBaseURL(input.baseURL);
      const existing = input.id ? stored.providers.find(provider => provider.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('未找到该供应商。');
      const encryptedKey = input.clearKey ? undefined : this.encryptKeyIfProvided(input.key, existing?.encryptedKey);
      const models = input.models ? mergeSavedModels(existing?.models ?? [], input.models, input.protocol) : (existing?.models ?? []);
      const source = existing?.source;
      for (const model of models) {
        const protocol = effectiveProtocol(input.protocol, model.protocol);
        if (!protocol) {
          if ((model.reasoningLevelId && model.reasoningLevelId !== VENDOR_DEFAULT_LEVEL_ID) || model.reasoningOutputEffort) {
            throw new Error('请先选择协议，再保存思考档位。');
          }
          continue;
        }
        const capability = reasoningCapabilityFor(source, baseURL, input.protocol, model.modelId, model.protocol, model.reasoningOverridden ? model.reasoningCapability : model.reasoningCapability);
        const built = buildReasoningRequest(protocol, capability, {
          levelId: model.reasoningLevelId ?? VENDOR_DEFAULT_LEVEL_ID,
          budgetTokens: model.reasoningBudgetTokens,
          adaptive: model.reasoningAdaptive,
          includeThoughts: model.reasoningIncludeThoughts,
          overridden: model.reasoningOverridden === true,
          outputEffort: model.reasoningOutputEffort,
          geminiMode: model.geminiMode,
        }, model.maxOutput);
        if (!built.ok) throw new Error(built.message);
      }
      const provider: StoredProvider = {
        id: existing?.id ?? randomUUID(),
        name,
        baseURL,
        protocol: input.protocol,
        encryptedKey,
        models,
        source: existing?.source,
      };
      const providers = existing
        ? stored.providers.map(item => item.id === provider.id ? provider : item)
        : [...stored.providers, provider];
      return keepDefaults({ ...stored, providers });
    });
  }

  async deleteProvider(profileKey: string, providerId: string): Promise<ModelConfigPublic> {
    return this.mutate(profileKey, stored => {
      if (!stored.providers.some(provider => provider.id === providerId)) throw new Error('未找到该供应商。');
      const providers = stored.providers.filter(provider => provider.id !== providerId);
      return keepDefaults({ ...stored, providers });
    });
  }

  async setDefault(profileKey: string, providerId: string, modelEntryId: string): Promise<ModelConfigPublic> {
    return this.mutate(profileKey, stored => {
      const provider = stored.providers.find(item => item.id === providerId);
      if (!provider) throw new Error('未找到该供应商。');
      if (!provider.models.some(model => model.id === modelEntryId)) throw new Error('未找到该模型。');
      return { ...stored, defaultProviderId: providerId, defaultModelId: modelEntryId };
    });
  }

  async addDiscoveredModels(profileKey: string, providerId: string, models: UpstreamModel[]): Promise<ModelConfigPublic> {
    return this.mutate(profileKey, stored => {
      const provider = stored.providers.find(item => item.id === providerId);
      if (!provider) throw new Error('未找到该供应商。');
      const added: StoredModel[] = [];
      const nextModels = [...provider.models];
      for (const item of models) {
        const modelId = item.id.trim();
        if (!modelId) continue;
        const protocol = item.protocol && isModelProtocol(item.protocol) ? item.protocol : undefined;
        if (discoveredAlreadyPresent(nextModels, modelId, protocol, provider.protocol)) continue;
        const contextWindow = optionalUpstreamLimit(item.contextWindow);
        const maxOutput = optionalUpstreamLimit(item.maxOutput);
        try { assertMaxOutputFitsContext(contextWindow, maxOutput); }
        catch { continue; }
        const capability = item.reasoning
          ? declaredReasoningCapability(effectiveProtocol(provider.protocol, protocol), item.reasoning, 'upstream')
          : undefined;
        added.push({
          id: randomUUID(),
          modelId,
          displayName: item.name?.trim() || modelId,
          protocol,
          contextWindow,
          maxOutput,
          contextWindowSource: contextWindow === undefined ? 'missing' : 'upstream',
          maxOutputSource: maxOutput === undefined ? 'missing' : 'upstream',
          reasoningLevelId: VENDOR_DEFAULT_LEVEL_ID,
          reasoningCapability: capability,
        });
        nextModels.push(added[added.length - 1]);
      }
      const next: StoredProvider = { ...provider, models: nextModels };
      return keepDefaults({ ...stored, providers: stored.providers.map(item => item.id === providerId ? next : item) });
    });
  }

  async previewDshProviders(dshDir: string): Promise<DshProviderPreview[]> {
    const providers = await loadDshSettings(dshDir);
    const out: DshProviderPreview[] = [];
    for (const [providerKey, raw] of Object.entries(providers)) {
      const picked = pickDshProvider(providerKey, raw);
      if (picked) out.push(picked);
    }
    return out;
  }

  async importDshProvider(profileKey: string, dshDir: string, providerKey: string): Promise<ModelConfigPublic> {
    const account = this.captureAccount();
    this.assertAccount(account, profileKey);
    const providers = await loadDshSettings(dshDir);
    this.assertAccount(account, profileKey);
    const picked = pickDshProvider(providerKey, providers[providerKey]);
    if (!picked) throw new Error('未找到指定的供应商。');
    const secret = await loadDshCredentialRef(dshDir, picked.apiKeyEnv);
    this.assertAccount(account, profileKey);
    return this.mutate(profileKey, stored => {
      const existing = stored.providers.find(item => item.source?.type === 'dsh' && item.source.providerKey === providerKey);
      const protocol = picked.protocol ?? existing?.protocol;
      const importedModels: StoredModel[] = picked.models.map(model => {
        const modelProtocol = model.protocol;
        const effective = effectiveProtocol(protocol, modelProtocol);
        const capability = model.reasoning
          ? declaredReasoningCapability(effective, model.reasoning, 'dsh')
          : undefined;
        const rawLevel = model.reasoningLevelId;
        const mappedLevel = rawLevel
          ? (effective && isOpenCodeGoV41Responses(undefined, picked.baseURL, model.id, effective) ? mapOpenCodeGoV41Effort(rawLevel) : normalizeEffortId(rawLevel))
          : undefined;
        return {
          id: randomUUID(),
          modelId: model.id,
          displayName: model.name,
          protocol: modelProtocol,
          contextWindow: model.contextWindow,
          maxOutput: model.maxOutput,
          contextWindowSource: model.contextWindow === undefined ? 'missing' : 'dsh',
          maxOutputSource: model.maxOutput === undefined ? 'missing' : 'dsh',
          reasoningLevelId: mappedLevel && mappedLevel !== VENDOR_DEFAULT_LEVEL_ID ? mappedLevel : (rawLevel?.trim() || VENDOR_DEFAULT_LEVEL_ID),
          reasoningCapability: capability,
        };
      });
      let models = mergeImportedModels(existing?.models ?? [], importedModels, protocol);
      models = appendCanonicalGoEntry(models, providerKey, picked.baseURL);
      let encryptedKey = existing?.encryptedKey;
      if (secret) encryptedKey = this.encryptPlainKey(secret);
      const provider: StoredProvider = {
        id: existing?.id ?? randomUUID(),
        name: picked.displayName,
        baseURL: validateBaseURL(picked.baseURL),
        protocol,
        encryptedKey,
        models,
        source: { type: 'dsh', providerKey },
      };
      const nextProviders = existing
        ? stored.providers.map(item => item.id === provider.id ? provider : item)
        : [...stored.providers, provider];
      return keepDefaults({ ...stored, providers: nextProviders });
    }, account);
  }

  async testConnection(profileKey: string, providerId: string, opts?: { modelEntryId?: string; signal?: AbortSignal }): Promise<ConnectionTestResult> {
    const account = this.captureAccount();
    this.assertAccount(account, profileKey);
    const stored = await this.readStored(profileKey);
    const provider = stored.providers.find(item => item.id === providerId);
    if (!provider) throw new Error('未找到该供应商。');
    const model = pickModel(provider, opts?.modelEntryId);
    const protocol = requireProtocol(effectiveProtocol(provider.protocol, model.protocol));
    const reasoning = modelReasoning(provider, model);
    const built = buildReasoningRequest(protocol, reasoning.capability, reasoning.selection, model.maxOutput);
    if (!built.ok) throw new Error(built.message);
    const thinkingBudget = reasoning.selection.levelId === 'budget' || reasoning.selection.geminiMode === 'budget' ? reasoning.selection.budgetTokens : undefined;
    const thinkingEnabled = Boolean(thinkingBudget) || (reasoning.selection.levelId !== VENDOR_DEFAULT_LEVEL_ID && reasoning.selection.levelId !== 'none') || Boolean(reasoning.selection.outputEffort);
    const maxOutput = testOutputBudget(model.maxOutput, thinkingBudget, thinkingEnabled);
    const key = this.decryptKey(provider);
    const sessionId = randomUUID();
    const headers = buildRequestHeaders(provider, protocol, key, sessionId);
    const url = joinEndpoint(provider.baseURL, testRequestPath(protocol, model.modelId));
    const json = await this.fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(testRequestBody(protocol, model.modelId, maxOutput, built.fragment)),
    }, opts?.signal, account);
    this.assertAccount(account, profileKey);
    const { truncated } = assertCompletion(protocol, json);
    const text = extractText(protocol, json);
    return { ok: true, text, usage: extractUsage(json), protocol, truncated, reasoningOmitted: built.omitted };
  }

  async listRemoteModels(profileKey: string, providerId: string, opts?: { signal?: AbortSignal; modelEntryId?: string }): Promise<UpstreamModel[]> {
    const account = this.captureAccount();
    this.assertAccount(account, profileKey);
    const stored = await this.readStored(profileKey);
    const provider = stored.providers.find(item => item.id === providerId);
    if (!provider) throw new Error('未找到该供应商。');
    let protocol: ModelProtocol | undefined;
    if (opts?.modelEntryId) {
      const model = provider.models.find(item => item.id === opts.modelEntryId);
      if (!model) throw new Error('未找到该模型。');
      protocol = effectiveProtocol(provider.protocol, model.protocol);
      if (!protocol) throw new Error('请选择协议。当前模型未声明协议，且供应商没有默认协议。');
    } else {
      protocol = provider.protocol;
      if (!protocol) throw new Error('请选择协议。请先保存供应商默认协议，或指定一个已保存协议的模型后再获取上游列表。');
    }
    const listProtocol = requireProtocol(protocol);
    const key = this.decryptKey(provider);
    const sessionId = randomUUID();
    const headers = buildRequestHeaders(provider, listProtocol, key, sessionId);
    const collected: UpstreamModel[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
      const url = new URL(joinEndpoint(provider.baseURL, 'models'));
      if (cursor) {
        const token = sameOriginToken(provider.baseURL, cursor);
        if (!token) break;
        if (listProtocol === 'gemini-generate-content') url.searchParams.set('pageToken', token);
        else if (listProtocol === 'anthropic-messages') url.searchParams.set('after_id', token);
        else url.searchParams.set('after', token);
      }
      if (listProtocol === 'anthropic-messages') url.searchParams.set('limit', '100');
      const json = await this.fetchJson(url.toString(), { method: 'GET', headers }, opts?.signal, account);
      this.assertAccount(account, profileKey);
      const pageResult = parseUpstreamPage(listProtocol, json);
      for (const model of pageResult.models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        collected.push(model);
      }
      if (!pageResult.hasMore || !pageResult.cursor) break;
      cursor = pageResult.cursor;
    }
    return collected;
  }

  /** 主进程专用：返回当前默认供应商/模型的明文凭证、有效协议、思考配置与动态请求头。 */
  async resolveRuntimeConfig(profileKey: string, conversationId: string): Promise<RuntimeModelConfig> {
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('缺少会话标识。');
    const account = this.captureAccount();
    this.assertAccount(account, profileKey);
    const stored = await this.readStored(profileKey);
    this.assertAccount(account, profileKey);
    const provider = stored.providers.find(item => item.id === stored.defaultProviderId) ?? stored.providers[0];
    if (!provider) throw new Error('请先配置模型供应商。');
    const model = provider.models.find(item => item.id === stored.defaultModelId) ?? provider.models[0];
    if (!model) throw new Error('请先添加模型。');
    const protocol = requireProtocol(effectiveProtocol(provider.protocol, model.protocol));
    const reasoning = modelReasoning(provider, model);
    const built = buildReasoningRequest(protocol, reasoning.capability, reasoning.selection, model.maxOutput);
    if (!built.ok) throw new Error(built.message);
    const key = this.decryptKey(provider);
    const runtimeReasoning: RuntimeReasoning = {
      levelId: reasoning.selection.levelId,
      effort: built.ok ? built.effort : undefined,
      omitted: built.omitted,
      unverified: built.unverified || selectionUnverified(reasoning.capability, reasoning.selection),
      source: built.source,
      protocol,
      request: built.fragment,
    };
    return {
      profileKey,
      providerId: provider.id,
      providerName: provider.name,
      baseURL: provider.baseURL,
      protocol,
      modelId: model.modelId,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
      key,
      headers: buildRequestHeaders(provider, protocol, key, conversationId.trim()),
      reasoning: runtimeReasoning,
    };
  }

  private captureAccount(): AccountStamp {
    const profileKey = this.currentProfile();
    const generation = this.getGeneration();
    if (this.lastSeenGeneration !== undefined && this.lastSeenGeneration !== generation) this.abortAccountRequests();
    this.lastSeenGeneration = generation;
    return { profileKey, generation };
  }

  private stillAccount(account: AccountStamp): boolean {
    return account.profileKey === this.currentProfile() && account.generation === this.getGeneration();
  }

  private assertAccount(account: AccountStamp, profileKey: string) {
    assertProfileKey(profileKey);
    if (profileKey !== account.profileKey || !this.stillAccount(account)) {
      throw new Error('账号已切换，本次旧页面操作未保存。');
    }
  }

  private abortAccountRequests() {
    for (const controller of this.accountControllers) controller.abort('cancelled');
    this.accountControllers.clear();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn, fn);
    this.gate = run.then(() => undefined, () => undefined);
    return run;
  }

  private async mutate(profileKey: string, fn: (stored: StoredConfig) => StoredConfig, stamp?: AccountStamp): Promise<ModelConfigPublic> {
    const account = stamp ?? this.captureAccount();
    this.assertAccount(account, profileKey);
    return this.enqueue(async () => {
      this.assertAccount(account, profileKey);
      const stored = await this.readStored(profileKey);
      this.assertAccount(account, profileKey);
      const next = fn(stored);
      next.schema = MODEL_CONFIG_SCHEMA;
      next.profileKey = profileKey;
      this.assertAccount(account, profileKey);
      this.assertWritable?.(profileKey);
      await this.beforeCommit?.();
      await atomicJSONGuarded(this.configPath(profileKey), toDisk(next), () => this.stillAccount(account));
      this.assertAccount(account, profileKey);
      return toPublic(next);
    });
  }

  private async readStored(profileKey: string): Promise<StoredConfig> {
    assertProfileKey(profileKey);
    const file = this.configPath(profileKey);
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return seedConfig(profileKey);
      throw new Error('模型配置无法读取，原文件已保留。');
    }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw new Error('模型配置无法读取，原文件已保留。'); }
    return parseStored(raw, profileKey);
  }

  private encryptKeyIfProvided(key: string | undefined, previous?: string): string | undefined {
    if (typeof key !== 'string' || !key.trim()) return previous;
    return this.encryptPlainKey(key.trim());
  }

  private encryptPlainKey(key: string): string {
    const vault = this.getVault();
    if (!vault.available()) throw new Error('本机安全存储不可用，无法保存密钥。');
    try { return vault.encrypt(key).toString('base64'); }
    catch { throw new Error('本机安全存储无法保存密钥。'); }
  }

  private decryptKey(provider: StoredProvider): string {
    if (!provider.encryptedKey) throw new Error('请先保存 API Key。');
    const vault = this.getVault();
    if (!vault.available()) throw new Error('本机安全存储不可用，无法读取密钥。');
    try { return vault.decrypt(Buffer.from(provider.encryptedKey, 'base64')); }
    catch { throw new Error('密钥无法读取，请重新保存。'); }
  }

  private async fetchJson(url: string, init: RequestInit, external: AbortSignal | undefined, account: AccountStamp): Promise<Record<string, unknown>> {
    this.assertAccount(account, account.profileKey);
    const controller = new AbortController();
    this.accountControllers.add(controller);
    const timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    const onAbort = () => controller.abort('cancelled');
    if (external) {
      if (external.aborted) controller.abort('cancelled');
      else external.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
      this.assertAccount(account, account.profileKey);
      if (!response.ok) throw httpFailure(response.status);
      const text = await readLimitedBody(response);
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch { throw new SafeRequestError('上游返回无法解析。'); }
      if (Array.isArray(parsed)) return { data: parsed };
      const rec = asRecord(parsed);
      if (!rec) throw new SafeRequestError('上游返回无法解析。');
      return rec;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SafeRequestError(controller.signal.reason === 'timeout' ? '连接超时。' : '连接已取消。');
      }
      if (error instanceof SafeRequestError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (/redirect/i.test(message)) throw new SafeRequestError('上游重定向已拒绝。');
      throw new SafeRequestError('网络连接失败。');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
      this.accountControllers.delete(controller);
    }
  }
}

function keepDefaults(stored: StoredConfig): StoredConfig {
  const provider = stored.providers.find(item => item.id === stored.defaultProviderId);
  if (provider) {
    if (provider.models.some(item => item.id === stored.defaultModelId)) return stored;
    return { ...stored, defaultModelId: provider.models[0]?.id };
  }
  if (!stored.providers.length) return { ...stored, defaultProviderId: undefined, defaultModelId: undefined };
  const first = stored.providers[0];
  return { ...stored, defaultProviderId: first.id, defaultModelId: first.models[0]?.id };
}

function pickModel(provider: StoredProvider, modelEntryId?: string): StoredModel {
  const model = (modelEntryId ? provider.models.find(item => item.id === modelEntryId) : undefined) ?? provider.models[0];
  if (!model) throw new Error('请先添加模型。');
  return model;
}

function appendCanonicalGoEntry(models: StoredModel[], providerKey: string, baseURL: string): StoredModel[] {
  if (providerKey !== OPENCODE_GO_SOURCE_KEY && !isOpenCodeGoUrl(baseURL)) return models;
  const has = models.some(model => model.modelId === OPENCODE_GO_MODEL_ID && (model.protocol ?? 'openai-responses') === 'openai-responses');
  if (has) return models;
  return [...models, {
    id: randomUUID(),
    modelId: OPENCODE_GO_MODEL_ID,
    displayName: OPENCODE_GO_DISPLAY_NAME,
    protocol: 'openai-responses',
    contextWindowSource: 'missing',
    maxOutputSource: 'missing',
    reasoningLevelId: VENDOR_DEFAULT_LEVEL_ID,
    reasoningCapability: presetOpenCodeGoV41Capability(),
  }];
}

function mergeImportedModels(existing: StoredModel[], incoming: StoredModel[], providerProtocol?: ModelProtocol): StoredModel[] {
  const have = new Set(existing.map(model => modelIdentityKey(model.modelId, effectiveProtocol(providerProtocol, model.protocol))));
  const added = incoming.filter(model => {
    const key = modelIdentityKey(model.modelId, effectiveProtocol(providerProtocol, model.protocol));
    if (have.has(key)) return false;
    have.add(key);
    return true;
  });
  return [...existing, ...added];
}

function buildRequestHeaders(provider: StoredProvider, protocol: ModelProtocol, key: string, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (protocol === 'anthropic-messages') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (protocol === 'gemini-generate-content') {
    headers['x-goog-api-key'] = key;
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  if (isOpenCodeGoProvider(provider.source, provider.baseURL)) {
    headers['User-Agent'] = OPENCODE_USER_AGENT;
    headers[OPENCODE_SESSION_HEADER] = sessionId;
  }
  return headers;
}
