import { useEffect, useState } from 'react';
import { desktop, desktopContractMismatch } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
import { App } from '../App.tsx';
import { acceptDesktopState } from '../app/scope.ts';
export function DesktopRoot(){
  if (desktopContractMismatch) {
    return <div className="error-banner" role="alert">桌面接口版本不兼容，请重新启动应用。</div>;
  }
  const [state,setState]=useState<DesktopState|null>(null),[error,setError]=useState('');
  const refresh=(incoming:DesktopState)=>setState(current=>acceptDesktopState(current,incoming));
  useEffect(()=>{if(!desktop)return;let active=true;void desktop.bootstrap().then(incoming=>{if(active)refresh(incoming);}).catch(e=>{if(active)setError(e.message);});const unsubscribe=desktop.onState(refresh);return()=>{active=false;unsubscribe();};},[]);
  if(!desktop)return <App/>;
  if(error)return <div className="page-pad"><h1>无法打开本机工作台</h1><p role="alert">{error}</p><p>原始记录已保留，请检查文件夹权限。</p></div>;
  if(!state)return <div className="page-pad"><h1>正在打开专利工作台…</h1></div>;
  return <App key={`${state.profileKey}:${state.scopeVersion}`} nativeState={state} refresh={refresh}/>;
}
