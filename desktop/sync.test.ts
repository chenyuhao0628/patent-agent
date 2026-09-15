import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopService,mapLimit} from './service.ts';
import {SyncCache} from './sync-cache.ts';
import {makeRound} from '../src/domain/workflow.ts';
import type {Case} from '../src/domain/workflow.ts';
import {atomicJSON} from './files.ts';

function gate(){
  let release!:()=>void,started!:()=>void;
  return {held:new Promise<void>(r=>release=r),began:new Promise<void>(r=>started=r),release:()=>release(),start:()=>started()};
}
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sync-review-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const work=path.join(root,'work'),originals=path.join(root,'originals');
  await fs.mkdir(work);await fs.mkdir(originals);
  const s=new DesktopService(path.join(root,'data'),{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});
  s.key='qa';s.workspace.settings={provider:'',model:'',baseUrl:'',workRoot:work,originalLibrary:originals};
  s.account={username:'qa',displayName:'QA',organization:'test',origin:'https://fixture.invalid',userId:'qa',status:'authenticated',remembered:false};
  const rows=[
    {CaseId:'qa',CaseNo:'QA-123456',CaseName:'Synthetic fixture',CaseProcId:'old',CaseProcName:'第一次审查意见答复',_status:500,CaseHandId:'' as string|undefined},
    {CaseId:'qa',CaseNo:'QA-123456',CaseName:'Synthetic fixture',CaseProcId:'new',CaseProcName:'第二次审查意见答复',_status:0,CaseHandId:'' as string|undefined},
  ];
  const calls:string[]=[];let extra=false,closed=false,processCount=1,fileCount=2;
  let officialState:'draft'|'sent'|'received'='draft';
  let outcomeState:'granted'|'rejected'|'none'='none';
  let outcomeThrows=false;
  const client={
    personalCases:async()=>{calls.push('personal');return rows;},
    personalCasesSnapshot:async(_signal:AbortSignal,initial?:{code:number;count:number}[])=>{
      calls.push('personal');
      return {rows,stats:initial??[{code:0,count:1},{code:200,count:0},{code:300,count:0},{code:400,count:0},{code:500,count:1}]};
    },
    personalProcessStatistics:async()=>{calls.push('process-stats');return [{code:0,count:processCount},{code:200,count:0},{code:300,count:0},{code:400,count:0},{code:500,count:1}];},
    fileCount:async()=>{calls.push('file-count');return fileCount;},
    queryOfficial:async()=>{calls.push('official');return {submission:{state:officialState,source:'send-status' as const,checkedAt:new Date().toISOString(),message:'fixture'},handId:'hand-1',canEdit:false,ok:true};},
    caseClosure:async()=>{calls.push('closure');return {finished:closed,checkedAt:new Date().toISOString()};},
    officialOutcome:async()=>{
      calls.push('outcome');
      if(outcomeThrows)throw new Error('fixture outcome failure');
      return {state:outcomeState,noticeName:outcomeState==='granted'?'办理登记手续通知书':outcomeState==='rejected'?'驳回决定':undefined,postDate:outcomeState==='none'?undefined:'2026-09-14',checkedAt:new Date().toISOString()};
    },
    files:async(id:string)=>{calls.push('files:'+id);return [{FileNo:id+'-notice',FileName:'notice.pdf'},...(id==='old'&&extra?[{FileNo:'late',FileName:'late.pdf'}]:[])];},
    download:async()=>Buffer.from('%PDF-1.7\nfixture\n%%EOF'),
    flow:async(item:Case)=>{const processes=structuredClone(item.remote)!;processes.processes.find(p=>p.id==='new')!.submission={state:'sent',source:'hand',checkedAt:new Date().toISOString()};return {at:new Date().toISOString(),currentProcessId:'new',processes,nodes:[],history:[]};},
  };
  s.client=client as never;await s.sync();
  const c=s.workspace.cases[0],old=makeRound('第一次审查意见答复');old.id='proc-old';
  old.materials=c.materials!.filter(m=>m.id==='file-old-notice');c.materials=c.materials!.filter(m=>m.id!=='file-old-notice');c.rounds.push(old);
  await s.files().ensureCase(c);await s.persist();calls.length=0;
  return {s,root,work,originals,c,client,calls,rows,official:(value:'draft'|'sent'|'received')=>{officialState=value;},outcome:(value:'granted'|'rejected'|'none')=>{outcomeState=value;},outcomeFails:(value:boolean)=>{outcomeThrows=value;},extra:()=>{extra=true;},closed:(value:boolean)=>{closed=value;},changeSignals:()=>{processCount++;fileCount++;}};
}

test('old sync preserves newer official flow in memory, shared index and after reopen',async t=>{
  const {s,c,client}=await fixture(t),g=gate(),files=client.files;
  client.files=async id=>{if(id==='new'){g.start();await g.held;}return files(id);};
  const syncing=s.sync();await g.began;
  await s.flow(c.id);
  assert.equal(s.findCase(c.id).current?.kind,'waiting');
  g.release();await syncing;
  assert.equal(s.findCase(c.id).current?.kind,'waiting');
  const manifest=JSON.parse(await fs.readFile(await s.casePath(c.id,'案件信息.json'),'utf8'));
  assert.equal(manifest.current.kind,'waiting');
  await s.refreshShared(s.key);assert.equal(s.findCase(c.id).current?.kind,'waiting');
});

test('本地脏 + 远端结案：脏本地仍合并结案，不抹掉草稿/标签/当前办理',async t=>{
  const {s,c,client,closed}=await fixture(t),g=gate(),files=client.files;
  closed(true);
  client.files=async id=>{if(id==='new'){g.start();await g.held;}return files(id);};
  const syncing=s.sync();await g.began;
  const live=s.findCase(c.id);
  const preservedProcessId=live.current?.processId;
  const preservedKind=live.current?.kind;
  live.caseRemark='同步期间本地备注';
  live.tags=['保留标签','同步后新增'];
  live.localDraft='必须保留的脏草稿';
  await s.persist();
  g.release();await syncing;
  const after=s.findCase(c.id);
  assert.equal(after.remoteClosure?.finished,true,'远端结案必须写入，不能因本地脏而整段跳过');
  assert.equal(after.archived,true,'首次结案应自动归档');
  assert.equal(after.localDraft,'必须保留的脏草稿');
  assert.deepEqual(after.tags,['保留标签','同步后新增']);
  assert.equal(after.current?.processId,preservedProcessId);
  assert.equal(after.current?.kind,preservedKind);
  assert.equal(after.caseRemark,'同步期间本地备注');
  const manifest=JSON.parse(await fs.readFile(await s.casePath(c.id,'案件信息.json'),'utf8'));
  assert.equal(manifest.remoteClosure.finished,true);
  assert.equal(manifest.current.processId,preservedProcessId);
  assert.equal(manifest.current.kind,preservedKind);
  const profile=JSON.parse(await fs.readFile(s.profileFile(),'utf8'));
  const row=profile.cases.find((x:{id:string})=>x.id===c.id);
  assert.equal(row.archived,true);
  assert.equal(row.localDraft,'必须保留的脏草稿');
  assert.deepEqual(row.tags,['保留标签','同步后新增']);
  assert.equal(row.remoteClosure.finished,true);
});

test('a flow refresh during personal list retrieval also wins over older sync rows',async t=>{
  const {s,c,client}=await fixture(t),g=gate(),personal=client.personalCasesSnapshot;
  client.personalCasesSnapshot=async(signal,initial)=>{g.start();await g.held;return personal(signal,initial);};
  const syncing=s.sync();await g.began;await s.flow(c.id);g.release();await syncing;
  assert.equal(s.findCase(c.id).current?.kind,'waiting');
});

test('manual original import during sync survives final merge and subsequent shared refresh',async t=>{
  const {s,c,client,originals}=await fixture(t),g=gate(),files=client.files;
  client.files=async id=>{if(id==='new'){g.start();await g.held;}return files(id);};
  const syncing=s.sync();await g.began;
  for(const name of ['A','B'])await fs.writeFile(path.join(originals,`QA-123456_${name}.pdf`),Buffer.from('%PDF-1.7\n'+name));
  await s.copyOriginal(c.id,'QA-123456_A.pdf');g.release();await syncing;
  const material=s.findCase(c.id).materials?.find(m=>m.role==='原始申请');assert.ok(material);
  assert.equal(await fs.readFile(await s.casePath(c.id,material.relativePath!),'utf8'),'%PDF-1.7\nA');
  await s.refreshShared(s.key);assert.ok(s.findCase(c.id).materials?.some(m=>m.id===material.id));
});

test('unchanged aggregate signals skip automatic detail sync',async t=>{
  const {s,calls,c,outcome,changeSignals}=await fixture(t);
  // 先让案件拿到官方结论；已出结论的案件在门控命中时既不查明细也不重复判读。
  outcome('granted');changeSignals();
  await s.sync({source:'manual',full:false});
  calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.deepEqual(calls,['process-stats']);
  assert.equal(s.findCase(c.id).number,'QA-123456');
});

test('changed aggregate signals reopen detail sync',async t=>{
  const {s,calls,changeSignals}=await fixture(t);
  changeSignals();calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.ok(calls.includes('process-stats'));
  assert.ok(calls.includes('personal'));
});

test('aggregate signal failure falls back to detail sync',async t=>{
  const {s,client,calls}=await fixture(t);
  client.personalProcessStatistics=async()=>{calls.push('process-stats');throw new Error('fixture signal failure');};
  calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.deepEqual(calls.filter(x=>x==='personal'),['personal']);
});

test('manual full sync fetches historical additions; ordinary incremental uses finite cache',async t=>{
  const {s,c,client,calls,extra,changeSignals}=await fixture(t);extra();
  changeSignals();
  await s.sync({source:'manual',full:false});
  assert.deepEqual(calls.filter(x=>x.startsWith('files:')),['files:new']);
  calls.length=0;await s.sync();
  assert.ok(calls.includes('files:old'));assert.ok(s.findCase(c.id).rounds.find(r=>r.id==='proc-old')?.materials.some(m=>m.id==='file-late'));
  const reopened=new DesktopService(s.root,s.vault);reopened.key=s.key;reopened.workspace=structuredClone(s.workspace);reopened.account=s.account;reopened.client=client as never;
  calls.length=0;await reopened.sync({source:'manual',full:false});assert.ok(calls.includes('files:old'));
});

test('non-current fileListCache misses after status/stamp change so旁路通知 is visible',async t=>{
  const {s,c,calls,extra,changeSignals,rows}=await fixture(t);extra();
  // Warm cache on ready non-current flow (old).
  changeSignals();
  await s.sync({source:'manual',full:false});
  assert.deepEqual(calls.filter(x=>x.startsWith('files:')),['files:new']);
  // Unchanged status/stamp: cache hit, no historical refetch.
  changeSignals();calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.ok(!calls.includes('files:old'));
  // Status change on non-current flow invalidates keyed cache →旁路 late notice appears.
  rows[0]._status=400;
  changeSignals();calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.ok(calls.includes('files:old'));
  assert.ok(s.findCase(c.id).rounds.find(r=>r.id==='proc-old')?.materials.some(m=>m.id==='file-late'));
  // Stamp-only change also misses without thrashing every unchanged sync.
  rows[0]._status=400;
  Object.assign(rows[0],{CaseProcFinishDate:'2026-09-15'});
  changeSignals();calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.ok(calls.includes('files:old'));
  changeSignals();calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.ok(!calls.includes('files:old'),'unchanged status/stamp must keep cache hit');
});

test('automatic triggers share work; a manual request during incremental queues exactly one full pass',async t=>{
  const {s,client,calls,changeSignals}=await fixture(t);changeSignals();
  const g=gate(),personal=client.personalCasesSnapshot;
  let first=true;
  client.personalCasesSnapshot=async(signal,initial)=>{if(first){first=false;g.start();await g.held;}return personal(signal,initial);};
  const initial=s.sync({source:'manual',full:false});await g.began;
  assert.equal(s.sync({source:'timer'}),initial);
  assert.equal(s.sync(),initial);assert.equal(s.sync(),initial);
  g.release();await initial;
  assert.equal(calls.filter(x=>x==='personal').length,2);
  calls.length=0;await s.sync({source:'focus'});await s.sync({source:'timer'});assert.equal(calls.length,0);
});

test('failed historical download retries without caching an incomplete list',async t=>{
  const {s,c,client,extra,calls}=await fixture(t);extra();const download=client.download;
  client.download=async()=>{throw new Error('fixture download failure');};
  await s.sync();assert.match(s.syncState.message,/需重试/);
  client.download=download;calls.length=0;await s.sync({source:'manual',full:false});
  assert.ok(calls.includes('files:old'));
  assert.ok(s.findCase(c.id).rounds.find(r=>r.id==='proc-old')?.materials.find(m=>m.id==='file-late')?.ready);
});

test('closed cache survives one timer interval but full refresh sees changed closure',async t=>{
  const {s,c,closed,calls}=await fixture(t);closed(true);await s.sync();
  const cache=s.caseClosureCache.get('qa')!;cache.at-=6*60*1000;
  calls.length=0;await s.sync({source:'manual',full:false});assert.ok(!calls.includes('closure'));
  closed(false);await s.sync();assert.equal(s.findCase(c.id).remoteClosure?.finished,false);
  assert.equal(s.caseClosureCache.get('qa')?.closure?.finished,false);
});

test('open closure cache expires after three minutes and full refresh bypasses it',async t=>{
  const {s,calls,changeSignals}=await fixture(t);
  changeSignals();await s.sync({source:'manual',full:false});
  assert.ok(!calls.includes('closure'));
  s.caseClosureCache.get('qa')!.at-=3*60*1000;
  changeSignals();calls.length=0;await s.sync({source:'manual',full:false});
  assert.ok(calls.includes('closure'));
  calls.length=0;await s.sync();assert.ok(calls.includes('closure'));
});

test('periodic full verification finds file-only additions despite intervening process changes',async t=>{
  const {s,calls,extra,changeSignals,c}=await fixture(t);
  const now=Date.now();let clock=now;t.mock.method(Date,'now',()=>clock);
  extra();
  for(const minutes of [5,10]){
    clock=now+minutes*60*1000;changeSignals();await s.sync({source:'manual',full:false});
  }
  calls.length=0;clock=now+16*60*1000;await s.sync({source:'manual',full:false});
  assert.ok(calls.includes('files:old'));
  assert.ok(s.findCase(c.id).rounds.find(r=>r.id==='proc-old')?.materials.some(m=>m.id==='file-late'));
  assert.ok(!calls.includes('file-count'));
});

test('forced verification stops re-querying a flow that already reached the receipt terminal state',async t=>{
  const {s,c,calls,official,rows}=await fixture(t);
  rows[1].CaseHandId='hand-1';
  official('received');
  await s.sync();
  assert.equal(s.findCase(c.id).current?.processId,'new');
  assert.equal(s.findCase(c.id).remote?.processes.find(p=>p.id==='new')?.submission?.state,'received');
  assert.deepEqual(calls.filter(x=>x==='official'),['official']);
  calls.length=0;await s.sync();
  assert.deepEqual(calls.filter(x=>x==='official'),[]);
  await s.sync();
  assert.deepEqual(calls.filter(x=>x==='official'),[]);
  assert.equal(s.findCase(c.id).remote?.processes.find(p=>p.id==='new')?.submission?.state,'received');
});

test('a flow still waiting for the receipt is re-queried on every forced verification',async t=>{
  const {s,c,calls,official,rows}=await fixture(t);
  rows[1].CaseHandId='hand-1';
  official('sent');
  await s.sync();
  assert.equal(s.findCase(c.id).current?.processId,'new');
  assert.deepEqual(calls.filter(x=>x==='official'),['official']);
  calls.length=0;await s.sync();
  assert.deepEqual(calls.filter(x=>x==='official'),['official']);
  assert.equal(s.findCase(c.id).remote?.processes.find(p=>p.id==='new')?.submission?.state,'sent');
});

test('case concurrency is bounded and all case indexes remain independently readable',async t=>{
  const {s,client}=await fixture(t),snapshot=client.personalCasesSnapshot;
  client.personalCasesSnapshot=async(signal,initial)=>{
    const result=await snapshot(signal,initial);
    return {...result,rows:Array.from({length:9},(_,i)=>({...result.rows[1],CaseId:'parallel-'+i,CaseNo:'parallel-'+i,CaseProcId:'p-'+i}))};
  };
  let active=0,peak=0;
  client.caseClosure=async()=>{
    active++;peak=Math.max(peak,active);
    await new Promise<void>(resolve=>setImmediate(resolve));
    active--;return {finished:false,checkedAt:new Date().toISOString()};
  };
  await s.sync();
  assert.ok(peak>1);assert.ok(peak<=4);assert.equal(active,0);
  for(const c of s.workspace.cases.filter(c=>c.remote?.caseId.startsWith('parallel-'))){
    const info=JSON.parse(await fs.readFile(await s.casePath(c.id,'案件信息.json'),'utf8'));
    assert.equal(info.id,c.id);
  }
  assert.equal(s.workspace.cases.filter(c=>c.remote?.caseId.startsWith('parallel-')).length,9);
});

test('pool drains admitted work and stops scheduling after failure',async()=>{
  const g=gate(),calls:number[]=[];let ended=false;
  const work=mapLimit([0,1,2,3],2,async i=>{
    calls.push(i);
    if(i===0){await g.held;return;}
    throw new Error('fixture failure');
  });
  const result=work.then(()=>{ended=true;},()=>{ended=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(ended,false);assert.deepEqual(calls,[0,1]);
  g.release();await result;assert.equal(ended,true);
});

test('late old-account sync response cannot fill caches or write to the next account root',async t=>{
  const {s,c,client,root}=await fixture(t),g=gate();
  client.caseClosure=async()=>{g.start();await g.held;return {finished:true,checkedAt:new Date().toISOString()};};
  const workB=path.join(root,'work-b');await fs.mkdir(workB);
  await atomicJSON(path.join(s.root,'profiles/local/workspace.json'),{schema:1,cases:[],settings:{provider:'',model:'',baseUrl:'',workRoot:workB}});
  const syncing=s.sync();await g.began;await s.logout();g.release();await syncing;
  assert.equal(s.workspace.cases.length,0);assert.equal(s.caseClosureCache.size,0);
  await assert.rejects(fs.stat(path.join(workB,c.directory!)),/ENOENT/);
});

test('cache expires and evicts oldest entries with a strict upper bound',()=>{
  let now=1000;const cache=new SyncCache<{at:number}>(100,2,()=>now);
  cache.set('a',{at:1000});cache.set('b',{at:1000});cache.set('c',{at:1000});
  assert.equal(cache.size,2);assert.equal(cache.get('a'),undefined);
  now=1100;assert.equal(cache.get('b'),undefined);assert.equal(cache.size,0);
  cache.set('future',{at:1200});assert.equal(cache.size,0);
});

test('routine sync judges the official outcome together with the case data',async t=>{
  const {s,calls,changeSignals,outcome}=await fixture(t);
  changeSignals();await s.sync({source:'manual',full:false});
  assert.equal(calls.filter(x=>x==='outcome').length,1,'未出结论的案件与案件数据同一次同步判读');
  assert.equal(s.workspace.cases[0].officialOutcome?.state,'none');
  calls.length=0;outcome('granted');changeSignals();await s.sync({source:'manual',full:false});
  assert.equal(calls.filter(x=>x==='outcome').length,1);
  assert.equal(s.workspace.cases[0].officialOutcome?.state,'granted');
  assert.equal(s.workspace.cases[0].officialOutcome?.postDate,'2026-09-14');
  calls.length=0;changeSignals();await s.sync({source:'manual',full:false});
  assert.equal(calls.filter(x=>x==='outcome').length,0,'已出结论的案件在 7 天内不再重复判读');
  const manifest=JSON.parse(await fs.readFile(await s.casePath(s.workspace.cases[0].id,'案件信息.json'),'utf8'));
  assert.equal(manifest.officialOutcome.state,'granted','shared index carries the conclusion for other devices');
  calls.length=0;
  const state=await s.refreshCaseOutcomes(s.key);
  assert.equal(calls.filter(x=>x==='outcome').length,1,'手动重新判读忽略 7 天缓存');
  assert.equal(state.workspace.cases[0].officialOutcome?.state,'granted');
});

test('aggregate gate hit skips details but still judges undecided cases',async t=>{
  const {s,calls,outcome}=await fixture(t);
  await s.sync({source:'manual',full:false});
  calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.deepEqual(calls,['process-stats','outcome'],'统计未变化时明细被跳过，但结论判读继续');
  assert.match(s.syncState.message,/案件状态已判读/);
  outcome('rejected');
  await s.refreshCaseOutcomes(s.key);
  calls.length=0;
  await s.sync({source:'manual',full:false});
  assert.deepEqual(calls,['process-stats'],'已出结论的案件在门控命中时不再判读');
});

test('outcome failure during explicit judging reports error and never writes corrupted conclusion',async t=>{
  const {s,calls,outcome,outcomeFails}=await fixture(t);
  outcome('none');
  await s.refreshCaseOutcomes(s.key);
  assert.equal(s.workspace.cases[0].officialOutcome?.state,'none');
  calls.length=0;outcomeFails(true);
  await s.refreshCaseOutcomes(s.key).then(()=>{throw new Error('expected rejection');},e=>assert.match((e as Error).message,/待重试/));
  assert.equal(s.workspace.cases[0].officialOutcome?.state,'none','a failed judge never overwrites the stored conclusion');
  outcomeFails(false);outcome('granted');
  const state=await s.refreshCaseOutcomes(s.key);
  assert.equal(state.workspace.cases[0].officialOutcome?.state,'granted');
});

test('outcome judging stays inside the account and is skipped for local cases',async t=>{
  const {s,calls,outcomeFails}=await fixture(t);
  await s.createCase({title:'本机案件',number:'LOCAL-9',kind:'write'});
  calls.length=0;
  await s.refreshCaseOutcomes(s.key);
  assert.equal(calls.filter(x=>x==='outcome').length,1,'only the Baseland case is judged');
  assert.equal(s.workspace.cases.find(c=>c.source==='local')?.officialOutcome,undefined);
  outcomeFails(true);calls.length=0;
  await s.logout();
  assert.equal(s.workspace.cases.length,0);
  assert.equal(calls.filter(x=>x==='outcome').length,0,'no judgement runs after the account is switched away');
});

test('single-case re-judge only touches that case and refuses without a Baseland link',async t=>{
  const {s,calls,client}=await fixture(t);
  const target=s.workspace.cases[0];
  await s.createCase({title:'本机案件',number:'LOCAL-10',kind:'write'});
  const local=s.workspace.cases.find(c=>c.source==='local')!;
  await assert.rejects(s.refreshCaseOutcome(s.key,local.id),/没有贝思兰德官文清单/);
  calls.length=0;
  const state=await s.refreshCaseOutcome(s.key,target.id);
  assert.deepEqual(calls,['outcome']);
  assert.equal(state.workspace.cases.find(c=>c.id===target.id)?.officialOutcome?.state,'none');
  const manifest=JSON.parse(await fs.readFile(await s.casePath(target.id,'案件信息.json'),'utf8'));
  assert.equal(manifest.officialOutcome.state,'none');
  assert.equal(s.workspace.cases.find(c=>c.id===local.id)?.officialOutcome,undefined);
});

test('outcome judging refuses early without workRoot and makes zero network calls',async t=>{
  const {s,calls}=await fixture(t);
  s.workspace.settings.workRoot=undefined;
  calls.length=0;
  await assert.rejects(s.refreshCaseOutcome(s.key,s.workspace.cases[0].id),/请先选择总工作文件夹/);
  await assert.rejects(s.refreshCaseOutcomes(s.key),/请先选择总工作文件夹/);
  assert.equal(calls.length,0,'no network requests are fired when workRoot is missing');
});
