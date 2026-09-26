import path from 'node:path';
import type { DesktopService, OperationScope } from './service.ts';
import { isConfirmedOfficialSubmission } from '../src/domain/lifecycle.ts';
import { atomicJSON, digest, readJSON } from './files.ts';
import { assertWriteResult } from './baseland-results.ts';

type StartMarker = { caseId: string; processId: string; state: 'uncertain' | 'failed' | 'confirmed'; at: string };

const active=new WeakMap<DesktopService,Map<string,Promise<void>>>();
export async function ensureCaseStarted(service:DesktopService,key:string,id:string):Promise<void>{
  const scope=service.captureScope(key,id);
  let jobs=active.get(service);if(!jobs){jobs=new Map();active.set(service,jobs);}
  const tag=JSON.stringify(scope);if(jobs.has(tag))return jobs.get(tag)!;
  const job=start(service,scope,id).finally(()=>jobs!.delete(tag));jobs.set(tag,job);return job;
}
async function markFailed(file:string,caseId:string,processId:string,guard:()=>void){
  await atomicJSON(file,{caseId,processId,state:'failed',at:new Date().toISOString()} satisfies StartMarker,guard);
}
async function start(service:DesktopService,scope:OperationScope,id:string){
  const key=scope.profileKey;
  service.assertScope(scope);const c=service.transferCase(id);if(c.identity.source!=='baseland')return;
  const processId=c.stage.current.processId;
  const guard=()=>{service.assertScope(scope);const latest=service.transferCase(id);if(latest.stage.current.processId!==processId||latest.identity.archived||isConfirmedOfficialSubmission(latest.transfer.currentSubmission))throw Error('案件阶段已变化，未启动工作。');return latest;};
  if(!processId||!service.client)throw Error('请先同步并登录贝思兰德。');
  guard();const client=service.client;
  const file=path.join(service.root,'profiles',key,'work-start',digest(id+'\n'+processId)+'.json');
  const readHand=async()=>{const hand=await client.request('/CaseInfo/GetHandInfo',undefined,{caseProcId:processId});guard();return hand;};
  let hand=await readHand();
  if(!hand?.HandInfo?.CaseHandId){
    const p=guard().transfer.currentProcess;if(p?.status!==0)throw Error('当前流程不是待处理，无法自动启动。');
    const marker=await readJSON<StartMarker|null>(file,null);
    guard();
    if(marker?.state==='uncertain'){
      hand=await readHand();
      if(!hand?.HandInfo?.CaseHandId)await markFailed(file,id,processId,guard);
    }
    if(!hand?.HandInfo?.CaseHandId){
      try{
        const result=await client.request('/CaseInfo/StartHand',undefined,{caseProcId:processId});guard();assertWriteResult('StartHand',result);
        await atomicJSON(file,{caseId:id,processId,state:'uncertain',at:new Date().toISOString()} satisfies StartMarker,guard);guard();
      }catch(error){
        const written=await readJSON<StartMarker|null>(file,null);
        if(written?.state==='uncertain')await markFailed(file,id,processId,guard);
        throw error;
      }
    }
  }
  if(hand?.HandInfo?.CaseHandId&&hand.IsReviewing!==true)throw Error('当前流程已交给其他办理人或不允许编辑，未启动任务。');
  await service.flow(id);const latest=guard();
  if(!latest.transfer.currentProcess?.handId||!latest.stage.editable)throw Error('启动后的办理权限尚未确认，请刷新后继续。');
  await atomicJSON(file,{caseId:id,processId,state:'confirmed',at:new Date().toISOString()} satisfies StartMarker,guard);
}
