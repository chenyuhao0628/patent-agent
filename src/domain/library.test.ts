import test from 'node:test';
import assert from 'node:assert/strict';
import type { Case, RemoteProcess } from './workflow.ts';
import type { CurrentWork } from './lifecycle.ts';
import {
  businessKind, daysUntilDeadline, deadlineView, isActiveWork, isConfirmedWaitingOfficial, isUrgencyEligible,
  libraryStatus, localDayOrdinal, nextLibrarySort, parseCalendarDay, progressStatus, progressStatusLabel, queryLibrary, waitingOfficialLabel,
} from './library.ts';
import { normalizeCase, WAITING_OFFICIAL_LABEL } from './lifecycle.ts';

const TODAY = new Date(2026, 8, 12, 15, 45, 0);

test('official and workspace scopes partition cases by current flow, ignoring old receipts', () => {
  const official = baseland({ id: 'waiting' }, { status: 500, submission: { state: 'received', checkedAt: '', source: 'send-status' } });
  const active = baseland({ id: 'active' }, { status: 200, submission: { state: 'draft', checkedAt: '' } });
  active.remote!.processes.push(process({ id: 'old', status: 500, submission: { state: 'received', checkedAt: '' } }));
  const local = fixture({ id: 'local', current: { kind: 'write' } });
  const all = [official, active, local];
  assert.deepEqual(queryLibrary(all, { scope: 'official' }).rows.map(c => c.id), ['waiting']);
  assert.deepEqual(new Set(queryLibrary(all, { scope: 'workspace' }).rows.map(c => c.id)), new Set(['active', 'local']));
  assert.equal(queryLibrary(all, { scope: 'workspace' }).counts.waitingOfficial, 0);
});

function process(fields: Partial<RemoteProcess> & Record<string, unknown>): RemoteProcess {
  return {
    id: 'p1', name: '第一次审查意见', status: 0, node: '内部办理', undertaker: '杨佳', deadline: '2026-09-01',
    ...fields,
  } as RemoteProcess;
}

function fixture(over: Partial<Case> & { current?: CurrentWork } = {}): Case {
  return {
    id: 'c1', title: '一种示例装置', number: '示例-1', type: '发明', deadline: '2026-09-20',
    archived: false, tags: [], rounds: [], source: 'local', current: { kind: 'reply' },
    ...over,
  };
}

function baseland(over: Partial<Case> = {}, proc: Record<string, unknown> = {}): Case {
  const current = over.current ?? { kind: 'reply' as const, processId: 'p1' };
  return fixture({
    source: 'baseland',
    deadline: '2026-09-01',
    remote: { caseId: 'r1', syncedAt: '2026-09-12T00:00:00.000Z', processes: [process({ id: current.processId ?? 'p1', ...proc })] },
    ...over,
    current,
  });
}

test('calendar day ordinals ignore time of day and reject invalid civil dates', () => {
  const morning = new Date(2026, 8, 12, 0, 15, 0);
  const night = new Date(2026, 8, 12, 23, 50, 0);
  assert.equal(localDayOrdinal(morning), localDayOrdinal(night));
  assert.equal(parseCalendarDay('2026-09-12'), localDayOrdinal(TODAY));
  assert.equal(parseCalendarDay('2026-02-31'), null);
  assert.equal(parseCalendarDay('2026-13-01'), null);
  assert.equal(parseCalendarDay(''), null);
  assert.equal(parseCalendarDay('not-a-date'), null);
});

test('today is not overdue; 1..14 days are near; day 15 is not near', () => {
  const expired = fixture({ id: 'expired', deadline: '2026-09-11' });
  const today = fixture({ id: 'today', deadline: '2026-09-12' });
  const inOne = fixture({ id: 'd1', deadline: '2026-09-13' });
  const inFourteen = fixture({ id: 'd14', deadline: '2026-09-26' });
  const inFifteen = fixture({ id: 'd15', deadline: '2026-09-27' });
  assert.equal(daysUntilDeadline(expired, TODAY), -1);
  assert.equal(daysUntilDeadline(today, new Date(2026, 8, 12, 23, 59, 0)), 0);
  assert.equal(daysUntilDeadline(inOne, TODAY), 1);
  assert.equal(daysUntilDeadline(inFourteen, TODAY), 14);
  assert.equal(daysUntilDeadline(inFifteen, TODAY), 15);
  const { counts, rows } = queryLibrary([expired, today, inOne, inFourteen, inFifteen], { now: TODAY, card: 'near' });
  assert.equal(counts.overdue, 1);
  assert.equal(counts.today, 1);
  assert.equal(counts.near, 2);
  assert.deepEqual(rows.map(c => c.id), ['d1', 'd14']);
});

test('baseland list date prefers genuine official then Baseland and never falls back to internal or generic deadline', () => {
  const official = baseland({}, { officialDeadline: '2026-11-01', officialDeadlineSource: 'cpc', baselandDeadline: '2026-10-01', internalDeadline: '2026-09-01', deadline: '2026-01-01' });
  const baselandOnly = baseland({ id: 'bl' }, { baselandDeadline: '2026-10-01', internalDeadline: '2026-09-01', deadline: '2026-01-01' });
  const legacy = baseland({ id: 'legacy' }, { officialDeadline: '2026-10-01', internalDeadline: '2026-09-01', deadline: '2026-09-01' });
  const missing = baseland({ id: 'missing' }, { deadline: '2026-09-01', internalDeadline: '2026-09-01' });
  const otherProcess = baseland(
    { id: 'other', current: { kind: 'reply', processId: 'p-current' } },
    { id: 'p-current', officialDeadline: undefined, deadline: '2026-09-01' },
  );
  assert.equal(deadlineView(official).source, 'official');
  assert.equal(deadlineView(official).label, '官方期限');
  assert.equal(deadlineView(official).display, '2026.11.01');
  assert.equal(deadlineView(baselandOnly).source, 'baseland');
  assert.equal(deadlineView(baselandOnly).label, '贝思兰德期限');
  assert.equal(deadlineView(baselandOnly).display, '2026.10.01');
  assert.equal(daysUntilDeadline(baselandOnly, TODAY), 19);
  assert.equal(deadlineView(legacy).source, 'baseland');
  assert.equal(deadlineView(legacy).label, '贝思兰德期限');
  assert.equal(deadlineView(missing).source, 'missing');
  assert.equal(deadlineView(missing).display, '未提供');
  assert.notEqual(deadlineView(missing).label, '官方期限');
  assert.equal(daysUntilDeadline(missing, TODAY), null);
  assert.equal(queryLibrary([missing], { now: TODAY }).counts.overdue, 0);
  assert.equal(deadlineView(otherProcess).display, '未提供');
  const local = fixture({ deadline: '2026-09-20' });
  assert.equal(deadlineView(local).source, 'local');
  assert.equal(deadlineView(local).label, '自设日期');
  assert.notEqual(deadlineView(local).label, '官方期限');
});

test('deadline sort keeps missing and invalid dates last in both directions; type sort is stable', () => {
  const cases = [
    fixture({ id: 'b', title: '乙案', type: '实用新型', deadline: '2026-09-20' }),
    fixture({ id: 'a', title: '甲案', type: '发明', deadline: '' }),
    fixture({ id: 'c', title: '丙案', type: '发明', deadline: '2026-02-31' }),
    fixture({ id: 'd', title: '丁案', type: '外观设计', deadline: '2026-09-10' }),
    fixture({ id: 'e', title: '戊案', type: '发明', deadline: '2026-09-18' }),
  ];
  const asc = queryLibrary(cases, { now: TODAY, sortKey: 'deadline', sortDir: 'asc' }).rows.map(c => c.id);
  const desc = queryLibrary(cases, { now: TODAY, sortKey: 'deadline', sortDir: 'desc' }).rows.map(c => c.id);
  assert.deepEqual(asc, ['d', 'e', 'b', 'a', 'c']);
  assert.deepEqual(desc, ['b', 'e', 'd', 'a', 'c']);
  const byType = queryLibrary(cases, { now: TODAY, sortKey: 'patentType', sortDir: 'asc' }).rows;
  assert.deepEqual(byType.filter(c => c.type === '发明').map(c => c.id), ['a', 'c', 'e']);
  assert.equal(byType.length, 5);
});

test('patent type and business filters combine; card counts use the filtered set and ignore the selected card', () => {
  const cases = [
    fixture({ id: 'reply-inv', type: '发明', current: { kind: 'reply' }, deadline: '2026-09-11' }),
    fixture({ id: 'reply-um', type: '实用新型', current: { kind: 'reply' }, deadline: '2026-09-11' }),
    fixture({ id: 'write-inv', type: '发明', current: { kind: 'write' }, deadline: '2026-09-13' }),
    fixture({ id: 'corr-inv', type: '发明', current: { kind: 'correction' }, deadline: '2026-09-12' }),
    fixture({ id: 'review-inv', type: '发明', current: { kind: 'review' }, deadline: '2026-10-01' }),
  ];
  const filtered = queryLibrary(cases, { now: TODAY, patentType: '发明', business: '审查意见', card: 'overdue' });
  const unfilteredCounts = queryLibrary(cases, { now: TODAY, patentType: '发明', business: '审查意见' }).counts;
  assert.deepEqual(filtered.rows.map(c => c.id), ['reply-inv']);
  assert.deepEqual(filtered.counts, unfilteredCounts);
  assert.equal(filtered.counts.overdue, 1);
  assert.equal(filtered.counts.today, 0);
  assert.equal(filtered.counts.near, 0);
  assert.equal(filtered.counts.active, 1);
  const invent = queryLibrary(cases, { now: TODAY, patentType: '发明' });
  assert.equal(invent.counts.overdue, 1);
  assert.equal(invent.counts.today, 1);
  assert.equal(invent.counts.near, 1);
  assert.equal(invent.counts.active, 4);
  assert.deepEqual(invent.availablePatentTypes, ['发明', '实用新型']);
  assert.deepEqual(invent.availableBusinessKinds, ['申请', '审查意见', '补正', '审查']);
  assert.equal(businessKind(cases[2]!), '申请');
});

test('confirmed sent/received leave urgency; generic waiting is not 等待官方; local final still has a deadline', () => {
  const sent = baseland(
    { id: 'sent', current: { kind: 'reply', processId: 'p1' } },
    { officialDeadline: '2026-09-11', submission: { state: 'sent', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  const received = baseland(
    { id: 'received', current: { kind: 'waiting', processId: 'p1', label: '等待后续通知' } },
    { officialDeadline: '2026-09-11', submission: { state: 'received', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  const genericWaiting = fixture({ id: 'wait', current: { kind: 'waiting', label: '等待后续通知' }, deadline: '2026-09-11' });
  const archived = fixture({ id: 'arch', archived: true, deadline: '2026-09-11' });
  const finished = baseland(
    { id: 'done', current: { kind: 'reply', processId: 'p1', remoteStatus: 500 } },
    { officialDeadline: '2026-09-11' },
  );
  const localFinal = fixture({
    id: 'final',
    current: { kind: 'write' },
    deadline: '2026-09-13',
    design: {
      writing: { stage: 'final', disclosure: '', researchQuery: '', researched: false, strategy: '', documents: [], versions: [], finalVersionId: 'v1', finalHistory: [] },
      review: null, reviewHistory: [], transfer: { selected: [], applicant: '', process: '', receiver: '', note: '', receipts: [] },
    },
  });
  assert.equal(isConfirmedWaitingOfficial(sent), true);
  assert.equal(isUrgencyEligible(sent), false);
  assert.equal(isUrgencyEligible(received), false);
  assert.equal(isUrgencyEligible(genericWaiting), false);
  assert.equal(isUrgencyEligible(archived), false);
  assert.equal(isConfirmedWaitingOfficial(finished), false);
  assert.equal(waitingOfficialLabel(finished), null);
  assert.equal(isUrgencyEligible(finished), true);
  assert.equal(isActiveWork(localFinal), true);
  assert.equal(isUrgencyEligible(localFinal), true);
  assert.equal(waitingOfficialLabel(sent), '递交成功，等待回执');
  assert.equal(waitingOfficialLabel(received), '已收到回执，等待官方处理结果');
  assert.equal(waitingOfficialLabel(genericWaiting), null);
  assert.equal(libraryStatus(genericWaiting).short, '等待后续通知');
  const result = queryLibrary([sent, received, genericWaiting, archived, finished, localFinal], { now: TODAY, archived: 'all' });
  assert.equal(result.counts.waitingOfficial, 2);
  assert.equal(result.counts.overdue, 1);
  assert.equal(result.counts.near, 1);
  assert.equal(result.counts.active, 2);
  assert.deepEqual(queryLibrary([sent, received, genericWaiting, localFinal], { now: TODAY, card: 'waitingOfficial' }).rows.map(c => c.id), ['received', 'sent']);
});

test('submission source distinguishes hand delivery from send-status; archived display wins over waiting official', () => {
  const hand = baseland(
    { id: 'hand', current: { kind: 'reply', processId: 'p1' } },
    { officialDeadline: '2026-09-20', submission: { state: 'sent', source: 'hand', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  const sendStatus = baseland(
    { id: 'elec', current: { kind: 'reply', processId: 'p1' } },
    { officialDeadline: '2026-09-20', submission: { state: 'sent', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  const received = baseland(
    { id: 'recv', current: { kind: 'reply', processId: 'p1' } },
    { officialDeadline: '2026-09-20', submission: { state: 'received', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  const archivedSent = baseland(
    { id: 'arch-sent', archived: true, current: { kind: 'reply', processId: 'p1' } },
    { officialDeadline: '2026-09-11', submission: { state: 'sent', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  assert.equal(waitingOfficialLabel(hand), '已递交，等待官方处理结果');
  assert.equal(libraryStatus(hand).short, '已完成 · 已提交官方');
  assert.match(libraryStatus(hand).full,/已提交官方/);
  assert.equal(waitingOfficialLabel(sendStatus), '递交成功，等待回执');
  assert.equal(waitingOfficialLabel(received), '已收到回执，等待官方处理结果');
  assert.equal(isConfirmedWaitingOfficial(hand), true);
  assert.equal(isConfirmedWaitingOfficial(sendStatus), true);
  assert.equal(libraryStatus(archivedSent).short, '已归档');
  assert.notEqual(libraryStatus(archivedSent).short, waitingOfficialLabel(sendStatus));
  const waiting = queryLibrary([hand, sendStatus, received, archivedSent], { now: TODAY, card: 'waitingOfficial' });
  assert.deepEqual(waiting.rows.map(c => c.id), ['elec', 'hand', 'recv']);
  assert.equal(waiting.counts.waitingOfficial, 3);
});

test('status dropdown keeps pending / in_progress / final and combines with other filters', () => {
  const pending = fixture({ id: 'pending', current: { kind: 'needs-confirmation' }, deadline: '2026-09-20' });
  const materials = fixture({
    id: 'materials',
    current: { kind: 'reply', roundId: 'r1' },
    rounds: [{
      id: 'r1', name: '第一次审查意见', stage: 'materials', confirmed: false, materials: [],
      strategy: null, draft: '', versions: [], discussions: [], review: null, job: null, final: null, finalHistory: [],
    }],
    deadline: '2026-09-20',
  });
  const drafting = fixture({
    id: 'drafting',
    type: '实用新型',
    current: { kind: 'reply', roundId: 'r2' },
    rounds: [{
      id: 'r2', name: '第一次审查意见', stage: 'draft', confirmed: true, materials: [],
      strategy: '维持', draft: '稿', versions: [], discussions: [], review: null, job: null, final: null, finalHistory: [],
    }],
    deadline: '2026-09-20',
  });
  const done = fixture({
    id: 'done',
    current: { kind: 'write' },
    deadline: '2026-09-20',
    design: {
      writing: { stage: 'final', disclosure: '', researchQuery: '', researched: false, strategy: '', documents: [], versions: [], finalVersionId: 'v1', finalHistory: [] },
      review: null, reviewHistory: [], transfer: { selected: [], applicant: '', process: '', receiver: '', note: '', receipts: [] },
    },
  });
  assert.equal(progressStatus(pending), 'pending');
  assert.equal(progressStatus(materials), 'pending');
  assert.equal(progressStatus(drafting), 'in_progress');
  assert.equal(progressStatus(done), 'final');
  assert.equal(progressStatusLabel('pending'), '待核对');
  assert.equal(progressStatusLabel('pending', 'write'), '待开始');
  assert.equal(progressStatusLabel('final', 'review'), '已完成');
  const cases = [pending, materials, drafting, done];
  const listed = queryLibrary(cases, { now: TODAY, progress: 'pending' }).rows.map(c => c.id);
  assert.deepEqual(listed, ['materials', 'pending']);
  const combined = queryLibrary(cases, { now: TODAY, progress: 'in_progress', patentType: '实用新型' });
  assert.deepEqual(combined.rows.map(c => c.id), ['drafting']);
  assert.deepEqual(queryLibrary(cases, { now: TODAY }).availableProgressStatuses, ['pending', 'in_progress', 'final']);
  const reset = queryLibrary(cases, { now: TODAY, progress: '', patentType: '', business: '' });
  assert.equal(reset.rows.length, 4);
});

test('search matches applicationNumber as well as title, number and tags', () => {
  const withApp = fixture({ id: 'app', title: '无关键词标题', number: '案号-9', applicationNumber: 'CN202610000001.1', tags: [] });
  const other = fixture({ id: 'other', title: '另一种装置', number: '案号-8', deadline: '2026-09-21' });
  assert.deepEqual(queryLibrary([withApp, other], { now: TODAY, search: '202610000001' }).rows.map(c => c.id), ['app']);
  assert.deepEqual(queryLibrary([withApp, other], { now: TODAY, search: '案号-8' }).rows.map(c => c.id), ['other']);
});

test('personal active external process stays in deadline stats; unowned external does not', () => {
  const restore = baseland(
    { id: 'restore', current: { kind: 'external', processId: 'p1', label: '恢复权利请求' } },
    { id: 'p1', name: '恢复权利请求', status: 0, officialDeadline: '2026-09-11' },
  );
  const unowned = fixture({
    id: 'unowned',
    source: 'baseland',
    current: { kind: 'external', label: '不在当前个人案件结果中，请核对分配情况' },
    deadline: '2026-09-11',
  });
  assert.equal(isUrgencyEligible(restore), true);
  assert.equal(isActiveWork(restore), true);
  assert.equal(isConfirmedWaitingOfficial(restore), false);
  assert.equal(isUrgencyEligible(unowned), false);
  const result = queryLibrary([restore, unowned], { now: TODAY, archived: 'all' });
  assert.equal(result.counts.active, 1);
  assert.equal(result.counts.overdue, 1);
  assert.deepEqual(queryLibrary([restore, unowned], { now: TODAY, card: 'overdue' }).rows.map(c => c.id), ['restore']);
});

test('waiting after official receipt still classifies application/OA/correction business', () => {
  const oa = normalizeCase(baseland(
    { id: 'oa', current: { kind: 'reply', processId: 'p1' } },
    { name: '第一次审查意见答复', submission: { state: 'received', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z' } },
  ));
  const apply = normalizeCase(baseland(
    { id: 'app', current: { kind: 'write', processId: 'p1' } },
    { name: '提出申请', submission: { state: 'sent', source: 'hand', checkedAt: '2026-09-12T00:00:00.000Z' } },
  ));
  const corr = normalizeCase(baseland(
    { id: 'corr', current: { kind: 'correction', processId: 'p1' } },
    { name: '补正', submission: { state: 'sent', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z' } },
  ));
  assert.equal(oa.current?.kind, 'waiting');
  assert.equal(oa.current?.label, WAITING_OFFICIAL_LABEL);
  assert.equal(businessKind(oa), '审查意见');
  assert.equal(businessKind(apply), '申请');
  assert.equal(businessKind(corr), '补正');
  assert.deepEqual(queryLibrary([oa, apply, corr], { now: TODAY, business: '审查意见' }).rows.map(c => c.id), ['oa']);
});

test('status sort uses displayed status; header click starts ascending then toggles', () => {
  const hand = baseland(
    { id: 'hand', current: { kind: 'reply', processId: 'p1' } },
    { officialDeadline: '2026-09-20', submission: { state: 'sent', source: 'hand', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  const elec = baseland(
    { id: 'elec', current: { kind: 'reply', processId: 'p1' } },
    { officialDeadline: '2026-09-20', submission: { state: 'sent', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  const recv = baseland(
    { id: 'recv', current: { kind: 'reply', processId: 'p1' } },
    { officialDeadline: '2026-09-20', submission: { state: 'received', source: 'send-status', checkedAt: '2026-09-12T00:00:00.000Z' } },
  );
  const labels = [libraryStatus(hand).short, libraryStatus(elec).short, libraryStatus(recv).short].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const asc = queryLibrary([hand, elec, recv], { now: TODAY, sortKey: 'status', sortDir: 'asc' }).rows.map(c => libraryStatus(c).short);
  const desc = queryLibrary([hand, elec, recv], { now: TODAY, sortKey: 'status', sortDir: 'desc' }).rows.map(c => libraryStatus(c).short);
  assert.deepEqual(asc, labels);
  assert.deepEqual(desc, [...labels].reverse());
  assert.deepEqual(nextLibrarySort('deadline', 'asc', 'title'), { sortKey: 'title', sortDir: 'asc' });
  assert.deepEqual(nextLibrarySort('title', 'asc', 'title'), { sortKey: 'title', sortDir: 'desc' });
  assert.deepEqual(nextLibrarySort('title', 'desc', 'title'), { sortKey: 'title', sortDir: 'asc' });
  assert.deepEqual(nextLibrarySort('status', 'desc', 'deadline'), { sortKey: 'deadline', sortDir: 'asc' });
});


test('internal transfer lists active remote flows without legacy finals and excludes local or official cases',()=>{
 const cases=[0,200,300,400,500].map(status=>baseland({id:String(status)},{status}));
 cases.push(fixture({id:'local'}));
 cases.push(baseland({id:'official'},{status:400,submission:{state:'sent',checkedAt:''}}));
 cases.push(baseland({id:'archived',archived:true},{status:0}));
 assert.deepEqual(new Set(queryLibrary(cases,{module:'transfer'}).rows.map(c=>c.id)),new Set(['0','200','300','400']));
});
