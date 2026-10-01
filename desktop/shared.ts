import { validAssociationIdentity, validCaseAssociations } from '../src/domain/case-record.ts';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { caseLinkMarker } from './case-link-publication.ts';
import { isDeepStrictEqual } from 'node:util';
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
function mergeMaterials(previous:Material[],incoming:Material[]):Material[]{
  if([previous,incoming].some(materials=>new Set(materials.map(m=>m.id)).size!==materials.length))throw new Error('材料标识重复，未替换本机记录');
  const next=incoming.map(m=>{
    const old=previous.find(p=>p.id===m.id);
    if(old?.relativePath&&portable(old.relativePath)!==m.relativePath)throw new Error('材料身份与路径冲突，未替换本机记录');
    return {...old,...m,excerpt:m.excerpt||old?.excerpt||''};
  });
  return [...next,...previous.filter(m=>!next.some(n=>n.id===m.id))];
}
function assertSharedDomains(manifest:Row,domains:Row){
  const identity=object(domains.identity),stage=object(domains.stage),materials=object(domains.materials),transfer=object(domains.transfer),outcome=object(domains.outcome);
  if(!text(identity.id)||!Array.isArray(stage.rounds)||!Array.isArray(materials.common)||!Array.isArray(materials.rounds))throw new Error('案件领域索引不完整');
  const matches=(legacy:unknown,canonical:unknown)=>{
    if(legacy!==undefined&&!isDeepStrictEqual(legacy,canonical))throw new Error('案件领域索引与兼容记录冲突');
  };
  for(const key of ['id','title','number','type','deadline','source','applicationNumber','companyName','caseRemark','caseInfoAt'])matches(manifest[key],identity[key]);
  matches(manifest.current,stage.current);
  matches(manifest.materials,materials.common);
  matches(manifest.remoteCaseId,transfer.remoteCaseId);
  matches(manifest.remoteClosure,outcome.closure);
  matches(manifest.officialOutcome,outcome.official);
  if(manifest.remote!==undefined){
    const remote=object(manifest.remote);
    matches(remote.caseId,transfer.remoteCaseId);
    matches(remote.syncedAt,transfer.syncedAt);
    matches(remote.processes,transfer.processes);
  }
  const rounds=array(stage.rounds).map(object),linked=array(materials.rounds).map(object);
  const ids=rounds.map(r=>text(r.id));
  if(ids.some(id=>!id)||new Set(ids).size!==ids.length||linked.length!==ids.length
    ||new Set(linked.map(r=>r.roundId)).size!==ids.length||linked.some(r=>!ids.includes(text(r.roundId))))throw new Error('轮次材料引用冲突');
  if(manifest.rounds!==undefined)matches(manifest.rounds,rounds.map(r=>({
    id:r.id,name:r.name,...(r.priorArt!==undefined?{priorArt:r.priorArt}:{}),
    materials:linked.find(m=>m.roundId===r.id)?.materials,
  })));
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
  const canEdit=typeof p.canEdit==='boolean'?p.canEdit:undefined;
  const personalStatus=typeof p.personalStatus==='number'&&Number.isFinite(p.personalStatus)?p.personalStatus:undefined;
  return {id,name:text(p.name),procCode:text(p.procCode)||undefined,flowRemark:text(p.flowRemark,20000)||undefined,officeNote:text(p.officeNote,20000)||undefined,procNote:text(p.procNote,20000)||undefined,status:typeof p.status==='number'?p.status:-1,canEdit,personalStatus,node:text(p.node),undertaker:text(p.undertaker),...dates,handId:text(p.handId)||undefined,submission:submission(p.submission),currentFlow:currentFlow(p.currentFlow),needSendOfficial};
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
  if(entries.some(e=>e.name===caseLinkMarker))throw new Error('共享目录的案件关联尚未完成，请在发起关联的电脑上刷新恢复；本次未导入部分状态。');
  if(entries.length>10000)throw new Error('案件目录超过 10,000 项，未进行不完整读取。');
  const seen=new Set<string>(),observed:Array<{file:string;hash:string}>=[];
  for(const entry of entries){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const directory=path.posix.join('案件',profile,entry.name);
    try{
      const root=await managedPath(workRoot,directory),manifestFile=await managedPath(root,'案件信息.json'),manifestBytes=await bytesFile(manifestFile),m=object(JSON.parse(manifestBytes.toString('utf8')));
      observed.push({file:manifestFile,hash:digest(manifestBytes)});
      if(![1,2,3].includes(Number(m.schema))||m.profile!==profile)throw new Error('案件信息不完整或账号不符');
      const domains=object(m.domains),identity=object(domains.identity),stage=object(domains.stage);
      if(Number(m.schema)===3)assertSharedDomains(m,domains);
      const domainMaterials=object(domains.materials),domainOutcome=object(domains.outcome),domainTransfer=object(domains.transfer);
      const hasDomains=Object.keys(domains).length>0&&Object.keys(identity).length>0;
      const id=text(m.id)||text(identity.id),title=text(m.title)||text(identity.title);
      if(!id||!title)throw new Error('案件信息不完整或账号不符');
      const index=cases.findIndex(c=>c.id===id),old=cases[index];
      if(seen.has(id)||old?.directory&&portable(old.directory)!==directory)throw new Error('同一案件存在多个目录，未自动合并');seen.add(id);
      const remoteValue=Object.keys(object(m.remote)).length
        ? m.remote
        : hasDomains
          ? {caseId:text(domainTransfer.remoteCaseId)||text(m.remoteCaseId),syncedAt:text(domainTransfer.syncedAt),processes:array(domainTransfer.processes)}
          : m.remote;
      const sourceValue='source' in m?m.source:identity.source;
      const source=sourceValue==='baseland'||text(m.remoteCaseId)||text(domainTransfer.remoteCaseId)?'baseland':'local';
      const currentValue='current' in m?m.current:stage.current;
      const closureValue='remoteClosure' in m?m.remoteClosure:hasDomains&&'closure' in domainOutcome?domainOutcome.closure:undefined;
      const outcomeValue='officialOutcome' in m?m.officialOutcome:hasDomains&&'official' in domainOutcome?domainOutcome.official:undefined;
      const numberValue='number' in m?m.number:identity.number;
      const typeValue='type' in m?m.type:identity.type;
      const deadlineValue='deadline' in m?m.deadline:identity.deadline;
      const c:Case={...(old??{id,archived:false,tags:[],rounds:[]}),id,title,number:text(numberValue),type:text(typeValue)||old?.type||'未分类',deadline:source==='local'?(calendarDate(deadlineValue)||(text(deadlineValue)?'':'')):'',applicationNumber:text('applicationNumber' in m?m.applicationNumber:identity.applicationNumber)||undefined,companyName:'companyName' in m?text(m.companyName,2000):'companyName' in identity?text(identity.companyName,2000):old?.companyName,caseRemark:'caseRemark' in m?text(m.caseRemark,20000):'caseRemark' in identity?text(identity.caseRemark,20000):old?.caseRemark,caseInfoAt:'caseInfoAt' in m?text(m.caseInfoAt,100):'caseInfoAt' in identity?text(identity.caseInfoAt,100):old?.caseInfoAt,remoteClosure:readClosure(closureValue)??old?.remoteClosure,officialOutcome:readOfficialOutcome(outcomeValue)??old?.officialOutcome,directory,source,current:current(currentValue,old?.current)};
      if(!validAssociationIdentity({...identity,id,source}))throw new Error('关联身份记录无效');
      if(old?.association&&!isDeepStrictEqual(old.association,identity.association)||old?.linkedTo&&old.linkedTo!==identity.linkedTo)throw new Error('已确认的关联身份不能由旧索引覆盖');
      if(typeof identity.linkedTo==='string'&&identity.linkedTo!==id){c.linkedTo=identity.linkedTo;c.archived=true;}
      const association=object(identity.association);
      if(['sourceCaseId','remoteCaseId','linkedAt','localProcessKey'].every(k=>typeof association[k]==='string'))c.association=association as NonNullable<Case['association']>;
      if(c.remoteClosure?.finished&&!old)c.archived=true;
      const stageChanged=!!old&&(old.current?.processId??old.current?.roundId??'local')!==(c.current?.processId??c.current?.roundId??'local');
      if(stageChanged){
        c.localVersions=[...(old.localVersions??[])];
        if(old.localDraft?.trim())c.localVersions.push({id:randomUUID(),text:old.localDraft,at:new Date().toISOString(),processId:old.current?.processId});
        c.localDraft='';c.sharedDraftHash=undefined;
      }
      c.remote=remote(remoteValue)??old?.remote??(text(m.remoteCaseId)||text(domainTransfer.remoteCaseId)?{caseId:text(m.remoteCaseId)||text(domainTransfer.remoteCaseId),processes:[],syncedAt:''}:undefined);
      if(Number(m.schema)===2||Number(m.schema)===3){
        const commonValues=Array.isArray(m.materials)?array(m.materials):hasDomains?array(domainMaterials.common):[];
        const roundValues=Array.isArray(m.rounds)
          ? array(m.rounds)
          : hasDomains
            ? array(stage.rounds).map(raw=>{
            const r=object(raw),roundId=text(r.id);
            const stored=array(domainMaterials.rounds).find(candidate=>text(object(candidate).roundId)===roundId);
            return {...r,materials:stored?array(object(stored).materials):[]};
            })
            : [];
        c.materials=mergeMaterials(old?.materials??[],(await Promise.all(commonValues.map(v=>material(v,root)))).filter((v):v is Material=>v!==null));
        const rounds:Case['rounds']=[];
        for(const raw of roundValues){
          const r=object(raw);if(!text(r.id)||!text(r.name))continue;
          const saved=old?.rounds.find(x=>x.id===r.id),round=saved?structuredClone(saved):makeRound(text(r.name));
          round.id=text(r.id);round.name=text(r.name);round.job=null;
          if(r.priorArt){const p=object(r.priorArt);round.priorArt={checkedAt:text(p.checkedAt,40),noticeSignature:text(p.noticeSignature,100),warning:text(p.warning,2000),items:array(p.items).slice(0,40).flatMap(v=>{const x=object(v);return /^[A-Z]{2}\d{5,14}[A-Z]\d?$/.test(text(x.number))&&['pending','downloaded','failed'].includes(text(x.status))?[{number:text(x.number),status:x.status as 'pending'|'downloaded'|'failed',message:text(x.message,2000),relativePath:text(x.relativePath,2000)||undefined}]:[];})};}
          round.materials=mergeMaterials(saved?.materials??[],(await Promise.all(array(r.materials).map(v=>material(v,root)))).filter((v):v is Material=>v!==null));
          rounds.push(round);
        }
        c.rounds=[...rounds,...(old?.rounds??[]).filter(round=>!rounds.some(incoming=>incoming.id===round.id))];
      }
      const draftPath=await managedPath(root,`02_工作稿/${digest(c.current?.processId??c.current?.roundId??'local').slice(0,10)}/工作稿.json`);
      try{
        const bytes=await bytesFile(draftPath),d=object(JSON.parse(bytes.toString('utf8')));
        if(d.caseId!==c.id||d.processId!==c.current?.processId||typeof d.text!=='string')throw new Error('工作稿不属于当前案件或阶段');
        if(!stageChanged&&old?.localDraft?.trim()&&old.localDraft!==d.text){
          c.localVersions=[...(old.localVersions??[])];
          if(!c.localVersions.some(v=>v.text===old.localDraft&&v.processId===old.current?.processId)){
            c.localVersions.push({id:randomUUID(),text:old.localDraft,at:new Date().toISOString(),processId:old.current?.processId});
          }
        }
        c.localDraft=d.text;c.sharedDraftHash=digest(bytes);
        const versions=array(d.versions).map(x=>{const v=object(x);return {id:text(v.id),text:typeof v.text==='string'?v.text:'',at:text(v.at),processId:text(v.processId)||undefined};}).filter(v=>/^[a-f0-9-]{36}$/i.test(v.id));
        if(versions.some(v=>c.localVersions?.some(old=>old.id===v.id&&(old.text!==v.text||old.processId!==v.processId))))throw new Error('稿件版本身份冲突，未替换本机记录');
        c.localVersions=[...(c.localVersions??[]),...versions.filter(v=>!c.localVersions?.some(x=>x.id===v.id))];
      }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(!old){c.localDraft='';c.localVersions=[];}}
      const normalized=normalizeCase(c);
      if(index<0)cases.push(normalized);else cases[index]=normalized;count++;
    }catch{warnings.push(entry.name+'：记录缺失、不完整或有冲突，未替换本机记录。');}
  }
  try{await fs.lstat(await managedPath(base,caseLinkMarker));throw new Error('读取期间开始了案件关联，未导入部分状态。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  for(const entry of observed)if(digest(await bytesFile(entry.file))!==entry.hash)throw new Error('读取期间案件索引已变化，请刷新重试。');
  if(!validCaseAssociations(cases))throw new Error('关联双方案件尚未完整同步或身份冲突，本次未替换本机记录。');
  return {cases,count,warnings};
}

function readClosure(value:unknown):Case['remoteClosure']{if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>;if(typeof v.finished==='boolean'&&typeof v.checkedAt==='string')return {finished:v.finished,checkedAt:v.checkedAt};}
// 官方结论来自远程判读：只接受已知结论值与判读时间，字段缺失或类型不符时忽略，不猜测、不补默认值。
function readOfficialOutcome(value:unknown):Case['officialOutcome']{
  if(!value||typeof value!=='object')return;
  const v=value as Record<string,unknown>;
  if(!['granted','rejected','none'].includes(String(v.state))||typeof v.checkedAt!=='string'||!v.checkedAt)return;
  const ids=Array.isArray(v.concludedProcessIds)?v.concludedProcessIds.filter((x):x is string=>typeof x==='string'&&!!x).slice(0,64):undefined;
  return {
    state:v.state as NonNullable<Case['officialOutcome']>['state'],
    noticeName:text(v.noticeName,200)||undefined,
    noticeTypeCode:text(v.noticeTypeCode,40)||undefined,
    postDate:text(v.postDate,40)||undefined,
    checkedAt:v.checkedAt,
    ...(v.incomplete===true?{incomplete:true}:{}),
    ...(ids?.length?{concludedProcessIds:ids}:{}),
  };
}
