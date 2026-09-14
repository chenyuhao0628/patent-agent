import type { AgentJob, AgentProcessState, Discussion } from './agent.ts';
import type { AgentCommand } from '../agent-api.ts';

export function workflowMessageCommand(state: AgentProcessState, discussionId: string, text: string): AgentCommand {
  const discussion = state.discussions.find(d => d.id === discussionId);
  if (!discussion || discussion.archived) throw new Error('请先打开可办理的主讨论。');
  if (discussion.kind !== 'main') throw new Error('独立复核讨论不能办理主流程，请切换到本案讨论。');
  if (state.finalized || state.access === 'readonly') throw new Error('当前流程不可办理，可切换为仅讨论。');
  if (!state.analysis) {
    if (!state.materialsConfirmed || state.classification.status !== 'classified') throw new Error('请先在材料核对中确认通知分类和用于分析的材料。');
    const previous = discussionJobs(state, discussion).filter(j => j.action === 'analysis').at(-1);
    if (previous && ['stopped', 'failed'].includes(previous.state)) return { type: 'conversation', discussionId, operation: 'continue', runId: previous.runId, text };
    return { type: 'run', action: 'analysis', discussionId, userMessage: text };
  }
  if (!state.userSelectedStrategyId) {
    const choice=text.trim().match(/^(?:按|选择|选定|采用)(?:方案|策略)([1-9一二三四五六七八九])(?:[，,；;：:\s]*(开始(?:起草|答复)?|起草|进行起草|开始写))?[。！!]?$/);
    if(choice){const n=/[1-9]/.test(choice[1])?Number(choice[1]):'一二三四五六七八九'.indexOf(choice[1])+1;const strategy=state.analysis.strategies[n-1];if(strategy)return {type:'strategy',strategyId:strategy.id,startDraft:!!choice[2],userMessage:text};}
    throw new Error('意见分析已完成，请先选定策略；如需比较或调整方向，可切换为“仅讨论”。');
  }
  return { type: 'run', action: state.currentDraftVersionId ? 'revise' : 'draft', discussionId, userMessage: text };
}

export function discussionJobs(state: AgentProcessState, discussion: Discussion): AgentJob[] {
  return state.jobs.filter(job => job.discussionId === discussion.id
    && (!discussion.branchRunIds || discussion.branchRunIds.includes(job.runId)));
}

function saveBranch(state: AgentProcessState, discussion: Discussion) {
  if (!discussion.activeBranchId) discussion.activeBranchId = 'original';
  if (!discussion.branchRunIds) discussion.branchRunIds = discussionJobs(state, discussion).map(job => job.runId);
  discussion.branches ??= [];
  const previous = discussion.branches.find(branch => branch.id === discussion.activeBranchId);
  const snapshot = {
    id: discussion.activeBranchId,
    title: previous?.title ?? '原对话',
    messages: structuredClone(discussion.messages),
    toolEvents: structuredClone(discussion.toolEvents),
    runIds: [...discussion.branchRunIds],
  };
  if (previous) Object.assign(previous, snapshot);
  else discussion.branches.push(snapshot);
}

export function switchConversationBranch(state: AgentProcessState, discussionId: string, branchId: string): AgentProcessState {
  if (state.activeRunId) throw new Error('请先停止当前任务再切换分支。');
  const next = structuredClone(state);
  const discussion = next.discussions.find(d => d.id === discussionId);
  if (!discussion) throw new Error('讨论不存在。');
  saveBranch(next, discussion);
  const branch = discussion.branches!.find(b => b.id === branchId);
  if (!branch) throw new Error('分支不存在。');
  discussion.activeBranchId = branch.id;
  discussion.messages = structuredClone(branch.messages);
  discussion.toolEvents = structuredClone(branch.toolEvents);
  discussion.branchRunIds = [...branch.runIds];
  return next;
}

// A conversation fork changes context only. Drafts and business state stay versioned independently.
export function forkConversation(state: AgentProcessState, discussionId: string, cut: number, id: string, title: string): AgentProcessState {
  if (state.activeRunId) throw new Error('请先停止当前任务再重新发送。');
  const next = structuredClone(state);
  const discussion = next.discussions.find(d => d.id === discussionId);
  if (!discussion || discussion.archived) throw new Error('讨论不存在或已归档。');
  if (!Number.isInteger(cut) || cut < 0 || cut > discussion.messages.length) throw new Error('消息位置已变更。');
  saveBranch(next, discussion);
  const removed = new Set(discussion.messages.slice(cut).map(m => m.runId).filter(Boolean));
  discussion.messages = discussion.messages.slice(0, cut);
  discussion.toolEvents = cut === 0 ? [] : discussion.toolEvents.filter(t => !removed.has(t.runId));
  discussion.branchRunIds = cut === 0 ? [] : discussion.branchRunIds!.filter(runId => !removed.has(runId));
  discussion.activeBranchId = id;
  discussion.branches!.push({ id, title, messages: structuredClone(discussion.messages), toolEvents: structuredClone(discussion.toolEvents), runIds: [...discussion.branchRunIds] });
  return next;
}

export function preserveInterruptedOutput(state: AgentProcessState, runId: string): void {
  const job = state.jobs.find(j => j.runId === runId);
  if (!job || job.state === 'completed') return;
  const discussion = state.discussions.find(d => d.id === job.discussionId);
  if (discussion && job.partialText && !discussion.messages.some(m => m.id === `partial-${runId}`)) {
    discussion.messages.push({ id: `partial-${runId}`, runId, role: 'assistant', text: job.partialText, incomplete: true, at: job.endedAt ?? job.startedAt });
  }
  for (const step of job.steps ?? []) if (step.status === 'running') { step.status = 'stopped'; step.endedAt = job.endedAt; }
}
