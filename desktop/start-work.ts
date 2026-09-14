import path from 'node:path';
import type { DesktopService } from './service.ts';
import { currentWork, editableCurrent, isConfirmedOfficialSubmission, processSubmission } from '../src/domain/lifecycle.ts';
import { atomicJSON, digest, readJSON } from './files.ts';
import { assertWriteResult } from './baseland-results.ts';

const active=new WeakMap<DesktopService,Map<string,Promise<void>>>();
export async function ensureCaseStarted(service:DesktopService,key:string,id:string):Promise<void>{
  let jobs=active.get(service);if(!jobs){jobs=new Map();active.set(service,jobs);}
  const tag=key+'/'+id;if(jobs.has(tag))return jobs.get(tag)!;
  const job=start(service,key,id).finally(()=>jobs!.delete(tag));jobs.set(tag,job);return job;
}
async function start(service:DesktopService,key:string,id:string){
  service.assertKey(key);const c=service.findCase(id);if(c.source!=='baseland')return;
  const processId=currentWork(c).processId;
  const guard=()=>{service.assertKey(key);const latest=service.findCase(id);if(currentWork(latest).processId!==processId||latest.archived||isConfirmedOfficialSubmission(processSubmission(latest)))throw Error('案件阶段已变化，未启动工作。');return latest;};
  if(!processId||!service.client)throw Error('请先同步并登录贝思兰德。');
  guard();const client=service.client;
  const hand=await client.request('/CaseInfo/GetHandInfo',undefined,{caseProcId:processId});guard();
  const file=path.join(service.root,'profiles',key,'work-start',digest(id+'\n'+processId)+'.json');
  if(!hand?.HandInfo?.CaseHandId){
    const p=guard().remote?.processes.find(p=>p.id===processId);if(p?.status!==0)throw Error('当前流程不是待处理，无法自动启动。');
    if(await readJSON(file,null))throw Error('上次启动结果待核对，请刷新贝思兰德，不能重复启动。');
    await atomicJSON(file,{caseId:id,processId,state:'uncertain',at:new Date().toISOString()});guard();
    const result=await client.request('/CaseInfo/StartHand',undefined,{caseProcId:processId});guard();assertWriteResult('StartHand',result);
  }else if(hand.IsReviewing!==true)throw Error('当前流程已交给其他办理人或不允许编辑，未启动任务。');
  await service.flow(id);const latest=guard();
  if(!latest.remote?.processes.find(p=>p.id===processId)?.handId||!editableCurrent(latest))throw Error('启动后的办理权限尚未确认，请刷新后继续。');
  await atomicJSON(file,{caseId:id,processId,state:'confirmed',at:new Date().toISOString()});
}
