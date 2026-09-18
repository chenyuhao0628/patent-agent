import { randomUUID } from 'node:crypto';
import { FIVE_PARTS } from '../src/transfer-api.ts';
import type { TransferRoute, TransferReview, TransferForm, TransferView } from '../src/transfer-api.ts';
import type { BaselandClient } from './baseland.ts';
import { flag, combineOfficialSubmission, boolTri, sendStatusState } from './baseland.ts';
import { assertWriteResult, businessCode } from './baseland-results.ts';
import { digest } from './files.ts';
import { validateCorrectionContents } from '../src/domain/correction.ts';
type Obj = Record<string, any>;
export type RemoteTransfer = { hand: Obj; handId: string; cards: Obj[]; instructionsCode?: string; formCode: string; form: Obj | null; instructions: Obj | null; files: Obj[]; notice: Obj | null; steps: Array<{id:string;name:string;users:Array<{id:string;name:string}>}>; fingerprint: string };
const list=(v:any):Obj[]=>Array.isArray(v)?v:Array.isArray(v?.List)?v.List:[];
const id=(v:unknown)=>typeof v==='string'||typeof v==='number'?String(v):'';
const clean=(v:unknown)=>String(v??'').trim();
const isEmptyGuid=(v:unknown)=>{const s=clean(v);return !s||s==='00000000-0000-0000-0000-000000000000'||s==='0';};
const code=(v:unknown)=>id(v).padStart(6,'0');
const names=(items:Obj[])=>items.map(f=>String(f.FileName||f.FormName||f.File?.FileName||'')).filter(Boolean);
export const remoteFileNames=names;
const GET_FORM:Record<TransferRoute,string>={reply:'GetFormOpinionStatement',correction:'GetFormCorrection',application:'GetFormPatentRequestInfo'};
const saveEndpoint=(route:TransferRoute,exists:boolean)=>route==='application'?(exists?'UpdateFormPatentRequestInfo':'InsertFromPatentRequestInfo'):(exists?'Update':'Insert')+(route==='reply'?'FormOpinionStatement':'FormCorrection');
export const REQUEST_DECLARATIONS:Record<string,string>={IsApplySameDay:'同日申请',IsPublicAdvance:'请求提前公开',IsExhibition:'展览会公开声明',IsPublished:'学术或技术会议公开声明',IsPublicForCommonProfit:'公共利益目的公开声明',IsDisclosure:'他人未经同意泄露声明',IsGiveUpOn51Section:'放弃主动修改',IsRequestDelayReview1YearForUtility:'实用新型延迟审查一年'};

export async function readRemoteTransfer(client:BaselandClient,processId:string,route:TransferRoute):Promise<RemoteTransfer|null>{
  const q=(ep:string,params:Record<string,string>,kind:'data'|'list'='data')=>client.request('/CaseInfo/'+ep,undefined,params,undefined,kind);
  const hand=await q('GetHandInfo',{caseProcId:processId});
  const handId=id(hand?.HandInfo?.CaseHandId);
  if(!handId)return null;
  const send=await q('GetCaseHandSendInfo',{caseHandId:handId});
  if(send!=null&&sendStatusState(send)===undefined&&!flag(hand.IsPackageSendSuccess))throw new Error('官方递交状态值尚未识别，请核对后再整理材料。');
  const submission=combineOfficialSubmission(boolTri(hand.IsPackageSendSuccess),send,new Date().toISOString());
  if(submission.state==='unknown')throw new Error('无法确认官方递交状态，请刷新核对后再整理材料。');
  if(['queued','sending'].includes(submission.state))throw new Error('当前流程正在递交官方，暂不能整理材料，请刷新核对。');
  if(['sent','received'].includes(submission.state))throw new Error('当前流程已经提交官方，不能重新整理本次材料。');
  const params={caseHandId:handId};
  const [original,middle,replacement,form,notice,files,rawSteps]=await Promise.all([
    q('GetOfficialFormList',{...params,fileType:'0'},'list'),q('GetOfficialFormList',{...params,fileType:'2'},'list'),q('GetOfficialFormList',{...params,fileType:'4'},'list'),
    q(GET_FORM[route],params),q('GetCaseHandProcRelateNoticeInfo',params),q('GetCaseHandFileList',params,'list'),q('GetHandNextFlowList',{caseReviewDraftId:handId},'list'),
  ]);
  const cards=[...new Map([...list(original),...list(middle),...list(replacement)].map(c=>[code(c.Code),c])).values()];
  const target=cards.find(c=>route==='reply'?code(c.Code)==='100012':route==='correction'?code(c.Code)==='100006':['110101','120101'].includes(code(c.Code)));
  if(!target)throw new Error('当前递交实例没有对应业务表单，请先核对贝思兰德流程。');
  const instructionsCard=cards.find(c=>/申请原文|申请文件|说明书及附图|说明书和附图|说明书、说明书摘要、权利要求书与附图/.test(String(c.FormName)));
  // The official frontend groups returned five-book entries from fileType 0/4 into virtual card 000000.
  const groupedParts=[...list(original),...list(replacement)].filter(c=>FIVE_PARTS.some(p=>p.code===code(c.Code)));
  const instructionsCode=instructionsCard?id(instructionsCard.Code):groupedParts.length?'000000':undefined;
  const instructions=instructionsCode?await q('GetFormInstructionsAndImage',{...params,formCode:instructionsCode}):null;
  const steps=[];
  for(const step of list(rawSteps)){
    if(!id(step.CaseHandStepId)||!id(step.Name)||flag(step.IsFinish))continue;
    const users=list(await q('GetHandNextFlowUserByStepId',{caseHandStepId:id(step.CaseHandStepId)},'list')).filter(u=>id(u.value)&&id(u.label)).map(u=>({id:id(u.value),name:id(u.label)}));
    steps.push({id:id(step.CaseHandStepId),name:id(step.Name),users});
  }
  const result={hand,handId,cards,instructionsCode,formCode:id(target.Code),form:form??null,instructions:instructions??null,files:list(files),notice:notice??null,steps};
  return {...result,fingerprint:remoteFingerprint(result)};
}
function remoteFingerprint(r:Omit<RemoteTransfer,'fingerprint'>){
  const sortedCards=[...r.cards].sort((a,b)=>String(a.Code).localeCompare(String(b.Code))).map(c=>[c.Code,c.IsSelect]);
  const sortedFiles=[...(r.files||[])].map(f=>({name:f.FileName||f.FormName,no:f.FileNo||f.File?.FileNo})).sort((a,b)=>String(a.no).localeCompare(String(b.no)));
  return digest(JSON.stringify({handId:r.handId,flow:r.hand.CurrentFlowInfo,canEdit:r.hand.IsReviewing,form:r.form,notice:r.notice,instructions:r.instructions,files:sortedFiles,cards:sortedCards}));
}
export function existingTransferParts(r:RemoteTransfer|null){
  const group=list(r?.instructions?.FormGroup);
  if(!group.some(g=>g.File?.FileNo))return [];
  return FIVE_PARTS.map(p=>{const available=group.some(g=>code(g.FormCode)===p.code&&g.File?.FileNo);return {...p,changed:null,available,reason:available?'服务端当前已有此部分；尚无修改比较，请核对是否保留。':'服务端当前没有此部分。'};});
}
export function defaultTransferForm(r:RemoteTransfer|null):TransferForm{
  const f=r?.form??{},notice=r?.notice??{},o=f.OpinionStatement??{},c=f.Correction??{};
  return {noticeDate:String(o.NoticeDate||c.NoticeDate||notice.PostDate||'').slice(0,10),noticeName:String(o.NoticeName||c.NoticeName||notice.NoticeName||''),noticeNo:String(o.NoticeNo||c.NoticeNo||notice.FaWenXLH||''),correctionReason:Number(c.CorrectionReasonType)===1?1:2,addEntrust:flag(c.IsAddEntrust),corrections:list(f.CorrectionContentList).map(x=>({...x,ChangeId:x.ChangeId||randomUUID()})) as TransferForm['corrections'],otherProof:flag(o.IsUseOtherProveFileHand),experimentData:flag(o.HasAddExperimentData),abstractFigure:String(f.SpecificationInfo?.AbstractDrawNumber||r?.hand?.HandInfo?.AbstractDrawNumber||'1'),declarations:Object.fromEntries(Object.keys(REQUEST_DECLARATIONS).map(k=>[k,flag(f.RequestInfo?.[k])]))};
}
export function isRemoteTransferSaved(r:RemoteTransfer|null,route:TransferRoute):boolean{
  if(!r||!r.handId||!flag(r.hand?.IsReviewing))return false;
  if(!Array.isArray(r.steps)||r.steps.length===0)return false;
  const cards=r.cards||[];
  if(route==='reply'){
    const card=cards.find(c=>code(c.Code)==='100012');
    if(!card||!flag(card.IsSelect))return false;
    const hasWord=Boolean(r.form?.File?.FileNo||(r.form?.File?.FileName&&r.files.some(f=>/(意见陈述|陈述意见|答复|审查意见)/.test(String(f.FileName||f.FormName||''))))||r.files.some(f=>/(意见陈述|陈述意见|答复|审查意见)/.test(String(f.FileName||f.FormName||''))||String(f.FileName||f.FormName||'').toLowerCase().endsWith('.docx')));
    if(!hasWord)return false;
    const op=r.form?.OpinionStatement;
    const noticeDate=String(op?.NoticeDate||r.notice?.PostDate||'').slice(0,10);
    const noticeName=String(op?.NoticeName||r.notice?.NoticeName||'').trim();
    const noticeNo=String(op?.NoticeNo||r.notice?.FaWenXLH||'').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(noticeDate)||!noticeName||!noticeNo)return false;
    return true;
  }
  if(route==='application'){
    const card=cards.find(c=>['110101','120101'].includes(code(c.Code)));
    if(!card||!flag(card.IsSelect))return false;
    if(!r.form?.RequestInfo)return false;
    const parts=existingTransferParts(r);
    if(parts.filter(p=>p.available).length!==5)return false;
    const setting=r.instructions?.Setting??r.instructions?.InstructionsAndImageSetting??r.instructions??{};
    if(!flag(setting.IsUseXmlFormatHand))return false;
    const group=list(r.instructions?.FormGroup);
    if(!group.some(g=>flag(g.IsMixFile)&&g.File?.FileNo))return false;
    return true;
  }
  if(route==='correction'){
    const card=cards.find(c=>code(c.Code)==='100006');
    if(!card||!flag(card.IsSelect))return false;
    const cor=r.form?.Correction;
    const items=list(r.form?.CorrectionContentList);
    if(!cor||items.length===0)return false;
    if(Number(cor.CorrectionReasonType)===2){
      const noticeDate=String(cor.NoticeDate||'').slice(0,10);
      const noticeName=String(cor.NoticeName||'').trim();
      const noticeNo=String(cor.NoticeNo||'').trim();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(noticeDate)||!noticeName||!noticeNo)return false;
    }
    return true;
  }
  return false;
}
export function rehydrateRemoteSavedView(input:{
  id?:string;
  r:RemoteTransfer;
  route:TransferRoute;
  key:string;
  caseId:string;
  caseNumber:string;
  caseTitle:string;
  processId:string;
  processName:string;
  sourceMode?:'workbench'|'local';
  selectedRecipient?:{stepId:string;userId:string};
}):TransferView{
  const parts=existingTransferParts(input.r);
  const keepCodes=parts.filter(p=>p.available).map(p=>p.code);
  const form=defaultTransferForm(input.r);
  const id=input.id||randomUUID();
  const files=[...(input.r.files||[])];
  if(input.r.form?.File&&!files.some(f=>(f.FileNo&&f.FileNo===input.r.form?.File?.FileNo)||(f.FileName&&f.FileName===input.r.form?.File?.FileName)))files.push(input.r.form.File);
  const fileNames=remoteFileNames(files);
  return {
    id,
    sourceMode:input.sourceMode??'workbench',
    profileKey:input.key,
    caseId:input.caseId,
    caseNumber:input.caseNumber,
    caseTitle:input.caseTitle,
    processId:input.processId,
    processName:input.processName,
    route:input.route,
    canEditRemote:input.r.hand.IsReviewing===true,
    handId:input.r.handId,
    currentNode:input.r.hand.CurrentFlowInfo?.FlowNodeName,
    currentUser:input.r.hand.CurrentFlowInfo?.FlowUserName,
    files:[],
    parts,
    review:{
      keepCodes,
      form,
      stepId:input.selectedRecipient?.stepId??'',
      userId:input.selectedRecipient?.userId??'',
      remark:'',
    },
    steps:input.r.steps,
    phase:'saved',
    results:['已从贝思兰德云端同步已保存的递交材料与表单，无需重复上传，可直接选择下一办理人并转交。'],
    existingFileNames:fileNames,
    at:new Date().toISOString(),
  };
}
// The user edits only the four content fields. Ancillary form values belong to
// the current Baseland instance and cannot be overridden by a renderer draft.
function reviewedForm(route:TransferRoute,r:RemoteTransfer,review:TransferReview):TransferForm{
  return route==='correction'?{...defaultTransferForm(r),corrections:review.form.corrections}:review.form;
}
export function validateReview(route:TransferRoute,r:RemoteTransfer,review:TransferReview,hasApplication:boolean,hasReply:boolean){
  if(!flag(r.hand.IsReviewing))throw new Error('贝思兰德当前未授权本账号编辑此递交节点。');
  if(!review||!Array.isArray(review.keepCodes)||!review.form)throw new Error('核对表单无效。');
  if(new Set(review.keepCodes).size!==review.keepCodes.length||review.keepCodes.some(c=>!FIVE_PARTS.some(p=>p.code===c)))throw new Error('五书选择无效。');
  if(route==='application'&&(!hasApplication||review.keepCodes.length!==5))throw new Error('提出申请需要完整申请文件和五书。');
  if(!hasApplication&&review.keepCodes.some(c=>!existingTransferParts(r).some(p=>p.code===c&&p.available)))throw new Error('所选部分既没有本次申请文件，也不在服务端当前材料中。');
  const remoteHasReply=Boolean(r.form?.File?.FileNo||(r.form?.File?.FileName)||r.files.some(f=>/(意见陈述|陈述意见|答复|审查意见)/.test(String(f.FileName||f.FormName||''))||String(f.FileName||f.FormName||'').toLowerCase().endsWith('.docx')));
  if(route==='reply'&&!hasReply&&!remoteHasReply)throw new Error('尚未选择意见陈述书 Word。');
  const f=reviewedForm(route,r,review);
  if((route==='reply'||route==='correction'&&f.correctionReason===2)&&(!/^\d{4}-\d{2}-\d{2}$/.test(f.noticeDate)||!f.noticeName.trim()||!f.noticeNo.trim()))throw new Error(route==='correction'?'贝思兰德未提供完整关联通知信息，请刷新当前流程后重试。':'请核对通知书日期、名称和发文序号。');
  if(route==='correction'){
    validateCorrectionContents(f.corrections);
    if(!f.corrections.length)throw new Error('请核对至少一条补正内容：文件名称、具体位置、补正前和补正后。');
    const allowed=[...FIVE_PARTS.map(p=>p.name),'核苷酸或氨基酸序列表','其他',...(f.correctionReason===2?['请求书','授权委托书','主体资格证明']:[])];
    const seen=new Set<string>();
    for(const row of f.corrections){if(!allowed.includes(row.FileName)||![row.ChangeId,row.PositionInFile,row.CorrectionBefore,row.CorrectionAfter].every(v=>typeof v==='string'&&v.trim())||seen.has(row.ChangeId)||row.PositionInFile==='本次修改段落（请核对具体位置）')throw new Error('每条补正必须有唯一编号、文件、准确位置、补正前和补正后内容；请替换待核对的位置提示。');seen.add(row.ChangeId);}
  }
  if(route==='application'&&code(r.formCode)==='120101'&&!/^\d/.test(f.abstractFigure))throw new Error('摘要附图图号必须以数字开头。');
  if(!r.steps.some(s=>s.id===review.stepId&&s.users.some(u=>u.id===review.userId)))throw new Error('请选择服务端返回的下一流程与办理人。');
  if(typeof review.remark!=='string'||review.remark.length>1000)throw new Error('转交备注不能超过 1000 字。');
}

export function transferPayload(route:TransferRoute,r:RemoteTransfer,review:TransferReview,replyFile?:{FileNo:string;FileName:string}):Obj{
  const f=reviewedForm(route,r,review),old=r.form??{},base:Obj={...old,CaseHandId:r.handId,FormCode:r.formCode};
  if(route==='reply'){const opinion={...old.OpinionStatement};for(const key of ['NoticeDate1','NoticeDate2','NoticeDate3','NoticeName1','NoticeNo1','NoticeNo2','NoticeNo3'])delete opinion[key];return {...base,File:{...old.File,...replyFile},OpinionStatement:{...opinion,OpinionStatementType:1,NoticeDate:f.noticeDate,NoticeName:f.noticeName,NoticeNo:f.noticeNo,OpinionStatementContentType:0,IsUseOtherProveFileHand:f.otherProof,HasAddExperimentData:f.experimentData}};}
  if(route==='correction'){
    const {File:unusedFile,...correctionBase}=base;
    const contents=validateCorrectionContents(f.corrections);
    return {...correctionBase,Correction:{...old.Correction,CorrectionReasonType:f.correctionReason,IsAddEntrust:f.addEntrust,...(f.correctionReason===2?{NoticeDate:f.noticeDate,NoticeName:f.noticeName.replace(/通知书/g,''),NoticeNo:f.noticeNo}:{})},CorrectionContentList:contents.map((row,i)=>({...list(old.CorrectionContentList).find(saved=>saved.ChangeId===f.corrections[i].ChangeId),...row,ChangeId:f.corrections[i].ChangeId,Sort:i}))};
  }
  const declarations=Object.fromEntries(Object.keys(REQUEST_DECLARATIONS).map(k=>[k,f.declarations[k]===true]));
  return {...base,DivisionalCase:{...old.DivisionalCase},RequestInfo:{...old.RequestInfo,...declarations},SpecificationInfo:{...old.SpecificationInfo,AbstractDrawNumber:f.abstractFigure}};
}

function includesValues(actual:any,expected:any,key=''):boolean{
  if(key==='NoticeDate'&&typeof expected==='string'&&typeof actual==='string')return actual.slice(0,10)===expected.slice(0,10);
  if(expected==null||typeof expected!=='object')return String(actual??'')===String(expected??'');
  if(Array.isArray(expected))return Array.isArray(actual)&&expected.length===actual.length&&expected.every((v,i)=>includesValues(actual[i],v));
  return actual!=null&&Object.entries(expected).every(([k,v])=>includesValues(actual[k],v,k));
}
export type TransferUpload={name:string;bytes:Buffer};
export async function saveRemoteTransfer(input:{client:BaselandClient;processId:string;caseTitle:string;route:TransferRoute;remote:RemoteTransfer;review:TransferReview;application?:TransferUpload;reply?:TransferUpload;guard:()=>void;onWrite:()=>void;checkpoint:(message:string)=>Promise<void>;confirmName?:(details:{applicationName:string;caseName:string})=>Promise<boolean>}):Promise<RemoteTransfer>{
  const {client,route,review,remote:r,guard,checkpoint}=input;
  if(route!=='reply'&&input.reply)throw new Error('补正通过表单字段保存，不能上传补正说明文件。');
  validateReview(route,r,review,!!input.application,!!input.reply);
  const q=async(ep:string,body?:Obj,params?:Record<string,string>,kind:'data'|'list'='data')=>{guard();if(body||/^(Add|Delete)/.test(ep))input.onWrite();const result=await client.request('/CaseInfo/'+ep,body,params,undefined,kind);guard();if(body||/^(Add|Delete)/.test(ep))assertWriteResult(ep,result);return result;};
  const fresh=await readRemoteTransfer(client,input.processId,route);guard();
  if(!fresh||fresh.fingerprint!==r.fingerprint)throw new Error('服务端文件或流程已变化，请重新读取并核对。');
  const params={caseHandId:r.handId};
  const ensure=async(formCode:string)=>{
    const selected=(remote:RemoteTransfer)=>flag(remote.cards.find(c=>code(c.Code)===code(formCode))?.IsSelect);
    if(selected(fresh))return;
    const has=await q('IsHasCaseHandForm',undefined,{...params,formCode});
    if(has===true)return;
    if(has!==false)throw new Error('无法确认表单是否已选中，请刷新回读。');
    guard();input.onWrite();
    const added=await client.request('/CaseInfo/AddCaseHandForm',undefined,{...params,formCode});guard();
    // ExistsForm is not write success. Accept only a fresh, selected card on the
    // same hand and unchanged form; never repeat Add or bypass another business error.
    if(businessCode(added)!=='ExistsForm')assertWriteResult('AddCaseHandForm',added);
    const checked=await readRemoteTransfer(client,input.processId,route);guard();
    const createdBlank=businessCode(added)?.toLowerCase()==='success'&&!fresh.form&&!!checked?.form&&!checked.form.File?.FileNo&&!checked.form.OpinionStatement?.OpinionStatementText;
    if(!checked||checked.handId!==fresh.handId||JSON.stringify(checked.hand.CurrentFlowInfo)!==JSON.stringify(fresh.hand.CurrentFlowInfo)||flag(checked.hand.IsReviewing)!==flag(fresh.hand.IsReviewing)||(!createdBlank&&JSON.stringify(checked.form)!==JSON.stringify(fresh.form))||!selected(checked))throw new Error('表单选中状态或内容发生变化，请刷新回读后核对，已停止后续保存。');
    if(createdBlank&&code(formCode)===code(r.formCode))r.form=checked.form;
  };
  if(input.application){
    if(!r.instructionsCode)throw new Error('未找到申请原文卡片，不能上传拆分。');
    if(code(r.instructionsCode)!=='000000')await ensure(r.instructionsCode);
    guard();input.onWrite();const fileNo=await client.uploadDocument(input.application.name,input.application.bytes);guard();
    await checkpoint('申请文件已上传，等待本次材料解析。');
    const parsed=await q('UploadExistFileFormInstructionsAndImage',{FileNo:fileNo,CaseHandId:r.handId});
    const figure=review.form.abstractFigure?.trim()||'1';
    const parsedFiles=list(parsed?.FileList).map(f=>code(f.FormCode)==='100003'||f.FormName==='说明书附图'?{...f,AbstractDrawNumber:figure}:f);
    const requiredParts=route==='application'?FIVE_PARTS:FIVE_PARTS.filter(p=>review.keepCodes.includes(p.code));
    const expectedFiles=new Map(requiredParts.map(p=>{const matches=parsedFiles.filter(f=>String(f.FormName||f.FileName)===p.name);const no=matches[0]?.FileNo??matches[0]?.File?.FileNo;if(matches.length!==1||!id(no))throw new Error('贝思兰德未明确解析出本次所选部分，已停止保存：'+p.name);return [p.code,id(no)];}));
    await q('ModifyFormInstructionsAndImage',{CaseHandId:r.handId,IsUseXmlHand:true,FileList:parsedFiles,MixFile:{fileNo,fileName:input.application.name}});
    const card=await q('GetFormInstructionsAndImage',undefined,{...params,formCode:r.instructionsCode});
    const initialGroup=list(card?.FormGroup);
    for(const p of requiredParts){if(!initialGroup.some(g=>code(g.FormCode)===p.code&&id(g.File?.FileNo)===expectedFiles.get(p.code)))throw new Error('保存的五书不是本次解析文件，停止整理：'+p.name);}
    if(!initialGroup.some(g=>flag(g.IsMixFile)&&id(g.File?.FileNo)===fileNo))throw new Error('完整申请文件回读未匹配，停止整理。');
    const setting=card?.Setting??card?.InstructionsAndImageSetting??card??{};
    const showName=boolTri(setting.IsShowCaseName);
    if(showName===undefined)throw new Error('服务端未提供名称设置条件，停止设置，请刷新核对。');
    const specification=parsedFiles.find(f=>code(f.FormCode)==='100002'||f.FormName==='说明书');
    const caseName=showName?String(specification?.CaseName??'').trim():null;
    if(showName&&!caseName)throw new Error('未能从本次说明书解析出案件名称，请核对说明书抬头；文件已上传，尚未转交。');
    const endpoint=setting.CaseHandFormInstructionsAndImageSettingId?'UpdateFormInstructionsAndImageSetting':'InsertFormInstructionsAndImageSetting';
    const body={CaseHandFormInstructionsAndImageSettingId:setting.CaseHandFormInstructionsAndImageSettingId,CaseHandId:r.handId,IsUseXmlFormatHand:true,CaseName:caseName,HasConfirmCaseNameIsNotSame:false};
    guard();input.onWrite();
    let result=await client.request('/CaseInfo/'+endpoint,body);guard();
    if(businessCode(result)==='NeedConfirmCaseNameIsNotSame'){
      const snapshot=await readRemoteTransfer(client,input.processId,route);guard();
      if(!snapshot||digest(JSON.stringify(snapshot.instructions))!==digest(JSON.stringify(card)))throw new Error('设置请求后服务端材料或设置已变化，请重新核对。');
      await checkpoint('文件已上传；设置需要确认名称差异，尚未完成保存或转交。');
      if(!snapshot||!caseName||!input.confirmName||!await input.confirmName({applicationName:caseName,caseName:input.caseTitle}))throw new Error('未确认名称差异，设置未完成；此前文件可能已保存，尚未转交。');
      guard();const current=await readRemoteTransfer(client,input.processId,route);guard();
      if(!current||current.fingerprint!==snapshot.fingerprint)throw new Error('确认期间服务端材料或流程已变化，未重试设置，请重新核对。');
      input.onWrite();result=await client.request('/CaseInfo/'+endpoint,{...body,HasConfirmCaseNameIsNotSame:true});guard();
    }
    assertWriteResult(endpoint,result);
    const settingsCard=await q('GetFormInstructionsAndImage',undefined,{...params,formCode:r.instructionsCode});
    const checked=settingsCard?.Setting??settingsCard?.InstructionsAndImageSetting??settingsCard??{};
    if(!flag(checked.IsUseXmlFormatHand)||!id(checked.CaseHandFormInstructionsAndImageSettingId)||showName&&String(checked.CaseName??'').trim()!==caseName)throw new Error('五书设置回读未匹配，文件可能已保存，尚未转交。');
    const drawing=list(settingsCard?.FormGroup).find(g=>code(g.FormCode)==='100003');
    if(requiredParts.some(p=>p.code==='100003')&&String(drawing?.AbstractDrawNumber??'').trim()!==figure)throw new Error('指定摘要附图回读未匹配，文件已保存但尚未转交。');
    await checkpoint('五书 XML 设置、说明书名称及指定摘要附图已回读核对。');
    if(route!=='application'){
      for(const p of FIVE_PARTS.filter(p=>!review.keepCodes.includes(p.code)&&initialGroup.some(g=>code(g.FormCode)===p.code&&g.File?.FileNo)))await q('DeleteFormFile',undefined,{...params,formCode:p.code});
      await q('DeleteFormInstructionsAndImageMixFile',undefined,params);
    }
    const saved=await q('GetFormInstructionsAndImage',undefined,{...params,formCode:r.instructionsCode});
    const group=list(saved?.FormGroup);
    for(const p of FIVE_PARTS){const found=group.find(g=>code(g.FormCode)===p.code&&!!g.File?.FileNo);if(!!found!==review.keepCodes.includes(p.code)||found&&id(found.File.FileNo)!==expectedFiles.get(p.code))throw new Error('五书回读与本次文件或勾选不一致：'+p.name);}
    const mix=group.find(g=>flag(g.IsMixFile)&&g.File?.FileNo);
    if(route!=='application'&&mix||route==='application'&&(!mix||id(mix.File.FileNo)!==fileNo))throw new Error('完整申请文件保留状态与本次方案不一致。');
    await checkpoint('五书保存与本次文件保留范围已回读核对。');
  }
  if(!input.application&&route!=='application'&&r.instructionsCode){
    const group=list(r.instructions?.FormGroup);
    const removed=group.filter(g=>g.File?.FileNo&&(flag(g.IsMixFile)||FIVE_PARTS.some(p=>p.code===code(g.FormCode))&&!review.keepCodes.includes(code(g.FormCode))));
    if(removed.length){
      const current=await readRemoteTransfer(client,input.processId,route);guard();
      if(!current||current.fingerprint!==r.fingerprint)throw new Error('服务端材料或流程已变化，不能整理已有文件。');
      for(const g of removed)await q(flag(g.IsMixFile)?'DeleteFormInstructionsAndImageMixFile':'DeleteFormFile',undefined,flag(g.IsMixFile)?params:{...params,formCode:id(g.FormCode)});
      const saved=await q('GetFormInstructionsAndImage',undefined,{...params,formCode:r.instructionsCode});
      const actual=list(saved?.FormGroup);
      for(const p of FIVE_PARTS){const found=actual.find(g=>code(g.FormCode)===p.code&&g.File?.FileNo),previous=group.find(g=>code(g.FormCode)===p.code&&g.File?.FileNo);if(!!found!==review.keepCodes.includes(p.code)||found&&id(found.File.FileNo)!==id(previous?.File?.FileNo))throw new Error('服务端已有五书整理结果未匹配：'+p.name);}
      if(actual.some(g=>flag(g.IsMixFile)&&g.File?.FileNo))throw new Error('本次完整混合申请文件移除尚未确认。');
      await checkpoint('服务端已有五书已按本次勾选范围整理，完整混合文件已移除。');
    }
  }
  await ensure(r.formCode);
  let replyFile: {FileNo:string;FileName:string}|undefined;
  if(input.reply){guard();input.onWrite();replyFile={FileNo:await client.uploadDocument(input.reply.name,input.reply.bytes),FileName:input.reply.name};guard();}
  const payload=transferPayload(route,r,review,replyFile);
  const formExists=route==='application'?!!r.form?.RequestInfo:route==='reply'?!!r.form?.OpinionStatement:!!r.form?.Correction;
  await q(saveEndpoint(route,formExists),payload);
  const savedForm=await q(GET_FORM[route],undefined,params);
  const verify=route==='reply'?{File:{FileNo:replyFile?.FileNo},OpinionStatement:payload.OpinionStatement}:route==='correction'?{Correction:payload.Correction,CorrectionContentList:payload.CorrectionContentList}:{RequestInfo:payload.RequestInfo,SpecificationInfo:payload.SpecificationInfo,DivisionalCase:payload.DivisionalCase};
  if(!includesValues(savedForm,verify))throw new Error('业务表单回读不一致，不能转交。');
  await checkpoint('业务表单已保存并通过专用接口回读。');
  const after=await readRemoteTransfer(client,input.processId,route);guard();if(!after||after.handId!==r.handId)throw new Error('保存后递交实例发生变化。');return after;
}

export function matchesNextFlow(hand:Obj|null|undefined,handId:string|undefined,step:{id:string;name:string}|undefined,user:{id:string;name:string}|undefined):boolean{
  if(!hand||!step||!user)return false;
  const cur=hand.CurrentFlowInfo as Obj|undefined;
  if(!cur)return false;
  if(handId&&id(hand.HandInfo?.CaseHandId)&&id(hand.HandInfo?.CaseHandId)!==handId)return false;
  const stepMatched=(Boolean(step.id)&&id(cur.CaseHandStepId)===step.id)||(isEmptyGuid(cur.CaseHandStepId)&&Boolean(step.name)&&clean(cur.FlowNodeName)===clean(step.name));
  const userMatched=(Boolean(user.id)&&id(cur.FlowUserId)===user.id)||(isEmptyGuid(cur.FlowUserId)&&Boolean(user.name)&&clean(cur.FlowUserName)===clean(user.name));
  return Boolean(stepMatched&&userMatched);
}

export async function submitRemoteTransfer(client:BaselandClient,processId:string,route:TransferRoute,r:RemoteTransfer,review:TransferReview,guard:()=>void,onSend?:()=>Promise<void>){
  const fresh=await readRemoteTransfer(client,processId,route);guard();
  if(!fresh||fresh.fingerprint!==r.fingerprint)throw new Error('保存后服务端流程或材料已变化，请重新核对。');
  if(!flag(fresh.hand.IsReviewing))throw new Error('当前账号已不能办理此节点，请刷新流程。');
  const step=fresh.steps.find(s=>s.id===review.stepId),user=step?.users.find(u=>u.id===review.userId);
  if(!step||!user)throw new Error('下一办理人已不在候选列表中。');
  if(id(fresh.hand.CurrentFlowInfo?.CaseHandStepId)===step.id&&id(fresh.hand.CurrentFlowInfo?.FlowUserId)===user.id)throw new Error('当前已位于所选节点和办理人，请核对流程，不能重复转交。');
  await onSend?.();guard();
  const result=await client.request('/CaseInfo/SubmitHandFlow',{CaseHandId:r.handId,IsOutSideSend:false,CaseHandStepId:step.id,NextFlowUserid:user.id,CCUserIdList:[],Remark:review.remark});guard();assertWriteResult('SubmitHandFlow',result);
  let hand=await client.request('/CaseInfo/GetHandInfo',undefined,{caseProcId:processId});guard();
  let matched=matchesNextFlow(hand,r.handId,step,user);
  if(!matched){
    await new Promise(res=>setTimeout(res,300));guard();
    hand=await client.request('/CaseInfo/GetHandInfo',undefined,{caseProcId:processId});guard();
    matched=matchesNextFlow(hand,r.handId,step,user);
  }
  if(!matched)throw new Error('已发送内部转交请求，但下一节点回读未匹配；请刷新核对，不要重复转交。');
  return {node:(hand?.CurrentFlowInfo?.FlowNodeName as string)||step.name,user:(hand?.CurrentFlowInfo?.FlowUserName as string)||user.name};
}

export async function clearRemoteTransfer(
  client: BaselandClient,
  processId: string,
  route: TransferRoute,
  guard: () => void,
): Promise<RemoteTransfer | null> {
  guard();
  const r = await readRemoteTransfer(client, processId, route);
  guard();
  if (!r || !r.handId) return null;
  if (!flag(r.hand.IsReviewing)) throw new Error('贝思兰德当前未授权本账号编辑此递交节点，无法清空材料。');

  const params = { caseHandId: r.handId };
  const q = async (ep: string, body?: Obj, p?: Record<string, string>, kind: 'data' | 'list' = 'data') => {
    guard();
    const res = await client.request('/CaseInfo/' + ep, body, p, undefined, kind);
    guard();
    return res;
  };

  // 1. Delete InstructionsAndImage mix file if exists
  try {
    await q('DeleteFormInstructionsAndImageMixFile', undefined, params);
  } catch {}

  // 2. Delete five parts if exist
  if (r.instructions?.FormGroup) {
    const group = list(r.instructions.FormGroup);
    for (const g of group) {
      if (g.File?.FileNo && g.FormCode) {
        try {
          await q('DeleteFormFile', undefined, { ...params, formCode: id(g.FormCode) });
        } catch {}
      }
    }
  }

  // 3. If reply route, reset opinion statement form file or call DeleteFormFile
  if (route === 'reply' && r.formCode) {
    try {
      await q('DeleteFormFile', undefined, { ...params, formCode: '100012' });
    } catch {}
    if (r.form?.OpinionStatement) {
      try {
        const payload = {
          CaseHandId: r.handId,
          FormCode: 100012,
          File: null,
          OpinionStatement: {
            ...r.form.OpinionStatement,
            OpinionStatementContentType: 0,
          },
        };
        await q(saveEndpoint('reply', true), payload);
      } catch {}
    }
  }

  // 4. If correction route, clear correction rows
  if (route === 'correction' && r.form?.Correction) {
    try {
      const payload = {
        CaseHandId: r.handId,
        FormCode: 100006,
        Correction: r.form.Correction,
        CorrectionContentList: [],
      };
      await q(saveEndpoint('correction', true), payload);
    } catch {}
  }

  // Re-read remote transfer to verify
  const after = await readRemoteTransfer(client, processId, route);
  guard();
  return after;
}
