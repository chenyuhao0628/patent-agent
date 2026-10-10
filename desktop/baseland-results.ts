import { officialMessages } from './baseland-messages.ts';
// Result contracts belong to write endpoints, not the shared read transport.
export function businessCode(value:unknown):string|undefined {
  if(typeof value==='string')return value;
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const v=value as Record<string,unknown>;
    return typeof v.Result==='string'?v.Result:typeof v.ResultType==='string'?v.ResultType:undefined;
  }
  return undefined;
}
const writes=new Set(['StartHand','AddCaseHandForm','DeleteFormFile','DeleteFormInstructionsAndImageMixFile','ModifyFormInstructionsAndImage','UploadExistFileFormInstructionsAndImage','UploadFormFile','InsertFormInstructionsAndImageSetting','UpdateFormInstructionsAndImageSetting','InsertFromPatentRequestInfo','UpdateFormPatentRequestInfo','InsertFormOpinionStatement','UpdateFormOpinionStatement','InsertFormCorrection','UpdateFormCorrection','SubmitHandFlow']);
const tables:Record<string,string>={StartHand:'start',SubmitHandFlow:'submit',AddCaseHandForm:'selectForm',DeleteFormFile:'deleteFile',InsertFromPatentRequestInfo:'requestForm',UpdateFormPatentRequestInfo:'requestForm',InsertFormInstructionsAndImageSetting:'setting',UpdateFormInstructionsAndImageSetting:'setting'};
for(const endpoint of ['UploadExistFileFormInstructionsAndImage','UploadFormFile','ModifyFormInstructionsAndImage','DeleteFormInstructionsAndImageMixFile'])tables[endpoint]='deleteFile';
export type BusinessResultKind='busy'|'prerequisite'|'confirmation'|'failure'|'unknown';
export class BaselandBusinessError extends Error {
  kind:BusinessResultKind;
  constructor(message:string,kind:BusinessResultKind){super(message);this.name='BaselandBusinessError';this.kind=kind;}
}
const needsPack=new Set(['NotPack','NotPackSuccess','NeedRePack','NeedRePackForApplicantChange','NeedRePackForInventorChange','NeedRePackForCaseChange','NeedRepackForFormChanged']);
const busy=new Set(['IsPacking','IsSending','Handing','IsInEntrusting']);
const manualRetry='处理完成后先点击“刷新回读”，核对材料、流程及接收人，再手动转交；不会自动重试。';
export function assertWriteResult(endpoint:string,value:unknown):void {
  const ep=endpoint.split('/').at(-1)!;
  if(!writes.has(ep))throw new Error('尚未定义此写接口的业务结果校验。');
  const code=businessCode(value);
  if(code?.toLowerCase()==='success'||ep==='StartHand'&&code==='AlreadyStarted')return;
  const table=tables[ep];
  let reason=code&&table?officialMessages[table]?.[code]:undefined;
  let kind:BusinessResultKind=reason?'failure':'unknown',action='请在贝思兰德核对并处理原因，再读取最新状态，重新核对本次方案。此前文件可能已保存。';
  if(table==='setting'&&code==='NeedConfirmCaseNameIsNotSame'){
    reason='申请文件名称与系统案件名称不一致，尚未确认保存。';kind='confirmation';action='请核对名称差异后由操作者决定，本应用不会自动确认。';
  }else if(reason&&ep==='SubmitHandFlow'){
    if(busy.has(code!)){kind='busy';action='请等待当前处理结束。'+manualRetry;}
    else if(needsPack.has(code!)){kind='prerequisite';action='请在贝思兰德核对本次材料并完成必要的打包；打包不等于递交官方。'+manualRetry;}
    else if(code==='NeedConfirmForRepack'){kind='confirmation';action='请在贝思兰德核对材料变动及前置校验，由操作者决定是否继续；本应用不会自动确认或打包。';}
    else if(['NoPassVerifyBeforeCaseHand','NoPassVerifyBeforeSubmit','OtherCountryNoHandFile'].includes(code!)){kind='prerequisite';action='请在贝思兰德查看校验详情，核对并补齐本次材料。'+manualRetry;}
    else if(code==='CannotBackForWaitSend'){action='请先核对官方递交状态，是否取消必须由操作者另行决定；本应用不会自动取消递交。';}
  }else if(reason&&ep==='StartHand'){
    if(code==='NeedConfirmReStart'){kind='confirmation';action='请在贝思兰德核对当前实例和官方递交状态，由操作者决定是否重新启动；本应用不会自动重启。';}
    else if(code==='Handing'){kind='busy';action='请稍后刷新核对是否已生成实例；结果未确认前不要重复启动。';}
  }else if(reason&&table==='deleteFile'){
    if(code==='ImageNonConformance'){reason='说明书附图尺寸超过 165mm × 245mm。';action='具体附图位置未取得，请在贝思兰德查看校验详情，调整对应附图尺寸后重新核对材料。';}
    else if(code==='ParagraphEndSpaceOverLong'){action='请检查并清理 Word 段落末尾连续空格，保存修订副本后重新选择并核对材料；保留原件。';}
    else if(code==='InvalidFileFormat'){action='请使用受支持的 Word 文件重新核对材料，不能只修改扩展名。';}
    else if(code==='VerifyPdfImageError'){action='请在贝思兰德查看具体附图校验详情，修正文件后重新核对材料。';}
  }else if(reason&&table==='requestForm'){
    action='请核对案件资料及请求书对应栏位；只有事实符合时才修改勾选，不能为通过校验自动勾选。修改后重新核对本次方案。';
  }
  if(reason){
    // Do not interpolate arbitrary server payload or show unresolved placeholders.
    const hasPlaceholders=/\{\d+\}/.test(reason);
    reason=reason.replace(/\{\d+\}/g,'（具体值未取得）');
    throw new BaselandBusinessError(reason+' '+(hasPlaceholders?'请在贝思兰德查看具体值。':'')+action,kind);
  }
  if(code==='NoAuthority'&&table)throw new BaselandBusinessError('当前账号无操作权限，请刷新核对账号和办理节点；本应用不会自动变更权限。','failure');
  const stages:Record<string,string>={UploadExistFileFormInstructionsAndImage:'申请文件解析',UploadFormFile:'申请分件关联保存',ModifyFormInstructionsAndImage:'合并申请文件关联保存'};
  const detail=stages[ep]?`${stages[ep]}未通过（${code&&/^[A-Za-z][A-Za-z0-9_]{0,70}$/.test(code)?code:'未返回有效业务结果'}）。`:'';
  throw new BaselandBusinessError(detail+'服务端未确认本次操作成功，结果待核验；已发出的请求可能已生效，请先刷新核对，勿直接重复执行。','unknown');
}
