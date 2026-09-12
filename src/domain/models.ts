export const MODEL_CONFIG_SCHEMA = 1 as const;
export const OPENCODE_USER_AGENT = 'patent-workbench/0.2.5';
export const OPENCODE_SESSION_HEADER = 'x-opencode-session';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_MODEL_ID = 'deepseek-v4.1-flash';
export const OPENCODE_GO_DISPLAY_NAME = 'DeepSeek V4.1 Flash';
export const OPENCODE_GO_PROVIDER_NAME = 'OpenCode Go';
export const OPENCODE_GO_SOURCE_KEY = 'opencode-go';
export const BUILTIN_OPENCODE_GO_PROVIDER_ID = 'builtin-opencode-go';
export const BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID = 'builtin-opencode-go-deepseek-v4.1-flash';
export const CONNECTION_TEST_PROMPT = '只回复OK';
export const CONNECTION_TEST_MAX_OUTPUT = 256;
export const ANTHROPIC_MIN_THINKING_BUDGET = 1024;
export const MODEL_REQUEST_TIMEOUT_MS = 20_000;
export const MODEL_RESPONSE_MAX_BYTES = 1_000_000;
export const MODEL_LIST_MAX_PAGES = 8;
export const VENDOR_DEFAULT_LEVEL_ID = 'vendor-default';

export const MODEL_PROTOCOLS = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
  'gemini-generate-content',
] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

export const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  'openai-responses': 'OpenAI Responses',
  'openai-chat-completions': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
  'gemini-generate-content': 'Gemini GenerateContent',
};

export type LimitSource = 'upstream' | 'manual' | 'missing' | 'dsh';

export type ModelSource =
  | { type: 'dsh'; providerKey: string }
  | { type: 'builtin'; providerKey: 'opencode-go' };

export type ReasoningCapabilitySource =
  | 'unverified'
  | 'codex-verified'
  | 'upstream'
  | 'dsh'
  | 'official-docs'
  | 'manual'
  | 'preset';

export type ReasoningKind = 'none' | 'openai-effort' | 'anthropic-thinking' | 'gemini-thinking';

export type ReasoningLevel = {
  id: string;
  label: string;
  protocolValue: string;
  source: ReasoningCapabilitySource;
  hint?: string;
};

export type ReasoningCapability = {
  supported: boolean;
  kind: ReasoningKind;
  levels: ReasoningLevel[];
  allowBudget: boolean;
  allowAdaptive: boolean;
  allowOff: boolean;
  allowIncludeThoughts: boolean;
  allowOutputEffort: boolean;
  outputEfforts: ReasoningLevel[];
  source: ReasoningCapabilitySource;
  unverified: boolean;
  disabledReason?: string;
};

export type GeminiThinkingMode = 'level' | 'budget';

export type ReasoningSelection = {
  levelId: string;
  budgetTokens?: number;
  adaptive?: boolean;
  includeThoughts?: boolean;
  overridden: boolean;
  outputEffort?: string;
  geminiMode?: GeminiThinkingMode;
};

export type ReasoningPublic = {
  capability: ReasoningCapability;
  selection: ReasoningSelection;
};

export type ModelPublic = {
  id: string;
  modelId: string;
  displayName: string;
  protocol?: ModelProtocol;
  contextWindow?: number;
  maxOutput?: number;
  contextWindowSource: LimitSource;
  maxOutputSource: LimitSource;
  reasoning: ReasoningPublic;
};

export type ProviderPublic = {
  id: string;
  name: string;
  baseURL: string;
  protocol?: ModelProtocol;
  hasKey: boolean;
  models: ModelPublic[];
  source?: ModelSource;
};

export type ModelConfigPublic = {
  profileKey: string;
  providers: ProviderPublic[];
  defaultProviderId?: string;
  defaultModelId?: string;
};

export type ModelSaveInput = {
  id?: string;
  modelId: string;
  displayName: string;
  protocol?: ModelProtocol | null;
  contextWindow?: number | null;
  maxOutput?: number | null;
  reasoningLevelId?: string;
  reasoningBudgetTokens?: number | null;
  reasoningAdaptive?: boolean;
  reasoningIncludeThoughts?: boolean;
  reasoningOverridden?: boolean;
  reasoningLevels?: ReasoningLevel[];
  reasoningOutputEffort?: string | null;
  geminiMode?: GeminiThinkingMode | null;
};

export type ProviderSaveInput = {
  id?: string;
  name: string;
  baseURL: string;
  protocol?: ModelProtocol;
  key?: string;
  clearKey?: boolean;
  models?: ModelSaveInput[];
};

export type UpstreamReasoning = {
  supported?: boolean;
  kind?: ReasoningKind;
  efforts?: string[];
  allowBudget?: boolean;
  allowAdaptive?: boolean;
  allowOff?: boolean;
  allowOutputEffort?: boolean;
};

export type UpstreamModel = {
  id: string;
  name?: string;
  protocol?: ModelProtocol;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: UpstreamReasoning;
};

export type ConnectionTestResult = {
  ok: true;
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number };
  protocol: ModelProtocol;
  truncated?: boolean;
  reasoningOmitted?: boolean;
};

export type DshImportedModel = {
  id: string;
  name: string;
  protocol?: ModelProtocol;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: UpstreamReasoning;
  reasoningLevelId?: string;
};

export type DshProviderPreview = {
  providerKey: string;
  displayName: string;
  baseURL: string;
  apiKeyEnv: string;
  protocol?: ModelProtocol;
  models: DshImportedModel[];
};

export type RuntimeReasoning = {
  levelId: string;
  effort?: string;
  omitted: boolean;
  unverified: boolean;
  source: ReasoningCapabilitySource;
  protocol: ModelProtocol;
  request?: Record<string, unknown>;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const API_PATH_SUFFIXES = ['/chat/completions', '/responses', '/completions', '/models', '/messages'];

export const OPENCODE_GO_V41_REASONING_LEVELS: ReasoningLevel[] = [
  { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'unverified', hint: '不附加思考参数；该默认行为尚未作为独立档位核验。' },
  { id: 'none', label: '关闭', protocolValue: 'none', source: 'codex-verified', hint: 'OpenCode Go + deepseek-v4.1-flash 已实测。' },
  { id: 'low', label: '低', protocolValue: 'low', source: 'codex-verified', hint: 'OpenCode Go + deepseek-v4.1-flash 已实测。' },
  { id: 'high', label: '高', protocolValue: 'high', source: 'codex-verified', hint: 'OpenCode Go + deepseek-v4.1-flash 已实测。官方将 xhigh 映射为 high。' },
  { id: 'max', label: '最大', protocolValue: 'max', source: 'codex-verified', hint: 'OpenCode Go + deepseek-v4.1-flash 已实测。' },
];

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return typeof value === 'string' && (MODEL_PROTOCOLS as readonly string[]).includes(value);
}

export function parsePositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(label + '必须是正整数。');
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!/^[1-9]\d*$/.test(trimmed)) throw new Error(label + '必须是正整数。');
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(label + '必须是正整数。');
    return parsed;
  }
  throw new Error(label + '必须是正整数。');
}

export function optionalUpstreamLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function assertMaxOutputFitsContext(contextWindow: number | undefined, maxOutput: number | undefined) {
  if (contextWindow !== undefined && maxOutput !== undefined && maxOutput > contextWindow) {
    throw new Error('最大输出不能大于上下文窗口。');
  }
}

export function validateBaseURL(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('请填写 API 地址。');
  let url: URL;
  try { url = new URL(trimmed); }
  catch { throw new Error('API 地址不是有效的 URL。'); }
  if (url.username || url.password) throw new Error('API 地址不能包含用户名或密码。');
  if (url.hash) throw new Error('API 地址不能包含 hash。');
  if (url.search) throw new Error('API 地址不能包含查询参数。');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = LOCAL_HOSTS.has(host);
  if (url.protocol === 'http:') {
    if (!local) throw new Error('除本机 localhost 外，API 地址必须使用 https。');
  } else if (url.protocol !== 'https:') {
    throw new Error('API 地址必须使用 https。');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (/:generateContent$/i.test(pathname)) {
    throw new Error('API 地址应填写服务根路径，不要包含 :generateContent 接口路径。');
  }
  const suffix = API_PATH_SUFFIXES.find(item => pathname.toLowerCase().endsWith(item));
  if (suffix) {
    const next = pathname.slice(0, -suffix.length).replace(/\/+$/, '');
    const suggested = `${url.protocol}//${url.host}${next}`;
    throw new Error(`API 地址应填写服务根路径，不要包含 ${suffix}。可改为：${suggested}`);
  }
  return `${url.protocol}//${url.host}${pathname}`;
}

export function originOf(url: string): string | undefined {
  try { return new URL(validateBaseURL(url)).origin; }
  catch {
    try { return new URL(url).origin; }
    catch { return; }
  }
}

export function sameOptionalProtocol(a?: string | null, b?: string | null): boolean {
  const norm = (value?: string | null) => (value ? value : undefined);
  return norm(a) === norm(b);
}

export function providerOriginLabel(source?: ModelSource): string {
  if (source?.type === 'builtin') return '预置';
  if (source?.type === 'dsh') return 'DSH导入';
  return '自定义';
}

export type ModelIndexKeep = {
  keepId?: string;
  keepModelId?: string;
  keepProtocol?: string | null;
  providerId?: string;
  defaultProviderId?: string;
  defaultModelId?: string;
};

export function preferredModelIndex(
  models: Array<{ id?: string; modelId?: string; protocol?: string | null }>,
  opts: ModelIndexKeep = {},
): number {
  if (!models.length) return 0;
  if (opts.keepId) {
    const found = models.findIndex(model => model.id === opts.keepId);
    if (found >= 0) return found;
  }
  if (opts.keepModelId) {
    const found = models.findIndex(model => (
      model.modelId === opts.keepModelId && sameOptionalProtocol(model.protocol, opts.keepProtocol)
    ));
    if (found >= 0) return found;
  }
  if (opts.providerId && opts.defaultProviderId === opts.providerId && opts.defaultModelId) {
    const found = models.findIndex(model => model.id === opts.defaultModelId);
    if (found >= 0) return found;
  }
  return 0;
}

export function joinEndpoint(baseURL: string, relative: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}

export function geminiGeneratePath(modelId: string): string {
  const id = modelId.replace(/^models\//, '');
  return `models/${id}:generateContent`;
}

export function isOpenCodeGoUrl(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    const host = url.hostname.toLowerCase();
    return (host === 'opencode.ai' || host.endsWith('.opencode.ai')) && url.pathname.toLowerCase().includes('/zen/go');
  } catch {
    return false;
  }
}

export function isOpenCodeGoProvider(source: ModelSource | undefined, baseURL: string): boolean {
  return source?.providerKey === OPENCODE_GO_SOURCE_KEY || isOpenCodeGoUrl(baseURL);
}

export function effectiveProtocol(providerProtocol?: ModelProtocol, modelProtocol?: ModelProtocol): ModelProtocol | undefined {
  return modelProtocol ?? providerProtocol;
}

export function requireProtocol(protocol: ModelProtocol | undefined): ModelProtocol {
  if (!protocol) throw new Error('请选择协议。');
  return protocol;
}

export function protocolLabel(protocol?: ModelProtocol): string {
  return protocol ? PROTOCOL_LABELS[protocol] : '待选择';
}

export function modelIdentityKey(modelId: string, protocol?: ModelProtocol): string {
  return modelId + '\0' + (protocol ?? '');
}

export function normalizeEffortId(raw: string): string | undefined {
  const value = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!value) return;
  if (value === VENDOR_DEFAULT_LEVEL_ID || value === 'default' || value === 'vendor') return VENDOR_DEFAULT_LEVEL_ID;
  if (value === 'off' || value === 'disabled' || value === 'disable') return 'none';
  if (value === 'med') return 'medium';
  if (value === 'x-high' || value === 'extra-high') return 'xhigh';
  if (value === 'min') return 'minimal';
  if (/^[a-z][a-z0-9-]{0,31}$/.test(value)) return value;
}

/** 仅 OpenCode Go + deepseek-v4.1-flash Responses 使用：官方 xhigh→high。 */
export function mapOpenCodeGoV41Effort(raw: string): string | undefined {
  const id = normalizeEffortId(raw);
  if (id === 'xhigh') return 'high';
  if (id === 'minimal') return 'low';
  return id;
}

export function effortLabel(id: string): string {
  return ({
    [VENDOR_DEFAULT_LEVEL_ID]: '供应商默认',
    none: '关闭',
    low: '低',
    medium: '中',
    high: '高',
    max: '最大',
    minimal: 'minimal',
    xhigh: 'xhigh',
    budget: '预算',
    adaptive: '自适应',
  } as Record<string, string>)[id] ?? id;
}

export function isOpenCodeGoV41Responses(
  source: ModelSource | undefined,
  baseURL: string,
  modelId: string,
  protocol: ModelProtocol,
): boolean {
  return protocol === 'openai-responses' && modelId === OPENCODE_GO_MODEL_ID && isOpenCodeGoProvider(source, baseURL);
}

function vendorDefaultLevel(source: ReasoningCapabilitySource = 'unverified'): ReasoningLevel {
  return { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source, hint: '不附加思考参数。' };
}

function emptyCapability(kind: ReasoningKind, source: ReasoningCapabilitySource, extra?: Partial<ReasoningCapability>): ReasoningCapability {
  return {
    supported: extra?.supported ?? false,
    kind,
    levels: extra?.levels ?? [vendorDefaultLevel(source)],
    allowBudget: extra?.allowBudget === true,
    allowAdaptive: extra?.allowAdaptive === true,
    allowOff: extra?.allowOff === true,
    allowIncludeThoughts: extra?.allowIncludeThoughts === true,
    allowOutputEffort: extra?.allowOutputEffort === true,
    outputEfforts: extra?.outputEfforts ?? [],
    source,
    unverified: extra?.unverified ?? true,
    disabledReason: extra?.disabledReason,
  };
}

export function openaiEffortLevels(ids: string[], source: ReasoningCapabilitySource, map: (raw: string) => string | undefined = normalizeEffortId): ReasoningLevel[] {
  const seen = new Set<string>();
  const levels: ReasoningLevel[] = [vendorDefaultLevel(source)];
  for (const raw of ids) {
    const id = map(raw);
    if (!id || id === VENDOR_DEFAULT_LEVEL_ID || seen.has(id)) continue;
    seen.add(id);
    levels.push({ id, label: effortLabel(id), protocolValue: id, source });
  }
  return levels;
}

export function presetOpenCodeGoV41Capability(): ReasoningCapability {
  return emptyCapability('openai-effort', 'preset', {
    supported: true,
    levels: OPENCODE_GO_V41_REASONING_LEVELS.map(level => ({ ...level })),
    unverified: true,
  });
}

export function unsupportedReasoning(kind: ReasoningKind, reason: string): ReasoningCapability {
  return emptyCapability(kind, 'unverified', { disabledReason: reason });
}

function protocolKind(protocol?: ModelProtocol): ReasoningKind {
  if (protocol === 'anthropic-messages') return 'anthropic-thinking';
  if (protocol === 'gemini-generate-content') return 'gemini-thinking';
  return 'openai-effort';
}

export function declaredReasoningCapability(
  protocol: ModelProtocol | undefined,
  declared: UpstreamReasoning | undefined,
  source: ReasoningCapabilitySource,
): ReasoningCapability {
  const kind = declared?.kind ?? protocolKind(protocol);
  if (declared?.supported === false) {
    return unsupportedReasoning(kind, '上游或导入配置声明该模型不支持思考参数。');
  }
  const efforts = declared?.efforts?.map(item => normalizeEffortId(item) ?? '').filter(Boolean) ?? [];
  const hasDeclaration = declared?.supported === true || efforts.length > 0 || declared?.allowBudget === true || declared?.allowAdaptive === true || declared?.allowOff === true || declared?.allowOutputEffort === true || declared?.kind;
  if (!hasDeclaration) {
    return unsupportedReasoning(kind, '未声明思考档位。请求使用供应商默认（不附加思考参数）。可手动声明后保存。');
  }
  if (kind === 'openai-effort') {
    const levels = efforts.length ? openaiEffortLevels(efforts, source) : [vendorDefaultLevel(source)];
    return emptyCapability(kind, source, {
      supported: true,
      levels,
      allowOff: efforts.includes('none') || declared?.allowOff === true,
      unverified: source !== 'codex-verified',
      disabledReason: efforts.length ? undefined : '已声明支持思考，但未给出档位。请手动声明后保存。',
    });
  }
  if (kind === 'anthropic-thinking') {
    const levels = [vendorDefaultLevel(source)];
    if (declared?.allowOff === true) levels.push({ id: 'none', label: '关闭', protocolValue: 'disabled', source, hint: '发送 thinking.type=disabled。' });
    if (declared?.allowBudget === true) levels.push({ id: 'budget', label: '预算', protocolValue: 'enabled', source, hint: 'thinking.type=enabled 与 budget_tokens，至少 1024 且小于最大输出。' });
    if (declared?.allowAdaptive === true) levels.push({ id: 'adaptive', label: '自适应', protocolValue: 'adaptive', source, hint: 'thinking.type=adaptive。' });
    const outputEfforts = declared?.allowOutputEffort === true || efforts.length
      ? openaiEffortLevels(efforts.length ? efforts : ['low', 'medium', 'high', 'max'], source).filter(level => level.id !== VENDOR_DEFAULT_LEVEL_ID)
      : [];
    return emptyCapability(kind, source, {
      supported: true,
      levels,
      allowBudget: declared?.allowBudget === true,
      allowAdaptive: declared?.allowAdaptive === true,
      allowOff: declared?.allowOff === true,
      allowOutputEffort: outputEfforts.length > 0,
      outputEfforts,
      unverified: source !== 'codex-verified',
    });
  }
  const geminiLevels = [vendorDefaultLevel(source)];
  if (declared?.allowOff === true || efforts.includes('none')) {
    geminiLevels.push({ id: 'none', label: '关闭', protocolValue: '0', source, hint: 'thinkingBudget=0。' });
  }
  for (const id of efforts) {
    if (id === 'none' || id === VENDOR_DEFAULT_LEVEL_ID || id === 'budget') continue;
    geminiLevels.push({ id, label: effortLabel(id), protocolValue: id.toUpperCase(), source });
  }
  if (declared?.allowBudget === true) {
    geminiLevels.push({ id: 'budget', label: '预算', protocolValue: 'budget', source, hint: '只发送 thinkingBudget，不与 thinkingLevel 同发。' });
  }
  return emptyCapability('gemini-thinking', source, {
    supported: true,
    levels: geminiLevels,
    allowBudget: declared?.allowBudget === true,
    allowOff: declared?.allowOff === true || efforts.includes('none'),
    allowIncludeThoughts: true,
    unverified: source !== 'codex-verified',
    disabledReason: geminiLevels.length === 1 && declared?.allowBudget !== true ? '已声明支持思考，但未给出档位或预算。请手动声明。' : undefined,
  });
}

export function reasoningCapabilityFor(
  source: ModelSource | undefined,
  baseURL: string,
  providerProtocol: ModelProtocol | undefined,
  modelId: string,
  modelProtocol: ModelProtocol | undefined,
  stored?: ReasoningCapability,
  declared?: UpstreamReasoning,
): ReasoningCapability {
  const protocol = effectiveProtocol(providerProtocol, modelProtocol);
  if (stored && stored.source === 'manual') return stored;
  if (protocol && isOpenCodeGoV41Responses(source, baseURL, modelId, protocol)) {
    if (stored?.source === 'manual') return stored;
    return presetOpenCodeGoV41Capability();
  }
  if (stored && stored.source !== 'unverified' && stored.source !== 'preset') return stored;
  if (declared) return declaredReasoningCapability(protocol, declared, stored?.source ?? 'upstream');
  if (stored) return stored;
  return unsupportedReasoning(protocolKind(protocol), '未声明思考档位，不能假定与 OpenCode Go / DeepSeek V4.1 相同。');
}

export function sanitizeSelection(capability: ReasoningCapability, selection: ReasoningSelection | undefined): ReasoningSelection {
  const fallback: ReasoningSelection = { levelId: VENDOR_DEFAULT_LEVEL_ID, overridden: false };
  if (!selection) return fallback;
  const allowed = capability.levels.some(level => level.id === selection.levelId);
  if (!allowed) {
    if (selection.overridden && selection.levelId) return selection;
    return { ...fallback, overridden: selection.overridden };
  }
  const next: ReasoningSelection = { ...selection, levelId: selection.levelId };
  if (!capability.allowBudget) delete next.budgetTokens;
  if (!capability.allowAdaptive) delete next.adaptive;
  if (!capability.allowIncludeThoughts) delete next.includeThoughts;
  if (!capability.allowOutputEffort) delete next.outputEffort;
  if (capability.kind === 'gemini-thinking' && next.levelId === 'budget') next.geminiMode = 'budget';
  else if (capability.kind === 'gemini-thinking' && next.levelId !== VENDOR_DEFAULT_LEVEL_ID && next.levelId !== 'none') next.geminiMode = 'level';
  if (next.levelId !== 'budget') {
    if (next.geminiMode !== 'budget') delete next.budgetTokens;
  }
  return next;
}

export function selectionUnverified(capability: ReasoningCapability, selection: ReasoningSelection): boolean {
  if (capability.unverified && selection.levelId === VENDOR_DEFAULT_LEVEL_ID) return true;
  const level = capability.levels.find(item => item.id === selection.levelId);
  if (!level) return true;
  return level.source === 'unverified' || level.source === 'official-docs' || level.source === 'dsh' || level.source === 'upstream' || level.source === 'manual';
}

export type ReasoningRequestBuild =
  | { ok: true; omitted: boolean; unverified: boolean; fragment?: Record<string, unknown>; effort?: string; source: ReasoningCapabilitySource }
  | { ok: false; message: string };

export function assertThinkingBudget(budget: number, maxOutput?: number) {
  if (!Number.isSafeInteger(budget) || budget < ANTHROPIC_MIN_THINKING_BUDGET) {
    throw new Error(`思考预算至少 ${ANTHROPIC_MIN_THINKING_BUDGET}。`);
  }
  if (maxOutput !== undefined && budget >= maxOutput) {
    throw new Error('思考预算必须小于最大输出。');
  }
}

export function buildReasoningRequest(
  protocol: ModelProtocol,
  capability: ReasoningCapability,
  selection: ReasoningSelection,
  maxOutput?: number,
): ReasoningRequestBuild {
  const levelId = selection.levelId || VENDOR_DEFAULT_LEVEL_ID;
  const level = capability.levels.find(item => item.id === levelId);
  const source = level?.source ?? capability.source;
  const unverified = selectionUnverified(capability, selection);
  if (levelId === VENDOR_DEFAULT_LEVEL_ID && !selection.outputEffort) {
    return { ok: true, omitted: true, unverified, source };
  }
  if (!capability.supported && !selection.overridden) {
    return { ok: false, message: capability.disabledReason || '该模型未声明思考能力，不能发送思考参数。' };
  }
  if (levelId !== VENDOR_DEFAULT_LEVEL_ID && !level && !selection.overridden) {
    return { ok: false, message: '所选思考档位与当前模型能力不兼容。' };
  }
  const mapped = capability.source === 'preset' ? mapOpenCodeGoV41Effort(levelId) : normalizeEffortId(levelId);
  const protocolValue = level?.protocolValue || mapped || levelId;
  if (protocol === 'openai-responses') {
    if (!protocolValue) return { ok: true, omitted: true, unverified, source };
    return { ok: true, omitted: false, unverified, source, effort: protocolValue, fragment: { reasoning: { effort: protocolValue } } };
  }
  if (protocol === 'openai-chat-completions') {
    if (!protocolValue) return { ok: true, omitted: true, unverified, source };
    return { ok: true, omitted: false, unverified, source, effort: protocolValue, fragment: { reasoning_effort: protocolValue } };
  }
  if (protocol === 'anthropic-messages') {
    const fragment: Record<string, unknown> = {};
    if (levelId === 'none' || protocolValue === 'disabled') {
      if (!capability.allowOff && !selection.overridden) return { ok: false, message: '该模型未声明可关闭思考。' };
      fragment.thinking = { type: 'disabled' };
    } else if (levelId === 'adaptive' || protocolValue === 'adaptive') {
      if (!capability.allowAdaptive && !selection.overridden) return { ok: false, message: '该模型未声明 Anthropic adaptive thinking。' };
      fragment.thinking = { type: 'adaptive' };
    } else if (levelId === 'budget' || protocolValue === 'enabled') {
      if (!capability.allowBudget && !selection.overridden) return { ok: false, message: '该模型未声明 Anthropic thinking budget。' };
      const budget = selection.budgetTokens;
      if (budget === undefined) return { ok: false, message: '请填写思考预算 token。' };
      try { assertThinkingBudget(budget, maxOutput); }
      catch (error) { return { ok: false, message: (error as Error).message }; }
      fragment.thinking = { type: 'enabled', budget_tokens: budget };
    } else if (levelId !== VENDOR_DEFAULT_LEVEL_ID) {
      return { ok: false, message: '当前协议不支持该思考档位。' };
    }
    if (selection.outputEffort) {
      if (!capability.allowOutputEffort && !selection.overridden) return { ok: false, message: '该模型未声明 output_config.effort。' };
      const effort = normalizeEffortId(selection.outputEffort);
      if (!effort || effort === VENDOR_DEFAULT_LEVEL_ID) return { ok: false, message: 'output_config.effort 无效。' };
      fragment.output_config = { effort };
    }
    if (!Object.keys(fragment).length) return { ok: true, omitted: true, unverified, source };
    return { ok: true, omitted: false, unverified, source, fragment };
  }
  const thinkingConfig: Record<string, unknown> = {};
  const useBudget = selection.geminiMode === 'budget' || levelId === 'budget';
  const useLevel = !useBudget && levelId !== VENDOR_DEFAULT_LEVEL_ID && levelId !== 'none';
  if (useBudget && useLevel) return { ok: false, message: 'Gemini 不能同时发送 thinkingBudget 与 thinkingLevel。' };
  if (levelId === 'none') {
    if (!capability.allowOff && !selection.overridden) return { ok: false, message: '该模型未声明可关闭思考。' };
    thinkingConfig.thinkingBudget = 0;
  } else if (useBudget) {
    if (!capability.allowBudget && !selection.overridden) return { ok: false, message: '该模型未声明 Gemini 思考预算。' };
    const budget = selection.budgetTokens;
    if (budget === undefined) return { ok: false, message: '请填写思考预算 token。' };
    if (maxOutput !== undefined && budget >= maxOutput) return { ok: false, message: '思考预算必须小于最大输出。' };
    thinkingConfig.thinkingBudget = budget;
  } else if (useLevel) {
    if (protocolValue && protocolValue !== '0' && protocolValue !== 'budget') thinkingConfig.thinkingLevel = protocolValue.toUpperCase();
  }
  if (capability.allowIncludeThoughts && selection.includeThoughts) thinkingConfig.includeThoughts = true;
  if (!Object.keys(thinkingConfig).length) {
    if (levelId === VENDOR_DEFAULT_LEVEL_ID) return { ok: true, omitted: true, unverified, source };
    return { ok: false, message: '未形成可用的 Gemini thinkingConfig。' };
  }
  return { ok: true, omitted: false, unverified, source, fragment: { thinkingConfig } };
}

export function testOutputBudget(maxOutput: number | undefined, thinkingBudget?: number, thinkingEnabled = false): number {
  if (thinkingBudget !== undefined) {
    assertThinkingBudget(thinkingBudget, maxOutput);
    const needed = thinkingBudget + 16;
    if (maxOutput !== undefined && maxOutput <= thinkingBudget) {
      throw new Error('当前最大输出不足以容纳思考预算，无法测试。');
    }
    if (maxOutput !== undefined) return maxOutput;
    return needed;
  }
  if (thinkingEnabled) return maxOutput ?? CONNECTION_TEST_MAX_OUTPUT;
  if (maxOutput === undefined) return CONNECTION_TEST_MAX_OUTPUT;
  return Math.max(1, Math.min(maxOutput, CONNECTION_TEST_MAX_OUTPUT));
}

export function parseDshProtocol(value: unknown): ModelProtocol | undefined {
  if (isModelProtocol(value)) return value;
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return;
  if (raw === 'openai-responses' || raw === 'responses' || raw === 'openai_responses') return 'openai-responses';
  if (raw === 'openai-completions' || raw === 'openai_completions' || raw === 'chat_completions' || raw === 'chat-completions' || raw === 'openai-chat') return 'openai-chat-completions';
  if (raw === 'anthropic-messages' || raw === 'anthropic' || raw === 'claude') return 'anthropic-messages';
  if (raw === 'google-generative-ai' || raw === 'google_generative_ai' || raw === 'generatecontent' || raw === 'generate_content' || raw === 'gemini') return 'gemini-generate-content';
}

export function parseDeclaredEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = normalizeEffortId(item);
    if (id && id !== VENDOR_DEFAULT_LEVEL_ID) out.push(id);
  }
  return out;
}

export function defaultPublicConfig(profileKey: string): ModelConfigPublic {
  const capability = presetOpenCodeGoV41Capability();
  const selection: ReasoningSelection = { levelId: VENDOR_DEFAULT_LEVEL_ID, overridden: false };
  return {
    profileKey,
    defaultProviderId: BUILTIN_OPENCODE_GO_PROVIDER_ID,
    defaultModelId: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID,
    providers: [{
      id: BUILTIN_OPENCODE_GO_PROVIDER_ID,
      name: OPENCODE_GO_PROVIDER_NAME,
      baseURL: OPENCODE_GO_BASE_URL,
      protocol: 'openai-responses',
      hasKey: false,
      source: { type: 'builtin', providerKey: 'opencode-go' },
      models: [{
        id: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID,
        modelId: OPENCODE_GO_MODEL_ID,
        displayName: OPENCODE_GO_DISPLAY_NAME,
        contextWindowSource: 'missing',
        maxOutputSource: 'missing',
        reasoning: { capability, selection },
      }],
    }],
  };
}
