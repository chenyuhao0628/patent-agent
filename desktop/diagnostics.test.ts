import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiagnosticLog, safeMetadata, diagnosticError, initializeDiagnostics, stopDiagnostics, diagnosticStage, withDiagnostics } from './diagnostics.ts';

test('diagnostics persist across restart, filter ten minutes and omit payloads and credentials',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostics-'));let now=Date.now();
 try{
  const log=new DiagnosticLog(dir,1024*1024,()=>now);
  log.write('agent','old',{runId:'case-private-id',message:'SECRET',key:'sk-secret'});
  now+=601000;
  log.write('agent','recent',{runId:'case-private-id',bytes:12,payload:'patent body',code:'sk-secret'});
  const result=new DiagnosticLog(dir,1024*1024,()=>now).snapshot('0.8.0');
  assert.equal(result.records.length,1);assert.equal(result.records[0].event,'recent');
  assert.equal(String(result.records[0].runId).length,16);
  const disk=fs.readdirSync(dir).map(f=>fs.readFileSync(path.join(dir,f),'utf8')).join('');
  for(const forbidden of ['SECRET','sk-secret','patent body','case-private-id'])assert(!disk.includes(forbidden));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('diagnostics rotate within five bounded files and preserve newest record',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostics-'));
 try{const log=new DiagnosticLog(dir,512);for(let i=0;i<1000;i++)log.write('agent','heartbeat',{count:i});
 const files=fs.readdirSync(dir);assert(files.length<=5);for(const f of files)assert(fs.statSync(path.join(dir,f)).size<=512);
 assert.equal(log.snapshot('test').records.at(-1)?.count,999);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('disk failure is fail-open and reported, malformed final line does not break export',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostics-'));
 try{const log=new DiagnosticLog(path.join(dir,'block'));fs.writeFileSync(path.join(dir,'block'),'x');assert.doesNotThrow(()=>log.write('app','start'));fs.unlinkSync(path.join(dir,'block'));assert.equal(log.snapshot('test').droppedWrites,1);
 fs.mkdirSync(path.join(dir,'block'));fs.writeFileSync(path.join(dir,'block','diagnostic-0.jsonl'),'{broken');assert.equal(log.snapshot('test').records.length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('metadata and error classifications never include raw error bodies or paths',()=>{
 assert.deepEqual(safeMetadata({message:'secret',stack:'/Users/private',bytes:3,code:'Bearer secret'}),{bytes:3});
 const error=Object.assign(new Error('fetch failed PRIVATE BODY sk-secret'),{cause:{code:'ECONNRESET'}});
 assert.equal(diagnosticError(error).code,'ECONNRESET');assert(!JSON.stringify(diagnosticError(error)).includes('PRIVATE'));
});

test('rotation uses record time even when filesystem creation stays old; restart keeps the ten minute history',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostics-time-'));let now=Date.now();
 try{let log=new DiagnosticLog(dir,1024*1024,()=>now);log.write('app','start');now+=6*60*1000;
 for(let i=0;i<30;i++)log.write('agent','heartbeat',{count:i});
 assert.equal(log.snapshot('test').records.length,31);
 log=new DiagnosticLog(dir,1024*1024,()=>now);for(let i=30;i<60;i++)log.write('agent','heartbeat',{count:i});
 assert.equal(log.snapshot('test').records.length,61);assert(fs.readdirSync(dir).length<=2);
 now+=5*60*1000;log.write('app','later');assert.equal(log.snapshot('test').records.length,61);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('stage diagnostics preserve correlation across awaits and classify failures without content',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-stage-'));
 try{
  const log=initializeDiagnostics(dir);
  await withDiagnostics({syncId:'private-sync',caseId:'private-case',processId:'private-process',source:'manual'},async()=>{
   await diagnosticStage('host','materials',{runId:'private-run'},async()=>{await Promise.resolve();});
   await assert.rejects(diagnosticStage('host','permission',{runId:'private-run'},async()=>{throw Object.assign(new Error('PRIVATE BODY'),{code:'ECONNRESET'});}));
  });
  const result=log.snapshot('test').records;
  assert.equal(result.length,4);assert.equal(result[0].syncId,result[3].syncId);
  assert.equal(result[1].state,'completed');assert.equal(result[3].state,'failed');assert.equal(result[3].code,'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(result),/private-sync|private-case|private-process|private-run|PRIVATE BODY/);
 }finally{stopDiagnostics();fs.rmSync(dir,{recursive:true,force:true});}
});
