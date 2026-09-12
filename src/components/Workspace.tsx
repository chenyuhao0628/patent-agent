import { useEffect, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Download, FileText, History, Pause, Play } from 'lucide-react';
import { canFinalize, isSaved, jobLabels, stages } from '../domain/workflow.ts';
import type { Action, Case, Material, Round, Stage } from '../domain/workflow.ts';
import { Discussion } from './Discussion.tsx';
import { Modal, Note, Ready } from './Primitives.tsx';

type Props = { item: Case; round: Round; dispatch: (a: Action) => void };
export function Workspace({ item, round: r, dispatch }: Props) {
  const [view, setView] = useState<Stage | null>(null);
  const [material, setMaterial] = useState<Material | null>(null);
  const [versionId, setVersionId] = useState('');
  const [showFinalize, setShowFinalize] = useState(false);
  const active = view ?? r.stage;
  const currentIndex = stages.findIndex(s => s.id === r.stage);
  const dispatchAndFollow = (a: Action) => { setView(null); dispatch(a); };
  useEffect(() => { window.scrollTo(0, 0); }, [r.stage]);
  const oldVersion = r.versions.find(v => v.id === versionId);
  function exportSnapshot() {
    const blob = new Blob([JSON.stringify({ kind: 'prototype-snapshot', disclaimer: '示例数据；不是 Word 定稿文件', caseNumber: item.number, round: r.name, final: r.final, versions: r.versions }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${item.number}-${r.name}-原型快照.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="workspace" aria-label="案件工作区">
    <nav className="stepper" aria-label="答复阶段">{stages.map((s, i) => <button key={s.id} className={`${active === s.id ? 'current' : ''} ${i < currentIndex ? 'done' : ''}`} disabled={i > currentIndex} onClick={() => setView(s.id)}><span>{i < currentIndex ? <Check size={14}/> : ''}</span>{s.label}</button>)}</nav>
    {r.job && <div className="job-banner" role="status"><span><i className={r.job.status === 'running' ? 'pulse' : ''}/>{jobLabels[r.job.kind]} · {r.job.status === 'running' ? '演示任务运行中' : '已暂停，等待你继续'}</span>
      <button onClick={() => dispatch({ type: r.job!.status === 'running' ? 'pause' : 'resume' })}>{r.job.status === 'running' ? <Pause size={16}/> : <Play size={16}/>} {r.job.status === 'running' ? '停止任务' : '继续任务'}</button></div>}
    {active === 'materials' && <>
      <div className="section-heading"><h3>本轮材料</h3><span className="muted">{r.materials.length} 份示例材料 · 原件保留</span></div>
      <div className="material-list">{r.materials.map(m => <button key={m.id} onClick={() => setMaterial(m)} className="material-row"><FileText/><span>{m.name}<small>{m.role}</small></span>{m.ready ? <Ready/> : <span className="warning">材料缺失</span>}<ChevronRight size={15}/></button>)}</div>
      <Note>点击文件查看示例片段与定位；真实文件尚未导入、解析或由模型阅读。</Note>
      <div className="action-bar"><label className="checkbox"><input type="checkbox" checked={r.confirmed} disabled={r.stage !== 'materials' || !!r.job} onChange={e => dispatch({ type: 'confirm', value: e.target.checked })}/>我已核对本轮材料</label>
        {r.stage === 'materials' ? <button className="primary" disabled={!r.confirmed || !!r.job || !r.materials.every(m => m.ready)} onClick={() => dispatchAndFollow({ type: 'start', kind: 'analysis' })}>开始答复</button> : <button onClick={() => setView(null)}>返回当前阶段<ChevronRight size={16}/></button>}</div>
    </>}
    {active === 'strategy' && <>
      <div className="section-heading"><h3>意见拆解与策略</h3><span className="muted">示例分析</span></div>
      <p className="analysis-summary">本轮需回应技术特征的区别，并核对修改依据。先比较保护范围与答复路径，再决定如何起草。</p>
      <button className="source-link" onClick={() => setMaterial(r.materials[0])}>当前通知书.pdf · 第 2 页 · 意见 1<ChevronRight size={14}/></button>
      <div className="strategies">{['解释差异，维持现有文本', '补充限定，并逐项说明依据'].map((strategy, i) => <div className="strategy" key={strategy}><span className="strategy-number">0{i + 1}</span><div><h4>{strategy}</h4><p>{i === 0 ? '优先说明现有特征及其配合关系。需有充分的材料依据支持与对比文件的区别。' : '围绕原始披露增加具体限定。需评估范围收窄的影响，并核对每项修改依据。'}</p><button className="source-link" onClick={() => setMaterial(r.materials[i + 1])}>{r.materials[i + 1].name}<ChevronRight size={14}/></button></div><button disabled={!!r.job || r.stage !== 'strategy'} onClick={() => dispatchAndFollow({ type: 'start', kind: 'drafting', strategy })}>选定并起草</button></div>)}</div>
      {r.strategy && <Note>已选定：{r.strategy}</Note>}<Discussion round={r} dispatch={dispatch}/>
    </>}
    {active === 'draft' && <>
      <div className="section-heading draft-heading"><h3>答复稿件</h3><span className="muted">{isSaved(r) ? `已保存 · v${r.versions.length}` : '有未保存修改'}</span></div>
      <div className="editor-toolbar"><select aria-label="稿件版本" value={versionId} onChange={e => setVersionId(e.target.value)}><option value="">当前工作稿</option>{r.versions.map((v, i) => <option key={v.id} value={v.id}>v{i + 1} · {v.label}</option>)}</select><button onClick={() => setView('materials')}><FileText size={15}/>查看材料</button><button disabled={!!oldVersion || isSaved(r) || !r.draft.trim() || !!r.job || !!r.final} onClick={() => dispatch({ type: 'save' })}><History size={15}/>保存新版本</button><button className="primary" disabled={!isSaved(r) || !!r.job || !!r.final} onClick={() => dispatchAndFollow({ type: 'start', kind: 'reviewing' })}>提交独立复核</button></div>
      {oldVersion && <Note>历史版本只读。选择“当前工作稿”继续编辑。</Note>}
      <div className="draft-layout"><div className="document-paper"><div className="document-title"><h3>{r.name.includes('补正') ? '补正说明' : '意见陈述书'}</h3><span>示例稿件</span></div><textarea className="document-editor" aria-label="答复正文" value={oldVersion?.text ?? r.draft} readOnly={!!oldVersion || !!r.job || !!r.final} onChange={e => dispatch({ type: 'edit', text: e.target.value })}/><div className="document-footer"><span>直接修改会使旧复核失效</span><span>原型示例 · 未连接模型</span></div></div><Discussion round={r} dispatch={dispatch}/></div>
    </>}
    {active === 'review' && <>
      <div className="section-heading"><h3>独立复核</h3><span className="muted">针对 v{r.versions.length} · 演示结果</span></div>
      <Note>正式产品将使用单独 AI 上下文。当前展示预设问题，未执行真实 AI 复核。</Note>
      {r.review && <div className="review-finding"><span className="review-index">01</span><div><h4>修改依据需逐项确认</h4><p>{r.review.finding}</p><button className="source-link" onClick={() => setMaterial(r.materials[1])}>原始申请文件.docx · 第 4 页<ChevronRight size={14}/></button><label className="checkbox"><input type="checkbox" checked={r.review.resolved} disabled={r.review.resolved} onChange={() => dispatch({ type: 'resolve' })}/>我已核对并处理此示例问题</label></div></div>}
      <div className="action-bar"><button onClick={() => { setView('draft'); dispatch({ type: 'discuss', discussionId: r.discussions[0].id, text: `处理独立复核问题：${r.review?.finding ?? ''}` }); }}><ArrowLeft size={16}/>返回原讨论修改</button><button className="primary" disabled={!canFinalize(r)} onClick={() => setShowFinalize(true)}>定稿<Check size={16}/></button></div>
      <button className="text-button" disabled={!isSaved(r) || !!r.job} onClick={() => dispatchAndFollow({ type: 'start', kind: 'reviewing' })}>再次独立复核</button>
    </>}
    {active === 'final' && <>
      <div className="final-heading"><span className="success-circle"><Check/></span><div><h3>本轮已定稿 · 演示</h3><p>已冻结 v{r.versions.findIndex(v => v.id === r.final?.versionId) + 1}，可下载原型快照。</p></div></div>
      <div className="output-list">{[r.name.includes('补正') ? '补正说明' : '意见陈述书', '本次实际修改的申请文本', '逐项修改依据', '内部复核说明'].map((name, i) => <div key={name}><FileText size={20}/><span>{name}</span><small>{i < 2 ? 'Word 模板待提供' : '正式生成待接入'}</small></div>)}</div>
      <Note>目前没有生成 Word 文件；用户既有模板将在实施阶段适配和验证。</Note>
      <div className="action-bar"><button onClick={() => dispatchAndFollow({ type: 'revise' })}>继续修改新版本</button><button className="primary" onClick={exportSnapshot}><Download size={17}/>下载原型快照</button></div>
    </>}
    {material && <Modal title={material.name} onClose={() => setMaterial(null)}><span className="tag">示例片段</span><h3>{material.role}</h3><p className="muted">{item.number} / {r.name} / {material.location}</p><blockquote>{material.excerpt}</blockquote><Note>本页面不是 PDF / Word 渲染。片段为虚构文本，用于讨论引用定位交互。</Note></Modal>}
    {showFinalize && <Modal title="确认本轮定稿" onClose={() => setShowFinalize(false)}><p>将冻结“{item.title}”的{r.name}，稿件版本为 v{r.versions.length}。</p><Note>本次仅演示定稿状态。Word 模板尚未提供，不会产生正式 Word 文件。</Note><div className="action-bar"><button onClick={() => setShowFinalize(false)}>返回检查</button><button className="primary" onClick={() => { dispatchAndFollow({ type: 'finalize' }); setShowFinalize(false); }}>确认定稿（演示）</button></div></Modal>}
  </section>;
}
