import { Component, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { desktop } from '../desktop.ts';
import { featureContextForDesktop } from './features.ts';
import { createModuleDataLease } from './module-data.ts';
import { useWorkspaceStore } from './workspace-context.tsx';
import { panels } from './panels.ts';
import type { PanelRegistry } from './panel-registry.ts';
import type { PanelAccessContext, PanelDefinition, PanelProps } from './panel-types.ts';
import { panelResource, retryPanelResource } from './panel-loader.ts';

export function panelAccessContext(context:PanelProps['context']):PanelAccessContext {
 const host=featureContextForDesktop(desktop);
 return {...host,caseView:context.kind==='case'?context.projected:undefined,historical:context.kind==='case'&&(context.historical||!!context.item.linkedTo)};
}
class PanelErrorBoundary extends Component<{children:ReactNode;retry:()=>void},{failed:boolean}> {
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<section role="alert" className="page-pad"><h2>此面板暂时无法加载</h2><p>案件与已保存工作仍然保留。</p><button onClick={this.props.retry}>重试加载</button></section>:this.props.children;}
}
function LoadedPanel({resource,...props}:PanelProps&{resource:ReturnType<typeof panelResource>}){
 const state=useSyncExternalStore(resource.subscribe,resource.getSnapshot,resource.getSnapshot);
 if(state.status==='error')throw state.error;
 if(state.status==='loading')return <div className="page-pad" role="status">正在加载面板…</div>;
 return <state.View {...props}/>;
}
function PanelContent({definition,context,access}:{definition:PanelDefinition;context:PanelProps['context'];access:PanelAccessContext}) {
 const store=useWorkspaceStore(),[attempt,setAttempt]=useState(0),[enterError,setEnterError]=useState('');
 const readonly=access.historical||!(definition.canEdit?.(access)??false);
 const lease=useMemo(()=>createModuleDataLease(store,context.kind==='case'?context.item.id:undefined,!readonly),[store,readonly]);
 useLayoutEffect(()=>{lease.activate();return lease.dispose;},[lease]);
 const data=lease.data;
 const resource=useMemo(()=>panelResource(definition),[definition,attempt]);
 const profile=context.kind==='case'?context.profileKey:undefined,id=context.kind==='case'?context.item.id:undefined;
 useEffect(()=>{
  let active=true;
  if(definition.enter==='open-case'&&!access.historical&&profile&&id&&desktop)void desktop.agent.command(profile,id,{type:'opened'}).catch(e=>{if(active)setEnterError(e.message);});
  return()=>{active=false;};
 },[definition,access.historical,profile,id]);
 return <>{enterError&&<p role="alert">本机打开记录未保存：{enterError}</p>}<PanelErrorBoundary key={attempt} retry={()=>{retryPanelResource(definition);setAttempt(v=>v+1);}}><LoadedPanel resource={resource} context={context} data={data} readonly={readonly}/></PanelErrorBoundary></>;
}
export function PanelHost({context,registry=panels}:{context:PanelProps['context'];registry?:PanelRegistry}) {
 const store=useWorkspaceStore();
 const access=panelAccessContext(context),route=context.kind==='case'?context.tab:context.page;
 const definition=registry.target(context.kind==='case'?'case':'global',route,access);
 if(!definition||!registry.available(definition,access))return <section className="page-pad" role="alert"><h2>当前面板不可用</h2><p>该入口不存在、已停用或缺少所需能力。</p><a href={context.kind==='case'?`#/case/${encodeURIComponent(context.item.id)}/overview`:'#/library'}>返回{context.kind==='case'?'案件概览':'案件库'}</a></section>;
 const scope=store.scope(context.kind==='case'?context.item.id:undefined);
 return <PanelContent key={JSON.stringify([definition.id,scope,context.kind==='case'?context.requestedTarget:undefined])} definition={definition} context={context} access={access}/>;
}
