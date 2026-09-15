import test from 'node:test';
import assert from 'node:assert/strict';
import type { Case, RemoteProcess, Submission } from './workflow.ts';
import {
  INTERNAL_ENDED_WAIT_LABEL, UNVERIFIED_OFFICIAL_LABEL, WAITING_OFFICIAL_LABEL,
  isPersonalCompleteVerdict, isWaitingOfficialVerdict, localWorkflowPhase,
  stageCurrentFields, stageVerdict, stageVerdictOfProcess,
} from './stage-verdict.ts';
import { normalizeCase, caseStatus, effectiveSubmission, isConfirmedOfficialSubmission, processSubmission, stampCurrentFromStageVerdict } from './lifecycle.ts';
import { applySubmissionToCurrent } from '../../desktop/baseland.ts';
import { currentHandling } from './handling.ts';
import { isConfirmedWaitingOfficial, waitingOfficialLabel } from './library.ts';

type Row = {
  name: string;
  status?: number;
  needSendOfficial?: boolean;
  submission?: Submission;
  expect: ReturnType<typeof stageVerdict>;
  phase?: ReturnType<typeof localWorkflowPhase>;
  handId?: string;
};

const sentHand: Submission = { state: 'sent', source: 'hand', checkedAt: '2026-09-12T00:00:00.000Z', message: '已递交，等待官方处理' };
const sentSend: Submission = { state: 'sent', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z', message: '递交成功' };
const received: Submission = { state: 'received', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z', message: '已收到回执' };
const draft: Submission = { state: 'draft', source: 'hand', checkedAt: '2026-09-12T00:00:00.000Z', message: '未递交官方' };

const rows: Row[] = [
  // A1: personal complete ≠ official sent
  { name: 'A1 status 500 + needSendOfficial false + draft', status: 500, needSendOfficial: false, submission: draft, expect: 'internal-ended-wait', phase: 'unknown', handId: 'h1' },
  { name: 'A1 status 500 + needSendOfficial false + no submission', status: 500, needSendOfficial: false, expect: 'internal-ended-wait', phase: 'unknown' },
  // real send / hand → waiting official
  { name: 'hand sent is waiting-official', status: 500, needSendOfficial: false, submission: sentHand, expect: 'waiting-official', phase: 'done' },
  { name: 'send-status sent is waiting-official', status: 400, submission: sentSend, expect: 'waiting-official', phase: 'done' },
  { name: 'received is waiting-official', status: 500, submission: received, expect: 'waiting-official', phase: 'done' },
  // unverified variants
  { name: 'status 500 + needSendOfficial true', status: 500, needSendOfficial: true, expect: 'unverified-official', phase: 'unknown' },
  { name: 'status 500 + needSendOfficial undefined', status: 500, expect: 'unverified-internal', phase: 'unknown' },
  // active / pending
  { name: 'status 0 no hand → pending', status: 0, expect: 'none', phase: 'pending' },
  { name: 'status 0 with hand → working', status: 0, handId: 'h1', expect: 'none', phase: 'working' },
  { name: 'status 200 working', status: 200, expect: 'none', phase: 'working' },
  { name: 'draft at 300 is not waiting-official', status: 300, submission: draft, expect: 'none', phase: 'working' },
];

test('stageVerdict table pins current-stage / waiting-official combinations', () => {
  for (const row of rows) {
    const kind = stageVerdict({ status: row.status, submission: row.submission, needSendOfficial: row.needSendOfficial });
    assert.equal(kind, row.expect, row.name);
    if (row.phase !== undefined) {
      assert.equal(
        localWorkflowPhase({ status: row.status, submission: row.submission, needSendOfficial: row.needSendOfficial, handId: row.handId }),
        row.phase,
        `${row.name} phase`,
      );
    }
  }
});

test('waiting-official vs personal-complete helpers', () => {
  assert.equal(isWaitingOfficialVerdict('waiting-official'), true);
  assert.equal(isWaitingOfficialVerdict('internal-ended-wait'), false);
  assert.equal(isPersonalCompleteVerdict('internal-ended-wait'), true);
  assert.equal(isPersonalCompleteVerdict('unverified-official'), true);
  assert.equal(isPersonalCompleteVerdict('waiting-official'), false);
});

test('stageCurrentFields stamps align with A1 and waiting-official', () => {
  const process = { id: 'app', name: '提出申请', status: 500 };
  const ended = stageCurrentFields('internal-ended-wait', process);
  assert.equal(ended?.kind, 'waiting');
  assert.equal(ended?.party, '内部');
  assert.equal(ended?.node, INTERNAL_ENDED_WAIT_LABEL);
  assert.notEqual(ended?.party, '官方');

  const wait = stageCurrentFields('waiting-official', process);
  assert.equal(wait?.kind, 'waiting');
  assert.equal(wait?.party, '官方');
  assert.equal(wait?.node, WAITING_OFFICIAL_LABEL);
  assert.equal(wait?.label, WAITING_OFFICIAL_LABEL);

  const unverified = stageCurrentFields('unverified-official', process);
  assert.equal(unverified?.kind, 'needs-confirmation');
  assert.equal(unverified?.label, UNVERIFIED_OFFICIAL_LABEL);
  assert.equal(unverified?.node, '待核验');
});

function caseWith(process: RemoteProcess, currentKind: 'write' | 'reply' | 'waiting' = 'write'): Case {
  return {
    id: 'c', title: '合成装置', number: 'SYN-SV', type: '发明', deadline: '', archived: false, tags: [], rounds: [],
    source: 'baseland',
    current: { kind: currentKind, processId: process.id, remoteStatus: process.status, label: process.name },
    remote: { caseId: 'r', syncedAt: '', processes: [process] },
  };
}

test('normalize / sync / handling / library share the same A1 verdict', () => {
  const p: RemoteProcess = {
    id: 'app', name: '提出申请', status: 500, personalStatus: 500, needSendOfficial: false,
    node: '', undertaker: '甲', deadline: '', handId: 'h1', submission: draft,
  };
  assert.equal(stageVerdictOfProcess(p), 'internal-ended-wait');
  assert.equal(effectiveSubmission(p)?.state, 'draft');
  assert.equal(isConfirmedOfficialSubmission(effectiveSubmission(p)), false);

  const normalized = normalizeCase(caseWith(p));
  assert.equal(normalized.current?.kind, 'waiting');
  assert.equal(normalized.current?.party, '内部');
  assert.equal(normalized.current?.node, INTERNAL_ENDED_WAIT_LABEL);
  assert.doesNotMatch(caseStatus(normalized), /已提交官方|已交官方/);
  assert.equal(isConfirmedWaitingOfficial(normalized), false);
  assert.equal(waitingOfficialLabel(normalized), null);

  const synced = caseWith(structuredClone(p));
  applySubmissionToCurrent(synced, synced.remote!.processes[0]);
  assert.equal(synced.current?.party, '内部');
  assert.equal(synced.current?.node, INTERNAL_ENDED_WAIT_LABEL);
  assert.equal(isConfirmedOfficialSubmission(synced.remote!.processes[0].submission), false);

  const handling = currentHandling(caseWith(p));
  assert.equal(handling.officialWaiting, false);
  assert.equal(handling.unverified, false);
  assert.equal(handling.node, INTERNAL_ENDED_WAIT_LABEL);
  assert.equal(localWorkflowPhase({ status: 500, submission: draft, needSendOfficial: false, handId: 'h1' }), 'unknown');
});

test('real send/hand and received share waiting-official across call sites', () => {
  for (const [label, submission] of [['hand', sentHand], ['send', sentSend], ['received', received]] as const) {
    const p: RemoteProcess = {
      id: 'app', name: '提出申请', status: 500, needSendOfficial: false,
      node: '结束', undertaker: '甲', deadline: '', submission,
    };
    assert.equal(stageVerdictOfProcess(p), 'waiting-official', label);
    const normalized = normalizeCase(caseWith(p, 'reply'));
    assert.equal(normalized.current?.party, '官方');
    assert.equal(normalized.current?.node, WAITING_OFFICIAL_LABEL);
    assert.equal(isConfirmedWaitingOfficial(normalized), true);
    assert.ok(waitingOfficialLabel(normalized));
    assert.equal(currentHandling(normalized).officialWaiting, true);
    assert.equal(localWorkflowPhase({ status: 500, submission, needSendOfficial: false }), 'done');

    const synced = caseWith(structuredClone(p), 'reply');
    applySubmissionToCurrent(synced, synced.remote!.processes[0]);
    assert.equal(synced.current?.party, '官方');
    assert.equal(processSubmission(synced)?.state, submission.state);
  }
});

test('stampCurrentFromStageVerdict is the shared sync/normalize stamp', () => {
  const p: RemoteProcess = {
    id: 'app', name: '提出申请', status: 500, needSendOfficial: true,
    node: '', undertaker: '甲', deadline: '',
  };
  const current = { kind: 'write' as const, processId: 'app', remoteStatus: 500, label: '提出申请' };
  const stamped = stampCurrentFromStageVerdict(current, p);
  assert.equal(stamped?.kind, 'needs-confirmation');
  assert.equal(stamped?.label, UNVERIFIED_OFFICIAL_LABEL);
  assert.equal(stamped?.node, '待核验');
});
