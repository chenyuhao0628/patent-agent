import {useEffect,useState} from 'react';
import {desktop} from '../desktop.ts';
import type {Case} from '../domain/workflow.ts';
import {Note} from './Primitives.tsx';
export function PatsnapSettings({profileKey}:{profileKey:string}){
 const [configured,setConfigured]=useState(false),[key,setKey]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{void desktop?.priorArt.status(profileKey).then(v=>setConfigured(v.configured));},[profileKey]);
 const run=async(fn:()=>Promise<{configured:boolean}>,success:string)=>{setBusy(true);setMessage('');try{const r=await fn();setConfigured(r.configured);setKey('');setMessage(success);}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}};
 return <><h2>智慧芽对比文件</h2><p>贝思兰德通知同步后自动识别公开号，通过智慧芽下载 PDF 并保存到本案轮次。失败项目可以单独重试。</p><p className="tag">{configured?'已保存凭证':'尚未配置'}</p><label className="field">API Key 或 Client ID:Client Secret<input type="password" autoComplete="off" value={key} placeholder={configured?'已有凭证，留空不改变':'sk-… 或 Client ID:Client Secret'} onChange={e=>setKey(e.target.value)}/></label><div className="action-bar"><button disabled={busy} onClick={()=>void run(()=>desktop!.priorArt.importLegacy(profileKey),'已从旧专利应用导入，凭证已在当前账号加密保存。')}>导入本机旧配置</button><button disabled={busy||!key.trim()} className="primary" onClick={()=>void run(()=>desktop!.priorArt.save(profileKey,key),'凭证已保存，下次同步自动下载；也可在案件材料页立即重试。')}>保存凭证</button><button disabled={busy||!configured} onClick={()=>void run(()=>desktop!.priorArt.test(profileKey),'连接成功，已验证公开专利 PDF 下载。')}>测试连接</button><button disabled={busy||!configured} onClick={()=>void run(()=>desktop!.priorArt.clear(profileKey),'已移除当前账号凭证。')}>移除凭证</button></div>{message&&<p role="status">{message}</p>}<Note>只发送公开专利编号；通知书、原始申请及账号登录凭证不发送给智慧芽。无需安装旧项目。</Note></>;
}
export function PriorArtPanel({item,profileKey,onUpdated}:{item:Case;profileKey:string;onUpdated:()=>void}){
 const [manual,setManual]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const r=item.rounds.find(r=>r.id===item.current?.roundId||r.id==='proc-'+item.current?.processId),state=r?.priorArt;
 if(!r||!['reply','correction'].includes(item.current?.kind??''))return null;
 const run=async()=>{setBusy(true);setError('');try{await desktop!.priorArt.prepare(profileKey,item.id,manual);setManual('');onUpdated();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <section className="prior-art-panel"><div className="section-heading"><h3>对比文件 · 智慧芽</h3><button disabled={busy} onClick={()=>void run()}>{busy?'正在识别并下载…':'识别并重试缺失文件'}</button></div>{state?.warning&&<p className="muted">{state.warning}</p>}{state?.items.map(i=><div className="prior-art-row" key={i.number}><b>{i.number}</b><span>{i.status==='downloaded'?'已下载':i.status==='failed'?'下载失败':'待下载'}</span><small>{i.message}</small>{i.relativePath&&<button onClick={()=>void desktop!.openMaterial(item.id,i.relativePath!)}>打开</button>}</div>)}<label className="field">补充公开号（多个编号用逗号或换行分隔）<textarea rows={2} value={manual} onChange={e=>setManual(e.target.value)} placeholder="CN120069239A"/></label>{error&&<p role="alert">{error}</p>}</section>;
}
