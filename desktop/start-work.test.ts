import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureCaseStarted } from './start-work.ts';
import { DesktopService } from './service.ts';
import type { Case } from '../src/domain/workflow.ts';

function fixture(root:string){
 const service=new DesktopService(root,{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
 service.key='k';
 const c:Case={id:'c',number:'SYN-START',title:'合成启动案件',type:'发明',deadline:'',tags:[],rounds:[],source:'baseland',archived:false,current:{kind:'reply',processId:'p',remoteStatus:0},remote:{caseId:'remote',syncedAt:'',processes:[{id:'p',name:'答复',status:0,node:'',undertaker:'',deadline:''}]}};
 service.workspace.cases=[c];
 return {service,c,p:c.remote!.processes[0]};
}

test('start work precedes analysis, confirms hand and does not start twice',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'start-work-'));let started=0,flows=0,hand=false;
 const {service,c,p}=fixture(root);
 service.client={request:async(ep:string)=>{if(ep.endsWith('GetHandInfo'))return hand?{HandInfo:{CaseHandId:'h'},IsReviewing:true}:{};assert.ok(ep.endsWith('StartHand'));started++;hand=true;return 'Success';}} as never;
 service.flow=async()=>{flows++;p.handId='h';p.status=400;p.canEdit=true;c.current!.remoteStatus=400;return {at:'',currentProcessId:'p',processes:c.remote!,currentFlow:undefined,nodes:[],history:[]};};
 try{await Promise.all([ensureCaseStarted(service,'k','c'),ensureCaseStarted(service,'k','c')]);assert.equal(started,1);assert.equal(flows,1);await ensureCaseStarted(service,'k','c');assert.equal(started,1);assert.equal(flows,2);}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('failed StartHand can retry, and another handler cannot start analysis',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'start-work-'));let started=0,mode='fail';
 const {service}=fixture(root);
 service.client={request:async(ep:string)=>{if(ep.endsWith('GetHandInfo'))return mode==='other'?{HandInfo:{CaseHandId:'h'},IsReviewing:false}:{};assert.ok(ep.endsWith('StartHand'));started++;throw Error('network lost');}} as never;
 service.flow=()=>{throw Error('must not run');};
 try{await assert.rejects(ensureCaseStarted(service,'k','c'),/network lost/);await assert.rejects(ensureCaseStarted(service,'k','c'),/network lost/);assert.equal(started,2);mode='other';await assert.rejects(ensureCaseStarted(service,'k','c'),/其他办理人/);assert.equal(started,2);}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('start work cannot send a write after account ABA during the permission read',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'start-aba-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {service}=fixture(root);
 let entered!:()=>void,release!:()=>void,writes=0;
 const begun=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 service.client={request:async(ep:string)=>{if(ep.endsWith('GetHandInfo')){entered();await held;return {};}writes++;return 'Success';}} as never;
 const pending=ensureCaseStarted(service,'k','c'),rejected=assert.rejects(pending,/作用域已变化/);
 await begun;service.key='other';service.generation++;service.key='k';service.generation++;
 release();await rejected;
 assert.equal(writes,0);
 assert.deepEqual(await fs.readdir(root),[]);
});

test('real flow read after StartHand retains the pending case scope when editing remains permitted',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'start-real-flow-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {service,c}=fixture(root);
 service.workspace.settings.workRoot=path.join(root,'work');
 await fs.mkdir(service.workspace.settings.workRoot);
 service.account={username:'synthetic',displayName:'Synthetic',organization:'Test',origin:'https://fixture.baselandtec.com',userId:'u',status:'authenticated',remembered:false};
 let started=0,hand=false;
 service.client={
  request:async(ep:string)=>{
   if(ep.endsWith('GetHandInfo'))return hand?{HandInfo:{CaseHandId:'h'},IsReviewing:true}:{};
   assert.ok(ep.endsWith('StartHand'));started++;hand=true;return 'Success';
  },
  flow:async(item:Case)=>({
   at:new Date().toISOString(),currentProcessId:'p',nodes:[],history:[],
   processes:{...structuredClone(item.remote!),processes:[{...item.remote!.processes[0],status:400,handId:'h',canEdit:true}]},
  }),
 } as never;
 const scope=service.captureScope(service.key,c.id);
 await ensureCaseStarted(service,service.key,c.id);
 service.assertScope(scope);
 assert.equal(service.transferCase(c.id).stage.editable,true);
 assert.equal(service.transferCase(c.id).transfer.currentProcess?.handId,'h');
 await ensureCaseStarted(service,service.key,c.id);
 assert.equal(started,1);
 service.assertScope(scope);
});
