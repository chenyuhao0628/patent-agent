import { useState } from 'react';
import type { Case } from '../domain/workflow.ts';
import { currentWork } from '../domain/lifecycle.ts';
import { desktop } from '../desktop.ts';
import { Modal } from './Primitives.tsx';

export function StartCaseWork({item,profileKey}:{item:Case;profileKey?:string}) {
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const p=item.remote?.processes.find(p=>p.id===currentWork(item).processId);
  if(!desktop||!profileKey||item.archived||p?.status!==0||p.handId)return null;
  const start=async()=>{setBusy(true);setError('');try {
    const view=await desktop!.transfer.prepare(profileKey,item.id);
    const result=await desktop!.transfer.startHand(profileKey,view.id);
    if(result.phase==='uncertain'||result.error)throw new Error(result.error||'启动结果待核对，请刷新，勿重复启动。');
    setConfirm(false);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <><button className="primary" onClick={()=>setConfirm(true)}>启动递交，开始工作</button>{confirm&&<Modal title="开始办理本案" onClose={()=>{if(!busy)setConfirm(false);}}>
    <p>{item.number} · {item.title}</p><p>启动后贝思兰德进入“递交中”，由你继续准备材料和稿件；此操作不会提交官方或转交下一办理人。</p>
    {error&&<p role="alert">{error}</p>}<button disabled={busy} onClick={()=>void start()}>{busy?'正在启动并核对…':'确认启动递交'}</button>
  </Modal>}</>;
}
