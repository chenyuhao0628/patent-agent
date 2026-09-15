import test from 'node:test';
import assert from 'node:assert/strict';
import { BaselandClient, judgeOfficialOutcome } from './baseland.ts';
import type { Case } from '../src/domain/workflow.ts';

const origin = 'https://test.baselandtec.com';

function caseFixture(caseId = 'case-1'): Case {
  return {
    id: 'bs-1', title: '合成案件', number: '202600001-0001', type: '发明', deadline: '',
    archived: false, tags: [], rounds: [], source: 'baseland',
    remote: { caseId, processes: [], syncedAt: '2026-09-15T00:00:00.000Z' },
  };
}

function notice(over: Record<string, unknown> = {}) {
  return { NoticeName: '第一次审查意见通知书', NoticeTypeCode: '210401', PostDate: '2026-08-26T00:00:00', ...over };
}

test('official conclusion reads only the documented notice type codes', () => {
  assert.deepEqual(judgeOfficialOutcome([]), { state: 'none' });
  assert.equal(judgeOfficialOutcome([notice({ NoticeName: '办理登记手续通知书', NoticeTypeCode: '200602', PostDate: '2026-09-14T00:00:00' })]).state, 'granted');
  assert.equal(judgeOfficialOutcome([notice({ NoticeName: '实用新型专利证书', NoticeTypeCode: 400002 })]).state, 'granted', 'a certificate only exists after grant');
  for (const code of ['200305', '210407', '210408']) assert.equal(judgeOfficialOutcome([notice({ NoticeName: '驳回决定', NoticeTypeCode: code })]).state, 'rejected');
  assert.equal(judgeOfficialOutcome([notice()]).state, 'none', 'an office action is not an official conclusion');
});

test('outcome precedence uses newest postDate: grant after rejection gives granted, rejection after grant gives rejected', () => {
  const reexaminedRows = [
    notice({ NoticeName: '办理登记手续通知书', NoticeTypeCode: '200602', PostDate: '2026-09-14T00:00:00' }),
    notice({ NoticeName: '驳回决定', NoticeTypeCode: '200305', PostDate: '2026-08-27T00:00:00' }),
    notice({ NoticeName: '驳回决定', NoticeTypeCode: '210407', PostDate: '2026-09-02T00:00:00' }),
  ];
  const reexaminedVerdict = judgeOfficialOutcome(reexaminedRows);
  assert.equal(reexaminedVerdict.state, 'granted', 'reexamination overturning rejection to grant is judged as granted');
  assert.equal(reexaminedVerdict.noticeTypeCode, '200602');
  assert.equal(reexaminedVerdict.postDate, '2026-09-14');

  const laterRejectionRows = [
    notice({ NoticeName: '办理登记手续通知书', NoticeTypeCode: '200602', PostDate: '2026-08-14T00:00:00' }),
    notice({ NoticeName: '驳回决定', NoticeTypeCode: '200305', PostDate: '2026-08-27T00:00:00' }),
    notice({ NoticeName: '驳回决定', NoticeTypeCode: '210407', PostDate: '2026-09-02T00:00:00' }),
  ];
  const rejectedVerdict = judgeOfficialOutcome(laterRejectionRows);
  assert.equal(rejectedVerdict.state, 'rejected');
  assert.equal(rejectedVerdict.noticeTypeCode, '210407');
  assert.equal(rejectedVerdict.postDate, '2026-09-02');

  const undatedRows = [
    notice({ NoticeName: '办理登记手续通知书', NoticeTypeCode: '200602', PostDate: '' }),
    notice({ NoticeName: '驳回决定', NoticeTypeCode: '200305', PostDate: '' }),
  ];
  assert.equal(judgeOfficialOutcome(undatedRows).state, 'granted', '0001 §3.7 recommends checking grant/certificate before rejection when undated');
});

test('outcome request carries caseId plus PagedInfo and stops as soon as a conclusion appears', async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = new BaselandClient(origin, 'token', async (input, init) => {
    assert.equal(init?.method, 'POST');
    assert.match(String(input), /\/CaseInfo\/GetNoticeListByCaseId$/);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ IsSuccess: true, Data: [notice(), notice({ NoticeName: '办理登记手续通知书', NoticeTypeCode: '200602', PostDate: '2026-09-14T00:00:00' })] });
  });
  const verdict = await client.officialOutcome(caseFixture(), new AbortController().signal);
  assert.equal(verdict.state, 'granted');
  assert.equal(verdict.noticeName, '办理登记手续通知书');
  assert.match(verdict.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].caseId, 'case-1');
  assert.deepEqual(bodies[0].PagedInfo, { PageIndex: 1, PageSize: 100 }, 'an empty body makes the endpoint answer 系统错误: e');
});

test('outcome paging walks further only while the list is full and no conclusion was found', async () => {
  const pages: number[] = [];
  const client = new BaselandClient(origin, 'token', async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    pages.push(body.PagedInfo.PageIndex);
    if (body.PagedInfo.PageIndex === 1) return Response.json({ IsSuccess: true, Data: Array.from({ length: 100 }, () => notice()) });
    return Response.json({ IsSuccess: true, Data: [notice({ NoticeName: '驳回决定', NoticeTypeCode: '200305' })] });
  });
  const verdict = await client.officialOutcome(caseFixture(), new AbortController().signal);
  assert.equal(verdict.state, 'rejected');
  assert.deepEqual(pages, [1, 2]);

  const shortPages: number[] = [];
  const shortList = new BaselandClient(origin, 'token', async (_input, init) => {
    shortPages.push(JSON.parse(String(init?.body)).PagedInfo.PageIndex);
    return Response.json({ IsSuccess: true, Data: [notice()] });
  });
  const empty = await shortList.officialOutcome(caseFixture(), new AbortController().signal);
  assert.deepEqual(empty, { state: 'none', checkedAt: empty.checkedAt });
  assert.deepEqual(shortPages, [1], 'a short page proves the list ended');
});

test('an unreadable list is never reported as “no conclusion”', async () => {
  let calls = 0;
  const full = new BaselandClient(origin, 'token', async () => {
    calls++;
    return Response.json({ IsSuccess: true, Data: Array.from({ length: 100 }, () => notice()) });
  });
  const verdict = await full.officialOutcome(caseFixture(), new AbortController().signal);
  assert.equal(verdict.state, 'none');
  assert.equal(verdict.incomplete, true, 'a truncated list must stay flagged for review');
  assert.equal(calls, 5, 'paging stops at the documented cap');

  const refused = new BaselandClient(origin, 'token', async () => Response.json({ IsSuccess: false, Message: '无访问权限' }));
  await assert.rejects(refused.officialOutcome(caseFixture(), new AbortController().signal), /无权访问/);
  const shapeless = new BaselandClient(origin, 'token', async () => Response.json({ IsSuccess: true, Data: { List: null } }));
  await assert.rejects(shapeless.officialOutcome(caseFixture(), new AbortController().signal), /结构尚未识别/);
  await assert.rejects(new BaselandClient(origin, 'token', async () => Response.json({ IsSuccess: true, Data: [] })).officialOutcome({ ...caseFixture(), remote: undefined }, new AbortController().signal), /未关联贝思兰德/);
});
