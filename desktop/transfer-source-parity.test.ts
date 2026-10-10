import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Server } from './test-support/transfer-server.ts';
import { BaselandClient } from './baseland.ts';
import { DesktopService } from './service.ts';
import { TransferHost } from './transfer-host.ts';
import type { AgentHost } from './agent-host.ts';
import type { Case } from '../src/domain/workflow.ts';
import type { ApplicationParts } from '../src/domain/application-parts.ts';

// All materials, credentials and remote state are synthetic. Compare identical
// bytes, filenames, roles and reviewed forms against independent remote states.
async function fixture(t:test.TestContext,parts:ApplicationParts){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pwb-source-parity-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const service=new DesktopService(root,{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
  service.key='parity-qa';
  service.account={username:'qa',displayName:'测试用户',organization:'合成组织',origin:'https://test.baselandtec.com',userId:'qa-user',status:'authenticated',remembered:false};
  const work=path.join(root,'work');await fs.mkdir(work);
  service.workspace.settings={provider:'',baseUrl:'',model:'',workRoot:work};
  const c:Case={id:'qa-case',number:'CASE-ONLY',title:'隔离对照案件',source:'baseland',type:'发明',deadline:'',archived:false,tags:[],rounds:[],current:{kind:'reply',processId:'proc-1',remoteStatus:400},remote:{caseId:'remote-case',syncedAt:'',processes:[{id:'proc-1',name:'第一次审查意见',status:400,node:'文件准备',undertaker:'测试用户',deadline:''}]}};
  service.workspace.cases=[c];c.directory=await service.files().ensureCase(c);
  const client=new Server();service.client=client;
  const agent={getCase:async()=>({artifacts:[],process:{drafts:[{id:'parity-draft',text:'本次答复使用合成材料。',adoptStatus:'adopted',applicationParts:parts}],currentDraftVersionId:'parity-draft',classification:{status:'classified',noticeCategory:'审查意见通知书',officeActionRound:1}}})} as unknown as AgentHost;
  return {root,service,client,c,host:new TransferHost(service,agent,{templatesRoot:path.resolve('resources/document-templates')})};
}

function trace(client:BaselandClient,rejectApplication=false){
  const events:unknown[]=[];
  const request=client.request.bind(client),upload=client.uploadDocument.bind(client);
  client.request=async(endpoint,body,params)=>{
    events.push({endpoint,body:structuredClone(body),params:structuredClone(params)});
    if(rejectApplication&&['UploadFormFile','UploadExistFileFormInstructionsAndImage'].some(ep=>endpoint.endsWith('/'+ep)))return 'InvalidFileFormat';
    return request(endpoint,body,params);
  };
  client.uploadDocument=async(name:string,bytes:Buffer)=>{
    events.push({upload:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    return upload(name,bytes);
  };
  return events;
}

async function compareSources(t:test.TestContext,parts:ApplicationParts,options:{showName?:boolean;rejectApplication?:boolean}={}){
  const auto=await fixture(t,parts),local=await fixture(t,parts);
  for(const f of [auto,local]){
    f.client.setting.IsShowCaseName=options.showName??false;
    f.client.setting.CaseName='远端已确认的原名称';
    // The mock parser only returns sections present in the synthetic fixture.
    f.client.parsedCodes=Object.keys(parts).map(key=>({CLAIMS:'100001',DESCRIPTION:'100002'} as Record<string,string>)[key]);
  }
  let a=await auto.host.prepare(auto.service.key,auto.c.id,false,'workbench');
  let b=await local.host.prepare(local.service.key,local.c.id,false,'local');
  assert.equal(a.sourceDraft?.id,'parity-draft');assert.equal(b.sourceDraft,undefined);
  for(const file of a.files){
    const copy=path.join(local.root,file.name);
    await fs.copyFile(await auto.service.casePath(auto.c.id,file.relativePath),copy);
    b=await local.host.addFile(local.service.key,b.id,file.role,copy);
  }
  assert.deepEqual(b.files.map(f=>[f.role,f.name,f.hash]),a.files.map(f=>[f.role,f.name,f.hash]));
  const review=structuredClone(a.review);
  const left=trace(auto.client,options.rejectApplication),right=trace(local.client,options.rejectApplication);
  // The only source-specific prerequisite must fail before any remote request.
  await assert.rejects(auto.host.save(auto.service.key,a.id,review),/确认.*稿件版本/);
  assert.deepEqual(left,[]);
  a=await auto.host.save(auto.service.key,a.id,{...review,confirmedDraftId:'parity-draft'});
  b=await local.host.save(local.service.key,b.id,review);
  assert.deepEqual(left,right,'同字节、同角色、同表单产生完全相同的上传摘要和请求序列');
  assert.equal(a.phase,b.phase);assert.equal(a.error,b.error);
  assert.deepEqual(auto.client.group,local.client.group);assert.deepEqual(auto.client.form,local.client.form);
  assert(!auto.client.calls.some(c=>c.endpoint.endsWith('/SubmitHandFlow')));
  const uploads=(left as Array<{upload?:string}>).filter(e=>e.upload);
  t.diagnostic(JSON.stringify({sources:['workbench','local'],roles:a.files.map(f=>f.role),sameRequests:true,uploads:uploads.length,phase:a.phase,error:a.error??null}));
  return {a,auto,uploads};
}

test('source parity: identical generated reply uses identical uploads and business requests',async t=>{
  const {a,uploads}=await compareSources(t,{});assert.equal(a.phase,'saved',a.error);assert.equal(uploads.length,1);
});

test('source parity: identical claims, description and reply use identical uploads and business requests',async t=>{
  const {a,uploads}=await compareSources(t,{CLAIMS:'1. 一种合成测试装置，包括底座。',DESCRIPTION:'合成测试装置\n技术领域\n本申请用于隔离测试。'},{showName:true});
  assert.equal(a.phase,'saved',a.error);
  assert.equal(uploads.length,a.files.length);
});

test('source parity: claims-only amendments preserve the existing remote name for both sources',async t=>{
  const {a,auto}=await compareSources(t,{CLAIMS:'1. 一种合成测试装置，包括底座。'},{showName:true});
  assert.equal(a.phase,'saved',a.error);assert.equal(auto.client.setting.CaseName,'远端已确认的原名称');
});

test('source parity: application rejection stops both sources before reply upload and handoff',async t=>{
  const {a,auto,uploads}=await compareSources(t,{CLAIMS:'1. 一种合成测试装置。',DESCRIPTION:'合成测试说明书'},{rejectApplication:true});
  assert.equal(a.phase,'uncertain');assert.match(a.error??'',/文件格式|InvalidFileFormat/);
  assert.equal(uploads.length,1);assert.equal(auto.client.form,null);assert.equal(auto.client.group.length,0);
});
