import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelRegistry } from './panel-registry.ts';
import { panels } from './panels.ts';
import { featureContext } from './features.ts';
import type { PanelDefinition } from './panel-types.ts';
import { projectCaseView } from '../domain/case-view.ts';
const context={...featureContext(true),historical:false};
const panel=(patch:Partial<PanelDefinition>={}):PanelDefinition=>({id:'test.one',location:'global',route:'one',label:'One',order:0,navigation:'main',load:async()=>({default:()=>null}),...patch});

test('new global and case modules are reachable through registry without changing a host',()=>{
 const registry=createPanelRegistry([panel(),panel({id:'test.case',location:'case',navigation:'case'})]);
 assert.equal(registry.navigation('global',context)[0].route,'one');assert.equal(registry.navigation('case',context)[0].route,'one');
 assert.equal(registry.target('global','one',context)?.id,'test.one');assert.equal(registry.target('case','one',context)?.id,'test.case');
 assert.equal(registry.target('global','missing',context),undefined);
});
test('duplicate identities/routes and malformed capabilities fail during registration',()=>{
 assert.throws(()=>createPanelRegistry([panel(),panel({route:'two'})]),/重复/);
 assert.throws(()=>createPanelRegistry([panel(),panel({id:'test.two'})]),/重复/);
 assert.throws(()=>createPanelRegistry([panel({requiredCapabilities:['']})]),/能力/);
 assert.throws(()=>createPanelRegistry([panel({enter:'open-case'})]),/全局/);
 assert.throws(()=>createPanelRegistry([panel({location:'case',historyRoute:'missing'})]),/历史/);
});
test('navigation and direct routes enforce the same capability and enabled checks without loading components',()=>{
 let loaded=0;const definition=panel({requiredCapabilities:['custom.read'],load:async()=>{loaded++;return {default:()=>null};}}),registry=createPanelRegistry([definition,panel({id:'off',route:'off',enabled:false})]);
 assert.deepEqual(registry.navigation('global',context),[]);assert.equal(registry.target('global','one',context),undefined);assert.equal(registry.target('global','off',context),undefined);assert.equal(loaded,0);
 const enabled={...context,capabilities:new Set(['custom.read'])};assert.equal(registry.navigation('global',enabled).length,1);assert.equal(registry.target('global','one',enabled)?.id,definition.id);assert.equal(loaded,0);
});
test('old historical bookmarks do not inherit current-stage start restrictions',()=>{
 const caseView=projectCaseView({id:'a',title:'a',number:'a',type:'test',deadline:'',tags:[],archived:true,rounds:[],source:'local',current:{kind:'reply'}});
 const current={...context,caseView};assert.equal(panels.target('case','write',current),undefined);
 const historical={...current,historical:true};for(const route of ['write','reply','review','discussion','history'])assert.equal(panels.target('case',route,historical)?.route,'history');
 assert.equal(panels.target('case','unknown',historical),undefined);
});
test('read-only modules default to no lifecycle or write grant and disabled history stays inaccessible',()=>{
 const view=panel({location:'case',historyRoute:'history'}),history=panel({id:'history',location:'case',route:'history',enabled:false});
 const registry=createPanelRegistry([view,history]);assert.equal(registry.resolve('case','one')?.enter,undefined);assert.equal(registry.resolve('case','one')?.canEdit,undefined);
 assert.equal(registry.target('case','one',{...context,historical:true}),undefined);
});
