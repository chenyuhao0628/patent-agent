import { ensureCaseStarted } from './start-work.ts';
import { BaselandBusinessError } from './baseland-results.ts';
import { currentDraft } from '../src/domain/agent.ts';
import { exportReplyDocx, exportApplicationParts } from './document-export.ts';
import { APPLICATION_PART_LABELS } from '../src/domain/application-parts.ts';
import type { WorkFile } from '../src/professional-api.ts';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesktopService, OperationScope } from './service.ts';
import type { AgentHost } from './agent-host.ts';
import { currentWork, internalTransferAvailable } from '../src/domain/lifecycle.ts';
import { currentHandling } from '../src/domain/handling.ts';
import { FIVE_PARTS } from '../src/transfer-api.ts';
import { DEFAULT_INTERNAL_TRANSFER_RECIPIENT } from '../src/domain/workflow-nodes.ts';
import type { TransferView, TransferFileRole, TransferReview, TransferRoute, TransferFilePreviewResult, RemoteFileDeleteRef } from '../src/transfer-api.ts';
import { compareApplication, applicationSections } from './application-diff.ts';
import { inspectZipLimits, MAX_MATERIAL_BYTES } from './agent-document-reader.ts';
import { atomicCreate, atomicJSON, digest, extractDocxContent, getImageMime, bufferToDataUrl, managedPath, readBoundedFile, safeName } from './files.ts';
import { deleteRemoteTransferFile, prepareRemoteFileDeletion, remoteFileDeletionResult, clearRemoteTransfer, isRemoteTransferCleared, remoteFiles, defaultTransferForm, existingTransferParts, isRemoteTransferSaved, matchesNextFlow, readRemoteTransfer, rehydrateRemoteSavedView, remoteFileNames, saveRemoteTransfer, submitRemoteTransfer, validateReview } from './baseland-transfer.ts';
import type { RemoteTransfer } from './baseland-transfer.ts';
type Session={view:TransferView;remote:RemoteTransfer|null;generation:number;root:string;scope:OperationScope;files:Partial<Record<TransferFileRole,{name:string;relativePath:string;hash:string}>>};
export type TransferRecipientOption={step:{id:string;name:string};user:{id:string;name:string}};
export type TransferRecipientPreference={userId:string;userName?:string;stepId?:string};
/** Resolve only actual server candidates; ambiguous identities require explicit choice. */
export function pickTransferRecipient(options:TransferRecipientOption[],preference?:TransferRecipientPreference|null):TransferRecipientOption|undefined{
  if(!options.length)return;
  if(preference?.userId){
    const matched=options.filter(o=>o.user.id===preference.userId);
    if(matched.length===1)return matched[0];
    if(matched.length>1){
      const sameStep=preference.stepId?matched.find(o=>o.step.id===preference.stepId):undefined;
      return sameStep;
    }
  }
  if(preference?.userName){
    const matched=options.filter(o=>o.user.name===preference.userName);
    if(matched.length===1)return matched[0];
    if(matched.length>1){
      const sameStep=preference.stepId?matched.find(o=>o.step.id===preference.stepId):undefined;
      return sameStep;
    }
  }
  const preferred=options.filter(o=>o.user.name===DEFAULT_INTERNAL_TRANSFER_RECIPIENT);
  if(preferred.length===1)return preferred[0];
  if(options.length===1)return options[0];
}

/** Empty file-less drafts can be discarded; a draft that already has files or 补正条目 must be kept. */
export function disposableEmptyDraft(view:TransferView|undefined):boolean{
  if(!view||view.phase!=='draft')return false;
  if(view.files?.length)return false;
  if(view.fileDeletion||view.review?.form?.corrections?.length||view.localReviewSaved||view.revokedByUser||view.review?.remark?.trim())return false;
  return true;
}

function normalizeLocalCorrections(rows:TransferReview['form']['corrections']):TransferReview['form']['corrections']{
  if(!Array.isArray(rows)||rows.length>100)throw new Error('补正内容必须是逐条字段列表。');
  return rows.map((row,Sort)=>({
    ChangeId:typeof row?.ChangeId==='string'&&row.ChangeId.trim()?row.ChangeId:randomUUID(),
    Sort,
    FileName:String(row?.FileName??''),
    PositionInFile:String(row?.PositionInFile??''),
    CorrectionBefore:String(row?.CorrectionBefore??''),
    CorrectionAfter:String(row?.CorrectionAfter??''),
  }));
}

function validTransferHistory(value:unknown):value is TransferView{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as TransferView;
  return ['id','profileKey','caseId','caseNumber','caseTitle','processId','processName','at'].every(k=>typeof (v as unknown as Record<string,unknown>)[k]==='string')
    && !!v.id&&!!v.processId&&['application','reply','correction'].includes(v.route)
    && ['draft','saved','uncertain','submitted','superseded'].includes(v.phase)
    && Array.isArray(v.files)&&v.files.every(f=>f&&['application','baseline','reply'].includes(f.role)&&typeof f.name==='string'&&typeof f.hash==='string'&&typeof f.relativePath==='string'&&!path.isAbsolute(f.relativePath)&&!f.relativePath.replaceAll('\\','/').split('/').some(p=>p==='..'||p==='.'||!p))
    && (!v.fileDeletion||(!!v.fileDeletion.target&&['fileNo','handId','fingerprint'].every(k=>typeof (v.fileDeletion!.target as unknown as Record<string,unknown>)[k]==='string'&&!!(v.fileDeletion!.target as unknown as Record<string,unknown>)[k])&&['part','mix','reply'].includes(v.fileDeletion.kind)&&typeof v.fileDeletion.preservationHash==='string'&&/^[a-f0-9]{64}$/.test(v.fileDeletion.preservationHash)&&typeof v.fileDeletion.name==='string'&&typeof v.fileDeletion.requestedAt==='string'&&(v.fileDeletion.kind==='mix'||typeof v.fileDeletion.formCode==='string')))
    && Array.isArray(v.steps)&&Array.isArray(v.parts)&&Array.isArray(v.results)&&v.results.every(r=>typeof r==='string')
    && !!v.review&&typeof v.review==='object'&&typeof v.review.remark==='string'&&typeof v.review.stepId==='string'&&typeof v.review.userId==='string'&&!!v.review.form&&Array.isArray(v.review.form.corrections);
}

export class TransferHost {
  desktop:DesktopService;agent:AgentHost;private sessions=new Map<string,Session>();busy=false;
  private options:{templatesRoot?:string;applicationFile?:(key:string,id:string)=>Promise<WorkFile|undefined>;confirmName?:(details:{applicationName:string;caseName:string})=>Promise<boolean>};
  constructor(desktop:DesktopService,agent:AgentHost,options:{templatesRoot?:string;applicationFile?:(key:string,id:string)=>Promise<WorkFile|undefined>;confirmName?:(details:{applicationName:string;caseName:string})=>Promise<boolean>}={}){this.desktop=desktop;this.agent=agent;this.options=options;}
  private guard(s:Session,observation=false){
    this.desktop.assertScope(s.scope);
    this.desktop.assertMigrationNotAccepted();this.desktop.assertKey(s.view.profileKey);
    const c=this.desktop.transferCase(s.view.caseId),work=c.stage.current;
    if(this.desktop.generation!==s.generation||this.desktop.workspace.settings.workRoot!==s.root||work.processId!==s.view.processId||!observation&&(c.stage.officialWaiting||!c.transfer.available))throw new Error('账号、目录或案件当前流程已变化，请重新准备。');
    if(this.desktop.account?.status!=='authenticated'||!this.desktop.client)throw new Error('请先登录贝思兰德。');
  }
  private get(key:string,id:string){const s=this.sessions.get(id);if(!s||s.view.profileKey!==key)throw new Error('本次准备已过期，请重新读取。');this.guard(s);return s;}
  requestScope(key:string,id:string):OperationScope{return structuredClone(this.get(key,id).scope);}
  private async persist(s:Session){this.guard(s,true);await atomicJSON(await this.desktop.casePath(s.view.caseId,`04_内部说明/transfer-${s.view.id}.json`),{schema:1,remoteFingerprint:s.remote?.fingerprint,view:s.view},()=>this.guard(s,true));}
  private view(s:Session){this.guard(s,true);return structuredClone(s.view);}
  private async syncCase(s:Session){
    this.guard(s,true);
    const identity=this.desktop.transferCase(s.view.caseId).identity,remoteCaseId=this.desktop.findCase(s.view.caseId).remote?.caseId;
    try{await this.desktop.flow(s.view.caseId);}
    catch(e){this.guard(s,true);s.view.results.push(`本次转交记录已保留，但全案流程刷新失败：${(e as Error).message}`);await this.persist(s);return this.view(s);}
    this.desktop.assertScope({...s.scope,caseId:undefined,processKey:undefined,caseRevision:undefined});
    const c=this.desktop.transferCase(s.view.caseId);
    if(c.identity.source!==identity.source||this.desktop.findCase(s.view.caseId).remote?.caseId!==remoteCaseId||c.stage.current.processId!==s.view.processId)throw new Error('案件流程已切换，原转交结果已保留在历史记录中。');
    s.scope=this.desktop.captureScope(s.view.profileKey,s.view.caseId);
    await this.persist(s);
    return this.view(s);
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new Error('正在保存或转交，请等待本次操作完成。');this.busy=true;this.desktop.flowFileWrites++;
    try{return await fn();}finally{this.busy=false;this.desktop.flowFileWrites--;}
  }
  async inspect(key:string,caseId:string,sourceMode:'workbench'|'local'='workbench'):Promise<TransferView|null>{
    const scope=this.desktop.captureScope(key,caseId);
    const c=this.desktop.transferCase(caseId),work=c.stage.current;
    if(c.identity.source!=='baseland'||!work.processId||!c.transfer.available||c.stage.officialWaiting)return null;
    const old=[...this.sessions.values()].filter(s=>s.view.profileKey===key&&s.view.caseId===caseId&&s.view.processId===work.processId&&s.view.phase!=='superseded').sort((a,b)=>b.view.at.localeCompare(a.view.at))[0];
    if(old){
      if(this.desktop.generation===old.generation&&this.desktop.workspace.settings.workRoot===old.root&&scope.caseRevision===old.scope.caseRevision){
        if(!disposableEmptyDraft(old.view))return old.view.phase==='submitted'?this.refresh(key,old.view.id):structuredClone(old.view);
      }
    }
    const prior=(await this.journals(scope,caseId)).filter(data=>data.view.processId===work.processId&&data.view.phase!=='superseded');
    prior.sort((a,b)=>b.view.at.localeCompare(a.view.at));
    if(prior.length&&!disposableEmptyDraft(prior[0].view)){
      const previous=prior[0];
      this.desktop.assertScope(scope);
      const s:Session={scope,generation:scope.scopeVersion,root:scope.root??'',remote:null,files:{},view:structuredClone(previous.view)};
      for(const f of s.view.files){
        if(['application','baseline','reply'].includes(f.role)&&([`03_定稿/内部提交准备/${s.view.id}/`,`03_定稿/内部提交准备/提交材料_${s.view.id}/`].some(prefix=>f.relativePath.startsWith(prefix)))&&!f.relativePath.includes('..')){
          s.files[f.role]={...f};
        }
      }
      if(!s.view.submissionAttempted&&s.view.steps.length===0&&this.desktop.account?.status==='authenticated'&&this.desktop.client){
        const route:TransferRoute=work.kind==='write'?'application':work.kind==='reply'?'reply':work.kind==='correction'?'correction':null as any;
        if(route){
          try{
            const r=await readRemoteTransfer(this.desktop.client,work.processId,route);
            if(r?.steps?.length){
              s.remote=r;
              s.view.steps=r.steps;
              if(!s.view.review.stepId||!s.view.review.userId){
                const options=r.steps.flatMap(step=>step.users.map(user=>({step,user})));
                const picked=pickTransferRecipient(options,this.desktop.workspace.settings.lastTransferRecipient);
                if(picked){
                  if(!s.view.review.stepId)s.view.review.stepId=picked.step.id;
                  if(!s.view.review.userId)s.view.review.userId=picked.user.id;
                }
              }
              await this.persist(s);
            }
          }catch(e){this.desktop.assertScope(scope);throw e;}
        }
      }
      this.desktop.assertScope(scope);this.sessions.set(s.view.id,s);
      return s.view.phase==='submitted'?this.refresh(key,s.view.id):structuredClone(s.view);
    }
    if(this.desktop.account?.status==='authenticated'&&this.desktop.client){
      const route:TransferRoute=work.kind==='write'?'application':work.kind==='reply'?'reply':work.kind==='correction'?'correction':null as any;
      if(route){
        try{
          const r=await readRemoteTransfer(this.desktop.client,work.processId,route);
          if(r&&isRemoteTransferSaved(r,route)){
            const options=r.steps.flatMap(step=>step.users.map(user=>({step,user})));
            const picked=pickTransferRecipient(options,this.desktop.workspace.settings.lastTransferRecipient);
            const view=rehydrateRemoteSavedView({
              r,route,key,caseId,sourceMode,
              caseNumber:c.identity.number,
              caseTitle:c.identity.title,
              processId:work.processId,
              processName:c.transfer.processes.find(p=>p.id===work.processId)?.name??'',
              selectedRecipient:picked?{stepId:picked.step.id,userId:picked.user.id}:undefined,
            });
            this.desktop.assertScope(scope);
            const s:Session={scope,generation:scope.scopeVersion,root:scope.root??'',remote:r,files:{},view};
            this.sessions.set(s.view.id,s);
            await this.persist(s);
            return structuredClone(s.view);
          }
        }catch(e){this.desktop.assertScope(scope);throw e;}
      }
    }
    if(!prior.length||disposableEmptyDraft(prior[0].view))return null;
    const previous=prior[0];
    this.desktop.assertScope(scope);
    const s:Session={scope,generation:scope.scopeVersion,root:scope.root??'',remote:null,files:{},view:structuredClone(previous.view)};
    for(const f of s.view.files){
      if(['application','baseline','reply'].includes(f.role)&&([`03_定稿/内部提交准备/${s.view.id}/`,`03_定稿/内部提交准备/提交材料_${s.view.id}/`].some(prefix=>f.relativePath.startsWith(prefix)))&&!f.relativePath.includes('..')){
        s.files[f.role]={...f};
      }
    }
    this.sessions.set(s.view.id,s);
    return structuredClone(s.view);
  }
  async history(key:string,caseId:string):Promise<TransferView[]>{
    const scope=this.desktop.captureScope(key,caseId);
    return (await this.journals(scope,caseId)).map(row=>structuredClone(row.view)).sort((a,b)=>b.at.localeCompare(a.at));
  }
  private async journals(scope:OperationScope,caseId:string):Promise<Array<{schema:1;view:TransferView;remoteFingerprint?:string}>>{
    const key=scope.profileKey;
    const c=this.desktop.transferCase(caseId);
    if(!c.identity.hasDirectory)return [];
    const folder=await this.desktop.casePath(caseId,'04_内部说明');
    let entries:import('node:fs').Dirent[];
    try{entries=await fs.readdir(folder,{withFileTypes:true});}
    catch(e){this.desktop.assertScope(scope);if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
    const rows:Array<{schema:1;view:TransferView;remoteFingerprint?:string}>=[];
    for(const entry of entries){
      if(!/^transfer-[\da-f-]+\.json$/.test(entry.name))continue;
      if(!entry.isFile()||entry.isSymbolicLink())throw new Error('内部流转历史文件类型无效，未读取。');
      const file=await managedPath(folder,entry.name);
      const stat=await fs.stat(file);if(stat.size>8*1024*1024)throw new Error('内部流转历史记录过大。');
      const data:unknown=JSON.parse(await fs.readFile(file,'utf8'));
      const row=data as {schema?:number;view?:TransferView;remoteFingerprint?:string};
      const view=row?.view;
      if(view&&(view.profileKey!==key||view.caseId!==caseId))continue;
      if(row?.schema!==1||!validTransferHistory(view)||entry.name!==`transfer-${view.id}.json`)throw new Error('内部流转历史记录不完整，原文件已保留。');
      this.desktop.assertScope(scope);this.desktop.transferCase(caseId);
      rows.push({schema:1,view:structuredClone(view),remoteFingerprint:typeof row.remoteFingerprint==='string'?row.remoteFingerprint:undefined});
    }
    this.desktop.assertScope(scope);
    return rows;
  }
  async prepare(key:string,caseId:string,ignorePrior=false,sourceMode:'workbench'|'local'='workbench'):Promise<TransferView>{
    if(!['workbench','local'].includes(sourceMode))throw new Error('提交来源无效。');
    this.desktop.assertKey(key);this.desktop.assertMigrationNotAccepted();
    const scope=this.desktop.captureScope(key,caseId);
    const c=this.desktop.transferCase(caseId),work=c.stage.current;
    if(c.identity.source!=='baseland'||!work.processId||!c.transfer.available||c.stage.officialWaiting)throw new Error('本案当前没有可内部转交的贝思兰德办理流程。');
    const route:TransferRoute=work.kind==='write'?'application':work.kind==='reply'?'reply':work.kind==='correction'?'correction':(()=>{throw new Error('当前业务不适用申请、答复或补正提交。');})();
    const conflicting=[...this.sessions.values()].find(s=>s.view.profileKey===key&&s.view.caseId===caseId&&s.view.processId===work.processId&&(s.view.sourceMode??'workbench')!==sourceMode&&['saved','uncertain','submitted'].includes(s.view.phase));
    if(conflicting&&conflicting.view.phase==='saved'&&!conflicting.view.files.length&&!conflicting.view.sourceDraft&&!conflicting.view.submissionAttempted&&!conflicting.view.localReviewSaved){this.guard(conflicting);conflicting.view.sourceMode=sourceMode;await this.persist(conflicting);return this.view(conflicting);}
    if(conflicting)throw new Error('本案另一提交来源已有保存或待核对方案，请先打开原方案核对，不能切换来源重复提交。');
    const old=[...this.sessions.values()].filter(s=>s.view.profileKey===key&&s.view.caseId===caseId&&s.view.processId===work.processId&&s.view.phase!=='superseded'&&(s.view.sourceMode??'workbench')===sourceMode).sort((a,b)=>b.view.at.localeCompare(a.view.at))[0];
    if(old&&!ignorePrior){if(old.view.phase==='submitted')return this.refresh(key,old.view.id);this.guard(old);if(disposableEmptyDraft(old.view)){old.view.phase='superseded';await this.persist(old);return this.prepare(key,caseId,true,sourceMode);}return this.view(old);}
    const id=randomUUID(),s:Session={scope,generation:scope.scopeVersion,root:scope.root??'',remote:null,files:{},view:{id,sourceMode,profileKey:key,caseId,caseNumber:c.identity.number,caseTitle:c.identity.title,processId:work.processId,processName:c.transfer.processes.find(p=>p.id===work.processId)?.name??'',route,files:[],parts:[],review:{keepCodes:[],form:defaultTransferForm(null),stepId:'',userId:'',remark:''},steps:[],phase:'draft',results:[],existingFileNames:[],at:new Date().toISOString()}};
    this.guard(s);
    if(!ignorePrior){
      const restored=await this.inspect(key,caseId,sourceMode);this.guard(s);
      if(restored&&restored.phase==='saved'&&!restored.files.length&&!restored.sourceDraft&&!restored.submissionAttempted&&!restored.localReviewSaved){const restoredSession=this.sessions.get(restored.id)!;restoredSession.view.sourceMode=sourceMode;await this.persist(restoredSession);return this.view(restoredSession);}
      if(restored&&(restored.sourceMode??'workbench')===sourceMode)return restored;
      if(restored&&['saved','uncertain','submitted'].includes(restored.phase))throw new Error('本案另一提交来源已有保存或待核对记录，请先打开原方案核对。');
    }
    s.remote=await readRemoteTransfer(this.desktop.client!,work.processId,route);this.guard(s);this.assignRemote(s);
    const prior=(await this.journals(scope,caseId)).filter(data=>data.view.processId===work.processId&&data.view.route===route&&data.view.phase!=='superseded');
    if(prior.some(p=>(p.view.sourceMode??'workbench')!==sourceMode&&['saved','uncertain','submitted'].includes(p.view.phase)))throw new Error('本案另一提交来源已有保存或待核对记录，请先打开原方案核对。');
    const sameSource=prior.filter(p=>(p.view.sourceMode??'workbench')===sourceMode);prior.splice(0,prior.length,...sameSource);
    prior.sort((a,b)=>b.view.at.localeCompare(a.view.at));
    if(prior.length&&!ignorePrior&&!disposableEmptyDraft(prior[0].view)){
      const previous=prior[0];s.view=previous.view;
      if(s.remote){
        s.view.steps=s.remote.steps;
        s.view.existingFileNames=remoteFileNames([...(s.remote.files||[]),...(s.remote.form?.File?[s.remote.form.File]:[])]);
        s.view.existingFiles=remoteFiles(s.remote);
        if(!s.view.review.stepId||!s.view.review.userId){
          const options=s.remote.steps.flatMap(step=>step.users.map(user=>({step,user})));
          const picked=pickTransferRecipient(options,this.desktop.workspace.settings.lastTransferRecipient);
          if(picked){
            if(!s.view.review.stepId)s.view.review.stepId=picked.step.id;
            if(!s.view.review.userId)s.view.review.userId=picked.user.id;
          }
        }
      }
      if(s.view.phase==='saved'){
        if(s.view.handId!==s.remote?.handId||!s.remote?.hand.IsReviewing){
          s.view.phase='uncertain';
          s.view.error='应用重开后，服务端递交实例或权限已变化，请先核对当前材料和流程。';
        }
      }
      for(const f of s.view.files){if(!['application','baseline','reply'].includes(f.role)||!([`03_定稿/内部提交准备/${s.view.id}/`,`03_定稿/内部提交准备/提交材料_${s.view.id}/`].some(prefix=>f.relativePath.startsWith(prefix)))||f.relativePath.includes('..'))throw new Error('内部提交文件记录无效。');s.files[f.role]={...f};}
      this.sessions.set(s.view.id,s);return this.view(s);
    }
    if(!ignorePrior&&isRemoteTransferSaved(s.remote,route)){
      const options=s.remote!.steps.flatMap(step=>step.users.map(user=>({step,user})));
      const picked=pickTransferRecipient(options,this.desktop.workspace.settings.lastTransferRecipient);
      s.view=rehydrateRemoteSavedView({
        id,r:s.remote!,route,key,caseId,
        caseNumber:c.identity.number,
        caseTitle:c.identity.title,
        processId:work.processId,
        processName:c.transfer.processes.find(p=>p.id===work.processId)?.name??'',
        sourceMode,
        selectedRecipient:picked?{stepId:picked.step.id,userId:picked.user.id}:undefined,
      });
      this.sessions.set(s.view.id,s);await this.persist(s);return this.view(s);
    }
    this.sessions.set(id,s);
    // Only one exact ready original is suggested automatically. Ambiguous sources stay unselected.
    const originals=[...new Map(c.materials.all.map(m=>[m.relativePath,m])).values()].filter(m=>m.ready&&m.relativePath&&/\.docx$/i.test(m.name)&&/原始申请/.test(m.role));
    if(sourceMode==='workbench'&&originals.length===1)await this.attach(s,'baseline',await this.desktop.casePath(caseId,originals[0].relativePath!));
    if(sourceMode==='workbench'&&route==='application'&&this.options.applicationFile){
      const f=await this.options.applicationFile(key,caseId);this.guard(s);
      if(f){const source=await this.desktop.casePath(caseId,f.relativePath);if(f.hash&&digest(await fs.readFile(source))!==f.hash)throw new Error('撰写完成稿已被外部修改，请手动选择确切版本。');await this.attach(s,'application',source);}
    }
    if(sourceMode==='workbench'&&(route==='reply'||route==='correction')){
      try {
        const agent=await this.agent.getCase(key,caseId);this.guard(s);
        const artifact=agent.artifacts.filter(a=>a.kind==='final-word'&&a.versionId===agent.process.finalized?.draftVersionId).sort((a,b)=>b.at.localeCompare(a.at))[0];
        const adopted=currentDraft(agent.process);
        const pending=[...agent.process.drafts].reverse().find(d=>d.adoptStatus==='pending'&&(!agent.process.userSelectedStrategyId||d.strategyId===agent.process.userSelectedStrategyId));
        const draft=pending&&(!adopted||(pending.at??'')>(adopted.at??''))?pending:adopted;
        if(draft){s.view.sourceDraft={id:draft.id,at:draft.at,pending:draft.adoptStatus==='pending'};s.view.results.push('已自动获取'+(draft.adoptStatus==='pending'?'最新待采用稿':'当前采用稿')+'的提交副本，请确认本次使用的版本。不会自动采用或覆盖工作稿。');}
        else s.view.results.push('未找到当前策略的可用工作台稿件，请先生成稿件或选择本地文件。');
        if(route==='correction'&&draft&&draft.correctionContents?.length){
          const usedIds=new Set<string>();
          s.view.review.form.corrections=draft.correctionContents.map((row,Sort)=>{
            const saved=s.view.review.form.corrections.find(old=>!usedIds.has(old.ChangeId)&&old.FileName===row.FileName&&old.PositionInFile===row.PositionInFile);
            const ChangeId=saved?.ChangeId||randomUUID();usedIds.add(ChangeId);
            return {...saved,...row,ChangeId,Sort};
          });
          s.view.results.push('已带入当前采用版本的补正字段，请核对文件名称、具体位置、补正前和补正后。');
        }
        if(route==='reply'&&artifact&&artifact.versionId===draft?.id)await this.attach(s,'reply',await this.desktop.casePath(caseId,artifact.relativePath));
        else if(route==='reply'&&draft?.text.trim()&&this.options.templatesRoot&&agent.process.classification.status==='classified'&&agent.process.classification.noticeCategory==='审查意见通知书'){
          const bytes=await exportReplyDocx(this.options.templatesRoot,draft.text,agent.process.classification.officeActionRound);this.guard(s);
          const source=await this.desktop.casePath(caseId,`03_定稿/内部提交准备/提交材料_${id}/意见陈述书-待提交.docx`);await fs.mkdir(path.dirname(source),{recursive:true});await atomicCreate(source,bytes,()=>this.guard(s));this.guard(s);await this.attach(s,'reply',source);
          s.view.results.push('已按自动获取稿件生成意见陈述书待提交副本；个人 AI 审查可选，请核对本次材料。');
        }
        if(draft&&draft.applicationParts===undefined)s.view.results.push('该版本尚未保存完整的修改申请内容；已带入答复正文。如有申请文件修改，请在稿件中核对并保存“本次修改文件”，或手动选择修改后文件。');
        if(draft&&draft.applicationParts&&Object.keys(draft.applicationParts).length&&this.options.templatesRoot){
          const bytes=await exportApplicationParts(this.options.templatesRoot,draft.applicationParts);this.guard(s);
          const source=await this.desktop.casePath(caseId,`03_定稿/内部提交准备/提交材料_${id}/本次修改申请文件.docx`);
          await fs.mkdir(path.dirname(source),{recursive:true});await atomicCreate(source,bytes,()=>this.guard(s));
          await this.attach(s,'application',source);
          const selected=new Set<string>(Object.keys(draft.applicationParts).map(k=>APPLICATION_PART_LABELS[k as keyof typeof APPLICATION_PART_LABELS]));
          s.view.parts=s.view.parts.map(p=>selected.has(p.name)?{...p,available:true,reason:p.changed===null?'已采用稿明确修改此部分，缺少可比较基线，请人工核对。':p.reason}:{...p,changed:false,available:false,reason:'本次采用稿未修改此部分，不加入递交材料。'});
          s.view.review.keepCodes=s.view.parts.filter(p=>p.available&&p.changed!==false).map(p=>p.code);
          s.view.results.push('已带入自动获取版本的完整修改部分并预选递交清单；请核对五书选择和补正表单，本地完整稿及历史保留。');
        }
      } catch (err) {
        s.view.results.push('读取工作台稿件时遇到提示：' + (err as Error).message + '。你可直接使用下方【选择文件】手动上传，或点击切换为本地文件提交。');
      }
    }
    await this.persist(s);return this.view(s);
  }
  private assignRemote(s:Session,preserveDraft=false){
    const r=s.remote;s.view.handId=r?.handId;s.view.currentNode=r?.hand.CurrentFlowInfo?.FlowNodeName;s.view.currentUser=r?.hand.CurrentFlowInfo?.FlowUserName;s.view.steps=r?.steps??[];
    s.view.existingFileNames=remoteFiles(r).map(f=>f.name);
    s.view.canEditRemote=r? r.hand.IsReviewing===true:undefined;
    s.view.existingFiles=remoteFiles(r);
    if(!preserveDraft)s.view.review.form=defaultTransferForm(r);
    if(!s.files.application){s.view.parts=existingTransferParts(r);if(!preserveDraft)s.view.review.keepCodes=s.view.parts.filter(p=>p.available).map(p=>p.code);}
    const options=s.view.steps.flatMap(step=>step.users.map(user=>({step,user})));
    const current=options.find(o=>o.step.id===s.view.review.stepId&&o.user.id===s.view.review.userId);
    const picked=current??pickTransferRecipient(options,this.desktop.workspace.settings.lastTransferRecipient);
    s.view.review.stepId=picked?.step.id??'';s.view.review.userId=picked?.user.id??'';
  }
  private async rememberRecipient(s:Session){
    const step=s.view.steps.find(x=>x.id===s.view.review.stepId),user=step?.users.find(u=>u.id===s.view.review.userId);
    if(!step||!user)return;
    const next:TransferRecipientPreference={userId:user.id,userName:user.name,stepId:step.id};
    const prev=this.desktop.workspace.settings.lastTransferRecipient;
    if(prev?.userId===next.userId&&prev?.stepId===next.stepId&&prev?.userName===next.userName)return;
    await this.desktop.rememberTransferRecipient(s.scope,next);
  }
  private async attach(s:Session,role:TransferFileRole,source:string){
    this.guard(s);if(role==='reply'&&s.view.route!=='reply')throw new Error('本业务通过表单字段保存补正内容，不能上传意见或补正说明文件。');if(s.view.phase!=='draft')throw new Error('已保存的提交方案不能直接改文件，请完成当前结果核对。');
    const stat=await fs.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_MATERIAL_BYTES||!source.toLowerCase().endsWith('.docx'))throw new Error('请选择不超过 20 MB 的 DOCX 普通文件。');
    let bytes:Buffer;try{bytes=await readBoundedFile(source,MAX_MATERIAL_BYTES);}catch{throw new Error('请选择不超过 20 MB 的 DOCX 普通文件。');}
    inspectZipLimits(bytes);this.guard(s);
    const hash=digest(bytes),name=safeName(path.basename(source),90),relativePath=`03_定稿/内部提交准备/提交材料_${s.view.id}/${({application:'修改申请文件',baseline:'修改前申请文件',reply:'意见陈述书'} as const)[role]}-${hash.slice(0,8)}-${name}`;
    const target=await this.desktop.casePath(s.view.caseId,relativePath);await fs.mkdir(path.dirname(target),{recursive:true});
    try{await atomicCreate(target,bytes,()=>this.guard(s));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||digest(await fs.readFile(target))!==hash)throw e;}
    this.guard(s);s.files[role]={name,relativePath,hash};
    s.view.files=Object.entries(s.files).map(([role,f])=>({role:role as TransferFileRole,...f!}));
    if(role==='reply')return;
    const before=await this.bytes(s,'baseline'),after=await this.bytes(s,'application');
    if(!after)return;
    const parts=await compareApplication(before?.bytes,after.bytes);this.guard(s);s.view.parts=parts;
    s.view.review.keepCodes=after?(s.view.route==='application'?FIVE_PARTS.map(p=>p.code):s.view.parts.filter(p=>p.changed).map(p=>p.code)):[];
    if(s.view.sourceMode!=='local'&&s.view.route==='correction'&&!s.view.review.form.corrections.length)s.view.review.form.corrections=s.view.parts.filter(p=>p.changed&&p.before&&p.after).map((p,i)=>({ChangeId:randomUUID(),Sort:i,FileName:p.name,PositionInFile:'本次修改段落（请核对具体位置）',CorrectionBefore:p.before!,CorrectionAfter:p.after!}));
  }
  private async bytes(s:Session,role:TransferFileRole){const f=s.files[role];if(!f)return;this.guard(s);const target=await this.desktop.casePath(s.view.caseId,f.relativePath);const st=await fs.lstat(target);if(st.isSymbolicLink()||!st.isFile()||st.size>MAX_MATERIAL_BYTES)throw new Error('本次文件副本不可用。');let bytes:Buffer;try{bytes=await readBoundedFile(target,MAX_MATERIAL_BYTES);}catch{throw new Error('本次文件副本不可用。');}this.guard(s);if(digest(bytes)!==f.hash)throw new Error('本次文件副本已经变化，请重新选择核对。');return {name:f.name,bytes};}
  async addFile(key:string,id:string,role:TransferFileRole,source:string){return this.exclusive(async()=>{if(!['baseline','application','reply'].includes(role))throw new Error('文件用途无效。');const s=this.get(key,id);await this.attach(s,role,source);await this.persist(s);return this.view(s);});}
  async removeFile(key:string,id:string,role:TransferFileRole){return this.exclusive(async()=>{
    if(!['baseline','application','reply'].includes(role))throw new Error('文件用途无效。');
    const s=this.get(key,id);
    if(s.view.phase!=='draft')throw new Error('已保存或已转交的提交方案不能直接移除文件，请先撤销保存。');
    if(!s.files[role])return this.view(s);
    delete s.files[role];
    s.view.files=Object.entries(s.files).map(([r,f])=>({role:r as TransferFileRole,...f!}));
    if(role==='application'){
      s.view.sourceDraft=undefined;
      s.view.parts=existingTransferParts(s.remote);
      s.view.review.keepCodes=s.view.parts.filter(p=>p.available).map(p=>p.code);
    }else if(role==='baseline'){
      const after=await this.bytes(s,'application');
      if(after){
        s.view.parts=await compareApplication(undefined,after.bytes);
        s.view.review.keepCodes=s.view.route==='application'?FIVE_PARTS.map(p=>p.code):s.view.parts.filter(p=>p.changed).map(p=>p.code);
      }else{
        s.view.parts=existingTransferParts(s.remote);
        s.view.review.keepCodes=s.view.parts.filter(p=>p.available).map(p=>p.code);
      }
    }
    s.view.results.push(`已移除本地【${({application:'修改申请文件',baseline:'修改前申请文件',reply:'意见陈述书'} as const)[role]}】。`);
    await this.persist(s);
    return this.view(s);
  });}
  async reprepare(key:string,id:string){return this.exclusive(async()=>{
    const old=this.get(key,id);if(old.view.fileDeletion)throw new Error('单份删除结果待核验，请先刷新材料；不能重新准备或重发删除。');if(old.view.phase==='submitted')throw new Error('已确认内部转交，不能重复准备同一提交。');
    const fresh=await readRemoteTransfer(this.desktop.client!,old.view.processId,old.view.route);this.guard(old);
    const target=old.view.steps.find(s=>s.id===old.view.review.stepId),user=target?.users.find(u=>u.id===old.view.review.userId);
    if(target?.name&&user?.name&&fresh?.hand.CurrentFlowInfo?.CaseHandStepId===target.id&&fresh?.hand.CurrentFlowInfo?.FlowUserId===user.id)throw new Error('已到达原方案的下一办理人，请刷新核对，不能重新提交。');
    old.view.phase='superseded';old.view.results.push('用户选择重新核对；原方案及结果保留，本方案不可再次执行。');await this.persist(old);
    const view=await this.prepare(key,old.view.caseId,true,old.view.sourceMode??'workbench'),s=this.get(key,view.id);
    for(const role of ['baseline','application','reply'] as const){const f=old.files[role];if(f&&(role==='baseline'||(!s.files[role]&&!s.view.sourceDraft)))await this.attach(s,role,await this.desktop.casePath(old.view.caseId,f.relativePath));}
    await this.persist(s);return this.view(s);
  });}
  async startHand(key:string,id:string){return this.exclusive(async()=>{
    const s=this.get(key,id);if(s.remote)return this.view(s);
    if(s.view.phase!=='draft')throw new Error('启动结果待核验，请先刷新，不要重复启动。');
    const c=this.desktop.transferCase(s.view.caseId),proc=c.transfer.processes.find(p=>p.id===s.view.processId);
    if(proc?.status!==0)throw new Error('只有待办流程可以在此启动递交实例。');
    s.view.phase='uncertain';s.view.results.push('正在启动递交实例；中断后请刷新核对。');await this.persist(s);
    try{
      await ensureCaseStarted(this.desktop,key,s.view.caseId);this.guard(s);
      s.remote=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);this.guard(s);
      if(!s.remote)throw new Error('未取得新递交实例，请在贝思兰德核对。');
      this.assignRemote(s);s.view.phase='draft';s.view.error=undefined;
      await this.desktop.flow(s.view.caseId);this.guard(s);
    }catch(e){s.view.error=(e as Error).message;}
    await this.persist(s);return this.view(s);
  });}
  async saveLocalReview(key:string,id:string,review:TransferReview){return this.exclusive(async()=>{
    const s=this.get(key,id);
    if(s.view.phase!=='draft')throw new Error('已保存到贝思兰德的提交方案不能在此改补正草稿，请先撤销保存。');
    if(!review||!Array.isArray(review.keepCodes)||!review.form)throw new Error('核对表单无效。');
    if(new Set(review.keepCodes).size!==review.keepCodes.length||review.keepCodes.some(c=>!FIVE_PARTS.some(p=>p.code===c)))throw new Error('五书选择无效。');
    s.view.review={
      ...structuredClone(review),
      form:{...structuredClone(review.form),corrections:normalizeLocalCorrections(review.form.corrections)},
    };
    s.view.localReviewSaved=true;
    s.view.at=new Date().toISOString();
    await this.persist(s);
    return this.view(s);
  });}
  async save(key:string,id:string,review:TransferReview){return this.exclusive(async()=>{
    const s=this.get(key,id);if(s.view.fileDeletion)throw new Error('单份删除结果待核验，请先刷新材料。');if(s.view.phase!=='draft')throw new Error('本次方案不能重复保存，请先核对当前状态。');
    if(!s.remote){s.remote=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);this.guard(s);}
    if(!s.remote)throw new Error('未能读取到贝思兰德递交实例。');
    s.view.review=structuredClone(review);s.view.error=undefined;s.view.revokedByUser=undefined;
    const application=await this.bytes(s,'application'),reply=await this.bytes(s,'reply');
    if(s.view.sourceDraft&&review.confirmedDraftId!==s.view.sourceDraft.id)throw new Error('请先确认本次自动获取的工作台稿件版本。');
    validateReview(s.view.route,s.remote,review,!!application,!!reply);
    let wrote=false;
    // Persist intent before the first remote write. An interrupted attempt never looks unsent.
    s.view.phase='uncertain';s.view.results.push('正在保存本次文件与业务表单；中断后需回读核对。');await this.persist(s);
    try{
      s.remote=await saveRemoteTransfer({client:this.desktop.client!,processId:s.view.processId,caseTitle:s.view.caseTitle,route:s.view.route,remote:s.remote,review:s.view.review,application,reply,confirmName:this.options.confirmName,guard:()=>this.guard(s),onWrite:()=>{wrote=true;},checkpoint:async message=>{s.view.results.push(message);await this.persist(s);}});
      s.view.phase='saved';s.view.cleanupPending=false;s.view.cleanupFileNos=undefined;
      s.view.at=new Date().toISOString();
      s.view.existingFileNames=remoteFileNames(s.remote.files);s.view.existingFiles=remoteFiles(s.remote);
      s.view.steps=s.remote.steps;
      if(!s.view.review.stepId||!s.view.review.userId){
        const options=s.remote.steps.flatMap(step=>step.users.map(user=>({step,user})));
        const picked=pickTransferRecipient(options,this.desktop.workspace.settings.lastTransferRecipient);
        if(picked){
          if(!s.view.review.stepId)s.view.review.stepId=picked.step.id;
          if(!s.view.review.userId)s.view.review.userId=picked.user.id;
        }
      }
      s.view.results.push('可以核对接收人并执行内部转交。');
      await this.rememberRecipient(s);
    }
    catch(e){if(!wrote)s.view.phase='draft';s.view.error=(e as Error).message;s.view.results.push('保存未能全部核验，尚未转交。');}
    await this.persist(s);return this.view(s);
  });}
  async revoke(key:string,id:string){return this.exclusive(async()=>{
    const s=this.get(key,id);
    if(s.view.fileDeletion)throw new Error('单份删除结果待核验，请先刷新材料；不能返回编辑或重复删除。');
    if(s.view.phase==='submitted')throw new Error('已确认内部转交，不能撤销。');
    if(s.view.phase!=='saved'&&s.view.phase!=='uncertain')throw new Error('当前状态无需撤销。');
    if(s.view.phase==='uncertain'&&s.view.submissionAttempted)throw new Error('本次内部转交请求已发送但结果未确认，必须先用【刷新本案】核对，不能撤销到草稿重复办理。');
    const interrupted=s.view.phase==='uncertain';
    s.view.phase='draft';
    s.view.revokedByUser=true;
    s.view.at=new Date().toISOString();
    s.view.error=undefined;
    // A save may have written remote state before failing. Re-read so the next
    // attempt compares against the current server fingerprint instead of the
    // pre-write one, otherwise every retry is rejected as "服务端已变化".
    if(interrupted&&this.desktop.account?.status==='authenticated'&&this.desktop.client){
      try{
        const r=await readRemoteTransfer(this.desktop.client,s.view.processId,s.view.route);this.guard(s);
        if(r){s.remote=r;s.view.handId=r.handId;s.view.currentNode=r.hand.CurrentFlowInfo?.FlowNodeName;s.view.currentUser=r.hand.CurrentFlowInfo?.FlowUserName;s.view.canEditRemote=r.hand.IsReviewing===true;s.view.steps=r.steps;s.view.existingFileNames=remoteFileNames([...(r.files||[]),...(r.form?.File?[r.form.File]:[])]);s.view.existingFiles=remoteFiles(r);}
      }catch{}
    }
    s.view.results.push(interrupted?'已撤销本次未完成的保存，返回草稿编辑状态；已回读服务端当前材料，原表单与本地文件保留，可修改后重新保存。':'已撤销本次保存，返回草稿编辑状态；原表单与材料保留，可修改后重新保存。');
    await this.persist(s);
    return this.view(s);
  });}
  async clearRemote(key:string,id:string){return this.exclusive(async()=>{
    const s=this.get(key,id);
    if(s.view.fileDeletion)throw new Error('单份删除结果待核验，请先刷新材料；不能改为整组清理。');
    if(s.view.phase==='submitted')throw new Error('已内部转交的案件不可清空服务端材料。');
    if(!s.remote){s.remote=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);this.guard(s);}
    if(!s.remote)throw new Error('未能读取到贝思兰德递交实例。');
    if(s.remote.hand.IsReviewing!==true)throw new Error('当前流程节点无编辑或删除材料权限。');
    if(s.view.submissionAttempted)throw new Error('转交请求结果尚未核验，不能清理材料。');
    s.remote=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);this.guard(s);
    if(!s.remote||s.view.handId&&s.remote.handId!==s.view.handId)throw new Error('待清理递交实例已变化。');
    s.view.handId=s.remote.handId;
    const group=s.remote.instructions?.FormGroup??[];
    s.view.cleanupFileNos=[...new Set([...(s.view.cleanupFileNos??[]),...group.map((g:any)=>String(g.File?.FileNo??'')),...(s.view.route==='reply'?[String(s.remote.form?.File?.FileNo??'')]:[])].filter(Boolean))];
    s.view.phase='uncertain';s.view.cleanupPending=true;s.view.revokedByUser=true;
    s.view.results.push('正在清理当前递交实例；中断或部分完成后必须回读核验。');
    await this.persist(s);
    try{
      const cleared=await clearRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route,()=>this.guard(s),{handId:s.remote.handId,fingerprint:s.remote.fingerprint});
      if(!cleared||!isRemoteTransferCleared(cleared,s.view.route,s.view.cleanupFileNos))throw new Error('清理结果未完全核验。');
      s.remote=cleared;this.assignRemote(s,true);s.view.phase='draft';s.view.cleanupPending=false;s.view.cleanupFileNos=undefined;s.view.error=undefined;
      s.view.results.push('已回读确认当前递交实例的目标文件关联与补正条目清空；本地文件和草稿保留。');
    }catch(e){this.guard(s);s.view.error=(e as Error).message;s.view.results.push('清理可能部分完成，尚未确认全部清空；请刷新核对，不可内部转交。');}
    await this.persist(s);return this.view(s);
  });}
  async deleteRemoteFile(key:string,id:string,target:RemoteFileDeleteRef){return this.exclusive(async()=>{
    const s=this.get(key,id);
    if(s.view.fileDeletion||s.view.cleanupPending||s.view.submissionAttempted||!['draft','saved'].includes(s.view.phase))throw new Error('当前状态不能删除远端文件，请先刷新核对待完成的操作。');
    if(!target||!target.fileNo||target.handId!==s.view.handId)throw new Error('删除目标不属于当前递交实例。');
    const listed=s.view.existingFiles?.find(f=>f.fileNo===target.fileNo)?.deleteRef;
    if(!listed||listed.handId!==target.handId||listed.fingerprint!==target.fingerprint)throw new Error('删除目标已变化或尚未核验，请刷新材料后重新确认。');
    const fresh=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);this.guard(s);
    if(!fresh)throw new Error('无法读取当前递交实例，未删除。');
    const deletion=prepareRemoteFileDeletion(fresh,target),previousPhase=s.view.phase;
    s.remote=fresh;s.view.fileDeletion=deletion;s.view.phase='uncertain';s.view.error=undefined;
    s.view.at=new Date().toISOString();
    s.view.results.push(`正在删除远端文件「${deletion.name}」的当前实例关联；中断后仅刷新核验，不自动重发。`);
    await this.persist(s);
    let wrote=false;
    try{
      s.remote=await deleteRemoteTransferFile({client:this.desktop.client!,processId:s.view.processId,route:s.view.route,deletion,guard:()=>this.guard(s),onWrite:()=>{wrote=true;}});
      this.finishFileDeletion(s);
    }catch(e){
      this.guard(s);
      if(!wrote){s.view.fileDeletion=undefined;s.view.phase=previousPhase;}
      s.view.error=(e as Error).message;
    }
    await this.persist(s);return this.view(s);
  });}
  private finishFileDeletion(s:Session){
    const deletion=s.view.fileDeletion!;
    this.assignRemote(s,true);
    if(deletion.kind==='part')s.view.review.keepCodes=s.view.review.keepCodes.filter(code=>code!==deletion.formCode);
    s.view.fileDeletion=undefined;s.view.phase='draft';s.view.revokedByUser=true;s.view.localReviewSaved=true;s.view.error=undefined;
    s.view.at=new Date().toISOString();
    s.view.results.push(`已核验：仅移除「${deletion.name}」的远端关联，其他远端材料、业务表单、本地原件和草稿保留。请重新核对后保存；本地副本仍选中时，再次保存可能重新上传。`);
  }
  private async generateFilePreview(name: string, bytes: Buffer, role?: TransferFileRole): Promise<TransferFilePreviewResult> {
    const ext = name.split('.').pop()?.toLowerCase();
    const isImageExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext || '');
    const isImageMagic = bytes.length >= 4 && (
      bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
      (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      bytes.subarray(0, 4).toString('ascii') === 'GIF8' ||
      (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') ||
      (bytes[0] === 0x42 && bytes[1] === 0x4d)
    );

    if (isImageExt || isImageMagic) {
      const mime = getImageMime(name, bytes);
      const dataUrl = bufferToDataUrl(bytes, mime);
      return {
        name,
        content: `![${name}](${dataUrl})`,
        dataUrl,
        mediaType: 'image',
      };
    }

    if (ext === 'txt' || ext === 'md' || ext === 'json') {
      try {
        return { name, content: bytes.toString('utf8'), mediaType: 'text' };
      } catch {
        return { name, content: '（文本解析失败）', mediaType: 'text' };
      }
    }

    if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from('%PDF'))) {
      return {
        name,
        content: `（PDF 文件：${name}，请使用系统关联程序打开查看完整版式）`,
        mediaType: 'unknown',
      };
    }

    const docx = await extractDocxContent(bytes, { maxImages: 40, maxImageBytes: 5 * 1024 * 1024 });
    let parts = docx.parts;

    if ((role === 'application' || role === 'baseline') && (!parts || parts.length === 0)) {
      const sections = await applicationSections(bytes).catch(() => new Map());
      if (sections.size > 0) {
        parts = FIVE_PARTS.map(p => ({ code: p.code, name: p.name, content: sections.get(p.code)?.text || '（本部分无正文）' }));
      }
    }

    return {
      name,
      content: docx.text || '暂无可用正文或附图预览',
      parts,
      mediaType: 'docx',
    };
  }

  async previewFile(key:string,id:string,fileRef:{role?:TransferFileRole;partCode?:string;fileNo?:string;name?:string}):Promise<TransferFilePreviewResult>{
    const s=this.get(key,id);
    const previewLocal=async(role:TransferFileRole)=>{
      const file=await this.bytes(s,role);
      if(!file)throw new Error('指定的本地材料不存在，请重新核对本次材料。');
      const preview=await this.generateFilePreview(file.name,file.bytes,role);
      this.guard(s);
      return preview;
    };
    if(fileRef.partCode){
      const p=s.view.parts.find(item=>item.code===fileRef.partCode);
      if(!p)throw new Error('指定的申请文件部分不存在。');
      // Verify the prepared copy even when the comparison already cached text.
      const preview=s.files.application?await previewLocal('application'):undefined;
      const content=p.after||p.before||preview?.parts?.find(pt=>pt.code===fileRef.partCode)?.content||p.reason;
      this.guard(s);
      return {name:p.name,content:content||'（本部分无正文）'};
    }
    if(fileRef.role)return previewLocal(fileRef.role);

    if(fileRef.fileNo||fileRef.name){
      if(!s.remote){
        const remote=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);
        this.guard(s);
        if(!remote||s.view.handId&&remote.handId!==s.view.handId)throw new Error('递交实例已变化，请重新核对本次材料。');
        s.remote=remote;
      }
      const matches=remoteFiles(s.remote).filter(file=>
        (!fileRef.fileNo||file.fileNo===fileRef.fileNo)
        &&(!fileRef.name||file.name===fileRef.name));
      const numbers=[...new Set(matches.map(file=>file.fileNo))];
      if(numbers.length!==1)throw new Error('指定的远端材料不属于本次流程或无法唯一确定。');
      const name=matches[0].name;
      this.guard(s);
      const bytes=await this.desktop.client!.download(numbers[0],AbortSignal.timeout(30000));
      this.guard(s);
      if(bytes.length>MAX_MATERIAL_BYTES)throw new Error('远端材料过大，未预览。');
      const preview=await this.generateFilePreview(name,bytes);
      this.guard(s);
      return preview;
    }
    // Only an unqualified request may choose a default. Explicit identities
    // must never fall through to another local or remote document.
    for(const role of ['application','reply','baseline'] as const){
      if(s.files[role])return previewLocal(role);
    }
    if(s.remote){
      const files=[...s.remote.files,...(s.remote.form?.File?[s.remote.form.File]:[])];
      const first=files.find(file=>file.FileNo||file.fileNo);
      if(first){
        return this.previewFile(key,id,{fileNo:first.FileNo||first.fileNo});
      }
    }
    return {name:'材料预览',content:'暂无可用内容预览'};
  }
  async submit(key:string,id:string,review?:TransferReview){return this.exclusive(async()=>{
    const s=this.get(key,id);if(s.view.fileDeletion)throw new Error('单份删除结果待核验，不能内部转交。');if(s.view.phase!=='saved')throw new Error('必须先完成文件与表单保存验收。');
    if(review){
      if(review.stepId)s.view.review.stepId=review.stepId;
      if(review.userId)s.view.review.userId=review.userId;
      if(typeof review.remark==='string')s.view.review.remark=review.remark;
      await this.rememberRecipient(s);
    }
    if(!s.view.review.stepId||!s.view.review.userId)throw new Error('请选择服务端返回的下一流程与办理人。');
    if(!s.remote){s.remote=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);this.guard(s);}
    if(!s.remote)throw new Error('未能读取到贝思兰德递交实例。');
    if(!isRemoteTransferSaved(s.remote,s.view.route))throw new Error('服务端递交材料已不完整或发生变化，请重新核对。');
    s.view.phase='uncertain';s.view.submissionAttempted=false;s.view.submissionRetryable=false;s.view.error=undefined;s.view.results.push('内部转交请求准备发送。');await this.persist(s);
    try{const result=await submitRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route,s.remote,s.view.review,()=>this.guard(s),async target=>{s.view.submissionTarget=structuredClone(target);s.view.submissionAttempted=true;s.view.submissionFingerprint=s.remote!.fingerprint;await this.persist(s);});s.view.phase='submitted';s.view.currentNode=result.node;s.view.currentUser=result.user;s.view.at=new Date().toISOString();s.view.results.push(`内部转交已确认：${result.node} · ${result.user}。后续官方递交由接收人办理。`);}catch(e){s.view.error=(e as Error).message;s.view.submissionRetryable=e instanceof BaselandBusinessError&&['busy','prerequisite'].includes(e.kind);}
    await this.persist(s);return this.syncCase(s);
  });}
  async refresh(key:string,id:string){return this.exclusive(async()=>{
    const s=this.sessions.get(id);
    if(!s||s.view.profileKey!==key)throw new Error('本次准备已过期，请重新读取。');
    this.desktop.assertScope({...s.scope,caseId:undefined,processKey:undefined,caseRevision:undefined});
    if(this.desktop.transferCase(s.view.caseId).stage.current.processId!==s.view.processId)throw new Error('案件当前流程已变化，请打开历史记录核对。');
    s.scope=this.desktop.captureScope(key,s.view.caseId);this.guard(s,true);
    if(s.view.phase==='uncertain'&&s.view.submissionAttempted){
      if(!s.view.submissionTarget){
        const step=s.view.steps.find(x=>x.id===s.view.review.stepId),user=step?.users.find(u=>u.id===s.view.review.userId);
        if(step&&user&&s.view.handId){s.view.submissionTarget={handId:s.view.handId,step:{id:step.id,name:step.name},user:{id:user.id,name:user.name}};await this.persist(s);}
      }
      const target=s.view.submissionTarget;
      const hand=await this.desktop.client!.request('/CaseInfo/GetHandInfo',undefined,{caseProcId:s.view.processId});this.guard(s,true);
      if(target&&target.handId===s.view.handId&&matchesNextFlow(hand,target.handId,target.step,target.user)){
        s.view.phase='submitted';s.view.error=undefined;s.view.currentNode=hand.CurrentFlowInfo?.FlowNodeName||target.step.name;s.view.currentUser=hand.CurrentFlowInfo?.FlowUserName||target.user.name;
        s.view.results.push('刷新已确认同一递交实例的原发送目标；未重复发送转交请求。');await this.persist(s);return this.syncCase(s);
      }
      if(!s.view.submissionRetryable){
        s.view.error=String(hand?.HandInfo?.CaseHandId??'')!==s.view.handId?'本次递交实例已变化，不能确认原转交结果。':'原转交目标尚未匹配，请继续核验，不要重复转交。';
        await this.persist(s);return this.syncCase(s);
      }
    }
    const r=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);this.guard(s,true);
    if(s.view.phase==='submitted'&&r&&r.handId===s.view.handId&&r.hand.IsReviewing===true&&s.view.submissionTarget&&!matchesNextFlow(r.hand,r.handId,s.view.submissionTarget.step,s.view.submissionTarget.user)){
      s.view.phase='superseded';
      s.view.results.push('原内部转交已确认；同一递交实例现已返回可办理节点，后续使用新的核对记录，原材料及发送目标保留。');
      await this.persist(s);
      const options=r.steps.flatMap(step=>step.users.map(user=>({step,user})));
      const picked=pickTransferRecipient(options,this.desktop.workspace.settings.lastTransferRecipient);
      const view=rehydrateRemoteSavedView({r,route:s.view.route,key,caseId:s.view.caseId,caseNumber:s.view.caseNumber,caseTitle:s.view.caseTitle,processId:s.view.processId,processName:s.view.processName,sourceMode:s.view.sourceMode,selectedRecipient:picked?{stepId:picked.step.id,userId:picked.user.id}:undefined});
      view.phase=isRemoteTransferSaved(r,s.view.route)?'saved':'draft';
      view.results=[`已核验退回后的当前材料；原转交记录 ${s.view.id} 保留，重新转交仍需手动确认。`];
      const next:Session={...s,view,remote:r,files:{}};
      this.sessions.set(view.id,next);await this.persist(next);return this.syncCase(next);
    }
    if(s.view.fileDeletion){
      const deletion=s.view.fileDeletion;
      if(r&&r.handId===deletion.target.handId){
        s.remote=r;this.assignRemote(s,true);
        const result=remoteFileDeletionResult(r,deletion);
        if(result==='deleted')this.finishFileDeletion(s);
        else if(result==='unchanged'){
          s.view.fileDeletion=undefined;s.view.phase='draft';s.view.revokedByUser=true;s.view.localReviewSaved=true;s.view.error=undefined;
          s.view.results.push('刷新确认远端文件、表单及流程均未改变，未确认删除生效；已返回草稿，若仍需删除请重新确认。未自动重发。');
        }else{s.view.phase='uncertain';s.view.error='单份删除尚不能确认，或其他远端材料/表单也已变化；请在贝思兰德核对后刷新，不可重复删除或转交。';}
      }else{s.view.phase='uncertain';s.view.error='删除请求对应的递交实例已变化，不能确认结果；请在贝思兰德核对。';}
      await this.persist(s);return this.view(s);
    }
    if(s.view.cleanupPending){
      if(r&&r.handId===s.view.handId){
        s.remote=r;this.assignRemote(s,true);
        if(isRemoteTransferCleared(r,s.view.route,s.view.cleanupFileNos)){s.view.cleanupPending=false;s.view.cleanupFileNos=undefined;s.view.phase='draft';s.view.revokedByUser=true;s.view.error=undefined;s.view.results.push('刷新已确认目标文件关联和补正条目清空；本地草稿保留。');}
        else{s.view.phase='uncertain';s.view.error='远端清理尚未全部完成；本地草稿保留，请核对剩余材料。';}
      }else{s.view.phase='uncertain';s.view.error='清理后的递交实例已变化，不能确认清理成功。';}
      await this.persist(s);return this.syncCase(s);
    }
    if(!r||s.view.phase!=='draft'&&r.handId!==s.view.handId){
      s.view.phase='uncertain';s.view.error='本次递交实例已变化，无法确认原方案结果。请在贝思兰德核对。';
    }else{
      s.view.canEditRemote=r.hand.IsReviewing===true;s.view.currentNode=r.hand.CurrentFlowInfo?.FlowNodeName;s.view.currentUser=r.hand.CurrentFlowInfo?.FlowUserName;s.view.existingFileNames=remoteFileNames(r.files);s.view.existingFiles=remoteFiles(r);s.view.steps=r.steps;
      if(s.view.phase==='draft'){
        s.remote=r;
         this.assignRemote(s,true);
         s.view.results.push(s.view.revokedByUser?'已刷新远端材料与流程；维持撤销保存后的草稿编辑状态，本地表单和五书选择保留。':'已刷新远端材料与流程；保留本地表单和五书选择，仍待用户保存核验。');
       }
      else if(s.view.phase==='uncertain'){
        if(s.view.submissionAttempted){
           const step=s.view.submissionTarget?.step,user=s.view.submissionTarget?.user;
          if(step&&user&&matchesNextFlow(r.hand,s.view.handId,step,user)){
            s.view.phase='submitted';s.view.error=undefined;
            s.view.currentNode=r.hand.CurrentFlowInfo?.FlowNodeName||step.name;
            s.view.currentUser=r.hand.CurrentFlowInfo?.FlowUserName||user.name;
            s.view.results.push('刷新已确认同一递交实例的下一内部节点和办理人。');
          }
          else if(s.view.submissionRetryable&&s.view.submissionFingerprint===r.fingerprint&&r.hand.IsReviewing===true){s.remote=r;s.view.phase='saved';s.view.submissionRetryable=false;s.view.error='上次转交返回：'+(s.view.error??'前置条件尚未通过。');s.view.results.push('刷新确认已保存材料与流程未变；请按上方原因完成处理后，再手动转交，无需重新上传。');}
        }else if(r.hand.IsReviewing===true){
          if(isRemoteTransferSaved(r,s.view.route)){
            s.remote=r;s.view.phase='saved';s.view.error=undefined;s.view.results.push('刷新确认服务端文件与表单已保存就绪，可继续选择接收人转交。');
          }else if(!s.view.handId){
            s.remote=r;this.assignRemote(s);s.view.phase='draft';s.view.error=undefined;s.view.results.push('刷新确认递交实例已启动就绪，请继续核对材料与表单。');
          }else{
            s.remote=r;s.view.error=s.view.error||'保存未能全部核验，请重新核对本次方案。';s.view.results.push('刷新核验远端材料尚未完整保存；请重新核对方案。');
          }
        }
      }else if(s.view.phase==='saved'){
        if(r.handId!==s.view.handId||!r.hand.IsReviewing){
          s.view.phase='uncertain';s.view.error='保存后服务端材料或流程已变化，请重新核对。';
        }else{
          s.remote=r;
          s.view.steps=r.steps;
          if(!s.view.review.stepId||!s.view.review.userId){
            const options=r.steps.flatMap(step=>step.users.map(user=>({step,user})));
            const picked=pickTransferRecipient(options,this.desktop.workspace.settings.lastTransferRecipient);
            if(picked){
              if(!s.view.review.stepId)s.view.review.stepId=picked.step.id;
              if(!s.view.review.userId)s.view.review.userId=picked.user.id;
            }
          }
          s.view.results.push('刷新已核对服务端最新材料与流程。');
        }
      }
    }
    await this.persist(s);return this.syncCase(s);
  });}
}
