import { useEffect, useRef, useState } from 'react';
import type { Case } from '../domain/workflow.ts';
import { currentRemoteProcess } from '../domain/deadlines.ts';
import { desktop } from '../desktop.ts';
import { stamp } from '../domain/outcome.ts';

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
  useEffect(()=>{
    if (!item.caseInfoAt && desktop && profileKey && item.remote && !busy) {
      void refresh();
    }
  },[item.id, profileKey]);

  if (!item.remote || item.source !== 'baseland') {
    return null;
  }
  const notes=[['案件备注',item.caseRemark],['流程备注',process?.flowRemark],['官文备注',process?.officeNote],['处理备忘',process?.procNote]].filter(([,value])=>value?.trim());
  const fetched=!!item.caseInfoAt;
  const timeText=stamp(item.caseInfoAt);

  return <div className="case-remarks">
    {item.remoteClosure?.finished&&<p className="muted">贝思兰德案件状态：已结案 · 已保留本地材料与历史。</p>}
    <div className="remarks-header">
      <span className="muted">{busy?'正在同步远程备注…':fetched?`备注更新时间：${timeText}`:'尚未获取远程备注'}</span>
    </div>
    {notes.length>0?(
      <dl>{notes.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    ):(
      <p className="muted">{fetched?'已获取备注（内容为空）。':'未拉取贝思兰德案件或流程备注。'}</p>
    )}
    {error&&<p role="alert" className="inline-warning">{fetched?`刷新失败，当前显示历史版本：${error}`:`获取失败：${error}`}</p>}
  </div>;
}
