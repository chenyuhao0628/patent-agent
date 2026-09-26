import test from 'node:test';
import assert from 'node:assert/strict';
import {
  caseFromRecord,
  caseRecordFromCase,
  caseRecordRound,
  caseRecordsFromStoredWorkspace,
  sharedCaseManifestFromCase,
  caseRecordProcess,
} from './case-record.ts';
import type { Case } from './workflow.ts';

function fixture(): Case {
  return {
    id: 'case-record-1',
    title: '一种隔离装置',
    number: 'CN-REC-1',
    type: '发明',
    deadline: '2026-10-01',
    archived: false,
    tags: ['测试'],
    source: 'baseland',
    materials: [{
      id: 'common-1',
      name: '原始申请.docx',
      role: '原始申请',
      location: '本案',
      excerpt: '原始摘要',
      ready: true,
      relativePath: '00_原始申请/原始申请.docx',
    }],
    rounds: [{
      id: 'round-1',
      name: '第一次审查意见',
      stage: 'draft',
      confirmed: true,
      materials: [{
        id: 'notice-1',
        name: '通知书.pdf',
        role: '当前通知',
        location: '第 1 页',
        excerpt: '通知正文',
        ready: true,
        relativePath: '01_通知与材料/通知书.pdf',
      }],
      strategy: '解释差异',
      draft: '  用户稿件前后空白  ',
      versions: [],
      discussions: [],
      review: null,
      job: null,
      final: null,
      finalHistory: [],
    }],
    current: { kind: 'reply', roundId: 'round-1', processId: 'process-1', remoteStatus: 200 },
    remote: {
      caseId: 'remote-1',
      syncedAt: '2026-09-26T00:00:00Z',
      processes: [{
        id: 'process-1',
        name: '审查意见答复',
        status: 200,
        node: '核稿',
        undertaker: '甲',
        deadline: '2026-10-01',
        canEdit: true,
      }],
    },
    localDraft: '  用户稿件前后空白  ',
    localVersions: [{ id: 'version-1', text: '旧版本', at: '2026-09-25T00:00:00Z', processId: 'process-1' }],
    design: undefined,
  };
}

test('case records keep round workflow state separate from round materials', () => {
  const source = fixture();
  const record = caseRecordFromCase(source);

  assert.equal('materials' in record.stage.rounds[0]!, false);
  assert.deepEqual(record.materials.common.map(material => material.id), ['common-1']);
  assert.deepEqual(record.materials.rounds.map(round => round.materials.map(material => material.id)), [['notice-1']]);

  const round = caseRecordRound(record);
  assert.equal(round?.id, 'round-1');
  assert.equal(round?.materials[0]?.id, 'notice-1');
  assert.equal(record.manuscripts.localDraft, '  用户稿件前后空白  ');
  assert.equal(record.manuscripts.design, undefined);
});

test('case record roundtrip preserves drafts, stages, outcomes and transfer process identity', () => {
  const source = fixture();
  source.officialOutcome = {
    state: 'none',
    checkedAt: '2026-09-26T01:00:00Z',
    incomplete: true,
  };
  source.remoteClosure = { finished: false, checkedAt: '2026-09-26T01:00:00Z' };
  source.design = {
    writing: {
      stage: 'draft',
      disclosure: '技术交底',
      researchQuery: '',
      researched: false,
      strategy: '',
      documents: [],
      versions: [],
      finalVersionId: null,
      finalHistory: [],
    },
    review: null,
    reviewHistory: [],
    transfer: {
      selected: [],
      applicant: '申请人',
      process: '内部核稿',
      receiver: '乙',
      note: '保留',
      receipts: [{
        id: 'receipt-1',
        at: '2026-09-26T02:00:00Z',
        files: ['意见陈述书.docx'],
        receiver: '乙',
        process: '内部核稿',
        note: '请核对',
      }],
    },
  };

  const record = caseRecordFromCase(source);
  assert.notEqual(record.manuscripts.design, source.design);
  const restored = caseFromRecord(record);
  assert.equal(restored.current?.processId, 'process-1');
  assert.equal(restored.rounds[0]?.materials[0]?.relativePath, '01_通知与材料/通知书.pdf');
  assert.equal(restored.localDraft, source.localDraft);
  assert.deepEqual(restored.localVersions, source.localVersions);
  assert.deepEqual(restored.officialOutcome, source.officialOutcome);
  assert.deepEqual(restored.remoteClosure, source.remoteClosure);
  assert.deepEqual(restored.design?.transfer.receipts, source.design.transfer.receipts);

  const manifest = sharedCaseManifestFromCase(source, 'account-a');
  assert.equal(manifest.schema, 3);
  assert.equal((manifest as { profile: string }).profile, 'account-a');
  assert.ok(manifest.domains);
  assert.equal('localDraft' in manifest, false);
  assert.equal((manifest.domains as { stage: { rounds: Array<Record<string, unknown>> } }).stage.rounds[0]!.materials, undefined);
});

test('stored case records are structurally isolated from the workspace snapshot', () => {
  const record = caseRecordFromCase(fixture());
  const stored = caseRecordsFromStoredWorkspace([record]);
  assert.ok(stored);
  assert.notEqual(stored![0], record);
  stored![0]!.identity.title = '只改规范化副本';
  assert.equal(record.identity.title, '一种隔离装置');
  assert.equal(caseRecordsFromStoredWorkspace({ schema: 1, records: [] }), undefined);
});

test('canonical records reject missing linked manuscripts, duplicate identities and invalid stages', () => {
  const record = caseRecordFromCase(fixture());
  assert.equal(caseRecordsFromStoredWorkspace([{ ...record, manuscripts: { ...record.manuscripts, rounds: [] } }]), undefined);
  assert.equal(caseRecordsFromStoredWorkspace([record, record]), undefined);
  assert.equal(caseRecordsFromStoredWorkspace([{ ...record, stage: { ...record.stage, current: { kind: 'unknown' } } }]), undefined);
  const process = caseRecordProcess(record)!;
  process.name = 'mutated';
  assert.notEqual(record.transfer.processes[0].name, process.name);
});

test('compatibility adapters retain nested unknown legacy fields without a duplicate case snapshot', () => {
  const source = fixture();
  Object.assign(source.rounds[0], { futureRound: { note: 'keep' } });
  Object.assign(source.remote!, { futureRemote: { note: 'keep' } });
  const record = caseRecordFromCase(source);
  const restored = caseFromRecord(record);
  assert.equal(record.extensions?.__caseSnapshot, undefined);
  assert.deepEqual((restored.rounds[0] as unknown as Record<string, unknown>).futureRound, { note: 'keep' });
  assert.deepEqual((restored.remote as unknown as Record<string, unknown>).futureRemote, { note: 'keep' });
});
