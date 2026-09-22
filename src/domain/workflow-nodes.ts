import type { Case } from './workflow.ts';
import type { LocalProgress } from './local-progress.ts';
import { currentWork, isConfirmedOfficialSubmission, processSubmission, processBusinessKind } from './lifecycle.ts';
import { WAITING_OFFICIAL_LABEL, OFFICIAL_PARTY } from './stage-verdict.ts';
import { WRITING_PHASES } from '../professional-api.ts';
export type WorkflowNode = { label: string; state: 'done' | 'current' | 'pending' | 'unknown' | 'optional'; at?: string; detail?: string; closedBySubmission?: boolean };
export function workflowBusiness(c: Case) {
  const w = currentWork(c);
  return processBusinessKind(c.remote?.processes.find(p => p.id === w.processId)?.name ?? '') ?? w.kind;
}
export function workflowNodes(c: Case, progress?: LocalProgress): WorkflowNode[] {
  const w = currentWork(c), p = c.remote?.processes.find(p => p.id === w.processId);
  const done = isConfirmedOfficialSubmission(processSubmission(c)) || (c.source === 'local' && (!!c.localSubmission || (w.kind === 'waiting' && (w.label === WAITING_OFFICIAL_LABEL || w.party === OFFICIAL_PARTY))));
  const remote = c.source === 'baseland';
  const started = !!p?.handId || !!p && [200, 300, 400].includes(p.status) || done;
  const forwarded = !done && !!p?.currentFlow && (p.currentFlow.serial ?? 0) > 1 && p.canEdit === false;
  const endedLocal = done || forwarded || p?.status === 500;
  const kind = workflowBusiness(c);
  const labels = kind === 'write' ? ['打开案件', ...WRITING_PHASES.map(x => '确认' + x)] : kind === 'review' ? ['打开案件', '准备审查稿件', '完成独立审查'] : ['打开案件', '确认材料', '意见分析', '选定策略', '采用稿件', '独立复核', '定稿'];
  const known = labels.map(label => progress?.steps.find(s => s.label === label));
  const lastDone = known.reduce((last, s, i) => s?.done ? i : last, -1);
  let hasCurrent = false;
  const local: WorkflowNode[] = labels.map((label, i) => {
    const s = known[i];
    if (s?.done) return { label: label === '采用稿件' ? '起草／修改' : label, state: 'done', at: s.at };
    let state: WorkflowNode['state'];
    if (endedLocal || i < lastDone) state = 'unknown';
    else if (label === '独立复核') state = 'optional';
    else if ((!remote || started) && !hasCurrent) { state = 'current'; hasCurrent = true; }
    else state = 'pending';
    return { label: label === '采用稿件' ? '起草／修改' : label, state };
  });
  if (!remote) {
    const localWithSubmit: WorkflowNode[] = [
      ...local,
      { label: '递交官方', state: done ? 'done' : hasCurrent ? 'pending' : 'current', at: c.localSubmission?.at, detail: c.localSubmission?.method },
    ];
    return done ? localWithSubmit.map(node => node.state === 'done' ? node : { ...node, state: 'done', closedBySubmission: true }) : localWithSubmit;
  }
  const nodes: WorkflowNode[] = [
    { label: '待处理', state: started ? 'done' : p?.status === 0 ? 'current' : 'unknown' },
    { label: '启动递交', state: started ? 'done' : p?.status === 0 ? 'pending' : 'unknown' },
    ...local,
    { label: '转交下一办理人', state: forwarded ? 'done' : endedLocal ? 'unknown' : started && !hasCurrent ? 'current' : 'pending', detail: forwarded ? p?.currentFlow?.user : undefined },
    { label: forwarded && p?.currentFlow?.name && !p.currentFlow.name.includes('官方') ? p.currentFlow.name + '／提交官方' : '提交官方', state: done ? 'done' : forwarded ? 'current' : p?.status === 500 ? 'unknown' : 'pending', detail: forwarded ? `${p?.currentFlow?.user || '办理人待核对'} · ${p?.currentFlow?.name || '节点待核对'}` : undefined },
    { label: '已完成', state: done ? 'done' : p?.status === 500 ? 'unknown' : 'pending' },
  ];
  return done ? nodes.map(node => node.state === 'done' ? node : {...node, state: 'done', closedBySubmission: true}) : nodes;
}
export const workflowNodeStatus = { done: '已完成', current: '当前', pending: '待办理', unknown: '无记录', optional: '可选' };
