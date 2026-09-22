import type { Case } from './workflow.ts';

// 官方结论（案件状态）：只表达贝思兰德官文清单判读出的官方结果。
// 「未见结果」只说明清单里没有授权/驳回类官文，不等于官方未授权；「未判读」表示还没查过。
export type OutcomeView = 'rejected' | 'granted' | 'none' | 'unknown';
export type OutcomeFilter = OutcomeView;
export type ArchivedScope = 'active' | 'archived' | 'all';

export const OUTCOME_ORDER: OutcomeView[] = ['rejected', 'granted', 'none', 'unknown'];
export const outcomeLabels: Record<OutcomeView, string> = { rejected: '已驳回', granted: '已授权', none: '未见结果', unknown: '未判读' };
export const OUTCOME_SOURCE_NOTE = '结论来自贝思兰德官文清单：授权=办理登记手续通知书（200602）或专利证书，驳回=驳回决定（200305/210407/210408）。';

export function outcomeApplies(c: Case): boolean {
  return c.source === 'baseland' && !!c.remote;
}

export function outcomeView(c: Case): OutcomeView {
  return c.remote && c.officialOutcome ? c.officialOutcome.state : 'unknown';
}

export function outcomeLabel(c: Case): string {
  return outcomeApplies(c) ? outcomeLabels[outcomeView(c)] : '—';
}

// 只有授权/驳回才算「官方结果已到」。未见结果与未判读都不算：官文清单不是完整历史，
// 没有查到结论不等于官方没有结论，这两类案件仍然按"等待官方"处理。
export function hasOfficialOutcome(c: Case): boolean {
  const view = outcomeView(c);
  return outcomeApplies(c) && (view === 'granted' || view === 'rejected');
}

// 结论一句话，用于案件状态与流程显示：已授权 · 办理登记手续通知书（2026-09-14）。
export function outcomeStatement(c: Case): string | undefined {
  if (!hasOfficialOutcome(c)) return undefined;
  const outcome = c.officialOutcome!;
  const name = outcome.noticeName || (outcome.state === 'granted' ? '办理登记手续通知书' : '驳回决定');
  const code = outcome.noticeTypeCode ? `（${outcome.noticeTypeCode}）` : '';
  const date = outcome.postDate ? ` ${outcome.postDate}` : '';
  return `${outcomeLabels[outcome.state]} · ${name}${code}${date}`;
}

export function stamp(value?: string): string {
  if (!value) return '';
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleString('zh-CN') : '';
}

export function outcomeDetail(c: Case): string {
  if (!outcomeApplies(c)) return '本机案件不参与贝思兰德官方结论判读。';
  const outcome = c.officialOutcome;
  if (!outcome) return `尚未判读官方结论。${OUTCOME_SOURCE_NOTE}`;
  const time = stamp(outcome.checkedAt);
  const when = time ? `判读时间：${time}` : '判读时间未记录';
  if (outcome.state === 'none') {
    const caveat = outcome.incomplete ? '官文清单未取完，结果待复核。' : '官文清单里没有授权或驳回类官文。';
    return `${caveat}${when}。`;
  }
  const name = outcome.noticeName || (outcome.state === 'granted' ? '办理登记手续通知书' : '驳回决定');
  const code = outcome.noticeTypeCode ? `（${outcome.noticeTypeCode}）` : '';
  const date = outcome.postDate ? ` · 官文日期 ${outcome.postDate}` : '';
  return `${name}${code}${date} · ${when}。${OUTCOME_SOURCE_NOTE}`;
}

export function outcomeOrder(c: Case): number {
  return OUTCOME_ORDER.indexOf(outcomeView(c));
}

function compareOutcome(a: Case, b: Case): number {
  const order = outcomeOrder(a) - outcomeOrder(b);
  if (order !== 0) return order;
  const left = a.officialOutcome?.postDate ?? '', right = b.officialOutcome?.postDate ?? '';
  if (left !== right) {
    if (!left) return 1;
    if (!right) return -1;
    return right.localeCompare(left);
  }
  return a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id);
}

export function outcomeCounts(cases: Case[]): Record<OutcomeView, number> {
  const counts: Record<OutcomeView, number> = { rejected: 0, granted: 0, none: 0, unknown: 0 };
  for (const c of cases) if (outcomeApplies(c)) counts[outcomeView(c)] += 1;
  return counts;
}

export function availableOutcomes(cases: Case[]): OutcomeView[] {
  const present = new Set(cases.filter(outcomeApplies).map(outcomeView));
  return OUTCOME_ORDER.filter(view => present.has(view));
}

export function matchesOutcome(c: Case, filter: OutcomeFilter | ''): boolean {
  if (!filter) return true;
  return outcomeApplies(c) && outcomeView(c) === filter;
}

export function matchesOutcomeSearch(c: Case, search: string): boolean {
  if (!search) return true;
  const haystack = `${c.title} ${c.companyName ?? ''} ${c.number} ${c.applicationNumber ?? ''}`.toLowerCase();
  return haystack.includes(search.toLowerCase());
}

export type OutcomeQuery = { search?: string; outcome?: OutcomeFilter | ''; archived?: ArchivedScope };

export function queryOutcomeCases(cases: Case[], query: OutcomeQuery = {}): Case[] {
  const { search = '', outcome = '', archived = 'active' } = query;
  const rows = cases.filter(c =>
    outcomeApplies(c)
    && matchesOutcomeSearch(c, search)
    && (archived === 'all' || (archived === 'archived' ? c.archived : !c.archived)),
  );
  const filtered = outcome ? rows.filter(c => matchesOutcome(c, outcome)) : rows;
  return [...filtered].sort(compareOutcome);
}
