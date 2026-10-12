import test from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopState } from '../contracts/desktop-state.ts';
import { createWorkspaceStore } from './workspace-data.ts';
import { createModuleData, createModuleDataLease } from './module-data.ts';

function state(): DesktopState {
 return {profileKey:'local',scopeVersion:1,snapshotVersion:1,caseRevisions:{a:0,b:0},account:null,
  workspace:{schema:1,settings:{provider:'',baseUrl:'',model:''},cases:['a','b'].map(id=>({id,title:id,number:id,type:'test',deadline:'',archived:false,tags:[],rounds:[],source:'local',current:{kind:'write'},localDraft:''}))},
  sync:{running:false,message:''},storage:{running:false,message:''},migration:{running:false,phase:'idle',canCancel:false,message:''},version:'test',dataDirectory:''};
}
function gate(){let release!:()=>void;return {wait:new Promise<void>(r=>{release=r;}),release:()=>release()};}

test('one store publishes optimistic edits and server acknowledgements to all subscribers without losing a newer draft',async()=>{
 const hold=gate(),entered=gate();let server=state(),calls=0;
 const store=createWorkspaceStore({initial:server,api:{saveSettings:async()=>server,saveWorkspace:async(_key,workspace)=>{if(++calls===2){entered.release();await hold.wait;}server={...server,snapshotVersion:server.snapshotVersion+1,workspace};return server;}}});
 let left='',right='';const a=store.subscribe(()=>{left=store.getSnapshot().workspace.cases[0].localDraft!;}),b=store.subscribe(()=>{right=store.getSnapshot().workspace.cases[0].localDraft!;});
 const scope=store.scope('a');const first=store.updateCase('a',{localDraft:'first'},scope),second=store.updateCase('a',{localDraft:'second'},scope);
 await entered.wait;assert.equal(left,'second');assert.equal(right,'second');hold.release();await Promise.all([first,second]);
 assert.equal(server.workspace.cases[0].localDraft,'second');assert.equal(store.getSnapshot().nativeState?.snapshotVersion,3);
 a();b();store.dispose();
});

test('account A-B-A invalidates in-flight saves and old module data handles',async()=>{
 const hold=gate(),initial=state();
 const store=createWorkspaceStore({initial,api:{saveSettings:async()=>initial,saveWorkspace:async(_key,workspace)=>{await hold.wait;return {...initial,snapshotVersion:9,workspace};}}});
 const module=createModuleData(store,'a',true),pending=store.updateCase('a',{localDraft:'stale'},store.scope('a'));const rejected=assert.rejects(pending,/作用域/);
 await Promise.resolve();store.receive({...state(),profileKey:'other',scopeVersion:2});store.receive({...state(),scopeVersion:3});hold.release();await rejected;
 assert.equal(store.getSnapshot().workspace.cases[0].localDraft,'');assert.throws(()=>module.case(),/范围已变化/);assert.equal(store.getSnapshot().error,null);
});

test('older snapshots do not override the current value and module snapshots cannot mutate the authority',()=>{
 const store=createWorkspaceStore({initial:state()});
 store.receive({...state(),snapshotVersion:5,workspace:{...state().workspace,cases:state().workspace.cases.map(c=>({...c,title:'new'}))}});
 store.receive({...state(),snapshotVersion:4});assert.equal(store.getSnapshot().workspace.cases[0].title,'new');
 // No API means browser preview; its projected data is still isolated.
 const data=createModuleData(store,'a');const view=data.case();assert.throws(()=>{view.identity.title='mutated';},TypeError);
 assert.equal(store.getSnapshot().workspace.cases[0].title,'new');assert.equal('saveMetadata' in data,false);assert.equal(data.listCases().length,1);
 store.dispose();assert.throws(()=>data.case(),/范围已变化/);
});

test('stage A-B-A expires bound reads, edits and subscriptions even when the process name returns',async()=>{
 const initial=state();const store=createWorkspaceStore({initial,api:{saveWorkspace:async()=>initial,saveSettings:async()=>initial}}),data=createModuleData(store,'a',true);
 let notifications=0;data.subscribe(()=>notifications++);
 store.receive({...initial,snapshotVersion:2,caseRevisions:{a:2,b:0}});
 assert.equal(notifications,0);assert.throws(()=>data.case(),/范围已变化/);
 if('saveMetadata' in data)await assert.rejects(data.saveMetadata!({title:'stale'}),/范围已变化/);else assert.fail('Expected writable lease');
});

test('module metadata edits affect one case and cannot write business state',async()=>{
 const initial=state();let saved=initial;
 const store=createWorkspaceStore({initial,api:{saveWorkspace:async(_key,workspace)=>{saved={...saved,snapshotVersion:saved.snapshotVersion+1,workspace};return saved;},saveSettings:async()=>saved}});
 const data=createModuleData(store,'a',true);assert.ok('saveMetadata' in data);
 await data.saveMetadata!({title:'edited'});assert.equal(saved.workspace.cases[0].title,'edited');assert.equal(saved.workspace.cases[1].title,'b');
 await assert.rejects(data.saveMetadata!({current:{kind:'review'}} as never),/未授权字段/);
});

test('a settings response arriving after an account switch cannot restore its settings',async()=>{
 const hold=gate(),initial=state();const store=createWorkspaceStore({initial,api:{saveWorkspace:async()=>initial,saveSettings:async()=>{await hold.wait;return {...initial,snapshotVersion:8,workspace:{...initial.workspace,settings:{provider:'OLD',baseUrl:'',model:''}}};}}});
 const saved=store.saveSettings({provider:'OLD',baseUrl:'',model:''}),rejected=assert.rejects(saved,/账号已变化/);
 store.receive({...state(),profileKey:'other',scopeVersion:2});hold.release();await rejected;
 assert.equal(store.getSnapshot().workspace.settings.provider,'');assert.equal(store.getSnapshot().nativeState?.profileKey,'other');
});

test('unmounting a module expires retained callbacks and releases its subscriptions',async()=>{
 const initial=state(),store=createWorkspaceStore({initial,api:{saveWorkspace:async()=>{throw Error('Must not write')},saveSettings:async()=>initial}});
 const lease=createModuleDataLease(store,'a',true);let calls=0;lease.data.subscribe(()=>calls++);lease.dispose();
 store.receive({...initial,snapshotVersion:2});assert.equal(calls,0);assert.throws(()=>lease.data.case(),/范围已变化/);
 if('saveMetadata' in lease.data)await assert.rejects(lease.data.saveMetadata!({title:'late'}),/范围已变化/);
});

test('module list snapshots are stable for subscriptions and refresh only from a new workspace',async()=>{
 const initial=state(),store=createWorkspaceStore({preview:initial.workspace}),global=createModuleData(store),single=createModuleData(store,'a');
 const globalBefore=global.listCases(),singleBefore=single.listCases();
 assert.equal(global.listCases(),globalBefore);assert.equal(single.listCases(),singleBefore);
 assert.equal(globalBefore.length,2);assert.deepEqual(singleBefore.map(c=>c.id),['a']);
 await store.updateCase('a',{title:'new'});
 assert.notEqual(global.listCases(),globalBefore);assert.equal(single.listCases()[0].title,'new');
 assert.equal(singleBefore[0].title,'a');assert.equal(globalBefore[0].title,'a');
 assert.throws(()=>single.listCases().push(singleBefore[0]),TypeError);
});
