import fs from 'node:fs/promises';
import {diagnostic,diagnosticStage,withDiagnostics} from './diagnostics.ts';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Case } from '../src/domain/workflow.ts';
import { currentWork, editableCurrent } from '../src/domain/lifecycle.ts';
import { currentHandling } from '../src/domain/handling.ts';
import { WRITING_PHASES } from '../src/professional-api.ts';
import { PROFESSIONAL_DECISION_MAX, PROFESSIONAL_WRITE_MESSAGE_MAX } from '../src/professional-api.ts';
import type { ProfessionalCaseView, ProfessionalCommand, ProfessionalJob, ProfessionalRecord, ReviewQueueItem, ReviewSource, WorkFile } from '../src/professional-api.ts';
import type { AgentHost, AgentHostRun, AgentHostRunHandle, AgentHostMaterialSnapshot } from './agent-host.ts';
import type { DesktopService } from './service.ts';
import type { ModelService } from './model-service.ts';
import { atomicJSON, digest, readJSON, readBoundedFile, safeName, managedPath } from './files.ts';
import { exportApplicationText } from './document-export.ts';
import type { ApplicationText } from './document-export.ts';
import { loadStandardSkill, SKILL_ADAPTER } from './standard-skills.ts';

type Store={schema:1;records:ProfessionalRecord[]};
type Live={key:string;generation:number;root:string;caseId:string;processKey:string;job:ProfessionalJob;abort:AbortController;handle?:AgentHostRunHandle;wait?:Promise<void>;partial:string;source?:ReviewSource};
const keyOf=(c:Case)=>{const w=currentWork(c);return (w.processId||w.roundId||`local-${w.kind}`).trim();};
const materialList=(c:Case)=>[...(c.materials??[]),...c.rounds.filter(r=>r.id===currentWork(c).roundId).flatMap(r=>r.materials)].filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i);
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
  private file(key:string){return path.join(this.service.root,'profiles',key,'professional-work.json');}
  private async store(key:string){
    if(this.stores.has(key))return this.stores.get(key)!;
    const store=await readJSON<Store>(this.file(key),{schema:1,records:[]});
    if(store.schema!==1||!Array.isArray(store.records))throw new Error('撰写与审查记录格式无效，未覆盖原记录。');
    for(const record of store.records)for(const job of record.jobs)if(job.state==='running'){job.state='stopped';job.error='应用已重开，上次任务已停止；原稿及记录保留。';}
    this.stores.set(key,store);return store;
  }
  private async persist(key:string){await atomicJSON(this.file(key),await this.store(key));this.changed(key);}
  private guard(key:string,id:string,processKey?:string){
    this.service.assertKey(key);this.service.assertMigrationNotAccepted();if(this.closed)throw new Error('应用正在退出。');
    const c=this.service.findCase(id);if(processKey&&keyOf(c)!==processKey)throw new Error('当前案件流程已变化。');return c;
  }
  private liveValid(l:Live){try{this.guard(l.key,l.caseId,l.processKey);return !l.abort.signal.aborted&&l.generation===this.service.generation&&l.root===this.service.workspace.settings.workRoot&&!this.closed;}catch{return false;}}
  private record(store:Store,c:Case){let r=store.records.find(r=>r.caseId===c.id&&r.processKey===keyOf(c));if(!r){r={caseId:c.id,processKey:keyOf(c),phase:0,confirmations:[],jobs:[],sources:[],completed:false};store.records.push(r);}return r;}
  assertIdleForMigration(){if(this.active.size)throw new Error('请先停止撰写或个人审查任务，再迁移目录或更换文档组件。');}
  noteScopeChange(){for(const l of this.active.values())if(!this.liveValid(l)){l.abort.abort();l.handle?.abort();}}
  async shutdown(){this.closed=true;for(const l of this.active.values()){l.abort.abort();l.handle?.abort();}await Promise.all([...this.active.values()].map(l=>l.wait?.catch(()=>{})));await this.operations;}
  private async archiveReason(c:Case,source:ReviewSource) {
    if(source.supersededAt)return '已有后续稿件版本';
    if(c.archived)return '案件已归档';
    if(keyOf(c)!==source.processKey)return '已进入后续办理流程';
    if(currentHandling(c).officialWaiting)return '已递交，等待官方处理结果';
    if(!c.directory)return undefined;
    const folder=await this.service.casePath(c.id,'04_内部说明');
    let names:string[]=[];try{names=await fs.readdir(folder);}catch{return undefined;}
    for(const name of names.filter(n=>/^transfer-[a-zA-Z0-9-]+\.json$/.test(n))){
      const record=await readJSON<any>(await this.service.casePath(c.id,`04_内部说明/${name}`),{});
      if(record.view?.profileKey===this.service.key&&record.view?.caseId===c.id&&record.view?.processId===source.processKey&&record.view?.phase==='submitted')return '已提交下一内部流程';
    }
    return undefined;
  }
  async listReviews(key:string):Promise<ReviewQueueItem[]>{return this.serial(()=>this.queue(key));}
  private async queue(key:string):Promise<ReviewQueueItem[]> {
    this.service.assertKey(key);const generation=this.service.generation,store=await this.store(key);
    const adopted=await this.agent.reviewSources(key);
    // Live reply review records take precedence over a source snapshot saved by personal review.
    const sources=[...store.records.flatMap(r=>r.sources),...adopted];
    const items:ReviewQueueItem[]=[];
    for(const source of new Map(sources.map(s=>[s.id,s])).values()){
      this.service.assertKey(key);if(generation!==this.service.generation)throw new Error('账号已切换。');
      const c=this.service.workspace.cases.find(c=>c.id===source.caseId);if(!c)continue;
      const reports=[...(source.reports||[]),...store.records.flatMap(r=>r.jobs).filter(j=>j.kind==='review'&&j.sourceId===source.id)].sort((a,b)=>a.at.localeCompare(b.at));
      const report=reports.at(-1);
      const reason=await this.archiveReason(c,source);
      items.push({source:structuredClone(source),caseTitle:c.title,caseNumber:c.number,archived:!!reason,archiveReason:reason,report:report?structuredClone(report):undefined,reports:structuredClone(reports),running:report?.state==='running'});
    }
    this.service.assertKey(key);if(generation!==this.service.generation)throw new Error('账号已切换。');return items.sort((a,b)=>b.source.at.localeCompare(a.source.at));
  }
  async getCase(key:string,id:string):Promise<ProfessionalCaseView>{return this.serial(()=>this.view(key,id));}
  private async view(key:string,id:string):Promise<ProfessionalCaseView>{
    const c=this.guard(key,id),processKey=keyOf(c),store=await this.store(key),record=this.record(store,c);
    const queue=(await this.queue(key)).filter(q=>q.source.caseId===id);this.guard(key,id,processKey);
    return {profileKey:key,caseId:id,processKey,record:structuredClone(record),materials:materialList(c).map(m=>({id:m.id,name:m.name,role:m.role,ready:m.ready,removable:m.id.startsWith('reference-'),relativePath:m.relativePath})),queue,busy:this.active.has(id),partial:this.active.get(id)?.partial};
  }
  async command(key:string,id:string,command:ProfessionalCommand):Promise<ProfessionalCaseView>{
    const queued=Date.now();
    return withDiagnostics({requestId:randomUUID(),caseId:id,operation:command.type},()=>diagnosticStage('professional','command',{},()=>this.serial(async()=>{
    diagnostic('professional','command_dequeued',{durationMs:Date.now()-queued});
    const c=this.guard(key,id),store=await this.store(key),record=this.record(store,c);
    if(command.type==='stop'){const live=this.active.get(id);live?.abort.abort();live?.handle?.abort();return this.view(key,id);}
    if(this.active.has(id))throw new Error('本案有撰写或审查任务在运行。');
    if(command.type==='write'){
      if(!editableCurrent(c)||currentWork(c).kind!=='write'||record.completed)throw new Error('当前案件不能启动该撰写阶段。');
      if(typeof command.message!=='string'||command.message.length>PROFESSIONAL_WRITE_MESSAGE_MAX||!Array.isArray(command.materialIds))throw new Error('撰写输入无效。');
      if(record.phase===0&&!command.message.trim()&&!c.title.trim())throw new Error('请提供名称或技术交底。');
      const materials=materialList(c),picked=command.materialIds.map(mid=>materials.find(m=>m.id===mid));
      if(picked.some(m=>!m?.ready||!m.relativePath))throw new Error('所选材料尚未准备好。');
      record.selectedMaterialIds=[...command.materialIds];
      await this.start(key,c,record,'writing',command.message,picked.map(m=>({name:m!.name,role:m!.role,relativePath:m!.relativePath!})));
    }else if(command.type==='review'){
      const item=(await this.queue(key)).find(q=>q.source.id===command.sourceId&&q.source.caseId===id);
      if(!item||item.archived)throw new Error('该稿件已归档或不属于本案待审查材料。');
      if(!record.sources.some(s=>s.id===item.source.id))record.sources.push(structuredClone(item.source));
      await this.start(key,c,record,'review','',item.source.files,item.source);
    }else if(command.type==='confirm'){
      if(!editableCurrent(c)||currentWork(c).kind!=='write')throw new Error('当前流程已不允许确认撰写结果。');
      const job=record.jobs.filter(j=>j.kind==='writing'&&j.phase===record.phase&&j.state==='completed').at(-1);
      if(!job||job.id!==command.jobId||record.completed)throw new Error('阶段结果已变化，请核对当前版本。');
      if(typeof command.decision!=='string'||command.decision.length>PROFESSIONAL_DECISION_MAX||record.phase<2&&!command.decision.trim())throw new Error('请明确所选方向或保护架构，再确认本阶段。');
      const confirmation={jobId:job.id,phase:record.phase,decision:command.decision.trim(),at:new Date().toISOString()};
      if(record.phase<4)record.phase++;
      else {
        if(!job.documents)throw new Error('缺少申请文件部分。');
        const docx=await exportApplicationText(path.join(this.resources,'document-templates'),job.documents as ApplicationText);
        this.guard(key,id,record.processKey);
        const relative=await this.saveFile(c,`申请文件-${job.id}.docx`,docx);
        record.completed=true;
        for(const old of record.sources)if(old.id.startsWith('writing-')&&!old.supersededAt)old.supersededAt=new Date().toISOString();
        record.sources.push({id:`writing-${job.id}`,caseId:id,processKey:record.processKey,title:'撰写完成 · 申请文件',business:'申请',at:new Date().toISOString(),text:Object.entries(job.documents).map(([k,v])=>`## ${k}\n${v}`).join('\n\n'),files:[{name:'申请文件.docx',role:'当前完成稿',relativePath:relative,hash:digest(docx)}]});
      }
      record.confirmations.push(confirmation);
      await this.persist(key);
    }else if(command.type==='restart'){
      if(!editableCurrent(c)||currentWork(c).kind!=='write'||!Number.isInteger(command.phase)||command.phase<0||command.phase>record.phase)throw new Error('不能回到指定阶段。');
      record.phase=command.phase;record.completed=false;record.confirmations=record.confirmations.filter(x=>x.phase<command.phase);await this.persist(key);
    }else if(command.type==='ready-manual'){
      if(!c.localDraft?.trim()||!['write','reply','correction'].includes(currentWork(c).kind)||currentHandling(c).officialWaiting)throw new Error('本案没有可列入审查的当前工作稿。');
      const hash=digest(c.localDraft),sourceId='manual-'+digest(c.id+'\0'+record.processKey+'\0'+hash);
      if(!record.sources.some(s=>s.id===sourceId))record.sources.push({id:sourceId,caseId:id,processKey:record.processKey,title:'已完成的人工工作稿',business:currentWork(c).kind==='write'?'申请':currentWork(c).kind==='correction'?'补正':'答复',at:new Date().toISOString(),text:c.localDraft,files:[]});
      await this.persist(key);
    }else throw new Error('操作无效。');
    return this.view(key,id);
  })));}
  private async saveFile(c:Case,name:string,bytes:Buffer){
    const key=this.service.key,generation=this.service.generation,root=this.service.workspace.settings.workRoot,processKey=keyOf(c);
    this.service.flowFileWrites++;
    try{
      const latest=this.guard(key,c.id,processKey);
      if(!latest.directory)throw new Error('本案目录尚未创建。');
      const directory=await this.service.casePath(c.id);
      const ext=path.extname(name);
      const rel=`04_内部说明/撰写与审查/${safeName(path.basename(name,ext),160)}${ext}`;
      const file=await managedPath(directory,rel,true);
      this.guard(key,c.id,processKey);
      if(generation!==this.service.generation||root!==this.service.workspace.settings.workRoot)throw new Error('账号或目录已变化，未保存迟到文件。');
      try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||digest(await fs.readFile(file))!==digest(bytes))throw e;}
      return rel;
    }finally{this.service.flowFileWrites--;}
  }
  async addFiles(key:string,id:string,paths:string[]):Promise<ProfessionalCaseView>{return this.serial(async()=>{
    const c=this.guard(key,id),processKey=keyOf(c),root=this.service.workspace.settings.workRoot,generation=this.service.generation,record=this.record(await this.store(key),c);
    if(this.active.has(id))throw new Error('请先停止本案任务再选择完成稿。');
    if(!paths.length||paths.length>12)throw new Error('每次可选择 1–12 份完成稿。');
    const files:WorkFile[]=[];
    for(const source of paths){
      const stat=await fs.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024||!['.doc','.docx','.pdf','.txt','.md','.png','.jpg','.jpeg'].includes(path.extname(source).toLowerCase()))throw new Error('请选择 20MB 以内的文档或图像文件。');
      const bytes=await fs.readFile(source);this.guard(key,id,processKey);if(root!==this.service.workspace.settings.workRoot||generation!==this.service.generation)throw new Error('账号或目录已变化。');
      const rel=await this.saveFile(c,`${randomUUID()}-${path.basename(source)}`,bytes);files.push({name:path.basename(source),role:'当前完成稿',relativePath:rel,hash:digest(bytes)});
    }
    record.sources.push({id:randomUUID(),caseId:id,processKey,title:'外部完成稿 · '+files.map(f=>f.name).join('、'),business:currentWork(c).kind==='reply'?'答复':currentWork(c).kind==='correction'?'补正':'申请',at:new Date().toISOString(),text:'',files});await this.persist(key);return this.view(key,id);
  });}
  async addReferences(key:string,id:string,paths:string[]):Promise<ProfessionalCaseView>{return this.serial(async()=>{
    const c=this.guard(key,id),expected={generation:this.service.generation,root:this.service.workspace.settings.workRoot,process:keyOf(c)};
    if(this.active.has(id)||!editableCurrent(c)||currentWork(c).kind!=='write')throw new Error('请在可编辑的撰写阶段、任务停止后添加材料。');
    if(!paths.length||paths.length>12)throw new Error('每次可添加 1–12 份参考材料。');
    const prepared:Array<{name:string;bytes:Buffer}>=[];
    for(const source of paths){
      const stat=await fs.lstat(source),name=path.basename(source);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024||!['.doc','.docx','.pdf','.txt','.md','.png','.jpg','.jpeg'].includes(path.extname(name).toLowerCase()))throw new Error(`${name}：请选择 20MB 以内的 Word、PDF、文本或 PNG/JPEG 文件。`);
      const bytes=await fs.readFile(source);if(!bytes.length||bytes.length>20*1024*1024)throw new Error(`${name}：文件为空或超过 20MB。`);
      prepared.push({name,bytes});
    }
    this.service.flowFileWrites++;
    try{
      const added:NonNullable<Case['materials']>=[];
      for(const file of prepared){
        this.guard(key,id,expected.process);
        if(expected.generation!==this.service.generation||expected.root!==this.service.workspace.settings.workRoot)throw new Error('账号或目录已变化。');
        const materialId='reference-'+randomUUID(),directory=await this.service.casePath(id);
        const rel=`01_通知与材料/撰写参考/${materialId}/${safeName(file.name,180)}`;
        const target=await managedPath(directory,rel,true);await fs.writeFile(target,file.bytes,{flag:'wx',mode:0o600});
        added.push({id:materialId,name:file.name,role:'撰写参考材料',location:'本机导入',excerpt:'',ready:true,relativePath:rel});
      }
      await this.service.updateReferences(key,id,expected,added);
      const latest=this.guard(key,id,expected.process);
      const record=this.record(await this.store(key),latest);
      record.selectedMaterialIds=[...new Set([...(record.selectedMaterialIds??[]),...added.map(m=>m.id)])];
      await this.persist(key);
      this.changed(key);return this.view(key,id);
    }finally{this.service.flowFileWrites--;}
  });}
  async removeReference(key:string,id:string,materialId:string):Promise<ProfessionalCaseView>{return this.serial(async()=>{
    const c=this.guard(key,id);if(this.active.has(id))throw new Error('请先停止本案任务，再移除材料。');
    await this.service.updateReferences(key,id,{generation:this.service.generation,root:this.service.workspace.settings.workRoot,process:keyOf(c)},[],materialId);
    const latest=this.guard(key,id);
    const record=this.record(await this.store(key),latest);
    record.selectedMaterialIds=(record.selectedMaterialIds??[]).filter(mid=>mid!==materialId);
    await this.persist(key);
    this.changed(key);return this.view(key,id);
  });}
  noteSubmitted(key:string,caseId:string){const live=this.active.get(caseId);if(live?.key===key&&live.job.kind==='review'){live.abort.abort();live.handle?.abort();}this.changed(key);}
  async listTasks(key:string):Promise<import('../src/agent-api.ts').AgentTaskView[]>{return this.serial(async()=>{
    this.service.assertKey(key);const store=await this.store(key);this.service.assertKey(key);
    return store.records.flatMap(record=>{const c=this.service.workspace.cases.find(c=>c.id===record.caseId);if(!c)return [];return record.jobs.map(j=>({caseId:c.id,caseNumber:c.number,caseTitle:c.title,processKey:record.processKey,discussionId:j.id,runId:j.id,action:j.kind==='review'?'review' as const:'discuss' as const,professionalKind:j.kind,state:j.state,startedAt:j.at,endedAt:j.endedAt,error:j.error}));});
  });}
  async submissionApplication(key:string,id:string){return this.serial(async()=>{
    const c=this.guard(key,id),record=this.record(await this.store(key),c);if(!record.completed)return undefined;
    const source=record.sources.filter(s=>s.id.startsWith('writing-')&&!s.supersededAt).at(-1);
    return source?.files[0]?structuredClone(source.files[0]):undefined;
  });}
  async fileAllowed(key:string,id:string,relative:string){this.guard(key,id);const generation=this.service.generation;const store=await this.store(key);this.guard(key,id);if(generation!==this.service.generation)throw new Error('账号已变化，请重新打开成果。');return materialList(this.service.findCase(id)).some(m=>m.relativePath===relative&&m.ready)||store.records.filter(r=>r.caseId===id).some(r=>r.jobs.some(j=>j.artifactPath===relative)||r.sources.some(s=>s.files.some(f=>f.relativePath===relative)));}
  beforeWriting?:(key:string,id:string)=>Promise<void>;
  private async start(key:string,c:Case,record:ProfessionalRecord,kind:'writing'|'review',message:string,files:WorkFile[],source?:ReviewSource){
    const generation=this.service.generation,root=this.service.workspace.settings.workRoot;
    if(!root)throw new Error('请先设置工作目录。');
    const runId=randomUUID(),controller=new AbortController(),skill=await loadStandardSkill(path.join(this.resources,'standard-skills'),kind==='writing'?'draft':'review');
    const runtime=await this.models.resolveRuntimeConfig(key,runId);this.guard(key,c.id,record.processKey);
    if(kind==='writing'&&this.beforeWriting){await diagnosticStage('professional','permission',{runId,caseId:c.id},()=>this.beforeWriting!(key,c.id));this.guard(key,c.id,record.processKey);}
    if(runtime.profileKey!==key||generation!==this.service.generation||root!==this.service.workspace.settings.workRoot)throw new Error('账号或目录已变化。');
    const runRoot=path.join(this.service.root,'profiles',key,'professional-runs',runId),snapshotDir=path.join(runRoot,'snapshot'),outputDir=path.join(runRoot,'output');await fs.mkdir(snapshotDir,{recursive:true,mode:0o700});
    const materials:AgentHostMaterialSnapshot[]=[];
    await diagnosticStage('professional','materials',{runId,caseId:c.id},async()=>{for(const [i,f] of files.entries()){
      const file=await this.service.casePath(c.id,f.relativePath),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024)throw new Error('稿件文件无效或过大。');
      const bytes=await readBoundedFile(file,20*1024*1024,controller.signal),hash=digest(bytes);if(f.hash&&f.hash!==hash)throw new Error('稿件已被外部修改，请重新选择确切版本。');
      const snapshotPath=path.join(snapshotDir,`${i}${path.extname(f.name)}`);await fs.writeFile(snapshotPath,bytes,{flag:'wx',mode:0o600});materials.push({id:`m${i}`,name:f.name,role:f.role,relativePath:`${i}${path.extname(f.name)}`,snapshotPath,hash});
    }});
    this.guard(key,c.id,record.processKey);if(generation!==this.service.generation||root!==this.service.workspace.settings.workRoot)throw new Error('账号或目录已变化。');
    const job:ProfessionalJob={id:runId,caseId:c.id,processKey:record.processKey,kind,sourceId:source?.id,phase:kind==='writing'?record.phase:undefined,state:'running',at:new Date().toISOString(),tools:[],skillName:skill.name,skillHash:skill.manifestHash};record.jobs.push(job);
    const live:Live={key,generation,root,caseId:c.id,processKey:record.processKey,job,abort:controller,partial:'',source};this.active.set(c.id,live);try{await this.persist(key);}catch(e){this.active.delete(c.id);record.jobs=record.jobs.filter(j=>j.id!==runId);throw e;}
    const confirmed=record.confirmations.map(cf=>({stage:WRITING_PHASES[cf.phase],decision:cf.decision,text:record.jobs.find(j=>j.id===cf.jobId)?.text}));
    const contract=kind==='review'?'{"kind":"review","text":"完整审查报告（含来源版本、具体位置、P0-P3问题、适用矩阵、检查范围和未完成项）"}':record.phase===4?'{"kind":"writing","text":"整理说明和需要核验的附图 / 内部记录","documents":{"ABSTRACT":"摘要","ABSTRACT_IMAGE":"已核对的摘要附图说明或未提供标记","CLAIMS":"权利要求书","DESCRIPTION":"说明书","DRAWINGS":"附图清单，未提供真实图像时明确标记"}}':'{"kind":"writing","text":"当前阶段完整结果、建议和待用户确认项"}';
    const task=[SKILL_ADAPTER,`本案名称：${c.title}；专利类型：${c.type}。`,`当前任务：${kind==='writing'?WRITING_PHASES[record.phase]:'递交前个人独立审查'}。`,kind==='writing'?`只执行当前阶段。前序已确认内容：${JSON.stringify(confirmed)}\n用户本次要求：${message}`:`程序阶段：${source?.business==='申请'?'pre-filing（申请准备）':'post-filing（答复或补正）'}。业务：${source?.business}。仅审查此冻结版本，不注入或索取主讨论。`,
      `启用的标准技能：${skill.name}。必须调用 read_skill 阅读 ${kind==='writing'?'draft':'review'}/SKILL.md，并读取本阶段所需参考。资源目录：${skill.resources.map(r=>r.path).join('、')}`,
      `材料清单：${JSON.stringify(materials.map(({snapshotPath,...m})=>m))}。逐项调用 read_material 读取；按返回的范围续读，图像和扫描页需视觉核对。${source?.text?'必须调用 read_draft 阅读冻结完成稿。':''}`,
      '不可声称运行了没有实际执行的脚本；工具以本次实际开放权限为准，检索或命令未实际执行时须如实注明，不能声称完成。附图未提供时不能生成虚假图像占位并声称完成。',
      '公式格式规范：说明书、权利要求或实施例中出现的计算公式、参数关系与数学推导，必须采用标准 LaTeX 格式（行内公式使用 $公式$，独立行间公式使用 $$公式$$，例如 $$P = \\frac{F}{S}$$）。严禁使用难以阅读的纯文本 ASCII 字符拼凑公式，以保证公式结构和排版在阅读预览和 Word 导出中均符合标准规范。',
      `最终必须用 write_artifact 写入 result.json，JSON 格式：${contract}`].join('\n\n');
    live.wait=(async()=>{
      try{
        live.handle=await this.run({runId,caseId:c.id,processKey:record.processKey,action:kind==='review'?'review':'discuss',discussionId:runId,snapshotDir,outputDir,prompt:{rules:skill.main,task,combined:`${skill.main}\n\n${task}`},skillResources:skill.resources,materials,draft:source?.text?{id:source.id,text:source.text,amendmentText:source.amendmentText,applicationParts:source.applicationParts,correctionContents:source.correctionContents,amendmentBasis:source.amendmentBasis}:undefined,messages:[],runtime,signal:controller.signal,onEvent:event=>{
          if(!this.liveValid(live))return;
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
          const result=parseProfessionalResult(JSON.stringify(artifact),kind,job.phase);job.text=result.text;job.documents=result.documents;
          job.artifactPath=await this.saveFile(this.service.findCase(c.id),`${kind==='writing'?WRITING_PHASES[job.phase!]: '独立审查报告'}-${runId}.md`,Buffer.from(result.text));job.state='completed';
        });
      }catch(e){job.state=controller.signal.aborted?'stopped':'failed';job.error=(e as Error).message;}
      finally{await this.serial(async()=>{if(job.state==='running')job.state='stopped';job.endedAt=new Date().toISOString();if(this.active.get(c.id)===live)this.active.delete(c.id);await this.persist(key);});}
    })();
  }
}
