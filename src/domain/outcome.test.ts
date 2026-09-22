import test from 'node:test';
import assert from 'node:assert/strict';
import type { Case } from './workflow.ts';
import {
  availableOutcomes, matchesOutcome, outcomeCounts, outcomeDetail, outcomeLabel, outcomeView, queryOutcomeCases,
} from './outcome.ts';

function fixture(over: Partial<Case> = {}): Case {
  return {
    id: 'bs-1', title: '一种示例装置', number: '202600001-0001', type: '发明', deadline: '',
    archived: false, tags: [], rounds: [], source: 'baseland',
    remote: { caseId: 'case-1', processes: [], syncedAt: '2026-09-15T00:00:00.000Z' },
    ...over,
  };
}

function decided(state: 'granted' | 'rejected' | 'none', postDate?: string, over: Partial<Case> = {}): Case {
  return fixture({
    officialOutcome: {
      state,
      noticeName: state === 'rejected' ? '驳回决定' : state === 'granted' ? '办理登记手续通知书' : undefined,
      noticeTypeCode: state === 'rejected' ? '200305' : state === 'granted' ? '200602' : undefined,
      postDate,
      checkedAt: '2026-09-15T02:00:00.000Z',
    },
    ...over,
  });
}

test('official outcome labels distinguish concluded, unlisted, unread and local cases', () => {
  assert.equal(outcomeLabel(decided('granted')), '已授权');
  assert.equal(outcomeLabel(decided('rejected')), '已驳回');
  assert.equal(outcomeLabel(decided('none')), '未见结果');
  assert.equal(outcomeLabel(fixture()), '未判读');
  assert.equal(outcomeView(fixture()), 'unknown');
  const local: Case = { ...fixture(), id: 'local-1', source: 'local', remote: undefined };
  assert.equal(outcomeLabel(local), '—');
  assert.equal(outcomeView(local), 'unknown');
  assert.match(outcomeDetail(local), /本机案件/);
});

test('unlisted outcome never claims the patent is unauthorised', () => {
  assert.match(outcomeDetail(decided('none')), /没有授权或驳回类官文/);
  assert.doesNotMatch(outcomeDetail(decided('none')), /未授权/);
  assert.match(outcomeDetail(fixture()), /尚未判读/);
  const truncated = fixture({ officialOutcome: { state: 'none', checkedAt: '2026-09-15T02:00:00.000Z', incomplete: true } });
  assert.match(outcomeDetail(truncated), /清单未取完/);
  assert.match(outcomeDetail(decided('granted', '2026-09-14')), /办理登记手续通知书（200602）/);
  assert.match(outcomeDetail(decided('granted', '2026-09-14')), /2026-09-14/);
  assert.match(outcomeDetail(decided('granted', '2026-09-14')), /授权=办理登记手续通知书/);
});

test('counts and available filters cover only cases under Baseland responsibility', () => {
  const rows = [decided('granted'), decided('rejected'), decided('none'), fixture(), { ...fixture({ id: 'local-2' }), source: 'local' as const, remote: undefined }];
  assert.deepEqual(outcomeCounts(rows), { rejected: 1, granted: 1, none: 1, unknown: 1 });
  assert.deepEqual(availableOutcomes(rows), ['rejected', 'granted', 'none', 'unknown']);
  assert.equal(matchesOutcome(rows[3], 'unknown'), true);
  assert.equal(matchesOutcome(rows[4], 'unknown'), false, 'local cases are not "unread", they simply do not apply');
  assert.equal(matchesOutcome(rows[0], ''), true);
});

test('outcome order puts rejected first, then newest notice date, then title', () => {
  const older = decided('granted', '2026-08-01', { id: 'a', title: '甲案' });
  const newer = decided('granted', '2026-09-01', { id: 'b', title: '乙案' });
  const undated = decided('granted', undefined, { id: 'c', title: '丙案' });
  const rejected = decided('rejected', '2026-07-01', { id: 'd', title: '丁案' });
  const none = decided('none', undefined, { id: 'e', title: '戊案' });
  const unread = fixture({ id: 'f', title: '己案' });
  const rows = queryOutcomeCases([older, newer, undated, rejected, none, unread]);
  assert.deepEqual(rows.map(c => c.id), ['d', 'b', 'a', 'c', 'e', 'f']);
});

test('outcome page query combines search, archive scope and outcome filter', () => {
  const a = decided('granted', '2026-09-01', { id: 'a', title: '一种冷链调度方法', companyName: '四川银生供应链', applicationNumber: '2026107023971' });
  const b = decided('rejected', '2026-09-02', { id: 'b', title: '一种夹具', companyName: '另一家公司', archived: true });
  const c = fixture({ id: 'c', title: '未判读案件', companyName: '四川银生供应链' });
  const rows = [a, b, c];
  assert.deepEqual(queryOutcomeCases(rows).map(x => x.id), ['a', 'c']);
  assert.deepEqual(queryOutcomeCases(rows, { archived: 'all' }).map(x => x.id), ['b', 'a', 'c']);
  assert.deepEqual(queryOutcomeCases(rows, { archived: 'archived' }).map(x => x.id), ['b']);
  assert.deepEqual(queryOutcomeCases(rows, { outcome: 'granted' }).map(x => x.id), ['a']);
  assert.deepEqual(queryOutcomeCases(rows, { search: '2026107023971' }).map(x => x.id), ['a']);
  assert.deepEqual(queryOutcomeCases(rows, { search: '银生' }).map(x => x.id), ['a', 'c']);
  assert.deepEqual(queryOutcomeCases(rows, { search: '夹具', archived: 'active' }), []);
});
