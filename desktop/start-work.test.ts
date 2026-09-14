import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureCaseStarted } from './start-work.ts';
import type { DesktopService } from './service.ts';

test('start work precedes analysis, confirms hand and does not start twice',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'start-work-'));let started=0,flows=0,hand=false;
 const p={id:'p',status:0,handId:undefined as string|undefined,canEdit:undefined as boolean|undefined};
 const c:any={id:'c',source:'baseland',archived:false,current:{kind:'reply',processId:'p',remoteStatus:0},remote:{processes:[p]}};
 const service:any={root,assertKey:(k:string)=>assert.equal(k,'k'),findCase:()=>c,client:{request:async(ep:string)=>{if(ep.endsWith('GetHandInfo'))return hand?{HandInfo:{CaseHandId:'h'},IsReviewing:true}:{};assert.ok(ep.endsWith('StartHand'));started++;hand=true;return 'Success';}},flow:async()=>{flows++;p.handId='h';p.status=400;p.canEdit=true;c.current.remoteStatus=400;}};
 try{await Promise.all([ensureCaseStarted(service,'k','c'),ensureCaseStarted(service,'k','c')]);assert.equal(started,1);assert.equal(flows,1);await ensureCaseStarted(service,'k','c');assert.equal(started,1);assert.equal(flows,2);}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('uncertain start is not replayed, and another handler cannot start analysis',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'start-work-'));let writes=0,mode='fail';
 const c:any={id:'c',source:'baseland',current:{kind:'reply',processId:'p',remoteStatus:0},remote:{processes:[{id:'p',status:0}]}};
 const service:any={root,assertKey:()=>{},findCase:()=>c,client:{request:async(ep:string)=>{if(ep.endsWith('GetHandInfo'))return mode==='other'?{HandInfo:{CaseHandId:'h'},IsReviewing:false}:{};writes++;throw Error('network lost');}},flow:()=>{throw Error('must not run');}};
 try{await assert.rejects(ensureCaseStarted(service,'k','c'),/network lost/);await assert.rejects(ensureCaseStarted(service,'k','c'),/不能重复启动/);assert.equal(writes,1);mode='other';await assert.rejects(ensureCaseStarted(service,'k','c'),/其他办理人/);}finally{await fs.rm(root,{recursive:true,force:true});}
});
