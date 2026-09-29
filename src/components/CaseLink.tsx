import { useEffect, useRef, useState } from 'react';
import type { Case } from '../domain/workflow.ts';
import type { CaseLinkCandidate } from '../domain/case-link.ts';
import { desktop } from '../desktop.ts';
import { Modal, Note } from './Primitives.tsx';

export function CaseLink({item,profileKey}:{item:Case;profileKey:string}){
 const [open,setOpen]=useState(false),[candidates,setCandidates]=useState<Array<CaseLinkCandidate&{token:string}>>([]);
 const [selected,setSelected]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0);
 useEffect(()=>{generation.current++;setOpen(false);setCandidates([]);setSelected('');setConfirmed(false);setBusy(false);setError('');return()=>{generation.current++;};},[profileKey,item.id]);
 const target=candidates.find(c=>c.id===selected);
 async function show(){const token=++generation.current;setOpen(true);setBusy(true);setError('');setCandidates([]);setSelected('');setConfirmed(false);try{const result=await desktop!.caseLinkCandidates(profileKey,item.id);if(token===generation.current)setCandidates(result);}catch(e){if(token===generation.current)setError((e as Error).message);}finally{if(token===generation.current)setBusy(false);}}
 async function link(){if(!target||!confirmed)return;const token=++generation.current;setBusy(true);setError('');try{await desktop!.linkCase(profileKey,item.id,target.id,target.token);if(token===generation.current)setOpen(false);}catch(e){if(token===generation.current)setError((e as Error).message);}finally{if(token===generation.current)setBusy(false);}}
 return <><button disabled={busy} onClick={()=>void show()}>关联已开卷案件</button>{open&&<Modal title="关联贝思兰德案件" onClose={()=>{if(!busy)setOpen(false);}}>
 <p>本地案件：<strong>{item.number} · {item.title}</strong></p><small>本地标识：{item.id}</small>
 <label className="field">选择当前账号已同步案件<select disabled={busy} value={selected} onChange={e=>{setSelected(e.target.value);setConfirmed(false);}}><option value="">请选择，不按同名自动匹配</option>{candidates.map(c=><option key={c.id} value={c.id}>{c.number} · {c.title}</option>)}</select></label>
 {target&&<div className="current-work"><p><strong>{target.number} · {target.title}</strong></p><p>远端案件 ID：{target.remoteCaseId}</p><p>当前流程：{target.processName}</p>{target.hasDraft&&<p>远端案件已有本地稿件，将保留为历史版本，不覆盖当前本地稿。</p>}</div>}
 <Note>关联后保留本地案件目录与撰写成果，原远端案件保留为只读历史；材料复制到当前案件，双方原目录不删除。此操作不向贝思兰德新建案件、上传或转交。</Note>
 {!busy&&!candidates.length&&<p>没有可关联案件，请先同步当前账号已分配或负责的案件。</p>}
 <label><input type="checkbox" checked={confirmed} disabled={!target||busy} onChange={e=>setConfirmed(e.target.checked)}/>我已核对双方身份，确认是同一案件</label>
 {error&&<p role="alert">{error}</p>}<div className="action-bar"><button disabled={busy} onClick={()=>setOpen(false)}>取消</button><button className="primary" disabled={busy||!target||!confirmed} onClick={()=>void link()}>{busy?'正在核对…':'确认关联并保留历史'}</button></div>
 </Modal>}</>;
}
