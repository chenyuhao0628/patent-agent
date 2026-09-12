import { useState } from 'react';
import { desktop } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
export function LocalCaseForm({done}:{done:(s:DesktopState)=>void}){
  const [title,setTitle]=useState(''),[number,setNumber]=useState(''),[kind,setKind]=useState<'write'|'review'>('write'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{done(await desktop!.createCase({title,number,kind}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><p>贝思兰德案件通过同步加入；本地立项按当前业务建立独立目录。</p><label className="field">案件名称<input required value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="field">案号／本地项目编号<input required value={number} onChange={e=>setNumber(e.target.value)}/></label><label className="field">当前业务<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="write">专利撰写</option><option value="review">独立审查已有文件</option></select></label>{error&&<p role="alert" className="inline-warning">{error}</p>}<div className="action-bar"><button className="primary" disabled={busy}>{busy?'正在建立目录…':'建立案件与目录'}</button></div></form>;
}
