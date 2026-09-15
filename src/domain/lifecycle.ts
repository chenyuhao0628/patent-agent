import type { Case, RemoteProcess, Submission, Workspace } from './workflow.ts';
import { applyCaseDeadline, mergeRemoteProcess } from './deadlines.ts';
import { outcomeStatement } from './outcome.ts';

export type WorkKind = 'write' | 'reply' | 'correction' | 'review' | 'waiting' | 'external' | 'needs-confirmation';
export type CurrentWork = { kind: WorkKind; roundId?: string; processId?: string; label?: string; remoteStatus?: number; node?: string; party?: string; handler?: string };
export type HistoryRecord = { id: string; title: string; detail: string; text: string };
export const workNames: Record<WorkKind,string> = {write:'专利撰写',reply:'审查意见答复',correction:'补正',review:'独立审查',waiting:'等待后续通知',external:'系统流程', 'needs-confirmation':'当前阶段待核对'};
export const WAITING_OFFICIAL_LABEL = '等待官方处理结果';
export const UNVERIFIED_OFFICIAL_LABEL = '内部流程已结束，官方递交待核验';
export const UNVERIFIED_INTERNAL_LABEL = '内部流程已结束，待核验';
export const INTERNAL_ENDED_WAIT_LABEL = '内部流程已结束，等待后续流程';
export const OFFICIAL_PARTY = '官方';

export function processBusinessKind(name:string):'write'|'reply'|'correction'|undefined {
  if(/^取消提出申请(?:$|[（(\s])/.test(name.trim()))return undefined;
  if(/补正/.test(name))return 'correction';
  if(/复审/.test(name))return 'reply';
  if(/答复|审查意见/.test(name))return 'reply';
  if(/提出申请|撰写/.test(name))return 'write';
  return undefined;
}

export function processSubmission(c:Case):Submission|undefined {
  const id=currentWork(c).processId;
  if(!id)return undefined;
  const p=(c.remote?.processes??[]).find(p=>p.id===id);
  return p?effectiveSubmission(p):undefined;
}
export function effectiveSubmission(p:RemoteProcess):Submission|undefined {
  // Personal-complete (_status/personalStatus=500) is a hint only. Official submission
  // requires send/hand evidence already recorded on p.submission — never invent "sent".
  return p.submission;
}
export function isConfirmedOfficialSubmission(sub?:Submission):boolean {
  return sub?.state==='sent'||sub?.state==='received';
}
export function isAuxiliaryProcess(name:string):boolean {
  return /取得申请号|缴申请费|缴纳申请费|申请费/.test(name);
}
export function isInternallyActiveProcess(p:{status:number;name:string;submission?:Submission}):boolean {
  return p.status>=0&&p.status!==500&&!isConfirmedOfficialSubmission(p.submission)&&!isAuxiliaryProcess(p.name);
}
export function officialStatusLabel(sub:Submission) {
  if(sub.state==='received')return '已收到回执，等待官方处理结果';
  if(sub.state==='sent')return sub.source==='send-status'?'递交成功':'已递交，等待官方处理结果';
  if(sub.state==='failed')return '递交失败';
  if(sub.state==='queued')return '准备递交中';
  if(sub.state==='sending')return '递交中';
  if(sub.state==='draft')return sub.source==='send-status'?'待递交':sub.message==='未递交官方'?'未递交官方':'递交办理中';
  return '官方递交状态未确认';
}

function officialWaitingFields(processId:string,status:number,label?:string):CurrentWork {
  return {kind:'waiting',processId,label:label??WAITING_OFFICIAL_LABEL,remoteStatus:status,node:WAITING_OFFICIAL_LABEL,party:OFFICIAL_PARTY,handler:OFFICIAL_PARTY};
}

function unverifiedInternalEnd(processId:string,status:number,label?:string):CurrentWork {
  return {kind:'needs-confirmation',processId,label:label??UNVERIFIED_OFFICIAL_LABEL,remoteStatus:status,node:'待核验',party:'内部'};
}

// Legacy prototype data is retained; conflicting parallel work is never silently selected.
export function currentWork(c: Case): CurrentWork {
  if (c.current) return c.current;
  const writing = !!c.design?.writing.disclosure;
  const independent = !!c.design?.review && c.design.review.source !== 'writing';
  if ((writing || independent) && c.rounds.length) return {kind:'needs-confirmation'};
  if (writing) return {kind:'write'};
  if (independent) return {kind:'review'};
  const r = c.rounds[0];
  return r ? {kind:r.name.includes('补正')?'correction':'reply',roundId:r.id} : {kind:'waiting'};
}
export function activeRound(c:Case) { return c.rounds.find(r=>r.id===currentWork(c).roundId); }
export function editableCurrent(c:Case) {
  if(c.remoteClosure?.finished)return false;
  const w=currentWork(c),sub=processSubmission(c);
  if(isConfirmedOfficialSubmission(sub)||w.kind==='waiting')return false;
  const p=c.remote?.processes.find(p=>p.id===w.processId);
  return !c.archived && ['write','reply','correction','review'].includes(w.kind) && (w.remoteStatus === undefined || w.remoteStatus===0 || ([200,300,400].includes(w.remoteStatus)&&p?.canEdit===true));
}
export function internalTransferAvailable(c:Case){
  const w=currentWork(c),status=w.remoteStatus??c.remote?.processes.find(p=>p.id===w.processId)?.status;
  return c.source==='baseland'&&!c.archived&&!!w.processId&&['write','reply','correction'].includes(w.kind)&&!isConfirmedOfficialSubmission(processSubmission(c))&&[0,200,300,400].includes(status??-1);
}
function withoutJobs<T extends {job:unknown}>(rounds:T[]):T[] {
  return rounds.map(r=>r.job?{...r,job:null}:r);
}
export function archiveDraftIfProcessChanged(c:Case,nextProcessId:string|undefined,at:string):void {
  if(c.current?.processId&&c.current.processId!==nextProcessId&&c.localDraft?.trim()){
    c.localVersions=[...(c.localVersions??[]),{id:crypto.randomUUID(),text:c.localDraft,at,processId:c.current.processId}];
    c.localDraft='';
    c.sharedDraftHash=undefined;
  }
}
function processWorkKind(name:string):WorkKind {
  return processBusinessKind(name)??'external';
}
function currentRemoteOf(c:Case,w:CurrentWork):RemoteProcess|undefined {
  return w.processId?(c.remote?.processes??[]).find(p=>p.id===w.processId):undefined;
}
export function applyOfficialWaiting(c:Case,processId:string):void {
  if(!c.current||c.current.processId!==processId)return;
  const process=(c.remote?.processes??[]).find(p=>p.id===processId);
  if(!process||!isConfirmedOfficialSubmission(process.submission))return;
  c.current={...c.current,...officialWaitingFields(process.id,process.status,WAITING_OFFICIAL_LABEL)};
  c.rounds=withoutJobs(c.rounds);
  applyCaseDeadline(c);
}
export function workModule(c:Case) { const k=currentWork(c).kind; return k==='correction'?'reply':k; }
export function caseStatus(c:Case) {
  if(c.archived)return '已归档';
  // 官方结论已知时，案件不再停留在"等待官方"之类的过程文案上，直接显示结论本身。
  const statement=outcomeStatement(c);
  if(statement)return statement;
  const w=currentWork(c),r=activeRound(c),sub=processSubmission(c),process=currentRemoteOf(c,w);
  const title=w.label??workNames[w.kind];
  if(c.source==='baseland'&&process&&!['queued','sending','failed'].includes(sub?.state??'')){
    if(isConfirmedOfficialSubmission(sub))return '已完成 · 已提交官方';
    if(process.status===0&&!process.handId)return '待处理 · 尚未启动递交';
    // status 500 is handled below via needSendOfficial / unverified paths; handId alone must not elevate it to 递交中 or 已交官方.
    if(process.status!==500&&([200,300,400].includes(process.status)||process.handId))return `递交中 · ${process.currentFlow?.user||'办理人待核对'} · ${process.currentFlow?.name||'节点待核对'}`;
  }
  if(sub&&(sub.state==='queued'||sub.state==='sending'||sub.state==='failed'||sub.state==='sent'||sub.state==='received')){
    if(sub.state==='received')return '已收到回执，等待官方处理结果';
    if(sub.state==='sent')return sub.source==='send-status'?'递交成功，等待回执':officialStatusLabel(sub);
    return officialStatusLabel(sub);
  }
  if(sub?.state==='draft'&&(w.remoteStatus===300||w.remoteStatus===400))return officialStatusLabel(sub);
  if(w.remoteStatus===500 && !isConfirmedOfficialSubmission(sub)){
    const name=w.label&&w.label!==WAITING_OFFICIAL_LABEL&&w.label!==UNVERIFIED_OFFICIAL_LABEL&&w.label!==UNVERIFIED_INTERNAL_LABEL&&w.label!==INTERNAL_ENDED_WAIT_LABEL?w.label:undefined;
    if(process?.needSendOfficial===true)return name?`${name} · 官方递交待核验`:UNVERIFIED_OFFICIAL_LABEL;
    if(process?.needSendOfficial===false)return name?`${name} · ${INTERNAL_ENDED_WAIT_LABEL}`:INTERNAL_ENDED_WAIT_LABEL;
    return name?`${name} · 待核验`:UNVERIFIED_INTERNAL_LABEL;
  }
  const flowName=process?.currentFlow?.name;
  if(flowName)return `${title} · ${flowName}`;
  if(w.remoteStatus && w.remoteStatus!==0)return `${title} · ${({200:'审核中',300:'待递交',400:'递交处理中'} as Record<number,string>)[w.remoteStatus]??'以系统记录为准'}`;
  if(w.kind==='waiting'||w.kind==='external'||w.kind==='needs-confirmation')return w.label??workNames[w.kind];
  const step=r ? r.job ? r.job.status==='paused'?'已暂停':'处理中' : {materials:'待核对',strategy:'策略讨论',draft:'起草中',review:'复核中',final:'已定稿，待提交'}[r.stage] : c.design?.writing.finalVersionId?'已定稿，待提交':w.kind==='write'?'撰写中':'待审查';
  if(w.node&&w.node!==title)return `${title} · ${w.node}`;
  return `${title} · ${step}`;
}
function applyProcessStage(next:Case,current:CurrentWork,process:RemoteProcess|undefined):void {
  const hasOtherActive=(next.remote?.processes??[]).some(x=>isInternallyActiveProcess(x)&&x.id!==process?.id);
  if(process&&isConfirmedOfficialSubmission(process.submission)&&!hasOtherActive){
    next.current={...current,...officialWaitingFields(process.id,process.status,WAITING_OFFICIAL_LABEL)};
    next.rounds=withoutJobs(next.rounds);
  }else if(process&&process.status===500&&!isConfirmedOfficialSubmission(process.submission)&&!hasOtherActive){
    if(process.needSendOfficial===false){
      next.current={...current,kind:'waiting',processId:process.id,label:process.name||current.label,remoteStatus:process.status,node:INTERNAL_ENDED_WAIT_LABEL,party:'内部'};
    }else{
      const label=process.needSendOfficial===true?UNVERIFIED_OFFICIAL_LABEL:(process.name||current.label);
      next.current={...current,...unverifiedInternalEnd(process.id,process.status,label)};
    }
    next.rounds=withoutJobs(next.rounds);
  }else{
    next.current=current;
    const roundId=next.current.roundId;
    next.rounds=next.rounds.map(r=>r.id===roundId?r:{...r,job:null});
  }
}

export function normalizeCase(c:Case):Case {
  const next={...c};
  if(next.remote?.processes)next.remote={...next.remote,processes:next.remote.processes.map(p=>({...mergeRemoteProcess(undefined,p),submission:effectiveSubmission(p)}))};
  const current=currentWork(next);
  const processes=next.remote?.processes??[];
  const internallyActive=processes.filter(isInternallyActiveProcess);
  const uniqueActive=internallyActive.length===1?internallyActive[0]:undefined;
  const currentProcess=current.processId?processes.find(p=>p.id===current.processId):undefined;
  const currentIsActive=!!currentProcess&&internallyActive.some(p=>p.id===currentProcess.id);
  if(uniqueActive&&uniqueActive.id!==current.processId){
    const kind=processWorkKind(uniqueActive.name);
    const round=next.rounds.find(r=>r.id==='proc-'+uniqueActive.id);
    archiveDraftIfProcessChanged(next,uniqueActive.id,new Date().toISOString());
    const adopted:CurrentWork={kind,roundId:round?.id,processId:uniqueActive.id,label:uniqueActive.name,remoteStatus:uniqueActive.status};
    applyProcessStage(next,adopted,uniqueActive);
  }else if(internallyActive.length>1&&!currentIsActive){
    next.current={kind:'needs-confirmation',label:'系统存在多个未结束流程，请核对实际当前阶段'};
  }else{
    applyProcessStage(next,current,currentProcess);
  }
  applyCaseDeadline(next);
  return next;
}
export function normalizeWorkspace(w:Workspace):Workspace {
  return {...w,cases:w.cases.map(normalizeCase)};
}
export function currentRoute(c:Case) { const k=workModule(c); return ['write','review','reply'].includes(k)?k:'overview'; }
export function historyRecords(c:Case):HistoryRecord[] {
  const current=currentWork(c),editable=editableCurrent(c);
  const records:HistoryRecord[]=[];
  for(const r of c.rounds){
    if(editable&&r.id===current.roundId)continue;
    const discussion=r.discussions.flatMap(d=>d.messages.map(m=>m.text)).join('\n\n');
    const body=r.final?.text||r.draft||'';
    records.push({id:'round-'+r.id,title:r.name,detail:'历史轮次 · 只读',text:[r.name,body||'该轮次未保存正文',discussion].filter(Boolean).join('\n\n')});
  }
  for(const [i,v] of (c.localVersions??[]).entries()){
    records.push({id:v.id,title:`人工保存版本 ${i+1}`,detail:`${new Date(v.at).toLocaleString('zh-CN')} · 只读`,text:v.text});
  }
  const draft=c.localDraft?.trim();
  if(draft&&!editable){
    const duplicate=(c.localVersions??[]).some(v=>v.text===c.localDraft)||c.rounds.some(r=>r.draft===c.localDraft||r.final?.text===c.localDraft);
    if(!duplicate)records.push({id:'current-draft',title:'当前稿件',detail:'只读',text:c.localDraft!});
  }
  if(c.design?.writing.disclosure&&current.kind!=='write'){
    const text=c.design.writing.documents.map(d=>`${d.title}\n${d.text}`).join('\n\n')||c.design.writing.disclosure;
    records.push({id:'writing',title:'历史撰写内容',detail:'只读',text});
  }
  return records;
}
