import { BaselandClient } from '../baseland.ts';
import { FIVE_PARTS } from '../../src/transfer-api.ts';
export class Server extends BaselandClient {
  calls:Array<{endpoint:string;body?:any;params?:Record<string,string>}>=[];
  form:any=null;group:any[]=[];flowInfo:Record<string,string>={FlowNodeName:'文件准备',FlowUserName:'测试用户',CaseHandStepId:'initial',FlowUserId:'initial'};next='下一内部流程';handId='hand-1';serial=0;badReadback=false;badRecipient=false;canEdit=true;nextUsers:Array<{value:string;label:string}>=[{value:'user-1',label:'杨佳'}];
  setting:any={CaseHandFormInstructionsAndImageSettingId:'setting-1',CaseName:'合成案件',IsShowCaseName:false,IsUseXmlFormatHand:true};
  notice:any={PostDate:'2026-09-10T00:00:00',NoticeName:'第一次审查意见通知书',FaWenXLH:'NOTICE-QA'};
  parsedCodes:string[]=FIVE_PARTS.map(p=>p.code);
  constructor(){super('https://test.baselandtec.com');}
  override async request(endpoint:string,body?:any,params?:Record<string,string>){
    this.calls.push({endpoint,body:structuredClone(body),params});const ep=endpoint.split('/').at(-1);
    if(ep==='GetCaseHandSendInfo')return null;
    if(ep==='GetHandInfo')return {HandInfo:{CaseHandId:this.handId},IsPackageSendSuccess:false,IsReviewing:this.canEdit,CurrentFlowInfo:this.flowInfo};
    if(ep==='GetOfficialFormList')return [...FIVE_PARTS.map(p=>({Code:Number(p.code),FormName:p.name,IsSelect:this.group.some(g=>String(g.FormCode)===p.code)})),{Code:100012,FormName:'意见陈述书',IsSelect:!!this.form},{Code:100006,FormName:'补正书',IsSelect:!!this.form},{Code:120101,FormName:'实用新型请求书',IsSelect:!!this.form}];
    if(ep==='GetCaseHandProcRelateNoticeInfo')return structuredClone(this.notice);
    if(ep==='GetHandNextFlowList')return [{CaseHandStepId:'step-1',Name:this.next,IsFinish:false}];
    if(ep==='GetHandNextFlowUserByStepId')return structuredClone(this.nextUsers);
    if(ep==='GetCaseHandFileList')return this.group.filter(g=>g.File).map(g=>g.File);
    if(ep==='GetFormInstructionsAndImage')return {FormGroup:structuredClone(this.group),...structuredClone(this.setting)};
    if(['GetFormOpinionStatement','GetFormCorrection','GetFormPatentRequestInfo'].includes(ep!))return this.badReadback&&this.form?{...this.form,File:{FileNo:'wrong'},CorrectionContentList:[]}:structuredClone(this.form);
    if(ep==='IsHasCaseHandForm')return true;
    if(ep==='UploadExistFileFormInstructionsAndImage')return {Result:'Success',FileList:FIVE_PARTS.filter(p=>this.parsedCodes.includes(p.code)).map(p=>({FormName:p.name,FormCode:Number(p.code),FileNo:'split-'+p.code,CaseName:p.code==='100002'?'说明书抬头名称':undefined,Untouched:'preserve'}))};
    if(ep==='ModifyFormInstructionsAndImage'){this.group=[...body.FileList.map((f:any)=>({FormCode:f.FormCode,AbstractDrawNumber:f.AbstractDrawNumber,File:{FileNo:f.FileNo,FileName:f.FormName+'.docx'}})),{IsMixFile:true,File:{FileNo:body.MixFile.fileNo,FileName:body.MixFile.fileName}}];return 'Success';}
    if(ep==='UpdateFormInstructionsAndImageSetting'||ep==='InsertFormInstructionsAndImageSetting'){this.setting={...this.setting,...body,CaseHandFormInstructionsAndImageSettingId:'setting-1'};return 'Success';}
    if(ep==='DeleteFormFile'){this.group=this.group.filter(f=>String(f.FormCode)!==params?.formCode);return 'Success';}
    if(ep==='DeleteFormInstructionsAndImageMixFile'){this.group=this.group.filter(f=>!f.IsMixFile);return 'Success';}
    if(ep==='InsertFromPatentRequestInfo'||/^(Insert|Update).*Form(Opinion|Correction|Patent)/.test(ep!)){this.form=structuredClone(body);return 'Success';}
    if(ep==='SubmitHandFlow'){this.flowInfo={FlowNodeName:this.next,FlowUserName:this.badRecipient?'其他人':'杨佳',CaseHandStepId:'step-1',FlowUserId:this.badRecipient?'other-user':'user-1'};return 'Success';}
    throw new Error('Unexpected endpoint '+ep);
  }
  override async uploadDocument(){return 'upload-'+(++this.serial);}
}
