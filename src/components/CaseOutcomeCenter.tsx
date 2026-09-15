import { useState } from 'react';
import type { Case } from '../domain/workflow.ts';
import {
  OUTCOME_ORDER, OUTCOME_SOURCE_NOTE, outcomeDetail, outcomeLabel, outcomeView,
  queryOutcomeCases, stamp,
} from '../domain/outcome.ts';
import type { ArchivedScope, OutcomeFilter, OutcomeView } from '../domain/outcome.ts';
import { outcomeCounts } from '../domain/outcome.ts';
import { Empty, Note } from './Primitives.tsx';
import { desktop } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
import { ArrowUpRight, RefreshCw, Search } from 'lucide-react';
import '../outcome.css';

const CARDS: { id: OutcomeView; label: string }[] = OUTCOME_ORDER.map(id => ({ id, label: { rejected: '已驳回', granted: '已授权', none: '未见结果', unknown: '未判读' }[id] }));

export function CaseOutcomeCenter({ cases, openCase, profileKey, refresh }: {
  cases: Case[];
  openCase: (c: Case) => void;
  profileKey?: string;
  refresh?: (state: DesktopState) => void;
}) {
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<OutcomeFilter | ''>('');
  const [archived, setArchived] = useState<ArchivedScope>('active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const counted = queryOutcomeCases(cases, { search: query, archived });
  const counts = outcomeCounts(counted);
  const rows = outcome ? counted.filter(c => outcomeView(c) === outcome) : counted;
  const canRefresh = !!desktop && !!profileKey;

  async function judge() {
    if (!desktop || !profileKey) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const state = await desktop.refreshCaseOutcomes(profileKey);
      refresh?.(state);
      setNotice(`已重新判读 ${state.workspace.cases.filter(c => c.remote).length} 个贝思兰德案件。`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="outcome-center page-pad">
    <div className="page-heading"><div><h1>案件状态</h1><p>只读判读贝思兰德的官方结论：已授权或已驳回。{OUTCOME_SOURCE_NOTE}</p></div>
      <div className="heading-actions">{notice && <span className="settings-notice is-success" role="status">{notice}</span>}{canRefresh && <button className="primary" disabled={busy} onClick={() => void judge()}><RefreshCw size={16}/>{busy ? '正在判读…' : '重新判读全部案件'}</button>}</div></div>
    {error && <p role="alert" className="inline-warning">{error}</p>}
    {!canRefresh && <Note>浏览器预览不访问贝思兰德。请在桌面程序中登录后查看官方结论。</Note>}
    <div className="library-stats" role="group" aria-label="案件状态筛选">
      {CARDS.map(card => <button type="button" key={card.id} className={`library-stat${outcome === card.id ? ' selected' : ''}${card.id === 'rejected' && counts.rejected ? ' is-overdue' : ''}`} aria-pressed={outcome === card.id} onClick={() => setOutcome(current => current === card.id ? '' : card.id)}>
        <strong>{counts[card.id]}</strong><span>{card.label}</span>
      </button>)}
    </div>
    <div className="library-toolbar">
      <div className="library-toolbar-group library-filters">
        <label className="outcome-search"><Search size={16}/><input aria-label="搜索案件" placeholder="搜索案号、案件名称或公司" value={query} onChange={e => setQuery(e.target.value)}/></label>
        <label>归档<select aria-label="归档" value={archived} onChange={e => setArchived(e.target.value as ArchivedScope)}><option value="active">未归档</option><option value="archived">已归档</option><option value="all">全部</option></select></label>
        <button type="button" disabled={!query && !outcome && archived === 'active'} onClick={() => { setQuery(''); setOutcome(''); setArchived('active'); }}>重置筛选</button>
      </div>
    </div>
    {rows.length ? <div className="outcome-catalog">{rows.map(c => {
      const view = outcomeView(c);
      const updated = stamp(c.officialOutcome?.checkedAt) || '尚未判读';
      return <article className={`outcome-row is-${view}`} key={c.id}>
        <div className="outcome-row-main">
          <div className="outcome-row-title"><b title={c.title}>{c.title}</b><small>{c.number}{c.companyName ? ` · ${c.companyName}` : ''}</small></div>
          <span className={`outcome-badge is-${view}`} title={outcomeDetail(c)}>{outcomeLabel(c)}</span>
          <dl className="outcome-facts">
            <div><dt>结论依据</dt><dd>{c.officialOutcome?.noticeName || (view === 'none' ? '清单内无授权或驳回类官文' : '—')}</dd></div>
            <div><dt>官文日期</dt><dd>{c.officialOutcome?.postDate || '—'}</dd></div>
            <div><dt>判读时间</dt><dd>{c.archived ? `${updated} · 已归档` : updated}</dd></div>
          </dl>
        </div>
        <button className="outcome-open" onClick={() => openCase(c)}>打开案件<ArrowUpRight size={15}/></button>
      </article>;
    })}</div> : <Empty title="没有匹配的案件">同步个人案件后，这里会显示每个案件的官方结论。</Empty>}
    <div className="table-foot">{rows.length} 个案件<span>只读结论 · 不下文件、不写贝思兰德</span></div>
  </div>;
}
