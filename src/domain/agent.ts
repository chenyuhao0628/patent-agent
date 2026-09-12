import {validateCorrectionContents,type CorrectionContent} from './correction.ts';
import {validateApplicationParts,type ApplicationParts} from './application-parts.ts';
// Pure business core for any structured runner. No HTTP/IPC/GUI, no credentials, no demo timer.
// hostGuards express scope freeze, managed paths and shared-draft hash for the host; this module does not touch disk.

export type PatentType = '发明' | '实用新型';
export type NoticeCategory = '审查意见通知书' | '补正通知书';
export type CorrectionBasis = 'original' | 'other' | `round_${number}`;
export type ProcessAccess = 'editable' | 'readonly';
export type AgentAction = 'analysis' | 'discuss' | 'draft' | 'revise' | 'review';
export type AgentJobState = 'running' | 'stopped' | 'failed' | 'completed';
export type DiscussionKind = 'main' | 'review';
export type ToolEventStatus = 'started' | 'ok' | 'error' | 'stopped';
export type ToolKind = 'read_material' | 'read_draft' | 'read_skill' | 'write_artifact' | 'web_search' | 'web_fetch' | 'ensure_tool' | 'discover_tools' | 'execute_command' | 'download_file' | 'prepare_material' | 'read_work_file' | 'custom_mcp';
export type AdoptStatus = 'pending' | 'adopted' | 'rejected' | 'conflict';
export type DraftSource = 'generated-initial' | 'generated-revise' | 'user';
export type IssueSeverity = 'error' | 'warning' | 'info';
export type AgentStage = 'materials' | 'strategy' | 'draft' | 'review' | 'final';

export type AgentScope = { caseId: string; processKey: string };

export type ReplyClassification = {
  status: 'classified';
  patentType: PatentType;
  noticeCategory: NoticeCategory;
  officeActionRound: number;
  correctionBasis: CorrectionBasis;
};

export type OpenClassification = {
  status: 'unclassified' | 'unknown';
  patentType?: PatentType | '待核对';
  noticeCategory?: NoticeCategory | '待核对';
  officeActionRound?: number;
  correctionBasis?: CorrectionBasis;
};

export type NoticeClassification = ReplyClassification | OpenClassification;

export type ClassificationInput = NoticeClassification | {
  patentType?: PatentType | '待核对' | 'unknown';
  noticeCategory?: NoticeCategory | '待核对' | 'unknown';
  officeActionRound?: number | null;
  correctionBasis?: CorrectionBasis | 'unknown';
};

export type MaterialRef = {
  name: string;
  role: string;
  relativePath?: string;
  hash?: string;
};

export type MaterialEntry = MaterialRef & {
  id: string;
  ready: boolean;
  selected: boolean;
};

export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  runId?: string;
};

export type ToolEvent = {
  id: string;
  runId: string;
  filename: string;
  detail?: string;
  readRange?: string;
  status: ToolEventStatus;
  at: string;
  materialId?: string;
  toolKind?: ToolKind;
};

export type Discussion = {
  archived?: boolean;
  id: string;
  kind: DiscussionKind;
  title: string;
  messages: AgentMessage[];
  toolEvents: ToolEvent[];
  boundDraftVersionId?: string;
  parentDiscussionId?: string;
};

export type PublicRuntimeSnapshot = {
  profileKey?: string;
  model?: string;
  protocol?: string;
  reasoningLevel?: string;
};

export type AgentJob = {
  runId: string;
  discussionId: string;
  action: AgentAction;
  state: AgentJobState;
  startedAt: string;
  endedAt?: string;
  error?: string;
  resumeFromRunId?: string;
  publicRuntime?: PublicRuntimeSnapshot;
  boundDraftVersionId?: string;
  baseDraftVersionId?: string;
};

export type Strategy = {
  id: string;
  title: string;
  summary: string;
  benefits: string;
  risks: string;
  basis: string;
};

export type OpinionItem = {
  id: string;
  title: string;
  summary: string;
  basis: string;
};

export type AnalysisResult = {
  runId: string;
  opinions: OpinionItem[];
  strategies: Strategy[];
  at: string;
  materialFingerprint: string;
  classificationKey: string;
};

export type DraftVersion = {
  id: string;
  source: DraftSource;
  text: string;
  amendmentText: string;
  applicationParts?:ApplicationParts;
  correctionContents?:CorrectionContent[];
  amendmentBasis: string;
  reviewNotes: string;
  at: string;
  runId?: string;
  strategyId?: string;
  basedOnVersionId?: string;
  adoptStatus: AdoptStatus;
  sourceSharedDraftHash?: string;
  reviewMaterials?: MaterialEntry[];
};

export type ReviewIssue = {
  id: string;
  severity: IssueSeverity;
  finding: string;
  basis: string;
  suggestion: string;
  handled: boolean;
};

export type ReviewResult = {
  id: string;
  runId: string;
  discussionId: string;
  draftVersionId: string;
  issues: ReviewIssue[];
  summary: string;
  at: string;
  invalidated: boolean;
};

export type FinalizeRecord = {
  draftVersionId: string;
  text: string;
  at: string;
  word: {
    generated: boolean;
    status: 'not-connected' | 'generated' | 'not-required';
    relativePath?: string;
    message: string;
  };
};

export type HostGuardKind = 'scope-freeze' | 'shared-draft-hash' | 'managed-path' | 'non-symlink' | 'profile-generation';

export type HostGuard = {
  kind: HostGuardKind;
  caseId: string;
  processKey: string;
  relativePath?: string;
  hash?: string;
  expectedSharedDraftHash?: string;
  expectedDraftVersionId?: string;
  note: string;
};

export type DraftPromptVersion = {
  id: string;
  text: string;
  amendmentText?: string;
  applicationParts?:ApplicationParts;
  correctionContents?:CorrectionContent[];
  amendmentBasis?: string;
};

export type PromptContext = {
  stage: AgentAction;
  classification?: NoticeClassification;
  patentType?: PatentType | '待核对';
  noticeCategory?: NoticeCategory | '待核对';
  officeActionRound?: number;
  correctionBasis?: CorrectionBasis;
  materialManifestRefs: MaterialRef[];
  selectedStrategy?: Strategy;
  draftVersion?: DraftPromptVersion;
  reviewFeedback?: Pick<ReviewResult, 'draftVersionId' | 'summary' | 'issues'>;
  userMessage?: string;
};

export type AgentProcessState = {
  scope: AgentScope;
  classification: NoticeClassification;
  access: ProcessAccess;
  stage: AgentStage;
  materials: MaterialEntry[];
  materialsConfirmed: boolean;
  materialsConfirmedAt?: string;
  confirmedMaterialFingerprint?: string;
  discussions: Discussion[];
  mainDiscussionId: string;
  jobs: AgentJob[];
  activeRunId: string | null;
  analysis: AnalysisResult | null;
  analysisHistory: AnalysisResult[];
  userSelectedStrategyId: string | null;
  userSelectedStrategyAt?: string;
  drafts: DraftVersion[];
  currentDraftVersionId: string | null;
  expectedSharedDraftHash?: string;
  reviews: ReviewResult[];
  finalized: FinalizeRecord | null;
  finalizeHistory: FinalizeRecord[];
};

export type AgentBook = { processes: AgentProcessState[] };

export type AnalysisArtifact = {
  kind: 'analysis';
  opinions: OpinionItem[];
  strategies: Strategy[];
  modelSelectedStrategyId?: string;
  body?: string;
};

export type DiscussArtifact = { kind: 'discuss'; reply: string };

export type DraftingArtifact = {
  kind: 'draft' | 'revise';
  body: string;
  amendmentText: string;
  applicationParts?:ApplicationParts;
  correctionContents?:CorrectionContent[];
  amendmentBasis: string;
  reviewNotes: string;
  strategyId: string;
};

export type ReviewArtifact = {
  kind: 'review';
  draftVersionId: string;
  summary: string;
  issues: Array<Omit<ReviewIssue, 'handled'> & { handled?: boolean }>;
};

export type JobArtifact = AnalysisArtifact | DiscussArtifact | DraftingArtifact | ReviewArtifact;

export type AgentErrorCode =
  | 'INVALID_SCOPE'
  | 'INVALID_CLASSIFICATION'
  | 'CLASSIFICATION_NOT_READY'
  | 'CLASSIFICATION_LOCKED'
  | 'MATERIALS_NOT_CONFIRMED'
  | 'MATERIALS_STALE'
  | 'MATERIALS_NOT_READY'
  | 'MATERIALS_UNREAD'
  | 'NO_MATERIALS_SELECTED'
  | 'UNKNOWN_MATERIAL'
  | 'CASE_BUSY'
  | 'JOB_RUNNING'
  | 'JOB_NOT_RUNNING'
  | 'STALE_RUN'
  | 'WRONG_SCOPE'
  | 'STRATEGY_NOT_SELECTED'
  | 'STRATEGY_INVALID'
  | 'READONLY'
  | 'ALREADY_FINALIZED'
  | 'REVIEW_REQUIRED'
  | 'REVIEW_STALE'
  | 'UNHANDLED_ISSUES'
  | 'DISCUSSION_NOT_FOUND'
  | 'DISCUSSION_KIND'
  | 'DRAFT_VERSION_REQUIRED'
  | 'DRAFT_VERSION_MISMATCH'
  | 'ADOPT_CONFLICT'
  | 'ARTIFACT_INVALID'
  | 'ACTION_NOT_ALLOWED'
  | 'ABSOLUTE_PATH'
  | 'PROMPT_RESOURCE_UNAVAILABLE'
  | 'INVALID_PROMPT_INPUT'
  | 'PROCESS_NOT_FOUND';

export type AgentFailure = { ok: false; code: AgentErrorCode; error: string };
export type AgentSuccess<T = unknown> = {
  ok: true;
  state: AgentProcessState;
  hostGuards: HostGuard[];
  promptContext?: PromptContext;
  value?: T;
};
export type AgentResult<T = unknown> = AgentSuccess<T> | AgentFailure;
export type BookResult<T = unknown> = (AgentSuccess<T> & { book: AgentBook }) | AgentFailure;

export const WORD_NOT_CONNECTED = 'Word 模板尚未接入，本阶段仅保留正文版本与时间，不能声称已生成 Word。';

export const PERSISTENCE_HINT = {
  localOnly: ['discussions', 'messages', 'toolEvents', 'jobs', 'publicRuntime'] as const,
  shared: ['materials', 'generatedDrafts', 'finalText'] as const,
};

export const AgentErrors: Record<AgentErrorCode, string> = {
  INVALID_SCOPE: '缺少案件或办理轮次标识。',
  INVALID_CLASSIFICATION: '通知类型、专利类型或轮次无效。',
  CLASSIFICATION_NOT_READY: '分类未核对，不能开始正式答复，不能默认当作审查意见。',
  CLASSIFICATION_LOCKED: '任务进行中，不能更新通知分类。',
  MATERIALS_NOT_CONFIRMED: '请先勾选并确认用于分析的材料后，才能开始意见分析。',
  MATERIALS_STALE: '分类或材料已变更，请重新分析后再起草或复核。',
  MATERIALS_NOT_READY: '已勾选材料尚未准备完成，不能开始意见分析。',
  MATERIALS_UNREAD: '正式任务完成前必须实际读取当次必需材料，不能仅凭模型自述。',
  NO_MATERIALS_SELECTED: '请先勾选用于分析的材料。',
  UNKNOWN_MATERIAL: '材料清单包含未知项。',
  CASE_BUSY: '同一案件已有进行中的任务，不能并行启动。',
  JOB_RUNNING: '当前轮次已有进行中的任务。',
  JOB_NOT_RUNNING: '任务已停止或结束，结果不能推进阶段。',
  STALE_RUN: '当前活动任务已变更，已拒绝过期结果。',
  WRONG_SCOPE: '请求不属于当前案件或办理轮次。',
  STRATEGY_NOT_SELECTED: '请先选定有效策略后，才能起草。模型声称已选定不构成授权。',
  STRATEGY_INVALID: '请选择本次分析给出的有效策略。',
  READONLY: '当前案件已只读，不能修改答复稿件或启动正式答复任务。',
  ALREADY_FINALIZED: '本轮已经定稿，不能修改答复稿件或启动正式答复任务。',
  REVIEW_REQUIRED: '定稿前必须完成针对当前稿件版本的独立复核。',
  REVIEW_STALE: '稿件已变更，原复核作废，请重新复核。',
  UNHANDLED_ISSUES: '仍有未处理的复核问题，不能定稿。',
  DISCUSSION_NOT_FOUND: '讨论不属于当前办理轮次。',
  DISCUSSION_KIND: '该任务不能写入当前讨论。独立复核必须使用单独讨论。',
  DRAFT_VERSION_REQUIRED: '独立复核必须绑定确切稿件版本。',
  DRAFT_VERSION_MISMATCH: '复核绑定的稿件版本与请求不一致。',
  ADOPT_CONFLICT: '共享稿哈希不一致，已保留待核对产物，未覆盖用户稿。',
  ARTIFACT_INVALID: '阶段产物缺少必要字段或与当前任务不一致。',
  ACTION_NOT_ALLOWED: '当前阶段不允许该操作。',
  ABSOLUTE_PATH: '材料引用不能使用本机绝对路径或越出案件相对路径。',
  PROMPT_RESOURCE_UNAVAILABLE: '产品答复规则资源缺失或标题已变化，不能生成提示。',
  INVALID_PROMPT_INPUT: '生成提示的输入不完整或不适用于当前阶段。',
  PROCESS_NOT_FOUND: '未找到该案件办理轮次的业务状态。',
};

const CORRECTION_BASIS = /^(original|other|round_[1-9][0-9]?)$/;
const PATENT_TYPES = new Set(['发明', '实用新型']);
const NOTICE_CATEGORIES = new Set(['审查意见通知书', '补正通知书']);
const TOOL_STATUSES = new Set<ToolEventStatus>(['started', 'ok', 'error', 'stopped']);
const SEVERITIES = new Set<IssueSeverity>(['error', 'warning', 'info']);
const FORMAL_ACTIONS = new Set<AgentAction>(['analysis', 'draft', 'revise', 'review']);

export function processIndexKey(caseId: string, processKey: string): string {
  return `${caseId}::${processKey}`;
}

export function resolveProcessKey(input: { processKey?: string; processId?: string; roundId?: string }): string {
  return (input.processKey || input.processId || input.roundId || '').trim();
}

export function agentFail(code: AgentErrorCode, error = AgentErrors[code]): AgentFailure {
  return { ok: false, code, error };
}

function ok<T>(state: AgentProcessState, extra: Partial<Omit<AgentSuccess<T>, 'ok' | 'state'>> = {}): AgentSuccess<T> {
  return { ok: true, state, hostGuards: extra.hostGuards ?? [], promptContext: extra.promptContext, value: extra.value };
}

function clone(state: AgentProcessState): AgentProcessState {
  return structuredClone(state);
}

function nowIso(at?: string): string {
  return at || new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

export function isUnsafePath(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  return trimmed.replaceAll('\\', '/').split('/').some(part => part === '..');
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueById<T extends { id: string }>(items: T[], label: string): AgentFailure | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return agentFail('ARTIFACT_INVALID', `${label}编号重复。`);
    seen.add(item.id);
  }
  return null;
}

function checkScope(state: AgentProcessState, cmd: { caseId: string; processKey: string }): AgentFailure | null {
  if (state.scope.caseId !== cmd.caseId || state.scope.processKey !== cmd.processKey) return agentFail('WRONG_SCOPE');
  return null;
}

function checkReplyWrite(state: AgentProcessState): AgentFailure | null {
  if (state.access === 'readonly') return agentFail('READONLY');
  if (state.finalized) return agentFail('ALREADY_FINALIZED');
  return null;
}

export function isReplyClassified(value: NoticeClassification): value is ReplyClassification {
  return value.status === 'classified'
    && PATENT_TYPES.has(value.patentType)
    && NOTICE_CATEGORIES.has(value.noticeCategory)
    && Number.isInteger(value.officeActionRound)
    && value.officeActionRound >= 1
    && value.officeActionRound <= 99
    && CORRECTION_BASIS.test(value.correctionBasis);
}

export type DataResult<T> = { ok: true; value: T } | AgentFailure;

export function parseClassification(input?: ClassificationInput): DataResult<NoticeClassification> {
  if (!input) return { ok: true, value: { status: 'unclassified' } };
  const status = 'status' in input ? input.status : undefined;
  const patentType = input.patentType;
  const noticeCategory = input.noticeCategory;
  if (status === 'unknown' || patentType === 'unknown' || noticeCategory === 'unknown') {
    return { ok: true, value: { status: 'unknown' } };
  }
  const round = input.officeActionRound;
  const basis = input.correctionBasis && input.correctionBasis !== 'unknown' ? input.correctionBasis : undefined;
  const pending = status === 'unclassified'
    || patentType === '待核对'
    || noticeCategory === '待核对'
    || !patentType
    || !noticeCategory
    || round == null;
  if (pending) {
    const open: OpenClassification = { status: 'unclassified' };
    if (patentType === '发明' || patentType === '实用新型' || patentType === '待核对') open.patentType = patentType;
    if (noticeCategory === '审查意见通知书' || noticeCategory === '补正通知书' || noticeCategory === '待核对') open.noticeCategory = noticeCategory;
    if (typeof round === 'number') open.officeActionRound = round;
    if (basis) open.correctionBasis = basis;
    return { ok: true, value: open };
  }
  const classified: ReplyClassification = {
    status: 'classified',
    patentType: patentType as PatentType,
    noticeCategory: noticeCategory as NoticeCategory,
    officeActionRound: round as number,
    correctionBasis: basis as CorrectionBasis,
  };
  if (!isReplyClassified(classified)) return agentFail('INVALID_CLASSIFICATION');
  return { ok: true, value: classified };
}

export function validateClassification(value: NoticeClassification): AgentFailure | null {
  if (value.status === 'classified') return isReplyClassified(value) ? null : agentFail('INVALID_CLASSIFICATION');
  if (value.status === 'unknown' || value.status === 'unclassified') return null;
  return agentFail('INVALID_CLASSIFICATION');
}

export function activeJob(state: AgentProcessState): AgentJob | undefined {
  return state.jobs.find(job => job.runId === state.activeRunId);
}

export function currentDraft(state: AgentProcessState): DraftVersion | undefined {
  return state.drafts.find(draft => draft.id === state.currentDraftVersionId);
}

export function selectedStrategy(state: AgentProcessState): Strategy | undefined {
  return state.analysis?.strategies.find(item => item.id === state.userSelectedStrategyId);
}

export function currentReview(state: AgentProcessState): ReviewResult | undefined {
  const versionId = state.currentDraftVersionId;
  if (!versionId) return undefined;
  return [...state.reviews].reverse().find(review => review.draftVersionId === versionId && !review.invalidated);
}

export function unhandledIssues(state: AgentProcessState): ReviewIssue[] {
  return (currentReview(state)?.issues ?? []).filter(issue => !issue.handled);
}

export function selectedMaterials(state: AgentProcessState): MaterialEntry[] {
  return state.materials.filter(item => item.selected);
}

export function classificationKeyOf(classification: NoticeClassification): string {
  return JSON.stringify(classification);
}

export function selectedMaterialsFingerprint(state: AgentProcessState): string {
  return selectedMaterials(state)
    .map(item => `${item.id}\0${item.hash ?? ''}\0${item.relativePath ?? ''}`)
    .sort()
    .join('\n');
}

export function analysisBaselineStale(state: AgentProcessState): boolean {
  if (!state.analysis) return true;
  return state.analysis.materialFingerprint !== selectedMaterialsFingerprint(state)
    || state.analysis.classificationKey !== classificationKeyOf(state.classification);
}

function archiveCurrentAnalysis(state: AgentProcessState): void {
  if (!state.analysis) return;
  state.analysisHistory.push(state.analysis);
  state.analysis = null;
  state.userSelectedStrategyId = null;
  state.userSelectedStrategyAt = undefined;
  state.reviews.forEach(review => {
    review.invalidated = true;
  });
  if (state.stage !== 'final' && state.stage !== 'draft') state.stage = 'materials';
}

export function materialRefsOf(state: AgentProcessState, action: AgentAction = 'discuss'): MaterialRef[] {
  const selected = selectedMaterials(state);
  const source = selected.length || action !== 'discuss' ? selected : state.materials;
  return source.map(({ name, role, relativePath, hash }) => ({ name, role, relativePath, hash }));
}

function hostGuardsFor(state: AgentProcessState, action: AgentAction): HostGuard[] {
  const { caseId, processKey } = state.scope;
  const guards: HostGuard[] = [{
    kind: 'scope-freeze',
    caseId,
    processKey,
    note: '启动前应由 host 冻结本案本轮材料快照与范围；纯函数未执行磁盘校验。',
  }];
  for (const item of (action === 'discuss' ? (selectedMaterials(state).length ? selectedMaterials(state) : state.materials) : selectedMaterials(state))) {
    if (!item.relativePath) continue;
    guards.push({
      kind: 'managed-path',
      caseId,
      processKey,
      relativePath: item.relativePath,
      hash: item.hash,
      note: '仅复制已勾选且 ready 的相对路径，并由 host 核验非符号链接。',
    });
    guards.push({
      kind: 'non-symlink',
      caseId,
      processKey,
      relativePath: item.relativePath,
      note: '路径权限与非符号链接由 host 校验，纯函数不假装完成磁盘保护。',
    });
  }
  if (action === 'draft' || action === 'revise' || action === 'review') {
    guards.push({
      kind: 'shared-draft-hash',
      caseId,
      processKey,
      expectedSharedDraftHash: state.expectedSharedDraftHash,
      expectedDraftVersionId: state.currentDraftVersionId ?? undefined,
      note: '写入成果前核对共享稿哈希与版本；冲突则保留待核对产物，不覆盖用户稿。',
    });
  }
  guards.push({
    kind: 'profile-generation',
    caseId,
    processKey,
    note: '运行中记录公开配置；模型设置变更只影响下一次新 run。凭证不得写入业务状态。',
  });
  return guards;
}

function flattenClassification(classification: NoticeClassification): Pick<PromptContext, 'patentType' | 'noticeCategory' | 'officeActionRound' | 'correctionBasis'> {
  if (classification.status === 'classified') {
    return {
      patentType: classification.patentType,
      noticeCategory: classification.noticeCategory,
      officeActionRound: classification.officeActionRound,
      correctionBasis: classification.correctionBasis,
    };
  }
  return {
    patentType: classification.patentType,
    noticeCategory: classification.noticeCategory,
    officeActionRound: classification.officeActionRound,
    correctionBasis: classification.correctionBasis,
  };
}

function promptContextOf(state: AgentProcessState, action: AgentAction, cmd: { userMessage?: string; draftVersionId?: string }): PromptContext {
  const draft = cmd.draftVersionId
    ? state.drafts.find(item => item.id === cmd.draftVersionId)
    : currentDraft(state);
  const includeDraft = action !== 'analysis';
  const includeStrategy = action === 'draft' || action === 'revise';
  const feedback = action === 'revise' ? currentReview(state) : undefined;
  return {
    stage: action,
    classification: state.classification,
    ...flattenClassification(state.classification),
    materialManifestRefs: materialRefsOf(state, action),
    selectedStrategy: includeStrategy ? selectedStrategy(state) : undefined,
    draftVersion: includeDraft && draft
      ? { id: draft.id, text: draft.text, amendmentText: draft.amendmentText, applicationParts:draft.applicationParts, correctionContents:draft.correctionContents, amendmentBasis: draft.amendmentBasis }
      : undefined,
    userMessage: cmd.userMessage,
    reviewFeedback: feedback && feedback.draftVersionId === draft?.id
      ? { draftVersionId: feedback.draftVersionId, summary: feedback.summary, issues: structuredClone(feedback.issues) } : undefined,
  };
}

function validateMaterial(entry: MaterialEntry): AgentFailure | null {
  if (!filled(entry.id) || !filled(entry.name) || !filled(entry.role)) return agentFail('ARTIFACT_INVALID', '材料清单缺少编号、名称或来源角色。');
  if (isUnsafePath(entry.relativePath) || isUnsafePath(entry.name)) return agentFail('ABSOLUTE_PATH');
  return null;
}

export type CreateProcessInput = {
  caseId: string;
  processKey?: string;
  processId?: string;
  roundId?: string;
  classification?: ClassificationInput;
  materials?: Array<Omit<MaterialEntry, 'selected'> & { selected?: boolean }>;
  access?: ProcessAccess;
  expectedSharedDraftHash?: string;
  mainDiscussionId?: string;
  at?: string;
};

export function createAgentProcess(input: CreateProcessInput): AgentResult {
  const caseId = input.caseId.trim();
  const processKey = resolveProcessKey(input);
  if (!caseId || !processKey) return agentFail('INVALID_SCOPE');
  const parsed = parseClassification(input.classification);
  if (!parsed.ok) return parsed;
  const classification = parsed.value!;
  const materials: MaterialEntry[] = [];
  for (const item of input.materials ?? []) {
    const entry: MaterialEntry = { ...item, selected: !!item.selected };
    const invalid = validateMaterial(entry);
    if (invalid) return invalid;
    materials.push(entry);
  }
  const duplicated = uniqueById(materials, '材料');
  if (duplicated) return duplicated;
  const mainDiscussionId = input.mainDiscussionId || newId();
  const state: AgentProcessState = {
    scope: { caseId, processKey },
    classification,
    access: input.access ?? 'editable',
    stage: 'materials',
    materials,
    materialsConfirmed: false,
    discussions: [{
      id: mainDiscussionId,
      kind: 'main',
      title: isReplyClassified(classification) ? '答复主讨论' : '本案讨论',
      messages: [],
      toolEvents: [],
    }],
    mainDiscussionId,
    jobs: [],
    activeRunId: null,
    analysis: null,
    analysisHistory: [],
    userSelectedStrategyId: null,
    drafts: [],
    currentDraftVersionId: null,
    expectedSharedDraftHash: input.expectedSharedDraftHash,
    reviews: [],
    finalized: null,
    finalizeHistory: [],
  };
  return ok(state);
}

export type ScopeCommand = { caseId: string; processKey: string };

export function updateClassification(state: AgentProcessState, cmd: ScopeCommand & { classification: ClassificationInput }): AgentResult {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  if (activeJob(state)) return agentFail('CLASSIFICATION_LOCKED');
  const parsed = parseClassification(cmd.classification);
  if (!parsed.ok) return parsed;
  const nextClass = parsed.value!;
  if (classificationKeyOf(state.classification) === classificationKeyOf(nextClass)) return ok(clone(state));
  const next = clone(state);
  next.classification = nextClass;
  if (!checkReplyWrite(next)) archiveCurrentAnalysis(next);
  return ok(next);
}

export function confirmMaterials(state: AgentProcessState, cmd: ScopeCommand & { selectedIds: string[]; at?: string }): AgentResult {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  const running = activeJob(state);
  if (running && FORMAL_ACTIONS.has(running.action)) return agentFail('JOB_RUNNING');
  const next = clone(state);
  const ids = new Set(cmd.selectedIds);
  for (const id of ids) {
    if (!next.materials.some(item => item.id === id)) return agentFail('UNKNOWN_MATERIAL');
  }
  for (const item of next.materials) item.selected = ids.has(item.id);
  const selected = selectedMaterials(next);
  if (!selected.length) return agentFail('NO_MATERIALS_SELECTED');
  if (selected.some(item => isUnsafePath(item.relativePath))) return agentFail('ABSOLUTE_PATH');
  const fingerprint = selectedMaterialsFingerprint(next);
  const discussionOnly = !!checkReplyWrite(state);
  if (discussionOnly) {
    next.materialsConfirmed = state.materialsConfirmed;
    next.confirmedMaterialFingerprint = state.confirmedMaterialFingerprint;
    next.materialsConfirmedAt = state.materialsConfirmedAt;
    return ok(next, { hostGuards: hostGuardsFor(next, 'discuss') });
  }
  const same = state.materialsConfirmed && fingerprint === state.confirmedMaterialFingerprint;
  next.materialsConfirmed = selected.every(item => item.ready);
  next.materialsConfirmedAt = nowIso(cmd.at);
  if (next.materialsConfirmed) next.confirmedMaterialFingerprint = fingerprint;
  if (!same && (state.analysis || state.reviews.some(item => !item.invalidated))) archiveCurrentAnalysis(next);
  return ok(next, { hostGuards: hostGuardsFor(next, 'discuss') });
}

export function syncProcessMaterials(state: AgentProcessState, incoming: MaterialEntry[], mode: 'formal' | 'discussion' = 'formal'): AgentResult {
  const mismatch = incoming.map(validateMaterial).find(Boolean);
  if (mismatch) return mismatch;
  const next = clone(state);
  const previous = new Map(state.materials.map(item => [item.id, item]));
  next.materials = incoming.map(item => {
    const old = previous.get(item.id);
    return { ...item, selected: old ? old.selected : !!item.selected };
  });
  if (mode === 'discussion' || checkReplyWrite(state)) return ok(next);
  if (state.materialsConfirmed && selectedMaterialsFingerprint(next) !== state.confirmedMaterialFingerprint) {
    next.materialsConfirmed = false;
    archiveCurrentAnalysis(next);
  }
  return ok(next);
}

export function openDiscussion(state: AgentProcessState, cmd: ScopeCommand & { title?: string }): AgentResult<{ discussionId: string }> {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  const next = clone(state);
  const discussion: Discussion = {
    id: newId(),
    kind: 'main',
    title: cmd.title?.trim() || `讨论 ${next.discussions.filter(item => item.kind === 'main').length + 1}`,
    messages: [],
    toolEvents: [],
  };
  next.discussions.push(discussion);
  return ok(next, { value: { discussionId: discussion.id } });
}

export function discussionCanDelete(state: AgentProcessState, id: string): boolean {
  const d=state.discussions.find(d=>d.id===id);
  return !!d && id!==state.mainDiscussionId && d.kind==='main' && !d.messages.length && !d.toolEvents.length
    && !state.jobs.some(j=>j.discussionId===id) && !state.discussions.some(d=>d.parentDiscussionId===id);
}

export function manageDiscussion(state: AgentProcessState, cmd: ScopeCommand & { discussionId:string; operation:'delete'|'archive'|'restore' }): AgentResult {
  const mismatch=checkScope(state,cmd);if(mismatch)return mismatch;
  if(!['delete','archive','restore'].includes(cmd.operation))return agentFail('DISCUSSION_KIND');
  if(activeJob(state))return agentFail('JOB_RUNNING');
  const d=state.discussions.find(d=>d.id===cmd.discussionId);
  if(!d)return agentFail('DISCUSSION_NOT_FOUND');
  if(cmd.operation==='delete'&&!discussionCanDelete(state,d.id))return agentFail('DISCUSSION_KIND','仅可删除没有内容和办理记录的附加讨论。');
  if(cmd.operation==='archive'&&(d.id===state.mainDiscussionId||d.kind==='review'))return agentFail('DISCUSSION_KIND','主讨论与独立复核保留在办理记录中。');
  const next=clone(state);
  if(cmd.operation==='delete')next.discussions=next.discussions.filter(x=>x.id!==d.id);
  else next.discussions.find(x=>x.id===d.id)!.archived=cmd.operation==='archive';
  return ok(next);
}

export function openReviewDiscussion(state: AgentProcessState, cmd: ScopeCommand & { draftVersionId: string; parentDiscussionId?: string; title?: string }): AgentResult<{ discussionId: string }> {
  const mismatch = checkScope(state, cmd) || checkReplyWrite(state);
  if (mismatch) return mismatch;
  if (!state.drafts.some(item => item.id === cmd.draftVersionId)) return agentFail('DRAFT_VERSION_REQUIRED');
  const parent = cmd.parentDiscussionId ?? state.mainDiscussionId;
  if (!state.discussions.some(item => item.id === parent && item.kind === 'main')) return agentFail('DISCUSSION_NOT_FOUND');
  const next = clone(state);
  const discussion: Discussion = {
    id: newId(),
    kind: 'review',
    title: cmd.title?.trim() || '独立复核',
    messages: [],
    toolEvents: [],
    boundDraftVersionId: cmd.draftVersionId,
    parentDiscussionId: parent,
  };
  next.discussions.push(discussion);
  return ok(next, { value: { discussionId: discussion.id } });
}

export type StartJobCommand = ScopeCommand & {
  action: AgentAction;
  discussionId: string;
  userMessage?: string;
  strategyId?: string;
  draftVersionId?: string;
  resumeFromRunId?: string;
  publicRuntime?: PublicRuntimeSnapshot;
  at?: string;
};

function discussionOf(state: AgentProcessState, discussionId: string): Discussion | undefined {
  return state.discussions.find(item => item.id === discussionId);
}

function isFailure(value: AgentFailure | Discussion): value is AgentFailure {
  return 'ok' in value;
}

function requireMainDiscussion(state: AgentProcessState, discussionId: string): AgentFailure | Discussion {
  const discussion = discussionOf(state, discussionId);
  if (!discussion) return agentFail('DISCUSSION_NOT_FOUND');
  if (discussion.archived) return agentFail('DISCUSSION_KIND', '请先恢复已归档讨论。');
  if (discussion.kind !== 'main') return agentFail('DISCUSSION_KIND');
  return discussion;
}

function requireReviewDiscussion(state: AgentProcessState, discussionId: string, draftVersionId: string): AgentFailure | Discussion {
  const discussion = discussionOf(state, discussionId);
  if (!discussion) return agentFail('DISCUSSION_NOT_FOUND');
  if (discussion.kind !== 'review') return agentFail('DISCUSSION_KIND', '独立复核必须使用单独的复核讨论，不能写入主讨论。');
  if (discussion.boundDraftVersionId !== draftVersionId) return agentFail('DRAFT_VERSION_MISMATCH');
  return discussion;
}

function canStart(state: AgentProcessState, cmd: StartJobCommand): AgentFailure | null {
  if (state.activeRunId) return agentFail('JOB_RUNNING');
  const replyWrite = checkReplyWrite(state);
  switch (cmd.action) {
    case 'analysis': {
      if (replyWrite) return replyWrite;
      if (!isReplyClassified(state.classification)) return agentFail('CLASSIFICATION_NOT_READY');
      if (!state.materialsConfirmed) return agentFail('MATERIALS_NOT_CONFIRMED');
      const selected = selectedMaterials(state);
      if (!selected.length) return agentFail('NO_MATERIALS_SELECTED');
      if (selected.some(item => !item.ready)) return agentFail('MATERIALS_NOT_READY');
      if (state.confirmedMaterialFingerprint && selectedMaterialsFingerprint(state) !== state.confirmedMaterialFingerprint) {
        return agentFail('MATERIALS_STALE');
      }
      const discussion = requireMainDiscussion(state, cmd.discussionId);
      return isFailure(discussion) ? discussion : null;
    }
    case 'discuss': {
      if (!filled(cmd.userMessage)) return agentFail('INVALID_PROMPT_INPUT', '讨论需要当前用户消息。');
      const discussion = requireMainDiscussion(state, cmd.discussionId);
      return isFailure(discussion) ? discussion : null;
    }
    case 'draft': {
      if (replyWrite) return replyWrite;
      if (!isReplyClassified(state.classification)) return agentFail('CLASSIFICATION_NOT_READY');
      if (analysisBaselineStale(state)) return agentFail('MATERIALS_STALE');
      if (!state.userSelectedStrategyId) return agentFail('STRATEGY_NOT_SELECTED');
      if (cmd.strategyId && cmd.strategyId !== state.userSelectedStrategyId) return agentFail('STRATEGY_INVALID');
      if (!selectedStrategy(state)) return agentFail('STRATEGY_INVALID');
      const discussion = requireMainDiscussion(state, cmd.discussionId);
      return isFailure(discussion) ? discussion : null;
    }
    case 'revise': {
      if (replyWrite) return replyWrite;
      if (!isReplyClassified(state.classification)) return agentFail('CLASSIFICATION_NOT_READY');
      if (analysisBaselineStale(state)) return agentFail('MATERIALS_STALE');
      if (!state.userSelectedStrategyId || !selectedStrategy(state)) return agentFail('STRATEGY_NOT_SELECTED');
      if (!state.currentDraftVersionId) return agentFail('DRAFT_VERSION_REQUIRED', '没有有效稿件，不能修改。');
      if (!filled(cmd.userMessage) && !currentReview(state)) return agentFail('INVALID_PROMPT_INPUT', '修改稿需要用户修改要求或复核结论。');
      const discussion = requireMainDiscussion(state, cmd.discussionId);
      return isFailure(discussion) ? discussion : null;
    }
    case 'review': {
      if (replyWrite) return replyWrite;
      if (!isReplyClassified(state.classification)) return agentFail('CLASSIFICATION_NOT_READY');
      if (analysisBaselineStale(state)) return agentFail('MATERIALS_STALE');
      const draftVersionId = cmd.draftVersionId || state.currentDraftVersionId;
      if (!draftVersionId || !state.drafts.some(item => item.id === draftVersionId)) return agentFail('DRAFT_VERSION_REQUIRED');
      const discussion = requireReviewDiscussion(state, cmd.discussionId, draftVersionId);
      return isFailure(discussion) ? discussion : null;
    }
    default:
      return agentFail('ACTION_NOT_ALLOWED');
  }
}

export function startAgentJob(state: AgentProcessState, cmd: StartJobCommand): AgentResult<{ job: AgentJob }> {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  const blocked = canStart(state, cmd);
  if (blocked) return blocked;
  const next = clone(state);
  if (cmd.action === 'analysis' && next.analysis) archiveCurrentAnalysis(next);
  const at = nowIso(cmd.at);
  const runId = newId();
  const reviewVersionId = cmd.action === 'review' ? (cmd.draftVersionId || state.currentDraftVersionId || undefined) : undefined;
  const job: AgentJob = {
    runId,
    discussionId: cmd.discussionId,
    action: cmd.action,
    state: 'running',
    startedAt: at,
    resumeFromRunId: cmd.resumeFromRunId,
    publicRuntime: cmd.publicRuntime ? {
      profileKey: cmd.publicRuntime.profileKey,
      model: cmd.publicRuntime.model,
      protocol: cmd.publicRuntime.protocol,
      reasoningLevel: cmd.publicRuntime.reasoningLevel,
    } : undefined,
    boundDraftVersionId: reviewVersionId,
    baseDraftVersionId: cmd.action === 'draft' || cmd.action === 'revise' ? state.currentDraftVersionId ?? undefined : undefined,
  };
  next.jobs.push(job);
  next.activeRunId = runId;
  const discussion = discussionOf(next, cmd.discussionId)!;
  if (filled(cmd.userMessage)) {
    discussion.messages.push({ id: newId(), role: 'user', text: cmd.userMessage.trim(), at, runId });
  }
  return ok(next, {
    hostGuards: hostGuardsFor(next, cmd.action),
    promptContext: promptContextOf(next, cmd.action, { userMessage: cmd.userMessage, draftVersionId: cmd.draftVersionId || reviewVersionId }),
    value: { job },
  });
}

const TOOL_KINDS = new Set<ToolKind>(['read_material', 'read_draft', 'read_skill', 'write_artifact', 'web_search', 'web_fetch', 'ensure_tool', 'discover_tools', 'execute_command', 'download_file', 'prepare_material', 'read_work_file','custom_mcp']);

export function recordToolEvent(state: AgentProcessState, cmd: ScopeCommand & {
  runId: string;
  filename: string;
  detail?: string;
  readRange?: string;
  status: ToolEventStatus;
  materialId?: string;
  toolKind?: ToolKind;
  at?: string;
}): AgentResult<{ event: ToolEvent }> {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  if (cmd.runId !== state.activeRunId) return agentFail('STALE_RUN');
  const job = activeJob(state);
  if (!job || job.state !== 'running') return agentFail('JOB_NOT_RUNNING');
  if (!TOOL_STATUSES.has(cmd.status)) return agentFail('ARTIFACT_INVALID', '工具事件状态无效。');
  if (!filled(cmd.filename) || isUnsafePath(cmd.filename)) return agentFail('ABSOLUTE_PATH');
  if (cmd.materialId && (isUnsafePath(cmd.materialId) || !cmd.materialId.trim())) return agentFail('ABSOLUTE_PATH');
  if (cmd.toolKind && !TOOL_KINDS.has(cmd.toolKind)) return agentFail('ARTIFACT_INVALID', '工具类型无效。');
  const next = clone(state);
  const running = activeJob(next)!;
  const discussion = discussionOf(next, running.discussionId);
  if (!discussion) return agentFail('DISCUSSION_NOT_FOUND');
  const event: ToolEvent = {
    id: newId(),
    runId: cmd.runId,
    filename: cmd.filename.trim(),
    detail: cmd.detail?.slice(0, 24000),
    readRange: cmd.readRange?.trim() || undefined,
    status: cmd.status,
    at: nowIso(cmd.at),
    materialId: cmd.materialId?.trim() || undefined,
    toolKind: cmd.toolKind,
  };
  discussion.toolEvents.push(event);
  return ok(next, { value: { event } });
}

function endJob(state: AgentProcessState, runId: string, jobState: Exclude<AgentJobState, 'running'>, at: string, error?: string): AgentJob | undefined {
  const job = state.jobs.find(item => item.runId === runId);
  if (!job) return undefined;
  job.state = jobState;
  job.endedAt = at;
  if (error) job.error = error;
  if (state.activeRunId === runId) state.activeRunId = null;
  return job;
}

export function stopAgentJob(state: AgentProcessState, cmd: ScopeCommand & { runId?: string; at?: string }): AgentResult<{ job: AgentJob }> {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  const runId = cmd.runId || state.activeRunId;
  if (!runId || runId !== state.activeRunId) return agentFail('STALE_RUN');
  const current = activeJob(state);
  if (!current || current.state !== 'running') return agentFail('JOB_NOT_RUNNING');
  const next = clone(state);
  const job = endJob(next, runId, 'stopped', nowIso(cmd.at), '用户已停止任务。')!;
  return ok(next, { value: { job } });
}

export function failAgentJob(state: AgentProcessState, cmd: ScopeCommand & { runId: string; error: string; at?: string }): AgentResult<{ job: AgentJob }> {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  if (cmd.runId !== state.activeRunId) return agentFail('STALE_RUN');
  const current = activeJob(state);
  if (!current || current.state !== 'running') return agentFail('JOB_NOT_RUNNING');
  const next = clone(state);
  const job = endJob(next, cmd.runId, 'failed', nowIso(cmd.at), cmd.error.trim() || '任务失败。')!;
  return ok(next, { value: { job } });
}

export function markStoppedOnReopen(state: AgentProcessState, cmd: ScopeCommand & { at?: string } = { caseId: state.scope.caseId, processKey: state.scope.processKey }): AgentResult {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  const next = clone(state);
  const running = activeJob(next);
  if (running && running.state === 'running') endJob(next, running.runId, 'stopped', nowIso(cmd.at), '应用重开，任务已停止，未自动继续。');
  return ok(next);
}

function parseOpinions(value: unknown): OpinionItem[] | AgentFailure {
  if (!Array.isArray(value) || value.length < 1) return agentFail('ARTIFACT_INVALID', '分析结果必须包含通知意见拆解。');
  const items: OpinionItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return agentFail('ARTIFACT_INVALID', '意见拆解格式无效。');
    const item = raw as Record<string, unknown>;
    if (!filled(item.id) || !filled(item.title) || !filled(item.summary) || !filled(item.basis)) {
      return agentFail('ARTIFACT_INVALID', '意见拆解必须包含编号、标题、摘要和材料依据。');
    }
    items.push({ id: item.id.trim(), title: item.title.trim(), summary: item.summary.trim(), basis: item.basis.trim() });
  }
  return uniqueById(items, '意见') ?? items;
}

function parseStrategies(value: unknown): Strategy[] | AgentFailure {
  if (!Array.isArray(value) || value.length < 2) return agentFail('ARTIFACT_INVALID', '分析结果必须包含至少两个可供选择的策略。');
  const items: Strategy[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return agentFail('ARTIFACT_INVALID', '策略格式无效。');
    const item = raw as Record<string, unknown>;
    if (!filled(item.id) || !filled(item.title) || !filled(item.summary) || !filled(item.benefits) || !filled(item.risks) || !filled(item.basis)) {
      return agentFail('ARTIFACT_INVALID', '策略必须包含编号、标题、摘要、收益、风险和材料依据。');
    }
    items.push({
      id: item.id.trim(),
      title: item.title.trim(),
      summary: item.summary.trim(),
      benefits: item.benefits.trim(),
      risks: item.risks.trim(),
      basis: item.basis.trim(),
    });
  }
  return uniqueById(items, '策略') ?? items;
}

function parseIssues(value: unknown): ReviewIssue[] | AgentFailure {
  if (!Array.isArray(value)) return agentFail('ARTIFACT_INVALID', '复核结果必须包含 issues 列表。');
  const items: ReviewIssue[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return agentFail('ARTIFACT_INVALID', '复核问题格式无效。');
    const item = raw as Record<string, unknown>;
    if (!filled(item.id) || !filled(item.finding) || !filled(item.basis) || !filled(item.suggestion)) {
      return agentFail('ARTIFACT_INVALID', '复核问题必须包含编号、发现、依据和建议。');
    }
    if (!SEVERITIES.has(item.severity as IssueSeverity)) return agentFail('ARTIFACT_INVALID', '复核问题严重程度无效。');
    items.push({
      id: item.id.trim(),
      severity: item.severity as IssueSeverity,
      finding: item.finding.trim(),
      basis: item.basis.trim(),
      suggestion: item.suggestion.trim(),
      handled: false,
    });
  }
  return uniqueById(items, '复核问题') ?? items;
}

function appendAssistant(state: AgentProcessState, discussionId: string, text: string, at: string, runId: string): void {
  const discussion = discussionOf(state, discussionId);
  if (!discussion) return;
  discussion.messages.push({ id: newId(), role: 'assistant', text, at, runId });
}

function successfulReads(state: AgentProcessState, runId: string): ToolEvent[] {
  const job = state.jobs.find(item => item.runId === runId);
  const discussion = job ? discussionOf(state, job.discussionId) : undefined;
  return (discussion?.toolEvents ?? []).filter(event => event.runId === runId && event.status === 'ok');
}

export function missingFormalReads(state: AgentProcessState, runId: string): AgentFailure | null {
  const job = state.jobs.find(item => item.runId === runId);
  if (!job || !FORMAL_ACTIONS.has(job.action)) return null;
  const required = selectedMaterials(state).filter(item => item.ready && (item.name || item.relativePath));
  if (job.action === 'analysis' && !required.length) return agentFail('NO_MATERIALS_SELECTED');
  const reads = successfulReads(state, runId);
  const materialReads = reads.filter(event => (event.toolKind === 'read_material' || event.toolKind === 'read_work_file') && event.materialId);
  const readIds = new Set(materialReads.map(event => event.materialId!));
  const missing = required.filter(item => !readIds.has(item.id));
  if (missing.length) {
    if (!materialReads.length) return agentFail('MATERIALS_UNREAD');
    return agentFail('MATERIALS_UNREAD', `正式任务完成前必须实际读取：${missing.map(item => item.name).join('、')}。`);
  }
  if (job.action === 'review' && !reads.some(event => event.toolKind === 'read_draft')) {
    return agentFail('MATERIALS_UNREAD', '正式复核完成前必须实际读取当前稿件，不能仅凭模型自述。');
  }
  return null;
}

export function completeAgentJob(state: AgentProcessState, cmd: ScopeCommand & {
  runId: string;
  artifact: JobArtifact;
  assistantText?: string;
  at?: string;
}): AgentResult {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  const current = activeJob(state);
  if (!current) return agentFail('STALE_RUN');
  if (cmd.runId !== current.runId || cmd.runId !== state.activeRunId) return agentFail('STALE_RUN');
  if (current.state !== 'running') return agentFail('JOB_NOT_RUNNING');
  const artifact = cmd.artifact;
  if (!artifact || artifact.kind !== current.action) return agentFail('ARTIFACT_INVALID', '产物类型与当前任务不一致。');
  const unread = missingFormalReads(state, current.runId);
  if (unread) return unread;
  const at = nowIso(cmd.at);
  const next = clone(state);
  const job = next.jobs.find(item => item.runId === cmd.runId)!;

  if (job.action === 'analysis') {
    if (artifact.kind !== 'analysis') return agentFail('ARTIFACT_INVALID', '产物类型与当前任务不一致。');
    const opinions = parseOpinions(artifact.opinions);
    if (!Array.isArray(opinions)) return opinions;
    const strategies = parseStrategies(artifact.strategies);
    if (!Array.isArray(strategies)) return strategies;
    next.analysis = {
      runId: cmd.runId,
      opinions,
      strategies,
      at,
      materialFingerprint: selectedMaterialsFingerprint(next),
      classificationKey: classificationKeyOf(next.classification),
    };
    next.userSelectedStrategyId = null;
    next.userSelectedStrategyAt = undefined;
    next.stage = 'strategy';
    endJob(next, cmd.runId, 'completed', at);
    appendAssistant(next, job.discussionId, cmd.assistantText?.trim() || '已完成本次意见拆解，并给出可供选择的策略。请选定策略后再起草。', at, cmd.runId);
    return ok(next);
  }

  if (job.action === 'discuss') {
    if (artifact.kind !== 'discuss' || !filled(artifact.reply)) return agentFail('ARTIFACT_INVALID', '讨论产物缺少回复文本。');
    endJob(next, cmd.runId, 'completed', at);
    appendAssistant(next, job.discussionId, cmd.assistantText?.trim() || artifact.reply.trim(), at, cmd.runId);
    return ok(next);
  }

  if (job.action === 'draft' || job.action === 'revise') {
    if (artifact.kind !== job.action) return agentFail('ARTIFACT_INVALID', '产物类型与当前任务不一致。');
    if (!filled(artifact.body) || !filled(artifact.amendmentText) || !filled(artifact.amendmentBasis) || !filled(artifact.reviewNotes)) {
      return agentFail('ARTIFACT_INVALID', '起草产物必须将正文、建议修改文本、修改依据与内部复核说明分开并写明。');
    }
    if (artifact.strategyId !== next.userSelectedStrategyId) {
      return agentFail('STRATEGY_INVALID', job.action === 'revise'
        ? '修改稿不能自动更换策略。如需更换，请用户重新选定。'
        : '起草结果中的策略与用户选定不一致，已拒绝该结果。');
    }
    const version: DraftVersion = {
      id: newId(),
      source: job.action === 'revise' ? 'generated-revise' : 'generated-initial',
      text: artifact.body.trim(),
      amendmentText: artifact.amendmentText.trim(),
      applicationParts:artifact.applicationParts===undefined?undefined:validateApplicationParts(artifact.applicationParts),
      correctionContents:artifact.correctionContents===undefined?undefined:validateCorrectionContents(artifact.correctionContents),
      amendmentBasis: artifact.amendmentBasis.trim(),
      reviewNotes: artifact.reviewNotes.trim(),
      at,
      runId: cmd.runId,
      strategyId: next.userSelectedStrategyId ?? undefined,
      basedOnVersionId: job.baseDraftVersionId,
      adoptStatus: 'pending',
    };
    next.drafts.push(version);
    next.stage = 'draft';
    endJob(next, cmd.runId, 'completed', at);
    appendAssistant(next, job.discussionId, cmd.assistantText?.trim() || (job.action === 'revise' ? '已生成独立修改稿版本，等待采用，不会覆盖现有用户稿。' : '已生成独立初稿版本，等待采用，不会覆盖现有用户稿。'), at, cmd.runId);
    return ok(next, { value: { versionId: version.id } });
  }

  if (job.action === 'review') {
    if (artifact.kind !== 'review') return agentFail('ARTIFACT_INVALID', '产物类型与当前任务不一致。');
    const bound = job.boundDraftVersionId ?? discussionOf(next, job.discussionId)?.boundDraftVersionId;
    if (!bound || artifact.draftVersionId !== bound) return agentFail('DRAFT_VERSION_MISMATCH');
    if (!filled(artifact.summary)) return agentFail('ARTIFACT_INVALID', '复核结果必须包含摘要。');
    const issues = parseIssues(artifact.issues);
    if (!Array.isArray(issues)) return issues;
    const matchesCurrent = bound === next.currentDraftVersionId;
    const review: ReviewResult = {
      id: newId(),
      runId: cmd.runId,
      discussionId: job.discussionId,
      draftVersionId: bound,
      issues,
      summary: artifact.summary.trim(),
      at,
      invalidated: !matchesCurrent,
    };
    next.reviews.push(review);
    if (matchesCurrent) next.stage = 'review';
    endJob(next, cmd.runId, 'completed', at);
    appendAssistant(next, job.discussionId, cmd.assistantText?.trim() || (
      !matchesCurrent
        ? '复核所绑定的稿件已不是当前稿，该复核不能当作当前稿已审。'
        : issues.length ? '独立复核已完成，请回到主讨论处理问题后再定稿。' : '独立复核未发现问题。定稿仍需用户确认。'
    ), at, cmd.runId);
    return ok(next, { value: { reviewId: review.id, invalidated: review.invalidated } });
  }

  return agentFail('ACTION_NOT_ALLOWED');
}

export function selectStrategy(state: AgentProcessState, cmd: ScopeCommand & { strategyId: string; at?: string }): AgentResult<{ strategy: Strategy }> {
  const mismatch = checkScope(state, cmd) || checkReplyWrite(state);
  if (mismatch) return mismatch;
  if (activeJob(state)) return agentFail('JOB_RUNNING');
  if (!state.analysis) return agentFail('ACTION_NOT_ALLOWED', '尚未完成意见分析，不能选定策略。');
  const strategy = state.analysis.strategies.find(item => item.id === cmd.strategyId);
  if (!strategy) return agentFail('STRATEGY_INVALID');
  const next = clone(state);
  const previous = next.userSelectedStrategyId;
  next.userSelectedStrategyId = strategy.id;
  next.userSelectedStrategyAt = nowIso(cmd.at);
  if (previous && previous !== strategy.id) {
    next.currentDraftVersionId = null;
    next.reviews.forEach(review => {
      review.invalidated = true;
    });
    next.stage = 'strategy';
  }
  return ok(next, { value: { strategy } });
}

export function adoptDraft(state: AgentProcessState, cmd: ScopeCommand & {
  versionId: string;
  sharedDraftHash?: string;
  expectedSharedDraftHash?: string;
  at?: string;
}): AgentResult<{ version: DraftVersion }> {
  const mismatch = checkScope(state, cmd) || checkReplyWrite(state);
  if (mismatch) return mismatch;
  if (activeJob(state)) return agentFail('JOB_RUNNING');
  const next = clone(state);
  const version = next.drafts.find(item => item.id === cmd.versionId);
  if (!version) return agentFail('DRAFT_VERSION_REQUIRED', '没有可采用的稿件版本。');
  if (next.userSelectedStrategyId && version.strategyId && version.strategyId !== next.userSelectedStrategyId) {
    return agentFail('STRATEGY_INVALID', '该稿件属于其他策略，不能作为当前选定策略的候选。历史版本已保留。');
  }
  const expected = cmd.expectedSharedDraftHash ?? next.expectedSharedDraftHash;
  if (cmd.sharedDraftHash && expected && cmd.sharedDraftHash !== expected) {
    version.adoptStatus = 'conflict';
    return agentFail('ADOPT_CONFLICT');
  }
  version.adoptStatus = 'adopted';
  version.reviewMaterials ??= structuredClone(selectedMaterials(next));
  const previous = next.currentDraftVersionId;
  next.currentDraftVersionId = version.id;
  next.expectedSharedDraftHash = cmd.sharedDraftHash ?? next.expectedSharedDraftHash;
  if (previous && previous !== version.id) {
    next.reviews.forEach(review => {
      if (review.draftVersionId !== version.id) review.invalidated = true;
    });
  }
  next.stage = 'draft';
  return ok(next, {
    hostGuards: hostGuardsFor(next, 'draft'),
    value: { version },
  });
}

export function latestUserDraft(state: AgentProcessState): DraftVersion | undefined {
  return [...state.drafts].reverse().find(item => item.source === 'user');
}

export function shouldRecordUserDraft(state: AgentProcessState, text: string, observedHash?: string, lastObservedHash?: string): boolean {
  if (!filled(text)) return false;
  if (observedHash && lastObservedHash && observedHash === lastObservedHash) return false;
  const current = currentDraft(state);
  if (current?.source === 'user' && current.text === text) return false;
  const lastUser = latestUserDraft(state);
  if (lastUser?.text === text) return false;
  return true;
}

export function recordUserDraft(state: AgentProcessState, cmd: ScopeCommand & {
  text: string;
  amendmentText?: string;
  applicationParts?:ApplicationParts;
  correctionContents?:CorrectionContent[];
  amendmentBasis?: string;
  reviewNotes?: string;
  at?: string;
}): AgentResult<{ version: DraftVersion }> {
  const mismatch = checkScope(state, cmd) || checkReplyWrite(state);
  if (mismatch) return mismatch;
  if (!filled(cmd.text)) return agentFail('ARTIFACT_INVALID', '用户稿不能为空。');
  const next = clone(state);
  const previous = currentDraft(next);
  const version: DraftVersion = {
    id: newId(),
    source: 'user',
    text: cmd.text,
    amendmentText: cmd.amendmentText ?? previous?.amendmentText ?? '',
    applicationParts:cmd.applicationParts===undefined?previous?.applicationParts:validateApplicationParts(cmd.applicationParts),
    correctionContents:cmd.correctionContents===undefined?previous?.correctionContents:validateCorrectionContents(cmd.correctionContents),
    amendmentBasis: cmd.amendmentBasis ?? previous?.amendmentBasis ?? '',
    reviewNotes: cmd.reviewNotes ?? previous?.reviewNotes ?? '',
    reviewMaterials: previous?.reviewMaterials,
    at: nowIso(cmd.at),
    strategyId: next.userSelectedStrategyId ?? undefined,
    basedOnVersionId: next.currentDraftVersionId ?? undefined,
    adoptStatus: 'adopted',
  };
  next.drafts.push(version);
  next.currentDraftVersionId = version.id;
  next.reviews.forEach(review => {
    if (review.draftVersionId !== version.id) review.invalidated = true;
  });
  next.stage = 'draft';
  return ok(next, { value: { version } });
}

export function confirmReviewIssuesHandled(state: AgentProcessState, cmd: ScopeCommand & {
  reviewId: string;
  issueIds: string[];
  handled?: boolean;
}): AgentResult<{ review: ReviewResult }> {
  const mismatch = checkScope(state, cmd) || checkReplyWrite(state);
  if (mismatch) return mismatch;
  const next = clone(state);
  const review = next.reviews.find(item => item.id === cmd.reviewId);
  if (!review) return agentFail('REVIEW_REQUIRED');
  if (review.invalidated) return agentFail('REVIEW_STALE');
  const ids = new Set(cmd.issueIds);
  for (const id of ids) {
    if (!review.issues.some(issue => issue.id === id)) return agentFail('ARTIFACT_INVALID', '复核处理列表包含未知问题。');
  }
  const flag = cmd.handled !== false;
  for (const issue of review.issues) {
    if (ids.has(issue.id)) issue.handled = flag;
  }
  return ok(next, { value: { review } });
}

export function finalizeBlocker(state: AgentProcessState): AgentFailure | null {
  const locked = checkReplyWrite(state);
  if (locked) return locked;
  if (activeJob(state)) return agentFail('JOB_RUNNING');
  const draft = currentDraft(state);
  if (!draft) return agentFail('DRAFT_VERSION_REQUIRED', '没有有效稿件，不能定稿。');
  if (state.userSelectedStrategyId && draft.strategyId && draft.strategyId !== state.userSelectedStrategyId) {
    return agentFail('STRATEGY_INVALID', '当前稿件不属于用户选定的策略，请按新策略起草并复核。');
  }
  const matching = [...state.reviews].reverse().find(review => review.draftVersionId === draft.id);
  if (!matching) return state.reviews.length ? agentFail('REVIEW_STALE') : agentFail('REVIEW_REQUIRED');
  if (matching.invalidated) return agentFail('REVIEW_STALE');
  if (matching.issues.some(issue => !issue.handled)) return agentFail('UNHANDLED_ISSUES');
  return null;
}

export function canFinalizeProcess(state: AgentProcessState): boolean {
  return finalizeBlocker(state) === null;
}

export function finalizeProcess(state: AgentProcessState, cmd: ScopeCommand & { at?: string }): AgentResult<{ finalized: FinalizeRecord }> {
  const mismatch = checkScope(state, cmd);
  if (mismatch) return mismatch;
  const blocked = finalizeBlocker(state);
  if (blocked) return blocked;
  const next = clone(state);
  const draft = currentDraft(next)!;
  const record: FinalizeRecord = {
    draftVersionId: draft.id,
    text: draft.text,
    at: nowIso(cmd.at),
    word: { generated: false, status: 'not-connected', message: WORD_NOT_CONNECTED },
  };
  next.finalized = record;
  next.finalizeHistory = [...next.finalizeHistory, record];
  next.stage = 'final';
  return ok(next, { value: { finalized: record } });
}

export function emptyAgentBook(): AgentBook {
  return { processes: [] };
}

export function findProcess(book: AgentBook, caseId: string, processKey: string): AgentProcessState | undefined {
  return book.processes.find(item => item.scope.caseId === caseId && item.scope.processKey === processKey);
}

export function upsertProcess(book: AgentBook, state: AgentProcessState): AgentBook {
  const exists = book.processes.some(item => item.scope.caseId === state.scope.caseId && item.scope.processKey === state.scope.processKey);
  return {
    processes: exists
      ? book.processes.map(item => item.scope.caseId === state.scope.caseId && item.scope.processKey === state.scope.processKey ? state : item)
      : [...book.processes, state],
  };
}

export function hasRunningJobForCase(book: AgentBook, caseId: string): boolean {
  return book.processes.some(item => item.scope.caseId === caseId && !!activeJob(item));
}

export function mapProcess(book: AgentBook, caseId: string, processKey: string, fn: (state: AgentProcessState) => AgentResult): BookResult {
  const state = findProcess(book, caseId, processKey);
  if (!state) return agentFail('PROCESS_NOT_FOUND');
  const result = fn(state);
  if (!result.ok) return result;
  return { ...result, book: upsertProcess(book, result.state) };
}

export function startAgentJobInBook(book: AgentBook, cmd: StartJobCommand): BookResult<{ job: AgentJob }> {
  if (hasRunningJobForCase(book, cmd.caseId)) return agentFail('CASE_BUSY');
  const mapped = mapProcess(book, cmd.caseId, cmd.processKey, state => startAgentJob(state, cmd));
  return mapped as BookResult<{ job: AgentJob }>;
}
