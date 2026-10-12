import type { ComponentType } from 'react';
import type { PanelDefinition, PanelProps } from './panel-types.ts';

type PanelLoadState = {status:'loading'} | {status:'ready';View:ComponentType<PanelProps>} | {status:'error';error:unknown};
const resources=new WeakMap<PanelDefinition,ReturnType<typeof createResource>>();
function createResource(definition:PanelDefinition){
 let snapshot:PanelLoadState={status:'loading'};
 const listeners=new Set<()=>void>();
 const publish=(value:PanelLoadState)=>{snapshot=value;for(const listener of [...listeners])listener();};
 // Cache only module code. Each mount retains its own props, data lease and
 // component instance. Explicit state avoids a Suspense fallback minimum wait.
 const settled=Promise.resolve().then(definition.load).then(
  module=>publish({status:'ready',View:module.default}),
  error=>publish({status:'error',error}),
 );
 return {getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},settled};
}
export function panelResource(definition:PanelDefinition){
 let resource=resources.get(definition);
 if(!resource){resource=createResource(definition);resources.set(definition,resource);}
 return resource;
}
export function retryPanelResource(definition:PanelDefinition){resources.delete(definition);}
