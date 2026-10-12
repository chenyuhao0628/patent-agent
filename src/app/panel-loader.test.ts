import test from 'node:test';
import assert from 'node:assert/strict';
import { panelResource, retryPanelResource } from './panel-loader.ts';
import type { PanelDefinition } from './panel-types.ts';

test('loaded panel code is immediately reusable while subscriptions remain per mount',async()=>{
 let loaded=0,notified=0;const View=()=>null;
 const definition:PanelDefinition={id:'probe',route:'probe',location:'global',label:'Probe',order:0,load:async()=>{loaded++;return {default:View};}};
 const resource=panelResource(definition),off=resource.subscribe(()=>notified++);
 assert.equal(resource.getSnapshot().status,'loading');await resource.settled;
 assert.equal(notified,1);off();assert.equal(panelResource(definition),resource);assert.equal(loaded,1);
 const state=resource.getSnapshot();assert.equal(state.status,'ready');if(state.status==='ready')assert.equal(state.View,View);
 assert.equal(resource.getSnapshot(),state);
});

test('a rejected load is contained, explicit retry replaces it and unmounted listeners are not called',async()=>{
 let attempts=0,stale=0;const definition:PanelDefinition={id:'retry',route:'retry',location:'case',label:'Retry',order:0,load:async()=>{if(++attempts===1)throw Error('synthetic failure');return {default:()=>null};}};
 const first=panelResource(definition),off=first.subscribe(()=>stale++);off();await first.settled;
 assert.equal(first.getSnapshot().status,'error');assert.equal(stale,0);assert.equal(panelResource(definition),first);
 retryPanelResource(definition);const second=panelResource(definition);assert.notEqual(second,first);await second.settled;
 assert.equal(second.getSnapshot().status,'ready');assert.equal(attempts,2);assert.equal(first.getSnapshot().status,'error');
});
