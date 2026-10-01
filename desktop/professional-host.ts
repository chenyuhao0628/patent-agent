import { professionalTaskMemory, taskMemoryView } from '../src/domain/task-memory.ts';
import { exportStageDocx, readStageDocx } from './stage-docx.ts';
import fs from 'node:fs/promises';
import {diagnostic,diagnosticStage,withDiagnostics} from './diagnostics.ts';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Material } from '../src/domain/workflow.ts';
import { currentWritingJobs, canChooseWritingStart, professionalWorkEditableForView, professionalWritingEditableForView } from '../src/domain/professional-policy.ts';
import type { CaseProfessionalView } from '../src/domain/case-view.ts';
import { WRITING_PHASES } from '../src/professional-api.ts';
import { PROFESSIONAL_DECISION_MAX, PROFESSIONAL_WRITE_MESSAGE_MAX } from '../src/professional-api.ts';
import type { ProfessionalCaseView, ProfessionalCommand, ProfessionalJob, ProfessionalRecord, ReviewQueueItem, ReviewSource, WorkFile } from '../src/professional-api.ts';
import type { AgentHost, AgentHostRun, AgentHostRunHandle, AgentHostMaterialSnapshot } from './agent-host.ts';
import type { DesktopService, OperationScope } from './service.ts';
import type { ModelService } from './model-service.ts';
import { atomicCreate, atomicJSON, digest, readJSON, readBoundedFile, safeName, managedPath } from './files.ts';
import { exportApplicationText } from './document-export.ts';
import type { ApplicationText } from './document-export.ts';
import { loadStandardSkill, SKILL_ADAPTER } from './standard-skills.ts';

type Store={schema:1;records:ProfessionalRecord[]};
type Live={key:string;generation:number;root:string;caseId:string;processKey:string;scope:OperationScope;job:ProfessionalJob;abort:AbortController;handle?:AgentHostRunHandle;wait?:Promise<void>;partial:string;source?:ReviewSource};
const sourceKey=(s:{caseId:string;processKey:string;id:string})=>JSON.stringify([s.caseId,s.processKey,s.id]);
const reportsFor=(source:ReviewSource)=>(source.reports??[]).filter(job=>
  job.kind==='review'&&job.caseId===source.caseId&&job.processKey===source.processKey&&job.sourceId===source.id);
function recordView(record:ProfessionalRecord):ProfessionalRecord{
  return structuredClone({...record,
    jobs:record.jobs.filter(job=>job.caseId===record.caseId&&job.processKey===record.processKey),
    sources:record.sources.filter(source=>source.caseId===record.caseId&&source.processKey===record.processKey)
      .map(source=>({...source,reports:reportsFor(source)})),
  });
}
const viewOf=(c:CaseProfessionalView):CaseProfessionalView=>c;
const keyOfView=(view:CaseProfessionalView)=>{const w=view.stage.current;return (w.processId||w.roundId||`local-${w.kind}`).trim();};
const keyOf=(c:CaseProfessionalView)=>keyOfView(viewOf(c));
const materialList=(c:CaseProfessionalView)=>viewOf(c).materials.current.map(material=>({...material})).filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i);
export function parseProfessionalResult(text:string,kind:'writing'|'review',phase?:number) {
  let obj:any;try{obj=JSON.parse(text);}catch{throw new Error('模型未返回完整 JSON 产物，请重试；现有版本保留。');}
  if(obj.kind!==kind||typeof obj.text!=='string'||!obj.text.trim()||obj.text.length>400000)throw new Error('模型产物类型或正文无效。');
  let documents:Record<string,string>|undefined;
  if(kind==='writing'&&phase===4){
    const keys=['ABSTRACT','ABSTRACT_IMAGE','CLAIMS','DESCRIPTION','DRAWINGS'];
    if(!obj.documents||keys.some(k=>typeof obj.documents[k]!=='string')||!obj.documents.CLAIMS.trim()||!obj.documents.DESCRIPTION.trim()||!obj.documents.ABSTRACT.trim())throw new Error('申请整理结果缺少完整的摘要、权利要求或说明书。');
    documents=Object.fromEntries(keys.map(k=>[k,obj.documents[k]]));
  }
  return {text:obj.text.trim(),documents};
}
export class ProfessionalHost {
  private stores=new Map<string,Store>();private active=new Map<string,Live>();private operations=Promise.resolve();private closed=false;
  changed:(key:string)=>void=()=>{};
  readonly service:DesktopService; readonly agent:AgentHost; readonly models:ModelService; readonly run:AgentHostRun; readonly resources:string;
  constructor(service:DesktopService,agent:AgentHost,models:ModelService,run:AgentHostRun,resources:string){this.service=service;this.agent=agent;this.models=models;this.run=run;this.resources=resources;}
  private serial<T>(fn:()=>Promise<T>){const p=this.operations.then(fn);this.operations=p.then(()=>{},()=>{});return p;}
  private activeKey(key:string,id:string){return JSON.stringify([key,id]);}
  private scoped<T>(key:string,id:string|undefined,fn:(scope:OperationScope)=>Promise<T>){
    const scope=this.service.captureScope(key,id);
    return this.serial(async()=>{this.service.assertScope(scope);const result=await fn(scope);this.service.assertScope(scope);return result;});
  }
  private file(key:string){return path.join(this.service.root,'profiles',key,'professional-work.json');}
  private async store(key:string){
    if(this.stores.has(key))return this.stores.get(key)!;
    const store=await readJSON<Store>(this.file(key),{schema:1,records:[]});
    if(store.schema!==1||!Array.isArray(store.records)||store.records.some(r=>!r||typeof r.caseId!=='string'||typeof r.processKey!=='string'||!Array.isArray(r.jobs)||!Array.isArray(r.sources)||!Array.isArray(r.confirmations)))throw new Error('撰写与审查记录格式无效，未覆盖原记录。');
    for(const record of store.records)for(const job of record.jobs)if(job.state==='running'){job.state='stopped';job.error='应用已重开，上次任务已停止；原稿及记录保留。';}
    this.stores.set(key,store);return store;
  }
  private async persist(key:string,scope?:OperationScope){await atomicJSON(this.file(key),await this.store(key),scope?()=>this.service.assertScope(scope):undefined);this.changed(key);}
  private guard(key:string,id:string,processKey?:string){
    this.service.assertKey(key);this.service.assertMigrationNotAccepted();if(this.closed)throw new Error('应用正在退出。');
    const c=this.service.professionalCase(id);if(processKey&&keyOf(c)!==processKey)throw new Error('当前案件流程已变化。');return c;
  }
  private liveValid(l:Live){try{this.service.assertScope(l.scope);this.guard(l.key,l.caseId,l.processKey);return !l.abort.signal.aborted&&!this.closed;}catch{return false;}}
  private record(store:Store,c:CaseProfessionalView){
    const processKey=keyOf(c);
    let r=store.records.find(r=>r.caseId===c.identity.id&&r.processKey===processKey);
    if(!r){
      const association=c.identity.association;
      const previous=association?.processId===processKey&&c.stage.kind==='write'?store.records.find(r=>r.caseId===c.identity.id&&r.processKey===association.localProcessKey):undefined;
      r=previous?{...structuredClone(previous),processKey,jobs:previous.jobs.map(job=>({...structuredClone(job),processKey})),sources:previous.sources.map(source=>({...structuredClone(source),processKey,reports:source.reports?.map(job=>({...structuredClone(job),processKey}))}))}:{caseId:c.identity.id,processKey,phase:0,confirmations:[],jobs:[],sources:[],completed:false};
      store.records.push(r);
    }
    return r;
  }
  assertIdleForMigration(){if(this.active.size)throw new Error('请先停止撰写或个人审查任务，再迁移目录或更换文档组件。');}
  noteScopeChange(){for(const l of this.active.values())if(!this.liveValid(l)){l.abort.abort();l.handle?.abort();}}
  async shutdown(){this.closed=true;for(const l of this.active.values()){l.abort.abort();l.handle?.abort();}await Promise.all([...this.active.values()].map(l=>l.wait?.catch(()=>{})));await this.operations;}
  private async archiveReason(c:CaseProfessionalView,source:ReviewSource) {
    const view=viewOf(c);
    if(source.supersededAt)return '已有后续稿件版本';
    if(c.identity.archived)return '案件已归档';
    if(c.officialOutcome.closure?.finished)return '案件已结案';
    if(c.officialOutcome.locksCurrent)return '已有官方结论';
    if(keyOfView(view)!==source.processKey)return '已进入后续办理流程';
    if(view.stage.officialWaiting)return '已递交，等待官方处理结果';
    if(!['write','reply','correction','review'].includes(view.stage.kind))return '当前业务不可继续审查';
    if(!professionalWorkEditableForView(view))return '当前案件仅可查看';
    if(!c.identity.hasDirectory)return undefined;
    const folder=await this.service.casePath(c.identity.id,'04_内部说明');
    let names:string[]=[];try{names=await fs.readdir(folder);}catch{return undefined;}
    for(const name of names.filter(n=>/^transfer-[a-zA-Z0-9-]+\.json$/.test(n))){
      const record=await readJSON<any>(await this.service.casePath(c.identity.id,`04_内部说明/${name}`),{});
      if(record.view?.profileKey===this.service.key&&record.view?.caseId===c.identity.id&&record.view?.processId===source.processKey&&record.view?.phase==='submitted')return '已提交下一内部流程';
    }
    return undefined;
  }
  async listReviews(key:string):Promise<ReviewQueueItem[]>{return this.scoped(key,undefined,()=>this.queue(key));}
  private async queue(key:string):Promise<ReviewQueueItem[]> {
    this.service.assertKey(key);const generation=this.service.generation,store=await this.store(key);
    const adopted=await this.agent.reviewSources(key);
    // Live reply review records take precedence over a source snapshot saved by personal review.
    const sources=[...store.records.flatMap(r=>r.sources.filter(s=>s.caseId===r.caseId&&s.processKey===r.processKey)),...adopted];
    const items:ReviewQueueItem[]=[];
    for(const source of new Map(sources.map(s=>[sourceKey(s),s])).values()){
      this.service.assertKey(key);if(generation!==this.service.generation)throw new Error('账号已切换。');
      const c=this.service.professionalCases().find(c=>c.identity.id===source.caseId);if(!c)continue;
      const reports=[...new Map([...(source.reports||[]),...store.records.filter(r=>r.caseId===source.caseId&&r.processKey===source.processKey).flatMap(r=>r.jobs)]
        .filter(j=>j.kind==='review'&&j.sourceId===source.id&&j.caseId===source.caseId&&j.processKey===source.processKey).map(j=>[sourceKey(j),j])).values()].sort((a,b)=>a.at.localeCompare(b.at));
      const report=reports.at(-1);
      const reason=await this.archiveReason(c,source);
      items.push({source:structuredClone({...source,reports:reportsFor(source)}),caseTitle:c.identity.title,caseNumber:c.identity.number,archived:!!reason,archiveReason:reason,report:report?structuredClone(report):undefined,reports:structuredClone(reports),running:report?.state==='running'});
    }
    this.service.assertKey(key);if(generation!==this.service.generation)throw new Error('账号已切换。');return items.sort((a,b)=>b.source.at.localeCompare(a.source.at));
  }
  async getCase(key:string,id:string):Promise<ProfessionalCaseView>{return this.scoped(key,id,async scope=>{const store=await this.store(key),count=store.records.length;const view=await this.view(key,id);if(store.records.length!==count)await this.persist(key,scope);return view;});}
  async history(key:string,id:string):Promise<import('../src/professional-api.ts').ProfessionalHistoryView>{return this.scoped(key,undefined,async()=>{
    this.service.assertKey(key);this.service.professionalCase(id);
    const generation=this.service.generation;
    const store=await this.store(key);
    this.service.assertKey(key);
    if(generation!==this.service.generation)throw new Error('账号已切换。');
    const records=store.records.filter(record=>record.caseId===id);
    const sources=new Map<string,ReviewSource>();
    const jobs=new Map<string,ProfessionalJob>();
    for(const record of records){
      for(const source of record.sources){
        if(source.caseId!==id||source.processKey!==record.processKey)continue;
        const copy=structuredClone(source);
        const existing=sources.get(sourceKey(source));
        sources.set(sourceKey(source),existing ? {...existing,...copy,reports:[...(existing.reports??[]),...(copy.reports??[])]} : copy);
        for(const report of reportsFor(source))jobs.set(sourceKey(report),structuredClone(report));
      }
      for(const job of record.jobs)if(job.caseId===id&&job.processKey===record.processKey)jobs.set(sourceKey(job),structuredClone(job));
    }
    const dedupedSources=[...sources.values()].map(source=>{
      if(!source.reports?.length)return source;
      return {...source,reports:[...new Map(reportsFor(source).map(report=>[sourceKey(report),report])).values()]};
    });
    return {profileKey:key,caseId:id,sources:dedupedSources,jobs:[...jobs.values()]};
  });}
  private async view(key:string,id:string):Promise<ProfessionalCaseView>{
    const c=this.guard(key,id),caseView=viewOf(c),processKey=keyOfView(caseView),store=await this.store(key),record=this.record(store,c);
    const queue=(await this.queue(key)).filter(q=>q.source.caseId===id&&q.source.processKey===processKey);this.guard(key,id,processKey);
    return {profileKey:key,caseId:id,processKey,writingContextHash:this.recoveryContext(c,record,'writing'),record:recordView(record),materials:caseView.materials.current.map(m=>({id:m.id,name:m.name,role:m.role,ready:m.ready,removable:m.id.startsWith('reference-'),relativePath:m.relativePath})),queue,busy:this.active.has(this.activeKey(key,id)),partial:this.active.get(this.activeKey(key,id))?.partial};
  }
  async command(key:string,id:string,command:ProfessionalCommand):Promise<ProfessionalCaseView>{
    const queued=Date.now();
    return withDiagnostics({requestId:randomUUID(),caseId:id,operation:command.type},()=>diagnosticStage('professional','command',{},()=>this.scoped(key,id,async(scope)=>{
    diagnostic('professional','command_dequeued',{durationMs:Date.now()-queued});
    const c=this.guard(key,id),store=await this.store(key);this.service.assertScope(scope);const record=this.record(store,c);
    if(command.type==='stop'){const activeKey=this.activeKey(key,id),live=this.active.get(activeKey);live?.abort.abort();live?.handle?.abort();if(live&&live.job.state!=='running'){await this.persist(key,scope);if(this.active.get(activeKey)===live)this.active.delete(activeKey);}return this.view(key,id);}
    if(this.active.has(this.activeKey(key,id)))throw new Error('本案有撰写或审查任务在运行。');
    if(command.type==='start-at'){
      if(!professionalWritingEditableForView(viewOf(c))||!canChooseWritingStart(record,this.recoveryContext(c,record,'writing'))||!Number.isInteger(command.phase)||command.phase<0||command.phase>=WRITING_PHASES.length)throw new Error('已有本轮成果，请先返回修改或保留版本开始新一轮，再调整撰写起点。');
      if(record.phase!==command.phase||!record.entry){
        record.revision=randomUUID();record.phase=command.phase;record.entry={phase:command.phase,at:new Date().toISOString()};
        await this.persist(key,scope);
      }
    }else if(command.type==='write'){
      if(!professionalWritingEditableForView(viewOf(c))||record.completed)throw new Error('当前案件不能启动该撰写阶段。');
      if(typeof command.message!=='string'||command.message.length>PROFESSIONAL_WRITE_MESSAGE_MAX||!Array.isArray(command.materialIds))throw new Error('撰写输入无效。');
      if(record.phase===0&&!command.message.trim()&&!c.identity.title.trim())throw new Error('请提供名称或技术交底。');
      const materials=materialList(c),picked=command.materialIds.map(mid=>materials.find(m=>m.id===mid));
      if(picked.some(m=>!m?.ready||!m.relativePath))throw new Error('所选材料尚未准备好。');
      record.selectedMaterialIds=[...command.materialIds];
      await this.start(scope,key,c,record,'writing',command.message,picked.map(m=>({name:m!.name,role:m!.role,relativePath:m!.relativePath!})));
    }else if(command.type==='review'){
      const item=(await this.queue(key)).find(q=>q.source.id===command.sourceId&&q.source.caseId===id&&q.source.processKey===record.processKey);
      this.service.assertScope(scope);
      if(!item||item.archived)throw new Error('该稿件已归档或不属于本案待审查材料。');
      if(!record.sources.some(s=>s.id===item.source.id))record.sources.push(structuredClone(item.source));
      await this.start(scope,key,c,record,'review','',item.source.files,item.source);
    }else if(command.type==='resume'){
      const old=record.jobs.find(j=>j.id===command.jobId&&j.caseId===id&&j.processKey===record.processKey);
      if(!old||!['stopped','failed'].includes(old.state))throw new Error('只能继续本案当前流程的未完成任务。');
      if(!old.recovery)throw new Error('旧任务缺少冻结续办资料；原记录保留，请按当前要求重新生成。');
      let source:ReviewSource|undefined;
      if(old.kind==='writing'){
        if(!professionalWritingEditableForView(viewOf(c))||record.completed||old.phase!==record.phase)throw new Error('撰写阶段已变化，请在当前阶段生成。');
      }else{
        const item=(await this.queue(key)).find(q=>q.source.id===old.sourceId&&q.source.caseId===id&&q.source.processKey===record.processKey);
        this.service.assertScope(scope);
        if(!item||item.archived)throw new Error('原审查稿件已归档或变化，请选择当前版本。');
        source=item.source;
      }
      const latest=record.jobs.filter(j=>j.kind===old.kind&&(old.kind==='writing'?j.phase===record.phase:j.sourceId===old.sourceId)).at(-1);
      if(latest?.id!==old.id||old.recovery.contextHash!==this.recoveryContext(c,record,old.kind,source))throw new Error('已有新要求或版本，原任务保留，请按当前要求生成。');
      await this.start(scope,key,c,record,old.kind,old.input??'',old.recovery.files,source,old);
    }else if(command.type==='confirm'){
      if(!professionalWritingEditableForView(viewOf(c)))throw new Error('当前流程已不允许确认撰写结果。');
      const contextHash=this.recoveryContext(c,record,'writing');
      let job=currentWritingJobs(record,contextHash).find(j=>j.id===command.jobId&&j.state==='completed');
      if(!job&&command.adoptEarlier===true){
        const earlier=record.jobs.find(j=>j.id===command.jobId&&j.kind==='writing'&&j.caseId===id&&j.processKey===record.processKey&&j.phase===record.phase&&j.state==='completed');
        if(earlier){
          // 显式采用退回前的完成稿：按当前上下文新建采用记录并继续确认；原任务记录完整保留，不做静默沿用。
          job={...structuredClone(earlier),id:randomUUID(),at:new Date().toISOString(),adoptedFromJobId:earlier.id,recovery:{files:structuredClone(earlier.recovery?.files??[]),contextHash}};
          record.jobs.push(job);
        }
      }
      if(!job||record.completed)throw new Error('阶段结果已变化，请核对当前版本。');
      if(typeof command.decision!=='string'||command.decision.length>PROFESSIONAL_DECISION_MAX||record.phase<2&&!command.decision.trim())throw new Error('请明确所选方向或保护架构，再确认本阶段。');
      const confirmation={jobId:job.id,phase:record.phase,decision:command.decision.trim(),at:new Date().toISOString()};
      if(record.phase<4)record.phase++;
      else {
        if(!job.documents)throw new Error('缺少申请文件部分。');
        const docx=await exportApplicationText(path.join(this.resources,'document-templates'),job.documents as ApplicationText);
        this.service.assertScope(scope);
        const relative=await this.saveFile(scope,c,`申请文件-${job.id}.docx`,docx);
        this.service.assertScope(scope);
        record.completed=true;
        for(const old of record.sources)if(old.id.startsWith('writing-')&&!old.supersededAt)old.supersededAt=new Date().toISOString();
        record.sources.push({id:`writing-${job.id}`,caseId:id,processKey:record.processKey,title:'撰写完成 · 申请文件',business:'申请',at:new Date().toISOString(),text:Object.entries(job.documents).map(([k,v])=>`## ${k}\n${v}`).join('\n\n'),files:[{name:'申请文件.docx',role:'当前完成稿',relativePath:relative,hash:digest(docx)}]});
      }
      record.confirmations.push(confirmation);
      await this.persist(key,scope);
    }else if(command.type==='restart'){
      if(!professionalWritingEditableForView(viewOf(c))||!Number.isInteger(command.phase)||command.phase<0||command.phase>record.phase)throw new Error('不能回到指定阶段。');
      record.revision=randomUUID();record.phase=command.phase;record.completed=false;if(command.phase===0)record.entry=undefined;record.confirmations=record.confirmations.filter(x=>x.phase<command.phase);await this.persist(key,scope);
    }else if(command.type==='ready-manual'){
      const caseView=viewOf(c);
      const draft=caseView.manuscripts.localDraft;
      if(!professionalWorkEditableForView(caseView)||c.officialOutcome.locksCurrent||!draft?.trim()||!['write','reply','correction'].includes(caseView.stage.kind))throw new Error('本案没有可列入审查的当前工作稿。');
      const hash=digest(draft),sourceId='manual-'+digest(c.identity.id+'\0'+record.processKey+'\0'+hash);
      if(!record.sources.some(s=>s.id===sourceId))record.sources.push({id:sourceId,caseId:id,processKey:record.processKey,title:'已完成的人工工作稿',business:caseView.stage.kind==='write'?'申请':caseView.stage.kind==='correction'?'补正':'答复',at:new Date().toISOString(),text:draft,files:[]});
      await this.persist(key,scope);
    }else throw new Error('操作无效。');
    return this.view(key,id);
  })));}
  private async saveFile(scope:OperationScope,c:CaseProfessionalView,name:string,bytes:Buffer){
    const key=scope.profileKey,generation=scope.scopeVersion,root=scope.root,processKey=scope.processKey!;
    const check=()=>this.service.assertScope(scope);check();
    this.service.flowFileWrites++;
    try{
      const latest=this.guard(key,c.identity.id,processKey);
      if(!latest.identity.hasDirectory)throw new Error('本案目录尚未创建。');
      const directory=await this.service.casePath(c.identity.id);
      const ext=path.extname(name);
      const rel=`04_内部说明/撰写与审查/${safeName(path.basename(name,ext),160)}${ext}`;
      const file=await managedPath(directory,rel,true);
      this.guard(key,c.identity.id,processKey);
      if(generation!==this.service.generation||root!==this.service.workspace.settings.workRoot)throw new Error('账号或目录已变化，未保存迟到文件。');
      try{await atomicCreate(file,bytes,check);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||digest(await fs.readFile(file))!==digest(bytes))throw e;}
      check();
      return rel;
    }finally{this.service.flowFileWrites--;}
  }
  async addFiles(key:string,id:string,paths:string[]):Promise<ProfessionalCaseView>{return this.scoped(key,id,async(scope)=>{
    const c=this.guard(key,id),processKey=keyOf(c),root=this.service.workspace.settings.workRoot,generation=this.service.generation,record=this.record(await this.store(key),c);
    if(!professionalWorkEditableForView(viewOf(c))||c.officialOutcome.locksCurrent)throw new Error('当前案件仅可查看，不能新增独立审查稿件。');
    if(this.active.has(this.activeKey(key,id)))throw new Error('请先停止本案任务再选择完成稿。');
    if(!paths.length||paths.length>12)throw new Error('每次可选择 1–12 份完成稿。');
    const files:WorkFile[]=[];
    for(const source of paths){
      const stat=await fs.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024||!['.doc','.docx','.pdf','.txt','.md','.png','.jpg','.jpeg'].includes(path.extname(source).toLowerCase()))throw new Error('请选择 20MB 以内的文档或图像文件。');
      let bytes:Buffer;try{bytes=await readBoundedFile(source,20*1024*1024);}catch{throw new Error('请选择 20MB 以内的文档或图像文件。');}
      this.guard(key,id,processKey);if(root!==this.service.workspace.settings.workRoot||generation!==this.service.generation)throw new Error('账号或目录已变化。');
      const rel=await this.saveFile(scope,c,`${randomUUID()}-${path.basename(source)}`,bytes);files.push({name:path.basename(source),role:'当前完成稿',relativePath:rel,hash:digest(bytes)});
    }
    const kind=viewOf(c).stage.kind;
    this.service.assertScope(scope);record.sources.push({id:randomUUID(),caseId:id,processKey,title:'外部完成稿 · '+files.map(f=>f.name).join('、'),business:kind==='reply'?'答复':kind==='correction'?'补正':'申请',at:new Date().toISOString(),text:'',files});await this.persist(key,scope);return this.view(key,id);
  });}
  async addReferences(key:string,id:string,paths:string[]):Promise<ProfessionalCaseView>{return this.scoped(key,id,async(scope)=>{
    const c=this.guard(key,id),expected={generation:scope.scopeVersion,root:scope.root,process:scope.processKey!,caseRevision:scope.caseRevision};
    if(this.active.has(this.activeKey(key,id))||!professionalWritingEditableForView(viewOf(c)))throw new Error('请在可编辑的撰写阶段、任务停止后添加材料。');
    if(!paths.length||paths.length>12)throw new Error('每次可添加 1–12 份参考材料。');
    const prepared:Array<{name:string;bytes:Buffer}>=[];
    for(const source of paths){
      const stat=await fs.lstat(source),name=path.basename(source);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024||!['.doc','.docx','.pdf','.txt','.md','.png','.jpg','.jpeg'].includes(path.extname(name).toLowerCase()))throw new Error(`${name}：请选择 20MB 以内的 Word、PDF、文本或 PNG/JPEG 文件。`);
      let bytes:Buffer;try{bytes=await readBoundedFile(source,20*1024*1024);}catch{throw new Error(`${name}：请选择 20MB 以内的 Word、PDF、文本或 PNG/JPEG 文件。`);}
      if(!bytes.length)throw new Error(`${name}：文件为空或超过 20MB。`);
      prepared.push({name,bytes});
    }
    this.service.flowFileWrites++;
    try{
      const added:Material[]=[];
      for(const file of prepared){
        this.guard(key,id,expected.process);
        if(expected.generation!==this.service.generation||expected.root!==this.service.workspace.settings.workRoot)throw new Error('账号或目录已变化。');
        const materialId='reference-'+randomUUID(),directory=await this.service.casePath(id);
        const rel=`01_通知与材料/撰写参考/${materialId}/${safeName(file.name,180)}`;
        const target=await managedPath(directory,rel,true);await atomicCreate(target,file.bytes,()=>this.service.assertScope(scope));
        added.push({id:materialId,name:file.name,role:'撰写参考材料',location:'本机导入',excerpt:'',ready:true,relativePath:rel});
      }
      await this.service.updateReferences(key,id,expected,added);
      const latest=this.guard(key,id,expected.process);
      const record=this.record(await this.store(key),latest);
      record.selectedMaterialIds=[...new Set([...(record.selectedMaterialIds??[]),...added.map(m=>m.id)])];
      await this.persist(key,scope);
      this.changed(key);return this.view(key,id);
    }finally{this.service.flowFileWrites--;}
  });}
  async removeReference(key:string,id:string,materialId:string):Promise<ProfessionalCaseView>{return this.scoped(key,id,async(scope)=>{
    const c=this.guard(key,id);if(this.active.has(this.activeKey(key,id)))throw new Error('请先停止本案任务，再移除材料。');
    if(!professionalWritingEditableForView(viewOf(c)))throw new Error('请在可编辑的撰写阶段移除材料。');
    await this.service.updateReferences(key,id,{generation:scope.scopeVersion,root:scope.root,process:scope.processKey!,caseRevision:scope.caseRevision},[],materialId);
    const latest=this.guard(key,id);
    const record=this.record(await this.store(key),latest);
    record.selectedMaterialIds=(record.selectedMaterialIds??[]).filter(mid=>mid!==materialId);
    await this.persist(key,scope);
    this.changed(key);return this.view(key,id);
  });}
  noteSubmitted(key:string,caseId:string){const live=this.active.get(this.activeKey(key,caseId));if(live?.key===key&&live.job.kind==='review'){live.abort.abort();live.handle?.abort();}this.changed(key);}
  async listTasks(key:string):Promise<import('../src/agent-api.ts').AgentTaskView[]>{return this.scoped(key,undefined,async()=>{
    this.service.assertKey(key);const store=await this.store(key);this.service.assertKey(key);
    return store.records.flatMap(record=>{const c=this.service.professionalCases().find(c=>c.identity.id===record.caseId);if(!c)return [];return recordView(record).jobs.map(j=>({caseId:c.identity.id,caseNumber:c.identity.number,caseTitle:c.identity.title,processKey:record.processKey,discussionId:j.id,runId:j.id,action:j.kind==='review'?'review' as const:'discuss' as const,professionalKind:j.kind,state:j.state,startedAt:j.at,endedAt:j.endedAt,error:j.error}));});
  });}
  async submissionApplication(key:string,id:string){return this.scoped(key,id,async()=>{
    const c=this.guard(key,id),record=this.record(await this.store(key),c);if(!record.completed)return undefined;
    const source=recordView(record).sources.filter(s=>s.id.startsWith('writing-')&&!s.supersededAt).at(-1);
    return source?.files[0]?structuredClone(source.files[0]):undefined;
  });}
  async previewDocument(key:string,id:string,processKey:string,jobId:string){return this.scoped(key,id,async(scope)=>{
    const c=this.guard(key,id),store=await this.store(key);
    const job=store.records.find(r=>r.caseId===id&&r.processKey===processKey)?.jobs.find(j=>j.id===jobId&&j.caseId===id&&j.processKey===processKey);
    if(!job||job.state!=='completed'||!job.text)throw new Error('指定阶段版本尚未完成或不属于本案。');
    if(!job.artifactPath?.endsWith('.docx')){
      const raw=job.artifactPath;
      if(raw){const original=await readBoundedFile(await this.service.casePath(id,raw),20*1024*1024);this.service.assertScope(scope);if(original.toString('utf8')!==job.text)throw new Error('原阶段文本已修改，未用旧记录替换用户文件。');}
      const bytes=await exportStageDocx(path.join(this.resources,'document-templates'),`${c.identity.title} · ${job.kind==='writing'?WRITING_PHASES[job.phase??0]:'独立审查报告'}`,job.text);
      this.service.assertScope(scope);
      job.artifactPath=await this.saveFile(scope,c,`阶段文档-${job.id}-${randomUUID()}.docx`,bytes);job.rawArtifactPath=raw;job.artifactHash=digest(bytes);await this.persist(key,scope);
    }
    const bytes=await readBoundedFile(await this.service.casePath(id,job.artifactPath),20*1024*1024);this.service.assertScope(scope);
    if(!job.artifactHash||digest(bytes)!==job.artifactHash)throw new Error('阶段 Word 已被修改或缺少版本摘要，未显示不匹配的预览。请打开确切原文件核对。');
    const blocks=await readStageDocx(bytes);this.service.assertScope(scope);
    return {jobId,processKey,relativePath:job.artifactPath,hash:job.artifactHash,blocks};
  });}
  async fileAllowed(key:string,id:string,relative:string){return this.scoped(key,id,async()=>{
    const store=await this.store(key);
    const sourceFile=(s:ReviewSource)=>s.files.some(f=>f.relativePath===relative)
      ||reportsFor(s).some(job=>(job.artifactPath===relative||job.rawArtifactPath===relative));
    if(materialList(this.service.professionalCase(id)).some(m=>m.relativePath===relative&&m.ready)
      ||store.records.filter(r=>r.caseId===id).some(r=>r.jobs.some(j=>j.caseId===id&&j.processKey===r.processKey&&(j.artifactPath===relative||j.rawArtifactPath===relative))
        ||r.sources.some(s=>s.caseId===id&&s.processKey===r.processKey&&sourceFile(s))))return true;
    return (await this.agent.reviewSources(key,id)).some(s=>s.caseId===id&&sourceFile(s));
  });}
  private recoveryContext(c:CaseProfessionalView,record:ProfessionalRecord,kind:'writing'|'review',source?:ReviewSource){
    return digest(JSON.stringify([c.identity.id,c.identity.title,c.identity.type,record.processKey,kind,kind==='writing'?[record.phase,record.revision,record.confirmations]:source&&[source.id,source.text,source.amendmentText,source.applicationParts,source.correctionContents,source.amendmentBasis,source.files]]));
  }
  beforeWriting?:(key:string,id:string)=>Promise<void>;
  private async start(scope:OperationScope,key:string,c:CaseProfessionalView,record:ProfessionalRecord,kind:'writing'|'review',message:string,files:WorkFile[],source?:ReviewSource,resume?:ProfessionalJob){
    this.service.assertScope(scope);
    const generation=scope.scopeVersion,root=scope.root;
    if(!root)throw new Error('请先设置工作目录。');
    const runId=randomUUID(),controller=new AbortController(),skill=await loadStandardSkill(path.join(this.resources,'standard-skills'),kind==='writing'?'draft':'review');
    const runtime=await this.models.resolveRuntimeConfig(key,runId);this.service.assertScope(scope);
    if(kind==='writing'&&this.beforeWriting){await diagnosticStage('professional','permission',{runId,caseId:c.identity.id},()=>this.beforeWriting!(key,c.identity.id));this.service.assertScope(scope);}
    if(runtime.profileKey!==key||generation!==this.service.generation||root!==this.service.workspace.settings.workRoot)throw new Error('账号或目录已变化。');
    const runRoot=path.join(this.service.root,'profiles',key,'professional-runs',runId),snapshotDir=path.join(runRoot,'snapshot'),outputDir=path.join(runRoot,'output');await fs.mkdir(snapshotDir,{recursive:true,mode:0o700});
    const materials:AgentHostMaterialSnapshot[]=[];
    await diagnosticStage('professional','materials',{runId,caseId:c.identity.id},async()=>{for(const [i,f] of files.entries()){
      const file=await this.service.casePath(c.identity.id,f.relativePath),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024)throw new Error('稿件文件无效或过大。');
      const bytes=await readBoundedFile(file,20*1024*1024,controller.signal),hash=digest(bytes);if(f.hash&&f.hash!==hash)throw new Error('稿件已被外部修改，请重新选择确切版本。');
      const snapshotPath=path.join(snapshotDir,`${i}${path.extname(f.name)}`);await atomicCreate(snapshotPath,bytes,()=>this.service.assertScope(scope));materials.push({id:`m${i}`,name:f.name,role:f.role,relativePath:`${i}${path.extname(f.name)}`,snapshotPath,hash});
    }});
    this.service.assertScope(scope);
    const job:ProfessionalJob={id:runId,caseId:c.identity.id,processKey:record.processKey,kind,sourceId:source?.id,phase:kind==='writing'?record.phase:undefined,state:'running',at:new Date().toISOString(),tools:[],skillName:skill.name,skillHash:skill.manifestHash};
    job.resumeFromRunId=resume?.id;
    job.recovery={files:files.map((f,i)=>({...f,hash:materials[i].hash})),contextHash:this.recoveryContext(c,record,kind,source)};
    job.input=kind==='writing'?message:undefined;
    const memory=professionalTaskMemory(record,{runId,kind,message,source});
    job.memory=taskMemoryView(memory);
    await atomicJSON(path.join(snapshotDir,'task-memory.json'),memory,()=>this.service.assertScope(scope));
    record.jobs.push(job);
    const activeKey=this.activeKey(key,c.identity.id);
    const live:Live={key,generation,root,scope,caseId:c.identity.id,processKey:record.processKey,job,abort:controller,partial:'',source};this.active.set(activeKey,live);try{await this.persist(key,scope);}catch(e){if(this.active.get(activeKey)===live)this.active.delete(activeKey);record.jobs=record.jobs.filter(j=>j.id!==runId);throw e;}
    const confirmed=record.confirmations.map(cf=>({stage:WRITING_PHASES[cf.phase],decision:cf.decision,text:record.jobs.find(j=>j.id===cf.jobId)?.text}));
    const entryContext=record.entry?'用户按已有材料选择从「'+WRITING_PHASES[record.entry.phase]+'」开始。未逐步确认的前序内容仅以实际读取材料和用户原话为依据，不得声称已确认；缺失之处列出具体待补充项，不重复无必要的方向构思。':'';
    const contract=kind==='review'?'{"kind":"review","text":"完整审查报告（含来源版本、具体位置、P0-P3问题、适用矩阵、检查范围和未完成项）"}':record.phase===4?'{"kind":"writing","text":"整理说明和需要核验的附图 / 内部记录","documents":{"ABSTRACT":"摘要","ABSTRACT_IMAGE":"已核对的摘要附图说明或未提供标记","CLAIMS":"权利要求书","DESCRIPTION":"说明书","DRAWINGS":"附图清单，未提供真实图像时明确标记"}}':'{"kind":"writing","text":"当前阶段完整结果、建议和待用户确认项"}';
    const task=[SKILL_ADAPTER,kind==='writing'?entryContext:'',`本案名称：${c.identity.title}；专利类型：${c.identity.type}。`,`当前任务：${kind==='writing'?WRITING_PHASES[record.phase]:'递交前个人独立审查'}。`,kind==='writing'?`只执行当前阶段。前序已确认内容：${JSON.stringify(confirmed)}\n用户本次要求：${message}`:`程序阶段：${source?.business==='申请'?'pre-filing（申请准备）':'post-filing（答复或补正）'}。业务：${source?.business}。仅审查此冻结版本，不注入或索取主讨论。`,
      `启用的标准技能：${skill.name}。必须调用 read_skill 阅读 ${kind==='writing'?'draft':'review'}/SKILL.md，并读取本阶段所需参考。资源目录：${skill.resources.map(r=>r.path).join('、')}`,
      `材料清单：${JSON.stringify(materials.map(({snapshotPath,...m})=>m))}。逐项调用 read_material 读取；按返回的范围续读，图像和扫描页需视觉核对。${source?.text?'必须调用 read_draft 阅读冻结完成稿。':''}`,
      '不可声称运行了没有实际执行的脚本；工具以本次实际开放权限为准，检索或命令未实际执行时须如实注明，不能声称完成。附图未提供时不能生成虚假图像占位并声称完成。',
      '公式格式规范：说明书、权利要求或实施例中出现的计算公式、参数关系与数学推导，必须采用标准 LaTeX 格式（行内公式使用 $公式$，独立行间公式使用 $$公式$$，例如 $$P = \\frac{F}{S}$$）。严禁使用难以阅读的纯文本 ASCII 字符拼凑公式，以保证公式结构和排版在阅读预览和 Word 导出中均符合标准规范。',
      `可随时用 write_artifact 的 mode=merge 保存 text 或 documents 子项；未齐内容保存为检查点，先 inspect_artifact 查看已保存字段再补齐。最终必须用 write_artifact 写入 result.json，JSON 格式：${contract}`].join('\n\n');
    live.wait=(async()=>{
      try{
        live.handle=await this.run({taskContract:{kind,professional:true,phase:job.phase},resumeFromRunId:resume?.id,artifactScope:job.recovery!.contextHash,taskMemory:memory,evidencePolicy:{formal:true},validateArtifact:async raw=>{
          if(!this.liveValid(live)||job.state!=='running')return '本任务已结束、停止或范围变化。';
          try{parseProfessionalResult(raw,kind,job.phase);}catch(error){return (error as Error).message;}
          if(!job.tools.some(t=>t.name==='read_skill'&&t.status==='ok'))return '请先用 read_skill 读取本阶段标准技能。';
          const missing=materials.filter(m=>!job.tools.some(t=>(t.name==='read_material:'+m.id||t.name==='read_work_file:'+m.id)&&t.status==='ok'));
          if(missing.length)return '请 read_material 读取本次材料：'+missing.map(m=>m.id+' '+m.name).join('、');
          if(source?.text&&!job.tools.some(t=>t.name==='read_draft'&&t.status==='ok'))return '请 read_draft 读取冻结完成稿。';
          return undefined;
        },runId,caseId:c.identity.id,processKey:record.processKey,action:kind==='review'?'review':'discuss',discussionId:runId,snapshotDir,outputDir,prompt:{rules:skill.main,task,combined:`${skill.main}\n\n${task}`},skillResources:skill.resources,materials,draft:source?.text?{id:source.id,text:source.text,amendmentText:source.amendmentText,applicationParts:source.applicationParts,correctionContents:source.correctionContents,amendmentBasis:source.amendmentBasis}:undefined,messages:[],runtime,signal:controller.signal,onEvent:event=>{
          if(!this.liveValid(live)||job.state!=='running')return;
          if(event.type==='progress'){job.progress=structuredClone(event.progress);this.changed(key);void this.serial(async()=>{if(this.liveValid(live)&&job.state==='running')await this.persist(key,scope);}).catch(()=>{});}
          if(event.type==='quality'){job.quality=structuredClone(event.quality);this.changed(key);}
          if(event.type==='partial'){live.partial=event.text;this.changed(key);}
          if(event.type==='tool'){job.tools.push({name:(event.toolKind==='read_material'||event.toolKind==='read_work_file')&&event.materialId?`${event.toolKind}:${event.materialId}`:event.toolKind||event.filename,status:event.status,detail:event.detail});this.changed(key);}
          if(event.type==='completed')live.partial=event.outputText||live.partial;
          if(event.type==='failed')job.error=event.error;
        }});
        if(controller.signal.aborted)live.handle.abort();await live.handle.wait;
        await this.serial(async()=>{
          if(!this.liveValid(live)){job.state='stopped';job.error='已停止或案件范围改变，未将迟到结果写入案件。';return;}
          if(job.error)throw new Error(job.error);
          if(!job.tools.some(t=>t.name==='read_skill'&&t.status==='ok')||materials.some(m=>!job.tools.some(t=>(t.name===`read_material:${m.id}`||t.name===`read_work_file:${m.id}`)&&t.status==='ok'))||source?.text&&!job.tools.some(t=>t.name==='read_draft'&&t.status==='ok'))throw new Error('缺少本次技能或材料的实际读取记录，未标为完成。');
          const artifact=JSON.parse(await fs.readFile(path.join(outputDir,'result.json'),'utf8'));
          const result=parseProfessionalResult(JSON.stringify(artifact),kind,job.phase);
          this.service.assertScope(scope);
          const artifactPath=await this.saveFile(scope,c,`${kind==='writing'?WRITING_PHASES[job.phase!]: '独立审查报告'}-${runId}.md`,Buffer.from(result.text));
          this.service.assertScope(scope);
          job.text=result.text;job.documents=result.documents;job.rawArtifactPath=artifactPath;
          const word=await exportStageDocx(path.join(this.resources,'document-templates'),`${c.identity.title} · ${kind==='writing'?WRITING_PHASES[job.phase!]: '独立审查报告'}`,result.text);
          this.service.assertScope(scope);
          job.artifactPath=await this.saveFile(scope,c,`${kind==='writing'?WRITING_PHASES[job.phase!]: '独立审查报告'}-${runId}.docx`,word);
          job.artifactHash=digest(word);job.state='completed';
        });
      }catch(e){job.state=controller.signal.aborted?'stopped':'failed';job.error=(e as Error).message;}
      finally{await this.serial(async()=>{if(job.state==='running')job.state='stopped';job.endedAt=new Date().toISOString();await this.persist(key);if(this.active.get(activeKey)===live)this.active.delete(activeKey);this.changed(key);});}
    })();
    void live.wait.catch(e=>{job.error=`状态未落盘：${(e as Error).message}`;this.changed(key);});
  }
}
