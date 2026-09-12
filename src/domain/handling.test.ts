import test from 'node:test';
import assert from 'node:assert/strict';
import type { Case, RemoteProcess } from './workflow.ts';
import { currentHandling, processRowHandling, OFFICIAL_WAIT_NODE, PENDING_NODE, PENDING_UNDERTAKER_NOTE } from './handling.ts';
import { UNVERIFIED_OFFICIAL_LABEL, normalizeCase } from './lifecycle.ts';

function proc(over: Partial<RemoteProcess> & Pick<RemoteProcess, 'id' | 'name'>): RemoteProcess {
  return { status: 0, node: '', undertaker: '', deadline: '', ...over };
}

function fixture(over: Partial<Case> = {}, processOver: Partial<RemoteProcess> = {}): Case {
  const process = proc({ id: 'p1', name: '第一次审查意见答复', ...processOver });
  return {
    id: 'c1', title: '合成装置', number: 'SYN-1', type: '发明', deadline: '', archived: false, tags: [],
    rounds: [], source: 'baseland',
    current: { kind: 'reply', processId: 'p1', label: '第一次审查意见答复', remoteStatus: process.status },
    remote: { caseId: 'r1', syncedAt: '', processes: [process] },
    ...over,
  };
}

test('H1 unknown status with undertaker is 待核验, waitHand pending uses 待办承办人', () => {
  const unknown = currentHandling(fixture({}, { status: -1, undertaker: '杨佳', node: '' }));
  assert.notEqual(unknown.node, PENDING_NODE);
  assert.notEqual(unknown.handlerKind, 'pending-undertaker');
  assert.equal(unknown.unverified, true);
  assert.doesNotMatch(unknown.status, /授权|驳回|整案终结/);
  const pending = currentHandling(fixture({}, { status: 0, undertaker: '杨佳', node: '' }));
  assert.equal(pending.node, PENDING_NODE);
  assert.equal(pending.handler, '杨佳');
  assert.equal(pending.handlerKind, 'pending-undertaker');
  assert.equal(pending.handlerNote, PENDING_UNDERTAKER_NOTE);
  assert.equal(pending.unverified, false);
});

test('internal CurrentFlowInfo node and user beat undertaker', () => {
  const h = currentHandling(fixture({}, {
    status: 200, undertaker: '承办人', node: '列表节点',
    currentFlow: { name: '核稿', user: '办理人', serial: 2, total: 4 },
  }));
  assert.equal(h.node, '核稿');
  assert.equal(h.handler, '办理人');
  assert.equal(h.handlerKind, 'flow-user');
  assert.notEqual(h.handler, '承办人');
});

test('sent and received are official waiting, not case end', () => {
  const sent = currentHandling(fixture({ current: { kind: 'reply', processId: 'p1' } }, {
    submission: { state: 'sent', source: 'hand', checkedAt: '2026-09-12T00:00:00.000Z' },
  }));
  assert.equal(sent.kind, 'waiting');
  assert.equal(sent.node, OFFICIAL_WAIT_NODE);
  assert.equal(sent.party, '官方');
  assert.equal(sent.officialWaiting, true);
  assert.equal(sent.showStepFraction, false);
  const received = currentHandling(normalizeCase(fixture({ current: { kind: 'reply', processId: 'p1' } }, {
    submission: { state: 'received', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z' },
  })));
  assert.equal(received.node, OFFICIAL_WAIT_NODE);
  assert.equal(received.officialWaiting, true);
  assert.match(received.status, /等待官方处理结果/);
  assert.doesNotMatch(received.status, /授权|驳回|100%/);
});

test('non-selected old receipt is 已收到回执, not 官方处理中', () => {
  const row = processRowHandling(proc({
    id: 'old', name: '答复审查意见', status: 500,
    submission: { state: 'received', checkedAt: '2026-09-12T00:00:00.000Z' },
  }), 'new');
  assert.equal(row.selected, false);
  assert.equal(row.tag, '已收到回执');
  assert.doesNotMatch(row.tag ?? '', /官方处理中/);
  const selected = processRowHandling(proc({
    id: 'old', name: '答复审查意见', status: 500,
    submission: { state: 'received', checkedAt: '2026-09-12T00:00:00.000Z' },
  }), 'old');
  assert.match(selected.tag ?? '', /官方处理中/);
});

test('H2 confirmed submission on a non-current row is not 内部办理中', () => {
  const old = proc({
    id: 'old', name: '提出申请', status: 400,
    submission: { state: 'sent', source: 'hand', checkedAt: '2026-09-01T00:00:00.000Z' },
  });
  const row = processRowHandling(old, 'oa');
  assert.equal(row.selected, false);
  assert.notEqual(row.tag, '内部办理中');
  assert.match(row.tag ?? '', /已递交/);
  const current = processRowHandling(proc({
    id: 'oa', name: '第一次审查意见答复', status: 0,
  }), 'oa');
  assert.equal(current.tag, '当前办理');
  assert.equal(current.historical, false);
});

test('completed nonfiling flow needs no forced verification', () => {
  const p = proc({ id: 'old', name: '答复审查意见', status: 500, needSendOfficial: false, submission: undefined });
  const c: Case = {
    id: 'c', title: 'test', number: 'test', type: '发明', deadline: '', tags: [], archived: false, rounds: [],
    remote: { caseId: 'c', syncedAt: '', processes: [p] },
    current: { kind: 'waiting', processId: 'old', remoteStatus: 500 },
  };
  const h = currentHandling(c);
  assert.equal(h.unverified, false);
  assert.match(h.node, /内部.*结束|等待后续/);
});

test('H3 only explicit needSendOfficial at internal 500 is 官方递交待核验', () => {
  const needed = currentHandling(fixture({ current: { kind: 'write', processId: 'p1', remoteStatus: 500 } }, {
    id: 'p1', name: '提出申请', status: 500, needSendOfficial: true,
  }));
  assert.match(needed.status, /官方递交待核验/);
  assert.equal(needed.officialWaiting, false);
  assert.doesNotMatch(needed.status, /授权|驳回/);
  const notNeeded = currentHandling(fixture({ current: { kind: 'write', processId: 'p1', remoteStatus: 500 } }, {
    id: 'p1', name: '提出申请', status: 500, needSendOfficial: false,
  }));
  assert.doesNotMatch(notNeeded.status, /官方递交待核验/);
  assert.doesNotMatch(notNeeded.status, /授权|驳回/);
  assert.equal(notNeeded.unverified, false);
  assert.match(notNeeded.node, /内部.*结束|等待后续/);
  const unknown = currentHandling(fixture({ current: { kind: 'write', processId: 'p1', remoteStatus: 500 } }, {
    id: 'p1', name: '提出申请', status: 500,
  }));
  assert.doesNotMatch(unknown.status, /官方递交待核验/);
  assert.doesNotMatch(unknown.status, /授权|驳回/);
  const normalized = normalizeCase(fixture({ current: { kind: 'write', processId: 'p1', remoteStatus: 500 } }, {
    id: 'p1', name: '提出申请', status: 500, needSendOfficial: true,
  }));
  assert.equal(normalized.current?.kind, 'needs-confirmation');
  assert.equal(normalized.current?.label, UNVERIFIED_OFFICIAL_LABEL);
});

test('IsCurrentFlowNode live node is current handling, not undertaker', () => {
  const h = currentHandling(fixture({}, { status: 200, undertaker: '承办人' }), {
    currentProcessId: 'p1',
    nodes: [
      { name: '开始', user: '甲', finished: true, isCurrent: false },
      { name: '核稿', user: '乙', finished: false, isCurrent: true, serial: 2, total: 4 },
    ],
  });
  assert.equal(h.node, '核稿');
  assert.equal(h.handler, '乙');
  assert.equal(h.handlerKind, 'flow-user');
  assert.equal(h.showStepFraction, true);
});
