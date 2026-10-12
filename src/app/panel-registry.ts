import type { PanelAccessContext, PanelDefinition, PanelLocation } from './panel-types.ts';
export function createPanelRegistry(definitions: readonly PanelDefinition[]) {
  const ids=new Set<string>(),routes=new Map<string,PanelDefinition>();
  for(const definition of definitions){
    if(!/^[a-z][a-z0-9.-]*$/.test(definition.id)||!/^[a-z][a-z0-9-]*$/.test(definition.route)||!['global','case'].includes(definition.location)||!definition.label.trim()||!Number.isFinite(definition.order)||typeof definition.load!=='function')throw new Error('面板描述无效。');
    const key=definition.location+':'+definition.route;
    if(ids.has(definition.id)||routes.has(key))throw new Error(`面板 ID 或路由重复：${definition.id}`);
    if(definition.enter && definition.location!=='case')throw new Error('全局面板不能声明案件进入动作。');
    if(definition.historyRoute&&definition.location!=='case')throw new Error('全局面板不能声明案件历史入口。');
    if(definition.requiredCapabilities&&(!Array.isArray(definition.requiredCapabilities)||definition.requiredCapabilities.some(c=>typeof c!=='string'||!c.trim())))throw new Error('面板能力声明无效。');
    ids.add(definition.id);routes.set(key,Object.freeze({...definition}));
  }
  const all=[...routes.values()].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
  for(const definition of all)if(definition.historyRoute&&!routes.has('case:'+definition.historyRoute))throw new Error('面板历史入口不存在。');
  const resolve=(location:PanelLocation,route:string)=>routes.get(location+':'+route);
  const available=(panel:PanelDefinition,context:PanelAccessContext)=>panel.enabled!==false&&(panel.requiredCapabilities??[]).every(c=>context.capabilities.has(c))&&(panel.canOpen?.(context)??true);
  return {
    all: Object.freeze(all),resolve,available,
    navigation:(location:PanelLocation,context:PanelAccessContext)=>all.filter(p=>p.location===location&&p.navigation!=='hidden'&&p.navigation!==undefined&&available(p,context)&&(p.visible?.(context)??true)),
    target:(location:PanelLocation,route:string,context:PanelAccessContext)=>{
      const panel=resolve(location,route);
      if(!panel||panel.enabled===false)return undefined;
      // Historical identity is resolved by the history adapter. Current-stage
      // start/view predicates cannot hide a valid old bookmark.
      if(context.historical&&location==='case'){
        const history=panel.historyRoute?resolve('case',panel.historyRoute):undefined;
        return history&&available(history,context)?history:undefined;
      }
      if(!available(panel,context))return undefined;
      return panel;
    },
  };
}
export type PanelRegistry=ReturnType<typeof createPanelRegistry>;
