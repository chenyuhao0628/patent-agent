import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronRight, FileText, Files, FolderOpen, Highlighter, MessageSquare, ShieldCheck } from 'lucide-react';
import type { Case } from '../domain/workflow.ts';
import { isWritingSaved, makeReview, replaceReview, reviewMatchesWriting, sampleDocuments } from '../domain/designFlows.ts';
import type { ApplicationReview, CaseDesign, ReviewIssue } from '../domain/designFlows.ts';
import { Modal, Note } from './Primitives.tsx';

type Props={item:Case;design:CaseDesign;update:(d:CaseDesign)=>void;openWriting:()=>void;openMaterials:()=>void};
export function ReviewWorkbench({item,design:d,update,openWriting,openMaterials}:Props){
  const [mode,setMode]=useState(d.review?'issues':'select');
  useEffect(()=>{ window.scrollTo(0,0); },[mode]);
  const [source,setSource]=useState<ApplicationReview['source']>(isWritingSaved(d.writing)?'writing':'case');
  const [selected,setSelected]=useState(['claims','description','abstract','figures']);
  const [issueId,setIssueId]=useState('scope');
  const [onlyOpen,setOnlyOpen]=useState(false);
  const [editing,setEditing]=useState(false);
  const [highlight,setHighlight]=useState(true);
  const [manualDocId,setManualDocId]=useState('');
  const paper=useRef<HTMLDivElement>(null);
  useEffect(()=>{ paper.current?.querySelector('.located')?.scrollIntoView({block:'nearest'}); },[issueId,manualDocId]);
  const latest=d.writing.versions.at(-1);
  const inputDocs=source==='writing'?(latest?.documents??[]):sampleDocuments(item.title);
  const picked=inputDocs.filter(x=>selected.includes(x.id));
  const r=d.review;
  const issues=r?.issues.filter(x=>!onlyOpen||x.disposition==='open')??[];
  const issue=issues.find(i=>i.id===issueId)??issues[0];
  const doc=r?.documents.find(x=>x.id===(manualDocId||issue?.documentId))??r?.documents[0];
  const allHandled=!!r&&r.issues.every(i=>i.disposition!=='open');
  const sourceLabel=source==='writing'?`撰写 v${d.writing.versions.length}`:source==='case'?'本案材料 · 示例版本':'外部申请文件 · 示例版本';
  function begin(){
    if(!picked.length||source==='writing'&&!isWritingSaved(d.writing))return;
    update(replaceReview(d,makeReview(source,source==='writing'?latest!.id:crypto.randomUUID(),sourceLabel,picked)));
    setMode('issues');setIssueId('scope');setOnlyOpen(false);setManualDocId('');
  }
  function record(patch:Partial<ReviewIssue>){
    if(!r||!issue)return;
    update({...d,review:{...r,completed:false,issues:r.issues.map(x=>x.id===issue.id?{...x,...patch}:x)}});setEditing(false);
  }
  return <section className={`business-workspace ${mode==='issues'?'review-focus':''}`} aria-label="独立审查工作区">
    <div className="business-title"><div><h2>独立审查</h2><p>锁定一组文件版本，逐项核对问题与原文。</p></div><span className="preview-label">后续模块 · 交互示例</span></div>
    <nav className="process-tabs" aria-label="独立审查阶段">{[['select','选择文件'],['locked','锁定版本'],['issues','审查问题'],['conclusion','处理结论']].map(([id,label],i)=><button key={id} className={mode===id?'active':''} disabled={id==='locked'?!picked.length:['issues','conclusion'].includes(id)?!r:false} onClick={()=>setMode(id)}><span>0{i+1}</span>{label}</button>)}</nav>
    {mode==='select'&&<div className="preparation-layout"><div><h3>本次审查哪些文件</h3><div className="source-choices">{[{id:'writing',label:'撰写工作稿',icon:FileText,desc:'关联已保存的申请文件版本'},{id:'case',label:'本案已有材料',icon:FolderOpen,desc:'独立检查本案申请文件'},{id:'external',label:'外部申请文件',icon:Files,desc:'无需先运行撰写或答复'}].map(x=><button className={source===x.id?'selected':''} key={x.id} disabled={x.id==='writing'&&!isWritingSaved(d.writing)} onClick={()=>setSource(x.id as typeof source)}><x.icon size={20}/><span><b>{x.label}</b><small>{x.desc}</small></span>{source===x.id&&<Check size={16}/>}</button>)}</div><div className="select-files">{inputDocs.map(doc=><label key={doc.id}><input type="checkbox" checked={selected.includes(doc.id)} onChange={e=>setSelected(e.target.checked?[...selected,doc.id]:selected.filter(id=>id!==doc.id))}/><FileText size={18}/><span>{doc.title}<small>{sourceLabel}</small></span></label>)}</div>{source==='external'&&<Note>目前载入虚构外部文件以体验流程，不读取你的真实文件。</Note>}<div className="action-bar"><span className="muted">已选择 {picked.length} 份文件</span><button className="primary" disabled={!picked.length} onClick={()=>setMode('locked')}>核对版本<ArrowRight size={16}/></button></div></div><aside className="context-aside"><h3>独立上下文</h3><p>审查任务只引用本次选定的文件快照。问题、处理意见和审查结果与该版本一起保存。</p><Note>修改工作稿不会改变已经锁定的原文。</Note>{d.reviewHistory.length>0&&<p className="muted">本案已保留 {d.reviewHistory.length} 次历史审查记录。</p>}</aside></div>}
    {mode==='locked'&&<div className="lock-review"><ShieldCheck size={30}/><h3>确认本次文件与版本</h3><p>{item.number} · {sourceLabel}</p><div className="final-files">{picked.map(doc=><div key={doc.id}><FileText size={18}/><span>{doc.title}</span><span className="muted">只读快照</span></div>)}</div><Note>本次会生成固定的演示问题，用于体验原文定位和处理记录；未调用真实 AI。</Note><div className="action-bar"><button onClick={()=>setMode('select')}>返回选择</button><button className="primary" disabled={!picked.length} onClick={begin}>开始审查演示<ArrowRight size={16}/></button></div></div>}
    {mode==='issues'&&r&&doc&&<>
      {r.source==='writing'&&!reviewMatchesWriting(d)&&<div className="inline-warning">当前工作稿已有变化。这里仍显示 {r.versionLabel} 的审查记录；请保存新版本后再次审查。</div>}
      <div className="review-desk"><div className="source-document"><div className="source-document-toolbar"><select aria-label="审查原文文件" value={doc.id} onChange={e=>setManualDocId(e.target.value)}>{r.documents.map(x=><option key={x.id} value={x.id}>{x.title}</option>)}</select><span>{r.versionLabel}</span><button className={highlight?'selected icon-button':'icon-button'} aria-label="显示原文定位" aria-pressed={highlight} onClick={()=>setHighlight(!highlight)}><Highlighter size={17}/></button></div><div className="review-paper" ref={paper}><h3>{doc.title}</h3>{doc.text.split('\n\n').map((p,i)=><p key={i} className={highlight&&issue?.documentId===doc.id&&p.includes(issue.quote)?'located':''}>{highlight&&issue?.documentId===doc.id&&p.includes(issue.quote)?<>{p.split(issue.quote)[0]}<mark>{issue.quote}</mark>{p.split(issue.quote).slice(1).join(issue.quote)}</>:p}</p>)}</div><footer>原文快照 · {r.versionLabel} · 仅供演示</footer></div>
        <aside className="issue-inspector"><div className="inspector-heading"><h3>问题清单</h3><div className="filter-tabs"><button className={!onlyOpen?'selected':''} onClick={()=>setOnlyOpen(false)}>全部</button><button className={onlyOpen?'selected':''} onClick={()=>setOnlyOpen(true)}>待处理</button></div></div><div className="issue-list">{issues.map(x=><button key={x.id} className={issue?.id===x.id?'active':''} onClick={()=>{setIssueId(x.id);setManualDocId('');setHighlight(true);}}><span>{x.disposition==='open'?String(r.issues.indexOf(x)+1).padStart(2,'0'):<Check size={15}/>}</span><b>{x.title}</b><ChevronRight size={14}/></button>)}</div>{issue?<div className="issue-detail"><span className="issue-category">{issue.category} · {issue.disposition==='open'?'待处理':issue.disposition==='accepted'?'已记录处理':'保留并注明理由'}</span><h4>原文依据</h4><blockquote>{issue.quote}<small>{r.documents.find(x=>x.id===issue.documentId)?.title} · {r.versionLabel}</small></blockquote><h4>修改建议</h4><p>{issue.suggestion}</p>{issue.comment&&<div className="disposition-note"><MessageSquare size={15}/><span>{issue.comment}</span></div>}</div>:<div className="inline-empty"><Check/><p>没有待处理的问题，可以查看处理结论。</p></div>}{issue&&<div className="inspector-actions"><button className="primary" onClick={()=>setEditing(true)}>记录处理意见</button><button onClick={r.source==='writing'?openWriting:openMaterials}>{r.source==='writing'?'返回撰写修改':'查看本案材料'}</button></div>}<div className="inspector-footer"><button className="text-button" onClick={()=>setMode('conclusion')}>查看处理结论<ArrowRight size={15}/></button><Note>修改稿件后需针对新版本再次审查。</Note></div></aside></div>
    </>}
    {mode==='conclusion'&&r&&<div className="review-conclusion"><div className="section-heading"><div><h3>{r.completed?'已记录审查结论':'核对问题处理情况'}</h3><p className="muted">{r.versionLabel} · 固定演示问题</p></div><span className="tag">{r.issues.filter(i=>i.disposition!=='open').length} / {r.issues.length} 已记录</span></div><div className="conclusion-list">{r.issues.map(x=><button key={x.id} onClick={()=>{setIssueId(x.id);setOnlyOpen(false);setMode('issues');setManualDocId('');}}><span className={x.disposition==='open'?'warning':'success-text'}>{x.disposition==='open'?'待处理':x.disposition==='accepted'?'已记录':'已说明保留'}</span><span><b>{x.title}</b><small>{x.comment||'尚未记录处理意见'}</small></span><ChevronRight size={15}/></button>)}</div><div className="action-bar"><button onClick={()=>setMode('issues')}>返回问题清单</button>{r.completed?<button className="primary" onClick={r.source==='writing'?openWriting:openMaterials}>{r.source==='writing'?'返回撰写定稿':'返回本案材料'}<ArrowRight size={15}/></button>:<button className="primary" disabled={!allHandled} onClick={()=>update({...d,review:{...r,completed:true}})}>完成本次审查记录</button>}</div><Note>“已记录”表示你对示例问题作出了处理，不表示文件已满足法律或递交要求。最终定稿仍由你确认。</Note></div>}
    {editing&&issue&&<IssueDisposition key={issue.id} issue={issue} close={()=>setEditing(false)} save={record}/>}
  </section>;
}
function IssueDisposition({issue,close,save}:{issue:ReviewIssue;close:()=>void;save:(p:Partial<ReviewIssue>)=>void}){
  const [comment,setComment]=useState(issue.comment);
  const [disposition,setDisposition]=useState<string>(issue.disposition==='open'?'accepted':issue.disposition);
  return <Modal title="记录处理意见" onClose={close}><h3>{issue.title}</h3><form onSubmit={e=>{e.preventDefault();save({comment:comment.trim(),disposition:disposition as ReviewIssue['disposition']});}}><label className="field">处理方式<select value={disposition} onChange={e=>setDisposition(e.target.value)}><option value="accepted">已核对并处理</option><option value="deferred">保留原文并说明理由</option></select></label><label className="field">处理说明<textarea required value={comment} onChange={e=>setComment(e.target.value)} placeholder="记录修改位置、核对依据，或保留原文的理由…" rows={4}/></label><Note>处理记录不会直接修改原文。需要改稿时返回对应撰写任务。</Note><div className="action-bar"><button type="button" onClick={close}>取消</button><button className="primary" disabled={!comment.trim()}>保存处理记录</button></div></form></Modal>;
}
