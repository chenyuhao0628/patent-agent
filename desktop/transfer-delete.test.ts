import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Server } from './test-support/transfer-server.ts';
import { DesktopService } from './service.ts';
import { TransferHost } from './transfer-host.ts';
import { ipcRemoteFileDeleteRef } from './ipc-contracts.ts';
import type { AgentHost } from './agent-host.ts';
import type { Case } from '../src/domain/workflow.ts';
import type { TransferView } from '../src/transfer-api.ts';

async function setup(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pwb-delete-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const service=new DesktopService(root,{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
  service.key='profile-qa';
  service.account={username:'qa',displayName:'测试用户',organization:'合成组织',origin:'https://test.baselandtec.com',userId:'qa-user',status:'authenticated',remembered:false};
  const work=path.join(root,'work');await fs.mkdir(work);service.workspace.settings={provider:'',baseUrl:'',model:'',workRoot:work};
  const c:Case={id:'qa-case',number:'DELETE-QA',title:'隔离单份删除验证',source:'baseland',type:'发明',deadline:'',archived:false,tags:[],rounds:[],current:{kind:'reply',processId:'proc-1',remoteStatus:400},remote:{caseId:'remote-case',syncedAt:'',processes:[{id:'proc-1',name:'第一次审查意见',status:400,node:'文件准备',undertaker:'测试用户',deadline:''}]}};
  service.workspace.cases=[c];c.directory=await service.files().ensureCase(c);
  const client=new Server();service.client=client;
  client.group=[
    {FormCode:100001,File:{FileNo:'claims',FileName:'同名材料.docx'}},
    {FormCode:100002,File:{FileNo:'description',FileName:'同名材料.docx'}},
    {IsMixFile:true,File:{FileNo:'mix',FileName:'完整申请文件.docx'}},
  ];
  client.form={CaseHandId:'hand-1',FormCode:'100012',File:{FileNo:'opinion',FileName:'意见陈述书.docx'},OpinionStatement:{NoticeDate:'2026-09-10',NoticeName:'第一次审查意见通知书',NoticeNo:'NOTICE-QA',OpinionStatementType:1,Untouched:'FORM-KEEP'}};
  const agent={getCase:async()=>{throw Error('单份删除不应读取 AI');}} as unknown as AgentHost;
  const host=new TransferHost(service,agent);
  const view=await host.prepare(service.key,c.id,false,'local');
  assert.equal(view.phase,'saved');
  return {root,service,client,agent,host,c,view};
}
const target=(v:TransferView,fileNo:string)=>{const ref=v.existingFiles?.find(f=>f.fileNo===fileNo)?.deleteRef;assert.ok(ref,'file must have a verified unique association');return ref;};
const writes=(s:Server)=>s.calls.filter(c=>/(Delete|Update|Insert|Submit|Upload)/.test(c.endpoint));

for(const [fileNo,endpoint] of [['claims','DeleteFormFile'],['mix','DeleteFormInstructionsAndImageMixFile'],['opinion','UpdateFormOpinionStatement']] as const){
  test(`single deletion of ${fileNo} preserves all other files and form fields`,async t=>{
    const {service,client,host,c,agent,view}=await setup(t);
    const form=structuredClone(client.form),group=structuredClone(client.group);
    const expected=view.existingFiles!.filter(f=>f.fileNo!==fileNo).map(f=>f.fileNo).sort();
    const result=await host.deleteRemoteFile(service.key,view.id,target(view,fileNo));
    assert.equal(result.phase,'draft',result.error);assert.equal(result.fileDeletion,undefined);
    assert.deepEqual(result.existingFiles!.map(f=>f.fileNo).sort(),expected);
    if(fileNo==='opinion'){assert.deepEqual(client.form,{...form,File:null});assert.deepEqual(client.group,group);}
    else {assert.deepEqual(client.form,form);assert.deepEqual(client.group,group.filter(g=>g.File.FileNo!==fileNo));}
    assert.deepEqual(writes(client).map(c=>c.endpoint),['/CaseInfo/'+endpoint]);
    await assert.rejects(host.submit(service.key,result.id),/先完成/);
    const reopened=new TransferHost(service,agent);
    const restored=await reopened.inspect(service.key,c.id);assert.equal(restored?.phase,'draft');
    assert.deepEqual(restored?.existingFiles,result.existingFiles);assert.equal(writes(client).length,1);
  });
}

test('single deletion preserves local original, selected copy and edited review',async t=>{
  const {root,service,client,host,view}=await setup(t);
  let v=await host.revoke(service.key,view.id);
  const source=path.join(root,'original.docx');await fs.copyFile(path.resolve('resources/document-templates/reply.docx'),source);
  v=await host.addFile(service.key,v.id,'reply',source);v.review.remark='保留我的备注';v.review.form.noticeNo='本地未上传字段';
  v=await host.saveLocalReview(service.key,v.id,v.review);
  const selected=v.files.find(f=>f.role==='reply')!,local=await service.casePath(v.caseId,selected.relativePath);
  const original=await fs.readFile(source),copy=await fs.readFile(local),before=structuredClone(v.review);
  v=await host.deleteRemoteFile(service.key,v.id,target(v,'opinion'));
  assert.equal(v.phase,'draft',v.error);assert.deepEqual(v.review,before);assert.deepEqual(v.files,[selected]);
  assert.deepEqual(await fs.readFile(source),original);assert.deepEqual(await fs.readFile(local),copy);
  assert.equal(client.serial,0);
});

test('stale identity, material version and permission fail before any remote write',async t=>{
  const {service,client,host,view}=await setup(t),ref=target(view,'claims');
  for(const patch of [{fileNo:'missing'},{handId:'other-hand'},{fingerprint:'a'.repeat(64)}]){
    await assert.rejects(host.deleteRemoteFile(service.key,view.id,{...ref,...patch}));
  }
  client.canEdit=false;await assert.rejects(host.deleteRemoteFile(service.key,view.id,ref));
  client.canEdit=true;client.group[1].File.FileNo='changed';await assert.rejects(host.deleteRemoteFile(service.key,view.id,ref),/变化/);
  assert.equal(writes(client).length,0);
});

test('file mutation between initial check and final pre-write read never deletes',async t=>{
  const {service,client,host,view}=await setup(t);const request=client.request.bind(client);let reads=0;
  client.request=async(ep,body,params)=>{if(ep.endsWith('GetHandInfo')&&++reads===2)client.group[0].File.FileNo='replacement';return request(ep,body,params);};
  const result=await host.deleteRemoteFile(service.key,view.id,target(view,'claims'));
  assert.equal(result.phase,'saved');assert.match(result.error!,/变化/);assert.equal(result.fileDeletion,undefined);assert.equal(writes(client).length,0);
});

test('ambiguous and unsupported remote attachments never get a deletion target',async t=>{
  const {service,client,host,view}=await setup(t);
  client.group.push({FormCode:100003,File:{FileNo:'claims',FileName:'另一个关联.docx'}},{FormCode:999999,File:{FileNo:'unsupported',FileName:'不支持的附件.docx'}});
  const refreshed=await host.refresh(service.key,view.id);
  for(const no of ['claims','unsupported']){const file=refreshed.existingFiles!.find(f=>f.fileNo===no)!;assert.equal(file.deleteRef,undefined);assert.ok(file.deleteDisabledReason);}
  await assert.rejects(host.deleteRemoteFile(service.key,view.id,{...target(view,'claims'),fileNo:'unsupported'}));
  assert.equal(writes(client).length,0);
});

test('lost delete response persists uncertain identity; reopen verifies without resending',async t=>{
  const {service,client,host,agent,c,view}=await setup(t);const request=client.request.bind(client);
  client.request=async(ep,body,params)=>{const result=await request(ep,body,params);if(ep.endsWith('DeleteFormFile'))throw Error('合成响应中断');return result;};
  let v=await host.deleteRemoteFile(service.key,view.id,target(view,'claims'));
  assert.equal(v.phase,'uncertain');assert.equal(v.fileDeletion?.target.fileNo,'claims');
  const journal=JSON.parse(await fs.readFile(await service.casePath(c.id,`04_内部说明/transfer-${v.id}.json`),'utf8'));
  assert.equal(journal.view.fileDeletion.target.fileNo,'claims');
  const reopened=new TransferHost(service,agent);v=(await reopened.inspect(service.key,c.id))!;assert.equal(v.phase,'uncertain');
  await assert.rejects(reopened.revoke(service.key,v.id),/单份删除/);
  await assert.rejects(reopened.clearRemote(service.key,v.id),/单份删除/);
  await assert.rejects(reopened.reprepare(service.key,v.id),/单份删除/);
  await assert.rejects(reopened.deleteRemoteFile(service.key,v.id,target(view,'claims')),/当前状态/);
  v=await reopened.refresh(service.key,v.id);assert.equal(v.phase,'draft',v.error);assert.equal(v.fileDeletion,undefined);
  assert.equal(writes(client).length,1);assert.ok(!v.existingFiles?.some(f=>f.fileNo==='claims'));
});

test('success response without deletion is uncertain; refresh never repeats the write',async t=>{
  const {service,client,host,view}=await setup(t);const request=client.request.bind(client);
  client.request=async(ep,body,params)=>{if(ep.endsWith('DeleteFormFile')){client.calls.push({endpoint:ep,body,params});return 'Success';}return request(ep,body,params);};
  let v=await host.deleteRemoteFile(service.key,view.id,target(view,'claims'));
  assert.equal(v.phase,'uncertain');assert.ok(v.fileDeletion);
  v=await host.refresh(service.key,v.id);assert.equal(v.phase,'draft');assert.equal(v.fileDeletion,undefined);
  assert.ok(v.existingFiles?.some(f=>f.fileNo==='claims'));assert.equal(writes(client).length,1);
});

test('collateral file changes remain uncertain after reopen and block further deletion',async t=>{
  const {service,client,host,agent,c,view}=await setup(t);const request=client.request.bind(client);
  client.request=async(ep,body,params)=>{const result=await request(ep,body,params);if(ep.endsWith('DeleteFormFile'))client.group=client.group.filter(g=>g.File.FileNo!=='description');return result;};
  let v=await host.deleteRemoteFile(service.key,view.id,target(view,'claims'));assert.equal(v.phase,'uncertain');
  const reopened=new TransferHost(service,agent);v=(await reopened.inspect(service.key,c.id))!;
  v=await reopened.refresh(service.key,v.id);assert.equal(v.phase,'uncertain');assert.ok(v.fileDeletion);assert.match(v.error!,/其他远端材料/);
  await assert.rejects(reopened.deleteRemoteFile(service.key,v.id,target(view,'mix')));assert.equal(writes(client).length,1);
});

test('account or process switches during read prevent deletion',async t=>{
  for(const change of ['account','process'] as const){await t.test(change,async t=>{
    const {service,client,host,c,view}=await setup(t);const request=client.request.bind(client);
    client.request=async(ep,body,params)=>{const result=await request(ep,body,params);if(ep.endsWith('GetHandInfo')){if(change==='account')service.key='different';else c.current!.processId='another';}return result;};
    await assert.rejects(host.deleteRemoteFile('profile-qa',view.id,target(view,'claims')));assert.equal(writes(client).length,0);
  });}
});

test('deletion IPC requires exact nonempty immutable identity and valid fingerprint',()=>{
  const ref={fileNo:'file-1',handId:'hand-1',fingerprint:'a'.repeat(64)};assert.deepEqual(ipcRemoteFileDeleteRef(ref),ref);
  for(const input of [null,{}, {...ref,fileNo:''},{...ref,fileNo:'0'},{...ref,fileNo:'00000000-0000-0000-0000-000000000000'}, {...ref,handId:''}, {...ref,fingerprint:'old'}, {...ref,name:'same-name.docx'}])assert.throws(()=>ipcRemoteFileDeleteRef(input));
});
