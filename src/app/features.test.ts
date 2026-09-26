import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_MODULE_BY_ID, FEATURE_MODULES, featureAccess, featureAvailable, featureContext, featureContextForDesktop, featureEditable, featureVisible } from './features.ts';
import type { Case } from '../domain/workflow.ts';
import { initialDesign } from '../domain/designFlows.ts';

function fixture(overrides: Partial<Case> = {}): Case {
  return {
    id: 'case-1',
    title: '测试案件',
    number: 'CN-1',
    type: '发明',
    deadline: '',
    archived: false,
    tags: [],
    rounds: [],
    source: 'baseland',
    current: { kind: 'reply', processId: 'p-1', remoteStatus: 200 },
    remote: {
      caseId: 'remote-1',
      syncedAt: '',
      processes: [{ id: 'p-1', name: '审查意见答复', status: 200, node: '审核', undertaker: '本人', deadline: '', canEdit: true }],
    },
    ...overrides,
  };
}

test('feature registry exposes one stable descriptor per business module', () => {
  assert.deepEqual(FEATURE_MODULES.map(feature => feature.id), ['reply', 'write', 'review', 'transfer']);
  assert.equal(FEATURE_MODULE_BY_ID.reply.route, '/reply');
  assert.ok(FEATURE_MODULES.every(feature => feature.capabilities.length > 0 && feature.icon));
});

test('feature availability follows current case boundaries', () => {
  const context = featureContext(true);
  const reply = FEATURE_MODULE_BY_ID.reply;
  const transfer = FEATURE_MODULE_BY_ID.transfer;
  assert.equal(featureAvailable(reply, context, fixture()), true);
  assert.equal(featureAvailable(transfer, context, fixture()), true);
  assert.equal(featureAvailable(reply, context, fixture({ current: { kind: 'waiting', processId: 'p-1' } })), false);
  assert.equal(featureAvailable(transfer, context, fixture({ source: 'local' })), false);
  assert.equal(featureAvailable(reply, context, fixture({ archived: true })), false);
});

test('feature visibility keeps historical read-only work reachable', () => {
  const context = featureContext(true);
  const waiting = fixture({ current: { kind: 'waiting', processId: 'p-1' } });
  assert.equal(featureAvailable(FEATURE_MODULE_BY_ID.reply, context, waiting), false);
  assert.equal(featureVisible(FEATURE_MODULE_BY_ID.reply, context, waiting), true);
  assert.equal(featureVisible(FEATURE_MODULE_BY_ID.review, context, waiting), true);
  assert.equal(featureVisible(FEATURE_MODULE_BY_ID.reply, context, fixture({ archived: true })), true);
  assert.equal(featureAvailable(FEATURE_MODULE_BY_ID.reply, context, fixture({ archived: true })), false);
  assert.equal(featureEditable(FEATURE_MODULE_BY_ID.review, context, waiting), false);
  assert.equal(featureEditable(FEATURE_MODULE_BY_ID.review, context, fixture({ current: { kind: 'review' } })), true);
});

test('feature visibility keeps reply and writing history available without granting start permission', () => {
  const context = featureContext(true);
  const replyHistory = fixture({
    current: { kind: 'write' },
    rounds: [{
      id: 'old-reply',
      name: '第一次审查意见答复',
      stage: 'final',
      confirmed: true,
      materials: [],
      strategy: null,
      draft: '历史答复',
      versions: [],
      discussions: [],
      review: null,
      job: null,
      final: null,
      finalHistory: [],
    }],
  });
  assert.equal(featureVisible(FEATURE_MODULE_BY_ID.reply, context, replyHistory), true);
  assert.equal(featureAvailable(FEATURE_MODULE_BY_ID.reply, context, replyHistory), false);
  const writingHistory = initialDesign();
  writingHistory.writing.disclosure = '历史交底';
  const replyWithWritingHistory = fixture({ current: { kind: 'reply', processId: 'p-1' }, design: writingHistory });
  assert.equal(featureVisible(FEATURE_MODULE_BY_ID.write, context, replyWithWritingHistory), true);
  assert.equal(featureAvailable(FEATURE_MODULE_BY_ID.write, context, replyWithWritingHistory), false);
});

test('desktop-only features remain unavailable outside the desktop host', () => {
  assert.equal(featureAvailable(FEATURE_MODULE_BY_ID.reply, featureContext(false), fixture()), false);
});

test('capability context is derived from the injected desktop surface', () => {
  const context = featureContextForDesktop({
    agent: { getCase: async () => { throw new Error('fixture'); }, command: async () => { throw new Error('fixture'); }, listTasks: async () => [], onState: () => () => {} },
    professional: { getCase: async () => { throw new Error('fixture'); }, command: async () => { throw new Error('fixture'); }, listReviews: async () => [], pickReferences: async () => { throw new Error('fixture'); }, removeReference: async () => { throw new Error('fixture'); }, pickFiles: async () => { throw new Error('fixture'); }, openFile: async () => {}, onState: () => () => {} },
    transfer: { prepare: async () => { throw new Error('fixture'); }, save: async () => { throw new Error('fixture'); }, inspect: async () => null, pickFile: async () => { throw new Error('fixture'); }, removeFile: async () => { throw new Error('fixture'); }, clearRemote: async () => { throw new Error('fixture'); }, previewFile: async () => { throw new Error('fixture'); }, startHand: async () => { throw new Error('fixture'); }, saveLocalReview: async () => { throw new Error('fixture'); }, submit: async () => { throw new Error('fixture'); }, refresh: async () => { throw new Error('fixture'); }, reprepare: async () => { throw new Error('fixture'); }, revoke: async () => { throw new Error('fixture'); } },
  } as never);
  assert.equal(context.capabilities.has('agent.reply'), true);
  assert.equal(context.capabilities.has('transfer.save'), true);
});

test('feature access exposes one consistent visibility, start and edit decision', () => {
  const feature = FEATURE_MODULE_BY_ID.review;
  const context = featureContext(true);
  const waiting = fixture({ current: { kind: 'waiting', processId: 'p-1' } });
  assert.deepEqual(featureAccess(feature, context, waiting), {
    visible: true,
    startable: false,
    editable: false,
  });
  assert.deepEqual(featureAccess(feature, context, fixture({ current: { kind: 'review' } })), {
    visible: true,
    startable: true,
    editable: true,
  });
  const readonly = fixture({
    current: { kind: 'reply', processId: 'p-1', remoteStatus: 200 },
    remote: {
      caseId: 'remote-1',
      syncedAt: '',
      processes: [{ id: 'p-1', name: '审查意见答复', status: 200, node: '审核', undertaker: '其他人', deadline: '', canEdit: false }],
    },
  });
  assert.equal(featureAccess(FEATURE_MODULE_BY_ID.review, context, readonly).editable, false);
});
