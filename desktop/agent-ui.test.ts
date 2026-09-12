import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentProcessState, ToolEvent } from '../src/domain/agent.ts';

(globalThis as unknown as { window: { patentDesktop?: unknown } }).window = { patentDesktop: undefined };
const desktop = await import('../src/desktop.ts');

function process(over: Partial<AgentProcessState> = {}): AgentProcessState {
  return {
    scope: { caseId: 'c1', processKey: 'p1' },
    classification: { status: 'unclassified' },
    access: 'editable',
    stage: 'materials',
    materials: [
      { id: 'm1', name: '通知.pdf', role: '当前通知', ready: true, selected: true },
      { id: 'm2', name: '通知.pdf', role: '历史通知', ready: true, selected: false },
    ],
    materialsConfirmed: true,
    discussions: [
      { id: 'main', kind: 'main', title: '主讨论', messages: [], toolEvents: [] },
      { id: 'rev', kind: 'review', title: '独立复核', messages: [], toolEvents: [] },
    ],
    mainDiscussionId: 'main',
    jobs: [],
    activeRunId: null,
    analysis: null,
    analysisHistory: [],
    userSelectedStrategyId: null,
    drafts: [],
    currentDraftVersionId: null,
    reviews: [],
    finalized: null,
    finalizeHistory: [],
    ...over,
  };
}

test('local classification and material picks sync only on first load or server change', () => {
  const first = desktop.serverFormFingerprint(process());
  assert.equal(desktop.shouldInitLocalForm(undefined, first, 'classification'), true);
  assert.equal(desktop.shouldInitLocalForm(first, first, 'classification'), false);
  assert.equal(desktop.shouldInitLocalForm(first, first, 'selected'), false);
  const reclass = desktop.serverFormFingerprint(process({
    classification: { status: 'classified', patentType: '发明', noticeCategory: '审查意见通知书', officeActionRound: 1, correctionBasis: 'original' },
  }));
  assert.equal(desktop.shouldInitLocalForm(first, reclass, 'classification'), true);
  assert.equal(desktop.shouldInitLocalForm(first, reclass, 'selected'), false);
  const switched = desktop.serverFormFingerprint(process({ scope: { caseId: 'c1', processKey: 'p2' } }));
  assert.equal(desktop.shouldInitLocalForm(first, switched, 'selected'), true);
});

test('partial text stays on the active job discussion', () => {
  const state = process({
    activeRunId: 'run-1',
    jobs: [{ runId: 'run-1', discussionId: 'main', action: 'discuss', state: 'running', startedAt: '2026-01-01' }],
  });
  const view = { profileKey: 'alice', caseId: 'c1', processKey: 'p1', process: state, busy: true, partialText: 'STREAM', artifacts: [] };
  assert.equal(desktop.partialTextForDiscussion(view, 'main'), 'STREAM');
  assert.equal(desktop.partialTextForDiscussion(view, 'rev'), undefined);
  assert.equal(desktop.reviseRunDiscussionId(state), 'main');
});

test('read evidence keys off materialId and does not collapse same filenames', () => {
  const tools: ToolEvent[] = [
    { id: 't1', runId: 'r', filename: '通知.pdf', status: 'ok', at: '2026-01-01', materialId: 'm1', toolKind: 'read_material' },
    { id: 't2', runId: 'r', filename: '通知.pdf', status: 'ok', at: '2026-01-01', materialId: 'm2', toolKind: 'read_material' },
    { id: 't3', runId: 'r', filename: '定稿.txt', status: 'ok', at: '2026-01-01', materialId: 'm1', toolKind: 'write_artifact' },
  ];
  const state = process({
    discussions: [
      { id: 'main', kind: 'main', title: '主讨论', messages: [], toolEvents: tools },
    ],
  });
  const ids = desktop.materialReadIds(state);
  assert.equal(ids.has('m1'), true);
  assert.equal(ids.has('m2'), true);
  const unread = desktop.materialReadIds(process());
  assert.equal(unread.size, 0);
  assert.equal(desktop.toolEventLabel(tools[0]), '已读取材料');
  assert.equal(desktop.toolEventLabel(tools[2]), '已保存产物');
  assert.equal(desktop.toolEventLabel({ id: 'd', runId: 'r', filename: '稿.txt', status: 'ok', at: '2026-01-01', toolKind: 'read_draft' }), '已读取稿件');
});

test('non-formal discussion can pick materials even when readonly or finalized', () => {
  assert.equal(desktop.canSelectCaseMaterials({ formal: false, busy: false, access: 'readonly', finalized: true }), true);
  assert.equal(desktop.canSelectCaseMaterials({ formal: false, busy: true, access: 'readonly', finalized: false }), false);
  assert.equal(desktop.canSelectCaseMaterials({ formal: true, busy: false, access: 'readonly', finalized: false }), false);
  assert.equal(desktop.canSelectCaseMaterials({ formal: true, busy: false, access: 'editable', finalized: false }), true);
  assert.equal(desktop.canSelectCaseMaterials({ formal: true, busy: false, access: 'editable', finalized: true }), false);
});

test('late agent views from another processKey are discarded', () => {
  const expected = { profileKey: 'alice', caseId: 'c1', processKey: 'p-new' };
  const stale = { profileKey: 'alice', caseId: 'c1', processKey: 'p-old', process: process({ scope: { caseId: 'c1', processKey: 'p-old' } }), busy: true, partialText: 'OLD', artifacts: [{ id: 'a', title: '旧成果', kind: 'draft', relativePath: 'old.txt', at: '2026-01-01' }] };
  const fresh = { profileKey: 'alice', caseId: 'c1', processKey: 'p-new', process: process({ scope: { caseId: 'c1', processKey: 'p-new' } }), busy: false, artifacts: [] };
  assert.equal(desktop.shouldAcceptAgentView(stale, expected), false);
  assert.equal(desktop.shouldAcceptAgentView(fresh, expected), true);
  assert.equal(desktop.partialTextForDiscussion(stale, 'main'), undefined);
});

test('discussion job alert uses latest job on that discussion only and sanitizes secrets', () => {
  const state = process({
    jobs: [
      { runId: 'old', discussionId: 'main', action: 'discuss', state: 'failed', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', error: '旧失败' },
      { runId: 'new', discussionId: 'main', action: 'discuss', state: 'failed', startedAt: '2026-01-01T00:02:00.000Z', endedAt: '2026-01-01T00:03:00.000Z', error: 'upstream sk-secretvalue123 Authorization: Bearer abc { "model": "x", "input": "raw" }' },
      { runId: 'rev-fail', discussionId: 'rev', action: 'review', state: 'failed', startedAt: '2026-01-01T00:04:00.000Z', error: '复核失败' },
    ],
  });
  const main = desktop.latestDiscussionJob(state, 'main');
  const alert = desktop.discussionJobAlert(main);
  assert.equal(main?.runId, 'new');
  assert.equal(alert?.state, 'failed');
  assert.match(alert?.text ?? '', /任务失败/);
  assert.equal(alert?.text.includes('sk-secretvalue123'), false);
  assert.equal(alert?.text.includes('Bearer abc'), false);
  assert.equal(alert?.text.includes('"input"'), false);
  assert.equal(desktop.discussionJobAlert(desktop.latestDiscussionJob(state, 'rev'))?.text.includes('复核失败'), true);
  const running = process({
    jobs: [
      { runId: 'old', discussionId: 'main', action: 'discuss', state: 'failed', startedAt: '2026-01-01T00:00:00.000Z', error: '旧失败' },
      { runId: 'now', discussionId: 'main', action: 'discuss', state: 'running', startedAt: '2026-01-01T00:05:00.000Z' },
    ],
  });
  assert.equal(desktop.discussionJobAlert(desktop.latestDiscussionJob(running, 'main')), undefined);
  const stopped = desktop.discussionJobAlert({ runId: 's', discussionId: 'main', action: 'discuss', state: 'stopped', startedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(stopped?.state, 'stopped');
});

test('agentProcessKey matches host processId/roundId/local-kind', () => {
  assert.equal(desktop.agentProcessKey({ id: 'c', title: 't', number: 'n', type: '发明', deadline: '', archived: false, tags: [], rounds: [], current: { kind: 'reply', processId: 'proc-1' } }), 'proc-1');
  assert.equal(desktop.agentProcessKey({ id: 'c', title: 't', number: 'n', type: '发明', deadline: '', archived: false, tags: [], rounds: [{ id: 'r1', name: '第一次审查意见', confirmed: true, materials: [], versions: [], discussions: [], stage: 'draft', draft: '', strategy: null, review: null, job: null, final: null, finalHistory: [] }], current: { kind: 'reply', roundId: 'r1' } }), 'r1');
  assert.equal(desktop.agentProcessKey({ id: 'c', title: 't', number: 'n', type: '发明', deadline: '', archived: false, tags: [], rounds: [], current: { kind: 'write' } }), 'local-write');
});

test('sendAgentMessage restores text on failure', async () => {
  const view = { profileKey: 'alice', caseId: 'c1', processKey: 'p', process: process(), busy: false, artifacts: [] };
  const ok = {
    getCase: async () => view,
    command: async () => view,
    listTasks: async () => [],
    onState: () => () => undefined,
  };
  const sent = await desktop.sendAgentMessage(ok, 'alice', 'c1', '  hello  ');
  assert.equal(sent.ok, true);
  const fail = { ...ok, command: async () => { throw new Error('host down'); } };
  const lost = await desktop.sendAgentMessage(fail, 'alice', 'c1', 'keep this');
  assert.equal(lost.ok, false);
  if (!lost.ok) assert.equal(lost.restore, 'keep this');
});
