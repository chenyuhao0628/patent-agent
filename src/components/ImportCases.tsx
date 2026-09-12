import { useState } from 'react';
import { AlertCircle, ArrowRight, Check, FileText, RefreshCw } from 'lucide-react';
import { makeRound } from '../domain/workflow.ts';
import type { Case } from '../domain/workflow.ts';
import { Note } from './Primitives.tsx';

export function ImportCases({create}:{create:(cases:Case[])=>void}){
  const [batch,setBatch]=useState(false),[prepared,setPrepared]=useState(false),[withError,setWithError]=useState(false),[failed,setFailed]=useState(false);
  const [names,setNames]=useState('一种环境监测装置');
  const [type,setType]=useState('发明'),[round,setRound]=useState('第一次审查意见');
  const titles=names.split('\n').map(s=>s.trim()).filter(Boolean).slice(0,batch?20:1);
  function finish(){
    if(failed||!titles.length)return;
    create(titles.map((title,i)=>({id:crypto.randomUUID(),title,number:`示例-${Date.now().toString().slice(-6)}-${i+1}`,type,deadline:'2026-10-15',tags:[],archived:false,rounds:[makeRound(round,['第一次审查意见','补正通知'].includes(round))]})));
  }
  return <div className="import-workflow">
    <nav className="surface-switch" aria-label="导入方式"><button className={!batch?'active':''} disabled={prepared} onClick={()=>setBatch(false)}>单案导入</button><button className={batch?'active':''} disabled={prepared} onClick={()=>setBatch(true)}>批量导入</button></nav>
    {!prepared?<form onSubmit={e=>{e.preventDefault();setFailed(withError);setPrepared(true);}}><Note>使用虚构通知书体验导入和整理，不读取或上传真实文件。</Note><label className="field">{batch?'案件名称，每行一个':'案件名称'}{batch?<textarea value={names} onChange={e=>setNames(e.target.value)} rows={4} placeholder="每行一个案件名称，最多20案"/>:<input required value={names.split('\n')[0]} onChange={e=>setNames(e.target.value)}/>}</label><div className="form-pair"><label className="field">专利类型<select value={type} onChange={e=>setType(e.target.value)}><option>发明</option><option>实用新型</option></select></label><label className="field">通知类型<select value={round} onChange={e=>setRound(e.target.value)}>{['第一次审查意见','第二次审查意见','第三次审查意见','后续审查意见','补正通知'].map(s=><option key={s}>{s}</option>)}</select></label></div><label className="checkbox"><input type="checkbox" checked={withError} onChange={e=>setWithError(e.target.checked)}/>体验一份下载失败的示例</label><div className="action-bar"><span className="muted">{titles.length} 个示例案件</span><button className="primary" disabled={!titles.length}>预览材料整理<ArrowRight size={15}/></button></div></form>:<><div className="preparation-progress"><span><Check size={14}/>识别通知示例</span><span><Check size={14}/>匹配原始材料</span><span>{failed?<AlertCircle size={14}/>:<Check size={14}/>}下载对比文件</span></div><div className="import-summary">{titles.map((title,i)=><div key={`${title}-${i}`}><FileText size={18}/><span>{title}<small>{round} · {type}</small></span><span className={i===0&&failed?'warning':'success-text'}>{i===0&&failed?'待重试':'已整理'}</span></div>)}</div>{failed&&<div className="inline-warning"><b>对比文件暂未取得 · 演示</b><p>示例下载连接超时。通知书及已匹配材料保留，重试只处理这份文件。</p><button onClick={()=>setFailed(false)}><RefreshCw size={14}/>重试示例下载</button></div>}<Note>正式接入后，整理结果来自真实文件与下载任务。这里不代表模型已读取材料。</Note><div className="action-bar"><button onClick={()=>setPrepared(false)}>返回调整</button><button className="primary" disabled={failed||!titles.length} onClick={finish}>将 {titles.length} 案加入案件库</button></div></>}
  </div>;
}
