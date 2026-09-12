import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Archive, ArrowUpRight, CheckSquare, Download, Folder, Plus, Search, X } from 'lucide-react';
import type { Case } from '../domain/workflow.ts';
import {
  businessKind, daysUntilDeadline, deadlineView, DEADLINE_HEADER, isUrgencyEligible, libraryStatus, moduleLabels, nextLibrarySort, progressStatusLabel, queryLibrary,
} from '../domain/library.ts';
import type { ArchivedFilter, BusinessKind, CardId, Module, ProgressStatus, SortDir, SortKey, LibraryScope } from '../domain/library.ts';
import { Empty } from './Primitives.tsx';
import { desktop } from '../desktop.ts';
import '../library.css';

export type { Module };
export { moduleLabels };

const COLUMNS = [
  { id: 'title', label: '案件名称', min: 160, max: 640, defaultWidth: 240 },
  { id: 'company', label: '公司名称', min: 100, max: 640, defaultWidth: 180 },
  { id: 'type', label: '专利类型', min: 72, max: 640, defaultWidth: 88 },
  { id: 'business', label: '办理业务', min: 88, max: 640, defaultWidth: 108 },
  { id: 'status', label: '当前状态', min: 88, max: 640, defaultWidth: 112 },
  { id: 'deadline', label: DEADLINE_HEADER, min: 120, max: 640, defaultWidth: 136 },
] as const;
type ColumnId = typeof COLUMNS[number]['id'];
type Widths = Record<ColumnId, number>;
const SELECT_COL = 52;
const OPEN_COL = 40;
const WIDTHS_KEY = 'patent-workbench.library-column-widths.v1';
const COLUMN_SORT: Record<ColumnId, SortKey> = {
  title: 'title', company: 'company', type: 'patentType', business: 'business', status: 'status', deadline: 'deadline',
};
const CARDS: { id: CardId; label: string }[] = [
  { id: 'active', label: '在办' },
  { id: 'overdue', label: '已超期' },
  { id: 'today', label: '今天到期' },
  { id: 'near', label: '临近期限' },
  { id: 'waitingOfficial', label: '等待官方' },
];
const BIZ_CLASS: Record<BusinessKind, string> = {
  申请: 'apply', '审查意见': 'oa', 补正: 'correction', 审查: 'review', 其他: 'other',
};

function clampWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function defaultWidths(): Widths {
  return { title: 240, company: 180, type: 88, business: 108, status: 112, deadline: 136 };
}

function sanitizeWidths(input: Partial<Record<string, unknown>> | Widths): Widths {
  const next = defaultWidths();
  for (const column of COLUMNS) {
    const value = input[column.id];
    if (typeof value === 'number' && Number.isFinite(value)) next[column.id] = clampWidth(value, column.min, column.max);
  }
  return next;
}

function readStoredWidths(): Widths {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    if (!raw) return defaultWidths();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!('company' in parsed) && parsed.status === 148) parsed.status = 112;
    return sanitizeWidths(parsed);
  } catch {
    return defaultWidths();
  }
}

function persistWidths(next: Widths) {
  try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(sanitizeWidths(next))); } catch { /* persist column widths only; ignore quota */ }
}

function tableWidth(widths: Widths, selecting: boolean) {
  return (selecting ? SELECT_COL : 0) + OPEN_COL + COLUMNS.reduce((sum, column) => sum + widths[column.id], 0);
}

function deadlineHint(c: Case, now: Date): string | null {
  if (!isUrgencyEligible(c)) return null;
  const days = daysUntilDeadline(c, now);
  if (days === null) return null;
  if (days < 0) return `已超过 ${-days} 天`;
  if (days === 0) return '今天到期';
  if (days <= 14) return `还有 ${days} 天`;
  return null;
}

export function Library({ cases, openCase, onImport, module, archiveCases, scope = 'all' }: { scope?: LibraryScope; cases: Case[]; openCase: (c: Case) => void; onImport: () => void; module?: Module; archiveCases: (ids: string[], archived: boolean) => void }) {
  const now = new Date();
  const [query, setQuery] = useState('');
  const [patentType, setPatentType] = useState('');
  const [business, setBusiness] = useState('');
  const [progress, setProgress] = useState<ProgressStatus | ''>('');
  const [card, setCard] = useState<CardId | null>(null);
  const [archived, setArchived] = useState<ArchivedFilter>('active');
  const [sortKey, setSortKey] = useState<SortKey>('deadline');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [widths, setWidths] = useState<Widths>(readStoredWidths);
  const [columnResizeActive, setColumnResizeActive] = useState(false);
  const widthsRef = useRef(widths);
  const resizingRef = useRef<{ id: ColumnId; startX: number; startWidth: number; via: 'pointer' | 'keyboard'; pointerId?: number } | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const result = queryLibrary(cases, { scope, module, search: query, patentType, business, progress, card, archived, sortKey, sortDir, now });
  const filtered = result.rows;
  const filtersOn = !!(patentType || business || progress || card || archived !== 'active');

  function commitWidths(next: Widths) {
    widthsRef.current = next;
    setWidths(next);
  }

  function detachPointerTracking() {
    pointerCleanupRef.current?.();
    pointerCleanupRef.current = null;
  }

  function applyResize(clientX: number) {
    const session = resizingRef.current;
    if (!session || session.via !== 'pointer') return;
    const spec = COLUMNS.find(column => column.id === session.id)!;
    const next = { ...widthsRef.current, [session.id]: clampWidth(session.startWidth + clientX - session.startX, spec.min, spec.max) };
    commitWidths(next);
    persistWidths(next);
  }

  function endResize() {
    detachPointerTracking();
    if (!resizingRef.current) return;
    resizingRef.current = null;
    persistWidths(widthsRef.current);
    setColumnResizeActive(false);
  }

  function onResizePointerDown(event: ReactPointerEvent<HTMLElement>, id: ColumnId) {
    event.preventDefault();
    event.stopPropagation();
    detachPointerTracking();
    const pointerId = event.pointerId;
    resizingRef.current = { id, startX: event.clientX, startWidth: widthsRef.current[id], via: 'pointer', pointerId };
    setColumnResizeActive(true);
    const move = (moveEvent: PointerEvent) => { if (moveEvent.pointerId === pointerId) applyResize(moveEvent.clientX); };
    const stop = (stopEvent: PointerEvent) => { if (stopEvent.pointerId === pointerId) endResize(); };
    const blur = () => { endResize(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', blur);
    pointerCleanupRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', blur);
    };
    try { event.currentTarget.setPointerCapture(pointerId); } catch { /* window listeners still track the drag */ }
  }

  function onLostPointerCapture(event: ReactPointerEvent<HTMLElement>) {
    if (resizingRef.current?.via !== 'pointer') return;
    if (resizingRef.current.pointerId !== undefined && resizingRef.current.pointerId !== event.pointerId) return;
    persistWidths(widthsRef.current);
    if (event.buttons !== 0 && pointerCleanupRef.current) return;
    endResize();
  }

  function onResizeKeyDown(event: ReactKeyboardEvent<HTMLElement>, id: ColumnId) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const spec = COLUMNS.find(column => column.id === id)!;
    const delta = event.key === 'ArrowRight' ? 8 : -8;
    setColumnResizeActive(true);
    resizingRef.current = { id, startX: 0, startWidth: widthsRef.current[id], via: 'keyboard' };
    commitWidths({ ...widthsRef.current, [id]: clampWidth(widthsRef.current[id] + delta, spec.min, spec.max) });
  }

  function onResizeKeyUp() {
    if (resizingRef.current?.via !== 'keyboard') return;
    persistWidths(widthsRef.current);
    resizingRef.current = null;
    setColumnResizeActive(false);
  }

  function openRow(c: Case) {
    if (columnResizeActive || resizingRef.current) return;
    openCase(c);
  }

  function resetFilters() {
    setPatentType('');
    setBusiness('');
    setProgress('');
    setCard(null);
    setArchived('active');
  }

  function exportCases() {
    const chosen = cases.filter(c => selected.includes(c.id));
    const blob = new Blob([JSON.stringify({ kind: 'prototype-case-snapshots', disclaimer: '虚构原型记录，不是真实案件材料包', cases: chosen }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = '所选案件-原型快照.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const colCount = (selecting ? 1 : 0) + COLUMNS.length + 1;
  const sumWidth = tableWidth(widths, selecting);
  const widthStyle = { width: '100%', minWidth: `max(100%, ${sumWidth}px)` };

  return <div className={`library page-pad${columnResizeActive ? ' is-resizing' : ''}`}>
    <div className="page-heading"><div><h1>{scope === 'official' ? '等待官方' : module ? moduleLabels[module] : '案件库'}</h1><p>{scope === 'official' ? '本案内部递交已完成，继续跟踪官方回执和处理结果。收到新办理任务后自动回到案件库。' : module === 'transfer' ? '显示当前可核对、保存或内部转交的贝思兰德案件，不要求先在本机定稿。' : module ? '这里只显示当前处于此业务阶段的案件。' : '让材料、讨论与每一份成果，各归其位。'}</p></div>{scope !== 'official' && <button className="primary" onClick={onImport}><Plus size={17}/>{module ? '返回案件库' : desktop ? '新建本地案件' : '导入通知书'}</button>}</div>
    {!desktop && module && module !== 'reply' && <div className="quiet-banner">交互示例 · {module === 'write' ? '从技术交底到申请文件，保存版本后进入独立审查。' : module === 'review' ? '独立选择文件，问题可定位原文并记录处理意见。' : '选择定稿成果，核对表单与下一内部办理人。'}</div>}
    <div className="library-stats" role="group" aria-label="案件统计筛选">
      {CARDS.filter(item => scope === 'all' || (scope === 'official' ? item.id === 'waitingOfficial' : item.id !== 'waitingOfficial')).map(item => <button type="button" key={item.id} className={`library-stat${card === item.id ? ' selected' : ''}${item.id === 'overdue' && result.counts[item.id] ? ' is-overdue' : ''}`} aria-pressed={card === item.id} onClick={() => { setCard(current => current === item.id ? null : item.id); setArchived('active'); }}>
        <strong>{result.counts[item.id]}</strong><span>{item.label}</span>
      </button>)}
    </div>
    <div className="library-toolbar">
      <div className="library-toolbar-group library-filters" role="group" aria-label="筛选">
        <label>专利类型<select aria-label="专利类型" value={patentType} onChange={e => setPatentType(e.target.value)}><option value="">全部类型</option>{result.availablePatentTypes.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
        <label>办理业务<select aria-label="办理业务" value={business} onChange={e => setBusiness(e.target.value)}><option value="">全部业务</option>{result.availableBusinessKinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
        <label>办理状态<select aria-label="办理状态" value={progress} onChange={e => setProgress(e.target.value as ProgressStatus | '')}><option value="">全部状态</option>{result.availableProgressStatuses.map(status => <option key={status} value={status}>{progressStatusLabel(status, module)}</option>)}</select></label>
        <label>归档<select aria-label="归档" value={archived} onChange={e => setArchived(e.target.value as ArchivedFilter)}><option value="active">未归档</option><option value="archived">已归档</option><option value="all">全部</option></select></label>
        <button type="button" disabled={!filtersOn} onClick={resetFilters}>重置筛选</button>
      </div>
      <div className="library-toolbar-group table-tools">
        <label className="search"><Search size={16}/><input aria-label="搜索案件" placeholder="搜索案件、公司、申请号或标签" value={query} onChange={e => setQuery(e.target.value)}/></label>
        <button type="button" className={selecting ? 'selected icon-button' : 'icon-button'} aria-label="批量操作" aria-pressed={selecting} onClick={() => setSelecting(!selecting)}><CheckSquare size={17}/></button>
      </div>
    </div>
    {selecting && <div className="batch-actions"><label className="checkbox"><input type="checkbox" aria-label="选择当前结果" checked={!!filtered.length && filtered.every(c => selected.includes(c.id))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...filtered.map(c => c.id)])] : selected.filter(id => !filtered.some(c => c.id === id)))}/>已选 {selected.length} 案</label>{!desktop && <button type="button" disabled={!selected.length} onClick={exportCases}><Download size={14}/>下载示例快照</button>}<button type="button" disabled={!selected.length} onClick={() => { archiveCases(selected, archived !== 'archived'); setSelected([]); }}><Archive size={14}/>{archived === 'archived' ? '取消归档' : '归档'}</button><button type="button" className="icon-button" aria-label="结束批量选择" onClick={() => { setSelecting(false); setSelected([]); }}><X size={15}/></button></div>}
    <div className={`library-table-scroll${selecting ? ' selectable' : ''}`}>
      <table className="library-table" style={widthStyle}>
        <caption className="library-caption">案件列表</caption>
        <colgroup>
          {selecting && <col style={{ width: SELECT_COL }}/>}
          {COLUMNS.map(column => <col key={column.id} style={{ width: widths[column.id] }}/>)}
          <col style={{ width: OPEN_COL }}/>
        </colgroup>
        <thead>
          <tr>
            {selecting && <th scope="col"><span className="library-sr">选择</span></th>}
            {COLUMNS.map(column => {
              const key = COLUMN_SORT[column.id];
              const sorted = sortKey === key;
              return <th scope="col" key={column.id} aria-sort={sorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <div className="library-th">
                  <button type="button" className={`library-th-sort${sorted ? ' is-sorted' : ''}`} onClick={() => {
                    const next = nextLibrarySort(sortKey, sortDir, key);
                    setSortKey(next.sortKey); setSortDir(next.sortDir);
                  }}><span className="library-th-sort-label">{column.label}</span>{sorted && <span className="library-sort-arrow" aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>}</button>
                  <span role="separator" tabIndex={0} className="library-col-resizer" aria-label={`调整${column.label}列宽`} aria-orientation="vertical" aria-valuemin={column.min} aria-valuemax={column.max} aria-valuenow={widths[column.id]} aria-valuetext={`${widths[column.id]} 像素`}
                    onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
                    onPointerDown={event => onResizePointerDown(event, column.id)}
                    onPointerMove={event => { if (resizingRef.current) applyResize(event.clientX); }}
                    onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={onLostPointerCapture}
                    onKeyDown={event => onResizeKeyDown(event, column.id)} onKeyUp={onResizeKeyUp} onBlur={onResizeKeyUp}/>
                </div>
              </th>;
            })}
            <th scope="col"><span className="library-sr">打开</span></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(c => {
            const due = deadlineView(c);
            const days = daysUntilDeadline(c, now);
            const overdue = isUrgencyEligible(c) && days !== null && days < 0;
            const status = libraryStatus(c);
            const kind = businessKind(c);
            const hint = deadlineHint(c, now);
            return <tr key={c.id} tabIndex={0} onClick={() => openRow(c)} onKeyDown={event => {
              if (columnResizeActive || resizingRef.current) return;
              if ((event.target as HTMLElement).closest('input,button,select,label,[role="separator"]')) return;
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRow(c); }
            }}>
              {selecting && <td className="library-select" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                <label className="library-check-target"><input type="checkbox" aria-label={`选择${c.title}`} checked={selected.includes(c.id)} onChange={event => setSelected(event.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id))}/></label>
              </td>}
              <td className="library-title-cell">
                <span className="library-case">
                  <span className="case-file"><Folder size={18}/></span>
                  <span className="library-case-text">
                    <b title={c.title}>{c.title}</b>
                    <small title={`${c.number}${c.tags.length ? ` · ${c.tags.join(' / ')}` : ''}`}>{c.number}{c.tags.length ? ` · ${c.tags.join(' / ')}` : ''}</small>
                  </span>
                </span>
              </td>
              <td><span className="library-company" title={c.companyName || '未提供客户名称'}>{c.companyName || '—'}</span></td>
              <td>{c.type || '—'}</td>
              <td><span className={`library-biz library-biz-${BIZ_CLASS[kind]}`}>{kind}</span></td>
              <td><span className="library-status" title={status.full}>{status.short}</span></td>
              <td>
                <span className={`library-deadline${overdue ? ' is-overdue' : ''}`} title={due.ordinal === null ? (due.source === 'local' ? '自设日期未提供' : '办理期限未提供') : `${due.display} · ${due.label}`}>
                  <span>{due.display}</span>
                  {due.ordinal !== null && <small>{due.label}</small>}
                  {hint && <small className={`deadline-hint${overdue ? ' is-overdue' : ''}`}>{hint}</small>}
                </span>
              </td>
              <td className="library-open"><ArrowUpRight size={16} aria-hidden="true"/></td>
            </tr>;
          })}
          {!filtered.length && <tr className="library-empty-row"><td colSpan={colCount}><Empty title="没有匹配的案件">调整筛选或搜索条件，已有案件会保留。</Empty></td></tr>}
        </tbody>
      </table>
    </div>
    <div className="table-foot">{filtered.length} 个案件<span>{desktop ? '当前账号的案件 · 本地文件保存' : '示例数据 · 浏览器预览'}</span></div>
  </div>;
}
