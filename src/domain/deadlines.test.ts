import test from 'node:test';
import assert from 'node:assert/strict';
import type { Case, RemoteProcess } from './workflow.ts';
import {
  applyCaseDeadline, calendarDate, deadlineFieldLabel, deadlineFieldValue, deadlineView, mergeProcessDeadlines, migrateProcessDeadlines, parseCalendarDay, processDeadlineView,
} from './deadlines.ts';

function proc(fields: Partial<RemoteProcess> & Pick<RemoteProcess, 'id'>): RemoteProcess {
  return { name: '第一次审查意见答复', status: 0, node: '', undertaker: '', deadline: '', ...fields };
}

function baseland(process: RemoteProcess, currentProcessId = process.id): Case {
  return {
    id: 'c1', title: '合成装置', number: 'SYN-1', type: '发明', deadline: '2026-01-01', archived: false, tags: [], rounds: [],
    source: 'baseland', current: { kind: 'reply', processId: currentProcessId },
    remote: { caseId: 'r1', syncedAt: '2026-09-12T00:00:00.000Z', processes: [process] },
  };
}

test('calendar dates reject blanks, impossible civil values and out-of-range years', () => {
  assert.equal(calendarDate(null), '');
  assert.equal(calendarDate('  '), '');
  assert.equal(calendarDate('\t\n'), '');
  assert.equal(calendarDate('2026-02-31'), '');
  assert.equal(calendarDate('0000-00-00'), '');
  assert.equal(calendarDate('2026-10-01T12:00:00'), '2026-10-01');
  assert.equal(calendarDate('  2026-10-01'), '2026-10-01');
  assert.equal(calendarDate('2026-10-01  '), '2026-10-01');
  assert.equal(calendarDate('\t2026-10-01\n'), '2026-10-01');
  assert.equal(calendarDate(' 2026-02-31 '), '');
  assert.equal(parseCalendarDay('2026-09-12'), Date.UTC(2026, 8, 12) / 86_400_000);
  assert.equal(parseCalendarDay('2026-02-31'), null);
});

test('genuine official wins over Baseland; internal and generic deadline are never selected', () => {
  const facts = migrateProcessDeadlines({
    officialDeadline: '2026-11-01', officialDeadlineSource: 'cpc',
    baselandDeadline: '2026-10-01', internalDeadline: '2026-09-28', deadline: '2026-01-01',
  });
  assert.equal(facts.officialDeadline, '2026-11-01');
  assert.equal(facts.officialDeadlineSource, 'cpc');
  assert.equal(facts.baselandDeadline, '2026-10-01');
  assert.equal(facts.internalDeadline, '2026-09-28');
  assert.equal(facts.deadline, '2026-11-01');
  const view = processDeadlineView(facts);
  assert.equal(view.source, 'official');
  assert.equal(view.label, '官方期限');
  assert.equal(view.display, '2026.11.01');
});

test('Baseland legal date is used when official is missing, invalid or unprovenanced', () => {
  const fallback = migrateProcessDeadlines({ baselandDeadline: '2026-10-01', internalDeadline: '2026-09-28', deadline: '2026-01-01' });
  assert.equal(fallback.deadline, '2026-10-01');
  assert.equal(fallback.officialDeadline, undefined);
  assert.equal(processDeadlineView(fallback).label, '贝思兰德期限');
  const invalidOfficial = migrateProcessDeadlines({
    officialDeadline: '2026-02-31', officialDeadlineSource: 'cpc', baselandDeadline: '2026-10-01',
  });
  assert.equal(invalidOfficial.officialDeadline, undefined);
  assert.equal(invalidOfficial.deadline, '2026-10-01');
  const missing = migrateProcessDeadlines({ internalDeadline: '2026-09-28', deadline: '2026-09-28' });
  assert.equal(missing.deadline, '');
  assert.equal(missing.baselandDeadline, undefined);
  assert.equal(processDeadlineView(missing).source, 'missing');
});

test('v023 officialDeadline without provenance migrates to baselandDeadline and is not labeled official', () => {
  const migrated = migrateProcessDeadlines({ officialDeadline: '2026-10-01', internalDeadline: '2026-09-28', deadline: '2026-09-28' });
  assert.equal(migrated.baselandDeadline, '2026-10-01');
  assert.equal(migrated.officialDeadline, undefined);
  assert.equal(migrated.officialDeadlineSource, undefined);
  assert.equal(migrated.deadline, '2026-10-01');
  assert.equal(processDeadlineView(migrated).label, '贝思兰德期限');
});

test('unknown supplied official source with a valid date is not treated as Baseland', () => {
  const unknown = migrateProcessDeadlines({
    officialDeadline: '2026-11-01', officialDeadlineSource: 'unknown', internalDeadline: '2026-09-28', deadline: '2026-01-01',
  });
  assert.equal(unknown.officialDeadline, undefined);
  assert.equal(unknown.officialDeadlineSource, undefined);
  assert.equal(unknown.baselandDeadline, undefined);
  assert.equal(unknown.deadline, '');
  const withBaseland = migrateProcessDeadlines({
    officialDeadline: '2026-11-01', officialDeadlineSource: 'mystery', baselandDeadline: '2026-10-01',
  });
  assert.equal(withBaseland.officialDeadline, undefined);
  assert.equal(withBaseland.baselandDeadline, '2026-10-01');
  assert.equal(withBaseland.deadline, '2026-10-01');
  const previous = migrateProcessDeadlines({ baselandDeadline: '2026-08-01' });
  const merged = mergeProcessDeadlines(previous, { officialDeadline: '2026-11-01', officialDeadlineSource: 'unknown' });
  assert.equal(merged.baselandDeadline, '2026-08-01');
  assert.equal(merged.officialDeadline, undefined);
  assert.equal(merged.deadline, '2026-08-01');
});

test('refresh keeps genuine official on the same process while updating Baseland values', () => {
  const previous = migrateProcessDeadlines({
    officialDeadline: '2026-11-01', officialDeadlineSource: 'official-document', baselandDeadline: '2026-08-01',
  });
  const merged = mergeProcessDeadlines(previous, { baselandDeadline: '2026-10-01', internalDeadline: '2026-09-28' });
  assert.equal(merged.officialDeadline, '2026-11-01');
  assert.equal(merged.officialDeadlineSource, 'official-document');
  assert.equal(merged.baselandDeadline, '2026-10-01');
  assert.equal(merged.deadline, '2026-11-01');
  const v023Refresh = mergeProcessDeadlines(previous, { officialDeadline: '2026-12-31', deadline: '2026-12-31' });
  assert.equal(v023Refresh.officialDeadline, '2026-11-01');
  assert.equal(v023Refresh.baselandDeadline, '2026-12-31');
});

test('case deadline uses only the current process; an old completed process cannot override it', () => {
  const current = proc({ id: 'oa', officialDeadline: '2026-12-01', officialDeadlineSource: 'cpc', baselandDeadline: '2026-10-01' });
  const old = proc({ id: 'app', officialDeadline: '2026-01-01', officialDeadlineSource: 'cpc', baselandDeadline: '2026-01-01', status: 500, name: '提出申请' });
  const c: Case = {
    id: 'c1', title: '合成装置', number: 'SYN-1', type: '发明', deadline: '2026-01-01', archived: false, tags: [], rounds: [],
    source: 'baseland', current: { kind: 'reply', processId: 'oa' },
    remote: { caseId: 'r1', syncedAt: '', processes: [old, current] },
  };
  applyCaseDeadline(c);
  assert.equal(c.deadline, '2026-12-01');
  assert.equal(deadlineView(c).label, '官方期限');
  const other = baseland(proc({ id: 'p-current' }), 'p-current');
  other.remote!.processes[0].deadline = '2026-09-01';
  other.deadline = '2026-09-01';
  assert.equal(deadlineView(other).source, 'missing');
  assert.equal(deadlineView(other).display, '未提供');
  const local: Case = { id: 'l', title: '本地', number: 'L-1', type: '发明', deadline: '2026-09-20', archived: false, tags: [], rounds: [], source: 'local' };
  assert.equal(deadlineView(local).label, '自设日期');
  assert.notEqual(deadlineView(local).label, '官方期限');
  assert.equal(deadlineView(local).ordinal, parseCalendarDay('2026-09-20'));
  const missingRemote = baseland(proc({ id: 'p-missing' }));
  assert.equal(deadlineFieldLabel(missingRemote), '办理期限');
  assert.equal(deadlineFieldValue(missingRemote), '未提供');
  const missingLocal: Case = { id: 'empty', title: '本地', number: 'L-0', type: '发明', deadline: '', archived: false, tags: [], rounds: [], source: 'local' };
  assert.equal(deadlineFieldLabel(missingLocal), '自设日期');
  assert.equal(deadlineFieldValue(missingLocal), '未提供');
});


test('initial application uses internal date exclusively; later notices keep official then Baseland dates',()=>{
 const initial=proc({id:'app',name:'提出申请',procCode:'105',internalDeadline:'2026-09-20',baselandDeadline:'2026-12-01'});
 assert.equal(processDeadlineView(initial).source,'internal');assert.equal(processDeadlineView(initial).raw,'2026-09-20');
 assert.equal(migrateProcessDeadlines(initial).deadline,'2026-09-20');
 assert.equal(mergeProcessDeadlines(initial,{internalDeadline:'2026-09-21'}).deadline,'2026-09-21');
 assert.equal(processDeadlineView({...initial,internalDeadline:undefined}).raw,null);
 const later=proc({id:'reply',name:'答复审查意见',internalDeadline:'2026-09-20',baselandDeadline:'2026-11-01',officialDeadline:'2026-12-01',officialDeadlineSource:'official-document'});
 assert.equal(processDeadlineView(later).raw,'2026-12-01');
 assert.equal(processDeadlineView({...later,officialDeadline:undefined}).raw,'2026-11-01');
 const c=baseland(initial);applyCaseDeadline(c);assert.equal(c.deadline,'2026-09-20');assert.equal(deadlineFieldLabel(c),'内部期限');
});
