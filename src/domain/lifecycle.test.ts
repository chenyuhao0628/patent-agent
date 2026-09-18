import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspace, updateRound } from './workflow.ts';
import type { Case, RemoteProcess } from './workflow.ts';
import { caseStatus, currentWork, editableCurrent, effectiveSubmission, historyRecords, isConfirmedOfficialSubmission, INTERNAL_ENDED_WAIT_LABEL, normalizeCase, normalizeWorkspace, processSubmission, WAITING_OFFICIAL_LABEL, workModule } from './lifecycle.ts';
import { currentHandling } from './handling.ts';
import { libraryStatus } from './library.ts';
import { initialDesign } from './designFlows.ts';
test('historical rounds cannot be started and all screens share one current business',()=>{
  const w=normalizeWorkspace(seedWorkspace()),c=w.cases[0],historical=c.rounds[1];
  const after=updateRound(w,c.id,historical.id,{type:'confirm',value:true});assert.deepEqual(after.cases[0].rounds[1],historical);
  assert.equal(currentWork(c).roundId,c.rounds[0].id);assert.equal(workModule(c),'reply');
  c.design=initialDesign();c.design.writing.disclosure='历史写作';assert.equal(workModule(c),'reply');
});
test('conflicting legacy prototype work is preserved and requires one explicit current selection',()=>{
  const c=seedWorkspace().cases[0];c.design=initialDesign();c.design.writing.disclosure='原有撰写内容';
  assert.equal(currentWork(c).kind,'needs-confirmation');
  const w=normalizeWorkspace({schema:1,cases:[c],settings:{provider:'',baseUrl:'',model:''}});
  assert.equal(w.cases[0].design?.writing.disclosure,'原有撰写内容');assert.equal(w.cases[0].rounds.length,2);
});

function remoteCase(over: Partial<Case> = {}, processOver: Partial<RemoteProcess> = {}): Case {
  const process: RemoteProcess = {
    id: 'p1', name: '第一次审查意见答复', status: 0, node: '内部', undertaker: '本人', deadline: '',
    submission: { state: 'received', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z', message: '已收到回执' },
    ...processOver,
  };
  return {
    id: 'c1', title: '合成装置', number: 'SYN-WAIT', type: '发明', deadline: '', archived: false, tags: [],
    rounds: [{
      id: 'proc-p1', name: '第一次审查意见答复', stage: 'draft', confirmed: true, materials: [],
      strategy: '维持', draft: '轮次正文', versions: [], discussions: [], review: null, job: null, final: null, finalHistory: [],
    }],
    source: 'baseland', current: { kind: 'reply', processId: 'p1', roundId: 'proc-p1', label: '第一次审查意见答复' },
    localDraft: '当前答复稿', localVersions: [],
    remote: { caseId: 'r1', syncedAt: '', processes: [process] },
    ...over,
  };
}

test('confirmed sent and receipt change current kind to waiting and keep process, round and draft', () => {
  const received = normalizeCase(remoteCase());
  assert.equal(received.current?.kind, 'waiting');
  assert.equal(received.current?.label, WAITING_OFFICIAL_LABEL);
  assert.equal(received.current?.node, WAITING_OFFICIAL_LABEL);
  assert.equal(received.current?.party, '官方');
  assert.equal(received.current?.processId, 'p1');
  assert.equal(received.current?.roundId, 'proc-p1');
  assert.equal(received.localDraft, '当前答复稿');
  assert.equal(received.localVersions?.length ?? 0, 0);
  assert.equal(received.rounds[0].draft, '轮次正文');
  assert.equal(editableCurrent(received), false);
  const sent = normalizeCase(remoteCase({}, { submission: { state: 'sent', source: 'hand', checkedAt: '2026-09-12T00:00:00.000Z', message: '已递交，等待官方处理' } }));
  assert.equal(sent.current?.kind, 'waiting');
  assert.equal(sent.current?.processId, 'p1');
  assert.equal(editableCurrent(sent), false);
});

test('waiting history remains readable without duplicating drafts or mutating stored versions', () => {
  const original = remoteCase();
  const versionsBefore = original.localVersions;
  const waiting = normalizeCase(original);
  const records = historyRecords(waiting);
  assert(records.some(r => r.id === 'round-proc-p1' && r.text.includes('轮次正文')));
  assert(records.some(r => r.id === 'current-draft' && r.text === '当前答复稿'));
  assert.equal(waiting.localVersions?.length ?? 0, 0);
  assert.equal(original.localVersions, versionsBefore);
  const duplicateDraft = normalizeCase(remoteCase({ localVersions: [{ id: '11111111-1111-1111-1111-111111111111', text: '当前答复稿', at: '2026-09-12T00:00:00.000Z', processId: 'p1' }] }));
  assert.equal(historyRecords(duplicateDraft).filter(r => r.text === '当前答复稿').length, 1);
});

test('legacy paused or running jobs are cleared on confirmed waiting without dropping round materials or body', () => {
  const materials = [{ id: 'm1', name: '通知.pdf', role: '通知书', location: '', excerpt: '', ready: true }];
  const paused = normalizeCase(remoteCase({
    rounds: [{
      id: 'proc-p1', name: '第一次审查意见答复', stage: 'draft', confirmed: true, materials,
      strategy: '维持', draft: '轮次正文', versions: [], discussions: [], review: null,
      job: { id: 'job-paused', kind: 'drafting', status: 'paused', due: 1 }, final: null, finalHistory: [],
    }],
  }));
  assert.equal(paused.current?.kind, 'waiting');
  assert.equal(paused.current?.roundId, 'proc-p1');
  assert.equal(paused.rounds[0].job, null);
  assert.equal(paused.rounds[0].draft, '轮次正文');
  assert.equal(paused.rounds[0].materials[0]?.name, '通知.pdf');
  assert.equal(paused.localDraft, '当前答复稿');
  const running = normalizeCase(remoteCase({
    rounds: [{
      id: 'proc-p1', name: '第一次审查意见答复', stage: 'draft', confirmed: true, materials,
      strategy: '维持', draft: '轮次正文', versions: [], discussions: [], review: null,
      job: { id: 'job-run', kind: 'drafting', status: 'running', due: 1 }, final: null, finalHistory: [],
    }],
  }, { submission: { state: 'sent', source: 'hand', checkedAt: '2026-09-12T00:00:00.000Z', message: '已递交，等待官方处理' } }));
  assert.equal(running.current?.kind, 'waiting');
  assert.equal(running.rounds[0].job, null);
  assert.equal(running.rounds[0].materials.length, 1);
});

test('internal 500 without official success is 待核验, not submitted or granted', () => {
  const ended = normalizeCase(remoteCase({
    current: { kind: 'write', processId: 'p1', remoteStatus: 500, label: '提出申请' },
  }, { name: '提出申请', status: 500, submission: undefined }));
  assert.equal(ended.current?.kind, 'needs-confirmation');
  assert.equal(ended.current?.node, '待核验');
  assert.notEqual(ended.current?.kind, 'waiting');
  assert.equal(editableCurrent(ended), false);
});

test('caseStatus prefers CurrentFlowInfo.name over 200/300/400 dictionary labels', () => {
  const c = remoteCase({
    current: { kind: 'reply', processId: 'p1', remoteStatus: 200, label: '第一次审查意见答复' },
  }, {
    status: 200,
    submission: undefined,
    currentFlow: { name: '客户审核', user: '甲', serial: 2, total: 4 },
  });
  assert.equal(caseStatus(c), '递交中 · 甲 · 客户审核');
  assert.equal(libraryStatus(c).short, '递交中 · 甲 · 客户审核');
  assert.equal(libraryStatus(c).full, '递交中 · 甲 · 客户审核');
  const dictOnly = remoteCase({
    current: { kind: 'reply', processId: 'p1', remoteStatus: 200, label: '第一次审查意见答复' },
  }, { status: 200, submission: undefined });
  assert.equal(caseStatus(dictOnly), '递交中 · 办理人待核对 · 节点待核对');
  const official = remoteCase({
    current: { kind: 'reply', processId: 'p1', remoteStatus: 400, label: '第一次审查意见答复' },
  }, {
    status: 400,
    currentFlow: { name: '递交官方', user: '乙' },
    submission: { state: 'received', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z', message: '已收到回执' },
  });
  assert.match(caseStatus(official), /已收到回执，等待官方处理结果/);
  assert.doesNotMatch(caseStatus(official), /客户审核|递交官方/);
});

test('normalizeCase switches stale official cache to unique personal active and keeps draft history', () => {
  const c = remoteCase({
    current: { kind: 'waiting', processId: 'p1', remoteStatus: 500, label: WAITING_OFFICIAL_LABEL },
    localDraft: '旧阶段稿件',
    localVersions: [],
    remote: {
      caseId: 'r1', syncedAt: '',
      processes: [
        { id: 'p1', name: '第一次审查意见答复', status: 500, node: '', undertaker: '', deadline: '', submission: { state: 'received', source: 'send-status', checkedAt: '2026-01-01T00:00:00.000Z' } },
        { id: 'restore', name: '恢复权利请求', status: 0, node: '待办', undertaker: '甲', deadline: '', officialDeadline: '2026-10-01', officialDeadlineSource: 'cpc' },
      ],
    },
  });
  const next = normalizeCase(c);
  assert.equal(next.current?.processId, 'restore');
  assert.equal(next.current?.kind, 'external');
  assert.equal(next.localDraft, '');
  assert(next.localVersions?.some(v => v.text === '旧阶段稿件' && v.processId === 'p1'));
  assert.equal(next.rounds[0].id, 'proc-p1');
  assert.equal(next.rounds[0].draft, '轮次正文');
  assert.notEqual(currentHandling(next).officialWaiting, true);
  assert.notEqual(next.current?.kind, 'waiting');
  const alreadyNew = normalizeCase(remoteCase({
    current: { kind: 'external', processId: 'restore', remoteStatus: 0, label: '恢复权利请求' },
    localDraft: '新阶段稿件',
    remote: {
      caseId: 'r1', syncedAt: '',
      processes: [
        { id: 'p1', name: '第一次审查意见答复', status: 500, node: '', undertaker: '', deadline: '', submission: { state: 'received', source: 'send-status', checkedAt: '2026-01-01T00:00:00.000Z' } },
        { id: 'restore', name: '恢复权利请求', status: 0, node: '待办', undertaker: '甲', deadline: '' },
      ],
    },
  }));
  assert.equal(alreadyNew.current?.processId, 'restore');
  assert.equal(alreadyNew.current?.kind, 'external');
  assert.equal(alreadyNew.localDraft, '新阶段稿件');
  const ambiguous = normalizeCase(remoteCase({
    current: { kind: 'waiting', processId: 'p1', label: WAITING_OFFICIAL_LABEL },
    localDraft: '保留的稿件',
    remote: {
      caseId: 'r1', syncedAt: '',
      processes: [
        { id: 'p1', name: '第一次审查意见答复', status: 500, node: '', undertaker: '', deadline: '', submission: { state: 'received', source: 'send-status', checkedAt: '2026-01-01T00:00:00.000Z' } },
        { id: 'a', name: '恢复权利请求', status: 0, node: '', undertaker: '', deadline: '' },
        { id: 'b', name: '办理登记手续', status: 0, node: '', undertaker: '', deadline: '' },
      ],
    },
  }));
  assert.equal(ambiguous.current?.kind, 'needs-confirmation');
  assert.equal(ambiguous.current?.processId, undefined);
  assert.equal(ambiguous.localDraft, '保留的稿件');
  assert.equal(currentHandling(ambiguous).officialWaiting, false);
  const keepCurrent = normalizeCase({
    id: 'c-keep', title: '合成装置', number: 'SYN-KEEP', type: '发明', deadline: '', archived: false, tags: [], rounds: [],
    source: 'baseland',
    current: { kind: 'reply', processId: 'oa', remoteStatus: 0, label: '第一次审查意见答复' },
    remote: {
      caseId: 'r-keep', syncedAt: '',
      processes: [
        { id: 'oa', name: '第一次审查意见答复', status: 0, node: '', undertaker: '', deadline: '' },
        { id: 'corr', name: '答复补正', status: 0, node: '', undertaker: '', deadline: '' },
      ],
    },
  });
  assert.equal(keepCurrent.current?.kind, 'reply');
  assert.equal(keepCurrent.current?.processId, 'oa');
});

test('previous completed receipt does not hide a new OA on another current process', () => {
  const c = remoteCase({
    current: { kind: 'reply', processId: 'oa', roundId: 'proc-oa', remoteStatus: 0, label: '第一次审查意见答复' },
    remote: {
      caseId: 'r1', syncedAt: '',
      processes: [
        { id: 'app', name: '提出申请', status: 500, node: '', undertaker: '', deadline: '', submission: { state: 'received', source: 'send-status', checkedAt: '2026-01-01T00:00:00.000Z' } },
        { id: 'oa', name: '第一次审查意见答复', status: 0, node: '', undertaker: '', deadline: '', officialDeadline: '2026-10-01', officialDeadlineSource: 'cpc' },
      ],
    },
  });
  const next = normalizeCase(c);
  assert.equal(next.current?.kind, 'reply');
  assert.equal(next.current?.processId, 'oa');
  assert.equal(editableCurrent(next), true);
  assert.equal(next.deadline, '2026-10-01');
});



test('personal pending, own started work, next handler and completed are distinct',()=>{
  const base=seedWorkspace().cases[0];
  const make=(status:number,canEdit?:boolean,user='陈雨浩')=>normalizeCase({...base,source:'baseland',archived:false,current:{kind:'write',processId:'p',remoteStatus:status},remote:{caseId:'c',syncedAt:'now',processes:[{id:'p',name:'提出申请',status,personalStatus:status,node:'',undertaker:'陈雨浩',deadline:'',canEdit,handId:status?'h':undefined,currentFlow:status?{name:user==='杨佳'?'递交官方':'开始',user}:undefined,submission:{state:'draft',source:'hand',checkedAt:'now'}}]}} as Case);
  assert.match(caseStatus(make(0)),/^待处理/);
  const own=make(400,true);assert.equal(editableCurrent(own),true);assert.match(caseStatus(own),/递交中.*陈雨浩/);
  const handed=make(400,false,'杨佳');assert.equal(editableCurrent(handed),false);assert.match(libraryStatus(handed).short,/递交中.*杨佳/);
  assert.equal(editableCurrent(make(400,undefined)),false);
  // personalStatus/draft alone is not official submission evidence
  const done=make(500,false,'杨佳');assert.equal(done.current?.kind,'needs-confirmation');assert.doesNotMatch(caseStatus(done),/已提交官方|已交官方/);assert.equal(editableCurrent(done),false);
});

test('case status shows the official conclusion instead of the waiting-for-official text', () => {
  const make = (outcome?: Case['officialOutcome']): Case => ({
    id: 'bs-1', title: '合成案件', number: 'SYN-1', type: '发明', deadline: '', archived: false, tags: [], rounds: [],
    source: 'baseland', current: { kind: 'waiting', processId: 'p1', remoteStatus: 500 },
    remote: { caseId: 'r1', syncedAt: '', processes: [{ id: 'p1', name: '第一次审查意见答复', status: 500, node: '结束', undertaker: '甲', deadline: '', submission: { state: 'received', source: 'send-status', checkedAt: '', message: '已收到回执' } }] },
    ...(outcome ? { officialOutcome: outcome } : {}),
  });
  assert.equal(caseStatus(make()), '已收到回执，等待官方处理结果');
  assert.equal(caseStatus(make({ state: 'none', checkedAt: '2026-09-15T00:00:00.000Z' })), '已收到回执，等待官方处理结果', '未见结果不改写过程状态');
  assert.equal(caseStatus(make({ state: 'granted', noticeName: '办理登记手续通知书', noticeTypeCode: '200602', postDate: '2026-09-14', checkedAt: '2026-09-15T00:00:00.000Z' })), '已授权 · 办理登记手续通知书（200602） 2026-09-14');
  assert.equal(caseStatus(make({ state: 'rejected', noticeName: '驳回决定', noticeTypeCode: '300305', checkedAt: '2026-09-15T00:00:00.000Z' })), '已驳回 · 驳回决定（300305）');
});

test('A1 personalStatus/_status 500 + needSendOfficial:false is not officially submitted', () => {
  const draft = { state: 'draft' as const, source: 'hand' as const, checkedAt: '2026-09-12T00:00:00.000Z', message: '未递交官方' };
  const p: RemoteProcess = {
    id: 'app', name: '提出申请', status: 500, personalStatus: 500, needSendOfficial: false,
    node: '', undertaker: '甲', deadline: '', handId: 'h1', submission: draft,
  };
  assert.equal(effectiveSubmission(p)?.state, 'draft');
  assert.notEqual(effectiveSubmission(p)?.source, 'personal-status');
  assert.equal(isConfirmedOfficialSubmission(effectiveSubmission(p)), false);

  const c = normalizeCase({
    id: 'c', title: '合成装置', number: 'SYN-A1', type: '发明', deadline: '', archived: false, tags: [], rounds: [],
    source: 'baseland',
    current: { kind: 'write', processId: 'app', remoteStatus: 500, label: '提出申请' },
    remote: { caseId: 'r', syncedAt: '', processes: [p] },
  } as Case);
  assert.equal(c.remote?.processes[0].submission?.state, 'draft');
  assert.equal(isConfirmedOfficialSubmission(processSubmission(c)), false);
  assert.doesNotMatch(caseStatus(c), /已提交官方|已交官方/);
  assert.equal(c.current?.kind, 'waiting');
  assert.equal(c.current?.party, '内部');
  assert.match(c.current?.node ?? '', /内部流程已结束|等待后续/);
  assert.match(caseStatus(c), /内部流程已结束/);
  assert.equal(c.current?.node, INTERNAL_ENDED_WAIT_LABEL);
});
