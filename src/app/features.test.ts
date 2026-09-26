import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_MODULE_BY_ID, FEATURE_MODULES, featureAvailable, featureContext } from './features.ts';
import type { Case } from '../domain/workflow.ts';

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

test('desktop-only features remain unavailable outside the desktop host', () => {
  assert.equal(featureAvailable(FEATURE_MODULE_BY_ID.reply, featureContext(false), fixture()), false);
});
