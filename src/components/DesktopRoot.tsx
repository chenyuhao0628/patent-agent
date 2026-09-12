import { useEffect, useState } from 'react';
import { desktop } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
import { App } from '../App.tsx';
export function DesktopRoot(){
  const [state,setState]=useState<DesktopState|null>(null),[error,setError]=useState('');
  useEffect(()=>{if(!desktop)return;void desktop.bootstrap().then(setState).catch(e=>setError(e.message));return desktop.onState(setState);},[]);
  if(!desktop)return <App/>;
  if(error)return <div className="page-pad"><h1>无法打开本机工作台</h1><p role="alert">{error}</p><p>原始记录已保留，请检查文件夹权限。</p></div>;
  if(!state)return <div className="page-pad"><h1>正在打开专利工作台…</h1></div>;
  return <App key={state.profileKey} nativeState={state} refresh={setState}/>;
}
