import { Server } from './test-support/transfer-server.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BaselandClient } from './baseland.ts';
import { defaultTransferForm, readRemoteTransfer, saveRemoteTransfer, submitRemoteTransfer, transferPayload, validateReview } from './baseland-transfer.ts';
import { FIVE_PARTS } from '../src/transfer-api.ts';
import type { TransferReview, TransferRoute } from '../src/transfer-api.ts';


async function setup(route:TransferRoute){const client=new Server(),remote=(await readRemoteTransfer(client,'proc-1',route))!;const review:TransferReview={keepCodes:route==='application'?FIVE_PARTS.map(p=>p.code):['100001'],form:defaultTransferForm(remote),stepId:'step-1',userId:'user-1',remark:'合成验收'};review.form.abstractFigure='1';return {client,remote,review};}
const guard=()=>{};
test('reply saves exact specialized form, prunes only current unselected parts and mix, then verifies internal recipient',async()=>{
  const {client,remote,review}=await setup('reply');
  const result=await saveRemoteTransfer({client,remote,review,route:'reply',processId:'proc-1',caseTitle:'合成案件',application:{name:'完整稿.docx',bytes:Buffer.from('synthetic')},reply:{name:'意见.docx',bytes:Buffer.from('synthetic reply')},guard,onWrite:()=>{},checkpoint:async()=>{}});
  assert.deepEqual(client.group.map(g=>String(g.FormCode)),['100001']);
  assert.equal(client.form.OpinionStatement.NoticeNo,'NOTICE-QA');
  assert.equal(client.form.File.FileNo,'upload-2');
  assert.equal(client.calls.find(c=>c.endpoint.endsWith('ModifyFormInstructionsAndImage'))!.body.FileList[0].Untouched,'preserve');
  assert.equal(client.calls.some(c=>c.endpoint.endsWith('/SubmitHandFlow')),false);
  const submitted=await submitRemoteTransfer(client,'proc-1','reply',result,review,guard);
  assert.equal(submitted.user,'杨佳');
  assert.equal(client.calls.some(c=>/StartCaseHandSend|VerifyBeforeCaseHand|\/StartPack$/.test(c.endpoint)),false);
});
test('application retains five split parts and mixed original; correction preserves IDs and fields',async()=>{
  const {client,remote,review}=await setup('application');
  await saveRemoteTransfer({client,remote,review,route:'application',processId:'proc-1',caseTitle:'合成案件',application:{name:'完整稿.docx',bytes:Buffer.from('synthetic')},guard,onWrite:()=>{},checkpoint:async()=>{}});
  assert.equal(client.group.length,6);assert.ok(client.group.some(g=>g.IsMixFile));
  const c=await setup('correction');c.remote.form={Correction:{CaseHandCorrectionId:'existing',OtherField:'keep'},CorrectionContentList:[]};
  c.review.form.corrections=[{ChangeId:'row',Sort:0,FileName:'权利要求书',PositionInFile:'权利要求 1',CorrectionBefore:'原文',CorrectionAfter:'修改'}];
  validateReview('correction',c.remote,c.review,true,false);
  const payload=transferPayload('correction',c.remote,c.review);
  assert.equal(payload.Correction.CaseHandCorrectionId,'existing');assert.equal(payload.Correction.OtherField,'keep');assert.equal(payload.Correction.NoticeName,'第一次审查意见');
});
test('stale remote data and invalid recipient block before writes; bad readback never permits internal submission',async()=>{
  const {client,remote,review}=await setup('reply');client.flowInfo.FlowNodeName='changed';let wrote=false;
  await assert.rejects(saveRemoteTransfer({client,remote,review,route:'reply',processId:'proc-1',caseTitle:'合成案件',application:{name:'full',bytes:Buffer.from('x')},reply:{name:'reply',bytes:Buffer.from('x')},guard,onWrite:()=>{wrote=true;},checkpoint:async()=>{}}),/变化/);
  assert.equal(wrote,false);
  assert.throws(()=>validateReview('reply',remote,{...review,userId:'not-eligible'},true,true),/服务端/);
  const next=await setup('reply');next.client.badReadback=true;
  await assert.rejects(saveRemoteTransfer({...next,route:'reply',processId:'proc-1',caseTitle:'合成案件',application:{name:'full',bytes:Buffer.from('x')},reply:{name:'reply',bytes:Buffer.from('x')},guard,onWrite:()=>{},checkpoint:async()=>{}}),/回读不一致/);
  assert.equal(next.client.calls.some(c=>c.endpoint.endsWith('SubmitHandFlow')),false);
});

test('reply without a new application still prunes only human-reviewed current server parts and mixed file',async()=>{
  const client=new Server();client.group=[...FIVE_PARTS.map(p=>({FormCode:Number(p.code),File:{FileNo:'existing-'+p.code,FileName:p.name}})),{IsMixFile:true,File:{FileNo:'existing-mix'}}];
  const remote=(await readRemoteTransfer(client,'proc-1','reply'))!;assert.equal(remote.instructionsCode,'000000');
  const review={keepCodes:['100001'],form:defaultTransferForm(remote),stepId:'step-1',userId:'user-1',remark:''};
  await saveRemoteTransfer({client,remote,review,route:'reply',processId:'proc-1',caseTitle:'合成案件',reply:{name:'reply.docx',bytes:Buffer.from('test')},guard,onWrite:()=>{},checkpoint:async()=>{}});
  assert.deepEqual(client.group.map(g=>g.File.FileNo),['existing-100001']);
  assert.equal(client.calls.some(c=>c.endpoint.endsWith('ModifyFormInstructionsAndImage')),false);
});

test('server editing permission is required before uploads even for the case undertaker',async()=>{
 const {client,review}=await setup('reply');client.canEdit=false;const remote=(await readRemoteTransfer(client,'proc-1','reply'))!;let wrote=false;
 await assert.rejects(saveRemoteTransfer({client,remote,review,route:'reply',processId:'proc-1',caseTitle:'合成案件',reply:{name:'reply.docx',bytes:Buffer.from('x')},guard,onWrite:()=>{wrote=true;},checkpoint:async()=>{}}),/未授权/);
 assert.equal(wrote,false);
});

const correctionRow={ChangeId:'existing-row',Sort:0,FileName:'权利要求书',PositionInFile:'权利要求 1',CorrectionBefore:'原有限位组件',CorrectionAfter:'限位组件'};
test('correction saves four fields with server metadata, preserves IDs, and never uploads a supplementary Word',async()=>{
 const client=new Server();client.form={Correction:{CaseHandCorrectionId:'server-id',CorrectionReasonType:2,IsAddEntrust:true,ServerField:'keep'},CorrectionContentList:[{...correctionRow,ServerRowId:'row-id'}]};
 const remote=(await readRemoteTransfer(client,'proc-1','correction'))!;
 const review:TransferReview={keepCodes:[],form:{...defaultTransferForm(remote),noticeDate:'',noticeName:'',noticeNo:'',correctionReason:1,addEntrust:false,corrections:[{...correctionRow,CorrectionAfter:'固定连接的限位组件'}]},stepId:'step-1',userId:'user-1',remark:''};
 const input={client,remote,review,route:'correction' as const,processId:'proc-1',caseTitle:'字段验收',guard,onWrite:()=>{},checkpoint:async()=>{}};
 await saveRemoteTransfer(input);
 assert.equal(client.serial,0);assert.equal(client.form.File,undefined);
 assert.equal(client.form.Correction.CaseHandCorrectionId,'server-id');assert.equal(client.form.Correction.ServerField,'keep');
 assert.equal(client.form.Correction.CorrectionReasonType,2);assert.equal(client.form.Correction.IsAddEntrust,true);
 assert.equal(client.form.Correction.NoticeDate,'2026-09-10');assert.equal(client.form.Correction.NoticeName,'第一次审查意见');assert.equal(client.form.Correction.NoticeNo,'NOTICE-QA');
 assert.deepEqual(client.form.CorrectionContentList,[{...correctionRow,ServerRowId:'row-id',CorrectionAfter:'固定连接的限位组件'}]);
 assert(client.calls.some(c=>c.endpoint.endsWith('UpdateFormCorrection')));
 assert(!client.calls.some(c=>/SubmitHandFlow|Upload/.test(c.endpoint)));
 const n=client.calls.length;
 await assert.rejects(saveRemoteTransfer({...input,reply:{name:'补正说明.docx',bytes:Buffer.from('rejected')}}),/不能上传补正说明/);
 assert.equal(client.serial,0);assert.equal(client.calls.length,n);
});

test('new correction uses related notice automatically; absent notice, stale metadata, or failed content readback block',async()=>{
 const {client,remote,review}=await setup('correction');review.keepCodes=[];review.form.corrections=[correctionRow];
 const input={client,remote,review,route:'correction' as const,processId:'proc-1',caseTitle:'补正',guard,onWrite:()=>{},checkpoint:async()=>{}};
 client.notice.FaWenXLH='changed';await assert.rejects(saveRemoteTransfer(input),/变化/);assert.equal(client.form,null);
 client.notice=null;const missing=(await readRemoteTransfer(client,'proc-1','correction'))!;
 assert.throws(()=>validateReview('correction',missing,review,false,false),/贝思兰德未提供/);
 client.notice=remote.notice;client.badReadback=true;await assert.rejects(saveRemoteTransfer(input),/业务表单回读不一致/);
 assert(client.calls.some(c=>c.endpoint.endsWith('InsertFormCorrection')));assert.equal(client.serial,0);
 assert(!client.calls.some(c=>c.endpoint.endsWith('SubmitHandFlow')));
});

test('reply and correction accept only the selected parsed parts; missing selected parts and incomplete new applications stop before saving',async()=>{
 for(const route of ['reply','correction','application'] as const){
  const {client,remote,review}=await setup(route);client.parsedCodes=['100001'];review.form.corrections=[correctionRow];
  const input={client,remote,review,route,processId:'proc-1',caseTitle:'部分修改',application:{name:'权利要求书.docx',bytes:Buffer.from('isolated')},...(route==='reply'?{reply:{name:'意见.docx',bytes:Buffer.from('reply')}}:{}),guard,onWrite:()=>{},checkpoint:async()=>{}};
  if(route==='application'){await assert.rejects(saveRemoteTransfer(input),/本次所选部分/);assert(!client.calls.some(c=>c.endpoint.endsWith('ModifyFormInstructionsAndImage')));}
  else{await saveRemoteTransfer(input);assert.deepEqual(client.group.map(g=>g.File.FileNo),['split-100001']);assert.equal(client.calls.find(c=>c.endpoint.endsWith('ModifyFormInstructionsAndImage'))!.body.FileList[0].Untouched,'preserve');}
 }
 const {client,remote,review}=await setup('correction');client.parsedCodes=['100002'];review.form.corrections=[correctionRow];
 await assert.rejects(saveRemoteTransfer({client,remote,review,route:'correction',processId:'proc-1',caseTitle:'缺少选中部分',application:{name:'申请.docx',bytes:Buffer.from('x')},guard,onWrite:()=>{},checkpoint:async()=>{}}),/权利要求书/);
 assert.equal(client.form,null);assert(!client.calls.some(c=>c.endpoint.endsWith('ModifyFormInstructionsAndImage')));
});
