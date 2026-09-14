import type { AgentProcessState } from './agent.ts';
import { currentDraft, currentReview } from './agent.ts';

export type LocalProgress = { caseId: string; processKey: string; openedAt?: string; steps: Array<{ label: string; done: boolean; at?: string }>; running: boolean; error?: string };
export function localProgress(state: AgentProcessState): LocalProgress {
  const draft = currentDraft(state), review = currentReview(state);
  return { caseId: state.scope.caseId, processKey: state.scope.processKey, openedAt: state.openedAt,
    steps: [
      { label: '打开案件', done: !!state.openedAt, at: state.openedAt },
      { label: '确认材料', done: state.materialsConfirmed, at: state.materialsConfirmedAt },
      { label: '意见分析', done: !!state.analysis, at: state.analysis?.at },
      { label: '选定策略', done: !!state.userSelectedStrategyId, at: state.userSelectedStrategyAt },
      { label: '采用稿件', done: !!draft, at: draft?.at },
      { label: '独立复核', done: !!review && !review.invalidated, at: review?.at },
      { label: '定稿', done: !!state.finalized, at: state.finalized?.at },
    ], running: !!state.activeRunId, error: state.jobs.at(-1)?.state === 'failed' ? state.jobs.at(-1)?.error : undefined };
}
