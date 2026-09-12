import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Case, CurrentFlowInfo, Material, RemoteProcess, Submission, SubmissionState } from '../src/domain/workflow.ts';
import type { CurrentWork, WorkKind } from '../src/domain/lifecycle.ts';
import { makeRound } from '../src/domain/workflow.ts';
import { digest, managedPath, portable } from './files.ts';
import { calendarDate, migrateProcessDeadlines } from '../src/domain/deadlines.ts';
import { normalizeCase } from '../src/domain/lifecycle.ts';

type Row=Record<string,unknown>;
const object=(x:unknown):Row=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Row:{};
const text=(x:unknown,max=500)=>typeof x==='string'?x.slice(0,max):'';
const array=(x:unknown):unknown[]=>Array.isArray(x)?x:[];
const kinds:WorkKind[]=['write','reply','correction','review','waiting','external','needs-confirmation'];
async function bytesFile(file:string){const stat=await fs.stat(file);if(stat.size>8*1024*1024)throw new Error('记录过大');return fs.readFile(file);}
async function jsonFile(file:string){return object(JSON.parse((await bytesFile(file)).toString('utf8')));}
function current(value:unknown,previous?:CurrentWork):CurrentWork {
  const v=object(value);
  if(!kinds.includes(v.kind as WorkKind))return previous??{kind:'needs-confirmation',label:'旧版目录缺少当前阶段记录，历史文件已保留'};
  const party=v.party==='官方'||v.party==='内部'?v.party:undefined;
  return {
    kind:v.kind as WorkKind,processId:text(v.processId)||undefined,roundId:text(v.roundId)||undefined,label:text(v.label)||undefined,
    remoteStatus:typeof v.remoteStatus==='number'?v.remoteStatus:undefined,node:text(v.node)||undefined,party,handler:text(v.handler)||undefined,
  };
}
function currentFlow(value:unknown):CurrentFlowInfo|undefined {
  const o=object(value),name=text(o.name);
  if(!name)return undefined;
  const serial=typeof o.serial==='number'&&Number.isFinite(o.serial)?o.serial:undefined;
  const total=typeof o.total==='number'&&Number.isFinite(o.total)?o.total:undefined;
  return {name,user:text(o.user),serial,total};
}
async function material(value:unknown,root:string):Promise<Material|null>{
  const m=object(value),id=text(m.id),name=text(m.name),relative=portable(text(m.relativePath,2000));
  if(!id||!name||!relative)return null;
  let ready=false;try{ready=(await fs.stat(await managedPath(root,relative))).isFile();}catch{/* Cloud placeholder/missing file stays visibly unavailable. */}
  return {id,name,relativePath:relative,role:text(m.role)||'案件材料',location:text(m.location),fileNo:text(m.fileNo)||undefined,excerpt:'',ready};
}
const submissionStates:SubmissionState[]=['unknown','draft','queued','sending','sent','received','failed'];
function submission(value:unknown):Submission|undefined {
  const s=object(value),state=text(s.state) as SubmissionState,checked=text(s.checkedAt,40);
  if(!submissionStates.includes(state)||!checked)return undefined;
  const source=s.source==='hand'||s.source==='send-status'?s.source:undefined;
  return {state,checkedAt:checked,message:text(s.message,200)||undefined,source,refreshError:text(s.refreshError,200)||undefined};
}
function remoteProcess(value:unknown):RemoteProcess|null {
  const p=object(value),id=text(p.id);if(!id)return null;
  const dates=migrateProcessDeadlines(p);
  const needSendOfficial=p.needSendOfficial===true?true:p.needSendOfficial===false?false:undefined;
  return {id,name:text(p.name),procCode:text(p.procCode)||undefined,flowRemark:text(p.flowRemark,20000)||undefined,officeNote:text(p.officeNote,20000)||undefined,procNote:text(p.procNote,20000)||undefined,status:typeof p.status==='number'?p.status:-1,node:text(p.node),undertaker:text(p.undertaker),...dates,handId:text(p.handId)||undefined,submission:submission(p.submission),currentFlow:currentFlow(p.currentFlow),needSendOfficial};
}
function remote(value:unknown):Case['remote'] {
  const r=object(value),caseId=text(r.caseId);if(!caseId)return undefined;
  const processes:RemoteProcess[]=array(r.processes).map(remoteProcess).filter((p):p is RemoteProcess=>p!==null);
  return {caseId,processes,syncedAt:text(r.syncedAt)};
}
// Read only the current account's generated case index. Never traverse another account or import arbitrary folders.
export async function readSharedCases(workRoot:string,profile:string,existing:Case[]) {
  const cases=structuredClone(existing),warnings:string[]=[];let count=0;
  const base=await managedPath(workRoot,path.posix.join('案件',profile));
  let entries:Dirent[];try{entries=await fs.readdir(base,{withFileTypes:true}) as Dirent[];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {cases,count,warnings};throw e;}
  if(entries.length>10000)throw new Error('案件目录超过 10,000 项，未进行不完整读取。');
  const seen=new Set<string>();
  for(const entry of entries){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const directory=path.posix.join('案件',profile,entry.name);
    try{
      const root=await managedPath(workRoot,directory),m=await jsonFile(await managedPath(root,'案件信息.json'));
      if(![1,2].includes(Number(m.schema))||m.profile!==profile||!text(m.id)||!text(m.title))throw new Error('案件信息不完整或账号不符');
      const id=text(m.id),index=cases.findIndex(c=>c.id===id),old=cases[index];
      if(seen.has(id)||old?.directory&&portable(old.directory)!==directory)throw new Error('同一案件存在多个目录，未自动合并');seen.add(id);
      const source=m.source==='baseland'||m.remoteCaseId?'baseland':'local';
      const c:Case={...(old??{id,archived:false,tags:[],rounds:[]}),id,title:text(m.title),number:text(m.number),type:text(m.type)||old?.type||'未分类',deadline:source==='local'?(calendarDate(m.deadline)||(text(m.deadline)?'':'')):'',applicationNumber:text(m.applicationNumber)||undefined,companyName:'companyName' in m?text(m.companyName,2000):old?.companyName,caseRemark:'caseRemark' in m?text(m.caseRemark,20000):old?.caseRemark,caseInfoAt:'caseInfoAt' in m?text(m.caseInfoAt,100):old?.caseInfoAt,remoteClosure:readClosure(m.remoteClosure)??old?.remoteClosure,directory,source,current:current(m.current,old?.current)};
      if(c.remoteClosure?.finished&&!old)c.archived=true;
      const stageChanged=!!old&&(old.current?.processId??old.current?.roundId??'local')!==(c.current?.processId??c.current?.roundId??'local');
      if(stageChanged){
        c.localVersions=[...(old.localVersions??[])];
        if(old.localDraft?.trim())c.localVersions.push({id:randomUUID(),text:old.localDraft,at:new Date().toISOString(),processId:old.current?.processId});
        c.localDraft='';c.sharedDraftHash=undefined;
      }
      c.remote=remote(m.remote)??old?.remote??(text(m.remoteCaseId)?{caseId:text(m.remoteCaseId),processes:[],syncedAt:''}:undefined);
      if(Number(m.schema)===2){
        c.materials=(await Promise.all(array(m.materials).map(v=>material(v,root)))).filter((v):v is Material=>v!==null);
        const rounds=[];
        for(const raw of array(m.rounds)){
          const r=object(raw);if(!text(r.id)||!text(r.name))continue;
          const saved=old?.rounds.find(x=>x.id===r.id),round=saved?structuredClone(saved):makeRound(text(r.name));
          round.id=text(r.id);round.name=text(r.name);round.job=null;
          if(r.priorArt){const p=object(r.priorArt);round.priorArt={checkedAt:text(p.checkedAt,40),noticeSignature:text(p.noticeSignature,100),warning:text(p.warning,2000),items:array(p.items).slice(0,40).flatMap(v=>{const x=object(v);return /^[A-Z]{2}\d{5,14}[A-Z]\d?$/.test(text(x.number))&&['pending','downloaded','failed'].includes(text(x.status))?[{number:text(x.number),status:x.status as 'pending'|'downloaded'|'failed',message:text(x.message,2000),relativePath:text(x.relativePath,2000)||undefined}]:[];})};}
          round.materials=(await Promise.all(array(r.materials).map(v=>material(v,root)))).filter((v):v is Material=>v!==null);
          rounds.push(round);
        }
        c.rounds=rounds;
      }
      const draftPath=await managedPath(root,`02_工作稿/${digest(c.current?.processId??c.current?.roundId??'local').slice(0,10)}/工作稿.json`);
      try{
        const bytes=await bytesFile(draftPath),d=object(JSON.parse(bytes.toString('utf8')));
        if(d.caseId!==c.id||d.processId!==c.current?.processId||typeof d.text!=='string')throw new Error('工作稿不属于当前案件或阶段');
        c.localDraft=d.text;c.sharedDraftHash=digest(bytes);
        const versions=array(d.versions).map(x=>{const v=object(x);return {id:text(v.id),text:typeof v.text==='string'?v.text:'',at:text(v.at),processId:text(v.processId)||undefined};}).filter(v=>/^[a-f0-9-]{36}$/i.test(v.id));
        c.localVersions=stageChanged?[...(c.localVersions??[]),...versions.filter(v=>!c.localVersions?.some(x=>x.id===v.id))]:versions;
      }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(!old){c.localDraft='';c.localVersions=[];}}
      const normalized=normalizeCase(c);
      if(index<0)cases.push(normalized);else cases[index]=normalized;count++;
    }catch{warnings.push(entry.name+'：记录缺失、不完整或有冲突，未替换本机记录。');}
  }
  return {cases,count,warnings};
}

function readClosure(value:unknown):Case['remoteClosure']{if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>;if(typeof v.finished==='boolean'&&typeof v.checkedAt==='string')return {finished:v.finished,checkedAt:v.checkedAt};}
