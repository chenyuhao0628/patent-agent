export type AuthState={phase:'signed-out'|'verifying'|'authenticated'|'offline'|'expired'|'forbidden'|'unreadable';message:string;attempts:number;lastCheckedAt?:string;nextRetryAt?:string};
import { discussionJobs } from './domain/conversation.ts';
import type { Settings, Workspace, Case } from './domain/workflow.ts';
import type { ModelAPI } from './model-api.ts';
import type { AgentAPI, AgentCaseView } from './agent-api.ts';
import type { AgentAction, AgentJob, AgentProcessState, MaterialEntry, NoticeClassification, ProcessAccess, ToolEvent, ToolKind } from './domain/agent.ts';
import {
  AgentErrors, activeJob, currentDraft, currentReview, finalizeBlocker, isReplyClassified,
  selectedMaterials, selectedStrategy, unhandledIssues,
} from './domain/agent.ts';
import { currentWork } from './domain/lifecycle.ts';

export type { AgentAPI, AgentCaseView, AgentCommand, AgentTaskView } from './agent-api.ts';
export type Account = {username:string;displayName:string;organization:string;origin:string;userId:string;status:'authenticated'|'expired'|'offline';remembered:boolean};
export type SyncState = {running:boolean;lastAt?:string;message:string};
export type StorageState={running:boolean;message:string;lastAt?:string;caseCount?:number};
export type DocumentToolStatus={permissions:{commandsEnabled:boolean;downloadsEnabled:boolean};detectedTools:Array<{name:string;path:string;kind:'application'|'command';note:string}>;converter:string|null;vision:boolean;webEnabled:boolean;autoInstall:boolean;managed:{root:string;version:string;phase:'idle'|'downloading'|'installing'|'ready'|'error';downloaded:number;total:number;message:string}};
export type MigrationPhase='idle'|'preview'|'copying'|'verifying'|'publishing'|'committing'|'done'|'failed';
export type MigrationPreview={
  id:string; profileKey:string; sourceRoot:string; destinationRoot:string; originalLibrary:string;
  caseDirectoryCount:number; extraDirectoryCount:number; fileCount:number; directoryCount:number; byteCount:number; emptyNamespace:boolean;
};
export type MigrationProgress={
  copiedFiles:number; verifiedFiles:number; totalFiles:number; copiedBytes:number; totalBytes:number;
  currentPath:string; message:string;
};
export type MigrationState={
  running:boolean; phase:MigrationPhase; canCancel:boolean; preview?:MigrationPreview; progress?:MigrationProgress;
  message:string; error?:string;
};
export type FolderOrganizationReport={
  renamedFolders:number;renamedFiles:number;skippedFiles:number;unknownPaths:string[];conflicts:string[];cases:number;message:string;
};
export type DesktopState = {
  auth?:AuthState;profileKey:string;account:Account|null;workspace:Workspace;sync:SyncState;storage:StorageState;migration:MigrationState;version:string;dataDirectory:string};
export type FlowNode={name:string;user:string;running:boolean;finished:boolean;start:string;end:string;stayHours?:number;type?:string;isCurrent?:boolean;sort?:number;serial?:number;total?:number};
export type FlowView={at:string;currentProcessId?:string;processes:Case['remote'];nodes:FlowNode[];history:{name:string;created:string;finished:string}[];currentFlow?:{name:string;user:string;serial?:number;total?:number}};
export type DesktopAPI={
  diagnosticExport:()=>Promise<{canceled:boolean;path?:string;count?:number;droppedWrites?:number}>;
  diagnosticReport:(input:{type:string;line?:number;column?:number})=>Promise<void>;
  extensions:{test:(key:string,id:string)=>Promise<{tools:number}>,list:(key:string)=>Promise<import('../desktop/extensions.ts').Extension[]>,toggle:(key:string,id:string,value:boolean)=>Promise<import('../desktop/extensions.ts').Extension[]>,remove:(key:string,id:string)=>Promise<import('../desktop/extensions.ts').Extension[]>,saveMcp:(key:string,raw:string,id?:string)=>Promise<import('../desktop/extensions.ts').Extension[]>,saveSkill:(key:string,name:string,text:string,id?:string)=>Promise<import('../desktop/extensions.ts').Extension[]>,importSkill:(key:string)=>Promise<import('../desktop/extensions.ts').Extension[]>};
  priorArt:{status:(key:string)=>Promise<{configured:boolean}>,save:(key:string,value:string)=>Promise<{configured:boolean}>,clear:(key:string)=>Promise<{configured:boolean}>,importLegacy:(key:string)=>Promise<{configured:boolean}>,test:(key:string)=>Promise<{configured:boolean}>,prepare:(key:string,id:string,value:string)=>Promise<DesktopState>};
  verifyLogin?:()=>Promise<DesktopState>; bootstrap:()=>Promise<DesktopState>; login:(input:{origin:string;username:string;password:string;remember:boolean})=>Promise<DesktopState>; logout:()=>Promise<DesktopState>;
  selectDirectory:(kind:'originalLibrary'|'workRoot')=>Promise<string|null>;
  saveSettings:(key:string,settings:Settings)=>Promise<DesktopState>; saveWorkspace:(key:string,workspace:Workspace)=>Promise<void>;
  refreshShared:(key:string)=>Promise<DesktopState>; sync:(source?:'manual'|'focus')=>Promise<DesktopState>; createCase:(input:{title:string;number:string;kind:'write'|'review'})=>Promise<DesktopState>;
  caseInfo:(key:string,caseId:string)=>Promise<DesktopState>;
  refreshCaseOutcomes:(key:string)=>Promise<DesktopState>;
  refreshCaseOutcome:(key:string,caseId:string)=>Promise<DesktopState>;
  flow:(caseId:string)=>Promise<FlowView>; openCaseDirectory:(caseId:string)=>Promise<void>;
  findOriginals:(caseId:string)=>Promise<{id:string;name:string}[]>; copyOriginal:(caseId:string,id:string)=>Promise<DesktopState>;
  openMaterial:(caseId:string,relativePath:string)=>Promise<void>;
  previewWorkMigration:(key:string,destination:string)=>Promise<MigrationPreview>;
  startWorkMigration:(key:string,previewId:string)=>Promise<DesktopState>;
  cancelWorkMigration:()=>Promise<DesktopState>;
  organizeWorkFolders:(key:string)=>Promise<FolderOrganizationReport>;
  selectDshDirectory:()=>Promise<string|null>;
  models:ModelAPI;
  agent:AgentAPI;
  transfer:import('./transfer-api.ts').TransferAPI;
  professional:import('./professional-api.ts').ProfessionalAPI;
  application:import('./application-api.ts').ApplicationAPI;
  documentTools:{detect:()=>Promise<DocumentToolStatus>,status:()=>Promise<DocumentToolStatus>,selectConverter:()=>Promise<DocumentToolStatus>,installConverter:()=>Promise<DocumentToolStatus>,configure:(value:{webEnabled:boolean;autoInstall:boolean;commandsEnabled:boolean;downloadsEnabled:boolean})=>Promise<DocumentToolStatus>,openDirectory:()=>Promise<void>,removeConverter:()=>Promise<DocumentToolStatus>};
  onState:(callback:(state:DesktopState)=>void)=>()=>void;
};

export type ServerFormFingerprint = {
  processKey: string;
  classification: string;
  selected: string;
};

export function serverFormFingerprint(process: AgentProcessState): ServerFormFingerprint {
  const classification = process.classification;
  return {
    processKey: process.scope.processKey,
    classification: JSON.stringify([
      classification.patentType ?? '',
      classification.noticeCategory ?? '',
      classification.officeActionRound ?? '',
      'correctionBasis' in classification ? classification.correctionBasis ?? '' : '',
    ]),
    selected: process.materials.filter(item => item.selected).map(item => item.id).sort().join('\0'),
  };
}

export function shouldInitLocalForm(
  previous: ServerFormFingerprint | undefined,
  next: ServerFormFingerprint,
  field: 'classification' | 'selected',
): boolean {
  if (!previous) return true;
  if (previous.processKey !== next.processKey) return true;
  return previous[field] !== next[field];
}

export function classificationFields(classification: NoticeClassification): {
  patentType: string;
  noticeCategory: string;
  round: string;
  basis: string;
} {
  return {
    patentType: classification.patentType && classification.patentType !== '待核对' ? classification.patentType : '',
    noticeCategory: classification.noticeCategory && classification.noticeCategory !== '待核对' ? classification.noticeCategory : '',
    round: classification.officeActionRound ? String(classification.officeActionRound) : '',
    basis: 'correctionBasis' in classification && classification.correctionBasis ? classification.correctionBasis : 'original',
  };
}

export function pickedFromMaterials(materials: MaterialEntry[]): Record<string, boolean> {
  const picked: Record<string, boolean> = {};
  for (const material of materials) picked[material.id] = material.selected;
  return picked;
}

export function partialTextForDiscussion(view: AgentCaseView, discussionId: string | undefined): string | undefined {
  if (!view.busy || !view.partialText || !discussionId) return;
  const job = activeJob(view.process);
  if (!job || job.discussionId !== discussionId) return;
  return view.partialText;
}

export function reviseRunDiscussionId(process: AgentProcessState): string {
  return process.mainDiscussionId;
}

export function toolMaterialId(tool: ToolEvent): string | undefined {
  const id = tool.materialId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

export function toolKindOf(tool: ToolEvent): ToolKind | undefined {
  return tool.toolKind;
}

export function canSelectCaseMaterials(opts: {
  formal: boolean;
  busy: boolean;
  access: ProcessAccess;
  finalized: boolean;
}): boolean {
  if (opts.busy) return false;
  if (!opts.formal) return true;
  return opts.access === 'editable' && !opts.finalized;
}

export function toolEventLabel(tool: ToolEvent): string {
  const kind = toolKindOf(tool);
  if(kind==='custom_mcp')return '自定义 MCP · '+tool.filename;
  const failed = tool.status === 'error';
  const stopped = tool.status === 'stopped';
  const running = tool.status === 'started';
  if(kind&&['web_search','web_fetch','ensure_tool','discover_tools','execute_command','download_file','prepare_material','read_work_file'].includes(kind)){
    const action=({web_search:'联网检索',web_fetch:'读取网页',ensure_tool:'安装工具',discover_tools:'检测工具',execute_command:'执行命令',download_file:'下载文件',prepare_material:'准备副本',read_work_file:'读取工具结果'} as Record<string,string>)[kind];return `${failed?'未完成':stopped?'已停止':running?'正在':'已完成'}${action}`;
  }
  if (kind === 'write_artifact') {
    if (failed) return '保存产物失败';
    if (stopped) return '已停止保存产物';
    if (running) return '正在保存产物';
    return '已保存产物';
  }
  if (kind === 'read_draft') {
    if (failed) return '读取稿件失败';
    if (stopped) return '已停止读取稿件';
    if (running) return '正在读取稿件';
    return '已读取稿件';
  }
  if (failed) return '读取材料失败';
  if (stopped) return '已停止读取材料';
  if (running) return '正在读取材料';
  return '已读取材料';
}

export function materialReadIds(process: AgentProcessState): Set<string> {
  const ids = new Set<string>();
  for (const discussion of process.discussions) {
    for (const tool of discussion.toolEvents) {
      if (tool.status !== 'ok') continue;
      const kind = toolKindOf(tool);

      if (kind === 'write_artifact' || kind === 'read_draft') continue;
      if (kind && kind !== 'read_material' && kind !== 'read_work_file') continue;
      const id = toolMaterialId(tool);
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function agentProcessKey(item: Case): string {
  const work = currentWork(item);
  return (work.processId || work.roundId || `local-${work.kind}`).trim();
}

export function shouldAcceptAgentView(
  view: AgentCaseView,
  expected: { profileKey: string; caseId: string; processKey: string },
): boolean {
  return view.profileKey === expected.profileKey
    && view.caseId === expected.caseId
    && view.processKey === expected.processKey;
}

export function sanitizeAgentError(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]');
  text = text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]');
  text = text.replace(/(api[_-]?key|encryptedKey|authorization|password|secret)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[已隐藏]');
  text = text.replace(/\{[^{}]{0,1200}"(?:model|messages|input|authorization|api_key)"[^{}]{0,1200}\}/gi, '[已隐藏]');
  if (text.length > 240) text = `${text.slice(0, 240)}…`;
  return text;
}

export function latestDiscussionJob(process: AgentProcessState, discussionId: string | undefined): AgentJob | undefined {
  if (!discussionId) return;
  const discussion = process.discussions.find(d => d.id === discussionId);
  const jobs = discussion ? discussionJobs(process, discussion) : [];
  if (!jobs.length) return;
  return jobs.reduce((latest, job) => {
    const left = latest.endedAt || latest.startedAt;
    const right = job.endedAt || job.startedAt;
    return right >= left ? job : latest;
  });
}

export function discussionJobAlert(job: AgentJob | undefined): { state: 'failed' | 'stopped'; text: string } | undefined {
  if (!job || (job.state !== 'failed' && job.state !== 'stopped')) return;
  const label = job.state === 'failed' ? '任务失败' : '任务已停止';
  const detail = job.error ? sanitizeAgentError(job.error) : '';
  return { state: job.state, text: detail ? `${label}：${detail}` : label };
}

export function modelSnapshotLabel(view: AgentCaseView | undefined): string {
  const model = view?.model;
  if (!model?.modelId) return '尚未读取运行配置';
  const parts = [model.providerName, model.modelId, model.protocol, model.reasoningLevel].filter(Boolean);
  return parts.join(' · ');
}

export async function sendAgentMessage(
  api: AgentAPI,
  profileKey: string,
  caseId: string,
  text: string,
  discussionId?: string,
): Promise<{ ok: true; view: AgentCaseView } | { ok: false; error: string; restore: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '请输入要发送的内容。', restore: text };
  try {
    const view = await api.command(profileKey, caseId, {
      type: 'run',
      action: 'discuss',
      discussionId,
      userMessage: trimmed,
    });
    return { ok: true, view };
  } catch (error) {
    return { ok: false, error: (error as Error).message || '发送失败。', restore: text };
  }
}

export function agentActionBlocker(
  view: AgentCaseView | undefined,
  action: AgentAction | 'finalize' | 'strategy' | 'adopt',
  formal: boolean,
): string | null {
  if (!view) return '尚未加载本案对话。';
  const process = view.process;
  if (view.busy || activeJob(process)) return AgentErrors.JOB_RUNNING;
  if (action === 'discuss') return null;
  if (!formal) return '当前阶段仅开放材料讨论，不能作为正式答复。';
  if (process.access === 'readonly') return AgentErrors.READONLY;
  if (process.finalized) return AgentErrors.ALREADY_FINALIZED;
  if (action === 'analysis') {
    if (!isReplyClassified(process.classification)) return AgentErrors.CLASSIFICATION_NOT_READY;
    if (!process.materialsConfirmed) return AgentErrors.MATERIALS_NOT_CONFIRMED;
    const selected = selectedMaterials(process);
    if (!selected.length) return AgentErrors.NO_MATERIALS_SELECTED;
    if (selected.some(item => !item.ready)) return AgentErrors.MATERIALS_NOT_READY;
    return null;
  }
  if (action === 'strategy') {
    if (!process.analysis) return '请先完成意见分析。';
    return null;
  }
  if (action === 'draft' || action === 'revise') {
    if (!isReplyClassified(process.classification)) return AgentErrors.CLASSIFICATION_NOT_READY;
    if (!process.materialsConfirmed) return AgentErrors.MATERIALS_NOT_CONFIRMED;
    if (!selectedStrategy(process)) return AgentErrors.STRATEGY_NOT_SELECTED;
    if (action === 'revise' && !currentDraft(process)) return '没有有效稿件，不能修改。';
    return null;
  }
  if (action === 'review') {
    if (!currentDraft(process)) return AgentErrors.DRAFT_VERSION_REQUIRED;
    return null;
  }
  if (action === 'adopt') {
    if (!process.drafts.some(item => item.adoptStatus === 'pending')) return '没有待采用的生成稿。';
    return null;
  }
  if (action === 'finalize') {
    const blocked = finalizeBlocker(process);
    return blocked ? blocked.error : null;
  }
  return AgentErrors.ACTION_NOT_ALLOWED;
}

export function reviewIssueSummary(view: AgentCaseView | undefined): string {
  const review = view ? currentReview(view.process) : undefined;
  if (!review) return '';
  if (review.invalidated) return '稿件已变更，原复核作废。';
  const open = unhandledIssues(view!.process).length;
  return open ? `未处理问题 ${open} 项` : '复核问题已全部勾选处理';
}
declare global { interface Window { patentDesktop?:DesktopAPI } }
export const desktop=window.patentDesktop;
