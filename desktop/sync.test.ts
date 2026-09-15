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
    files:async(id:string)=>{calls.push('files:'+id);return [{FileNo:id+'-notice',FileName:'notice.pdf'},...(id==='old'&&extra?[{FileNo:'late',FileName:'late.pdf'}]:[])];},
    download:async()=>Buffer.from('%PDF-1.7\nfixture\n%%EOF'),
    flow:async(item:Case)=>{const processes=structuredClone(item.remote)!;processes.processes.find(p=>p.id==='new')!.submission={state:'sent',source:'hand',checkedAt:new Date().toISOString()};return {at:new Date().toISOString(),currentProcessId:'new',processes,nodes:[],history:[]};},
  };
  s.client=client as never;await s.sync();
  const c=s.workspace.cases[0],old=makeRound('第一次审查意见答复');old.id='proc-old';
  old.materials=c.materials!.filter(m=>m.id==='file-old-notice');c.materials=c.materials!.filter(m=>m.id!=='file-old-notice');c.rounds.push(old);
  await s.files().ensureCase(c);await s.persist();calls.length=0;
  return {s,root,work,originals,c,client,calls,rows,official:(value:'draft'|'sent'|'received')=>{officialState=value;},extra:()=>{extra=true;},closed:(value:boolean)=>{closed=value;},changeSignals:()=>{processCount++;fileCount++;}};
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
  const {s,calls,c}=await fixture(t);
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
