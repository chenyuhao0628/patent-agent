import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdapterRegistry } from '../src/contracts/adapter-registry.ts';
import { createWorkspaceAdapters, localWorkspaceAdapter, WORKSPACE_CAPABILITIES } from './workspace-adapters.ts';
import { createCaseSystemAdapters, baselandAdapter, CASE_SYSTEM_CAPABILITIES } from './case-system-adapters.ts';
import { createEngineAdapters, ENGINE_CAPABILITIES } from './engine-adapters.ts';
import type { WorkspaceRepository } from './workspace-repository.ts';
import type { CaseSystemClient } from './case-system-contract.ts';
import type { Workspace } from '../src/domain/workflow.ts';
import { caseRecordFromCase } from '../src/domain/case-record.ts';
import { DesktopService } from './service.ts';
import { createHostRun } from './agent-integration.ts';
import type { AgentHostRunEvent } from './agent-host.ts';

test('adapter selection rejects unknown IDs, duplicates, incompatible versions and missing capabilities before constructing',()=>{
  let created=0;
  const capabilities=['read'];
  const definition={id:'synthetic',contractVersion:1,capabilities,create:()=>{created++;return {};}};
  const registry=createAdapterRegistry([definition,{...definition,id:'incompatible',contractVersion:2},{...definition,id:'incomplete',capabilities:[]}],['read']);
  capabilities.length=0;
  assert.throws(()=>registry.create('unknown',{}),/未注册/);
  assert.throws(()=>registry.create('incompatible',{}),/版本/);
  assert.throws(()=>registry.create('incomplete',{}),/能力/);
  assert.equal(created,0);registry.create('synthetic',{});assert.equal(created,1);
  assert.throws(()=>createAdapterRegistry([definition,definition],[]),/重复/);
  assert.throws(()=>createAdapterRegistry([{...definition,capabilities:['']}],[]),/无效/);
});

const empty=():Workspace=>({schema:1,cases:[],settings:{provider:'',baseUrl:'',model:''}});
const vault={available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''};

// This substitute owns its state and implements the contract without deriving
// from the file repository. Production continues to use local-files.
function memoryRepository(root:string):WorkspaceRepository {
  const values=new Map<string,Workspace>();
  return {
    id:'memory-fixture',contractVersion:1,
    file:key=>path.join(root,'profiles',key,'workspace.json'),
    load:async key=>({workspace:structuredClone(values.get(key)??empty()),needsPersist:!values.has(key),needsBackup:false,unsafe:false}),
    backup:async()=>{},
    save:async(key,value,guard)=>{guard();const snapshot=structuredClone(value);await Promise.resolve();guard();values.set(key,snapshot);},
    record:(_key,item)=>caseRecordFromCase(item),
  };
}

for(const id of ['local-files','memory-fixture'])test(`${id}: the same service persists, reopens and guards independent profiles`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'adapter-store-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const registry=createWorkspaceAdapters([localWorkspaceAdapter,{id:'memory-fixture',contractVersion:1,capabilities:WORKSPACE_CAPABILITIES,create:({root})=>memoryRepository(root)}]);
  const repository=registry.create(id,{root});
  const service=new DesktopService(root,vault,undefined,repository);await service.init();
  service.workspace.cases.push({id:'case-a',number:'A',title:'用户保留稿',type:'发明',deadline:'',tags:[],archived:false,rounds:[],current:{kind:'write'},localDraft:'不得覆盖的正文'});
  await service.persist();
  const bob=empty();bob.cases=[{...service.workspace.cases[0],id:'case-b',localDraft:'另一账号'}];
  await repository.save('bob',bob,()=>{});
  const reopened=new DesktopService(root,vault,undefined,repository);await reopened.init();
  assert.equal(reopened.workspace.cases[0].localDraft,'不得覆盖的正文');
  assert.equal((await repository.load('bob')).workspace.cases[0].id,'case-b');
  await assert.rejects(repository.save('local',empty(),()=>{throw new Error('scope changed');}),/scope changed/);
  assert.equal((await repository.load('local')).workspace.cases[0].id,'case-a');
  await assert.rejects(reopened.save('bob',bob),/账号|范围/);
  assert.equal((await repository.load('local')).workspace.cases[0].localDraft,'不得覆盖的正文');
});

const origin='https://contract.baselandtec.com';
const stats=[0,200,300,400,500].map(code=>({code,count:code===0?1:0}));
const row={CaseId:'synthetic-case',CaseProcId:'synthetic-process',CaseNo:'CONTRACT-001',CaseName:'合成案件',CaseProcName:'提出申请',_status:0};
const files=[{FileNo:'fixture-pdf',FileName:'合成通知.pdf'}];
const pdf=Buffer.from('%PDF-1.7\nCONTRACT-FIXTURE\n%%EOF');
function syntheticClient(o:string,token=''):CaseSystemClient {
  const client:CaseSystemClient={
    origin:o,token,
    identity:async username=>({origin:o,username,userId:username,displayName:username,organization:'合成',remembered:false,status:'authenticated'}),
    login:async(username,_password,signal)=>{signal?.throwIfAborted();client.token='synthetic-token';return client.identity(username,signal);},
    personalCasesSnapshot:async signal=>{signal.throwIfAborted();return {rows:[structuredClone(row)],stats};},
    personalCases:async signal=>(await client.personalCasesSnapshot(signal)).rows,
    personalProcessStatistics:async signal=>{signal?.throwIfAborted();return stats;},
    caseFileCount:async()=>1,
    files:async(_id,signal)=>{signal.throwIfAborted();return files;},
    download:async(_id,signal)=>{signal.throwIfAborted();return pdf;},
    queryOfficial:async()=>({ok:true,submission:{state:'draft',source:'hand',checkedAt:new Date().toISOString()}}),
    caseClosure:async()=>undefined,
    officialOutcome:async()=>({state:'none',checkedAt:new Date().toISOString()}),
    caseInfo:async()=>({at:new Date().toISOString()}),
    flow:async item=>({at:new Date().toISOString(),processes:item.remote!,nodes:[],history:[]}),
    uploadDocument:async()=>{throw new Error('synthetic write disabled');},
    request:async()=>{throw new Error('synthetic write disabled');},
  };return client;
}
const syntheticFetch:typeof fetch=async(input,init)=>{
  init?.signal?.throwIfAborted();
  const endpoint=new URL(String(input)).pathname.split('/').at(-1),body=init?.body?JSON.parse(String(init.body)):{};
  let data:unknown;
  switch(endpoint){
    case 'GetToken':data={Token:'synthetic-token'};break;
    case 'GetLoginInfo':case 'GetCurrentUserInfo':data={UserName:'alice',UserId:'alice',RealName:'alice',TenantName:'合成'};break;
    case 'GetPersonalProcStatistics':data=stats.map(({code,count})=>({Code:code,Count:count}));break;
    case 'GetPersonalCaseCount':data=body.ActiveName==='waitHand'?1:0;break;
    case 'GetPersonalCase':data={List:body.ActiveName==='waitHand'?[row]:[],Total:body.ActiveName==='waitHand'?1:0};break;
    case 'GetCaseProcFileList':data=files;break;
    case 'FileStorageGetFile':return new Response(pdf);
    default:throw new Error(`unexpected synthetic request: ${endpoint}`);
  }return Response.json({IsSuccess:true,Data:data});
};
for(const id of ['baseland','synthetic-case-system'])test(`${id}: registered clients provide the same login, case, file and cancellation contract`,async t=>{
  const registry=createCaseSystemAdapters([baselandAdapter,{id:'synthetic-case-system',contractVersion:1,capabilities:CASE_SYSTEM_CAPABILITIES,create:({origin,token})=>syntheticClient(origin,token)}]);
  const factory=(origin:string,token?:string)=>registry.create(id,{origin,token,fetchImpl:syntheticFetch});
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'adapter-client-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const service=new DesktopService(root,vault,factory);await service.init();await service.login({origin,username:'alice',password:'synthetic',remember:false});
  assert.equal(service.account?.username,'alice');
  const client=service.client!,signal=new AbortController().signal;
  const snapshot=await client.personalCasesSnapshot(signal);
  assert.equal(snapshot.rows.length,1);assert.equal(snapshot.rows[0].CaseId,row.CaseId);assert.deepEqual(snapshot.stats,stats);
  assert.deepEqual(await client.files(row.CaseProcId,signal),files);
  assert.deepEqual(await client.download('fixture-pdf',signal),pdf);
  await assert.rejects(client.personalProcessStatistics(AbortSignal.abort()),/abort|停止/i);
  await service.logout();assert.equal(service.account,null);assert.equal(service.workspace.cases.length,0);
});

test('a registered replacement engine receives cancellation and cannot publish a late completed task',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'adapter-engine-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const events:AgentHostRunEvent[]=[];
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const registry=createEngineAdapters([{id:'replacement',contractVersion:1,capabilities:ENGINE_CAPABILITIES,create:()=>({run:async input=>{
    assert.deepEqual(input.publicMessages,[]);assert.equal(input.review,true);assert.equal(input.materials.length,0);
    input.onEvent({type:'delta',text:'合成增量'});entered();
    await new Promise<void>(resolve=>input.signal!.addEventListener('abort',()=>resolve(),{once:true}));
    input.onEvent({type:'delta',text:'迟到消息'});
    return {status:'completed',finalText:'迟到完成',toolEvents:[]};
  }})}]);
  const run=createHostRun(registry.create('replacement',{binaryPath:'unused'}));
  const handle=await run({runId:'r',caseId:'c',processKey:'p',discussionId:'d',action:'review',snapshotDir:path.join(root,'snapshot'),outputDir:path.join(root,'output'),materials:[],messages:[{role:'user',text:'不得送入独立复核'}],prompt:{rules:'',task:'',combined:'review'},runtime:{profileKey:'synthetic',providerId:'synthetic',providerName:'Synthetic',baseURL:'https://example.invalid',modelId:'synthetic',displayName:'Synthetic',key:'synthetic',headers:{},protocol:'openai-responses',reasoning:{levelId:'default',protocol:'openai-responses',omitted:true,unverified:true,source:'unverified'}},signal:new AbortController().signal,onEvent:event=>{events.push(event);}});
  await started;handle.abort();await handle.wait;
  assert.deepEqual(events.map(e=>e.type),['partial','stopped']);
  await assert.rejects(fs.access(path.join(root,'output','result.json')));
});
