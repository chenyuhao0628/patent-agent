import { diagnostic, diagnosticError } from './diagnostics.ts';
export class BaselandAuthError extends Error { kind:'expired'|'forbidden';constructor(kind:'expired'|'forbidden',message:string){super(message);this.kind=kind;this.name='BaselandAuthError';} }
import { businessCode } from './baseland-results.ts';
import type { Account, FlowNode } from '../src/desktop.ts';
import type { Case, RemoteProcess, Submission, SubmissionState } from '../src/domain/workflow.ts';
import { makeRound } from '../src/domain/workflow.ts';
import { applyCaseDeadline, calendarDate, mergeRemoteProcess } from '../src/domain/deadlines.ts';
import { applyOfficialWaiting, archiveDraftIfProcessChanged, effectiveSubmission, isAuxiliaryProcess, isInternallyActiveProcess, processBusinessKind, stampCurrentFromStageVerdict } from '../src/domain/lifecycle.ts';
import { stageVerdict } from '../src/domain/stage-verdict.ts';
import { stampCurrentHandling } from '../src/domain/handling.ts';
import { digest } from './files.ts';
export { isAuxiliaryProcess, isInternallyActiveProcess };

type Obj=Record<string,any>;
export type PersonalProcessStatistic={code:number;count:number};
export const API='https://cloudapi02.baselandtec.com/v1';
const clean=(s:unknown)=>typeof s==='string'?s:typeof s==='number'?String(s):'';
const listOf=(data:any):Obj[]|undefined=>Array.isArray(data)?data:data?.List??data?.Rows??data?.DataList??data?.ListData??data?.PageData??data?.Items;
const SEND_STATUS:Record<number,SubmissionState>={0:'draft',1:'queued',2:'sent',3:'failed',6:'received',100:'sending'};
const SEND_LABEL:Record<SubmissionState,string>={unknown:'官方递交状态未确认',draft:'待递交',queued:'准备递交中',sending:'递交中',sent:'递交成功',received:'已收到回执',failed:'递交失败'};
export const KNOWN_SEND_STATUS=[{label:'待递交',value:0},{label:'准备递交中',value:1},{label:'递交成功',value:2},{label:'递交失败',value:3},{label:'已收到回执',value:6},{label:'递交中',value:100}] as const;
export const SUBMISSION_REFRESH_ERROR='未能刷新官方递交状态，仍显示上次确认结果。';

export const officialDate=calendarDate;
// 官方结论判读表（0001《只读-授权与获证检测》§3.7）：授权类官文名叫「办理登记手续通知书」，不叫「授权通知书」；
// 专利证书只可能出现在授权之后，因此同样判为已授权。驳回决定有三个同义码。本表只用于官文清单，不改写贝思兰德。
export const OUTCOME_NOTICE_TYPES={granted:['200602'],grantedByCertificate:['400001','400002','400003'],rejected:['200305','210407','210408']} as const;
export type OfficialOutcomeState='granted'|'rejected'|'none';
export type OfficialOutcomeVerdict={state:OfficialOutcomeState;noticeName?:string;noticeTypeCode?:string;postDate?:string};
const OUTCOME_PAGE_SIZE=100;
const OUTCOME_PAGE_LIMIT=5;
function newestNotice(list:{name:string;code:string;postDate:string}[]){
  const known=list.filter(row=>row.postDate);
  if(!known.length)return list[0];
  return [...known].sort((a,b)=>b.postDate.localeCompare(a.postDate))[0];
}
export function judgeOfficialOutcome(rows:Obj[]):OfficialOutcomeVerdict {
  const matched=(codes:readonly string[])=>rows.flatMap(row=>{
    const code=clean(row.NoticeTypeCode??row.NoticeCode);
    return codes.includes(code)?[{name:clean(row.NoticeName),code,postDate:officialDate(row.PostDate)||clean(row.PostDate)}]:[];
  });
  const rejected=newestNotice(matched(OUTCOME_NOTICE_TYPES.rejected));
  const granted=newestNotice([...matched(OUTCOME_NOTICE_TYPES.granted),...matched(OUTCOME_NOTICE_TYPES.grantedByCertificate)]);
  // 若同时存在授权与驳回，以发文日 postDate 较新者为准（复审撤销驳回后授权为专利实务常规）；
  // 日期相同或均无日期时，依 0001 §3.7 建议优先判定办登/证书（先看 200602/40000x，再看驳回）。
  let winner:{name:string;code:string;postDate:string;state:OfficialOutcomeState}|undefined;
  if(rejected&&granted){
    if(rejected.postDate&&granted.postDate){
      winner=granted.postDate>=rejected.postDate?{...granted,state:'granted'}:{...rejected,state:'rejected'};
    }else{
      winner={...granted,state:'granted'};
    }
  }else if(rejected){
    winner={...rejected,state:'rejected'};
  }else if(granted){
    winner={...granted,state:'granted'};
  }
  if(!winner)return {state:'none'};
  return {state:winner.state,noticeName:winner.name||undefined,noticeTypeCode:winner.code,postDate:winner.postDate||undefined};
}
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
export function rowStamp(r?:Obj) {
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
  if(internallyActive.length>1)return preferredId?internallyActive.find(p=>p.id===preferredId):undefined;
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
    personalStatus:typeof r._status==='number'?r._status:previous?.personalStatus,
    canEdit:previous?.canEdit,
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
export function isIdempotentRead(endpoint:string):boolean{
  if(endpoint==='/Auth/GetToken'||endpoint.includes('FileStorageUploadFile'))return false;
  if(/(?:Add|Insert|Update|Delete|Modify|Submit|Start|Upload)/i.test(endpoint))return false;
  if(/(?:Get|Query|Snapshot|List|Statistics|Count|History|Record|Info|Setting|Type)/i.test(endpoint))return true;
  return false;
}
export class BaselandClient {
  origin:string; token:string; fetcher:typeof fetch;
  onUnauthorized?:()=>Promise<boolean>;
  constructor(origin:string,token='',fetcher=fetch){this.origin=validOrigin(origin);this.token=token;this.fetcher=fetcher;}
  async uploadDocument(name:string,bytes:Buffer,signal?:AbortSignal):Promise<string>{
    const form=new FormData();form.set('file',new Blob([Uint8Array.from(bytes)],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name);
    const response=await this.fetcher(API+'/NoPermissionRequired/FileStorageUploadFile?1=1',{method:'POST',headers:{Origin:this.origin,Referer:this.origin+'/login.html',Language:'zh-CN',Authorization:this.token},body:form,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
    if(response.status===401)throw new BaselandAuthError('expired','登录已失效，请重新登录。');
    if(!response.ok)throw new Error(`文件上传未完成（HTTP ${response.status}）。`);
    const data=await response.json() as Obj;
    const code=businessCode(data.Data);
    if(code!==undefined&&code.toLowerCase()!=='success')throw new Error('服务端未确认文件上传成功，结果待核验，请勿直接重复上传。');
    if(data.IsSuccess!==true||typeof data.Data?.FileNo!=='string'||!data.Data.FileNo)throw new Error('贝思兰德未返回上传文件编号。');
    return data.Data.FileNo;
  }
  async request(endpoint:string,body?:unknown,params?:Record<string,string>,signal?:AbortSignal,kind:'data'|'list'='data',retried=false):Promise<any> {
    const started=Date.now();
    diagnostic('baseland','request_started',{operation:endpoint});
    const url=new URL(API+endpoint);for(const [k,v] of Object.entries(params??{}))url.searchParams.set(k,v);
    let response:Response;
    try{response=await this.fetcher(url,{method:body?'POST':'GET',headers:{Origin:this.origin,Referer:this.origin+'/login.html',Language:'zh-CN','Content-Type':'application/json',...(this.token?{Authorization:this.token}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}catch(error){diagnostic('baseland','request_failed',{operation:endpoint,durationMs:Date.now()-started,...diagnosticError(error)});throw new Error(signal?.aborted?'操作已停止。':'无法连接贝思兰德，请检查网络后重试。');}
    diagnostic('baseland','response',{operation:endpoint,statusCode:response.status,durationMs:Date.now()-started});
    if(response.status===401||response.status===403){
      if(response.status===401&&endpoint!=='/Auth/GetToken'&&!retried&&this.onUnauthorized&&isIdempotentRead(endpoint)){
        const renewed=await this.onUnauthorized();
        if(renewed)return this.request(endpoint,body,params,signal,kind,true);
      }
      throw new BaselandAuthError(response.status===401?'expired':'forbidden','登录已失效或账号无权限，请重新登录。');
    }
    if(!response.ok)throw new Error(`贝思兰德请求失败（HTTP ${response.status}）。`);
    const data=await response.json() as Obj;
    if(data.IsSuccess!==true){
      if(endpoint==='/Auth/GetToken')throw loginFailure(data.Message);
      if(/权限/.test(data.Message??''))throw new BaselandAuthError('forbidden','当前账号无权访问该数据。');
      if(/登录|Token|token|认证|过期/.test(data.Message??'')){
        if(!retried&&this.onUnauthorized&&isIdempotentRead(endpoint)){
          const renewed=await this.onUnauthorized();
          if(renewed)return this.request(endpoint,body,params,signal,kind,true);
        }
        throw new BaselandAuthError('expired','登录已失效，请重新登录。');
      }
      throw new Error(/权限/.test(data.Message??'')?'当前账号无权访问该数据。':/登录|Token|token|认证|过期/.test(data.Message??'')?'登录已失效，请重新登录。':'贝思兰德未确认请求成功，请核对账号或稍后重试。');
    }
    // Login/detail objects must never be replaced by a default empty DataList.
    const result=kind==='list'?(data.DataList??data.ListData??data.Data):data.Data;
    if(typeof result==='string'&&/^[A-Za-z][A-Za-z0-9_]{1,90}$/.test(result)&&/\/(?:AddCaseHandForm|IsHasCaseHandForm|InsertFormOpinionStatement|UpdateFormOpinionStatement|SubmitHandFlow)$/.test(endpoint))diagnostic('baseland','business_result',{operation:endpoint,code:result});
    return result;
  }
  async identity(username:string,signal?:AbortSignal):Promise<Account> {
    const raw=await this.request('/Auth/GetLoginInfo',undefined,{checkVersion:'false',isLogin:'true'},signal);
    const data=(raw??{}) as Obj;let user:Obj=data.UserInfo??data.TenantUserInfo??data.User??data;
    try{const more=await this.request('/TenantUser/GetCurrentUserInfo',undefined,undefined,signal);if(more&&typeof more==='object')user={...user,...more};}catch(e){if(signal?.aborted)throw e;/* Optional profile details; GetLoginInfo already verified the session. */}
    return {username,displayName:clean(user.RealName??user.UserRealName??user.Name??user.UserName)||username,organization:clean(data.TenantName??data.TenantInfo?.TenantName??user.TenantName),origin:this.origin,userId:clean(user.UserId??user.TenantUserId??user.Id),status:'authenticated',remembered:false};
  }
  async login(username:string,password:string,signal?:AbortSignal) {
    const data=await this.request('/Auth/GetToken',{UserName:username.trim(),Password:password.trim()},undefined,signal);
    if(data?.IsSuccess===false)throw loginFailure(data.ResultString??data.Message);
    if(typeof data?.Token!=='string'||!data.Token.trim())throw new Error('贝思兰德登录响应格式未识别，尚未取得有效登录。请在机构网页确认能否正常登录。');
    this.token=data.Token;return this.identity(username,signal);
  }
  async personalCasesSnapshot(signal:AbortSignal,initial?:PersonalProcessStatistic[]) {
    const rows:Obj[]=[];
    const tabs=[['waitHand',50010,0],['auditing',50011,200],['waitDeliver',50012,300],['delivering',50013,400],['finish',50014,500]] as const;
    let expectedStats=initial;
    for(let attempt=0;attempt<2;attempt++){
      rows.length=0;
      expectedStats=attempt===0&&initial?initial:await this.snapshotStatistics(signal);
      const expected=new Map(expectedStats.map(row=>[row.code,row.count]));
      const allIds=new Set<string>();
      let consistent=true;
      // 五个页签互相独立，并发拉取（实测服务端不禁并发：20 路并发同接口全部 200）。
      // 结果按 tabs 顺序返回；跨页签去重与计数核对在全部返回后统一进行，语义与串行版一致。
      const results=await Promise.all(tabs.map(async ([name,table,status])=>{
        const body={PagedInfo:{pageIndex:1,pageSize:100},ProcStatusTypeList:[status],TableType:table,ActiveName:name,SelectedProcIdGroup:[]};
        const expectedCount=expected.get(status);
        if(expectedCount===undefined)throw new Error('个人流程统计缺少页签数据。');
        const pageRows:Obj[]=[],seen=new Set<string>();
        let tabConsistent=true;
        for(let page=1;page<=500;page++){
          const data=listOf(await this.request('/CaseInfo/GetPersonalCase',{...body,PagedInfo:{pageIndex:page,pageSize:100}},undefined,signal,'list'));
          if(!Array.isArray(data))throw new Error('个人案件列表结构尚未识别，本次未写入案件。');
          for(const row of data){const id=clean(row.CaseProcId);if(!id||seen.has(id)){tabConsistent=false;break;}seen.add(id);pageRows.push({...row,_status:status});}
          if(!tabConsistent||data.length===0||pageRows.length>=expectedCount)break;
          if(page===500)tabConsistent=false;
        }
        return {status,pageRows,consistent:tabConsistent&&pageRows.length===expectedCount};
      }));
      for(const result of results){
        if(!result.consistent){consistent=false;break;}
        for(const row of result.pageRows){const id=clean(row.CaseProcId);if(allIds.has(id)){consistent=false;break;}allIds.add(id);}
        if(!consistent)break;
        rows.push(...result.pageRows);
      }
      const after=await this.snapshotStatistics(signal);
      if(consistent&&expectedStats.every(row=>after.find(x=>x.code===row.code)?.count===row.count))return {rows,stats:after};
    }
    throw new Error('个人流程数量与分页结果不一致，可能正在变化；本次同步未完成，本地案件与稿件保留，请稍后重试。');
  }
  async personalCases(signal:AbortSignal) {
    return (await this.personalCasesSnapshot(signal)).rows;
  }
  private async snapshotStatistics(signal:AbortSignal):Promise<PersonalProcessStatistic[]> {
    try{return await this.personalProcessStatistics(signal);}
    catch(error){
      signal.throwIfAborted();
      if(error instanceof BaselandAuthError)throw error;
      const stats:PersonalProcessStatistic[]=[];
      for(const [name,table,code] of [['waitHand',50010,0],['auditing',50011,200],['waitDeliver',50012,300],['delivering',50013,400],['finish',50014,500]] as const){
        const count=await this.request('/CaseInfo/GetPersonalCaseCount',{PagedInfo:{pageIndex:1,pageSize:100},ProcStatusTypeList:[code],TableType:table,ActiveName:name,SelectedProcIdGroup:[]},undefined,signal);
        if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0)throw new Error('个人流程数量未能确认，本次同步未完成。');
        stats.push({code,count});
      }
      return stats;
    }
  }
  async personalProcessStatistics(signal?:AbortSignal) {
    const data=listOf(await this.request('/CaseInfo/GetPersonalProcStatistics',undefined,undefined,signal,'list'));
    if(!Array.isArray(data))throw new Error('个人流程统计结构尚未识别。');
    const result=data.map(row=>{
      const code=row.Code??row.code,count=row.Count??row.count;
      if(!Number.isInteger(code)||!Number.isSafeInteger(count)||count<0)throw new Error('个人流程统计结构尚未识别。');
      return {code,count};
    });
    if(result.length!==5||![0,200,300,400,500].every(code=>result.filter(row=>row.code===code).length===1))throw new Error('个人流程统计缺少或重复页签数据。');
    return result.sort((a,b)=>a.code-b.code);
  }
  // 仅被测试引用，产品代码当前不使用：GetFileCount 只接受单个案件号（CaseNo 传数组会「参数验证失败」，
  // CaseNoList/CaseNoGroup 被忽略并按全所计数），拿不到「本账号个人案件」的增量信号。
  async fileCount(signal?:AbortSignal) {
    const data=await this.request('/CaseFile/GetFileCount',{
      PagedInfo:{PageIndex:1,PageSize:1,SortField:null,SortType:null},
      UserTableTitleColumnList:[],
      TableType:20101,
    },undefined,signal);
    const count=typeof data==='number'?data:Number(data?.Count??data?.count);
    if(!Number.isSafeInteger(count)||count<0)throw new Error('文件中心数量结构尚未识别。');
    return count;
  }
  // 同上，仅被测试引用：按 UploadDate 区间查「全所」文件中心，不能按案件号批量过滤，
  // 接回产品代码会变成替别人上传的文件付查询与分页成本，因此保留在案件级逐流程取文件列表的方案。
  async fileListSince(start:string,end:string,signal?:AbortSignal) {
    const data=listOf(await this.request('/CaseFile/GetFileList',{
      PagedInfo:{PageIndex:1,PageSize:100,SortField:'UploadDate',SortType:'descending'},
      UserTableTitleColumnList:[],
      TableType:20101,
      UploadDateStart:start,
      UploadDateEnd:end,
    },undefined,signal,'list'));
    if(!Array.isArray(data))throw new Error('文件中心增量列表结构尚未识别。');
    return data;
  }
  async caseFileCount(caseId:string,signal?:AbortSignal) {
    const data=await this.request('/CaseInfo/GetCaseFileAllListCount',undefined,{caseId},signal);
    const count=typeof data==='number'?data:Number(data?.Count??data?.count);
    if(!Number.isSafeInteger(count)||count<0)throw new Error('案件文件数量结构尚未识别。');
    return count;
  }
  async files(processId:string,signal:AbortSignal) {const data=listOf(await this.request('/CaseInfo/GetCaseProcFileList',undefined,{caseProcId:processId},signal,'list'));if(!Array.isArray(data))throw new Error('文件列表结构尚未识别。');return data;}
  async download(fileNo:string,signal:AbortSignal,retried=false):Promise<Buffer> {
    const url=new URL(API+'/NoPermissionRequired/FileStorageGetFile');url.searchParams.set('fileNo',fileNo);url.searchParams.set('forBlob','true');
    const r=await this.fetcher(url,{headers:{Authorization:this.token,Origin:this.origin,Language:'zh-CN'},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
    if(r.status===401&&!retried&&this.onUnauthorized){
      const renewed=await this.onUnauthorized();
      if(renewed)return this.download(fileNo,signal,true);
    }
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
  async queryOfficial(processId:string,handId?:string,signal?:AbortSignal,previous?:Submission):Promise<{submission:Submission;handId?:string;currentFlow?:{name:string;user:string;serial?:number;total?:number};needSendOfficial?:boolean;canEdit?:boolean;ok:boolean}> {
    const checkedAt=new Date().toISOString();
    try{
      const data=await this.request('/CaseInfo/GetHandInfo',undefined,{caseProcId:processId},signal);
      const obj=data&&typeof data==='object'?data as Obj:null;
      const info=obj?.HandInfo&&typeof obj.HandInfo==='object'?obj.HandInfo as Obj:{};
      const id=clean(info.CaseHandId||obj?.CaseHandId)||handId||undefined;
      const currentFlow=mapCurrentFlow(obj?.CurrentFlowInfo);
      const needSendOfficial=obj?boolTri(obj.IsNeedSendToOfficail):undefined;
      const primary=obj?boolTri(obj.IsPackageSendSuccess):undefined;
      const canEdit=obj?boolTri(obj.IsReviewing):undefined;
      let send:unknown=undefined,sendFailed=false;
      if(id){
        try{send=await this.request('/CaseInfo/GetCaseHandSendInfo',undefined,{caseHandId:id},signal);}
        catch(e){
          if(signal?.aborted)throw e;
          sendFailed=true;
        }
      }
      if(sendFailed&&previous&&(previous.state==='sent'||previous.state==='received')){
        return {submission:{...previous,refreshError:SUBMISSION_REFRESH_ERROR},handId:id,currentFlow,needSendOfficial,canEdit,ok:true};
      }
      return {submission:combineOfficialSubmission(primary,sendFailed?undefined:send,checkedAt),handId:id,currentFlow,needSendOfficial,canEdit,ok:true};
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
  // 只读：按案件官文清单判读官方结论（授权/驳回），不下载、不导入、不写回贝思兰德。
  // 请求体必须带 PagedInfo，空对象服务端会返回「系统错误: e」；命中结论即停止翻页。
  async officialOutcome(c:Case,signal?:AbortSignal):Promise<OfficialOutcomeVerdict&{checkedAt:string;incomplete?:boolean}> {
    if(!c.remote)throw new Error('案件未关联贝思兰德。');
    const caseId=c.remote.caseId,rows:Obj[]=[];
    for(let page=1;page<=OUTCOME_PAGE_LIMIT;page++){
      const data=listOf(await this.request('/CaseInfo/GetNoticeListByCaseId',{caseId,PagedInfo:{PageIndex:page,PageSize:OUTCOME_PAGE_SIZE}},undefined,signal,'list'));
      if(!Array.isArray(data))throw new Error('案件官文清单结构尚未识别。');
      rows.push(...data);
      const verdict=judgeOfficialOutcome(rows);
      if(verdict.state!=='none')return {...verdict,checkedAt:new Date().toISOString()};
      if(data.length<OUTCOME_PAGE_SIZE)return {state:'none',checkedAt:new Date().toISOString()};
    }
    // 到翻页上限仍未判定：保留「未见结果」，但标记清单未取完，界面必须提示结果待复核。
    return {state:'none',checkedAt:new Date().toISOString(),incomplete:true};
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
      selected.canEdit=official.ok?official.canEdit:false;
      selected.submission=effectiveSubmission(selected);
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
  p.submission=effectiveSubmission(p);
  if(!c.current?.processId||c.current.processId!==p.id)return;
  const kind=stageVerdict({status:p.status,submission:p.submission,needSendOfficial:p.needSendOfficial});
  if(kind==='waiting-official'){
    applyOfficialWaiting(c,p.id);
    stampCurrentHandling(c);
    return;
  }
  const hasActiveMain=c.remote?.processes.some(x=>isInternallyActiveProcess(x)&&x.id!==p.id);
  if(kind==='none'||!hasActiveMain){
    const stamped=stampCurrentFromStageVerdict(c.current,p,kind);
    if(stamped)c.current=stamped;
  }
  applyCaseDeadline(c);
  stampCurrentHandling(c);
}
export function mergePersonalRows(rows:Obj[],existing:Case[],at:string):Case[] {
  const grouped=new Map<string,Obj[]>();
  for(const row of rows){const id=clean(row.CaseId);if(!id||!row.CaseProcId)throw new Error('案件列表缺少案件或流程标识。');grouped.set(id,[...(grouped.get(id)??[]),row]);}
  const result=[...existing];
  for(const [id,group] of grouped){
    const first=group[0],index=result.findIndex(c=>!c.linkedTo&&c.remote?.caseId===id),old=result[index];
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
