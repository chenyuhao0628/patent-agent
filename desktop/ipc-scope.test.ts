import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopService } from './service.ts';
import { captureIpcScope, dispatchScopedIpc } from './ipc-scope.ts';
import type { IpcArgs } from '../src/contracts/ipc.ts';
import { defaultTransferForm } from './baseland-transfer.ts';

const noSession={requestScope:()=>{throw new Error('not a session request');}};
function queue(){
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  return {release,enqueue:<T>(fn:()=>Promise<T>)=>held.then(fn)};
}
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ipc-scope-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const service=new DesktopService(root,{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
  service.workspace.settings.workRoot=path.join(root,'work');
  await fs.mkdir(service.workspace.settings.workRoot);
  await service.createCase({title:'Synthetic',number:'IPC-1',kind:'write'});
  return {service,id:service.workspace.cases[0].id};
}

test('queued IPC freezes account generation before the host is invoked',async t=>{
  const {service,id}=await fixture(t),q=queue();
  let called=false;
  const pending=dispatchScopedIpc(service,noSession,'professionalPickReferences',['local',id],async()=>{called=true;},q.enqueue);
  const rejected=assert.rejects(pending,/作用域已变化/);
  service.key='other';service.generation++;service.key='local';service.generation++;
  q.release();await rejected;assert.equal(called,false);
});

test('queued IPC rejects same-case stage ABA and changed work root',async t=>{
  const {service,id}=await fixture(t);
  for(const change of ['stage','root']){
    const q=queue();let called=false;
    const pending=dispatchScopedIpc(service,noSession,'professionalCommand',['local',id,{type:'ready-manual'}],async()=>{called=true;},q.enqueue);
    const rejected=assert.rejects(pending,/阶段已重新切换|目录已变化/);
    if(change==='stage'){
      for(const kind of ['review','write'] as const){
        const edit=structuredClone(service.workspace);edit.cases[0].current={kind};
        await service.save('local',edit,service.captureScope('local',id));
      }
    }else service.workspace.settings.workRoot+='-changed';
    q.release();await rejected;assert.equal(called,false);
  }
});

test('transfer session requests bind to the owning case rather than treating session ID as case ID',async t=>{
  const {service,id}=await fixture(t),scope=service.captureScope('local',id),q=queue();
  const transfer={requestScope:(key:string,session:string)=>{assert.equal(key,'local');assert.equal(session,'session-only');return scope;}};
  const args:IpcArgs<'transferSaveLocalReview'>=['local','session-only',{stepId:'step',userId:'user',remark:'original',keepCodes:[],form:defaultTransferForm(null)}];
  const pending=dispatchScopedIpc(service,transfer,'transferSaveLocalReview',args,async(_key,_id,review)=>review.remark,q.enqueue);
  args[2].remark='changed after enqueue';q.release();
  assert.equal(await pending,'original');
});

test('workspace scope is checked at receipt, while login and logout stay available for unsafe storage',async t=>{
  const {service,id}=await fixture(t);
  const scope=service.captureScope('local',id);
  service.generation++;
  assert.throws(()=>captureIpcScope(service,noSession,'saveWorkspace',['local',service.workspace,scope]),/作用域已变化/);
  Object.assign(service,{profileStorageUnsafe:true});
  service.assertMigrationNotAccepted(false);
  assert.equal(captureIpcScope(service,noSession,'logout',[]),undefined);
  assert.equal(await dispatchScopedIpc(service,noSession,'logout',[],async()=> 'recovery'), 'recovery');
});
