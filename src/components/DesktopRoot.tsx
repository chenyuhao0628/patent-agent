import { useEffect, useState, useSyncExternalStore } from 'react';
import { desktop, desktopContractMismatch } from '../desktop.ts';
import { App } from '../App.tsx';
import { loadWorkspace } from '../domain/persistence.ts';
import { createWorkspaceStore } from '../app/workspace-data.ts';
import { WorkspaceDataContext } from '../app/workspace-context.tsx';

export function DesktopRoot(){
  const [store]=useState(()=>{
    const preview=desktop?undefined:loadWorkspace();
    return createWorkspaceStore({api:desktop,preview:preview?.workspace,error:preview?.error});
  });
  const {nativeState}=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const [error,setError]=useState('');
  useEffect(()=>{
    if(!desktop||desktopContractMismatch)return;
    let active=true;
    const unsubscribe=desktop.onState(state=>{if(active)store.receive(state);});
    void desktop.bootstrap().then(state=>{if(active)store.receive(state);}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;unsubscribe();};
  },[store]);
  if(desktopContractMismatch)return <div className="error-banner" role="alert">桌面接口版本不兼容，请重新启动应用。</div>;
  if(error)return <div className="page-pad"><h1>无法打开本机工作台</h1><p role="alert">{error}</p><p>原始记录已保留，请检查文件夹权限。</p></div>;
  if(desktop&&!nativeState)return <div className="page-pad"><h1>正在打开专利工作台…</h1></div>;
  return <WorkspaceDataContext.Provider value={store}><App key={nativeState?`${nativeState.profileKey}:${nativeState.scopeVersion}`:'preview'} store={store}/></WorkspaceDataContext.Provider>;
}
