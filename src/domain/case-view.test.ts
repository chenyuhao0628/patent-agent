import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCaseView } from './case-view.ts';
import type { Case } from './workflow.ts';

function fixture(overrides: Partial<Case> = {}): Case {
  return {
    id: 'case-1',
    title: '一种装置',
    number: 'CN-1',
    type: '发明',
    deadline: '2026-10-01',
    archived: false,
    tags: ['优先'],
    source: 'baseland',
    rounds: [{
      id: 'round-1',
      name: '审查意见通知',
      stage: 'draft',
      confirmed: true,
      materials: [{ id: 'm-round', name: '通知书.pdf', role: '通知', location: '第 1 页', excerpt: '', ready: true }],
      strategy: null,
      draft: '',
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
      processes: [{
        id: 'process-1',
        name: '审查意见答复',
        status: 200,
        node: '审核',
        undertaker: '甲',
        deadline: '',
        canEdit: true,
      }],
      syncedAt: '2026-09-26T00:00:00Z',
    },
    ...overrides,
  };
}

test('case projection separates identity, current stage, materials and active processes', () => {
  const view = projectCaseView(fixture({
    materials: [{ id: 'm-case', name: '原始申请.docx', role: '原始申请', location: '', excerpt: '', ready: true }],
  }));
  assert.equal(view.identity.id, 'case-1');
  assert.equal(view.identity.title, '一种装置');
  assert.equal(view.identity.number, 'CN-1');
  assert.equal(view.identity.source, 'baseland');
  assert.deepEqual(view.identity.tags, ['优先']);
  assert.equal(view.identity.deadlineView.label, '办理期限');
  assert.equal(view.stage.kind, 'reply');
  assert.equal(view.stage.module, 'reply');
  assert.equal(view.stage.editable, true);
  assert.equal(view.stage.transferAvailable, true);
  assert.deepEqual(view.materials.all.map(material => material.id), ['m-case', 'm-round']);
  assert.equal(view.transfer.activeProcesses.length, 1);
  assert.equal(view.transfer.remoteCaseId, 'remote-1');
  assert.equal(view.transfer.remoteSyncedAt, '2026-09-26T00:00:00Z');
});

test('projection uses the unified official waiting decision', () => {
  const view = projectCaseView(fixture({
    current: { kind: 'reply', roundId: 'round-1', processId: 'process-1', remoteStatus: 500 },
    remote: {
      caseId: 'remote-1',
      processes: [{
        id: 'process-1',
        name: '审查意见答复',
        status: 500,
        node: '结束',
        undertaker: '甲',
        deadline: '',
        submission: { state: 'received', checkedAt: '2026-09-26T00:00:00Z', source: 'send-status' },
      }],
      syncedAt: '2026-09-26T00:00:00Z',
    },
  }));
  assert.equal(view.stage.officialWaiting, true);
});

test('projection preserves local identity and does not invent official outcomes', () => {
  const view = projectCaseView(fixture({
    source: 'local',
    remote: undefined,
    officialOutcome: undefined,
    current: { kind: 'write' },
  }));
  assert.equal(view.identity.source, 'local');
  assert.equal(view.officialOutcome.applies, false);
  assert.equal(view.officialOutcome.view, 'unknown');
  assert.equal(view.officialOutcome.concluded, false);
  assert.equal(view.stage.transferAvailable, false);
});

test('projection keeps same material id distinct across round identities', () => {
  const base = fixture();
  const view = projectCaseView({
    ...base,
    materials: [{ id: 'same', name: '材料', role: '本案', location: '', excerpt: '', ready: true }],
    rounds: [{
      ...base.rounds[0],
      materials: [
        { id: 'same', name: '材料', role: '轮次', location: '', excerpt: '', ready: true },
        { id: 'same', name: '材料副本', role: '轮次', location: '', excerpt: '', ready: true },
      ],
    }],
  });
  assert.equal(view.materials.all.length, 3);
});

test('projection does not share mutable nested data with the case', () => {
  const source = fixture();
  const view = projectCaseView(source);
  (view.identity.tags as string[]).push('只读视图测试');
  (view.materials.all[0] as { name: string }).name = '修改后的投影视图';
  (view.transfer.activeProcesses[0] as { currentFlow?: { name: string; user: string } }).currentFlow = { name: '投影视图节点', user: '测试' };
  assert.equal('materials' in view.stage.activeRound!, false);
  assert.deepEqual(source.tags, ['优先']);
  assert.equal(source.materials, undefined);
  assert.equal(source.rounds[0]!.materials[0]!.name, '通知书.pdf');
  assert.equal(source.remote!.processes[0]!.currentFlow, undefined);
});

test('legacy cases without current/design still project a stable module view', () => {
  const view = projectCaseView(fixture({
    current: undefined,
    design: undefined,
    remote: undefined,
    source: 'local',
    localDraft: '  人工稿保留前后空白  ',
    localVersions: [{ id: 'v-1', text: '旧版本', at: '2026-09-25T00:00:00Z' }],
  }));
  assert.equal(view.stage.kind, 'reply');
  assert.equal(view.stage.activeRound?.id, 'round-1');
  assert.equal(view.manuscripts.localDraft, '  人工稿保留前后空白  ');
  assert.deepEqual(view.manuscripts.localVersions.map(version => version.id), ['v-1']);
  assert.equal(view.officialOutcome.applies, false);
  assert.equal(view.transfer.remoteSyncedAt, undefined);
});
import { caseRecordFromCase } from './case-record.ts';
import { professionalViewFromWorkspace, projectProfessionalView, projectReplyView, projectTransferView } from './case-view.ts';

test('professional selections resolve duplicate material IDs to the current round in both projections',()=>{
  const c=fixture();
  c.materials=[{...c.rounds[0].materials[0],relativePath:'common/old.pdf'}];
  c.rounds[0].materials[0].relativePath='round/current.pdf';
  for(const view of [projectProfessionalView(c),professionalViewFromWorkspace(projectCaseView(c))]){
    assert.equal(view.materials.current.length,1);
    assert.equal(view.materials.current[0].relativePath,'round/current.pdf');
    assert.equal(view.materials.current[0].roundId,'round-1');
  }
});

test('business projections do not read unrelated manuscript or transfer form payloads',()=>{
  const record=caseRecordFromCase({id:'minimal',title:'Synthetic',number:'S1',type:'invention',deadline:'',archived:false,tags:[],rounds:[],current:{kind:'write'},localDraft:'local'});
  Object.defineProperty(record.manuscripts,'design',{get(){throw new Error('unrelated design');}});
  Object.defineProperty(record.transfer,'form',{get(){throw new Error('unrelated form');}});
  const professional=projectProfessionalView(record),reply=projectReplyView(record),transfer=projectTransferView(record);
  assert.deepEqual(Object.keys(professional.manuscripts),['localDraft']);
  assert.deepEqual(Object.keys(professional.materials),['current']);
  assert.equal('design' in reply.manuscripts,false);
  assert.equal('manuscripts' in transfer,false);
  professional.identity.tags.push('not persisted');
  assert.deepEqual(record.identity.tags,[]);
});
