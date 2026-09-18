import { diagnostic, diagnosticError, diagnosticStage, withDiagnostics } from './diagnostics.ts';
import { localProgress } from '../src/domain/local-progress.ts';
import { workflowMessageCommand, discussionJobs, forkConversation, preserveInterruptedOutput, switchConversationBranch } from '../src/domain/conversation.ts';
import {validateCorrectionContents} from '../src/domain/correction.ts';
import {APPLICATION_PART_LABELS,validateApplicationParts} from '../src/domain/application-parts.ts';
import { loadStandardSkill, SKILL_ADAPTER } from './standard-skills.ts';
import { classificationSuggestion } from './agent-classification.ts';
import { exportReplyDocx,exportApplicationParts,exportNoteDocx } from './document-export.ts';
import type { ClassificationSuggestion } from './agent-classification.ts';
import { readFrozenMaterial, MAX_MATERIAL_BYTES } from './agent-document-reader.ts';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAPI, AgentCaseView, AgentCommand, AgentTaskView, AgentPreparation } from '../src/agent-api.ts';
import type { AgentAction, AgentProcessState, DraftVersion, JobArtifact, MaterialEntry } from '../src/domain/agent.ts';
import {
  adoptDraft,
  completeAgentJob,
  confirmMaterials,
  confirmReviewIssuesHandled,
  createAgentProcess,
  currentDraft,
  failAgentJob,
  finalizeProcess,
  isReplyClassified,
  isUnsafePath,
  markStoppedOnReopen,
  openDiscussion,
  manageDiscussion,
  openReviewDiscussion,
  recordToolEvent,
  recordUserDraft,
  selectedMaterials,
  selectStrategy,
  shouldRecordUserDraft,
  startAgentJob,
  stopAgentJob,
  syncProcessMaterials,
  updateClassification,
  WORD_NOT_CONNECTED,
} from '../src/domain/agent.ts';
import { activeRound, currentWork, editableCurrent } from '../src/domain/lifecycle.ts';
import type { Case, Workspace } from '../src/domain/workflow.ts';
import type { ModelConfigPublic } from '../src/domain/models.ts';
import { atomicJSON, datedFolder, digest, managedPath, portable, processFolder, readJSON, readBoundedFile, safeName } from './files.ts';
import { parseAgentArtifact } from './agent-artifact.ts';
import { buildAgentPrompt } from './agent-rules.ts';
import type { DesktopService } from './service.ts';
import type { RuntimeModelConfig } from './model-service.ts';

export type AgentHostRuntimeConfig = RuntimeModelConfig;

export type AgentHostRunEvent =
  | { type: 'partial'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'activity'; label: string; stepId?: string; status?: string }
  | { type: 'tool'; filename: string; detail?: string; readRange?: string; status: 'started' | 'ok' | 'error' | 'stopped'; materialId?: string; toolKind?: 'read_material' | 'read_draft' | 'read_skill' | 'write_artifact' | 'web_search' | 'web_fetch' | 'ensure_tool' | 'discover_tools' | 'execute_command' | 'download_file' | 'prepare_material' | 'read_work_file' | 'custom_mcp' }
  | { type: 'artifact'; relativePath: string; kind?: string }
  | { type: 'completed'; outputText?: string }
  | { type: 'failed'; error: string }
  | { type: 'stopped' };

export type AgentHostMaterialSnapshot = {
  id: string;
  name: string;
  role: string;
  relativePath: string;
  hash: string;
  snapshotPath: string;
};

export type AgentHostRunInput = {
  validateArtifact?: (raw: string) => Promise<string | undefined>;
  artifactScope?: string;
  artifactExpect?: import('./agent-artifact.ts').ParseArtifactExpect;
  skillResources?: Array<{path:string;text:string}>;
  runId: string;
  caseId: string;
  processKey: string;
  action: AgentAction;
  discussionId: string;
  snapshotDir: string;
  outputDir: string;
  prompt: { rules: string; task: string; combined: string };
  materials: AgentHostMaterialSnapshot[];
  draft?: { id: string; text: string; amendmentText?: string; applicationParts?:import('../src/domain/application-parts.ts').ApplicationParts;correctionContents?:import('../src/domain/correction.ts').CorrectionContent[]; amendmentBasis?: string };
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  runtime: AgentHostRuntimeConfig;
  signal: AbortSignal;
  resumeFromRunId?: string;
  onEvent: (event: AgentHostRunEvent) => void | Promise<void>;
};

export type AgentHostRunHandle = { wait: Promise<void>; abort: () => void };
export type AgentHostRun = (input: AgentHostRunInput) => AgentHostRunHandle | Promise<AgentHostRunHandle>;

export type AgentModelService = {
  list(profileKey: string): Promise<ModelConfigPublic>;
  resolveRuntimeConfig(profileKey: string, conversationId: string): Promise<RuntimeModelConfig>;
};

export type AgentHostOptions = {
  beforeFormalRun?:(key:string,id:string)=>Promise<void>;
  desktopService: DesktopService;
  modelService: AgentModelService;
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
  rulesRoot: string;
  standardSkillsRoot?: string;
  run: AgentHostRun;
};

type AgentStore = {
  schema: 1;
  processes: AgentProcessState[];
  lastObservedHash: Record<string, string>;
  lastObservedText: Record<string, string>;
  partialText: Record<string, string>;
};

type SharedRunIndex = {
  schema: 1;
  caseId: string;
  profileKey: string;
  processKey: string;
  runId: string;
  at: string;
  files: Array<{ relativePath: string; hash: string; kind: string; title: string; at: string; versionId?: string }>;
};

type FrozenModel = NonNullable<AgentCaseView['model']>;

type RequestTicket = {
  profileKey: string;
  generation: number;
};

type LiveRun = {
  profileKey: string;
  generation: number;
  caseId: string;
  processKey: string;
  runId: string;
  workRoot: string;
  materialHashes: Record<string, string>;
  readAliases: Array<{ id: string; sourceId: string; name: string; fileName: string }>;
  startSharedDraftHash?: string;
  abort: AbortController;
  handle?: AgentHostRunHandle;
  settled: boolean;
  ignoreEvents: boolean;
  outputDir: string;
  outputText?: string;
  failed?: string;
  /** Set when terminal-state persistence failed; kept until a later persist succeeds. */
  persistAlert?: string;
  model: FrozenModel;
};

const STORE_SCHEMA = 1 as const;
const ACCOUNT_SWITCHED = '账号已切换，本次旧页面操作未保存。';
const STALE_SCOPE = '请求不属于当前案件或办理轮次。';
/** Marker when terminal settle could not write agent/state.json — UI/recovery must see this. */
const TERMINAL_PERSIST_UNSAVED = '状态未落盘';
const TERMINAL_PERSIST_ATTEMPTS = 3;

function emptyStore(): AgentStore {
  return { schema: STORE_SCHEMA, processes: [], lastObservedHash: {}, lastObservedText: {}, partialText: {} };
}

function processKeyOf(c: Case): string {
  const work = currentWork(c);
  return (work.processId || work.roundId || `local-${work.kind}`).trim();
}

function storeKey(caseId: string, processKey: string): string {
  return `${caseId}::${processKey}`;
}

function unwrap<T>(result: { ok: true; state: AgentProcessState; value?: T } | { ok: false; error: string }): AgentProcessState {
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

function errorMessage(error: unknown, fallback = '任务失败。'): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

async function assertNoSymlinkAncestors(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let cursor = path.resolve(target);
  for (;;) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('案件目录内不支持符号链接。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (cursor === resolvedRoot) return;
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function modelFromRuntime(runtime: RuntimeModelConfig): FrozenModel {
  return {
    providerName: runtime.providerName,
    modelId: runtime.modelId,
    protocol: runtime.protocol,
    reasoningLevel: runtime.reasoning.levelId,
  };
}

export class AgentHost implements AgentAPI {
  desktop: DesktopService;
  models: AgentModelService;
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
  rulesRoot: string;
  standardSkillsRoot?: string;
  run: AgentHostRun;
  private listeners = new Set<(view: AgentCaseView) => void>();
  private stores = new Map<string, AgentStore>();
  private corrupt = new Set<string>();
  private live = new Map<string, LiveRun>();
  private follows = new Set<Promise<void>>();
  private shuttingDown = false;
  private classificationCache = new Map<string, ClassificationSuggestion>();

  beforeFormalRun?:AgentHostOptions['beforeFormalRun'];
  constructor(options: AgentHostOptions) {
    this.beforeFormalRun=options.beforeFormalRun;
    this.desktop = options.desktopService;
    this.models = options.modelService;
    this.serialize = options.serialize;
    this.rulesRoot = options.rulesRoot;
    this.standardSkillsRoot = options.standardSkillsRoot;
    this.run = options.run;
  }

  onState(callback: (view: AgentCaseView) => void): () => void {
    return this.onChanged(callback);
  }

  onChanged(callback: (view: AgentCaseView) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  noteAccountChange(): void {
    for (const run of this.live.values()) {
      if (!this.liveScopeStillValid(run)) this.abortLive(run);
    }
  }

  hasRunningJobs(): boolean {
    return this.live.size > 0;
  }

  assertIdleForMigration(): void {
    if (this.hasRunningJobs()) throw new Error('有正在运行的 Agent 任务，请先停止后再迁移。');
    this.desktop.assertNotMigrating();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const run of this.live.values()) this.abortLive(run);
    await Promise.allSettled([...this.follows]);
    const key = this.desktop.key;
    const store = this.stores.get(key);
    if (store && !this.corrupt.has(key)) {
      try { await this.persistStore(key, store); }
      catch { /* exiting: keep last in-memory store */ }
    }
  }

  async waitIdle(): Promise<void> {
    await Promise.allSettled([...this.follows]);
  }

  async getCase(profileKey: string, caseId: string): Promise<AgentCaseView> {
    const ticket = this.capture(profileKey);
    return this.enqueue(() => this.getCaseAlreadyLocked(ticket, caseId));
  }

  async reviewSources(profileKey:string):Promise<import('../src/professional-api.ts').ReviewSource[]> {
    const ticket=this.capture(profileKey);
    return this.enqueue(async()=>{
      const store=await this.loadStore(profileKey);this.assertTicket(ticket);
      return store.processes.flatMap(state=>{
        if(!isReplyClassified(state.classification))return [];
        const c=this.desktop.workspace.cases.find(c=>c.id===state.scope.caseId);
        if(!c)return [];
        return state.drafts.filter(draft=>draft.adoptStatus==='adopted'&&(draft.source!=='user'||draft.applicationParts!==undefined||state.reviews.some(r=>r.draftVersionId===draft.id))).map(draft=>({
          id:`agent-${digest(state.scope.processKey+'-'+draft.id)}`,caseId:c.id,processKey:state.scope.processKey,
          title:`${state.classification.noticeCategory==='补正通知书'?'补正':'答复'} · 已采用稿件`,
          business:state.classification.noticeCategory==='补正通知书'?'补正' as const:'答复' as const,
          at:draft.at,text:draft.text,amendmentText:draft.amendmentText,applicationParts:draft.applicationParts,correctionContents:draft.correctionContents,amendmentBasis:draft.amendmentBasis,
          reports:state.reviews.filter(r=>r.draftVersionId===draft.id).map(r=>({
            id:'reply-review-'+r.id,caseId:c.id,processKey:state.scope.processKey,kind:'review' as const,sourceId:`agent-${digest(state.scope.processKey+'-'+draft.id)}`,
            state:'completed' as const,at:r.at,endedAt:r.at,text:[r.summary,...r.issues.map((i,n)=>`${n+1}. ${i.finding}\n依据：${i.basis}\n建议：${i.suggestion}\n处理：${i.handled?'已记录处理':'未记录处理'}`)].join('\n\n'),
            skillName:'答复独立复核',skillHash:'',tools:state.discussions.flatMap(d=>d.toolEvents).filter(t=>t.runId===r.runId).map(t=>({name:t.toolKind||t.filename,status:t.status})),
          })),
          supersededAt:state.currentDraftVersionId!==draft.id?new Date().toISOString():undefined,
          files:(draft.reviewMaterials??[]).filter(m=>m.ready&&m.relativePath).map(m=>({name:m.name,relativePath:m.relativePath!,hash:m.hash,role:m.role}))
        }));
      });
    });
  }

  async listProgress(profileKey: string) {
    const ticket = this.capture(profileKey);
    return this.enqueue(async () => {
      this.assertTicket(ticket);
      const store = await this.loadStore(profileKey);
      this.assertTicket(ticket);
      return store.processes.filter(p => { try { return processKeyOf(this.desktop.findCase(p.scope.caseId)) === p.scope.processKey; } catch { return false; } }).map(localProgress);
    });
  }

  async listTasks(profileKey: string): Promise<AgentTaskView[]> {
    const ticket = this.capture(profileKey);
    return this.enqueue(() => this.listTasksAlreadyLocked(ticket));
  }

  preparationChanged?:(event:AgentPreparation)=>void;
  private preparation(ticket:RequestTicket,caseId:string,step:AgentPreparation['step']){
    if(ticket.profileKey!==this.desktop.key||ticket.generation!==this.desktop.generation)return;
    const c=this.desktop.workspace.cases.find(c=>c.id===caseId);if(!c)return;
    this.preparationChanged?.({profileKey:ticket.profileKey,caseId,processKey:processKeyOf(c),step});
  }
  async command(profileKey: string, caseId: string, command: AgentCommand): Promise<AgentCaseView> {
    const ticket=this.capture(profileKey);
    const at=Date.now(),requestId=randomUUID();
    return withDiagnostics({requestId,caseId,operation:command.type},async()=>{
      diagnostic('host','command_received');
      this.preparation(ticket,caseId,'queued');
      try{return await diagnosticStage('host','command',{},()=>this.commandInternal(profileKey,caseId,command,at));}
      finally{this.preparation(ticket,caseId,'done');}
    });
  }
  private async commandInternal(profileKey: string, caseId: string, command: AgentCommand,queuedAt:number): Promise<AgentCaseView> {
    const ticket = this.capture(profileKey);
    if (command.type === 'conversation' && (command.operation === 'edit' || command.operation === 'regenerate')) {
      const stopped = await this.enqueue(async () => {
        diagnostic('host','command_dequeued',{durationMs:Date.now()-queuedAt});
        this.preparation(ticket,caseId,'preparing');
        this.assertTicket(ticket);
        const store = await this.loadStore(ticket.profileKey);
        const state = await this.ensureProcess(store, this.desktop.findCase(caseId));
        const discussion = state.discussions.find(d => d.id === command.discussionId && !d.archived);
        const message = discussion?.messages.find(m => m.id === command.messageId);
        if (!message || (command.operation === 'edit' && (message.role !== 'user' || !command.text?.trim())) || (command.operation === 'regenerate' && message.role !== 'assistant')) throw new Error('消息不存在或不能重新发送。');
        const live = this.live.get(caseId);
        if (live) this.abortLive(live);
        return { runId: live?.runId, wait: live?.handle?.wait, processKey: processKeyOf(this.desktop.findCase(caseId)) };
      });
      if (stopped.wait) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([stopped.wait.catch(() => undefined), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('后台尚未确认停止，请稍后重新发送。')), 15000); })]); }
        finally { clearTimeout(timer); }
      }
      return this.enqueue(async () => {
        this.assertTicket(ticket);
        if (processKeyOf(this.desktop.findCase(caseId)) !== stopped.processKey) throw new Error(STALE_SCOPE);
        const live = this.live.get(caseId);
        if (live && live.runId !== stopped.runId) throw new Error('当前活动任务已变更，请重新核对后发送。');
        if (live) await this.settleAlreadyLocked(live);
        return this.commandAlreadyLocked(ticket, caseId, command);
      });
    }
    return this.enqueue(() => {
      diagnostic('host','command_dequeued',{durationMs:Date.now()-queuedAt});
      this.preparation(ticket,caseId,'preparing');
      return this.commandAlreadyLocked(ticket, caseId, command);
    });
  }

  private capture(profileKey: string): RequestTicket {
    this.assertOpen();
    this.assertProfile(profileKey);
    return { profileKey, generation: this.desktop.generation };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialize(fn);
  }

  private track(work: Promise<void>): void {
    const followed = work.then(() => undefined, () => undefined);
    this.follows.add(followed);
    void followed.finally(() => this.follows.delete(followed));
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new Error('Agent 正在退出。');
  }

  private assertProfile(profileKey: string): void {
    if (profileKey !== this.desktop.key) throw new Error(ACCOUNT_SWITCHED);
  }

  private assertTicket(ticket: RequestTicket): void {
    this.assertProfile(ticket.profileKey);
    if (this.desktop.generation !== ticket.generation) throw new Error(ACCOUNT_SWITCHED);
  }

  private assertView(view: AgentCaseView, ticket: RequestTicket): void {
    if (view.profileKey !== ticket.profileKey || view.profileKey !== this.desktop.key) throw new Error(ACCOUNT_SWITCHED);
  }

  private emit(view: AgentCaseView): void {
    if (view.profileKey !== this.desktop.key) return;
    for (const listener of this.listeners) listener(view);
  }

  private abortLive(live: LiveRun): void {
    live.ignoreEvents = true;
    try { live.handle?.abort(); }
    catch { /* runner abort must not block host */ }
    if (!live.abort.signal.aborted) live.abort.abort();
  }

  private findLiveCase(live: LiveRun): Case | undefined {
    if (this.desktop.key !== live.profileKey) return;
    try { return this.desktop.findCase(live.caseId); }
    catch { return; }
  }

  private liveScopeStillValid(live: LiveRun, known: Case | undefined | 'lookup' = 'lookup'): boolean {
    if (live.profileKey !== this.desktop.key || live.generation !== this.desktop.generation) return false;
    if ((this.desktop.workspace.settings.workRoot || '') !== live.workRoot) return false;
    const current = known === 'lookup' ? this.findLiveCase(live) : known;
    return !!current && processKeyOf(current) === live.processKey;
  }

  private storePath(profileKey: string): string {
    return path.join(this.desktop.root, 'profiles', profileKey, 'agent', 'state.json');
  }

  private async loadStore(profileKey: string): Promise<AgentStore> {
    const cached = this.stores.get(profileKey);
    if (cached) return cached;
    const file = this.storePath(profileKey);
    try {
      const data = await readJSON<AgentStore | null>(file, null);
      if (!data) {
        const empty = emptyStore();
        this.stores.set(profileKey, empty);
        return empty;
      }
      if (data.schema !== STORE_SCHEMA || !Array.isArray(data.processes)) throw new Error('schema');
      const store: AgentStore = {
        schema: STORE_SCHEMA,
        processes: data.processes,
        lastObservedHash: data.lastObservedHash ?? {},
        lastObservedText: data.lastObservedText ?? {},
        partialText: data.partialText ?? {},
      };
      store.processes = store.processes.map(process => {
        if (!this.live.has(process.scope.caseId) && process.activeRunId) {
          const stopped = markStoppedOnReopen(process, process.scope);
          if (stopped.ok) { const job = stopped.state.jobs.find(j => j.runId === process.activeRunId); if (job) { job.partialText ??= store.partialText[storeKey(process.scope.caseId, process.scope.processKey)]; preserveInterruptedOutput(stopped.state, job.runId); } return stopped.state; }
          return process;
        }
        return process;
      });
      this.stores.set(profileKey, store);
      return store;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const empty = emptyStore();
        this.stores.set(profileKey, empty);
        return empty;
      }
      this.corrupt.add(profileKey);
      const empty = emptyStore();
      this.stores.set(profileKey, empty);
      return empty;
    }
  }

  private async persistStore(profileKey: string, store: AgentStore): Promise<void> {
    if (this.corrupt.has(profileKey)) return;
    await atomicJSON(this.storePath(profileKey), store);
  }

  private findProcess(store: AgentStore, caseId: string, processKey: string): AgentProcessState | undefined {
    return store.processes.find(item => item.scope.caseId === caseId && item.scope.processKey === processKey);
  }

  private putProcess(store: AgentStore, state: AgentProcessState): void {
    const index = store.processes.findIndex(item => item.scope.caseId === state.scope.caseId && item.scope.processKey === state.scope.processKey);
    if (index >= 0) store.processes[index] = state;
    else store.processes.push(state);
  }

  private async publicModel(profileKey: string): Promise<AgentCaseView['model']> {
    const listed = await this.models.list(profileKey);
    const provider = listed.providers.find(item => item.id === listed.defaultProviderId) ?? listed.providers[0];
    const model = provider?.models.find(item => item.id === listed.defaultModelId) ?? provider?.models[0];
    if (!provider || !model) return undefined;
    return {
      providerName: provider.name,
      modelId: model.modelId,
      protocol: model.protocol || provider.protocol || '',
      reasoningLevel: model.reasoning.selection.levelId,
    };
  }

  private async caseMaterials(c: Case): Promise<MaterialEntry[]> {
    const round = activeRound(c);
    const merged: MaterialEntry[] = [];
    const push = (item: { id: string; name: string; role: string; relativePath?: string; ready: boolean }) => {
      if (merged.some(existing => existing.id === item.id)) return;
      merged.push({
        id: item.id,
        name: item.name,
        role: item.role,
        relativePath: item.relativePath,
        ready: item.ready && !!item.relativePath,
        selected: false,
        hash: undefined,
      });
    };
    for (const item of round?.materials ?? []) push(item);
    for (const item of c.materials ?? []) push(item);
    for (const item of merged) {
      if (!item.relativePath || !item.ready || isUnsafePath(item.relativePath)) {
        if (isUnsafePath(item.relativePath)) item.ready = false;
        continue;
      }
      try {
        const abs = await this.desktop.casePath(c.id, item.relativePath);
        await assertNoSymlinkAncestors(path.dirname(abs), abs);
        const stat = await fs.lstat(abs);
        if (stat.isSymbolicLink()) {
          item.ready = false;
          continue;
        }
        item.hash = digest(await fs.readFile(abs));
      } catch {
        item.ready = false;
      }
    }
    return merged;
  }

  private defaultClassification(c: Case) {
    const kind = currentWork(c).kind;
    if (kind === 'reply' || kind === 'correction') return { status: 'unclassified' as const };
    return { status: 'unknown' as const };
  }

  private syncManualDraft(store: AgentStore, state: AgentProcessState, c: Case): AgentProcessState {
    const key = storeKey(c.id, state.scope.processKey);
    const text = c.localDraft ?? '';
    const hash = c.sharedDraftHash;
    if (!shouldRecordUserDraft(state, text, hash, store.lastObservedHash[key])) {
      if (hash) store.lastObservedHash[key] = hash;
      store.lastObservedText[key] = text;
      return state;
    }
    const next = unwrap(recordUserDraft(state, { caseId: c.id, processKey: state.scope.processKey, text }));
    if (hash) store.lastObservedHash[key] = hash;
    store.lastObservedText[key] = text;
    return next;
  }

  private async ensureProcess(store: AgentStore, c: Case): Promise<AgentProcessState> {
    const processKey = processKeyOf(c);
    const access = editableCurrent(c) ? 'editable' : 'readonly';
    const incoming = await this.caseMaterials(c);
    let state = this.findProcess(store, c.id, processKey);
    if (!state) {
      state = unwrap(createAgentProcess({
        caseId: c.id,
        processKey,
        classification: this.defaultClassification(c),
        materials: incoming,
        access,
        expectedSharedDraftHash: c.sharedDraftHash,
      }));
    } else {
      state = { ...state, access, expectedSharedDraftHash: c.sharedDraftHash };
      const synced = syncProcessMaterials(state, incoming.map(item => {
        const previous = state!.materials.find(existing => existing.id === item.id);
        return { ...item, selected: previous?.selected ?? item.selected };
      }), access === 'editable' && !state.finalized ? 'formal' : 'discussion');
      state = unwrap(synced);
    }
    if (!this.live.has(c.id) && state.activeRunId) {
      const stopped = markStoppedOnReopen(state, state.scope);
      if (stopped.ok) state = stopped.state;
    }
    state = this.syncManualDraft(store, state, c);
    this.putProcess(store, state);
    return state;
  }

  private async artifactsOf(profileKey: string, c: Case, processKey: string): Promise<AgentCaseView['artifacts']> {
    if (!c.directory) return [];
    let root: string;
    try { root = await this.desktop.casePath(c.id); }
    catch { return []; }
    const folder = path.join(root, '04_内部说明');
    let names: string[] = [];
    try { names = await fs.readdir(folder); }
    catch { return []; }
    const artifacts: AgentCaseView['artifacts'] = [];
    for (const name of names) {
      if ((!name.startsWith('agent-run-') && !name.startsWith('agent-final-')) || !name.endsWith('.json')) continue;
      const abs = path.join(folder, name);
      try {
        const stat = await fs.lstat(abs);
        if (stat.isSymbolicLink()) continue;
        await assertNoSymlinkAncestors(root, abs);
        const index = JSON.parse(await fs.readFile(abs, 'utf8')) as SharedRunIndex;
        if (index.schema !== 1 || index.caseId !== c.id || index.profileKey !== profileKey || index.processKey !== processKey) continue;
        for (const file of index.files ?? []) {
          if (isUnsafePath(file.relativePath)) continue;
          const target = await managedPath(root, file.relativePath);
          await assertNoSymlinkAncestors(root, target);
          const hash = digest(await fs.readFile(target));
          if (hash !== file.hash) continue;
          artifacts.push({
            id: `${index.runId}:${file.relativePath}`,
            title: file.title,
            kind: file.kind,
            relativePath: portable(file.relativePath),
            at: file.at,
            versionId: file.versionId,
          });
        }
      } catch { /* skip unreadable or mismatched indexes */ }
    }
    return artifacts;
  }

  private async suggestClassification(profileKey: string, c: Case, state: AgentProcessState): Promise<ClassificationSuggestion> {
    const round = c.rounds.find(r => r.id === c.current?.roundId || r.id === `proc-${c.current?.processId}`);
    const ids = new Set(round?.materials.map(m => m.id) ?? []);
    const notices = state.materials.filter(m => ids.has(m.id) && /通知|审查意见|补正/.test(m.name + m.role));
    const signature = JSON.stringify([profileKey, state.scope, c.type, c.remote?.processes, notices.map(m => [m.id, m.hash])]);
    const cached = this.classificationCache.get(signature);
    if (cached) return cached;
    const sources = notices.map(m => ({ name: `通知文件 ${m.name}`, text: m.name, read: false }));
    const failures: string[] = [];
    for (const material of notices.slice(0, 2)) {
      if (!material.ready || !material.relativePath || !material.hash) continue;
      try {
        const absoluteSnapshotPath = await this.desktop.casePath(c.id, material.relativePath);
        await assertNoSymlinkAncestors(path.dirname(absoluteSnapshotPath), absoluteSnapshotPath);
        const content = await readFrozenMaterial({ material: { ...material, relativePath: material.relativePath, hash: material.hash, absoluteSnapshotPath }, range: { startLine: 1, endLine: /\.pdf$/i.test(material.name) ? 1 : 30 } });
        if(content.some(x=>x.type==='image')){failures.push(`${material.name} 需要视觉核对；当前建议依据流程与文件名，尚未读取扫描页文字。`);continue;}
        const text = content.filter(x => x.type === 'text').map(x => x.text.slice(x.text.indexOf('\n\n') + 2)).join('\n');
        if (text.trim()) sources.push({ name: material.name, text, read: true });
      } catch { failures.push(`${material.name} 的文字未能自动读取；先根据当前流程和文件名提出建议，不能作为全文阅读完成。`); }
    }
    const result = classificationSuggestion(c, sources);
    result.warnings.push(...failures);
    if (this.classificationCache.size > 100) this.classificationCache.clear();
    this.classificationCache.set(signature, result);
    return result;
  }

  private async toView(profileKey: string, c: Case, state: AgentProcessState, store: AgentStore): Promise<AgentCaseView> {
    const key = storeKey(c.id, state.scope.processKey);
    const live = this.live.get(c.id);
    const liveMatches = !!live
      && live.profileKey === profileKey
      && live.caseId === c.id
      && live.processKey === state.scope.processKey;
    const frozen = liveMatches && live.runId === state.activeRunId ? live.model : undefined;
    return {
      profileKey,
      caseId: c.id,
      processKey: state.scope.processKey,
      process: structuredClone(state),
      classificationSuggestion: state.classification.status === 'classified' ? undefined : await this.suggestClassification(profileKey, c, state),
      busy: liveMatches || !!state.activeRunId,
      partialText: store.partialText[key],
      persistAlert: liveMatches && live?.persistAlert ? live.persistAlert : undefined,
      model: frozen ?? await this.publicModel(profileKey),
      artifacts: await this.artifactsOf(profileKey, c, state.scope.processKey),
    };
  }

  private async getCaseAlreadyLocked(ticket: RequestTicket, caseId: string): Promise<AgentCaseView> {
    this.assertTicket(ticket);
    const store = await this.loadStore(ticket.profileKey);
    this.assertTicket(ticket);
    const c = this.desktop.findCase(caseId);
    const state = await this.ensureProcess(store, c);
    if (processKeyOf(c) !== state.scope.processKey) throw new Error(STALE_SCOPE);
    this.assertTicket(ticket);
    await this.persistStore(ticket.profileKey, store);
    const view = await this.toView(ticket.profileKey, c, state, store);
    this.assertTicket(ticket);
    this.assertView(view, ticket);
    this.emit(view);
    return view;
  }

  private async listTasksAlreadyLocked(ticket: RequestTicket): Promise<AgentTaskView[]> {
    this.assertTicket(ticket);
    const store = await this.loadStore(ticket.profileKey);
    this.assertTicket(ticket);
    const tasks: AgentTaskView[] = [];
    for (const process of store.processes) {
      let c: Case | undefined;
      try { c = this.desktop.findCase(process.scope.caseId); }
      catch { continue; }
      if (processKeyOf(c) !== process.scope.processKey) continue;
      for (const job of process.jobs) {
        tasks.push({
          caseId: c.id,
          caseNumber: c.number,
          caseTitle: c.title,
          processKey: process.scope.processKey,
          discussionId: job.discussionId,
          runId: job.runId,
          action: job.action,
          state: job.state,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
          error: job.error,
        });
      }
    }
    this.assertTicket(ticket);
    return tasks;
  }

  private async commandAlreadyLocked(ticket: RequestTicket, caseId: string, command: AgentCommand): Promise<AgentCaseView> {
    this.assertTicket(ticket);
    const view = command.type === 'queue' ? await this.queueAlreadyLocked(ticket, caseId, command) : command.type === 'conversation'
      ? await this.conversationAlreadyLocked(ticket, caseId, command)
      : command.type === 'run'
      ? await this.startRunAlreadyLocked(ticket, caseId, command)
      : await this.mutateAlreadyLocked(ticket, caseId, command);
    this.assertTicket(ticket);
    this.assertView(view, ticket);
    this.emit(view);
    if(command.type==='strategy'&&command.startDraft){const started=await this.startRunAlreadyLocked(ticket,caseId,{type:'run',action:'draft',discussionId:view.process.mainDiscussionId,userMessage:command.userMessage,queueId:command.queueId});this.emit(started);return started;}
    return view;
  }

  private async queueAlreadyLocked(ticket:RequestTicket,caseId:string,command:Extract<AgentCommand,{type:'queue'}>):Promise<AgentCaseView>{
    this.assertTicket(ticket);this.desktop.assertNotMigrating();
    const store=await this.loadStore(ticket.profileKey),c=this.desktop.findCase(caseId);
    const state=await this.ensureProcess(store,c);
    const discussion=state.discussions.find(d=>d.id===command.discussionId&&!d.archived);
    if(!discussion)throw new Error('讨论不存在或已归档。');
    if(!['add','edit','remove','send'].includes(command.operation))throw new Error('队列操作无效。');
    const branchId=discussion.activeBranchId??'original';
    discussion.queuedMessages??=[];
    if(command.operation==='add'){
      if(typeof command.text!=='string'||!command.text.trim()||command.text.length>100000)throw new Error('待发送内容为空或过长。');
      if(command.purpose&&command.purpose!=='workflow'&&command.purpose!=='discuss')throw new Error('发送用途无效。');
      if(discussion.queuedMessages.length>=20)throw new Error('待发送消息已达20条，请先处理队列。');
      if(command.expectedRunId&&state.activeRunId&&command.expectedRunId!==state.activeRunId)throw new Error('活动任务已变化，请重新核对。');
      discussion.queuedMessages.push({id:randomUUID(),text:command.text.trim(),purpose:command.purpose??'discuss',analysisRunId:state.analysis?.runId,branchId,at:new Date().toISOString()});
    }else{
      const entry=discussion.queuedMessages.find(q=>q.id===command.id&&q.branchId===branchId);
      if(!entry)throw new Error('待发送消息不存在于当前分支。');
      if(command.operation==='remove')discussion.queuedMessages=discussion.queuedMessages.filter(q=>q.id!==entry.id);
      else if(command.operation==='edit'){if(!command.text?.trim())throw new Error('内容不能为空。');entry.text=command.text.trim();entry.error=undefined;}
      else if(command.operation==='send'){
        if(state.activeRunId||this.live.has(caseId))throw new Error('请等待当前任务完成。');
        return this.deliverQueuedAlreadyLocked(ticket,c,state,store,discussion.id,entry.id);
      }
    }
    this.putProcess(store,state);await this.persistStore(ticket.profileKey,store);
    return this.toView(ticket.profileKey,c,state,store);
  }

  private async deliverQueuedAlreadyLocked(ticket:RequestTicket,c:Case,state:AgentProcessState,store:AgentStore,discussionId:string,id:string):Promise<AgentCaseView>{
    const discussion=state.discussions.find(d=>d.id===discussionId)!;
    const entry=discussion.queuedMessages!.find(q=>q.id===id)!;
    let command:AgentCommand;
    try{command=entry.purpose==='workflow'?workflowMessageCommand(state,discussionId,entry.text):{type:'run',action:'discuss',discussionId,userMessage:entry.text};if(command.type==='strategy'&&entry.analysisRunId!==state.analysis?.runId)throw new Error('策略来自新的分析，请查看后重新选定。');}
    catch(e){entry.error=errorMessage(e);await this.persistStore(ticket.profileKey,store);return this.toView(ticket.profileKey,c,state,store);}
    if(command.type==='run'||command.type==='conversation'||command.type==='strategy')command={...command,queueId:id};
    try{return await this.commandAlreadyLocked(ticket,c.id,command);}
    catch(e){
      const latest=this.findProcess(store,c.id,state.scope.processKey)??state;
      const pending=latest.discussions.find(d=>d.id===discussionId)?.queuedMessages?.find(q=>q.id===id);
      if(pending){pending.error=errorMessage(e);await this.persistStore(ticket.profileKey,store);}
      return this.toView(ticket.profileKey,c,latest,store);
    }
  }

  private async mutateAlreadyLocked(ticket: RequestTicket, caseId: string, command: Exclude<AgentCommand, { type: 'run' }>): Promise<AgentCaseView> {
    this.assertTicket(ticket);
    this.desktop.assertNotMigrating();
    const store = await this.loadStore(ticket.profileKey);
    const c = this.desktop.findCase(caseId);
    let state = await this.ensureProcess(store, c);
    const scope = { caseId: c.id, processKey: state.scope.processKey };
    if (processKeyOf(c) !== state.scope.processKey) throw new Error(STALE_SCOPE);
    if (command.type === 'opened') { state = structuredClone(state); state.openedAt ??= new Date().toISOString(); }
    else if (command.type === 'clearConversation') {
      const d = state.discussions.find(d => d.id === command.discussionId);
      if (d?.queuedMessages?.length) throw new Error('请先处理或移除待发送消息，再清理会话。');
      state = forkConversation(state, command.discussionId, 0, randomUUID(), '清理后的会话');
    }
    else if (command.type === 'branch') state = switchConversationBranch(state, command.discussionId, command.branchId);
    else if (command.type === 'classify') state = unwrap(updateClassification(state, { ...scope, classification: command.classification }));
    else if (command.type === 'materials') state = unwrap(confirmMaterials(state, { ...scope, selectedIds: command.selectedIds }));
    else if (command.type === 'manageDiscussion') state = unwrap(manageDiscussion(state, { ...scope, ...command }));
    else if (command.type === 'discussion') state = unwrap(openDiscussion(state, { ...scope, title: command.title }));
    else if (command.type === 'stop') {
      const live = this.live.get(c.id);
      if (command.runId && live && live.runId !== command.runId) throw new Error('当前活动任务已变更，已拒绝过期结果。');
      if (live) this.abortLive(live);
      else state = unwrap(stopAgentJob(state, { ...scope, runId: command.runId }));
    } else if (command.type === 'strategy') {
      state = unwrap(selectStrategy(state, { ...scope, strategyId: command.strategyId }));
      if(command.queueId&&!command.startDraft)for(const d of state.discussions)d.queuedMessages=d.queuedMessages?.filter(q=>q.id!==command.queueId);
    }
    else if(command.type==='restoreDraft'){
      const source=state.drafts.find(d=>d.id===command.versionId);
      if(!source)throw new Error('历史稿件不存在。');
      if(source.strategyId&&source.strategyId!==state.userSelectedStrategyId)throw new Error('该历史稿件属于其他策略，请先核对策略。');
      state=structuredClone(state);
      const restored={...structuredClone(source),id:randomUUID(),at:new Date().toISOString(),basedOnVersionId:source.id,adoptStatus:'pending' as const,sourceSharedDraftHash:c.sharedDraftHash??''};
      state.drafts.push(restored);
      state=await this.adoptAlreadyLocked(ticket.profileKey,c,state,restored.id);
    }
    else if (command.type === 'adopt') state = await this.adoptAlreadyLocked(ticket.profileKey, c, state, command.versionId);
    else if (command.type === 'issues') state = unwrap(confirmReviewIssuesHandled(state, { ...scope, reviewId: command.reviewId, issueIds: command.issueIds, handled: command.handled }));
    else if(command.type==='correctionContents'){const d=currentDraft(state);if(!d)throw new Error('请先采用稿件。');state=unwrap(recordUserDraft(state,{...scope,text:d.text,correctionContents:validateCorrectionContents(command.items)}));}
    else if(command.type==='applicationParts'){const d=currentDraft(state);if(!d)throw new Error('请先采用稿件。');state=unwrap(recordUserDraft(state,{...scope,text:d.text,applicationParts:validateApplicationParts(command.parts)}));}
    else if(command.type==='updateDraft'){
      const d=currentDraft(state);if(!d)throw new Error('请先采用稿件。');
      state=unwrap(recordUserDraft(state,{
        ...scope,
        text: command.text ?? d.text,
        amendmentText: command.amendmentText ?? d.amendmentText,
        applicationParts: command.applicationParts !== undefined ? validateApplicationParts(command.applicationParts) : d.applicationParts,
        correctionContents: command.correctionContents !== undefined ? validateCorrectionContents(command.correctionContents) : d.correctionContents,
        amendmentBasis: command.amendmentBasis ?? d.amendmentBasis,
        reviewNotes: command.reviewNotes ?? d.reviewNotes,
      }));
    }
    else if (command.type === 'finalize') state = await this.finalizeAlreadyLocked(ticket.profileKey, c, state);
    else throw new Error('不支持的 Agent 命令。');
    this.assertTicket(ticket);
    this.putProcess(store, state);
    await this.persistStore(ticket.profileKey, store);
    return this.toView(ticket.profileKey, c, state, store);
  }

  private async conversationAlreadyLocked(ticket: RequestTicket, caseId: string, command: Extract<AgentCommand, { type: 'conversation' }>): Promise<AgentCaseView> {
    this.assertTicket(ticket);
    const store = await this.loadStore(ticket.profileKey);
    const c = this.desktop.findCase(caseId);
    let state = await this.ensureProcess(store, c);
    if (state.activeRunId || this.live.has(caseId)) throw new Error('当前任务尚未停止。');
    const discussion = state.discussions.find(d => d.id === command.discussionId);
    if (!discussion || discussion.archived) throw new Error('讨论不存在或已归档。');
    const message = discussion.messages.find(m => m.id === command.messageId);
    const job = discussionJobs(state, discussion).find(j => j.runId === (command.runId ?? message?.runId));
    if (!job) throw new Error('原任务不存在于当前分支。');
    if (command.operation === 'continue' && !['stopped', 'failed'].includes(job.state)) throw new Error('仅可继续已停止或失败的任务。');
    if (command.operation === 'edit' && (message?.role !== 'user' || !command.text?.trim())) throw new Error('请选择用户消息并填写修改内容。');
    if (command.operation === 'regenerate' && message?.role !== 'assistant') throw new Error('请选择要重新生成的回复。');
    let userMessage = command.operation === 'edit' ? command.text!.trim() : job.userMessage ?? discussion.messages.find(m => m.runId === job.runId && m.role === 'user')?.text ?? '请完成本轮任务。';
    if (command.operation !== 'continue') {
      let cut = command.operation === 'edit' ? discussion.messages.findIndex(m => m.id === command.messageId) : discussion.messages.findIndex(m => m.runId === job.runId);
      if (cut < 0) cut = discussion.messages.length;
      state = forkConversation(state, discussion.id, cut, randomUUID(), command.operation === 'edit' ? '编辑后重发' : '重新生成');
      // Runs without visible messages still need excluding from the new branch.
      const fork = state.discussions.find(d => d.id === discussion.id)!;
      const index = state.jobs.findIndex(j => j.runId === job.runId);
      const excluded = new Set(state.jobs.slice(index).filter(j => j.discussionId === discussion.id).map(j => j.runId));
      fork.branchRunIds = fork.branchRunIds?.filter(id => !excluded.has(id));
      fork.toolEvents = fork.toolEvents.filter(t => !excluded.has(t.runId));
    } else userMessage = `继续上次中断的任务：${userMessage}${command.text?.trim() ? '\n用户补充：' + command.text.trim() : ''}`;
    this.putProcess(store, state);
    await this.persistStore(ticket.profileKey, store);
    return this.startRunAlreadyLocked(ticket, caseId, { type: 'run', action: job.action, discussionId: discussion.id, userMessage, resumeFromRunId: job.runId,queueId:command.queueId });
  }

  private async startRunAlreadyLocked(ticket: RequestTicket, caseId: string, command: Extract<AgentCommand, { type: 'run' }>): Promise<AgentCaseView> {
    this.assertTicket(ticket);
    this.desktop.assertNotMigrating();
    if (this.live.has(caseId)) throw new Error('同一案件已有进行中的任务，不能并行启动。');
    const workRoot = this.desktop.workspace.settings.workRoot;
    if (!workRoot) throw new Error('请先选择总工作文件夹。');
    const store = await this.loadStore(ticket.profileKey);
    const c = this.desktop.findCase(caseId);
    let state = await this.ensureProcess(store, c);
    const scope = { caseId: c.id, processKey: state.scope.processKey };
    if (processKeyOf(c) !== state.scope.processKey) throw new Error(STALE_SCOPE);
    const recovery = command.resumeFromRunId ? state.jobs.find(j => j.runId === command.resumeFromRunId && j.discussionId === command.discussionId && j.action === command.action && j.state !== 'running') : undefined;
    if (command.resumeFromRunId && !recovery) throw new Error('恢复来源任务无效。');
    const formal = command.action !== 'discuss';
    const kind = currentWork(c).kind;
    if (formal && (!editableCurrent(c) || (kind !== 'reply' && kind !== 'correction') || !isReplyClassified(state.classification))) {
      throw new Error('当前案件不能启动正式答复任务。');
    }
    let discussionId = command.discussionId;
    if (command.action === 'review' && !command.resumeFromRunId) {
      const draftId = state.currentDraftVersionId;
      if (!draftId) throw new Error('独立复核必须绑定确切稿件版本。');
      const opened = openReviewDiscussion(state, { ...scope, draftVersionId: draftId, parentDiscussionId: state.mainDiscussionId });
      state = unwrap(opened);
      discussionId = opened.ok ? opened.value!.discussionId : discussionId;
    } else if (!discussionId) discussionId = state.mainDiscussionId;
    this.assertTicket(ticket);
    const conversationId = discussionId!;
    const runtime = await diagnosticStage('host','model_config',{caseId,discussionId:conversationId},()=>this.models.resolveRuntimeConfig(ticket.profileKey, conversationId));
    this.assertTicket(ticket);
    if (runtime.profileKey && runtime.profileKey !== ticket.profileKey) throw new Error(ACCOUNT_SWITCHED);
    const frozen = modelFromRuntime(runtime);
    const started = startAgentJob(state, {
      ...scope,
      action: command.action,
      discussionId: conversationId,
      userMessage: command.userMessage,
      resumeFromRunId: command.resumeFromRunId,
      publicRuntime: {
        profileKey: ticket.profileKey,
        model: frozen.modelId,
        protocol: frozen.protocol,
        reasoningLevel: frozen.reasoningLevel,
      },
      strategyId: command.action === 'draft' || command.action === 'revise' ? state.userSelectedStrategyId ?? undefined : undefined,
      draftVersionId: command.action === 'review' ? state.currentDraftVersionId ?? undefined : undefined,
    });
    state = unwrap(started);
    const job = started.ok ? started.value!.job : undefined;
    if (!job) throw new Error('无法启动任务。');
    if(command.queueId){for(const d of state.discussions)d.queuedMessages=d.queuedMessages?.filter(q=>q.id!==command.queueId);const storedJob=state.jobs.find(j=>j.runId===job?.runId);if(storedJob)storedJob.queueId=command.queueId;}

    const selected = command.action === 'discuss' ? selectedMaterials(state) : selectedMaterials(state).filter(item => item.ready && item.relativePath);
    if (formal && !selected.length) throw new Error('请先勾选用于分析的材料。');
    const snapshotDir = path.join(this.desktop.root, 'profiles', ticket.profileKey, 'agent', 'runs', job.runId, 'snapshot');
    const outputDir = path.join(this.desktop.root, 'profiles', ticket.profileKey, 'agent', 'runs', job.runId, 'output');
    await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    const snapshots: AgentHostMaterialSnapshot[] = [];
    const materialHashes: Record<string, string> = {};
    const readAliases: LiveRun['readAliases'] = [];
    const idMap: Record<string, string> = {};
    let skillResources:Array<{path:string;text:string}>|undefined;
    let promptValue: { rules: string; task: string; combined: string } | undefined;
    const failBeforeLive = async (error: unknown): Promise<never> => {
      const failed = failAgentJob(state, { ...scope, runId: job.runId, error: errorMessage(error) });
      if (failed.ok) {
        this.putProcess(store, failed.state);
        delete store.partialText[storeKey(c.id, state.scope.processKey)];
        await this.persistStore(ticket.profileKey, store);
      }
      throw error instanceof Error ? error : new Error(errorMessage(error));
    };
    this.preparation(ticket,c.id,'materials');
    try {
      await diagnosticStage('host','materials',{caseId,runId:job.runId},async()=>{
      for (const item of selected) {
        if (!item.relativePath || isUnsafePath(item.relativePath)) continue;
        const abs = await this.desktop.casePath(c.id, item.relativePath);
        await assertNoSymlinkAncestors(this.desktop.workspace.settings.workRoot || abs, abs);
        const stat = await fs.lstat(abs);
        if (stat.isSymbolicLink()) throw new Error('案件目录内不支持符号链接。');
        const buf = await readBoundedFile(abs,MAX_MATERIAL_BYTES);
        const hash = digest(buf);
        if (item.hash && item.hash !== hash) throw new Error('材料哈希不一致，未启动任务。');
        const snapshotId = randomUUID();
        const destName = safeName(path.basename(item.relativePath || item.name || 'material'), 48);
        const snapshotRel = portable(path.join('materials', snapshotId, destName));
        const dest = await managedPath(snapshotDir, snapshotRel, true);
        await assertNoSymlinkAncestors(snapshotDir, dest);
        await fs.writeFile(dest, buf, { mode: 0o600 });
        snapshots.push({
          id: snapshotId,
          name: item.name,
          role: item.role,
          relativePath: snapshotRel,
          hash,
          snapshotPath: dest,
        });
        materialHashes[item.id] = hash;
        idMap[snapshotId] = item.id;
        readAliases.push({ id: snapshotId, sourceId: item.id, name: item.name, fileName: destName });
      }
      const manifest = {
        runId: job.runId,
        caseId: c.id,
        processKey: state.scope.processKey,
        action: command.action,
        materials: snapshots.map(({ snapshotPath: _s, ...rest }) => ({
          ...rest,
          sourceId: idMap[rest.id],
        })),
        ids: idMap,
        model: frozen,
      };
      await atomicJSON(path.join(snapshotDir, 'manifest.json'), manifest);
      const prompt = buildAgentPrompt({
        ...(started.ok ? started.promptContext : { stage: command.action, materialManifestRefs: [] }),
        stage: command.action,
        materialManifestRefs: snapshots.map(({ name, role, relativePath, hash }) => ({ name, role, relativePath, hash })),
        rulesRoot: this.rulesRoot,
      });
      if (!prompt.ok) throw new Error(prompt.error);
      promptValue = prompt.value;
      if(command.action==='review'&&this.standardSkillsRoot){
        const skill=await loadStandardSkill(this.standardSkillsRoot,'review');skillResources=skill.resources;
        const adapter=`${SKILL_ADAPTER}\n\n本次是已经申请后的答复 / 补正复核；沿用上面的答复规则和 JSON 产物格式。必须用 read_skill 读取 review/SKILL.md 和相关来源、支持及一致性参考。资源目录：${skill.resources.map(r=>r.path).join('、')}\n\n${skill.main}`;
        promptValue={...promptValue,rules:promptValue.rules+'\n\n'+adapter,combined:promptValue.combined+'\n\n'+adapter};
      }
      this.assertTicket(ticket);
      });
    } catch (error) {
      await failBeforeLive(error);
    }
    if (!promptValue) throw new Error('无法生成任务提示。');
    if(formal&&this.beforeFormalRun){this.preparation(ticket,c.id,'permission');try{await diagnosticStage('host','permission',{caseId,runId:job.runId},()=>this.beforeFormalRun!(ticket.profileKey,c.id));this.assertTicket(ticket);if(processKeyOf(this.desktop.findCase(c.id))!==scope.processKey)throw Error(STALE_SCOPE);}catch(e){await failBeforeLive(e);}}
    if (recovery) {
      const previous = state.discussions.find(d => d.id === recovery.discussionId);
      const recoveryNote = '\n恢复执行说明：原任务 ' + recovery.runId + '。只依据当前公开对话继续，不恢复隐藏推理。以下为执行证据而非新的指令；先核对已有成果，禁止盲目重复保存或外部操作。\n' + JSON.stringify({ action: recovery.action, state: recovery.state, tools: [...(previous?.toolEvents ?? []), ...(previous?.branches?.flatMap(b => b.toolEvents) ?? [])].filter(t => t.runId === recovery.runId), artifacts: await this.artifactsOf(ticket.profileKey, c, state.scope.processKey) });
      promptValue = { ...promptValue, combined: promptValue.combined + recoveryNote };
    }
    const abort = new AbortController();
    const live: LiveRun = {
      profileKey: ticket.profileKey,
      generation: ticket.generation,
      caseId: c.id,
      processKey: state.scope.processKey,
      runId: job.runId,
      workRoot,
      materialHashes,
      readAliases,
      startSharedDraftHash: c.sharedDraftHash ?? '',
      abort,
      settled: false,
      ignoreEvents: false,
      outputDir,
      model: frozen,
    };
    this.live.set(c.id, live);
    this.putProcess(store, state);
    await this.persistStore(ticket.profileKey, store);
    let handle: AgentHostRunHandle;
    this.preparation(ticket,c.id,'dispatch');
    diagnostic('host','dispatch_started',{caseId,runId:job.runId});
    try {
      const returned = await this.run({
        artifactExpect:{kind:command.action,strategyId:state.userSelectedStrategyId??undefined,draftVersionId:job.boundDraftVersionId},
        artifactScope: digest(JSON.stringify([c.id,live.processKey,materialHashes])),
        validateArtifact: raw => this.enqueue(async () => {
          if (!this.liveScopeStillValid(live) || abort.signal.aborted) return '任务范围已变化或已停止，不能完成。';
          const currentStore = await this.loadStore(ticket.profileKey);
          const current = this.findProcess(currentStore, c.id, live.processKey);
          if (!current) return '当前办理阶段已不存在。';
          const parsed = parseAgentArtifact(raw, {kind: command.action, strategyId: current.userSelectedStrategyId ?? undefined, draftVersionId: job.boundDraftVersionId});
          if (!parsed.ok) return parsed.error;
          // Dry-run the same transition used at acceptance; never adopt or publish here.
          const checked = completeAgentJob(current, {...current.scope, runId: job.runId, artifact: parsed.artifact});
          return checked.ok ? undefined : checked.error;
        }),
        runId: job.runId,
        caseId: c.id,
        processKey: state.scope.processKey,
        action: command.action,
        discussionId: conversationId,
        snapshotDir,
        outputDir,
        prompt: promptValue,
        skillResources,
        materials: snapshots,
        draft: command.action === 'review' || command.action === 'revise' || command.action === 'draft'
          ? draftSnapshot(state, command.action)
          : undefined,
        messages: command.action === 'review' ? [] : publicMessages(state, conversationId),
        runtime,
        signal: abort.signal,
        resumeFromRunId: command.resumeFromRunId,
        onEvent: event => {
          this.track(this.enqueue(() => this.handleEventAlreadyLocked(live, event)));
        },
      });
      handle = await Promise.resolve(returned);
      if (!handle || !handle.wait || typeof handle.abort !== 'function') throw new Error('任务没有返回可停止的运行句柄。');
    } catch (error) {
      await this.failLiveAlreadyLocked(live, errorMessage(error));
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }
    live.handle = handle;
    void handle.wait.then(() => undefined, () => undefined);
    this.track(this.follow(live, handle));
    this.assertTicket(ticket);
    return this.toView(ticket.profileKey, c, state, store);
  }

  private resolveMaterialId(live: LiveRun, materialId?: string): string | undefined {
    if (!materialId) return undefined;
    const alias = live.readAliases.find(item => item.id === materialId || item.sourceId === materialId);
    return alias?.sourceId ?? materialId;
  }

  private toolFileName(live: LiveRun, filename: string): string {
    const base = path.basename(filename);
    const alias = live.readAliases.find(item =>
      item.fileName === base
      || item.id === base
      || item.sourceId === base
      || item.name === base
      || item.name === filename
      || filename.endsWith(item.fileName)
    );
    return alias?.name || base;
  }

  private async handleEventAlreadyLocked(live: LiveRun, event: AgentHostRunEvent): Promise<void> {
    if (live.settled || live.ignoreEvents) return;
    if (event.type === 'completed') live.outputText = event.outputText;
    if (event.type === 'failed') {live.failed = event.error;diagnostic('host','runner_failed',{runId:live.runId,...diagnosticError(new Error(event.error))});}
    if(event.type==='tool')diagnostic('host','tool',{runId:live.runId,tool:event.toolKind,state:event.status});
    if (event.type === 'partial' || event.type === 'thinking' || event.type === 'activity') {
      if (!this.liveScopeStillValid(live)) return;
      const store = await this.loadStore(live.profileKey);
      if (!this.liveScopeStillValid(live)) return;
      const state = this.findProcess(store, live.caseId, live.processKey);
      const job = state?.jobs.find(j => j.runId === live.runId);
      if (!state || !job || job.state !== 'running') return;
      const at = new Date().toISOString();
      if (event.type === 'partial' && job.partialText === event.text) return;
      if (event.type === 'thinking' && job.thinkingText === event.text) return;
      const existingStep = event.type === 'activity' && event.stepId ? job.steps?.find(s => s.id === event.stepId) : undefined;
      if (existingStep && event.type === 'activity' && (existingStep.status === event.status || (existingStep.status !== 'running' && event.status === 'running'))) return;
      job.lastActivityAt = at;
      if (event.type === 'partial') { job.partialText = event.text; store.partialText[storeKey(live.caseId, live.processKey)] = event.text; job.activity = '生成回复'; }
      if (event.type === 'thinking') { job.thinkingText = event.text.slice(0, 500000); job.activity = '分析中'; }
      if (event.type === 'activity') {
        job.activity = event.status && event.status !== 'running' ? '等待模型响应' : event.label;
        if (event.stepId) {
          job.steps ??= [];
          const step = job.steps.find(s => s.id === event.stepId);
          if (step) { step.status = event.status ?? 'running'; if (step.status !== 'running') step.endedAt = at; }
          else job.steps.push({ id: event.stepId, label: event.label, status: event.status ?? 'running', at, endedAt: event.status && event.status !== 'running' ? at : undefined });
        }
      }
      // C#4: streaming partial/thinking stay in-memory; flush on activity/tool boundary or terminal.
      if (event.type === 'activity') await this.persistStore(live.profileKey, store);
      if (this.liveScopeStillValid(live)) this.emit(await this.toView(live.profileKey, this.desktop.findCase(live.caseId), state, store));
      return;
    }
    if (event.type === 'tool') {
      if (!this.liveScopeStillValid(live)) return;
      const store = await this.loadStore(live.profileKey);
      const state = this.findProcess(store, live.caseId, live.processKey);
      if (!state) return;
      const next = recordToolEvent(state, {
        caseId: live.caseId,
        processKey: live.processKey,
        runId: live.runId,
        filename: this.toolFileName(live, event.filename),
        detail: event.detail,
        readRange: event.readRange,
        status: event.status,
        materialId: this.resolveMaterialId(live, event.materialId),
        toolKind: event.toolKind,
      });
      if (!next.ok) return;
      const job = next.state.jobs.find(j => j.runId === live.runId);
      if (job) { job.lastActivityAt = new Date().toISOString(); job.activity = event.status === 'started' ? '正在执行工具' : '等待模型响应'; }
      this.putProcess(store, next.state);
      await this.persistStore(live.profileKey, store);
      if (this.liveScopeStillValid(live)) this.emit(await this.toView(live.profileKey, this.desktop.findCase(live.caseId), next.state, store));
    }
  }

  private async follow(live: LiveRun, handle: AgentHostRunHandle): Promise<void> {
    try {
      await Promise.resolve(handle.wait);
    } catch (error) {
      live.failed = live.failed || errorMessage(error);
    }
    if (!live.outputText) {
      try { live.outputText = await fs.readFile(path.join(live.outputDir, 'result.json'), 'utf8'); }
      catch { /* optional */ }
    }
    try {
      await this.enqueue(() => this.settleAlreadyLocked(live));
    } catch (error) {
      live.failed = live.failed || errorMessage(error);
      if (!live.settled) {
        try { await this.enqueue(() => this.failLiveAlreadyLocked(live, errorMessage(error))); }
        catch {
          live.settled = true;
          live.ignoreEvents = true;
          this.live.delete(live.caseId);
        }
      }
    }
  }

  private async emitTerminal(live: LiveRun, store: AgentStore, state: AgentProcessState | undefined, c: Case | undefined): Promise<void> {
    const job=state?.jobs.find(j=>j.runId===live.runId);
    diagnostic('host','terminal',{runId:live.runId,state:job?.state,...(job?.error?diagnosticError(new Error(job.error)): {})});
    if (state) preserveInterruptedOutput(state, live.runId);
    delete store.partialText[storeKey(live.caseId, live.processKey)];
    if (state) this.putProcess(store, state);
    let persistError: unknown;
    for (let attempt = 1; attempt <= TERMINAL_PERSIST_ATTEMPTS; attempt++) {
      try {
        if (this.corrupt.has(live.profileKey)) throw new Error('Agent 状态文件不可用。');
        await this.persistStore(live.profileKey, store);
        persistError = undefined;
        break;
      } catch (error) {
        persistError = error;
        diagnostic('host','persist_failed',{runId:live.runId,attempt,...diagnosticError(error)});
      }
    }
    if (persistError) {
      live.persistAlert = TERMINAL_PERSIST_UNSAVED;
      live.failed = live.failed || `${TERMINAL_PERSIST_UNSAVED}：${errorMessage(persistError)}`;
      if (job) {
        job.activity = TERMINAL_PERSIST_UNSAVED;
        if (!job.error?.includes(TERMINAL_PERSIST_UNSAVED)) {
          job.error = job.error ? `${job.error}（${TERMINAL_PERSIST_UNSAVED}）` : TERMINAL_PERSIST_UNSAVED;
        }
        if (state) this.putProcess(store, state);
      }
      // Do not clear live: in-memory terminal state must stay visible for UI/recovery.
      this.live.set(live.caseId, live);
      const canEmitFailed = !!c && !!state && this.liveScopeStillValid(live, c);
      if (canEmitFailed) {
        try { this.emit(await this.toView(live.profileKey, c!, state!, store)); }
        catch (error) { diagnostic('host','terminal_delivery_failed',{runId:live.runId,...diagnosticError(error)}); }
      }
      throw new Error(`${TERMINAL_PERSIST_UNSAVED}：${errorMessage(persistError)}`);
    }
    delete live.persistAlert;
    this.live.delete(live.caseId);
    const canEmit = !!c && !!state && this.liveScopeStillValid(live, c);
    if (!canEmit) return;
    try { this.emit(await this.toView(live.profileKey, c!, state!, store)); }
    catch(error) {diagnostic('host','terminal_delivery_failed',{runId:live.runId,...diagnosticError(error)});}
  }

  private async failLiveAlreadyLocked(live: LiveRun, error: string): Promise<void> {
    this.abortLive(live);
    if (live.settled) return;
    live.settled = true;
    live.ignoreEvents = true;
    // live stays until emitTerminal persists successfully (or marks 状态未落盘).
    const store = await this.loadStore(live.profileKey);
    let c: Case | undefined;
    try { if (this.desktop.key === live.profileKey) c = this.desktop.findCase(live.caseId); }
    catch { c = undefined; }
    let state = this.findProcess(store, live.caseId, live.processKey);
    if (state) {
      const job = state.jobs.find(item => item.runId === live.runId);
      if (job && job.state === 'running') {
        const failed = failAgentJob(state, { caseId: live.caseId, processKey: live.processKey, runId: live.runId, error });
        if (failed.ok) state = failed.state;
      }
    }
    await this.emitTerminal(live, store, state, this.liveScopeStillValid(live, c) ? c : undefined);
  }

  private async settleAlreadyLocked(live: LiveRun): Promise<void> {
    if (live.settled) return;
    live.settled = true;
    live.ignoreEvents = true;
    // live stays until emitTerminal persists successfully (or marks 状态未落盘).
    const store = await this.loadStore(live.profileKey);
    let c: Case | undefined;
    try { if (this.desktop.key === live.profileKey) c = this.desktop.findCase(live.caseId); }
    catch { c = undefined; }
    let state = this.findProcess(store, live.caseId, live.processKey);
    const profileChanged = this.desktop.key !== live.profileKey || this.desktop.generation !== live.generation;
    const scope = { caseId: live.caseId, processKey: live.processKey };
    const endRunning = (next: AgentProcessState, error: string): AgentProcessState => {
      const job = next.jobs.find(item => item.runId === live.runId);
      if (!job || job.state !== 'running') return next;
      const failed = failAgentJob(next, { ...scope, runId: live.runId, error });
      return failed.ok ? failed.state : next;
    };
    if (profileChanged) {
      if (state) state = endRunning(state, '账号或任务世代已变更，已拒绝过期结果。');
      await this.emitTerminal(live, store, state, undefined);
      return;
    }
    if (!c || !state || !this.liveScopeStillValid(live, c)) {
      if (state) {
        const error = !c
          ? '案件已不存在，本机结果已保留，未推进阶段。'
          : '案件范围、目录或材料已变化，本机结果已保留，未推进阶段。';
        state = endRunning(state, error);
      }
      await this.emitTerminal(live, store, state, undefined);
      return;
    }
    state = this.syncManualDraft(store, state, c);
    const job = state.jobs.find(item => item.runId === live.runId);
    if (!job || job.state !== 'running' || live.abort.signal.aborted) {
      if (job?.state === 'running') state = unwrap(stopAgentJob(state, { ...scope, runId: live.runId }));
      await this.emitTerminal(live, store, state, c);
      return;
    }
    let materialsChanged = false;
    try {
      const incoming = await this.caseMaterials(c);
      for (const [id, hash] of Object.entries(live.materialHashes)) {
        if (incoming.find(item => item.id === id)?.hash !== hash) materialsChanged = true;
      }
    } catch { materialsChanged = true; }
    if (materialsChanged) {
      state = unwrap(failAgentJob(state, { ...scope, runId: live.runId, error: '案件范围、目录或材料已变化，本机结果已保留，未推进阶段。' }));
      await this.emitTerminal(live, store, state, c);
      return;
    }
    if (live.failed || !live.outputText) {
      state = unwrap(failAgentJob(state, { ...scope, runId: live.runId, error: live.failed || '任务没有完整 JSON 产物。' }));
      await this.emitTerminal(live, store, state, c);
      return;
    }
    const parsed = parseAgentArtifact(live.outputText, {
      kind: job.action,
      strategyId: state.userSelectedStrategyId ?? undefined,
      draftVersionId: job.boundDraftVersionId,
    });
    if (!parsed.ok) {
      state = unwrap(failAgentJob(state, { ...scope, runId: live.runId, error: parsed.error }));
      await this.emitTerminal(live, store, state, c);
      return;
    }
    const completed = completeAgentJob(state, { ...scope, runId: live.runId, artifact: parsed.artifact });
    if (!completed.ok) {
      state = unwrap(failAgentJob(state, { ...scope, runId: live.runId, error: completed.error }));
      await this.emitTerminal(live, store, state, c);
      return;
    }
    state = completed.state;
    const versionId = (completed.value as { versionId?: string } | undefined)?.versionId;
    const version = versionId ? state.drafts.find(item => item.id === versionId) : undefined;
    if (version) version.sourceSharedDraftHash = live.startSharedDraftHash;
    await this.publishRunFiles(live, c, state, parsed.artifact, version);
    await this.emitTerminal(live, store, state, c);
    if(!this.shuttingDown&&this.liveScopeStillValid(live,c)){
      const discussion=state.discussions.find(d=>d.id===job.discussionId&&!d.archived);
      const queued=discussion?.queuedMessages?.find(q=>q.branchId===(discussion.activeBranchId??'original'));
      if(discussion&&queued&&!queued.error){const next=await this.deliverQueuedAlreadyLocked({profileKey:live.profileKey,generation:live.generation},c,state,store,discussion.id,queued.id);this.emit(next);}
    }
  }

  private async writeOnce(root: string, relativePath: string, content: string): Promise<string> {
    const portablePath = portable(relativePath);
    const abs = await managedPath(root, portablePath, true);
    await assertNoSymlinkAncestors(root, abs);
    try {
      await fs.writeFile(abs, content, { mode: 0o600, flag: 'wx' });
      return portablePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await fs.readFile(abs);
      if (digest(existing) === digest(content)) return portablePath;
      throw new Error('已有成果不能覆盖。');
    }
  }

  private async publishRunFiles(live: LiveRun, c: Case, state: AgentProcessState, artifact: JobArtifact, version?: DraftVersion): Promise<void> {
    if (!c.directory) return;
    const root = await this.desktop.casePath(c.id);
    const proc = processFolder(c, live.processKey);
    const relDir = path.join('02_工作稿', proc, datedFolder(({draft:'起草稿件',revise:'修订稿件',review:'独立复核',analysis:'材料分析',discuss:'策略讨论'} as Record<string,string>)[artifact.kind]??'办理结果',live.runId));
    const files: SharedRunIndex['files'] = [];
    const write = async (name: string, kind: string, title: string, content: string, versionId?: string) => {
      const relativePath = await this.writeOnce(root, path.join(relDir, name), content);
      files.push({ relativePath, hash: digest(content), kind, title, at: new Date().toISOString(), versionId });
    };
    if (artifact.kind === 'draft' || artifact.kind === 'revise') {
      await write('答复正文.txt', 'body', '答复正文', artifact.body, version?.id);
      await write('建议修改文本.txt', 'amendmentText', '建议修改文本', artifact.amendmentText, version?.id);
      await write('修改依据.txt', 'amendmentBasis', '修改依据', artifact.amendmentBasis, version?.id);
      await write('内部复核说明.txt', 'reviewNotes', '内部复核说明', artifact.reviewNotes, version?.id);
    } else if (artifact.kind === 'review') {
      await write('独立复核.json', 'review', '独立复核', JSON.stringify(artifact, null, 2));
    } else if (artifact.kind === 'analysis') {
      await write('意见分析.json', 'analysis', '意见分析', JSON.stringify({ opinions: artifact.opinions, strategies: artifact.strategies }, null, 2));
    } else if (artifact.kind === 'discuss') {
      await write('讨论回复.txt', 'discuss', '讨论回复', artifact.reply);
    }
    const index: SharedRunIndex = {
      schema: 1,
      caseId: c.id,
      profileKey: live.profileKey,
      processKey: live.processKey,
      runId: live.runId,
      at: new Date().toISOString(),
      files,
    };
    const indexRel = portable(path.join('04_内部说明', `agent-run-${live.runId}.json`));
    await atomicJSON(await managedPath(root, indexRel, true), index);
  }

  private async adoptAlreadyLocked(profileKey: string, c: Case, state: AgentProcessState, versionId: string): Promise<AgentProcessState> {
    const version = state.drafts.find(item => item.id === versionId);
    if (!version) throw new Error('没有可采用的稿件版本。');
    const liveHash = c.sharedDraftHash ?? '';
    const expected = version.sourceSharedDraftHash ?? state.expectedSharedDraftHash ?? '';
    if (liveHash !== expected) throw new Error('共享稿哈希不一致，已保留待核对产物，未覆盖用户稿。');
    const incoming = await this.caseMaterials(c);
    const selected = incoming.filter(item => state.materials.some(existing => existing.selected && existing.id === item.id));
    if (state.confirmedMaterialFingerprint) {
      const fp = selected.map(item => `${item.id}\0${item.hash ?? ''}\0${item.relativePath ?? ''}`).sort().join('\n');
      if (fp !== state.confirmedMaterialFingerprint) throw new Error('材料已变更，不能采用该生成稿。');
    }
    if (processKeyOf(c) !== state.scope.processKey) throw new Error(STALE_SCOPE);
    let next = unwrap(adoptDraft(state, {
      caseId: c.id,
      processKey: state.scope.processKey,
      versionId,
      sharedDraftHash: liveHash,
      expectedSharedDraftHash: state.expectedSharedDraftHash,
    }));
    const workspace = structuredClone(this.desktop.workspace) as Workspace;
    const target = workspace.cases.find(item => item.id === c.id);
    if (!target) throw new Error('当前账号没有该案件。');
    if (target.localDraft && target.localDraft !== version.text) {
      const keepId = randomUUID();
      target.localVersions = [...(target.localVersions ?? []), { id: keepId, text: target.localDraft, at: new Date().toISOString(), processId: currentWork(c).processId }];
      await this.desktop.save(profileKey, workspace);
      const again = structuredClone(this.desktop.workspace) as Workspace;
      const row = again.cases.find(item => item.id === c.id)!;
      row.localDraft = version.text;
      await this.desktop.save(profileKey, again);
      next = { ...next, expectedSharedDraftHash: this.desktop.findCase(c.id).sharedDraftHash };
    } else {
      target.localDraft = version.text;
      await this.desktop.save(profileKey, workspace);
      next = { ...next, expectedSharedDraftHash: this.desktop.findCase(c.id).sharedDraftHash };
    }
    const store = this.stores.get(profileKey);
    if (store) {
      const key = storeKey(c.id, state.scope.processKey);
      store.lastObservedHash[key] = this.desktop.findCase(c.id).sharedDraftHash ?? '';
      store.lastObservedText[key] = version.text;
    }
    return next;
  }

  private async finalizeAlreadyLocked(profileKey: string, c: Case, state: AgentProcessState): Promise<AgentProcessState> {
    const next = unwrap(finalizeProcess(state, { caseId: c.id, processKey: state.scope.processKey }));
    const draft = currentDraft(next);
    if (!draft || !c.directory) return next;
    if(draft.applicationParts===undefined)throw new Error('请先核对本次修改文件正文；未修改也需要明确保存。');
    const root = await this.desktop.casePath(c.id);
    const proc = processFolder(c, state.scope.processKey);
    const versionId = randomUUID();
    const relDir = path.join('03_定稿', proc, datedFolder('用户定稿',versionId));
    const files: SharedRunIndex['files'] = [];
    const templateRoot=path.join(this.rulesRoot,'..','document-templates');
    const writeWord=async(name:string,kind:string,bytes:Buffer)=>{const relativePath=portable(path.join(relDir,name+'.docx'));await fs.writeFile(await managedPath(root,relativePath,true),bytes,{flag:'wx',mode:0o600});files.push({relativePath,hash:digest(bytes),kind,title:name,at:new Date().toISOString(),versionId:draft.id});return relativePath;};
    const reply=state.classification.status==='classified'&&state.classification.noticeCategory==='审查意见通知书';
    let main:string|undefined;
    if(reply)main=await writeWord('意见陈述书','final-word',await exportReplyDocx(templateRoot,draft.text,state.classification.officeActionRound||1));
    else{
      if(!draft.correctionContents?.length)throw new Error('请先准备并核对逐条补正字段。');
      const content=JSON.stringify({schema:1,caseId:c.id,processKey:state.scope.processKey,draftVersionId:draft.id,FormCode:100006,CorrectionContentList:validateCorrectionContents(draft.correctionContents).map((row,Sort)=>({...row,ChangeId:randomUUID(),Sort})),note:'本地补正字段记录，不作为附件上传。用户只核对文件名称、具体位置、补正前和补正后；其余表单信息由程序读取并保留贝思兰德数据。'},null,2);
      const relativePath=await this.writeOnce(root,path.join(relDir,'补正表单.json'),content);files.push({relativePath,hash:digest(content),kind:'final-correction-form',title:'补正表单（字段记录）',at:new Date().toISOString(),versionId:draft.id});
    }
    for(const [part,text]of Object.entries(draft.applicationParts!))await writeWord(APPLICATION_PART_LABELS[part as keyof typeof APPLICATION_PART_LABELS],'final-application-'+part,await exportApplicationParts(templateRoot,{[part]:text}));
    await writeWord('修改依据','final-basis',await exportNoteDocx(templateRoot,'修改依据',draft.amendmentBasis||'本次未修改申请文件。'));
    await writeWord('内部复核说明','final-review-notes',await exportNoteDocx(templateRoot,'内部复核说明',[draft.reviewNotes,...state.reviews.filter(r=>r.draftVersionId===draft.id&&!r.invalidated).map(r=>[r.summary,...r.issues.map(i=>`${i.finding}\n依据：${i.basis}\n建议：${i.suggestion}\n处理：${i.handled?'已记录处理':'未记录处理'}`)].join('\n\n'))].filter(Boolean).join('\n\n')||'无补充内部说明。'));
    next.finalized!.word=reply?{generated:true,status:'generated',relativePath:main,message:'已按确认模板生成意见陈述书及本次修改部分的 Word，内部说明分别保存。'}:{generated:false,status:'not-required',message:'补正内容已保存为逐条字段，提交页核对后写入补正表；本次修改的申请文件已生成 Word。'};
    const index: SharedRunIndex = {
      schema: 1,
      caseId: c.id,
      profileKey,
      processKey: state.scope.processKey,
      runId: `final-${versionId}`,
      at: new Date().toISOString(),
      files,
    };
    const indexRel = portable(path.join('04_内部说明', `agent-final-${versionId}.json`));
    await atomicJSON(await managedPath(root, indexRel, true), index);
    return next;
  }
}

function publicMessages(state: AgentProcessState, discussionId: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  const discussion = state.discussions.find(item => item.id === discussionId);
  return (discussion?.messages ?? []).map(item => ({ role: item.role, text: item.incomplete ? '[上次未完成的输出]\n' + item.text : item.text }));
}

function draftSnapshot(state: AgentProcessState, action: AgentAction): AgentHostRunInput['draft'] {
  const draft = currentDraft(state);
  if (!draft) return undefined;
  if (action === 'analysis') return undefined;
  return { id: draft.id, text: draft.text, amendmentText: draft.amendmentText, applicationParts:draft.applicationParts,correctionContents:draft.correctionContents, amendmentBasis: draft.amendmentBasis };
}
