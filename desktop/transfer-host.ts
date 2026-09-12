import { currentDraft } from '../src/domain/agent.ts';
import { exportReplyDocx, exportApplicationParts } from './document-export.ts';
import { APPLICATION_PART_LABELS } from '../src/domain/application-parts.ts';
import type { WorkFile } from '../src/professional-api.ts';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesktopService } from './service.ts';
import type { AgentHost } from './agent-host.ts';
import { currentWork, internalTransferAvailable } from '../src/domain/lifecycle.ts';
import { currentHandling } from '../src/domain/handling.ts';
import { FIVE_PARTS } from '../src/transfer-api.ts';
import type { TransferView, TransferFileRole, TransferReview, TransferRoute } from '../src/transfer-api.ts';
import { compareApplication } from './application-diff.ts';
import { inspectZipLimits, MAX_MATERIAL_BYTES } from './agent-document-reader.ts';
import { atomicJSON, digest, managedPath, readJSON, safeName } from './files.ts';
import { defaultTransferForm, existingTransferParts, readRemoteTransfer, remoteFileNames, saveRemoteTransfer, submitRemoteTransfer, validateReview } from './baseland-transfer.ts';
import type { RemoteTransfer } from './baseland-transfer.ts';
type Session={view:TransferView;remote:RemoteTransfer|null;generation:number;root:string;files:Partial<Record<TransferFileRole,{name:string;relativePath:string;hash:string}>>};

export class TransferHost {
  desktop:DesktopService;agent:AgentHost;private sessions=new Map<string,Session>();busy=false;
  private options:{templatesRoot?:string;applicationFile?:(key:string,id:string)=>Promise<WorkFile|undefined>};
  constructor(desktop:DesktopService,agent:AgentHost,options:{templatesRoot?:string;applicationFile?:(key:string,id:string)=>Promise<WorkFile|undefined>}={}){this.desktop=desktop;this.agent=agent;this.options=options;}
  private guard(s:Session){
    this.desktop.assertMigrationNotAccepted();this.desktop.assertKey(s.view.profileKey);
    const c=this.desktop.findCase(s.view.caseId),work=currentWork(c);
    if(this.desktop.generation!==s.generation||this.desktop.workspace.settings.workRoot!==s.root||work.processId!==s.view.processId||currentHandling(c).officialWaiting||!internalTransferAvailable(c))throw new Error('账号、目录或案件当前流程已变化，请重新准备。');
    if(this.desktop.account?.status!=='authenticated'||!this.desktop.client)throw new Error('请先登录贝思兰德。');
  }
  private get(key:string,id:string){const s=this.sessions.get(id);if(!s||s.view.profileKey!==key)throw new Error('本次准备已过期，请重新读取。');this.guard(s);return s;}
  private async persist(s:Session){this.guard(s);await atomicJSON(await this.desktop.casePath(s.view.caseId,`04_内部说明/transfer-${s.view.id}.json`),{schema:1,remoteFingerprint:s.remote?.fingerprint,view:s.view});}
  private view(s:Session){this.guard(s);return structuredClone(s.view);}
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new Error('正在保存或转交，请等待本次操作完成。');this.busy=true;this.desktop.flowFileWrites++;
    try{return await fn();}finally{this.busy=false;this.desktop.flowFileWrites--;}
  }
  async prepare(key:string,caseId:string,ignorePrior=false):Promise<TransferView>{
    this.desktop.assertKey(key);this.desktop.assertMigrationNotAccepted();
    const c=this.desktop.findCase(caseId),work=currentWork(c);
    if(c.source!=='baseland'||!work.processId||!internalTransferAvailable(c)||currentHandling(c).officialWaiting)throw new Error('本案当前没有可内部转交的贝思兰德办理流程。');
    const route:TransferRoute=work.kind==='write'?'application':work.kind==='reply'?'reply':work.kind==='correction'?'correction':(()=>{throw new Error('当前业务不适用申请、答复或补正提交。');})();
    const old=[...this.sessions.values()].filter(s=>s.view.profileKey===key&&s.view.caseId===caseId&&s.view.processId===work.processId&&s.view.phase!=='superseded').sort((a,b)=>b.view.at.localeCompare(a.view.at))[0];
    if(old&&!ignorePrior){this.guard(old);return this.view(old);}
    const id=randomUUID(),s:Session={generation:this.desktop.generation,root:this.desktop.workspace.settings.workRoot??'',remote:null,files:{},view:{id,profileKey:key,caseId,caseNumber:c.number,caseTitle:c.title,processId:work.processId,processName:c.remote?.processes.find(p=>p.id===work.processId)?.name??'',route,files:[],parts:[],review:{keepCodes:[],form:defaultTransferForm(null),stepId:'',userId:'',remark:''},steps:[],phase:'draft',results:[],existingFileNames:[],at:new Date().toISOString()}};
    this.guard(s);
    s.remote=await readRemoteTransfer(this.desktop.client!,work.processId,route);this.guard(s);this.assignRemote(s);
    const journalRoot=await this.desktop.casePath(caseId,'04_内部说明');
    const prior=[];
    for(const entry of await fs.readdir(journalRoot,{withFileTypes:true}).catch(()=>[])){
      if(!entry.isFile()||!/^transfer-[\da-f-]+\.json$/.test(entry.name))continue;
      const data=await readJSON<any>(await managedPath(journalRoot,entry.name),null),v=data?.view;
      if(data?.schema===1&&v?.profileKey===key&&v.caseId===caseId&&v.processId===work.processId&&v.route===route&&typeof v.id==='string'&&entry.name===`transfer-${v.id}.json`&&Array.isArray(v.files)&&Array.isArray(v.steps)&&['draft','saved','uncertain','submitted'].includes(v.phase))prior.push(data);
    }
    prior.sort((a,b)=>b.view.at.localeCompare(a.view.at));
    if(prior.length&&!ignorePrior){
      const previous=prior[0];s.view=previous.view;
      if(s.view.phase==='saved'&&(previous.remoteFingerprint!==s.remote?.fingerprint||s.view.handId!==s.remote?.handId)){s.view.phase='uncertain';s.view.error='应用重开后，服务端数据与保存记录不一致，请先核对当前材料和流程。';}
      for(const f of s.view.files){if(!['application','baseline','reply'].includes(f.role)||!f.relativePath.startsWith(`03_定稿/内部提交准备/${s.view.id}/`)||f.relativePath.includes('..'))throw new Error('内部提交文件记录无效。');s.files[f.role]={...f};}
      this.sessions.set(s.view.id,s);return this.view(s);
    }
    this.sessions.set(id,s);
    // Only one exact ready original is suggested automatically. Ambiguous sources stay unselected.
    const originals=(c.materials??[]).filter(m=>m.ready&&m.relativePath&&/\.docx$/i.test(m.name)&&/原始申请/.test(m.role));
    if(originals.length===1)await this.attach(s,'baseline',await this.desktop.casePath(caseId,originals[0].relativePath!));
    if(route==='application'&&this.options.applicationFile){
      const f=await this.options.applicationFile(key,caseId);this.guard(s);
      if(f){const source=await this.desktop.casePath(caseId,f.relativePath);if(f.hash&&digest(await fs.readFile(source))!==f.hash)throw new Error('撰写完成稿已被外部修改，请手动选择确切版本。');await this.attach(s,'application',source);}
    }
    if(route==='reply'||route==='correction'){
      const agent=await this.agent.getCase(key,caseId);this.guard(s);
      const artifact=agent.artifacts.filter(a=>a.kind==='final-word'&&a.versionId===agent.process.finalized?.draftVersionId).sort((a,b)=>b.at.localeCompare(a.at))[0];
      const draft=currentDraft(agent.process);
      if(route==='correction'&&draft?.adoptStatus==='adopted'&&draft.correctionContents?.length){
        const usedIds=new Set<string>();
        s.view.review.form.corrections=draft.correctionContents.map((row,Sort)=>{
          const saved=s.view.review.form.corrections.find(old=>!usedIds.has(old.ChangeId)&&old.FileName===row.FileName&&old.PositionInFile===row.PositionInFile);
          const ChangeId=saved?.ChangeId||randomUUID();usedIds.add(ChangeId);
          return {...saved,...row,ChangeId,Sort};
        });
        s.view.results.push('已带入当前采用版本的补正字段，请核对文件名称、具体位置、补正前和补正后。');
      }
      if(route==='reply'&&artifact&&artifact.versionId===draft?.id)await this.attach(s,'reply',await this.desktop.casePath(caseId,artifact.relativePath));
      else if(route==='reply'&&draft?.text.trim()&&draft.adoptStatus==='adopted'&&this.options.templatesRoot&&agent.process.classification.status==='classified'&&agent.process.classification.noticeCategory==='审查意见通知书'){
        const bytes=await exportReplyDocx(this.options.templatesRoot,draft.text,agent.process.classification.officeActionRound);this.guard(s);
        const source=await this.desktop.casePath(caseId,`03_定稿/内部提交准备/${id}/意见陈述书-待提交.docx`);await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,bytes,{flag:'wx',mode:0o600});this.guard(s);await this.attach(s,'reply',source);
        s.view.results.push('已按当前采用稿生成意见陈述书待提交副本；个人 AI 审查可选，请核对本次材料。');
      }
      if(draft?.adoptStatus==='adopted'&&draft.applicationParts&&Object.keys(draft.applicationParts).length&&this.options.templatesRoot){
        const bytes=await exportApplicationParts(this.options.templatesRoot,draft.applicationParts);this.guard(s);
        const source=await this.desktop.casePath(caseId,`03_定稿/内部提交准备/${id}/本次修改申请文件.docx`);
        await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,bytes,{flag:'wx',mode:0o600});
        await this.attach(s,'application',source);
        const selected=new Set<string>(Object.keys(draft.applicationParts).map(k=>APPLICATION_PART_LABELS[k as keyof typeof APPLICATION_PART_LABELS]));
        s.view.parts=s.view.parts.map(p=>selected.has(p.name)?{...p,available:true,reason:p.changed===null?'已采用稿明确修改此部分，缺少可比较基线，请人工核对。':p.reason}:{...p,changed:false,available:false,reason:'本次采用稿未修改此部分，不加入递交材料。'});
        s.view.review.keepCodes=s.view.parts.filter(p=>p.available&&p.changed!==false).map(p=>p.code);
        s.view.results.push('已带入采用版本的完整修改部分并预选递交清单；请核对五书选择和补正表单，本地完整稿及历史保留。');
      }
    }
    await this.persist(s);return this.view(s);
  }
  private assignRemote(s:Session){
    const r=s.remote;s.view.handId=r?.handId;s.view.currentNode=r?.hand.CurrentFlowInfo?.FlowNodeName;s.view.currentUser=r?.hand.CurrentFlowInfo?.FlowUserName;s.view.steps=r?.steps??[];s.view.existingFileNames=remoteFileNames(r?.files??[]);
    s.view.canEditRemote=r? r.hand.IsReviewing===true:undefined;
    s.view.review.form=defaultTransferForm(r);
    if(!s.files.application){s.view.parts=existingTransferParts(r);s.view.review.keepCodes=s.view.parts.filter(p=>p.available).map(p=>p.code);}
    const options=s.view.steps.flatMap(step=>step.users.map(user=>({step,user})));
    const named=options.filter(o=>o.user.name==='杨佳'),picked=named.length===1?named[0]:options.length===1?options[0]:undefined;
    s.view.review.stepId=picked?.step.id??'';s.view.review.userId=picked?.user.id??'';
  }
  private async attach(s:Session,role:TransferFileRole,source:string){
    this.guard(s);if(role==='reply'&&s.view.route!=='reply')throw new Error('本业务通过表单字段保存补正内容，不能上传意见或补正说明文件。');if(s.view.phase!=='draft')throw new Error('已保存的提交方案不能直接改文件，请完成当前结果核对。');
    const stat=await fs.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_MATERIAL_BYTES||!source.toLowerCase().endsWith('.docx'))throw new Error('请选择不超过 20 MB 的 DOCX 普通文件。');
    const bytes=await fs.readFile(source);inspectZipLimits(bytes);this.guard(s);
    const hash=digest(bytes),name=safeName(path.basename(source),90),relativePath=`03_定稿/内部提交准备/${s.view.id}/${role}-${hash.slice(0,12)}-${name}`;
    const target=await this.desktop.casePath(s.view.caseId,relativePath);await fs.mkdir(path.dirname(target),{recursive:true});
    try{await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||digest(await fs.readFile(target))!==hash)throw e;}
    this.guard(s);s.files[role]={name,relativePath,hash};
    s.view.files=Object.entries(s.files).map(([role,f])=>({role:role as TransferFileRole,...f!}));
    if(role==='reply')return;
    const before=await this.bytes(s,'baseline'),after=await this.bytes(s,'application');
    if(!after)return;
    s.view.parts=await compareApplication(before?.bytes,after.bytes);
    s.view.review.keepCodes=after?(s.view.route==='application'?FIVE_PARTS.map(p=>p.code):s.view.parts.filter(p=>p.changed).map(p=>p.code)):[];
    if(s.view.route==='correction'&&!s.view.review.form.corrections.length)s.view.review.form.corrections=s.view.parts.filter(p=>p.changed&&p.before&&p.after).map((p,i)=>({ChangeId:randomUUID(),Sort:i,FileName:p.name,PositionInFile:'本次修改段落（请核对具体位置）',CorrectionBefore:p.before!,CorrectionAfter:p.after!}));
  }
  private async bytes(s:Session,role:TransferFileRole){const f=s.files[role];if(!f)return;this.guard(s);const target=await this.desktop.casePath(s.view.caseId,f.relativePath);const st=await fs.lstat(target);if(st.isSymbolicLink()||!st.isFile()||st.size>MAX_MATERIAL_BYTES)throw new Error('本次文件副本不可用。');const bytes=await fs.readFile(target);if(digest(bytes)!==f.hash)throw new Error('本次文件副本已经变化，请重新选择核对。');return {name:f.name,bytes};}
  async addFile(key:string,id:string,role:TransferFileRole,source:string){return this.exclusive(async()=>{if(!['baseline','application','reply'].includes(role))throw new Error('文件用途无效。');const s=this.get(key,id);await this.attach(s,role,source);await this.persist(s);return this.view(s);});}
  async reprepare(key:string,id:string){return this.exclusive(async()=>{
    const old=this.get(key,id);if(old.view.phase==='submitted')throw new Error('已确认内部转交，不能重复准备同一提交。');
    const fresh=await readRemoteTransfer(this.desktop.client!,old.view.processId,old.view.route);this.guard(old);
    const target=old.view.steps.find(s=>s.id===old.view.review.stepId),user=target?.users.find(u=>u.id===old.view.review.userId);
    if(target?.name&&user?.name&&fresh?.hand.CurrentFlowInfo?.FlowNodeName===target.name&&fresh?.hand.CurrentFlowInfo?.FlowUserName===user.name)throw new Error('已到达原方案的下一办理人，请刷新核对，不能重新提交。');
    old.view.phase='superseded';old.view.results.push('用户选择重新核对；原方案及结果保留，本方案不可再次执行。');await this.persist(old);
    const view=await this.prepare(key,old.view.caseId,true),s=this.get(key,view.id);
    for(const role of ['baseline','application','reply'] as const){const f=old.files[role];if(f)await this.attach(s,role,await this.desktop.casePath(old.view.caseId,f.relativePath));}
    await this.persist(s);return this.view(s);
  });}
  async startHand(key:string,id:string){return this.exclusive(async()=>{const s=this.get(key,id);if(s.remote)return this.view(s);const c=this.desktop.findCase(s.view.caseId),proc=c.remote?.processes.find(p=>p.id===s.view.processId);if(proc?.status!==0)throw new Error('只有待办流程可以在此启动递交实例。');await this.desktop.client!.request('/CaseInfo/StartHand',undefined,{caseProcId:s.view.processId});this.guard(s);s.remote=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);if(!s.remote)throw new Error('未取得新递交实例，请在贝思兰德核对。');this.assignRemote(s);await this.persist(s);return this.view(s);});}
  async save(key:string,id:string,review:TransferReview){return this.exclusive(async()=>{
    const s=this.get(key,id);if(s.view.phase!=='draft'||!s.remote)throw new Error('本次方案不能重复保存，请先核对当前状态。');
    s.view.review=structuredClone(review);s.view.error=undefined;
    const application=await this.bytes(s,'application'),reply=await this.bytes(s,'reply');
    validateReview(s.view.route,s.remote,review,!!application,!!reply);
    let wrote=false;
    // Persist intent before the first remote write. An interrupted attempt never looks unsent.
    s.view.phase='uncertain';s.view.results.push('正在保存本次文件与业务表单；中断后需回读核对。');await this.persist(s);
    try{s.remote=await saveRemoteTransfer({client:this.desktop.client!,processId:s.view.processId,caseTitle:s.view.caseTitle,route:s.view.route,remote:s.remote,review:s.view.review,application,reply,guard:()=>this.guard(s),onWrite:()=>{wrote=true;},checkpoint:async message=>{s.view.results.push(message);await this.persist(s);}});s.view.phase='saved';s.view.existingFileNames=remoteFileNames(s.remote.files);s.view.results.push('可以核对接收人并执行内部转交。');}
    catch(e){if(!wrote)s.view.phase='draft';s.view.error=(e as Error).message;s.view.results.push('保存未能全部核验，尚未转交。');}
    await this.persist(s);return this.view(s);
  });}
  async submit(key:string,id:string){return this.exclusive(async()=>{
    const s=this.get(key,id);if(s.view.phase!=='saved'||!s.remote)throw new Error('必须先完成文件与表单保存验收。');
    s.view.phase='uncertain';s.view.error=undefined;s.view.results.push('内部转交请求准备发送。');await this.persist(s);
    try{const result=await submitRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route,s.remote,s.view.review,()=>this.guard(s));s.view.phase='submitted';s.view.currentNode=result.node;s.view.currentUser=result.user;s.view.results.push(`内部转交已确认：${result.node} · ${result.user}。后续官方递交由接收人办理。`);}catch(e){s.view.error=(e as Error).message;}
    await this.persist(s);return this.view(s);
  });}
  async refresh(key:string,id:string){return this.exclusive(async()=>{
    const s=this.get(key,id),r=await readRemoteTransfer(this.desktop.client!,s.view.processId,s.view.route);this.guard(s);
    if(!r||s.view.phase!=='draft'&&r.handId!==s.view.handId){
      s.view.phase='uncertain';s.view.error='本次递交实例已变化，无法确认原方案结果。请在贝思兰德核对。';
    }else{
      s.view.canEditRemote=r.hand.IsReviewing===true;s.view.currentNode=r.hand.CurrentFlowInfo?.FlowNodeName;s.view.currentUser=r.hand.CurrentFlowInfo?.FlowUserName;s.view.existingFileNames=remoteFileNames(r.files);
      if(s.view.phase==='draft'){s.remote=r;this.assignRemote(s);}
      else if(s.view.phase==='uncertain'){
        const step=s.view.steps.find(x=>x.id===s.view.review.stepId),user=step?.users.find(u=>u.id===s.view.review.userId);
        if(step?.name&&user?.name&&step.name===s.view.currentNode&&user.name===s.view.currentUser){s.view.phase='submitted';s.view.error=undefined;s.view.results.push('刷新已确认同一递交实例的下一内部节点和办理人。');}
      }else if(s.view.phase==='saved'&&r.fingerprint!==s.remote?.fingerprint){s.view.phase='uncertain';s.view.error='保存后服务端材料或流程已变化，请重新核对。';}
    }
    await this.persist(s);return this.view(s);
  });}
}
