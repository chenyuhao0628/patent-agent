import { currentHandling } from './handling.ts';
import type { Case, RemoteProcess } from './workflow.ts';
import { hasOfficialOutcome, outcomeLabels, outcomeView } from './outcome.ts';
import { internalTransferAvailable, activeRound, caseStatus, currentWork, processBusinessKind, workModule } from './lifecycle.ts';
import { stageVerdict } from './stage-verdict.ts';
import {
  currentRemoteProcess, deadlineView as caseDeadlineView, DEADLINE_HEADER, localDayOrdinal, MS_PER_DAY, parseCalendarDay,
} from './deadlines.ts';
import type { DeadlineProvenance, DeadlineView } from './deadlines.ts';

export type Module = 'reply' | 'write' | 'review' | 'transfer';
export type BusinessKind = '申请' | '审查意见' | '补正' | '审查' | '其他';
export type CardId = 'active' | 'overdue' | 'today' | 'near' | 'waitingOfficial';
export type SortKey = 'deadline' | 'patentType' | 'business' | 'title' | 'company' | 'status';
export type SortDir = 'asc' | 'desc';
export type ArchivedFilter = 'active' | 'archived' | 'all';
export type ProgressStatus = 'pending' | 'in_progress' | 'final';
export type DeadlineSource = DeadlineProvenance;
export type { DeadlineView };
export { DEADLINE_HEADER, localDayOrdinal, MS_PER_DAY, parseCalendarDay };

export const NEAR_DEADLINE_DAYS = 14;
export const BUSINESS_ORDER: BusinessKind[] = ['申请', '审查意见', '补正', '审查', '其他'];
export const PROGRESS_ORDER: ProgressStatus[] = ['pending', 'in_progress', 'final'];
export const moduleLabels: Record<Module, string> = { reply: '审查意见答复', write: '专利撰写', review: '内部审查', transfer: '内部流转' };

const BUSINESS_BY_KIND: Record<string, BusinessKind> = {
  write: '申请',
  reply: '审查意见',
  correction: '补正',
  review: '审查',
};

type SubmissionState = 'unknown' | 'draft' | 'queued' | 'sending' | 'sent' | 'received' | 'failed';

type ProcessFields = {
  submissionState?: SubmissionState | string;
  submissionSource?: 'hand' | 'send-status' | string;
};

export type LibraryScope = 'all' | 'workspace' | 'official';

export function inOfficialWaiting(c: Case): boolean {
  return currentHandling(c).officialWaiting;
}

export type LibraryQuery = {
  scope?: LibraryScope;
  module?: Module;
  search?: string;
  patentType?: string;
  business?: string;
  progress?: ProgressStatus | '';
  card?: CardId | null;
  archived?: ArchivedFilter;
  sortKey?: SortKey;
  sortDir?: SortDir;
  now?: Date;
};

export type LibraryResult = {
  availablePatentTypes: string[];
  availableBusinessKinds: BusinessKind[];
  availableProgressStatuses: ProgressStatus[];
  counts: Record<CardId, number>;
  rows: Case[];
};

function processFields(c: Case): ProcessFields {
  const process = currentRemoteProcess(c) as (RemoteProcess & Record<string, unknown>) | undefined;
  if (!process) return {};
  const submission = process.submission && typeof process.submission === 'object' ? process.submission as Record<string, unknown> : undefined;
  const submissionState = typeof submission?.state === 'string' ? submission.state : undefined;
  const submissionSource = typeof submission?.source === 'string' ? submission.source : undefined;
  return { submissionState, submissionSource };
}

export function deadlineView(c: Case): DeadlineView {
  return caseDeadlineView(c);
}

export function daysUntilDeadline(c: Case, now: Date = new Date()): number | null {
  const ordinal = deadlineView(c).ordinal;
  if (ordinal === null) return null;
  return ordinal - localDayOrdinal(now);
}

export function businessKind(c: Case): BusinessKind {
  const process = currentRemoteProcess(c);
  const remote = process ? processBusinessKind(process.name) : processBusinessKind(currentWork(c).label ?? '');
  if (remote) return BUSINESS_BY_KIND[remote];
  return BUSINESS_BY_KIND[currentWork(c).kind] ?? '其他';
}

export function isConfirmedWaitingOfficial(c: Case): boolean {
  // 已出官方结论（授权/驳回）的案件不再算"等待官方"：结果已经到案，等的是后续处理而不是结果。
  if (hasOfficialOutcome(c)) return false;
  return stageVerdict({ submission: currentRemoteProcess(c)?.submission }) === 'waiting-official';
}

export function waitingOfficialLabel(c: Case): string | null {
  const { submissionState, submissionSource } = processFields(c);
  if (submissionState === 'received') return '已收到回执，等待官方处理结果';
  if (submissionState !== 'sent') return null;
  if (submissionSource === 'hand') return '已递交，等待官方处理结果';
  return '递交成功，等待回执';
}

function isFinishedOrWaitingBusiness(c: Case): boolean {
  if (isConfirmedWaitingOfficial(c)) return true;
  const work = currentWork(c);
  if (work.kind === 'waiting') return true;
  if (work.kind === 'external' && !work.processId) return true;
  return false;
}

export function isUrgencyEligible(c: Case): boolean {
  return !c.archived && !isFinishedOrWaitingBusiness(c);
}

export function isActiveWork(c: Case): boolean {
  return isUrgencyEligible(c);
}

export function matchesModule(c: Case, module?: Module): boolean {
  if (!module) return true;
  if (module === 'transfer') return c.source==='baseland' ? internalTransferAvailable(c) : false;
  return workModule(c) === module;
}

export function progressStatus(c: Case): ProgressStatus {
  const work = currentWork(c);
  if (['waiting', 'external'].includes(work.kind) || (work.remoteStatus && work.remoteStatus !== 0)) return 'in_progress';
  if (work.kind === 'needs-confirmation') return 'pending';
  const stage = activeRound(c)?.stage ?? (c.design?.writing.finalVersionId ? 'final' : work.kind === 'write' ? 'draft' : 'review');
  if (stage === 'materials') return 'pending';
  if (stage === 'final') return 'final';
  return 'in_progress';
}

export function progressStatusLabel(status: ProgressStatus, module?: Module): string {
  const future = !!module && module !== 'reply';
  if (status === 'pending') return future ? '待开始' : '待核对';
  if (status === 'final') return future ? '已完成' : '已定稿';
  return '进行中';
}

export function libraryStatus(c: Case): { short: string; full: string } {
  const full = caseStatus(c);
  if (c.archived) return { short: '已归档', full };
  // 官方结论优先：列表里直接显示"已授权/已驳回"，不再显示为等待官方。
  if (hasOfficialOutcome(c)) return { short: outcomeLabels[outcomeView(c)], full };
  if(c.source==='baseland'&&/^(待处理|递交中|已完成) · /.test(full))return {short:full,full};
  if(c.remoteClosure?.finished)return {short:'已结案',full:'贝思兰德确认案件已结案'};
  if (/当前流程已办结|已结束，等待|内部流程已结束/.test(full)) return { short: inOfficialWaiting(c)?'等待官方':'流程已结束', full };
  const waiting = waitingOfficialLabel(c);
  if (waiting) return { short: '等待官方', full: full && full !== waiting ? `${waiting} · ${full}` : waiting };
  const separator = ' · ';
  const index = full.indexOf(separator);
  if (index >= 0) return { short: full.slice(index + separator.length), full };
  return { short: full, full };
}

function matchesSearch(c: Case, search: string): boolean {
  if (!search) return true;
  const haystack = `${c.title} ${c.companyName ?? ''} ${c.number} ${c.applicationNumber ?? ''} ${c.tags.join(' ')}`.toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function matchesCard(c: Case, card: CardId, now: Date): boolean {
  if (card === 'waitingOfficial') return !c.archived && isConfirmedWaitingOfficial(c);
  if (card === 'active') return isActiveWork(c);
  if (!isUrgencyEligible(c)) return false;
  const days = daysUntilDeadline(c, now);
  if (days === null) return false;
  if (card === 'overdue') return days < 0;
  if (card === 'today') return days === 0;
  return days >= 1 && days <= NEAR_DEADLINE_DAYS;
}

function uniquePatentTypes(cases: Case[]): string[] {
  const values = [...new Set(cases.map(c => c.type).filter(Boolean))];
  const preferred = ['发明', '实用新型'];
  return values.sort((a, b) => {
    const ai = preferred.indexOf(a), bi = preferred.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai === -1 ? preferred.length : ai) - (bi === -1 ? preferred.length : bi) || a.localeCompare(b, 'zh-CN');
    return a.localeCompare(b, 'zh-CN');
  });
}

function uniqueBusinessKinds(cases: Case[]): BusinessKind[] {
  const present = new Set(cases.map(businessKind));
  return BUSINESS_ORDER.filter(kind => present.has(kind));
}

function uniqueProgressStatuses(cases: Case[]): ProgressStatus[] {
  const present = new Set(cases.map(progressStatus));
  return PROGRESS_ORDER.filter(status => present.has(status));
}

export function nextLibrarySort(currentKey: SortKey, currentDir: SortDir, clicked: SortKey): { sortKey: SortKey; sortDir: SortDir } {
  if (currentKey === clicked) return { sortKey: clicked, sortDir: currentDir === 'asc' ? 'desc' : 'asc' };
  return { sortKey: clicked, sortDir: 'asc' };
}

function compareCases(a: Case, b: Case, sortKey: SortKey, sortDir: SortDir, index: Map<string, number>): number {
  let primary = 0;
  if (sortKey === 'deadline') {
    const left = deadlineView(a).ordinal, right = deadlineView(b).ordinal;
    if (left === null && right === null) primary = 0;
    else if (left === null) return 1;
    else if (right === null) return -1;
    else primary = left - right;
  } else if (sortKey === 'company') {
    const left = a.companyName?.trim(), right = b.companyName?.trim();
    if (!left && right) return 1;
    if (left && !right) return -1;
    primary = (left || '').localeCompare(right || '', 'zh-CN');
  } else if (sortKey === 'patentType') {
    primary = a.type.localeCompare(b.type, 'zh-CN');
  } else if (sortKey === 'business') {
    primary = BUSINESS_ORDER.indexOf(businessKind(a)) - BUSINESS_ORDER.indexOf(businessKind(b));
  } else if (sortKey === 'status') {
    primary = libraryStatus(a).short.localeCompare(libraryStatus(b).short, 'zh-CN');
  } else {
    primary = a.title.localeCompare(b.title, 'zh-CN') || a.number.localeCompare(b.number, 'zh-CN');
  }
  if (primary !== 0) return sortDir === 'desc' ? -primary : primary;
  const byId = a.id.localeCompare(b.id);
  if (byId !== 0) return byId;
  return (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
}

export function queryLibrary(cases: Case[], query: LibraryQuery = {}): LibraryResult {
  const {
    scope = 'all', module, search = '', patentType = '', business = '', progress = '', card = null,
    archived = 'active', sortKey = 'deadline', sortDir = 'asc', now = new Date(),
  } = query;
  const index = new Map(cases.map((c, i) => [c.id, i]));
  const inModule = cases.filter(c => matchesModule(c, module) && (scope === 'all' || (scope === 'official' ? inOfficialWaiting(c) : !inOfficialWaiting(c))));
  const availablePatentTypes = uniquePatentTypes(inModule);
  const availableBusinessKinds = uniqueBusinessKinds(inModule);
  const availableProgressStatuses = uniqueProgressStatuses(inModule);
  const typed = inModule.filter(c =>
    matchesSearch(c, search)
    && (!patentType || c.type === patentType)
    && (!business || businessKind(c) === business)
    && (!progress || progressStatus(c) === progress)
  );
  const counts: Record<CardId, number> = {
    active: typed.filter(isActiveWork).length,
    overdue: typed.filter(c => matchesCard(c, 'overdue', now)).length,
    today: typed.filter(c => matchesCard(c, 'today', now)).length,
    near: typed.filter(c => matchesCard(c, 'near', now)).length,
    waitingOfficial: typed.filter(c => matchesCard(c, 'waitingOfficial', now)).length,
  };
  let rows = typed;
  if (archived === 'active') rows = rows.filter(c => !c.archived);
  else if (archived === 'archived') rows = rows.filter(c => c.archived);
  if (card) rows = rows.filter(c => matchesCard(c, card, now));
  rows = [...rows].sort((a, b) => compareCases(a, b, sortKey, sortDir, index));
  return { availablePatentTypes, availableBusinessKinds, availableProgressStatuses, counts, rows };
}
