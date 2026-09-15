import { useEffect, useState } from 'react';
import type { Case } from '../domain/workflow.ts';
import type { LocalProgress } from '../domain/local-progress.ts';
import { currentWork, editableCurrent, processSubmission } from '../domain/lifecycle.ts';
import { desktop, agentProcessKey } from '../desktop.ts';
import { currentHandling } from '../domain/handling.ts';
import { WRITING_PHASES } from '../professional-api.ts';
import { OUTCOME_ORDER, hasOfficialOutcome, outcomeApplies, outcomeDetail, outcomeLabel, outcomeView, matchesOutcome, outcomeLabels } from '../domain/outcome.ts';
import type { OutcomeFilter } from '../domain/outcome.ts';
import { localWorkflowPhase } from '../domain/stage-verdict.ts';
import '../outcome.css';

import { workflowBusiness, workflowNodes, workflowNodeStatus } from '../domain/workflow-nodes.ts';
function phase(c: Case) {
  const w = currentWork(c), p = c.remote?.processes.find(p => p.id === w.processId);
  return localWorkflowPhase({ submission: processSubmission(c), status: p?.status, handId: p?.handId, needSendOfficial: p?.needSendOfficial });
}
export function LocalWorkflow({ profileKey, cases, open }: { profileKey: string; cases: Case[]; open: (item: Case) => void }) {
  const [rows, setRows] = useState<LocalProgress[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('active');
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter | ''>('');
  const owned = cases.filter(c => !c.archived && (c.source === 'baseland' || editableCurrent(c)));
  const signature = owned.map(c => c.id + ':' + agentProcessKey(c) + ':' + JSON.stringify(c.remote?.processes)).join('|');
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (!desktop?.agent.listProgress) throw new Error('请更新桌面程序后查看本机进度。');
        const progress = await desktop.agent.listProgress(profileKey);
        const additional = await Promise.all(owned.filter(c => ['write', 'review'].includes(workflowBusiness(c))).map(async c => {
          const view = await desktop!.professional.getCase(profileKey, c.id);
          const existing = progress.find(p => p.caseId === c.id && p.processKey === agentProcessKey(c));
          const record = view.record;
          return { caseId: c.id, processKey: agentProcessKey(c), openedAt: existing?.openedAt, running: view.busy,
            steps: [{ label: '打开案件', done: !!existing?.openedAt, at: existing?.openedAt },
              ...(workflowBusiness(c) === 'write' ? WRITING_PHASES.map((label, index) => ({ label: '确认' + label, done: record.confirmations.some(x => x.phase === index), at: record.confirmations.find(x => x.phase === index)?.at }))
                : [{ label: '准备审查稿件', done: record.sources.length > 0 }, { label: '完成独立审查', done: record.jobs.some(j => j.kind === 'review' && j.state === 'completed') }])],
          } satisfies LocalProgress;
        }));
        if (active) { setRows([...progress.filter(p => !additional.some(a => a.caseId === p.caseId)), ...additional]); setError(''); setLoading(false); }
      } catch (e) { if (active) { setError((e as Error).message); setLoading(false); } }
    };
    void load();
    // This overview is refreshed when returning to it. No model or remote workflow query is started.
    return () => { active = false; };
  }, [profileKey, signature]);
  const visible = owned.map(c => ({ c, progress: rows.find(p => p.caseId === c.id && p.processKey === agentProcessKey(c)) }))
    .filter(({ c, progress }) => (!query || (c.number + c.title + (c.companyName ?? '')).toLowerCase().includes(query.toLowerCase()))
      && matchesOutcome(c, outcomeFilter)
      && (filter === 'all' || filter === 'active' && phase(c) !== 'done' || filter === 'unopened' && phase(c) === 'pending' || filter === 'working' && phase(c) === 'working' || filter === 'done' && phase(c) === 'done' || filter === 'unknown' && phase(c) === 'unknown'));
  return <section className="page-pad local-workflow"><h1>内部流转</h1><p>按待处理、递交办理中、已递交官方查看案件；完整展示本次办理节点；过程稿保存在本地。案件状态为贝思兰德官文判读的官方结论。</p>
    <div className="local-workflow-filters"><input aria-label="搜索本地办理案件" placeholder="搜索案号、名称或公司" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="本地办理状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">当前办理</option><option value="all">全部案件</option><option value="unopened">待处理</option><option value="working">递交办理中</option><option value="done">已递交官方</option><option value="unknown">完成结果待核对</option></select><select aria-label="案件状态" value={outcomeFilter} onChange={e => setOutcomeFilter(e.target.value as OutcomeFilter | '')}><option value="">全部案件状态</option>{OUTCOME_ORDER.map(view => <option key={view} value={view}>{outcomeLabels[view]}</option>)}</select></div>
    {error && <p role="alert">{error}</p>}{loading ? <p>正在读取本机办理记录…</p> : <>
      {!visible.length && <p>当前筛选下没有在手案件。</p>}
      {visible.map(({ c, progress }) => {
        const steps = workflowNodes(c, progress);
        const next = steps.find(step => step.state === 'current');
        const handling = currentHandling(c);
        const stage = phase(c);
        const concluded = hasOfficialOutcome(c);
        // 已出官方结论：状态直接显示结论，不再显示"已递交官方 / 等待后续通知"。
        const status = concluded ? outcomeLabel(c) : stage === 'done' ? '已完成 · 已递交官方' : stage === 'pending' ? '待处理 · 尚未启动递交' : stage === 'unknown' ? '已完成 · 官方结果待核对' : c.source === 'baseland' ? `递交中 · ${handling.handler ?? '办理人待核对'} · ${handling.node}` : '本机办理中';
        const caption = concluded ? `官方结论已到（${c.officialOutcome?.noticeName || '官文'}${c.officialOutcome?.postDate ? ` · ${c.officialOutcome.postDate}` : ''}），本次办理结束。` : stage === 'done' ? '本次办理已完成，等待官方后续通知。' : progress?.running ? '任务运行中' : next ? '当前：' + next.label : '按当前办理人跟踪进度。';
        return <article className="local-workflow-case" key={c.id}><header><div><h3>{c.title}</h3><p className="workflow-company">{c.companyName || '客户公司未提供'}</p><p className="workflow-meta"><span>{c.number}</span><span className="workflow-type">{c.type || '案件类型未提供'}</span><span className="workflow-status">{status}</span>{outcomeApplies(c) && <span className={`outcome-badge is-${outcomeView(c)}`} title={outcomeDetail(c)}>案件状态 · {outcomeLabel(c)}</span>}</p><small>{caption}</small></div><button onClick={() => open(c)}>{stage==='done'?'查看案件':'进入案件'}</button></header>
          <ol className="workflow-nodes" aria-label="完整办理节点">{steps.map((step, index) => <li key={step.label} className={step.state}><span>{step.state === 'done' ? '✓' : index + 1}</span><div>{step.label}<small>{step.closedBySubmission ? '随本次提交结束' : workflowNodeStatus[step.state]}{step.at ? ' · ' + new Date(step.at).toLocaleDateString() : ''}</small>{step.detail && <small>{step.detail}</small>}</div></li>)}</ol>
          {steps.some(s => s.closedBySubmission) && <small className="workflow-legend">已提交官方，前序节点统一结束；未记录节点不补造本机操作时间。</small>}{steps.some(s => s.state === 'unknown') && <small className="workflow-legend">无记录：本机没有该节点的历史凭据，不代表未办理。</small>}
          {stage !== 'done' && progress?.error && <p>最近任务失败：{progress.error}</p>}
        </article>;
      })}
    </>}
  </section>;
}
