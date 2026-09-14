import { useState } from 'react';
import { ArrowUpRight, Clock3, Pause, Play } from 'lucide-react';
import type { Case, Action } from '../domain/workflow.ts';
import { activeRound, caseStatus, currentRoute, currentWork, editableCurrent, isConfirmedOfficialSubmission, processSubmission, workNames } from '../domain/lifecycle.ts';
import type { CaseTab } from './CaseSpace.tsx';
import { Empty } from './Primitives.tsx';
export function TaskCenter({cases,open,dispatch}:{cases:Case[];open:(c:Case,t:CaseTab,r?:string)=>void;dispatch:(caseId:string,roundId:string,a:Action)=>void}){
  const [filter,setFilter]=useState('active');
  const status=(c:Case)=>{
    if(currentWork(c).kind==='waiting'||isConfirmedOfficialSubmission(processSubmission(c)))return 'waiting';
    if(activeRound(c)?.job?.status==='paused')return 'paused';
    return editableCurrent(c)?'active':'waiting';
  };
  const shown=cases.filter(c=>!c.archived&&(filter==='all'||status(c)===filter)).reverse();
  return <div className="page-pad task-center"><div className="page-heading"><div><h1>工作任务</h1><p>新加入的案件在前；每个案件只有一项当前办理工作，历史任务在案件中回看。</p></div></div><nav className="surface-switch" aria-label="任务筛选">{[['active','当前办理'],['paused','已暂停'],['waiting','等待与系统流程'],['all','全部案件']].map(([id,label])=><button className={filter===id?'active':''} key={id} onClick={()=>setFilter(id)}>{label}<span>{cases.filter(c=>!c.archived&&(id==='all'||status(c)===id)).length}</span></button>)}</nav>{shown.length?<div className="task-catalog">{shown.map(c=>{const r=activeRound(c),w=currentWork(c),editable=editableCurrent(c);return <div key={c.id}><span className="task-symbol"><Clock3 size={21}/></span><div><h3>{w.label??workNames[w.kind]}</h3><p>{c.title}</p><small>{caseStatus(c)}</small></div><div className="task-actions">{editable&&r?.job&&<button onClick={()=>dispatch(c.id,r.id,{type:r.job?.status==='paused'?'resume':'pause'})}>{r.job.status==='paused'?<Play size={14}/>:<Pause size={14}/>}{r.job.status==='paused'?'继续':'停止'}</button>}<button onClick={()=>open(c,currentRoute(c) as CaseTab,r?.id)}>打开当前工作<ArrowUpRight size={15}/></button></div></div>;})}</div>:<Empty title="当前没有此类案件">同步个人案件或调整筛选后查看。</Empty>}</div>;
}
