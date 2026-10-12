import { useEffect, useState } from 'react';
import { desktop } from '../desktop.ts';
import type { EngineRuntimeStatus } from '../domain/engine-runtime.ts';

const labels: Record<EngineRuntimeStatus['state'], string> = {idle:'可用',checking:'检查官方更新',downloading:'下载更新',verifying:'验证模型协议与工具兼容性',pending:'等待任务结束后切换',unavailable:'不可用'};
export function RuntimeSettings() {
  const api=desktop?.runtime;
  const [view,setView]=useState<EngineRuntimeStatus|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!api)return;
    let closed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const refresh=async()=>{
      try{const next=await api.status();if(closed)return;setView(next);}
      catch(e){if(!closed)setError((e as Error).message);}
      if(!closed)timer=setTimeout(()=>void refresh(),2_000);
    };
    void refresh();return()=>{closed=true;if(timer)clearTimeout(timer);};
  },[api]);
  const act=async(action:()=>Promise<EngineRuntimeStatus>)=>{setBusy(true);setError('');try{setView(await action());}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  if(!api)return null;
  const checking=view&&['checking','downloading','verifying'].includes(view.state);
  return <section className="application-settings">
    <header className="application-settings-heading"><h3>OpenCode 后台</h3><p>自动获取官方运行时，通过合成模型与工具检查后更新；正在办理的任务结束后再切换。</p></header>
    {view&&<div className="application-preferences">
      <p role="status">当前 {view.activeVersion} · {labels[view.state]}{view.candidateVersion?` · 待切换 ${view.candidateVersion}`:''}</p>
      <label className="application-choice"><input type="checkbox" checked={view.automatic} disabled={busy} onChange={e=>void act(()=>api.automatic(e.target.checked))}/><span>自动检查并安装兼容更新</span></label>
      <p className="application-option-hint">启动时及运行期间每 6 小时检查。案件会话保存在本机；允许供应商缓存，额外计费的定时预热保持关闭。</p>
      {view.checkedAt&&<p className="muted">最近检查：{new Date(view.checkedAt).toLocaleString('zh-CN')}</p>}
      <div className="application-settings-actions"><button disabled={busy||!!checking||view.state==='unavailable'} onClick={()=>void act(()=>api.check())}>{checking?'检查与验证中…':'立即检查'}</button><button disabled={busy||!!checking||!view.previousVersion||view.state==='pending'} onClick={()=>void act(()=>api.rollback())}>回退{view.previousVersion?`到 ${view.previousVersion}`:''}</button></div>
      {view.error&&<p role="alert" className="inline-warning">{view.error}</p>}
    </div>}
    {error&&<p role="alert" className="inline-warning">{error}</p>}
  </section>;
}
