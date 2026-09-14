import type { CaseDesign } from './designFlows.ts';
import { currentWork, editableCurrent } from './lifecycle.ts';
import type { CurrentWork } from './lifecycle.ts';
export type Stage = 'materials' | 'strategy' | 'draft' | 'review' | 'final';
export type JobKind = 'analysis' | 'drafting' | 'reviewing';
export type Message = { id: string; role: 'user' | 'assistant'; text: string };
export type Discussion = { id: string; title: string; messages: Message[] };
export type Version = { id: string; text: string; label: string; at: string };
export type Material = { id: string; name: string; role: string; location: string; excerpt: string; ready: boolean; fileNo?:string; relativePath?:string };
export type Round = {
  priorArt?: import("../../desktop/prior-art.ts").PriorArtState;
  id: string; name: string; stage: Stage; confirmed: boolean; materials: Material[];
  strategy: string | null; draft: string; versions: Version[]; discussions: Discussion[];
  review: { versionId: string; finding: string; resolved: boolean } | null;
  job: { id: string; kind: JobKind; status: 'running' | 'paused'; due: number } | null;
  final: { versionId: string; text: string; at: string } | null;
  finalHistory: { versionId: string; text: string; at: string }[];
};
export type SubmissionState = 'unknown'|'draft'|'queued'|'sending'|'sent'|'received'|'failed';
export type Submission = {state:SubmissionState;checkedAt:string;message?:string;source?:'hand'|'send-status'|'personal-status';refreshError?:string};
export type OfficialDeadlineSource = 'cpc'|'official-document';
export type CurrentFlowInfo = {name:string;user:string;serial?:number;total?:number};
export type RemoteProcess = {personalStatus?:number;canEdit?:boolean;procCode?:string;flowRemark?:string;officeNote?:string;procNote?:string;id:string;name:string;status:number;node:string;undertaker:string;deadline:string;officialDeadline?:string;officialDeadlineSource?:OfficialDeadlineSource;baselandDeadline?:string;internalDeadline?:string;handId?:string;submission?:Submission;currentFlow?:CurrentFlowInfo;needSendOfficial?:boolean};
export type Case = { remoteClosure?:{finished:boolean;checkedAt:string}; companyName?:string;caseRemark?:string;caseInfoAt?:string; id: string; title: string; number: string; type: string; deadline: string; archived: boolean; tags: string[]; rounds: Round[]; design?: CaseDesign; current?:CurrentWork; source?:'baseland'|'local'; materials?:Material[]; applicationNumber?:string; directory?:string; remote?:{caseId:string;processes:RemoteProcess[];syncedAt:string}; localDraft?:string; sharedDraftHash?:string; localVersions?:{id:string;text:string;at:string;processId?:string}[] };
export type Settings = {provider:string;baseUrl:string;model:string;originalLibrary?:string;workRoot?:string;sharedDirectory?:string;localDirectory?:string;templatePath?:string;extensions?:{id:string;name:string;kind:'技能'|'MCP';enabled:boolean}[]};
export type Workspace = { schema: 1; cases: Case[]; settings: Settings };
export type Action =
  | { type: 'confirm'; value: boolean }
  | { type: 'start'; kind: JobKind; strategy?: string }
  | { type: 'complete'; jobId: string }
  | { type: 'pause' } | { type: 'resume' }
  | { type: 'edit'; text: string } | { type: 'save' }
  | { type: 'resolve' } | { type: 'finalize' } | { type: 'revise' }
  | { type: 'discuss'; discussionId: string; text: string }
  | { type: 'new-discussion' };

const uid = () => crypto.randomUUID();
const time = () => new Date().toISOString();
export const stages: { id: Stage; label: string }[] = [
  { id: 'materials', label: '材料核对' }, { id: 'strategy', label: '策略讨论' },
  { id: 'draft', label: '起草修改' }, { id: 'review', label: '独立复核' }, { id: 'final', label: '定稿归档' },
];
export const jobLabels: Record<JobKind, string> = { analysis: '分析材料', drafting: '起草稿件', reviewing: '独立复核' };
export const currentVersion = (r: Round) => r.versions.at(-1);
export const isSaved = (r: Round) => !!currentVersion(r) && currentVersion(r)!.text === r.draft;
export const canFinalize = (r: Round) => isSaved(r) && !r.job && !r.final && !!r.review?.resolved && r.review.versionId === currentVersion(r)?.id;
export function statusLabel(r: Round) {
  if (r.job) return r.job.status === 'paused' ? '已暂停' : jobLabels[r.job.kind];
  return { materials: '待核对', strategy: '策略讨论', draft: '起草修改', review: '待复核', final: '已定稿' }[r.stage];
}

// Pure transition boundary: jobs, reviews and final artifacts always belong to one round.
export function transition(round: Round, action: Action): Round {
  const r = structuredClone(round);
  switch (action.type) {
    case 'confirm': if (r.stage === 'materials' && !r.job) r.confirmed = action.value; break;
    case 'start': {
      if (r.job || r.final) break;
      const valid = action.kind === 'analysis' ? r.stage === 'materials' && r.confirmed && r.materials.every(m => m.ready)
        : action.kind === 'drafting' ? r.stage === 'strategy' && !!action.strategy
          : ['draft', 'review'].includes(r.stage) && isSaved(r);
      if (!valid) break;
      if (action.strategy) r.strategy = action.strategy;
      r.job = { id: uid(), kind: action.kind, status: 'running', due: Date.now() + 3500 };
      if (action.kind === 'reviewing') r.review = null;
      break;
    }
    case 'complete': {
      if (!r.job || r.job.id !== action.jobId || r.job.status !== 'running') break;
      if (r.job.kind === 'analysis') {
        r.stage = 'strategy';
        r.discussions[0].messages.push({ id: uid(), role: 'assistant', text: '示例分析已展开。请比较两种答复路径，点击材料引用核对依据，再由你选定策略。此处为固定演示内容。' });
      } else if (r.job.kind === 'drafting') {
        r.stage = 'draft';
        r.draft = `针对${r.name}的答复\n\n一、意见概述\n本稿用于演示材料、策略与稿件之间的交互，不作为任何真实案件的答复。\n\n二、答复路径\n已选策略：${r.strategy}。结合原始申请文件中的技术描述，逐项回应通知书意见。\n\n三、修改说明\n拟修改内容及其原始依据应逐项对应，提交前由用户核对。\n\n四、结语\n请基于最终确认的有效文本完成答复。`;
        r.versions.push({ id: uid(), text: r.draft, label: '示例初稿', at: time() });
      } else {
        r.stage = 'review';
        r.review = { versionId: currentVersion(r)!.id, finding: '请核对第三节的修改说明是否已逐项标出原始依据。本条为预设复核问题。', resolved: false };
      }
      r.job = null;
      break;
    }
    case 'pause': if (r.job) r.job.status = 'paused'; break;
    case 'resume': if (r.job?.status === 'paused') { r.job.status = 'running'; r.job.due = Date.now() + 3500; } break;
    case 'edit': if (!r.final && !r.job && r.versions.length) { r.draft = action.text; r.review = null; r.stage = 'draft'; } break;
    case 'save':
      if (!r.final && !r.job && r.draft.trim() && !isSaved(r)) r.versions.push({ id: uid(), text: r.draft, label: '人工修改', at: time() });
      break;
    case 'resolve': if (r.review && isSaved(r) && r.review.versionId === currentVersion(r)?.id) r.review.resolved = true; break;
    case 'finalize':
      if (canFinalize(r)) { r.final = { versionId: currentVersion(r)!.id, text: r.draft, at: time() }; r.stage = 'final'; }
      break;
    case 'revise': if (r.final) { r.finalHistory.push(r.final); r.final = null; r.review = null; r.stage = 'draft'; } break;
    case 'discuss': {
      if (!action.text.trim() || r.job) break;
      const discussion = r.discussions.find(d => d.id === action.discussionId);
      if (!discussion) break;
      discussion.messages.push({ id: uid(), role: 'user', text: action.text.trim() });
      discussion.messages.push({ id: uid(), role: 'assistant', text: '已记录你的意见（原型演示）。正式接入后，agent 将基于本轮材料及明确的稿件版本回应。当前可直接在正文区编辑并保存新版本。' });
      break;
    }
    case 'new-discussion': r.discussions.push({ id: uid(), title: `讨论 ${r.discussions.length + 1}`, messages: [] }); break;
  }
  return r;
}

export function updateRound(workspace: Workspace, caseId: string, roundId: string, action: Action): Workspace {
  return { ...workspace, cases: workspace.cases.map(c => c.id !== caseId || currentWork(c).roundId!==roundId || !editableCurrent(c) ? c : { ...c, rounds: c.rounds.map(r => r.id === roundId ? transition(r, action) : r) }) };
}
export function pauseRunning(workspace: Workspace): Workspace {
  return { ...workspace, cases: workspace.cases.map(c => ({ ...c, rounds: c.rounds.map(r => r.job?.status === 'running' ? transition(r, { type: 'pause' }) : r) })) };
}

export function makeRound(name: string, historical = false): Round {
  const materialNames = historical ? ['当前通知书.pdf', '原始申请文件.docx', '对比文件 D1.pdf'] : ['当前通知书.pdf', '原始申请文件.docx', '对比文件 D1.pdf', '首通答复及修改稿.doc'];
  return {
    id: uid(), name, stage: 'materials', confirmed: false, strategy: null, draft: '', versions: [], review: null, job: null, final: null, finalHistory: [],
    materials: materialNames.map((name, i) => ({ id: uid(), name, role: ['当前通知', '原始申请', '对比文件', '历史有效稿'][i], location: ['第 2 页 · 意见 1', '第 4 页 · 第 0018 段', '第 3 页 · 技术描述', '第 2 页 · 修改说明'][i], ready: true, excerpt: ['【虚构通知片段】请针对申请文件所述的技术特征补充说明，并核对相应修改的原始依据。', '【虚构原始申请片段】控制模块根据检测结果调整执行机构的工作状态。具体结构与配合关系见原始说明书。', '【虚构对比片段】参考装置包括检测单元和控制单元。本例用于演示源文件定位交互。', '【虚构历史片段】本轮采用上轮实际提交的修改稿作为历史有效版本。原始文件另行保留。'][i] })),
    discussions: [{ id: uid(), title: '答复主讨论', messages: [] }],
  };
}

export function seedWorkspace(): Workspace {
  const titles = ['一种自适应温控装置', '一种模块化夹持机构', '一种图像识别方法', '一种密封连接结构'];
  const cases = titles.map((title, i): Case => ({ id: uid(), title, number: `示例-2026-00${i + 1}`, type: i === 1 || i === 3 ? '实用新型' : '发明', deadline: ['2026-09-25', '2026-09-28', '2026-10-08', '2026-10-12'][i], archived: false, tags: i === 0 ? ['优先处理'] : [], rounds: [makeRound(i === 0 ? '第二次审查意见' : i === 3 ? '补正通知' : '第一次审查意见', i !== 0)] }));
  cases[0].rounds.push(makeRound('第一次审查意见', true));
  cases[1].rounds[0].stage = 'strategy'; cases[1].rounds[0].confirmed = true;
  for (const i of [2, 3]) {
    let r = cases[i].rounds[0]; r.stage = 'strategy'; r.confirmed = true;
    r = transition(r, { type: 'start', kind: 'drafting', strategy: '解释差异，维持现有文本' });
    r = transition(r, { type: 'complete', jobId: r.job!.id });
    if (i === 3) {
      r = transition(r, { type: 'start', kind: 'reviewing' }); r = transition(r, { type: 'complete', jobId: r.job!.id });
      r = transition(r, { type: 'resolve' }); r = transition(r, { type: 'finalize' });
    }
    cases[i].rounds[0] = r;
  }
  return { schema: 1, cases, settings: { provider: 'DeepSeek', baseUrl: '', model: '' } };
}
