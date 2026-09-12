import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Server } from './test-support/transfer-server.ts';
import { DesktopService } from './service.ts';
import { TransferHost } from './transfer-host.ts';
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
  client.flowInfo.FlowUserName='杨佳';v=await reopened.refresh(service.key,v.id);assert.equal(v.phase,'submitted');
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
 v=await host.save(service.key,v.id,v.review);assert.equal(v.phase,'saved');v=await host.submit(service.key,v.id);assert.equal(v.phase,'submitted');
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
 client.parsedCodes=['100001'];view=await host.save(service.key,view.id,view.review);assert.equal(view.phase,'saved');
 assert.equal(client.serial,1);assert.equal(client.form.File,undefined);assert.equal(client.form.CorrectionContentList[0].ChangeId,'server-row');
 assert(!client.calls.some(c=>c.endpoint.endsWith('SubmitHandFlow')));
});
