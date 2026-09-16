import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adoptDraft,
  AgentErrors,
  completeAgentJob,
  confirmMaterials,
  confirmReviewIssuesHandled,
  createAgentProcess,
  currentReview,
  emptyAgentBook,
  failAgentJob,
  finalizeProcess,
  markStoppedOnReopen,
  openDiscussion,
  manageDiscussion,
  discussionCanDelete,
  openReviewDiscussion,
  missingFormalReads,
  recordToolEvent,
  recordUserDraft,
  selectStrategy,
  startAgentJob,
  startAgentJobInBook,
  stopAgentJob,
  updateClassification,
  upsertProcess,
  WORD_NOT_CONNECTED,
  artifactPreviewText,
  type DraftVersion,
  type AgentProcessState,
  type AgentResult,
  type AgentSuccess,
  type AnalysisArtifact,
  type DraftingArtifact,
  type ReviewArtifact,
} from './agent.ts';
import { buildAgentPrompt, loadReplyRules, REPLY_RULES_ROOT_HINT } from '../../desktop/agent-rules.ts';

const rulesRoot = fileURLToPath(new URL('../../resources/reply-rules', import.meta.url));
const SOURCE_SHA: Record<string, string> = {
  'ai_reply_template_prompt.md': '160a2f4a6127b53097370d02aee365644a5858fc99d67ef5f0406a10accdea5d',
  'ai_reply_first_office_action_prompt.md': '30964e758aba68f3bea17ce86d1d1306da6733de35e7c7d959b8a579ae480bc0',
  'ai_reply_second_office_action_prompt.md': '391abe4bec265365759c2c8d1f107de3cc1bc0c08e251e167d7e8ab528245a92',
  'ai_reply_third_office_action_prompt.md': '33e3a78767918fd1bd2205244d3dd444b5000cbe51f8db275f01a3f42a2e4d04',
  'ai_reply_correction_prompt.md': '2d0072ebc7609f284fc7899fa4a77933dc267351192bbb11b16366764e182621',
};
const scope = { caseId: 'c1', processKey: 'p1' };
const firstInvention = {
  patentType: '发明' as const,
  noticeCategory: '审查意见通知书' as const,
  officeActionRound: 1,
  correctionBasis: 'original' as const,
};

function unwrap<T>(result: AgentResult<T>): AgentSuccess<T> {
  if (!result.ok) throw new Error(result.error);
  return result;
}

function materials() {
  return [
    { id: 'n1', name: '通知.pdf', role: '当前通知', relativePath: '01_通知与材料/通知.pdf', hash: 'h-notice', ready: true },
    { id: 'a1', name: '申请.docx', role: '原始申请', relativePath: '00_原始申请/申请.docx', hash: 'h-app', ready: true },
  ];
}

function created(over: Record<string, unknown> = {}, access?: 'editable' | 'readonly'): AgentProcessState {
  return unwrap(createAgentProcess({
    ...scope,
    classification: { ...firstInvention, ...over } as typeof firstInvention,
    materials: materials(),
    access,
  })).state;
}

function confirmed(state = created()): AgentProcessState {
  return unwrap(confirmMaterials(state, { ...scope, selectedIds: ['n1', 'a1'] })).state;
}

const analysisArtifact: AnalysisArtifact = {
  kind: 'analysis',
  opinions: [{ id: 'o1', title: '创造性', summary: '通知认为权利要求1不具备创造性', basis: '通知.pdf 意见1' }],
  strategies: [
    { id: 's1', title: '争辩维持', summary: '强调区别特征', benefits: '保护范围较大', risks: '二通压力', basis: '申请.docx 权利要求1' },
    { id: 's2', title: '适度修改', summary: '补入从属特征', benefits: '更稳妥', risks: '范围收窄', basis: '申请.docx 权利要求2' },
  ],
  modelSelectedStrategyId: 's1',
  body: '若被误当作草稿，应被忽略。',
};

function readSelected(state: AgentProcessState, runId?: string, caseScope = scope): AgentProcessState {
  const id = runId ?? state.activeRunId!;
  let next = state;
  for (const item of state.materials.filter(entry => entry.selected)) {
    next = unwrap(recordToolEvent(next, {
      ...caseScope, runId: id, filename: item.name, readRange: '1-2', status: 'ok',
      materialId: item.id, toolKind: 'read_material',
    })).state;
  }
  return next;
}

function readDraft(state: AgentProcessState, runId?: string, caseScope = scope): AgentProcessState {
  const id = runId ?? state.activeRunId!;
  return unwrap(recordToolEvent(state, {
    ...caseScope, runId: id, filename: '当前稿', readRange: '全文', status: 'ok', toolKind: 'read_draft',
  })).state;
}

function readFormal(state: AgentProcessState, runId?: string, caseScope = scope): AgentProcessState {
  const id = runId ?? state.activeRunId!;
  const materials = readSelected(state, id, caseScope);
  const job = materials.jobs.find(item => item.runId === id);
  return job?.action === 'review' ? readDraft(materials, id, caseScope) : materials;
}

function analyzed(state = confirmed()): AgentProcessState {
  const started = unwrap(startAgentJob(state, { ...scope, action: 'analysis', discussionId: state.mainDiscussionId }));
  const read = readFormal(started.state);
  return unwrap(completeAgentJob(read, { ...scope, runId: started.state.activeRunId!, artifact: analysisArtifact })).state;
}

function strategyChosen(state = analyzed(), strategyId = 's2'): AgentProcessState {
  return unwrap(selectStrategy(state, { ...scope, strategyId })).state;
}

const draftArtifact: DraftingArtifact = {
  kind: 'draft',
  body: '尊敬的审查员：\n本申请意见陈述如下。',
  amendmentText: '1. 一种装置，其特征在于还包括限位件。',
  amendmentBasis: '限位件记载于说明书第0018段。',
  reviewNotes: '对比文件全文已核。',
  strategyId: 's2',
};

function drafted(state = strategyChosen()): { state: AgentProcessState; versionId: string } {
  const started = unwrap(startAgentJob(state, { ...scope, action: 'draft', discussionId: state.mainDiscussionId, strategyId: 's2' }));
  const completed = unwrap(completeAgentJob(readFormal(started.state), { ...scope, runId: started.state.activeRunId!, artifact: draftArtifact }));
  const versionId = completed.value as { versionId: string };
  return { state: completed.state, versionId: versionId.versionId };
}

function adopted(state = drafted()): AgentProcessState {
  const pending = state.state.drafts.at(-1)!;
  return unwrap(adoptDraft(state.state, { ...scope, versionId: pending.id })).state;
}

test('修订携带当前版本公开复核意见，旧版本与独立复核不混入', () => {
  const live = adopted();
  const disc = unwrap(openReviewDiscussion(live, { ...scope, draftVersionId: live.currentDraftVersionId! }));
  const run = unwrap(startAgentJob(disc.state, { ...scope, action: 'review', discussionId: disc.value!.discussionId, draftVersionId: live.currentDraftVersionId! }));
  const reviewed = unwrap(completeAgentJob(readFormal(run.state), { ...scope, runId: run.state.activeRunId!, artifact: {
    kind: 'review', draftVersionId: live.currentDraftVersionId!, summary: '公开复核标记 REVIEW-47',
    issues: [{ id: 'i47', severity: 'warning', finding: '原文位置不足', basis: '说明书第4段', suggestion: '补足段落号' }],
  } })).state;
  const revised = unwrap(startAgentJob(reviewed, { ...scope, action: 'revise', discussionId: reviewed.mainDiscussionId }));
  assert.equal(revised.promptContext?.reviewFeedback?.draftVersionId, live.currentDraftVersionId);
  assert.equal(revised.promptContext?.reviewFeedback?.issues[0].suggestion, '补足段落号');
  const prompt = buildAgentPrompt({ ...revised.promptContext!, rulesRoot });
  assert.ok(prompt.ok);
  if (prompt.ok) assert.match(prompt.value.task, /REVIEW-47/);
  const edited = unwrap(recordUserDraft(reviewed, { ...scope, text: '新版本正文' })).state;
  const editRun = unwrap(startAgentJob(edited, { ...scope, action: 'revise', discussionId: edited.mainDiscussionId, userMessage: '核对新稿' }));
  assert.equal(editRun.promptContext?.reviewFeedback, undefined);
  const isolated = buildAgentPrompt({ ...revised.promptContext!, stage: 'review', rulesRoot });
  assert.ok(isolated.ok);
  if (isolated.ok) assert.equal(isolated.value.task.includes('REVIEW-47'), false);
});

test('未确认材料不能分析，勾选未就绪同样拒绝', () => {
  const raw = created();
  const blocked = startAgentJob(raw, { ...scope, action: 'analysis', discussionId: raw.mainDiscussionId });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.code, 'MATERIALS_NOT_CONFIRMED');
    assert.equal(blocked.error, AgentErrors.MATERIALS_NOT_CONFIRMED);
  }
  const notReady = created();
  notReady.materials[0].ready = false;
  const confirmedNotReady = unwrap(confirmMaterials(notReady, { ...scope, selectedIds: ['n1', 'a1'] }));
  assert.equal(confirmedNotReady.state.materialsConfirmed, false);
  const blockedReady = startAgentJob(confirmedNotReady.state, { ...scope, action: 'analysis', discussionId: confirmedNotReady.state.mainDiscussionId });
  assert.equal(blockedReady.ok, false);
  if (!blockedReady.ok) assert.ok(blockedReady.code === 'MATERIALS_NOT_READY' || blockedReady.code === 'MATERIALS_NOT_CONFIRMED');
});

test('分析不产生稿件，模型声称已选定不能授权起草', () => {
  const state = analyzed();
  assert.equal(state.stage, 'strategy');
  assert.equal(state.drafts.length, 0);
  assert.equal(state.userSelectedStrategyId, null);
  assert.equal(state.currentDraftVersionId, null);
  const premature = startAgentJob(state, { ...scope, action: 'draft', discussionId: state.mainDiscussionId });
  assert.equal(premature.ok, false);
  if (!premature.ok) {
    assert.equal(premature.code, 'STRATEGY_NOT_SELECTED');
    assert.match(premature.error, /模型声称已选定不构成授权/);
  }
  const invalid = selectStrategy(state, { ...scope, strategyId: 'model-picked' });
  assert.equal(invalid.ok, false);
});

test('过期 run 与错误 scope 均拒绝，取消或失败不推进阶段', () => {
  const ready = confirmed();
  const started = unwrap(startAgentJob(ready, { ...scope, action: 'analysis', discussionId: ready.mainDiscussionId }));
  const runId = started.state.activeRunId!;
  assert.equal(started.promptContext?.stage, 'analysis');
  assert.equal(started.hostGuards.some(item => item.kind === 'scope-freeze'), true);
  const wrongScope = completeAgentJob(started.state, { caseId: 'other', processKey: 'p1', runId, artifact: analysisArtifact });
  assert.equal(wrongScope.ok, false);
  if (!wrongScope.ok) assert.equal(wrongScope.code, 'WRONG_SCOPE');
  const stopped = unwrap(stopAgentJob(started.state, { ...scope, runId }));
  assert.equal(stopped.state.stage, 'materials');
  assert.equal(stopped.state.analysis, null);
  assert.equal(stopped.state.activeRunId, null);
  const stale = completeAgentJob(stopped.state, { ...scope, runId, artifact: analysisArtifact });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.ok(stale.code === 'STALE_RUN' || stale.code === 'JOB_NOT_RUNNING');
  const again = unwrap(startAgentJob(stopped.state, { ...scope, action: 'analysis', discussionId: stopped.state.mainDiscussionId }));
  const failed = unwrap(failAgentJob(again.state, { ...scope, runId: again.state.activeRunId!, error: '模型中断' }));
  assert.equal(failed.state.stage, 'materials');
  assert.equal(failed.state.analysis, null);
});

test('重开只把进行中任务标为已停止，不自动继续', () => {
  const ready = confirmed();
  const started = unwrap(startAgentJob(ready, { ...scope, action: 'analysis', discussionId: ready.mainDiscussionId }));
  const reopened = unwrap(markStoppedOnReopen(started.state, scope));
  assert.equal(reopened.state.activeRunId, null);
  assert.equal(reopened.state.jobs[0].state, 'stopped');
  assert.equal(reopened.state.stage, 'materials');
  assert.equal(reopened.state.jobs.length, 1);
});

test('同轮多个讨论隔离，讨论完成不跨阶段', () => {
  const state = strategyChosen();
  const second = unwrap(openDiscussion(state, { ...scope, title: '补充讨论' }));
  const a = unwrap(startAgentJob(second.state, {
    ...scope, action: 'discuss', discussionId: state.mainDiscussionId, userMessage: '主讨论问题',
  }));
  const afterA = unwrap(completeAgentJob(a.state, {
    ...scope, runId: a.state.activeRunId!, artifact: { kind: 'discuss', reply: '主讨论回复' },
  }));
  const b = unwrap(startAgentJob(afterA.state, {
    ...scope, action: 'discuss', discussionId: second.value!.discussionId, userMessage: '另一讨论问题',
  }));
  const afterB = unwrap(completeAgentJob(b.state, {
    ...scope, runId: b.state.activeRunId!, artifact: { kind: 'discuss', reply: '另一讨论回复' },
  }));
  const main = afterB.state.discussions.find(item => item.id === state.mainDiscussionId)!;
  const other = afterB.state.discussions.find(item => item.id === second.value!.discussionId)!;
  assert.equal(afterB.state.stage, state.stage); // Discussion must preserve the already-selected drafting stage.
  assert.equal(afterB.state.drafts.length, 0);
  assert.ok(main.messages.some(item => item.text === '主讨论问题'));
  assert.ok(main.messages.some(item => item.text.includes('主讨论回复')));
  assert.equal(other.messages.some(item => item.text.includes('主讨论回复')), false);
  assert.ok(other.messages.some(item => item.text.includes('另一讨论回复')));
});

test('初稿形成独立待采用版本，不覆盖已有用户稿', () => {
  const withUser = unwrap(recordUserDraft(strategyChosen(), { ...scope, text: '用户正在写的稿' }));
  const current = withUser.state.currentDraftVersionId;
  const started = unwrap(startAgentJob(withUser.state, { ...scope, action: 'draft', discussionId: withUser.state.mainDiscussionId, strategyId: 's2' }));
  const done = unwrap(completeAgentJob(readFormal(started.state), { ...scope, runId: started.state.activeRunId!, artifact: draftArtifact }));
  assert.equal(done.state.currentDraftVersionId, current);
  assert.equal(done.state.drafts.filter(item => item.adoptStatus === 'pending').length, 1);
  assert.equal(done.state.drafts.find(item => item.id === current)?.text, '用户正在写的稿');
  const conflict = adoptDraft(done.state, {
    ...scope,
    versionId: done.state.drafts.find(item => item.adoptStatus === 'pending')!.id,
    sharedDraftHash: 'new-hash',
    expectedSharedDraftHash: 'old-hash',
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, 'ADOPT_CONFLICT');
  assert.equal(done.state.currentDraftVersionId, current);
});

test('独立复核绑定版本并使用单独讨论；编辑后旧复核不能定稿', () => {
  const live = adopted();
  const onMain = startAgentJob(live, {
    ...scope, action: 'review', discussionId: live.mainDiscussionId, draftVersionId: live.currentDraftVersionId!,
  });
  assert.equal(onMain.ok, false);
  if (!onMain.ok) assert.equal(onMain.code, 'DISCUSSION_KIND');
  const reviewDisc = unwrap(openReviewDiscussion(live, {
    ...scope, draftVersionId: live.currentDraftVersionId!, parentDiscussionId: live.mainDiscussionId,
  }));
  const started = unwrap(startAgentJob(reviewDisc.state, {
    ...scope,
    action: 'review',
    discussionId: reviewDisc.value!.discussionId,
    draftVersionId: live.currentDraftVersionId!,
  }));
  assert.equal(started.promptContext?.draftVersion?.id, live.currentDraftVersionId);
  const tool = readFormal(started.state);
  const reviewArtifact: ReviewArtifact = {
    kind: 'review',
    draftVersionId: live.currentDraftVersionId!,
    summary: '权利要求修改依据需再核一段落。',
    issues: [{ id: 'i1', severity: 'warning', finding: '修改依据定位不足', basis: '申请.docx', suggestion: '补说明书段落号' }],
  };
  const reviewed = unwrap(completeAgentJob(tool, { ...scope, runId: started.state.activeRunId!, artifact: reviewArtifact }));
  assert.equal(reviewed.state.stage, 'review');
  assert.equal(finalizeProcess(reviewed.state, scope).ok, true);
  const handled = unwrap(confirmReviewIssuesHandled(reviewed.state, { ...scope, reviewId: currentReview(reviewed.state)!.id, issueIds: ['i1'] }));
  assert.equal(finalizeProcess(handled.state, scope).ok, true);
  const edited = unwrap(recordUserDraft(handled.state, { ...scope, text: handled.state.drafts.at(-1)!.text + '\n人工改了一句' }));
  assert.equal(edited.state.reviews.every(item => item.invalidated), true);
  const blocked = finalizeProcess(edited.state, scope);
  assert.equal(blocked.ok, true);
});

test('无问题复核后由用户定稿，保留文本与时间且不声称 Word 已生成', () => {
  const live = adopted();
  const reviewDisc = unwrap(openReviewDiscussion(live, { ...scope, draftVersionId: live.currentDraftVersionId! }));
  const started = unwrap(startAgentJob(reviewDisc.state, {
    ...scope, action: 'review', discussionId: reviewDisc.value!.discussionId, draftVersionId: live.currentDraftVersionId!,
  }));
  const reviewed = unwrap(completeAgentJob(readFormal(started.state), {
    ...scope,
    runId: started.state.activeRunId!,
    artifact: { kind: 'review', draftVersionId: live.currentDraftVersionId!, summary: '未见必须处理的问题。', issues: [] },
  }));
  const at = '2026-09-12T08:00:00.000Z';
  const finalized = unwrap(finalizeProcess(reviewed.state, { ...scope, at }));
  assert.equal(finalized.state.stage, 'final');
  assert.equal(finalized.state.finalized?.text, live.drafts.find(item => item.id === live.currentDraftVersionId)?.text);
  assert.equal(finalized.state.finalized?.at, at);
  assert.equal(finalized.state.finalized?.word.generated, false);
  assert.equal(finalized.state.finalized?.word.message, WORD_NOT_CONNECTED);
  assert.equal(finalized.state.finalizeHistory.length, 1);
  assert.equal(finalized.state.discussions.length >= 2, true);
  assert.equal(finalizeProcess(finalized.state, scope).ok, false);
  assert.equal(startAgentJob(finalized.state, { ...scope, action: 'analysis', discussionId: live.mainDiscussionId }).ok, false);
  const talk = startAgentJob(finalized.state, { ...scope, action: 'discuss', discussionId: live.mainDiscussionId, userMessage: '定稿后仍可本机讨论' });
  assert.equal(talk.ok, true);
});

test('同案进行中任务互斥，不同案件可以并行且消息不串', () => {
  const one = upsertProcess(emptyAgentBook(), confirmed());
  const other = unwrap(createAgentProcess({
    caseId: 'c2', processKey: 'p2', classification: firstInvention, materials: materials(),
  }));
  const confirmedOther = unwrap(confirmMaterials(other.state, { caseId: 'c2', processKey: 'p2', selectedIds: ['n1', 'a1'] }));
  let book = upsertProcess(one, confirmedOther.state);
  const first = startAgentJobInBook(book, { caseId: 'c1', processKey: 'p1', action: 'analysis', discussionId: book.processes[0].mainDiscussionId });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  book = first.book;
  const sameCase = startAgentJobInBook(book, { caseId: 'c1', processKey: 'p1', action: 'discuss', discussionId: book.processes[0].mainDiscussionId, userMessage: '插话' });
  assert.equal(sameCase.ok, false);
  if (!sameCase.ok) assert.equal(sameCase.code, 'CASE_BUSY');
  const parallel = startAgentJobInBook(book, { caseId: 'c2', processKey: 'p2', action: 'analysis', discussionId: confirmedOther.state.mainDiscussionId });
  assert.equal(parallel.ok, true);
  if (!parallel.ok) return;
  const c1 = parallel.book.processes.find(item => item.scope.caseId === 'c1')!;
  const c2 = parallel.book.processes.find(item => item.scope.caseId === 'c2')!;
  assert.equal(c1.activeRunId, first.state.activeRunId);
  assert.notEqual(c2.activeRunId, c1.activeRunId);
  assert.equal(c2.discussions[0].messages.length, 0);
});

function promptOf(over: Partial<Parameters<typeof buildAgentPrompt>[0]>) {
  const result = buildAgentPrompt({
    stage: 'analysis',
    patentType: '发明',
    noticeCategory: '审查意见通知书',
    officeActionRound: 1,
    correctionBasis: 'original',
    materialManifestRefs: [{ name: '通知.pdf', role: '当前通知', relativePath: '01_通知与材料/通知.pdf', hash: 'h-notice' }],
    rulesRoot,
    ...over,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

test('规则按首通、二通、后续和补正组合，分析阶段不得提前起草', () => {
  const first = promptOf({ officeActionRound: 1 });
  const second = promptOf({ officeActionRound: 2, correctionBasis: 'round_1' });
  const later = promptOf({ officeActionRound: 5, correctionBasis: 'round_4' });
  const utility = promptOf({ patentType: '实用新型' });
  const correction = promptOf({ noticeCategory: '补正通知书', officeActionRound: 1, correctionBasis: 'original' });
  assert.ok(first.includedResources.includes('ai_reply_first_office_action_prompt.md'));
  assert.ok(first.combined.includes('第一次意见陈述书'));
  assert.ok(first.combined.includes('避免在首次答复中不必要地大幅缩小保护范围'));
  assert.ok(first.combined.includes('对比文件1、对比文件2'));
  assert.ok(first.combined.includes('## 二、总体目标'));
  assert.ok(first.combined.includes('## 三、输入材料'));
  assert.ok(first.combined.includes('原始申请文件'));
  assert.ok(first.combined.includes('二次寻优'));
  assert.ok(first.combined.includes('技术特征'));
  assert.equal(first.combined.includes('必须在内部完成以下工作，但最终输出不得展示内部分析过程'), false);
  assert.ok(first.combined.includes('可供用户选择') || first.combined.includes('用户选定'));
  assert.equal(first.combined.includes('第一部分：《意见陈述书》核心正文'), false);
  assert.ok(first.combined.includes('当前阶段是意见分析，不是起草'));
  assert.ok(first.combined.includes('模型给出的推荐不等于用户授权'));
  assert.ok(first.combined.includes('"kind":"analysis"') || first.combined.includes('"kind": "analysis"'));
  assert.equal(first.combined.includes('/Users/'), false);
  assert.ok(second.combined.includes('第二次意见陈述书'));
  assert.ok(second.combined.includes('第一次修改后申请文件'));
  assert.equal(second.includedResources.includes('ai_reply_first_office_action_prompt.md'), false);
  assert.ok(later.combined.includes('以第4次审查意见后的修改稿为直接基线'));
  assert.equal(later.combined.includes( '优先使用第二次修改后申请文件；第一轮材料用于核对修改轨迹和避免前后矛盾。'), false);
  assert.ok(utility.combined.includes('只保护产品的形状、构造或者其结合'));
  assert.equal(utility.combined.includes('对比文件1、对比文件2'), false);
  assert.ok(correction.combined.includes('补正书/补正说明'));
  assert.ok(correction.combined.includes('不主动扩展到通知书未提出的新颖性、创造性'));
  assert.equal(correction.combined.includes('### 1. 实用新型审查意见'), false);
  assert.equal(correction.combined.includes('### 2. 发明审查意见'), false);
  const analysisWithDraft = buildAgentPrompt({
    stage: 'analysis',
    patentType: '发明',
    noticeCategory: '审查意见通知书',
    officeActionRound: 1,
    correctionBasis: 'original',
    materialManifestRefs: [],
    draftVersion: { id: 'v1', text: '稿' },
    rulesRoot,
  });
  assert.equal(analysisWithDraft.ok, false);
});

test('起草与复核提示分离正文依据，复核不附分析推理且修改不自动换策略', () => {
  const strategy = analysisArtifact.strategies[1];
  const draft = promptOf({
    stage: 'draft',
    selectedStrategy: strategy,
    draftVersion: { id: 'dv1', text: '用户当前稿' },
  });
  assert.ok(draft.combined.includes('用户已选定策略（不得擅自更换）'));
  assert.ok(draft.combined.includes(strategy.title));
  assert.ok(draft.combined.includes('amendmentBasis'));
  assert.ok(draft.combined.includes('reviewNotes'));
  assert.equal(draft.combined.includes('reviewNotes 对应内部复核说明'), false);
  assert.ok(draft.combined.includes('原文位置'));
  assert.ok(draft.combined.includes('不得覆盖或要求覆盖已有用户稿'));
  const review = promptOf({
    stage: 'review',
    selectedStrategy: strategy,
    draftVersion: { id: 'dv1', text: '待复核正文', amendmentText: '建议权利要求1', amendmentBasis: '说明书第0018段' },
  });
  assert.ok(review.combined.includes('draftVersionId：dv1'));
  assert.ok(review.combined.includes('建议修改文本'));
  assert.ok(review.combined.includes('说明书第0018段'));
  assert.ok(review.combined.includes('不要使用、引用或假设存在未提供的主讨论助手推理'));
  assert.equal(review.combined.includes(`标题：${strategy.title}`), false);
  assert.equal(review.combined.includes('## 用户已选定策略（不得擅自更换）'), false);
  assert.equal(review.combined.includes(analysisArtifact.body!), false);
  assert.ok(review.combined.includes('"kind":"review"') || review.combined.includes('"kind": "review"'));
  const revise = promptOf({
    stage: 'revise',
    selectedStrategy: strategy,
    draftVersion: { id: 'dv1', text: '待改正文' },
    userMessage: '请按复核意见补段落号，不要改策略。',
  });
  assert.ok(revise.combined.includes('不得自动更换用户已选定策略'));
  assert.ok(revise.combined.includes('请按复核意见补段落号'));
  const abs = buildAgentPrompt({
    stage: 'analysis',
    patentType: '发明',
    noticeCategory: '审查意见通知书',
    officeActionRound: 1,
    correctionBasis: 'original',
    materialManifestRefs: [{ name: '通知.pdf', role: '当前通知', relativePath: '/Users/someone/案件/通知.pdf' }],
    rulesRoot,
  });
  assert.equal(abs.ok, false);
  if (!abs.ok) assert.equal(abs.code, 'ABSOLUTE_PATH');
});

test('产品规则资源与 SOURCE.md 固定 SHA 一致，读取路径必须显式注入', () => {
  const loaded = loadReplyRules(rulesRoot);
  assert.equal(loaded.ok, true);
  const missing = loadReplyRules('');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /app.getAppPath/);
  assert.match(REPLY_RULES_ROOT_HINT, /app.getAppPath/);
  const noRoot = buildAgentPrompt({
    stage: 'analysis',
    patentType: '发明',
    noticeCategory: '审查意见通知书',
    officeActionRound: 1,
    correctionBasis: 'original',
    materialManifestRefs: [],
  });
  assert.equal(noRoot.ok, false);
  for (const [name, sha] of Object.entries(SOURCE_SHA)) {
    const product = createHash('sha256').update(readFileSync(path.join(rulesRoot, name))).digest('hex');
    assert.equal(product, sha, name);
  }
});

test('未分类和只读案件可以真实讨论，不能假造审查意见或改稿', () => {
  const raw = unwrap(createAgentProcess({ caseId: 'c1', processKey: 'p1', materials: materials() }));
  assert.equal(raw.state.classification.status, 'unclassified');
  const analysis = startAgentJob(raw.state, { ...scope, action: 'analysis', discussionId: raw.state.mainDiscussionId });
  assert.equal(analysis.ok, false);
  if (!analysis.ok) assert.equal(analysis.code, 'CLASSIFICATION_NOT_READY');
  const talking = unwrap(startAgentJob(raw.state, { ...scope, action: 'discuss', discussionId: raw.state.mainDiscussionId, userMessage: '这个期限怎么算' }));
  const done = unwrap(completeAgentJob(talking.state, { ...scope, runId: talking.state.activeRunId!, artifact: { kind: 'discuss', reply: '按官方期限计算。' } }));
  assert.equal(done.state.stage, 'materials');
  const discussPrompt = buildAgentPrompt({
    stage: 'discuss',
    classification: { status: 'unknown' },
    materialManifestRefs: [{ name: '交底书.docx', role: '技术交底', relativePath: '00_原始申请/交底书.docx' }],
    userMessage: '撰写进度如何',
  });
  if (!discussPrompt.ok) throw new Error(discussPrompt.error);
  assert.equal(discussPrompt.value.includedResources.length, 0);
  assert.equal(discussPrompt.value.combined.includes('第一次意见陈述书'), false);
  assert.equal(discussPrompt.value.combined.includes('## 五、答复策略'), false);
  assert.ok(discussPrompt.value.combined.includes('不得假造通知书类型'));
  const readonlyCase = created({}, 'readonly');
  const picked = unwrap(confirmMaterials(readonlyCase, { ...scope, selectedIds: ['n1'] }));
  assert.equal(startAgentJob(picked.state, { ...scope, action: 'discuss', discussionId: picked.state.mainDiscussionId, userMessage: '只读讨论' }).ok, true);
  assert.equal(startAgentJob(picked.state, { ...scope, action: 'analysis', discussionId: picked.state.mainDiscussionId }).ok, false);
  assert.equal(recordUserDraft(picked.state, { ...scope, text: '不可改稿' }).ok, false);
  const readyForLock = confirmed();
  const running = unwrap(startAgentJob(readyForLock, { ...scope, action: 'analysis', discussionId: readyForLock.mainDiscussionId }));
  const locked = updateClassification(running.state, { ...scope, classification: firstInvention });
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.equal(locked.code, 'CLASSIFICATION_LOCKED');
  const updated = unwrap(updateClassification(raw.state, { ...scope, classification: firstInvention }));
  assert.equal(updated.state.classification.status, 'classified');
});

test('复核绑定启动时版本；运行中可改用户稿，生成稿 basedOn 仍为冻结基线', () => {
  const live = adopted();
  const reviewDisc = unwrap(openReviewDiscussion(live, { ...scope, draftVersionId: live.currentDraftVersionId! }));
  const reviewing = unwrap(startAgentJob(reviewDisc.state, {
    ...scope, action: 'review', discussionId: reviewDisc.value!.discussionId, draftVersionId: live.currentDraftVersionId!,
  }));
  assert.equal(reviewing.state.jobs.at(-1)?.boundDraftVersionId, live.currentDraftVersionId);
  const edited = unwrap(recordUserDraft(reviewing.state, { ...scope, text: '复核期间用户改稿' }));
  assert.equal(edited.state.activeRunId, reviewing.state.activeRunId);
  const reviewed = unwrap(completeAgentJob(readFormal(edited.state), {
    ...scope,
    runId: edited.state.activeRunId!,
    artifact: { kind: 'review', draftVersionId: live.currentDraftVersionId!, summary: '针对旧版本', issues: [] },
  }));
  const stored = reviewed.state.reviews.at(-1)!;
  assert.equal(stored.draftVersionId, live.currentDraftVersionId);
  assert.equal(stored.invalidated, true);
  assert.notEqual(reviewed.state.stage, 'review');
  assert.equal(finalizeProcess(reviewed.state, scope).ok, true);

  const chosen = strategyChosen();
  const user = unwrap(recordUserDraft(chosen, { ...scope, text: '启动前用户稿' }));
  const started = unwrap(startAgentJob(user.state, { ...scope, action: 'draft', discussionId: user.state.mainDiscussionId, strategyId: 's2' }));
  const frozen = started.state.jobs.at(-1)?.baseDraftVersionId;
  assert.equal(frozen, user.state.currentDraftVersionId);
  const during = unwrap(recordUserDraft(started.state, { ...scope, text: '运行中又改了一版' }));
  const generated = unwrap(completeAgentJob(readFormal(during.state), { ...scope, runId: during.state.activeRunId!, artifact: draftArtifact }));
  const pending = generated.state.drafts.find(item => item.adoptStatus === 'pending')!;
  assert.equal(pending.basedOnVersionId, frozen);
  assert.notEqual(pending.basedOnVersionId, generated.state.currentDraftVersionId);
  assert.equal(generated.state.drafts.some(item => item.text === '启动前用户稿'), true);
});

test('复核问题可逐项保存；换策略解除当前稿候选且不能拿旧策略稿定稿', () => {
  const live = adopted();
  const reviewDisc = unwrap(openReviewDiscussion(live, { ...scope, draftVersionId: live.currentDraftVersionId! }));
  const started = unwrap(startAgentJob(reviewDisc.state, {
    ...scope, action: 'review', discussionId: reviewDisc.value!.discussionId, draftVersionId: live.currentDraftVersionId!,
  }));
  const reviewed = unwrap(completeAgentJob(readFormal(started.state), {
    ...scope,
    runId: started.state.activeRunId!,
    artifact: {
      kind: 'review',
      draftVersionId: live.currentDraftVersionId!,
      summary: '两项问题',
      issues: [
        { id: 'i1', severity: 'error', finding: '依据不足', basis: '申请.docx', suggestion: '补段落' },
        { id: 'i2', severity: 'warning', finding: '术语不一致', basis: '通知.pdf', suggestion: '统一用语' },
      ],
    },
  }));
  const reviewId = currentReview(reviewed.state)!.id;
  const partial = unwrap(confirmReviewIssuesHandled(reviewed.state, { ...scope, reviewId, issueIds: ['i1'] }));
  assert.equal(partial.state.reviews.find(item => item.id === reviewId)!.issues.find(item => item.id === 'i1')!.handled, true);
  assert.equal(partial.state.reviews.find(item => item.id === reviewId)!.issues.find(item => item.id === 'i2')!.handled, false);
  assert.equal(finalizeProcess(partial.state, scope).ok, true);
  const rest = unwrap(confirmReviewIssuesHandled(partial.state, { ...scope, reviewId, issueIds: ['i2'] }));
  assert.equal(finalizeProcess(rest.state, scope).ok, true);

  const switched = unwrap(selectStrategy(rest.state, { ...scope, strategyId: 's1' }));
  assert.equal(switched.state.currentDraftVersionId, null);
  assert.ok(switched.state.drafts.length >= 1);
  assert.equal(finalizeProcess(switched.state, scope).ok, false);
  const reuse = adoptDraft(switched.state, { ...scope, versionId: rest.state.currentDraftVersionId! });
  assert.equal(reuse.ok, false);
  if (!reuse.ok) assert.equal(reuse.code, 'STRATEGY_INVALID');
});

test('分类或材料变更使旧分析复核失效；相同确认不重置；允许在已有人工稿后重新分析', () => {
  const live = adopted();
  const reviewDisc = unwrap(openReviewDiscussion(live, { ...scope, draftVersionId: live.currentDraftVersionId! }));
  const started = unwrap(startAgentJob(reviewDisc.state, {
    ...scope, action: 'review', discussionId: reviewDisc.value!.discussionId, draftVersionId: live.currentDraftVersionId!,
  }));
  const reviewed = unwrap(completeAgentJob(readFormal(started.state), {
    ...scope,
    runId: started.state.activeRunId!,
    artifact: { kind: 'review', draftVersionId: live.currentDraftVersionId!, summary: 'ok', issues: [] },
  }));
  const same = unwrap(confirmMaterials(reviewed.state, { ...scope, selectedIds: ['n1', 'a1'] }));
  assert.equal(same.state.analysis?.runId, reviewed.state.analysis?.runId);
  assert.equal(same.state.reviews[0].invalidated, false);
  const changed = unwrap(confirmMaterials(reviewed.state, { ...scope, selectedIds: ['n1'] }));
  assert.equal(changed.state.analysis, null);
  assert.equal(changed.state.analysisHistory.length >= 1, true);
  assert.equal(changed.state.userSelectedStrategyId, null);
  assert.equal(changed.state.reviews.every(item => item.invalidated), true);
  assert.ok(changed.state.drafts.length >= 1);
  const classified = unwrap(updateClassification(analyzed(), { ...scope, classification: { ...firstInvention, officeActionRound: 2, correctionBasis: 'round_1' } }));
  assert.equal(classified.state.analysis, null);
  assert.ok(classified.state.analysisHistory.length >= 1);
  const again = unwrap(updateClassification(analyzed(), { ...scope, classification: firstInvention }));
  assert.equal(again.state.analysis?.strategies.length, 2);
  const withDrafts = unwrap(recordUserDraft(strategyChosen(), { ...scope, text: '人工稿仍在' }));
  const reanalyze = unwrap(startAgentJob(withDrafts.state, { ...scope, action: 'analysis', discussionId: withDrafts.state.mainDiscussionId }));
  const done = unwrap(completeAgentJob(readFormal(reanalyze.state), { ...scope, runId: reanalyze.state.activeRunId!, artifact: analysisArtifact }));
  assert.equal(done.state.userSelectedStrategyId, null);
  assert.ok(done.state.drafts.some(item => item.text === '人工稿仍在'));
  const staleDraft = startAgentJob(changed.state, { ...scope, action: 'draft', discussionId: changed.state.mainDiscussionId, strategyId: 's2' });
  assert.equal(staleDraft.ok, false);
  const readonlyPick = unwrap(confirmMaterials(created({}, 'readonly'), { ...scope, selectedIds: ['n1'] }));
  assert.equal(readonlyPick.state.materialsConfirmed, false);
});

test('正式分析/复核不能仅凭模型自述完成，必须有当次材料的成功 read', () => {
  const ready = confirmed();
  const started = unwrap(startAgentJob(ready, { ...scope, action: 'analysis', discussionId: ready.mainDiscussionId }));
  const claimed = completeAgentJob(started.state, { ...scope, runId: started.state.activeRunId!, artifact: analysisArtifact });
  assert.equal(claimed.ok, false);
  if (!claimed.ok) {
    assert.equal(claimed.code, 'MATERIALS_UNREAD');
    assert.equal(missingFormalReads(started.state, started.state.activeRunId!)?.code, 'MATERIALS_UNREAD');
  }
  const partial = unwrap(recordToolEvent(started.state, {
    ...scope, runId: started.state.activeRunId!, filename: '通知.pdf', status: 'ok',
  }));
  const stillMissing = completeAgentJob(partial.state, { ...scope, runId: started.state.activeRunId!, artifact: analysisArtifact });
  assert.equal(stillMissing.ok, false);
  if (!stillMissing.ok) assert.equal(stillMissing.code, 'MATERIALS_UNREAD');
  const read = readSelected(started.state);
  assert.equal(completeAgentJob(read, { ...scope, runId: started.state.activeRunId!, artifact: analysisArtifact }).ok, true);

  const live = adopted();
  const reviewDisc = unwrap(openReviewDiscussion(live, { ...scope, draftVersionId: live.currentDraftVersionId! }));
  const reviewing = unwrap(startAgentJob(reviewDisc.state, {
    ...scope, action: 'review', discussionId: reviewDisc.value!.discussionId, draftVersionId: live.currentDraftVersionId!,
  }));
  const reviewBare = completeAgentJob(reviewing.state, {
    ...scope,
    runId: reviewing.state.activeRunId!,
    artifact: { kind: 'review', draftVersionId: live.currentDraftVersionId!, summary: '我已阅读全部材料。', issues: [] },
  });
  assert.equal(reviewBare.ok, false);
  if (!reviewBare.ok) assert.equal(reviewBare.code, 'MATERIALS_UNREAD');
  assert.equal(completeAgentJob(readFormal(reviewing.state), {
    ...scope,
    runId: reviewing.state.activeRunId!,
    artifact: { kind: 'review', draftVersionId: live.currentDraftVersionId!, summary: '未见必须处理的问题。', issues: [] },
  }).ok, true);

  const materialsOnly = readSelected(reviewing.state);
  const noDraft = completeAgentJob(materialsOnly, {
    ...scope,
    runId: reviewing.state.activeRunId!,
    artifact: { kind: 'review', draftVersionId: live.currentDraftVersionId!, summary: '已读材料未读稿。', issues: [] },
  });
  assert.equal(noDraft.ok, false);
  if (!noDraft.ok) assert.equal(noDraft.code, 'MATERIALS_UNREAD');
});

test('同名材料必须靠 materialId 区分；write_artifact 不算已读', () => {
  const twin = unwrap(createAgentProcess({
    ...scope,
    classification: firstInvention,
    materials: [
      { id: 'n1', name: '通知.pdf', role: '当前通知', relativePath: '01_通知与材料/通知.pdf', hash: 'h1', ready: true },
      { id: 'n2', name: '通知.pdf', role: '对比文件', relativePath: '01_通知与材料/对比通知.pdf', hash: 'h2', ready: true },
    ],
  })).state;
  const picked = unwrap(confirmMaterials(twin, { ...scope, selectedIds: ['n1', 'n2'] })).state;
  const started = unwrap(startAgentJob(picked, { ...scope, action: 'analysis', discussionId: picked.mainDiscussionId }));
  const oneName = unwrap(recordToolEvent(started.state, {
    ...scope, runId: started.state.activeRunId!, filename: '通知.pdf', status: 'ok', materialId: 'n1', toolKind: 'read_material',
  }));
  assert.equal(completeAgentJob(oneName.state, { ...scope, runId: started.state.activeRunId!, artifact: analysisArtifact }).ok, false);
  const written = unwrap(recordToolEvent(oneName.state, {
    ...scope, runId: started.state.activeRunId!, filename: 'result.json', status: 'ok', toolKind: 'write_artifact',
  }));
  assert.equal(completeAgentJob(written.state, { ...scope, runId: started.state.activeRunId!, artifact: analysisArtifact }).ok, false);
  const both = unwrap(recordToolEvent(oneName.state, {
    ...scope, runId: started.state.activeRunId!, filename: '通知.pdf', status: 'ok', materialId: 'n2', toolKind: 'read_material',
  }));
  assert.equal(completeAgentJob(both.state, { ...scope, runId: started.state.activeRunId!, artifact: analysisArtifact }).ok, true);
});


test('命令和复制不算已读，工具转换结果关联来源后可完成正式分析', () => {
  const initial=unwrap(createAgentProcess({...scope,classification:firstInvention,materials:[{id:'m1',name:'旧 DOC.doc',role:'当前通知',relativePath:'材料/通知.doc',hash:'h1',ready:true}]})).state;
  const picked=unwrap(confirmMaterials(initial,{...scope,selectedIds:['m1']})).state;
  let state=unwrap(startAgentJob(picked,{...scope,action:'analysis',discussionId:picked.mainDiscussionId})).state;
  for(const toolKind of ['discover_tools','prepare_material','execute_command','download_file'] as const){state=unwrap(recordToolEvent(state,{...scope,runId:state.activeRunId!,filename:toolKind,detail:'/usr/bin/textutil copied.doc',status:'ok',toolKind})).state;}
  assert.equal(completeAgentJob(state,{...scope,runId:state.activeRunId!,artifact:analysisArtifact}).ok,false);
  state=unwrap(recordToolEvent(state,{...scope,runId:state.activeRunId!,filename:'converted.docx',status:'ok',materialId:'m1',toolKind:'read_work_file'})).state;
  assert.equal(completeAgentJob(state,{...scope,runId:state.activeRunId!,artifact:analysisArtifact}).ok,true);
});

test('editing only full application parts invalidates review and freezes the new parts for the next review',()=>{
 const live=adopted();
 const discussion=unwrap(openReviewDiscussion(live,{...scope,draftVersionId:live.currentDraftVersionId!}));
 const started=unwrap(startAgentJob(discussion.state,{...scope,action:'review',discussionId:discussion.value!.discussionId,draftVersionId:live.currentDraftVersionId!}));
 const reviewed=unwrap(completeAgentJob(readFormal(started.state),{...scope,runId:started.state.activeRunId!,artifact:{kind:'review',draftVersionId:live.currentDraftVersionId!,summary:'已复核',issues:[]}}));
 const body=reviewed.state.drafts.at(-1)!.text;
 const edited=unwrap(recordUserDraft(reviewed.state,{...scope,text:body,applicationParts:{CLAIMS:'1. 一种新的完整权利要求。'}}));
 assert.equal(edited.state.drafts.at(-1)!.text,body);assert.notEqual(edited.state.currentDraftVersionId,live.currentDraftVersionId);
 assert.equal(edited.state.reviews[0].invalidated,true);assert.equal(finalizeProcess(edited.state,scope).ok,true);
 const next=unwrap(openReviewDiscussion(edited.state,{...scope,draftVersionId:edited.state.currentDraftVersionId!}));
 const run=unwrap(startAgentJob(next.state,{...scope,action:'review',discussionId:next.value!.discussionId,draftVersionId:edited.state.currentDraftVersionId!}));
 assert.equal(run.promptContext?.draftVersion?.applicationParts?.CLAIMS,'1. 一种新的完整权利要求。');
});


test('discussion cleanup preserves primary, messages, audit links and supports archive restore',()=>{
 let state=created();
 assert.equal(manageDiscussion(state,{...scope,discussionId:state.mainDiscussionId,operation:'delete'}).ok,false);
 state=unwrap(openDiscussion(state,scope)).state;
 const id=state.discussions.at(-1)!.id;
 assert.equal(discussionCanDelete(state,id),true);
 const removed=unwrap(manageDiscussion(state,{...scope,discussionId:id,operation:'delete'})).state;
 assert.equal(removed.discussions.length,1);assert.equal(state.discussions.length,2);
 state.discussions.at(-1)!.messages.push({id:'m',role:'user',text:'保留内容',at:'2026-09-12'});
 assert.equal(manageDiscussion(state,{...scope,discussionId:id,operation:'delete'}).ok,false);
 state=unwrap(manageDiscussion(state,{...scope,discussionId:id,operation:'archive'})).state;
 assert.equal(state.discussions.at(-1)!.archived,true);
 assert.equal(startAgentJob(state,{...scope,discussionId:id,action:'discuss',userMessage:'不可发送'}).ok,false);
 state=unwrap(manageDiscussion(state,{...scope,discussionId:id,operation:'restore'})).state;
 assert.equal(state.discussions.at(-1)!.messages[0].text,'保留内容');
 assert.equal(state.discussions.at(-1)!.archived,false);
 const running=unwrap(startAgentJob(state,{...scope,discussionId:id,action:'discuss',userMessage:'运行中'})).state;
 assert.equal(manageDiscussion(running,{...scope,discussionId:id,operation:'archive'}).ok,false);
 state=unwrap(openDiscussion(state,scope)).state;
 const parent=state.discussions.at(-1)!;
 state.discussions.push({id:'review',kind:'review',title:'复核',messages:[],toolEvents:[],parentDiscussionId:parent.id});
 assert.equal(discussionCanDelete(state,parent.id),false);
 assert.equal(manageDiscussion(state,{...scope,discussionId:'review',operation:'archive'}).ok,false);
});

test('independent review is optional, and finalizing without a report does not invent one',()=>{
 const state=adopted();assert.equal(state.reviews.length,0);
 const final=finalizeProcess(state,scope);assert.equal(final.ok,true);
 if(final.ok){assert.equal(final.state.reviews.length,0);assert.equal(final.state.finalized?.draftVersionId,state.currentDraftVersionId);}
});

test('artifactPreviewText extracts full text for all final and drafting artifact kinds', () => {
  const draft: DraftVersion = {
    id: 'd1',
    source: 'user',
    at: '2026-09-15',
    adoptStatus: 'adopted',
    text: '这是意见陈述书全文内容',
    amendmentText: '这是修改后的权利要求',
    amendmentBasis: '说明书第10-15段',
    reviewNotes: '内部核对无误',
    applicationParts: {
      CLAIMS: '1. 一种测试装置，其特征在于……',
      DESCRIPTION: '本说明书公开了一种测试装置……',
    },
    correctionContents: [
      { FileName: '权利要求书', PositionInFile: '第1项', CorrectionBefore: '原内容', CorrectionAfter: '修正内容' },
    ],
  };

  assert.equal(artifactPreviewText('final-word', draft), '这是意见陈述书全文内容');
  assert.equal(artifactPreviewText('body', draft), '这是意见陈述书全文内容');
  assert.equal(artifactPreviewText('final-body', draft), '这是意见陈述书全文内容');
  assert.equal(artifactPreviewText('final-application-CLAIMS', draft), '1. 一种测试装置，其特征在于……');
  assert.equal(artifactPreviewText('final-application-DESCRIPTION', draft), '本说明书公开了一种测试装置……');
  assert.equal(artifactPreviewText('final-amendment', draft), '这是修改后的权利要求');
  assert.equal(artifactPreviewText('final-basis', draft), '说明书第10-15段');
  assert.equal(artifactPreviewText('final-review-notes', draft), '内部核对无误');
  assert.ok(artifactPreviewText('final-correction-form', draft)?.includes('条目 1'));
  assert.ok(artifactPreviewText('final-correction-form', draft)?.includes('修正内容'));
  assert.equal(artifactPreviewText('unknown-kind', draft), undefined);
  assert.equal(artifactPreviewText('final-word', undefined), undefined);
});
