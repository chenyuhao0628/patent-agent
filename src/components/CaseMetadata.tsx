import { useEffect, useRef, useState } from 'react';
import type { Case } from '../domain/workflow.ts';
import { currentRemoteProcess } from '../domain/deadlines.ts';
import { desktop } from '../desktop.ts';

export function CaseMetadata({item,profileKey}:{item:Case;profileKey?:string}) {
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const request=useRef(0);
  const process=currentRemoteProcess(item);
  const refresh=async()=>{
    if (!desktop || !profileKey || !item.remote) return;
    const token=++request.current; setBusy(true); setError('');
    try { await desktop.caseInfo(profileKey,item.id); }
    catch(e) { if (token===request.current) setError((e as Error).message); }
    finally { if (token===request.current) setBusy(false); }
  };
  useEffect(()=>{void refresh();return()=>{request.current++;};},[profileKey,item.id,item.current?.processId]);
  const notes=[['案件备注',item.caseRemark],['流程备注',process?.flowRemark],['官文备注',process?.officeNote],['处理备忘',process?.procNote]].filter(([,value])=>value?.trim());
  return <div className="case-remarks">{item.remoteClosure?.finished&&<p className="muted">贝思兰德案件状态：已结案 · 已保留本地材料与历史。</p>}<dl>{notes.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{!notes.length&&<p className="muted">{busy?'正在读取案件与流程备注…':'未提供案件或流程备注。'}</p>}{error&&<p role="alert" className="inline-warning">{error}</p>}{desktop&&item.remote&&<div className="button-row"><button disabled={busy} onClick={()=>void refresh()}>{busy?'读取中…':'刷新备注'}</button></div>}</div>;
}
