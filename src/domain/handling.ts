import type { Case, RemoteProcess, Submission } from './workflow.ts';
import {
  caseStatus, currentWork, effectiveSubmission, INTERNAL_ENDED_WAIT_LABEL, isConfirmedOfficialSubmission, officialStatusLabel, processSubmission, UNVERIFIED_INTERNAL_LABEL, UNVERIFIED_OFFICIAL_LABEL,
  WAITING_OFFICIAL_LABEL, workNames,
} from './lifecycle.ts';
import type { WorkKind } from './lifecycle.ts';
import { hasOfficialOutcome, outcomeLabels, outcomeView } from './outcome.ts';

export type HandlingFlowHint = {
  currentProcessId?: string;
  currentFlow?: { name: string; user: string; serial?: number; total?: number };
  nodes?: { name: string; user: string; finished: boolean; isCurrent?: boolean; type?: string; serial?: number; total?: number }[];
};

export type HandlerKind = 'flow-user' | 'pending-undertaker' | 'official' | 'none';

export type CurrentHandling = {
  kind: WorkKind;
  processId?: string;
  processName: string;
  node: string;
  party: string;
  handler?: string;
  handlerKind: HandlerKind;
  handlerNote?: string;
  officialWaiting: boolean;
  unverified: boolean;
  status: string;
  serial?: number;
  total?: number;
  showStepFraction: boolean;
};

export type ProcessRowHandling = {
  selected: boolean;
  tag: string | null;
  historical: boolean;
};

export const OFFICIAL_WAIT_NODE = WAITING_OFFICIAL_LABEL;
export const OFFICIAL_PARTY = '官方';
export const INTERNAL_FLOW_END = '内部递交流程结束';
export const PENDING_NODE = '待办';
export const PENDING_UNDERTAKER_NOTE = '待办承办人';

export function isInternalEndNode(name: string): boolean {
  return name === '结束' || name.includes(INTERNAL_FLOW_END);
}

export function isOfficialWaitingSubmission(sub?: Submission): boolean {
  return sub?.state === 'sent' || sub?.state === 'received';
}

function processNameOf(c: Case, process?: RemoteProcess): string {
  const work = currentWork(c);
  if (process?.name) return process.name;
  if (work.label && work.label !== WAITING_OFFICIAL_LABEL && work.label !== UNVERIFIED_OFFICIAL_LABEL && work.label !== UNVERIFIED_INTERNAL_LABEL && work.label !== INTERNAL_ENDED_WAIT_LABEL) return work.label;
  return workNames[work.kind];
}

function liveInternalNode(hint?: HandlingFlowHint) {
  return hint?.nodes?.find(n => n.isCurrent && !n.finished && n.type !== 'official');
}

function pendingWithoutInstance(process: RemoteProcess, hint?: HandlingFlowHint): boolean {
  if (process.status !== 0 || process.handId) return false;
  if (process.currentFlow?.name) return false;
  if (hint?.currentFlow?.name) return false;
  if (hint?.nodes?.some(n => n.isCurrent && !n.finished && n.type !== 'official')) return false;
  return true;
}

export function currentHandling(c: Case, hint?: HandlingFlowHint): CurrentHandling {
  const work = currentWork(c);
  const processId = hint?.currentProcessId ?? work.processId;
  const process = processId ? (c.remote?.processes ?? []).find(p => p.id === processId) : undefined;
  const sub = process ? effectiveSubmission(process) : processSubmission(c);
  const name = processNameOf(c, process);
  const status = caseStatus(c);
  const currentFlow = hint?.currentFlow ?? process?.currentFlow;
  const live = liveInternalNode(hint);

  // 官方结论优先于"等待官方处理结果"：授权/驳回通知已经到案，就不该再显示在等官方给结果。
  // 只覆盖显示与本机的等待判定，不改变贝思兰德流程页展示的真实递交与回执字段。
  if (hasOfficialOutcome(c)) {
    return {
      kind: work.kind,
      processId: process?.id ?? work.processId,
      processName: name,
      node: outcomeLabels[outcomeView(c)],
      party: OFFICIAL_PARTY,
      handlerKind: 'none',
      officialWaiting: false,
      unverified: false,
      status,
      showStepFraction: false,
    };
  }

  if (isOfficialWaitingSubmission(sub) && (!processId || !work.processId || processId === work.processId || process?.id === work.processId)) {
    return {
      kind: 'waiting',
      processId: process?.id ?? work.processId,
      processName: name,
      node: OFFICIAL_WAIT_NODE,
      party: OFFICIAL_PARTY,
      handler: OFFICIAL_PARTY,
      handlerKind: 'official',
      officialWaiting: true,
      unverified: false,
      status,
      showStepFraction: false,
    };
  }

  if (work.kind === 'needs-confirmation' && !process) {
    return {
      kind: work.kind,
      processName: work.label ?? workNames[work.kind],
      node: '待核验',
      party: '内部',
      handlerKind: 'none',
      officialWaiting: false,
      unverified: true,
      status,
      showStepFraction: false,
    };
  }

  if (process && process.status === 500 && !isConfirmedOfficialSubmission(sub)) {
    if (process.needSendOfficial === false) {
      return {
        kind: 'waiting',
        processId: process.id,
        processName: name,
        node: INTERNAL_ENDED_WAIT_LABEL,
        party: '内部',
        handlerKind: 'none',
        officialWaiting: false,
        unverified: false,
        status,
        showStepFraction: false,
      };
    }
    return {
      kind: work.kind === 'waiting' ? 'needs-confirmation' : work.kind,
      processId: process.id,
      processName: name,
      node: '待核验',
      party: '内部',
      handlerKind: 'none',
      officialWaiting: false,
      unverified: true,
      status,
      showStepFraction: false,
    };
  }

  if (live?.name) {
    return {
      kind: work.kind,
      processId: process?.id ?? work.processId,
      processName: name,
      node: live.name,
      party: '内部',
      handler: live.user || undefined,
      handlerKind: live.user ? 'flow-user' : 'none',
      officialWaiting: false,
      unverified: !live.user,
      status,
      serial: live.serial ?? currentFlow?.serial,
      total: live.total ?? currentFlow?.total,
      showStepFraction: stepFractionVisible(live.serial ?? currentFlow?.serial, live.total ?? currentFlow?.total),
    };
  }

  if (currentFlow?.name) {
    return {
      kind: work.kind,
      processId: process?.id ?? work.processId,
      processName: name,
      node: currentFlow.name,
      party: '内部',
      handler: currentFlow.user || undefined,
      handlerKind: currentFlow.user ? 'flow-user' : 'none',
      officialWaiting: false,
      unverified: !currentFlow.user,
      status,
      serial: currentFlow.serial,
      total: currentFlow.total,
      showStepFraction: stepFractionVisible(currentFlow.serial, currentFlow.total),
    };
  }

  if (process && pendingWithoutInstance(process, hint)) {
    return {
      kind: work.kind,
      processId: process.id,
      processName: name,
      node: process.node || PENDING_NODE,
      party: '内部',
      handler: process.undertaker || undefined,
      handlerKind: process.undertaker ? 'pending-undertaker' : 'none',
      handlerNote: process.undertaker ? PENDING_UNDERTAKER_NOTE : undefined,
      officialWaiting: false,
      unverified: !process.undertaker,
      status,
      showStepFraction: false,
    };
  }

  if (process?.node) {
    return {
      kind: work.kind,
      processId: process.id,
      processName: name,
      node: process.node,
      party: '内部',
      handlerKind: 'none',
      officialWaiting: false,
      unverified: true,
      status,
      showStepFraction: false,
    };
  }

  if (work.kind === 'waiting' || work.kind === 'external' || work.kind === 'needs-confirmation') {
    return {
      kind: work.kind,
      processId: work.processId,
      processName: name,
      node: work.node || work.label || workNames[work.kind],
      party: work.party || '内部',
      handlerKind: 'none',
      officialWaiting: false,
      unverified: work.kind === 'needs-confirmation' || !c.remote,
      status,
      showStepFraction: false,
    };
  }

  return {
    kind: work.kind,
    processId: work.processId,
    processName: name,
    node: work.node || name,
    party: work.party || '内部',
    handler: work.handler,
    handlerKind: work.handler ? 'flow-user' : 'none',
    officialWaiting: false,
    unverified: !!c.remote && !work.handler,
    status,
    showStepFraction: false,
  };
}

function stepFractionVisible(serial?: number, total?: number): boolean {
  if (serial == null || total == null || total <= 0) return false;
  return serial < total;
}

export function handlingHandlerText(h: CurrentHandling): string | undefined {
  if (h.handlerKind === 'pending-undertaker' && h.handler) return `${h.handler}（${PENDING_UNDERTAKER_NOTE}）`;
  if (h.handlerKind === 'flow-user' && h.handler) return h.handler;
  if (h.handlerKind === 'official') return OFFICIAL_PARTY;
  return undefined;
}

// 案件概览用的一句话流程状态：流程名 · 节点 · 办理人，外加官方递交状态。
// 只做展示拼装，不产生新的业务判断；办理主体为官方时不重复显示「办理人：官方」。
export type FlowStatusSummary = { process: string; node: string; handler?: string; submission?: string; officialWaiting: boolean; unverified: boolean };

export function flowStatusSummary(c: Case): FlowStatusSummary {
  const h = currentHandling(c);
  const handler = handlingHandlerText(h);
  const sub = processSubmission(c);
  return {
    process: h.processName,
    node: h.node,
    handler: handler && h.handlerKind !== 'official' ? handler : undefined,
    // 已出官方结论时不再显示"等待官方处理结果"这类递交文案，避免和结论自相矛盾；
    // 真实的递交与回执记录仍在贝思兰德流程页展示。
    submission: hasOfficialOutcome(c) || !sub ? undefined : officialStatusLabel(sub),
    officialWaiting: h.officialWaiting,
    unverified: h.unverified,
  };
}

export function processRowHandling(p: RemoteProcess, currentProcessId?: string): ProcessRowHandling {
  const selected = p.id === currentProcessId;
  const official = isOfficialWaitingSubmission(p.submission);
  const activeInternal = p.status >= 0 && p.status !== 500 && !official;
  if (official) {
    if (selected) {
      const tag = p.submission?.state === 'received' ? '已收到回执 · 官方处理中' : '已递交 · 官方处理中';
      return { selected: true, tag, historical: false };
    }
    return { selected: false, tag: p.submission?.state === 'received' ? '已收到回执' : '已递交', historical: true };
  }
  if (selected && p.status === 500) return { selected: true, tag: '待核验', historical: false };
  if (selected && activeInternal) return { selected: true, tag: '当前办理', historical: false };
  if (selected) return { selected: true, tag: '待核验', historical: false };
  if (activeInternal) return { selected: false, tag: '内部办理中', historical: false };
  if (p.status === 500) return { selected: false, tag: null, historical: true };
  return { selected: false, tag: '待核验', historical: false };
}

export function officialWaitProgressCaption(h: CurrentHandling, nodes?: { name: string; finished: boolean }[]): string | undefined {
  if (h.officialWaiting) {
    const ended = nodes?.some(n => isInternalEndNode(n.name) && n.finished);
    return ended ? `${INTERNAL_FLOW_END}，正在${OFFICIAL_WAIT_NODE}` : `正在${OFFICIAL_WAIT_NODE}`;
  }
  if (h.showStepFraction && h.serial != null && h.total != null) return `当前步骤 ${h.serial} / ${h.total}`;
  return undefined;
}

export function stampCurrentHandling(c: Case, hint?: HandlingFlowHint): void {
  if (!c.current) return;
  const h = currentHandling(c, hint);
  c.current = { ...c.current, node: h.node, party: h.party, handler: h.handler };
}
