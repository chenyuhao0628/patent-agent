import type { Account, FlowNode } from '../src/desktop.ts';
import type { Case, RemoteProcess, Submission, SubmissionState } from '../src/domain/workflow.ts';
import { makeRound } from '../src/domain/workflow.ts';
import { applyCaseDeadline, calendarDate, mergeRemoteProcess } from '../src/domain/deadlines.ts';
import { applyOfficialWaiting, archiveDraftIfProcessChanged, INTERNAL_ENDED_WAIT_LABEL, isAuxiliaryProcess, isConfirmedOfficialSubmission, isInternallyActiveProcess, processBusinessKind, UNVERIFIED_OFFICIAL_LABEL } from '../src/domain/lifecycle.ts';
import { stampCurrentHandling } from '../src/domain/handling.ts';
import { digest } from './files.ts';
export { isAuxiliaryProcess, isInternallyActiveProcess };

type Obj=Record<string,any>;
export const API='https://cloudapi02.baselandtec.com/v1';
const clean=(s:unknown)=>typeof s==='string'?s:typeof s==='number'?String(s):'';
const listOf=(data:any):Obj[]|undefined=>Array.isArray(data)?data:data?.List??data?.Rows??data?.DataList??data?.ListData??data?.PageData??data?.Items;
const SEND_STATUS:Record<number,SubmissionState>={0:'draft',1:'queued',2:'sent',3:'failed',6:'received',100:'sending'};
const SEND_LABEL:Record<SubmissionState,string>={unknown:'官方递交状态未确认',draft:'待递交',queued:'准备递交中',sending:'递交中',sent:'递交成功',received:'已收到回执',failed:'递交失败'};
export const KNOWN_SEND_STATUS=[{label:'待递交',value:0},{label:'准备递交中',value:1},{label:'递交成功',value:2},{label:'递交失败',value:3},{label:'已收到回执',value:6},{label:'递交中',value:100}] as const;
export const SUBMISSION_REFRESH_ERROR='未能刷新官方递交状态，仍显示上次确认结果。';

export const officialDate=calendarDate;
export function mainProcessKind(name:string){return processBusinessKind(name);}
export function flag(value:unknown):boolean {
  return value===true||value===1||value==='true'||value==='True'||value==='1';
}
export function boolTri(value:unknown):boolean|undefined {
  if(value===true||value===1||value==='true'||value==='True'||value==='1')return true;
  if(value===false||value===0||value==='false'||value==='False'||value==='0')return false;
  return undefined;
}
export function sendStatusState(value:unknown):SubmissionState|undefined {
  if(value==null)return undefined;
  if(typeof value==='object'&&!Array.isArray(value)){
    if(!('SendStatus' in (value as Obj)))return undefined;
    return sendStatusState((value as Obj).SendStatus);
  }
  if(typeof value==='boolean')return undefined;
  if(typeof value==='string'){
    const t=value.trim();
    if(!t||!/^-?\d+$/.test(t))return undefined;
    return SEND_STATUS[Number(t)];
  }
  if(typeof value==='number'){
    if(!Number.isInteger(value))return undefined;
    return SEND_STATUS[value];
  }
  return undefined;
}
export function combineOfficialSubmission(flagValue:boolean|undefined,send:unknown,checkedAt:string):Submission {
  const sendState=sendStatusState(send);
  if(flagValue===true){
    if(sendState==='received')return {state:'received',source:'send-status',checkedAt,message:SEND_LABEL.received};
    return {state:'sent',source:'hand',checkedAt,message:'已递交，等待官方处理'};
  }
  if(sendState)return {state:sendState,source:'send-status',checkedAt,message:SEND_LABEL[sendState]};
  if(flagValue===false)return {state:'draft',source:'hand',checkedAt,message:'未递交官方'};
  return {state:'unknown',checkedAt,message:'官方递交状态未确认'};
}
function existsHandFromRow(r?:Obj) {
  if(!r||typeof r!=='object')return false;
  const op=r.CaseProcOperateInfo;
  return op?.IsExistsHand===true||op?.IsExistsNoFinishHand===true;
}
export function shouldQueryOfficial(p:RemoteProcess,row?:Obj) {
  if(!p.id)return false;
  if(p.handId||existsHandFromRow(row))return true;
  if(p.status===200||p.status===300||p.status===400)return true;
  if(p.status===500&&mainProcessKind(p.name))return true;
  return false;
}
function rowStamp(r?:Obj) {
  if(!r)return '';
  return clean(r.CaseProcFinishDate||r.FinishDate||r.ProcCreateDate||r.CaseProcCreateDate||r.CreateDate);
}
export function selectCurrentProcess(processes:RemoteProcess[],rows:Obj[]=[],preferredId?:string,personalIds?:string[]):RemoteProcess|undefined {
  const scoped=personalIds?processes.filter(p=>personalIds.includes(p.id)):processes;
  const byId=new Map(rows.map(r=>[clean(r.CaseProcId),r]));
  const stamp=(p:RemoteProcess)=>rowStamp(byId.get(p.id));
  const latest=(list:RemoteProcess[])=>{
    if(list.length===0)return undefined;
    if(list.length===1)return list[0];
    const dated=list.map(p=>({p,t:stamp(p)}));
    const known=dated.filter(d=>d.t);
    if(known.length===0)return preferredId?list.find(p=>p.id===preferredId):undefined;
    if(known.length!==list.length)return preferredId?list.find(p=>p.id===preferredId):undefined;
    known.sort((a,b)=>a.t.localeCompare(b.t));
    const last=known[known.length-1];
    const tied=known.filter(d=>d.t===last.t);
    if(tied.length===1)return last.p;
    return preferredId?tied.find(d=>d.p.id===preferredId)?.p:undefined;
  };
  const internallyActive=scoped.filter(isInternallyActiveProcess);
  if(internallyActive.length===1)return internallyActive[0];
  if(internallyActive.length>1)return undefined;
  const finishedMain=scoped.filter(p=>{
    if(p.status!==500||!mainProcessKind(p.name)||isAuxiliaryProcess(p.name))return false;
    return !!p.handId||existsHandFromRow(byId.get(p.id));
  });
  const completed=latest(finishedMain);
  if(completed)return completed;
  if(preferredId){
    const pref=scoped.find(p=>p.id===preferredId);
    if(pref&&!isAuxiliaryProcess(pref.name))return pref;
  }
  return undefined;
}

function loginFailure(result:unknown) {
  const reason=clean(result).toLowerCase();
  if(/licenseexpired|license|授权.*过期/.test(reason))return new Error('贝思兰德系统授权已过期，请联系机构管理员处理。');
  if(/lock|disabled|禁用|锁定/.test(reason))return new Error('贝思兰德账号已锁定或停用，请联系机构管理员。');
  if(/password|username|credential|用户名|密码|账号|usernotfound/.test(reason))return new Error('贝思兰德未通过账号验证，请核对系统地址、账号和密码。');
  return new Error('贝思兰德未通过登录验证。请先在机构的贝思兰德网页登录，确认账号与系统授权状态。');
}
export function processRow(r:Obj,previous?:RemoteProcess):RemoteProcess {
  const raw=r._status??r.ProcStatusCode??r.StatusCode??previous?.status;
  const status=typeof raw==='number'&&Number.isFinite(raw)?raw:Number(raw);
  const incoming:RemoteProcess={
    id:clean(r.CaseProcId),
    name:clean(r.CaseProcName??r.CaseProcNameInfo?.CaseProcName),
    ...(r.CaseProcNameInfo?.ProcCode != null ? {procCode:clean(r.CaseProcNameInfo.ProcCode)} : r.ProcCode != null ? {procCode:clean(r.ProcCode)} : {}),
    ...Object.fromEntries([['FlowRemark','flowRemark'],['CaseProcOfficeNote','officeNote'],['CaseProcProcNote','procNote']].filter(([field])=>field in r).map(([field,key])=>[key,clean(r[field])])),
    status:Number.isFinite(status)?status:-1,
    node:clean(r.CaseProcCurrentFlowName??r.CaseProcCurrentStatus??r.CurrentFlowNodeName),
    undertaker:clean(r.CaseProcUndertakerUserName),
    deadline:'',
    baselandDeadline:officialDate(r.CaseProcLegalDate)||undefined,
    internalDeadline:officialDate(r.CaseProcCustomDate)||undefined,
    handId:clean(r.CaseHandId)||previous?.handId||undefined,
    submission:previous?.submission,
  };
  return mergeRemoteProcess(previous,incoming);
}
export function mapCurrentFlow(raw:unknown) {
  if(raw==null||typeof raw!=='object')return undefined;
  const o=raw as Obj,name=clean(o.FlowNodeName);
  if(!name)return undefined;
  const serial=Number(o.SerialNumber),total=Number(o.TotalStepNumber);
  return {name,user:clean(o.FlowUserName),serial:Number.isFinite(serial)?serial:undefined,total:Number.isFinite(total)?total:undefined};
}
export function mapFlowNodes(records:Obj[],currentFlow?:{name:string;user:string;serial?:number;total?:number}):FlowNode[] {
  const sorted=[...records].sort((a,b)=>{
    const sa=Number(a.Sort),sb=Number(b.Sort),fa=Number.isFinite(sa),fb=Number.isFinite(sb);
    if(fa&&fb&&sa!==sb)return sa-sb;
    if(fa&&!fb)return -1;
    if(!fa&&fb)return 1;
    return 0;
  });
  const mapped=sorted.map(r=>{
    const finished=flag(r.IsFinish)||flag(r.IsFinished);
    const sort=Number(r.Sort),serial=Number(r.SerialNumber),total=Number(r.TotalStepNumber);
    return {name:clean(r.FlowStepName),user:clean(r.FlowUserName),finished,marked:flag(r.IsCurrentFlowNode),runningRaw:flag(r.IsRunning),sort:Number.isFinite(sort)?sort:undefined,type:clean(r.FlowTypeName)||undefined,start:clean(r.StartDate),end:clean(r.EndTDate),stayHours:typeof r.StayHours==='number'?r.StayHours:undefined,serial:Number.isFinite(serial)?serial:undefined,total:Number.isFinite(total)?total:undefined};
  });
  let currentIndex=-1;
  if(currentFlow?.name){
    const matches=mapped.map((n,i)=>({n,i})).filter(x=>x.n.name===currentFlow.name&&!x.n.finished);
    if(matches.length===1)currentIndex=matches[0].i;
    else if(matches.length>1){
      const serial=currentFlow.serial;
      const keyed=serial==null?[]:matches.filter(x=>x.n.serial===serial||x.n.sort===serial);
      if(keyed.length===1)currentIndex=keyed[0].i;
      else if(matches.filter(x=>x.n.marked).length===1)currentIndex=matches.filter(x=>x.n.marked)[0].i;
    }
  }
  if(currentIndex<0){
    const marked=mapped.map((n,i)=>({n,i})).filter(x=>x.n.marked&&!x.n.finished);
    if(marked.length===1)currentIndex=marked[0].i;
  }
  return mapped.map((n,i)=>{
    const isCurrent=i===currentIndex&&!n.finished;
    const running=!n.finished&&(n.runningRaw||isCurrent);
    return {name:n.name,user:isCurrent&&currentFlow?.user?currentFlow.user:n.user,running:n.finished?false:running,finished:n.finished,isCurrent:n.finished?false:isCurrent,sort:n.sort,type:n.type,start:n.start,end:n.end,stayHours:n.stayHours,serial:isCurrent&&currentFlow?.serial!==undefined?currentFlow.serial:n.serial,total:currentFlow?.total??n.total};
  });
}
export function withOfficialWait(nodes:FlowNode[],sub:Submission):FlowNode[] {
  if(sub.state!=='sent'&&sub.state!=='received')return nodes;
  const historical=nodes.map(n=>({...n,running:false,isCurrent:false}));
  const waiting:FlowNode={name:'等待官方处理结果',user:'官方',running:true,finished:false,isCurrent:true,type:'official',start:'',end:''};
  if(sub.state==='received'){
    return [...historical,{name:'已收到回执',user:'',running:false,finished:true,isCurrent:false,type:'receipt',start:'',end:''},waiting];
  }
  return [...historical,waiting];
}
export function validOrigin(input:string) {
  const url=new URL(input);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.baselandtec.com')||url.username||url.password||url.port)throw new Error('请输入 https://机构名.baselandtec.com 格式的贝思兰德系统地址。');
  return url.origin;
}
export const profileKey=(origin:string,username:string)=>digest(origin+'\n'+username.trim().toLowerCase()).slice(0,24);
export class BaselandClient {
  origin:string; token:string; fetcher:typeof fetch;
  constructor(origin:string,token='',fetcher=fetch){this.origin=validOrigin(origin);this.token=token;this.fetcher=fetcher;}
  async uploadDocument(name:string,bytes:Buffer,signal?:AbortSignal):Promise<string>{
    const form=new FormData();form.set('file',new Blob([Uint8Array.from(bytes)],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name);
    const response=await this.fetcher(API+'/NoPermissionRequired/FileStorageUploadFile?1=1',{method:'POST',headers:{Origin:this.origin,Referer:this.origin+'/login.html',Language:'zh-CN',Authorization:this.token},body:form,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
    if(!response.ok)throw new Error(`文件上传未完成（HTTP ${response.status}）。`);
    const data=await response.json() as Obj;
    if(data.IsSuccess!==true||typeof data.Data?.FileNo!=='string'||!data.Data.FileNo)throw new Error('贝思兰德未返回上传文件编号。');
    return data.Data.FileNo;
  }
  async request(endpoint:string,body?:unknown,params?:Record<string,string>,signal?:AbortSignal,kind:'data'|'list'='data') {
    const url=new URL(API+endpoint);for(const [k,v] of Object.entries(params??{}))url.searchParams.set(k,v);
    let response:Response;
    try{response=await this.fetcher(url,{method:body?'POST':'GET',headers:{Origin:this.origin,Referer:this.origin+'/login.html',Language:'zh-CN','Content-Type':'application/json',...(this.token?{Authorization:this.token}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}catch{throw new Error(signal?.aborted?'操作已停止。':'无法连接贝思兰德，请检查网络后重试。');}
    if(response.status===401||response.status===403)throw new Error('登录已失效或账号无权限，请重新登录。');
    if(!response.ok)throw new Error(`贝思兰德请求失败（HTTP ${response.status}）。`);
    const data=await response.json() as Obj;
    if(data.IsSuccess!==true){if(endpoint==='/Auth/GetToken')throw loginFailure(data.Message);throw new Error(/权限/.test(data.Message??'')?'当前账号无权访问该数据。':/登录|Token|token|认证|过期/.test(data.Message??'')?'登录已失效，请重新登录。':'贝思兰德未确认请求成功，请核对账号或稍后重试。');}
    // Login/detail objects must never be replaced by a default empty DataList.
    return kind==='list'?(data.DataList??data.ListData??data.Data):data.Data;
  }
  async identity(username:string):Promise<Account> {
    const raw=await this.request('/Auth/GetLoginInfo',undefined,{checkVersion:'false',isLogin:'true'});
    const data=(raw??{}) as Obj;let user:Obj=data.UserInfo??data.TenantUserInfo??data.User??data;
    try{const more=await this.request('/TenantUser/GetCurrentUserInfo');if(more&&typeof more==='object')user={...user,...more};}catch{/* Optional profile details; GetLoginInfo already verified the session. */}
    return {username,displayName:clean(user.RealName??user.UserRealName??user.Name??user.UserName)||username,organization:clean(data.TenantName??data.TenantInfo?.TenantName??user.TenantName),origin:this.origin,userId:clean(user.UserId??user.TenantUserId??user.Id),status:'authenticated',remembered:false};
  }
  async login(username:string,password:string) {
    const data=await this.request('/Auth/GetToken',{UserName:username.trim(),Password:password.trim()});
    if(data?.IsSuccess===false)throw loginFailure(data.ResultString??data.Message);
    if(typeof data?.Token!=='string'||!data.Token.trim())throw new Error('贝思兰德登录响应格式未识别，尚未取得有效登录。请在机构网页确认能否正常登录。');
    this.token=data.Token;return this.identity(username);
  }
  async personalCases(signal:AbortSignal) {
    const rows:Obj[]=[];
    for(const [name,table,status] of [['waitHand',50010,0],['auditing',50011,200],['waitDeliver',50012,300],['delivering',50013,400],['finish',50014,500]] as const){
      for(let page=1;page<=500;page++){
        const data=await this.request('/CaseInfo/GetPersonalCase',{PagedInfo:{pageIndex:page,pageSize:100},ProcStatusTypeList:[status],TableType:table,ActiveName:name,SelectedProcIdGroup:[]},undefined,signal,'list');
        const list=listOf(data);
        if(!Array.isArray(list))throw new Error('个人案件列表结构尚未识别，本次未写入案件。');
        rows.push(...list.map((r:Obj)=>({...r,_status:status})));
        const total=Number(data?.Total??data?.TotalCount??data?.RecordCount);
        if(list.length<100||Number.isFinite(total)&&page*100>=total)break;
        if(page===500)throw new Error('案件分页达到保护上限，本次未标为同步完成。');
      }
    }
    return rows;
  }
  async files(processId:string,signal:AbortSignal) {const data=listOf(await this.request('/CaseInfo/GetCaseProcFileList',undefined,{caseProcId:processId},signal,'list'));if(!Array.isArray(data))throw new Error('文件列表结构尚未识别。');return data;}
  async download(fileNo:string,signal:AbortSignal) {
    const url=new URL(API+'/NoPermissionRequired/FileStorageGetFile');url.searchParams.set('fileNo',fileNo);url.searchParams.set('forBlob','true');
    const r=await this.fetcher(url,{headers:{Authorization:this.token,Origin:this.origin,Language:'zh-CN'},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
    if(!r.ok)throw new Error(`附件下载失败（HTTP ${r.status}）。`);
    const max=100*1024*1024;if(Number(r.headers.get('content-length'))>max)throw new Error('附件超过 100MB，请单独处理。');
    if(!r.body)throw new Error('附件内容为空。');
    const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new Error('附件超过 100MB，请单独处理。');}chunks.push(value);}
    return Buffer.concat(chunks);
  }
  async sendStatusViewTypes(signal?:AbortSignal) {
    const data=listOf(await this.request('/SystemTypeSetting/GetCaseHandSendStatusViewTypeList',undefined,undefined,signal,'list'));
    if(!Array.isArray(data))throw new Error('递交状态字典结构尚未识别。');
    return data.map(row=>{
      const label=clean(row.label??row.Label??row.Name);
      const raw=row.value??row.Value??row.Code;
      const value=typeof raw==='number'?raw:Number(raw);
      if(!label||!Number.isInteger(value))throw new Error('递交状态字典结构尚未识别。');
      return {label,value,state:SEND_STATUS[value] as SubmissionState|undefined};
    });
  }
  async queryOfficial(processId:string,handId?:string,signal?:AbortSignal,previous?:Submission):Promise<{submission:Submission;handId?:string;currentFlow?:{name:string;user:string;serial?:number;total?:number};needSendOfficial?:boolean;ok:boolean}> {
    const checkedAt=new Date().toISOString();
    try{
      const data=await this.request('/CaseInfo/GetHandInfo',undefined,{caseProcId:processId},signal);
      const obj=data&&typeof data==='object'?data as Obj:null;
      const info=obj?.HandInfo&&typeof obj.HandInfo==='object'?obj.HandInfo as Obj:{};
      const id=clean(info.CaseHandId||obj?.CaseHandId)||handId||undefined;
      const currentFlow=mapCurrentFlow(obj?.CurrentFlowInfo);
      const needSendOfficial=obj?boolTri(obj.IsNeedSendToOfficail):undefined;
      const primary=obj?boolTri(obj.IsPackageSendSuccess):undefined;
      let send:unknown=undefined,sendFailed=false;
      if(id){
        try{send=await this.request('/CaseInfo/GetCaseHandSendInfo',undefined,{caseHandId:id},signal);}
        catch(e){
          if(signal?.aborted)throw e;
          sendFailed=true;
        }
      }
      if(sendFailed&&previous&&(previous.state==='sent'||previous.state==='received')){
        return {submission:{...previous,refreshError:SUBMISSION_REFRESH_ERROR},handId:id,currentFlow,needSendOfficial,ok:true};
      }
      return {submission:combineOfficialSubmission(primary,sendFailed?undefined:send,checkedAt),handId:id,currentFlow,needSendOfficial,ok:true};
    }catch(e){
      if(signal?.aborted)throw e;
      return {submission:{state:'unknown',checkedAt,message:'未能确认官方递交状态，请稍后重试。'},handId,ok:false};
    }
  }
  async caseClosure(c:Case,signal?:AbortSignal) {
    if(!c.remote)throw new Error('案件未关联贝思兰德。');
    const data=await this.request('/CaseInfo/GetUpdateCaseInfo',undefined,{caseId:c.remote.caseId},signal);
    const info=data?.CaseInfo;
    if(!info||typeof info!=='object'||info.CaseId&&clean(info.CaseId)!==c.remote.caseId)throw new Error('案件结案信息与当前案件不匹配。');
    const finished=boolTri(info.IsFinishCase);
    return finished===undefined?undefined:{finished,checkedAt:new Date().toISOString()};
  }
  async caseInfo(c:Case,signal?:AbortSignal) {
    if (!c.remote) throw new Error('本地案件尚未关联贝思兰德。');
    const processId = c.current?.processId;
    const [caseData, processData] = await Promise.all([
      this.request('/CaseInfo/GetUpdateCaseInfo',undefined,{caseId:c.remote.caseId},signal),
      processId ? this.request('/CaseInfo/GetCaseProcById',undefined,{caseProcId:processId},signal) : undefined,
    ]);
    const info = caseData?.CaseInfo;
    const process = processData?.CaseProc;
    if (!info || typeof info !== 'object') throw new Error('案件信息结构未识别，已保留上次备注。');
    if (info.CaseId && clean(info.CaseId) !== c.remote.caseId) throw new Error('案件信息与当前案件不一致。');
    if (process?.CaseProcId && clean(process.CaseProcId) !== processId) throw new Error('流程备注与当前流程不一致。');
    const result:{closure?:{finished:boolean;checkedAt:string};caseRemark?:string;processId?:string;process?:Partial<RemoteProcess>;at:string} = {at:new Date().toISOString(),processId};
    const finished=boolTri(info.IsFinishCase);if(finished!==undefined)result.closure={finished,checkedAt:result.at};
    if ('Remark' in info) result.caseRemark = clean(info.Remark);
    if (process && typeof process === 'object') {
      result.process = Object.fromEntries([['FlowRemark','flowRemark'],['OfficeNote','officeNote'],['ProcNote','procNote']].filter(([field])=>field in process).map(([field,key])=>[key,clean(process[field])]));
    }
    return result;
  }
  async flow(c:Case,signal?:AbortSignal) {
    if(!c.remote)throw new Error('本地案件尚未关联贝思兰德。');
    const detail=listOf(await this.request('/CaseInfo/GetCaseDetailProcList',{caseId:c.remote.caseId,TableType:80001,SortInfo:{},UserTableTitleColumnList:['CaseProcName','CaseProcCustomDate','CaseProcLegalDate','CaseProcFinishDate','CaseProcUndertakerUserName','CaseProcCurrentStatus','CaseProcCurrentFlowName']},undefined,signal,'list'));
    if(!Array.isArray(detail)||detail.some(r=>!r.CaseProcId))throw new Error('最新流程明细结构尚未识别，请稍后重试。');
    const processes=detail.map(r=>processRow(r,c.remote!.processes.find(p=>p.id===String(r.CaseProcId))));
    const personalIds=c.remote.processes.map(p=>p.id);
    const selected=c.current?.kind==='external'&&!c.current.processId?undefined:selectCurrentProcess(processes,detail,c.current?.processId,personalIds);
    let records:Obj[]=[];
    if(selected){
      const data=listOf(await this.request('/CaseMonitor/GetProcFlowRecord',undefined,{caseProcId:selected.id},signal,'list'));
      if(!Array.isArray(data))throw new Error('流转节点结构尚未识别。');
      records=data;
    }
    let currentFlow:{name:string;user:string;serial?:number;total?:number}|undefined;
    if(selected){
      const official=await this.queryOfficial(selected.id,selected.handId,signal,selected.submission);
      selected.submission=official.ok||!selected.submission?official.submission:preserveStale(selected.submission,official.submission);
      if(official.handId)selected.handId=official.handId;
      currentFlow=official.currentFlow;
      selected.currentFlow=official.currentFlow;
      if(official.needSendOfficial!==undefined)selected.needSendOfficial=official.needSendOfficial;
    }
    let nodes=mapFlowNodes(records,currentFlow);
    if(!nodes.length&&currentFlow)nodes=[{name:currentFlow.name,user:currentFlow.user,running:true,finished:false,isCurrent:true,serial:currentFlow.serial,total:currentFlow.total,start:'',end:''}];
    const sub=selected?.submission;
    if(sub)nodes=withOfficialWait(nodes,sub);
    let history:{name:string;created:string;finished:string}[]=[];
    try{
      const raw=await this.request('/CaseInfo/GetCaseAllFlowHistoryInfo',undefined,{caseId:c.remote.caseId},signal);
      history=(listOf(raw)??[]).map((h:Obj)=>({name:clean(h.CaseProcName),created:clean(h.ProcCreateDate),finished:clean(h.FinishDate)}));
    }catch(e){if(signal?.aborted)throw e;}
    const at=new Date().toISOString();
    return {at,currentProcessId:selected?.id,processes:{caseId:c.remote.caseId,processes,syncedAt:at},nodes,history,currentFlow};
  }
}
export function preserveStale(previous:Submission,failed:Submission):Submission {
  if(previous.state==='sent'||previous.state==='received')return {...previous,refreshError:SUBMISSION_REFRESH_ERROR};
  return failed;
}
export function assignCurrentProcess(c:Case,p:RemoteProcess|undefined,at:string) {
  const list=c.remote?.processes??[];
  const internallyActive=list.filter(isInternallyActiveProcess);
  const kind=p?mainProcessKind(p.name)??'external':internallyActive.length?'needs-confirmation':'waiting';
  let round=c.rounds.find(r=>r.id==='proc-'+p?.id);
  if(p&&['reply','correction'].includes(kind)&&!round){round=makeRound(p.name);round.id='proc-'+p.id;round.materials=[];c.rounds.push(round);}
  archiveDraftIfProcessChanged(c,p?.id,at);
  c.current={kind,roundId:round?.id,processId:p?.id,label:p?.name??(internallyActive.length?'系统存在多个未结束流程，请核对实际当前阶段':'当前流程已办结，等待后续通知'),remoteStatus:p?.status};
  c.rounds=c.rounds.map(r=>r.id===round?.id?r:{...r,job:null});
  if(p)applySubmissionToCurrent(c,p);
  else{applyCaseDeadline(c);stampCurrentHandling(c);}
}
export function applySubmissionToCurrent(c:Case,p:RemoteProcess) {
  if(!c.current?.processId||c.current.processId!==p.id)return;
  if(isConfirmedOfficialSubmission(p.submission)){
    applyOfficialWaiting(c,p.id);
    stampCurrentHandling(c);
    return;
  }
  if(p.status===500){
    const hasActiveMain=c.remote?.processes.some(x=>isInternallyActiveProcess(x)&&x.id!==p.id);
    if(!hasActiveMain){
      if(p.needSendOfficial===false){
        c.current={...c.current,kind:'waiting',processId:p.id,label:p.name,remoteStatus:500,node:INTERNAL_ENDED_WAIT_LABEL,party:'内部'};
      }else{
        c.current={
          ...c.current,
          kind:'needs-confirmation',
          processId:p.id,
          label:p.needSendOfficial===true?UNVERIFIED_OFFICIAL_LABEL:p.name,
          remoteStatus:500,
          node:'待核验',
          party:'内部',
        };
      }
    }
  }
  applyCaseDeadline(c);
  stampCurrentHandling(c);
}
export function mergePersonalRows(rows:Obj[],existing:Case[],at:string):Case[] {
  const grouped=new Map<string,Obj[]>();
  for(const row of rows){const id=clean(row.CaseId);if(!id||!row.CaseProcId)throw new Error('案件列表缺少案件或流程标识。');grouped.set(id,[...(grouped.get(id)??[]),row]);}
  const result=[...existing];
  for(const [id,group] of grouped){
    const first=group[0],index=result.findIndex(c=>c.remote?.caseId===id),old=result[index];
    const processes:RemoteProcess[]=[...new Map(group.map(r=>[String(r.CaseProcId),processRow(r,old?.remote?.processes.find(p=>p.id===String(r.CaseProcId)))])).values()];
    const p=selectCurrentProcess(processes,group,old?.current?.processId);
    const internallyActive=processes.filter(isInternallyActiveProcess);
    const kind=p?mainProcessKind(p.name)??'external':internallyActive.length?'needs-confirmation':'waiting';
    const c:Case=old?structuredClone(old):{id:'bs-'+id,title:'',number:'',type:'',deadline:'',archived:false,tags:[],rounds:[],source:'baseland'};
    Object.assign(c,{title:clean(first.CaseName)||c.title||'未命名案件',number:clean(first.CaseNo)||c.number||id,type:clean(first.ApplyType)||c.type,applicationNumber:clean(first.ApplyNo??first.ApplicationNo)||c.applicationNumber,deadline:p?.deadline??'',remote:{caseId:id,processes,syncedAt:at}});
    if ('ClientName' in first) c.companyName = clean(first.ClientName);
    if ('CaseRemark' in first) c.caseRemark = clean(first.CaseRemark);
    let round=c.rounds.find(r=>r.id==='proc-'+p?.id);
    if(p&&['reply','correction'].includes(kind)&&!round){round=makeRound(p.name);round.id='proc-'+p.id;round.materials=[];c.rounds.push(round);}
    archiveDraftIfProcessChanged(c,p?.id,at);
    c.current={kind,roundId:round?.id,processId:p?.id,label:p?.name??(internallyActive.length?'系统存在多个未结束流程，请核对实际当前阶段':'当前流程已办结，等待后续通知'),remoteStatus:p?.status};
    c.rounds=c.rounds.map(r=>r.id===round?.id?r:{...r,job:null});
    if(p)applySubmissionToCurrent(c,p);
    else{applyCaseDeadline(c);stampCurrentHandling(c);}
    if(index<0)result.push(c);else result[index]=c;
  }
  // Cases no longer returned stay on disk but may not continue under stale responsibility.
  return result.map(c=>c.remote&&!grouped.has(c.remote.caseId)?{...c,current:{kind:'external',label:'不在当前个人案件结果中，请核对分配情况'} as Case['current']}:c);
}

export function applyRemoteClosure(c:Case,closure:{finished:boolean;checkedAt:string}|undefined){
  if(!closure)return;
  const newlyClosed=closure.finished&&c.remoteClosure?.finished!==true;
  c.remoteClosure=closure;
  if(newlyClosed)c.archived=true;
}
