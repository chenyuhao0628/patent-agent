import path from 'node:path';
import type { DesktopService } from './service.ts';
import { currentWork, editableCurrent, isConfirmedOfficialSubmission, processSubmission } from '../src/domain/lifecycle.ts';
import { atomicJSON, digest, readJSON } from './files.ts';
import { assertWriteResult } from './baseland-results.ts';

type StartMarker = { caseId: string; processId: string; state: 'uncertain' | 'failed' | 'confirmed'; at: string };

const active=new WeakMap<DesktopService,Map<string,Promise<void>>>();
export async function ensureCaseStarted(service:DesktopService,key:string,id:string):Promise<void>{
  let jobs=active.get(service);if(!jobs){jobs=new Map();active.set(service,jobs);}
  const tag=key+'/'+id;if(jobs.has(tag))return jobs.get(tag)!;
  const job=start(service,key,id).finally(()=>jobs!.delete(tag));jobs.set(tag,job);return job;
}
async function markFailed(file:string,caseId:string,processId:string){
  await atomicJSON(file,{caseId,processId,state:'failed',at:new Date().toISOString()} satisfies StartMarker);
}
async function start(service:DesktopService,key:string,id:string){
  service.assertKey(key);const c=service.findCase(id);if(c.source!=='baseland')return;
  const processId=currentWork(c).processId;
  const guard=()=>{service.assertKey(key);const latest=service.findCase(id);if(currentWork(latest).processId!==processId||latest.archived||isConfirmedOfficialSubmission(processSubmission(latest)))throw Error('案件阶段已变化，未启动工作。');return latest;};
  if(!processId||!service.client)throw Error('请先同步并登录贝思兰德。');
  guard();const client=service.client;
  const file=path.join(service.root,'profiles',key,'work-start',digest(id+'\n'+processId)+'.json');
  const readHand=async()=>{const hand=await client.request('/CaseInfo/GetHandInfo',undefined,{caseProcId:processId});guard();return hand;};
  let hand=await readHand();
  if(!hand?.HandInfo?.CaseHandId){
    const p=guard().remote?.processes.find(item=>item.id===processId);if(p?.status!==0)throw Error('当前流程不是待处理，无法自动启动。');
    const marker=await readJSON<StartMarker|null>(file,null);
    if(marker?.state==='uncertain'){
      hand=await readHand();
      if(!hand?.HandInfo?.CaseHandId)await markFailed(file,id,processId);
    }
    if(!hand?.HandInfo?.CaseHandId){
      try{
        const result=await client.request('/CaseInfo/StartHand',undefined,{caseProcId:processId});guard();assertWriteResult('StartHand',result);
        await atomicJSON(file,{caseId:id,processId,state:'uncertain',at:new Date().toISOString()} satisfies StartMarker);guard();
      }catch(error){
        const written=await readJSON<StartMarker|null>(file,null);
        if(written?.state==='uncertain')await markFailed(file,id,processId);
        throw error;
      }
    }
  }
  if(hand?.HandInfo?.CaseHandId&&hand.IsReviewing!==true)throw Error('当前流程已交给其他办理人或不允许编辑，未启动任务。');
  await service.flow(id);const latest=guard();
  if(!latest.remote?.processes.find(item=>item.id===processId)?.handId||!editableCurrent(latest))throw Error('启动后的办理权限尚未确认，请刷新后继续。');
  await atomicJSON(file,{caseId:id,processId,state:'confirmed',at:new Date().toISOString()} satisfies StartMarker);
}
