import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Server } from './test-support/transfer-server.ts';
import { DesktopService } from './service.ts';
import { TransferHost, pickTransferRecipient } from './transfer-host.ts';
import { isRemoteTransferSaved } from './baseland-transfer.ts';
import type { AgentHost } from './agent-host.ts';
import type { Case } from '../src/domain/workflow.ts';

async function setup(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pwb-transfer-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const service=new DesktopService(root,{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
  service.key='profile-qa';service.account={username:'qa',displayName:'测试用户',organization:'合成组织',origin:'https://test.baselandtec.com',userId:'qa-user',status:'authenticated',remembered:false};
  const work=path.join(root,'work');await fs.mkdir(work);service.workspace.settings={provider:'',baseUrl:'',model:'',workRoot:work};
  const c:Case={id:'qa-case',number:'CASE-ONLY',title:'隔离提交案件',source:'baseland',type:'发明',deadline:'',archived:false,tags:[],rounds:[],current:{kind:'reply',processId:'proc-1',remoteStatus:400},remote:{caseId:'remote-case',syncedAt:'',processes:[{id:'proc-1',name:'第一次审查意见',status:400,node:'文件准备',undertaker:'测试用户',deadline:''}]}};
  service.workspace.cases=[c];c.directory=await service.files().ensureCase(c);const client=new Server();service.client=client;
  const agent={getCase:async()=>({artifacts:[],process:{drafts:[]}})} as unknown as AgentHost;
  const host=new TransferHost(service,agent);
  const source=path.join(root,'reply.docx');await fs.copyFile(path.resolve('resources/document-templates/reply.docx'),source);
  return {root,service,client,agent,host,c,source};
}
test('internal save survives reopen, never auto-submits, and rejects repeated submit',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);v=await host.addFile(service.key,v.id,'reply',source);
  const original=await fs.readFile(source);
  v=await host.save(service.key,v.id,v.review);assert.equal(v.phase,'saved');
  assert.equal(client.calls.some(c=>c.endpoint.endsWith('SubmitHandFlow')),false);
  const reopened=new TransferHost(service,agent);let restored=await reopened.prepare(service.key,c.id);
  assert.equal(restored.id,v.id);assert.equal(restored.phase,'saved');
  restored=await reopened.submit(service.key,restored.id);assert.equal(restored.phase,'submitted');
  await assert.rejects(reopened.submit(service.key,restored.id),/先完成/);
  assert.equal(client.calls.filter(c=>c.endpoint.endsWith('SubmitHandFlow')).length,1);
  assert.deepEqual(await fs.readFile(source),original);
});
test('inspect restores saved transfer session without network calls and preserves saved state',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);assert.equal(v.phase,'saved');
  const callsBefore=client.calls.length;
  const reopened=new TransferHost(service,agent);
  const inspected=await reopened.inspect(service.key,c.id);
  assert.ok(inspected);
  assert.equal(inspected.id,v.id);
  assert.equal(inspected.phase,'saved');
  assert.equal(inspected.files.length>0,true);
  assert.equal(client.calls.length,callsBefore,'inspect 不发送任何网络请求');
  const submitted=await reopened.submit(service.key,inspected.id);
  assert.equal(submitted.phase,'submitted');
});
test('revoke reverts saved transfer to draft, preserves user inputs, and supports clean re-save',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);v=await host.addFile(service.key,v.id,'reply',source);
  const initialAt=v.at;
  // Advance system clock slightly if possible or check that at is updated
  await new Promise(r=>setTimeout(r,10));
  v.review.remark='重要内部备注';
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');
  assert(v.at>=initialAt,'save updates at timestamp');

  // Revoke to draft
  const revoked=await host.revoke(service.key,v.id);
  assert.equal(revoked.phase,'draft');
  assert.equal(revoked.review.remark,'重要内部备注','表单备注与输入保留');
  assert.equal(revoked.files.length,1,'文件副本完整保留');

  // Reopen after revoke - inspect loads draft session
  const reopened=new TransferHost(service,agent);
  const inspected=await reopened.inspect(service.key,c.id);
  assert.ok(inspected);
  assert.equal(inspected.phase,'draft');
  assert.equal(inspected.review.remark,'重要内部备注');

  // Re-saving after reopen lazy-loads remote and transitions to saved cleanly
  const resaved=await reopened.save(service.key,inspected.id,inspected.review);
  assert.equal(resaved.phase,'saved');

  // Submit succeeds
  const submitted=await reopened.submit(service.key,resaved.id);
  assert.equal(submitted.phase,'submitted');

  // Cannot revoke after submitted
  await assert.rejects(reopened.revoke(service.key,resaved.id),/已确认内部转交/);
});
test('changed snapshot, case process and account fail before upload; incomplete form stays editable',async t=>{
  const {service,client,host,c,source}=await setup(t);let v=await host.prepare(service.key,c.id);v=await host.addFile(service.key,v.id,'reply',source);
  await assert.rejects(host.save(service.key,v.id,{...v.review,userId:'wrong'}),/服务端/);
  assert.equal((await host.prepare(service.key,c.id)).phase,'draft');
  const target=await service.casePath(c.id,v.files[0].relativePath);await fs.writeFile(target,'changed');
  await assert.rejects(host.save(service.key,v.id,v.review),/副本已经变化/);
  assert.equal(client.serial,0);
  c.current!.processId='new-process';await assert.rejects(host.refresh(service.key,v.id),/流程已变化/);
  c.current!.processId='proc-1';service.key='other';await assert.rejects(host.refresh('profile-qa',v.id),/账号已切换/);
});
test('unconfirmed transfer remains uncertain on reopen and can only recover through readback',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);let v=await host.prepare(service.key,c.id);v=await host.addFile(service.key,v.id,'reply',source);v=await host.save(service.key,v.id,v.review);
  client.badRecipient=true;v=await host.submit(service.key,v.id);assert.equal(v.phase,'uncertain');
  const reopened=new TransferHost(service,agent);v=await reopened.prepare(service.key,c.id);assert.equal(v.phase,'uncertain');
  await assert.rejects(reopened.submit(service.key,v.id),/先完成/);
  client.flowInfo.FlowUserName='杨佳';client.flowInfo.FlowUserId='user-1';v=await reopened.refresh(service.key,v.id);assert.equal(v.phase,'submitted');
  assert.equal(client.calls.filter(c=>c.endpoint.endsWith('SubmitHandFlow')).length,1);
});

test('empty guid in post-transfer FlowUserId with matching FlowUserName confirms transfer',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  const orig=client.request.bind(client);
  client.request=async(ep:string,b:any,p:any)=>{
    const res=await orig(ep,b,p);
    if(ep.endsWith('SubmitHandFlow')){
      client.flowInfo={FlowNodeName:'下一内部流程',FlowUserName:'杨佳',CaseHandStepId:'step-1',FlowUserId:'00000000-0000-0000-0000-000000000000'};
    }
    return res;
  };
  v=await host.submit(service.key,v.id);
  assert.equal(v.phase,'submitted');
  assert.equal(v.currentUser,'杨佳');
  assert.equal(client.calls.filter(c=>c.endpoint.endsWith('SubmitHandFlow')).length,1);
});

test('matching recipient on a different hand cannot confirm an uncertain transfer',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);v=await host.save(service.key,v.id,v.review);
  client.badRecipient=true;v=await host.submit(service.key,v.id);assert.equal(v.phase,'uncertain');
  client.flowInfo.FlowUserName='杨佳';client.handId='different-hand';
  const reopened=new TransferHost(service,agent);v=await reopened.prepare(service.key,c.id);v=await reopened.refresh(service.key,v.id);
  assert.equal(v.phase,'uncertain');assert.match(v.error!,/递交实例已变化/);
});


test('current adopted response can prepare Word and submit without optional AI review or formal finalization',async t=>{
 const {service,client,agent,c}=await setup(t);
 agent.getCase=async()=>({artifacts:[],process:{drafts:[{id:'draft-now',text:'尊敬的审查员：\n一、权利要求修改说明\n本次未修改权利要求。\n二、关于创造性问题\n合成验收意见。\n三、综上\n请予考虑。\n四、结尾\n谢谢审查。\n此致',adoptStatus:'adopted'}],currentDraftVersionId:'draft-now',finalized:null,reviews:[],classification:{status:'classified',noticeCategory:'审查意见通知书',officeActionRound:1}}}) as any;
 const host=new TransferHost(service,agent,{templatesRoot:path.resolve('resources/document-templates')});
 let v=await host.prepare(service.key,c.id);assert(v.files.some(f=>f.role==='reply'&&f.name.endsWith('.docx')));assert.equal(client.serial,0);
 v=await host.save(service.key,v.id,{...v.review,confirmedDraftId:v.sourceDraft?.id});assert.equal(v.phase,'saved');v=await host.submit(service.key,v.id);assert.equal(v.phase,'submitted');
});

test('selected full Word parts enter local transfer preparation without any remote write',async t=>{
 const {service,client,agent,c}=await setup(t);
 agent.getCase=async()=>({artifacts:[],process:{drafts:[{id:'v-word',text:'尊敬的审查员：\n本次修改权利要求。\n此致',adoptStatus:'adopted',applicationParts:{CLAIMS:'1. 一种检测装置，包括底座以及安装于底座的检测组件。'}}],currentDraftVersionId:'v-word',finalized:null,reviews:[],classification:{status:'classified',noticeCategory:'审查意见通知书',officeActionRound:1}}}) as any;
 const host=new TransferHost(service,agent,{templatesRoot:path.resolve('resources/document-templates')});
 const view=await host.prepare(service.key,c.id);
 assert.deepEqual(view.review.keepCodes,['100001']);assert.equal(view.parts.find(p=>p.code==='100002')?.available,false);
 const file=view.files.find(f=>f.role==='application');assert(file);
 const {applicationSections}=await import('./application-diff.ts');const parts=await applicationSections(await fs.readFile(await service.casePath(c.id,file.relativePath)));
 assert.deepEqual([...parts.keys()],['100001']);assert.match(parts.get('100001')!.text,/检测组件/);
 assert.equal(client.serial,0);assert(!client.calls.some(c=>/Upload|Save|Submit|StartHand/.test(c.endpoint)));
});

test('correction adopts four fields independently of a Word upload and retains existing row identity',async t=>{
 const {service,client,agent,c,source}=await setup(t);c.current!.kind='correction';c.remote!.processes[0].name='补正';
 const content={FileName:'权利要求书',PositionInFile:'权利要求 1',CorrectionBefore:'原有限位组件',CorrectionAfter:'固定连接的限位组件'};
 client.form={Correction:{CaseHandCorrectionId:'existing',CorrectionReasonType:2,IsAddEntrust:false},CorrectionContentList:[{...content,ChangeId:'server-row',Sort:0}]};
 agent.getCase=async()=>({artifacts:[],process:{drafts:[{id:'correction-now',text:'本次补正办理说明',adoptStatus:'adopted',applicationParts:{CLAIMS:'1. 一种检测装置，包括固定连接的限位组件。'},correctionContents:[content]}],currentDraftVersionId:'correction-now',finalized:null,reviews:[],classification:{status:'classified',noticeCategory:'补正通知书',officeActionRound:1}}}) as any;
 const host=new TransferHost(service,agent,{templatesRoot:path.resolve('resources/document-templates')});
 let view=await host.prepare(service.key,c.id);
 assert.deepEqual(view.review.form.corrections,[{...content,ChangeId:'server-row',Sort:0}]);
 assert.deepEqual(view.review.keepCodes,['100001']);assert(view.files.some(f=>f.role==='application'));
 assert(!view.files.some(f=>f.role==='reply'||/补正说明/.test(f.name)));assert.equal(client.serial,0);
 await assert.rejects(host.addFile(service.key,view.id,'reply',source),/不能上传/);assert.equal(client.serial,0);
 client.parsedCodes=['100001'];view=await host.save(service.key,view.id,{...view.review,confirmedDraftId:view.sourceDraft?.id});assert.equal(view.phase,'saved');
 assert.equal(client.serial,1);assert.equal(client.form.File,undefined);assert.equal(client.form.CorrectionContentList[0].ChangeId,'server-row');
 assert(!client.calls.some(c=>c.endpoint.endsWith('SubmitHandFlow')));
});

test('interrupted StartHand persists uncertainty and cannot be blindly repeated after reopen',async t=>{
 const {service,client,host,agent,c}=await setup(t);client.handId='';c.current!.remoteStatus=0;c.remote!.processes[0].status=0;
 let attempts=0;const original=client.request.bind(client);
 client.request=async(ep,b,p)=>{if(ep.endsWith('StartHand')){attempts++;throw new Error('connection lost after request');}return original(ep,b,p);};
 let view=await host.prepare(service.key,c.id);view=await host.startHand(service.key,view.id);assert.equal(view.phase,'uncertain');
 const reopened=new TransferHost(service,agent);view=await reopened.prepare(service.key,c.id);assert.equal(view.phase,'uncertain');
 await assert.rejects(reopened.startHand(service.key,view.id),/不要重复启动/);assert.equal(attempts,1);
});

test('a failed save cannot become submitted just because the displayed recipient matches',async t=>{
 const {service,client,host,c,source}=await setup(t);let view=await host.prepare(service.key,c.id);view=await host.addFile(service.key,view.id,'reply',source);
 const original=client.request.bind(client);
 client.request=async(ep,b,p)=>{if(ep.endsWith('InsertFormOpinionStatement'))return 'Denied';return original(ep,b,p);};
 view=await host.save(service.key,view.id,view.review);assert.equal(view.phase,'uncertain');
 client.flowInfo={FlowNodeName:client.next,FlowUserName:'杨佳',CaseHandStepId:'step-1',FlowUserId:'user-1'};
 view=await host.refresh(service.key,view.id);assert.equal(view.phase,'uncertain');assert.notEqual(view.submissionAttempted,true);
});

test('known busy handoff recovers saved state after unchanged readback and retries without upload',async t=>{
 const {service,client,host,agent,c,source}=await setup(t);let v=await host.prepare(service.key,c.id);v=await host.addFile(service.key,v.id,'reply',source);v=await host.save(service.key,v.id,v.review);
 const original=client.request.bind(client);let attempts=0;
 client.request=async(ep,b,p)=>{if(ep.endsWith('SubmitHandFlow')&&++attempts===1)return {Result:'IsPacking'};return original(ep,b,p);};
 v=await host.submit(service.key,v.id);assert.equal(v.phase,'uncertain');assert.equal(v.submissionRetryable,true);const uploads=client.serial;
 const reopened=new TransferHost(service,agent);v=await reopened.prepare(service.key,c.id);v=await reopened.refresh(service.key,v.id);
 assert.equal(v.phase,'saved');assert.match(v.error!,/正在打包/);assert.equal(attempts,1);
 v=await reopened.submit(service.key,v.id);assert.equal(v.phase,'submitted');assert.equal(client.serial,uploads);assert.equal(attempts,2);
});
test('reopening cannot replace the pre-submit fingerprint and permit retry after remote changes',async t=>{
 const {service,client,host,agent,c,source}=await setup(t);let v=await host.prepare(service.key,c.id);v=await host.addFile(service.key,v.id,'reply',source);v=await host.save(service.key,v.id,v.review);
 const original=client.request.bind(client);client.request=async(ep,b,p)=>ep.endsWith('SubmitHandFlow')?{Result:'NotPack'}:original(ep,b,p);
 v=await host.submit(service.key,v.id);client.form.OpinionStatement.NoticeName='changed remotely';
 const reopened=new TransferHost(service,agent);v=await reopened.prepare(service.key,c.id);v=await reopened.refresh(service.key,v.id);assert.equal(v.phase,'uncertain');
 await assert.rejects(reopened.submit(service.key,v.id),/先完成/);
});
test('unknown and confirmation results never unlock manual resubmission through unchanged readback',async t=>{
 for(const code of ['UnknownResult','NeedConfirmForRepack']){
  const {service,client,host,c,source}=await setup(t);let v=await host.prepare(service.key,c.id);v=await host.addFile(service.key,v.id,'reply',source);v=await host.save(service.key,v.id,v.review);
  const original=client.request.bind(client);client.request=async(ep,b,p)=>ep.endsWith('SubmitHandFlow')?{Result:code}:original(ep,b,p);
  v=await host.submit(service.key,v.id);v=await host.refresh(service.key,v.id);assert.equal(v.phase,'uncertain');assert.equal(v.submissionRetryable,false);
 }
});

test('local reply bypasses agent, supports manual Word, restores source and blocks alternate saved plan',async t=>{
 const {service,agent,host,c,source,client}=await setup(t);agent.getCase=async()=>{throw new Error('must not read AI state');};
 let v=await host.prepare(service.key,c.id,false,'local');assert.equal(v.sourceMode,'local');assert.equal(v.files.length,0);
 v=await host.addFile(service.key,v.id,'reply',source);const original=await fs.readFile(source);
 v=await host.save(service.key,v.id,v.review);assert.equal(v.phase,'saved');assert.equal(client.calls.some(c=>c.endpoint.endsWith('SubmitHandFlow')),false);
 const restarted=new TransferHost(service,agent);assert.equal((await restarted.prepare(service.key,c.id,false,'local')).id,v.id);
 await assert.rejects(restarted.prepare(service.key,c.id),/另一提交来源/);assert.deepEqual(await fs.readFile(source),original);
});
test('local application and correction do not require AI artifacts; correction fields remain manually supplied',async t=>{
 const {service,agent,c,source}=await setup(t);agent.getCase=async()=>{throw new Error('must not read AI state');};
 for(const kind of ['write','correction'] as const){
  c.current!.kind=kind;c.current!.processId='proc-'+kind;c.remote!.processes[0].id=c.current!.processId;c.remote!.processes[0].name=kind==='write'?'提出申请':'补正';
  const host=new TransferHost(service,agent,{applicationFile:async()=>{throw new Error('must not read writing record');}});
  let v=await host.prepare(service.key,c.id,false,'local');assert.equal(v.route,kind==='write'?'application':'correction');assert.equal(v.files.length,0);
  v=await host.addFile(service.key,v.id,'application',source);assert.equal(v.parts.length,5);assert.equal(v.review.form.corrections.length,0);
 }
});
test('local correction draft save keeps 补正内容 across inspect, reopen and file pick',async t=>{
 const {service,agent,c,source,client}=await setup(t);
 c.current!.kind='correction';c.current!.processId='proc-correction';c.remote!.processes[0].id='proc-correction';c.remote!.processes[0].name='补正';
 const host=new TransferHost(service,agent);
 let v=await host.prepare(service.key,c.id,false,'local');
 const row={ChangeId:'local-row',Sort:0,FileName:'权利要求书',PositionInFile:'权利要求 1',CorrectionBefore:'原装置',CorrectionAfter:'限位组件'};
 v=await host.saveLocalReview(service.key,v.id,{...v.review,form:{...v.review.form,corrections:[row]}});
 assert.equal(v.phase,'draft');
 assert.deepEqual(v.review.form.corrections,[row]);
 assert.equal(client.serial,0);
 const inspected=await host.inspect(service.key,c.id);
 assert.ok(inspected);
 assert.deepEqual(inspected!.review.form.corrections,[row]);
 const reopened=new TransferHost(service,agent);
 const restored=await reopened.inspect(service.key,c.id);
 assert.ok(restored);
 assert.equal(restored!.id,v.id);
 assert.deepEqual(restored!.review.form.corrections,[row]);
 const prepared=await reopened.prepare(service.key,c.id,false,'local');
 assert.equal(prepared.id,v.id);
 assert.deepEqual(prepared.review.form.corrections,[row]);
 const withFile=await reopened.addFile(service.key,prepared.id,'application',source);
 assert.deepEqual(withFile.review.form.corrections,[row]);
 assert.equal(client.calls.some(call=>/Upload|Save|Submit|Insert|Update/.test(call.endpoint)),false);
});
test('file-less correction draft without 补正条目 is still discarded as empty',async t=>{
 const {service,agent,c}=await setup(t);
 c.current!.kind='correction';c.current!.processId='proc-correction';c.remote!.processes[0].id='proc-correction';c.remote!.processes[0].name='补正';
 const host=new TransferHost(service,agent);
 const empty=await host.prepare(service.key,c.id,false,'local');
 assert.equal(empty.files.length,0);
 assert.equal(empty.review.form.corrections.length,0);
 const again=await host.prepare(service.key,c.id,false,'local');
 assert.notEqual(again.id,empty.id);
});

test('local Word saves figure 1 on drawing row and specification-derived name',async t=>{
 const {service,host,c,source,client}=await setup(t);client.setting.IsShowCaseName=true;client.setting.CaseName='过期名称';
 let v=await host.prepare(service.key,c.id,false,'local');assert.equal(v.review.form.abstractFigure,'1');v=await host.addFile(service.key,v.id,'reply',source);v=await host.addFile(service.key,v.id,'application',source);
 v=await host.save(service.key,v.id,{...v.review,keepCodes:['100003']});assert.equal(v.phase,'saved');assert.equal(client.setting.CaseName,'说明书抬头名称');assert.equal(client.group.find((g:any)=>String(g.FormCode)==='100003').AbstractDrawNumber,'1');
 assert.equal(client.calls.some(c=>c.endpoint.endsWith('SubmitHandFlow')),false);
});

test('workbench automatically fetches pending draft after empty preparation and requires exact manual confirmation',async t=>{
 const {service,client,agent,c}=await setup(t);
 const host=new TransferHost(service,agent,{templatesRoot:path.resolve('resources/document-templates')});
 const empty=await host.prepare(service.key,c.id);assert.equal(empty.files.length,0);
 const process={drafts:[{id:'pending-v1',text:'尊敬的审查员：\n合成待采用稿。\n此致',at:'2026-09-14T00:00:00Z',adoptStatus:'pending',strategyId:'s2',applicationParts:{CLAIMS:'1. 一种合成装置，包括测试组件。'}}],userSelectedStrategyId:'s2',currentDraftVersionId:null,finalized:null,reviews:[],classification:{status:'classified',noticeCategory:'审查意见通知书',officeActionRound:1}};
 agent.getCase=async()=>({artifacts:[],process}) as any;
 let view=await host.prepare(service.key,c.id);assert.notEqual(view.id,empty.id);assert.equal(view.sourceDraft?.id,'pending-v1');assert.equal(view.sourceDraft?.pending,true);assert(view.files.some(f=>f.role==='reply'));assert(view.files.some(f=>f.role==='application'));
 assert.equal(process.currentDraftVersionId,null);assert.equal(process.drafts[0].adoptStatus,'pending');assert.equal(client.serial,0);
 await assert.rejects(host.save(service.key,view.id,view.review),/确认.*版本/);assert.equal(client.serial,0);
 await assert.rejects(host.save(service.key,view.id,{...view.review,confirmedDraftId:'wrong'}),/确认.*版本/);
 // Latest version intentionally has no application modifications: do not bring old application file forward.
 process.drafts.push({...process.drafts[0],id:'pending-v2',at:'2026-09-15T00:00:00Z',applicationParts:{} as any});
 view=await host.reprepare(service.key,view.id);assert.equal(view.sourceDraft?.id,'pending-v2');assert(!view.files.some(f=>f.role==='application'));assert.equal(view.review.confirmedDraftId,undefined);
 view=await host.save(service.key,view.id,{...view.review,confirmedDraftId:'pending-v2'});assert.equal(view.phase,'saved');assert(!client.calls.some(c=>c.endpoint.endsWith('SubmitHandFlow')));
});


test('transfer-host has no hardcoded 杨佳 recipient default',async()=>{
  const src=await fs.readFile(path.resolve('desktop/transfer-host.ts'),'utf8');
  assert.equal(src.includes('杨佳'),false);
  assert.match(src,/pickTransferRecipient/);
});

test('pickTransferRecipient uses last preference, sole candidate, otherwise requires explicit choice',()=>{
  const a={step:{id:'s1',name:'递交'},user:{id:'u1',name:'甲'}};
  const b={step:{id:'s1',name:'递交'},user:{id:'u2',name:'乙'}};
  const c={step:{id:'s2',name:'核稿'},user:{id:'u2',name:'乙'}};
  assert.equal(pickTransferRecipient([]),undefined);
  assert.equal(pickTransferRecipient([a]),a);
  assert.equal(pickTransferRecipient([a,b]),undefined);
  assert.equal(pickTransferRecipient([a,b],{userId:'u2'}),b);
  assert.equal(pickTransferRecipient([a,b],{userId:'missing'}),undefined);
  assert.equal(pickTransferRecipient([a,b,c],{userId:'u2',stepId:'s2'}),c);
  assert.equal(pickTransferRecipient([a,b,c],{userId:'u2',stepId:'gone'}),b);
  assert.equal(pickTransferRecipient([a,b],{userId:'',userName:'乙'}),b);
});

test('prepare leaves recipient empty when multiple candidates and no preference',async t=>{
  const {service,client,host,c}=await setup(t);
  client.nextUsers=[{value:'u-a',label:'甲'},{value:'u-b',label:'乙'}];
  const v=await host.prepare(service.key,c.id);
  assert.equal(v.review.stepId,'');
  assert.equal(v.review.userId,'');
  assert.equal(service.workspace.settings.lastTransferRecipient,undefined);
});

test('prepare selects sole candidate without relying on a fixed name',async t=>{
  const {service,client,host,c}=await setup(t);
  client.nextUsers=[{value:'only-user',label:'唯一办理人'}];
  const v=await host.prepare(service.key,c.id);
  assert.equal(v.review.stepId,'step-1');
  assert.equal(v.review.userId,'only-user');
});

test('successful save remembers recipient for the next preparation',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  client.nextUsers=[{value:'u-a',label:'甲'},{value:'u-b',label:'乙'}];
  let v=await host.prepare(service.key,c.id);
  assert.equal(v.review.userId,'');
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,{...v.review,stepId:'step-1',userId:'u-b'});
  assert.equal(v.phase,'saved');
  assert.deepEqual(service.workspace.settings.lastTransferRecipient,{userId:'u-b',userName:'乙',stepId:'step-1'});
  // New process so prior journal for proc-1 does not restore the old view.
  c.current!.processId='proc-2';c.remote!.processes[0].id='proc-2';
  const next=new TransferHost(service,agent);
  const fresh=await next.prepare(service.key,c.id);
  assert.equal(fresh.review.stepId,'step-1');
  assert.equal(fresh.review.userId,'u-b');
});

test('successful save updates view.steps and resolves recipient',async t=>{
  const {service,client,host,c,source}=await setup(t);
  client.nextUsers=[{value:'u-1',label:'杨佳'}];
  let v=await host.prepare(service.key,c.id);
  assert.equal(v.review.userId,'u-1');
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');
  assert.equal(v.steps.length,1);
  assert.equal(v.steps[0].users[0].name,'杨佳');
  assert.equal(v.review.userId,'u-1');
});

test('isRemoteTransferSaved validates contracts across reply, application, and correction routes',()=>{
  assert.equal(isRemoteTransferSaved(null,'reply'),false);
  assert.equal(isRemoteTransferSaved({hand:{},handId:'',cards:[],formCode:'100012',form:null,instructions:null,files:[],notice:null,steps:[],fingerprint:''},'reply'),false);

  // Valid reply
  const validReply={
    hand:{IsReviewing:true},
    handId:'h-1',
    cards:[{Code:100012,IsSelect:true}],
    formCode:'100012',
    form:{
      File:{FileNo:'f-1',FileName:'意见陈述书.docx'},
      OpinionStatement:{NoticeDate:'2026-09-10',NoticeName:'第一次审查意见通知书',NoticeNo:'NOTICE-1'},
    },
    instructions:null,
    files:[{FileNo:'f-1',FileName:'意见陈述书.docx'}],
    notice:null,
    steps:[{id:'s1',name:'审核',users:[{id:'u1',name:'李明'}]}],
    fingerprint:'fp-1',
  };
  assert.equal(isRemoteTransferSaved(validReply as any,'reply'),true);
  // Missing notice date
  assert.equal(isRemoteTransferSaved({...validReply,form:{...validReply.form,OpinionStatement:{...validReply.form.OpinionStatement,NoticeDate:''}}} as any,'reply'),false);
  // Reply card not selected
  assert.equal(isRemoteTransferSaved({...validReply,cards:[{Code:100012,IsSelect:false}]} as any,'reply'),false);
  // Missing reply file
  assert.equal(isRemoteTransferSaved({...validReply,form:{...validReply.form,File:undefined},files:[]} as any,'reply'),false);
  // Notice date via notice info fallback
  const replyNoticeFallback={...validReply,form:{...validReply.form,OpinionStatement:{...validReply.form.OpinionStatement,NoticeDate:''}},notice:{PostDate:'2026-09-10',NoticeName:'第一次审查意见通知书',FaWenXLH:'NOTICE-1'}};
  assert.equal(isRemoteTransferSaved(replyNoticeFallback as any,'reply'),true);
  // Docx filename matching 答复
  const replyDocx={...validReply,form:{...validReply.form,File:{FileNo:'f-1',FileName:'202606292-0591一种塑料薄膜生产用收卷设备第一次审查意见通知书答复.docx'}},files:[{FileNo:'f-1',FileName:'202606292-0591一种塑料薄膜生产用收卷设备第一次审查意见通知书答复.docx'}]};
  assert.equal(isRemoteTransferSaved(replyDocx as any,'reply'),true);

  // Valid application
  const validApp={
    hand:{IsReviewing:true},
    handId:'h-2',
    cards:[{Code:110101,IsSelect:true}],
    formCode:'110101',
    form:{RequestInfo:{IsApplySameDay:false}},
    instructions:{
      Setting:{IsUseXmlFormatHand:true},
      FormGroup:[
        {FormCode:100001,File:{FileNo:'p1'}},
        {FormCode:100002,File:{FileNo:'p2'}},
        {FormCode:100003,File:{FileNo:'p3'}},
        {FormCode:100004,File:{FileNo:'p4'}},
        {FormCode:100005,File:{FileNo:'p5'}},
        {IsMixFile:true,File:{FileNo:'mix'}},
      ],
    },
    files:[],
    notice:null,
    steps:[{id:'s1',name:'审核',users:[{id:'u1',name:'李明'}]}],
    fingerprint:'fp-2',
  };
  assert.equal(isRemoteTransferSaved(validApp as any,'application'),true);
  // Missing one part
  const missingOne={...validApp,instructions:{...validApp.instructions,FormGroup:validApp.instructions.FormGroup.slice(1)}};
  assert.equal(isRemoteTransferSaved(missingOne as any,'application'),false);

  // Valid correction
  const validCorr={
    hand:{IsReviewing:true},
    handId:'h-3',
    cards:[{Code:100006,IsSelect:true}],
    formCode:'100006',
    form:{
      Correction:{CorrectionReasonType:2,NoticeDate:'2026-09-10',NoticeName:'补正通知书',NoticeNo:'CORR-1'},
      CorrectionContentList:[{ChangeId:'c1',Sort:0,FileName:'说明书',PositionInFile:'第1段',CorrectionBefore:'旧',CorrectionAfter:'新'}],
    },
    instructions:null,
    files:[],
    notice:null,
    steps:[{id:'s1',name:'审核',users:[{id:'u1',name:'李明'}]}],
    fingerprint:'fp-3',
  };
  assert.equal(isRemoteTransferSaved(validCorr as any,'correction'),true);
  // Empty correction list
  assert.equal(isRemoteTransferSaved({...validCorr,form:{...validCorr.form,CorrectionContentList:[]}} as any,'correction'),false);
});

test('cross-device rehydration: second machine without local files detects remote saved state, rehydrates, and submits directly',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');

  // Machine B: separate directory, no local transfer JSON
  const rootB=await fs.mkdtemp(path.join(os.tmpdir(),'pwb-transfer-b-'));
  t.after(()=>fs.rm(rootB,{recursive:true,force:true}));
  const serviceB=new DesktopService(rootB,{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
  serviceB.key='profile-qa';
  serviceB.account=structuredClone(service.account);
  const workB=path.join(rootB,'work');
  await fs.mkdir(workB);
  serviceB.workspace.settings={provider:'',baseUrl:'',model:'',workRoot:workB};
  const cB:Case={...c};
  serviceB.workspace.cases=[cB];
  cB.directory=await serviceB.files().ensureCase(cB);
  serviceB.client=client;
  const hostB=new TransferHost(serviceB,agent);

  // 1. inspect on Machine B detects saved state on cloud
  const inspectedB=await hostB.inspect(serviceB.key,cB.id);
  assert.ok(inspectedB);
  assert.equal(inspectedB.phase,'saved');
  assert.equal(inspectedB.existingFileNames.length>0,true);
  assert.equal(inspectedB.files.length,0,'不需要机A本地文件副本');
  assert.equal(inspectedB.review.form.noticeNo,'NOTICE-QA');
  assert.equal(inspectedB.review.stepId,'step-1');
  assert.equal(inspectedB.review.userId,'user-1');

  // 2. Machine B can directly submit to Baseland without local source files
  const submittedB=await hostB.submit(serviceB.key,inspectedB.id,{...inspectedB.review,remark:'从第二台电脑转交'});
  assert.equal(submittedB.phase,'submitted');
  assert.equal(submittedB.currentNode,'下一内部流程');
  assert.equal(submittedB.currentUser,'杨佳');
  const submitCalls=client.calls.filter(call=>call.endpoint.endsWith('SubmitHandFlow'));
  assert.equal(submitCalls.length,1);
  assert.equal(submitCalls[0].body.Remark,'从第二台电脑转交');

  // 3. Machine B now has local transfer JSON; reopened host loads it locally
  const reopenedB=new TransferHost(serviceB,agent);
  const checkedB=await reopenedB.inspect(serviceB.key,cB.id);
  assert.equal(checkedB?.phase,'submitted');
});

test('cross-device prepare rehydrates remote saved state directly when no local journal exists',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');

  // Machine B
  const rootB=await fs.mkdtemp(path.join(os.tmpdir(),'pwb-transfer-prep-b-'));
  t.after(()=>fs.rm(rootB,{recursive:true,force:true}));
  const serviceB=new DesktopService(rootB,{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
  serviceB.key='profile-qa';
  serviceB.account=structuredClone(service.account);
  const workB=path.join(rootB,'work');
  await fs.mkdir(workB);
  serviceB.workspace.settings={provider:'',baseUrl:'',model:'',workRoot:workB};
  const cB:Case={...c};
  serviceB.workspace.cases=[cB];
  cB.directory=await serviceB.files().ensureCase(cB);
  serviceB.client=client;
  const hostB=new TransferHost(serviceB,agent);

  // Calling prepare directly on Machine B without prior local file returns saved session
  const preparedB=await hostB.prepare(serviceB.key,cB.id);
  assert.equal(preparedB.phase,'saved');
  assert.equal(preparedB.existingFileNames.length>0,true);
  assert.equal(preparedB.review.stepId,'step-1');
  assert.equal(preparedB.review.userId,'user-1');
});

test('refresh recovers uncertain phase without attempted submission to saved when remote was already complete',async t=>{
  const {service,client,host,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');

  // Simulate an interrupted save or read failure that left phase uncertain with submissionAttempted false
  const session=(host as any).sessions.get(v.id);
  session.view.phase='uncertain';
  session.view.submissionAttempted=false;

  // Remote already has valid saved state (reply docx + notice form)
  const refreshed=await host.refresh(service.key,v.id);
  assert.equal(refreshed.phase,'saved');
  assert.equal(refreshed.existingFileNames.length>0,true);
  assert.match(refreshed.results.at(-1)!,/已保存就绪/);
});

test('submit rejects when remote hand has lost files or contract prior to sending',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');

  // Remote files deleted or corrupted on server before a reopened session submits
  client.group=[];
  client.form={...client.form,File:undefined};

  const reopened=new TransferHost(service,agent);
  await reopened.prepare(service.key,c.id);
  await assert.rejects(
    reopened.submit(service.key,v.id),
    /服务端递交材料已不完整或发生变化/
  );
  assert.equal(client.calls.some(call=>call.endpoint.endsWith('SubmitHandFlow')),false);
});

test('inspect ignores stale empty local draft without files and rehydrates remote saved state',async t=>{
  const {service,client,host,agent,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');

  const journalRoot=await service.casePath(c.id,'04_内部说明');
  const staleDraftId='stale-empty-draft-1';
  const staleData={
    schema:1,
    view:{
      id:staleDraftId,
      sourceMode:'workbench',
      profileKey:service.key,
      caseId:c.id,
      caseNumber:c.number,
      caseTitle:c.title,
      processId:c.remote!.processes[0].id,
      processName:c.remote!.processes[0].name,
      route:'reply',
      files:[],
      parts:[],
      review:{keepCodes:[],form:{},stepId:'',userId:'',remark:''},
      steps:[],
      phase:'draft',
      results:[],
      existingFileNames:[],
      at:new Date(Date.now()+1000).toISOString()
    }
  };
  await fs.writeFile(path.join(journalRoot,`transfer-${staleDraftId}.json`),JSON.stringify(staleData));

  const reopened=new TransferHost(service,agent);
  const inspected=await reopened.inspect(service.key,c.id);
  assert.equal(inspected?.phase,'saved');
  assert.equal(inspected?.existingFileNames.length>0,true);
});

test('refresh promotes draft phase to saved when remote materials and form already exist on server',async t=>{
  const {service,client,host,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');

  const session=(host as any).sessions.get(v.id);
  session.view.phase='draft';
  session.view.files=[];

  const refreshed=await host.refresh(service.key,v.id);
  assert.equal(refreshed.phase,'saved');
  assert.equal(refreshed.existingFileNames.length>0,true);
  assert.match(refreshed.results.at(-1)!,/已保存就绪/);
});

test('revoke sets revokedByUser flag and prevents refresh from auto-promoting to saved',async t=>{
  const {service,client,host,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');

  // Revoke to draft
  const revoked=await host.revoke(service.key,v.id);
  assert.equal(revoked.phase,'draft');
  assert.equal(revoked.revokedByUser,true);

  // Refresh should NOT promote back to saved because revokedByUser is true
  const refreshed=await host.refresh(service.key,v.id);
  assert.equal(refreshed.phase,'draft');
  assert.equal(refreshed.revokedByUser,true);
  assert.match(refreshed.results.at(-1)!,/维持撤销保存后的草稿编辑状态/);

  // Re-saving clears revokedByUser and sets phase to saved
  const resaved=await host.save(service.key,v.id,refreshed.review);
  assert.equal(resaved.phase,'saved');
  assert.equal(resaved.revokedByUser,undefined);
});

test('removeFile removes local prepared file and restores parts keepCodes',async t=>{
  const {service,host,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  assert.equal(v.files.length,1);
  assert.equal(v.files[0].role,'reply');

  // removeFile removes reply
  const afterRemove=await host.removeFile(service.key,v.id,'reply');
  assert.equal(afterRemove.files.length,0);
  assert.match(afterRemove.results.at(-1)!,/已移除本地【意见陈述书】/);

  // Re-add file, save, and verify removeFile is rejected when saved
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');
  await assert.rejects(host.removeFile(service.key,v.id,'reply'),/已保存或已转交/);
});

test('clearRemote deletes remote files, resets form, and keeps draft state',async t=>{
  const {service,client,host,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);
  v=await host.save(service.key,v.id,v.review);
  assert.equal(v.phase,'saved');
  assert.equal(client.calls.some(call=>call.endpoint.endsWith('FormOpinionStatement')),true);

  // clearRemote executes remote deletes and resets form
  const cleared=await host.clearRemote(service.key,v.id);
  assert.equal(cleared.phase,'draft');
  assert.equal(cleared.revokedByUser,true);
  assert.equal(cleared.existingFileNames.length,0);
  assert.equal(client.calls.some(call=>call.endpoint.endsWith('DeleteFormFile')),true);
  assert.match(cleared.results.at(-1)!,/已成功物理删除贝思兰德系统内的远端上传文件/);

  // Cannot clear remote after submitted
  const resaved=await host.save(service.key,v.id,cleared.review);
  const submitted=await host.submit(service.key,resaved.id);
  assert.equal(submitted.phase,'submitted');
  await assert.rejects(host.clearRemote(service.key,v.id),/已内部转交/);
});

test('previewFile supports local file, remote download, and partCode preview',async t=>{
  const {service,client,host,c,source}=await setup(t);
  let v=await host.prepare(service.key,c.id);
  v=await host.addFile(service.key,v.id,'reply',source);

  // Preview local reply docx
  const replyPreview=await host.previewFile(service.key,v.id,{role:'reply'});
  assert.ok(replyPreview.name);
  assert.ok(typeof replyPreview.content==='string');

  // Preview partCode
  (host as any).sessions.get(v.id).view.parts=[{code:'100001',name:'权利要求书',after:'1. 一种测试专利。'}];
  const partPreview=await host.previewFile(service.key,v.id,{partCode:'100001'});
  assert.equal(partPreview.name,'权利要求书');
  assert.equal(partPreview.content,'1. 一种测试专利。');

  // Preview by remote fileNo
  const remotePreview=await host.previewFile(service.key,v.id,{fileNo:'remote-f1',name:'远端文件.docx'});
  assert.equal(remotePreview.name,'远端文件.docx');
});


