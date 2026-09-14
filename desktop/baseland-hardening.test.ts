import test from 'node:test';
import assert from 'node:assert/strict';
import { BaselandClient } from './baseland.ts';
import { assertWriteResult } from './baseland-results.ts';
import { Server } from './test-support/transfer-server.ts';
import { readRemoteTransfer, defaultTransferForm, saveRemoteTransfer, submitRemoteTransfer } from './baseland-transfer.ts';
import { FIVE_PARTS } from '../src/transfer-api.ts';
import { processBusinessKind } from '../src/domain/lifecycle.ts';
async function setup(){
 const client=new Server();const remote=(await readRemoteTransfer(client,'proc-1','application'))!;
 const review={keepCodes:FIVE_PARTS.map(p=>p.code),form:defaultTransferForm(remote),stepId:'step-1',userId:'user-1',remark:''};review.form.abstractFigure='1';
 return {client,remote,review,route:'application' as const,processId:'proc-1',caseTitle:'本地案件',application:{name:'full.docx',bytes:Buffer.from('synthetic')},guard:()=>{},onWrite:()=>{},checkpoint:async()=>{}};
}
test('endpoint results accept only explicit contracts; read transport remains unchanged',async()=>{
 for(const value of [true,undefined,null,0,{},'Unknown',{Result:'Denied'}])assert.throws(()=>assertWriteResult('SubmitHandFlow',value));
 assertWriteResult('StartHand','AlreadyStarted');assert.throws(()=>assertWriteResult('SubmitHandFlow','AlreadyStarted'));
 assert.throws(()=>assertWriteResult('StartHand','NeedConfirmReStart'),/不会自动重启/);
 assertWriteResult('SubmitHandFlow',{Result:'Success'});assertWriteResult('DeleteFormFile','success');
 const client=new BaselandClient('https://test.baselandtec.com','',async()=>Response.json({IsSuccess:true,Data:{Result:0,Token:'synthetic'}}));
 assert.deepEqual(await client.request('/Auth/GetToken',{}),{Result:0,Token:'synthetic'});
});
test('hidden case name stays null; rejected settings stop subsequent form writes',async()=>{
 const input=await setup();const original=input.client.request.bind(input.client);let body:any;
 input.client.request=async(ep,b,p)=>{if(ep.endsWith('FormInstructionsAndImageSetting')){body=b;return 'NeedConfirmCaseNameIsNotSame';}return original(ep,b,p);};
 await assert.rejects(saveRemoteTransfer(input),/未确认名称差异/);
 assert.equal(body.CaseName,null);assert.equal(body.HasConfirmCaseNameIsNotSame,false);assert.equal(input.client.form,null);
});
test('success code without persisted XML settings cannot pass readback',async()=>{
 const input=await setup();input.client.setting.IsUseXmlFormatHand=false;
 input.remote=(await readRemoteTransfer(input.client,'proc-1','application'))!;
 const original=input.client.request.bind(input.client);
 input.client.request=async(ep,b,p)=>ep.endsWith('FormInstructionsAndImageSetting')?'Success':original(ep,b,p);
 await assert.rejects(saveRemoteTransfer(input),/设置回读/);assert.equal(input.client.form,null);
});
for(const answer of [false,true])test(`name confirmation ${answer?'retries settings only':'declines without retry'}`,async()=>{
 const input=await setup();input.client.setting.IsShowCaseName=true;input.client.setting.CaseName='申请文件名称';
 input.remote=(await readRemoteTransfer(input.client,'proc-1','application'))!;
 const original=input.client.request.bind(input.client);const attempts:any[]=[];
 input.client.request=async(ep,b,p)=>{if(ep.endsWith('FormInstructionsAndImageSetting')){attempts.push(b);if(!b.HasConfirmCaseNameIsNotSame)return 'NeedConfirmCaseNameIsNotSame';}return original(ep,b,p);};
 const task=saveRemoteTransfer({...input,confirmName:async details=>{assert.equal(details.applicationName,'说明书抬头名称');return answer;}});
 if(answer)await task;else await assert.rejects(task,/未确认/);
 assert.equal(attempts.length,answer?2:1);assert.equal(input.client.serial,1);
 assert.equal(attempts[0].HasConfirmCaseNameIsNotSame,false);
 if(answer)assert.equal(attempts[1].HasConfirmCaseNameIsNotSame,true);
});
test('server changes while confirming prevent retry',async()=>{
 const input=await setup();input.client.setting.IsShowCaseName=true;
 input.remote=(await readRemoteTransfer(input.client,'proc-1','application'))!;
 const original=input.client.request.bind(input.client);let attempts=0;
 input.client.request=async(ep,b,p)=>{if(ep.endsWith('FormInstructionsAndImageSetting')){attempts++;return 'NeedConfirmCaseNameIsNotSame';}return original(ep,b,p);};
 await assert.rejects(saveRemoteTransfer({...input,confirmName:async()=>{input.client.flowInfo.FlowUserId='changed';return true;}}),/确认期间/);assert.equal(attempts,1);
});
test('official send status comes from send endpoint; null with false remains editable',async()=>{
 const client=new Server(),original=client.request.bind(client);
 for(const status of [2,6,1,100]){
  client.request=async(ep,b,p)=>ep.endsWith('GetCaseHandSendInfo')?{SendStatus:status}:original(ep,b,p);
  await assert.rejects(readRemoteTransfer(client,'proc-1','application'),/递交|提交/);
 }
 client.request=async(ep,b,p)=>ep.endsWith('GetCaseHandSendInfo')?null:original(ep,b,p);
 assert.ok(await readRemoteTransfer(client,'proc-1','application'));
});
test('same recipient name with wrong ID cannot confirm internal handoff',async()=>{
 const input=await setup();const remote=await saveRemoteTransfer(input);const original=input.client.request.bind(input.client);
 input.client.request=async(ep,b,p)=>{const result=await original(ep,b,p);if(ep.endsWith('SubmitHandFlow'))input.client.flowInfo.FlowUserId='different-user';return result;};
 await assert.rejects(submitRemoteTransfer(input.client,'proc-1','application',remote,input.review,()=>{}),/回读未匹配/);
});
test('AddCaseHandForm success must be followed by selected-state verification',async()=>{
 const input=await setup();const original=input.client.request.bind(input.client);
 input.client.request=async(ep,b,p)=>ep.endsWith('IsHasCaseHandForm')?false:ep.endsWith('AddCaseHandForm')?'Success':original(ep,b,p);
 await assert.rejects(saveRemoteTransfer(input),/表单选中状态/);assert.equal(input.client.form,null);
});
test('cancel application is external; normal application and reply remain unchanged',()=>{
 assert.equal(processBusinessKind('取消提出申请'),undefined);
 assert.equal(processBusinessKind('提出申请'),'write');assert.equal(processBusinessKind('答复审查意见'),'reply');
});
for(const duplicate of [false,true])test(`count mismatch ${duplicate?'with repeated pages':'with early empty page'} never silently completes`,async()=>{
 const client=new BaselandClient('https://test.baselandtec.com','',async(url,init)=>{
  const body=JSON.parse(String(init?.body));
  return Response.json({IsSuccess:true,Data:String(url).includes('GetPersonalCaseCount')?2:body.PagedInfo.pageIndex===1||duplicate?[{CaseProcId:'one'}]:[]});
 });
 await assert.rejects(client.personalCases(new AbortController().signal),/数量与分页结果不一致/);
});
test('a count change retries boundedly and imports only the consistent snapshot',async()=>{
 let counts=0;const client=new BaselandClient('https://test.baselandtec.com','',async(url,init)=>{
  const body=JSON.parse(String(init?.body));const active=body.ActiveName==='waitHand';
  const count=String(url).includes('GetPersonalCaseCount');
  return Response.json({IsSuccess:true,Data:count?(active?(++counts===1?2:1):0):active?[{CaseProcId:'one'}]:[]});
 });
 const rows=await client.personalCases(new AbortController().signal);assert.equal(rows.length,1);assert.equal(counts,4);
});

test('upload must not accept a file number accompanying an explicit business failure',async()=>{
 const client=new BaselandClient('https://test.baselandtec.com','',async()=>Response.json({IsSuccess:true,Data:{FileNo:'existing',Result:'Denied'}}));
 await assert.rejects(client.uploadDocument('synthetic.docx',Buffer.from('x')),/上传成功/);
});

test('unknown official status cannot fall back to editable through a false success flag',async()=>{
 const client=new Server(),original=client.request.bind(client);
 client.request=async(ep,b,p)=>ep.endsWith('GetCaseHandSendInfo')?{SendStatus:999}:original(ep,b,p);
 await assert.rejects(readRemoteTransfer(client,'proc-1','application'),/状态值尚未识别/);
});
