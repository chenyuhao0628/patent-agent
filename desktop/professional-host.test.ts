import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProfessionalHost, parseProfessionalResult } from './professional-host.ts';
import { DesktopService } from './service.ts';
import type { AgentHost, AgentHostRun, AgentHostRunInput } from './agent-host.ts';
import type { ModelService } from './model-service.ts';
import { atomicJSON } from './files.ts';

async function fixture(t:test.TestContext,options:{delayed?:boolean;unread?:boolean}={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'professional-'));
 const service=new DesktopService(path.join(root,'data'),{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});await service.init();await fs.mkdir(path.join(root,'work'));await service.settings('local',{provider:'',baseUrl:'',model:'',workRoot:path.join(root,'work')});await service.createCase({title:'隔离夹持装置',number:'QA-1',kind:'write'});
 const inputs:AgentHostRunInput[]=[];
 const run:AgentHostRun=input=>{inputs.push(input);let stopped=false;return {abort:()=>{stopped=true;},wait:(async()=>{
  if(options.delayed)await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));
  if(stopped||input.signal.aborted)return;
  if(!options.unread){await input.onEvent({type:'tool',filename:'SKILL.md',toolKind:'read_skill',status:'ok'});for(const m of input.materials)await input.onEvent({type:'tool',filename:m.name,materialId:m.id,toolKind:'read_material',status:'ok'});if(input.draft)await input.onEvent({type:'tool',filename:'draft',toolKind:'read_draft',status:'ok'});}
  const kind=input.action==='review'?'review':'writing';const result={kind,text:kind==='review'?'P2：请核对原稿说明书支持；未检索。':'本阶段完整合成结果。',documents:{ABSTRACT:'本公开涉及夹持装置。',ABSTRACT_IMAGE:'未提供摘要附图。',CLAIMS:'1. 一种夹持装置，包括夹持件。',DESCRIPTION:'技术领域\n本公开涉及夹持装置。\n背景技术\n需要夹持。\n发明内容\n采用夹持件。\n具体实施方式\n夹持件夹持工件。',DRAWINGS:'未提供真实附图。'}};
  await fs.mkdir(input.outputDir,{recursive:true});await fs.writeFile(path.join(input.outputDir,'result.json'),JSON.stringify(result));await input.onEvent({type:'completed',outputText:JSON.stringify(result)});
 })()};};
 const agent={reviewSources:async()=>[]} as unknown as AgentHost;
 const models={resolveRuntimeConfig:async()=>({profileKey:'local',providerName:'fixture',modelId:'fixture',protocol:'responses'})} as unknown as ModelService;
 const host=new ProfessionalHost(service,agent,models,run,path.resolve('resources'));t.after(async()=>{await host.shutdown();await fs.rm(root,{recursive:true,force:true});});
 return {root,service,host,agent,inputs,id:service.workspace.cases[0].id};
}
async function settled(host:ProfessionalHost,id:string){for(let i=0;i<200;i++){const view=await host.getCase('local',id);if(!view.busy)return view;await new Promise(r=>setTimeout(r,5));}throw new Error('task did not settle');}
test('new reply reviews remain visible when the same source already has a personal review snapshot',async t=>{
 const f=await fixture(t);f.service.findCase(f.id).localDraft='合成稿件';await f.host.command('local',f.id,{type:'ready-manual'});
 const source=(await f.host.listReviews('local'))[0].source;
 const report={id:'reply-review-1',caseId:f.id,processKey:source.processKey,sourceId:source.id,kind:'review' as const,state:'completed' as const,at:'2026-09-12T00:00:00Z',text:'正式答复复核',tools:[],skillName:'答复独立复核',skillHash:''};
 f.agent.reviewSources=async()=>[{...source,reports:[report]}];assert.equal((await f.host.listReviews('local'))[0].reports?.length,1);
 await f.host.command('local',f.id,{type:'review',sourceId:source.id});await settled(f.host,f.id);
 f.agent.reviewSources=async()=>[{...source,reports:[report,{...report,id:'reply-review-2',at:'2026-09-12T01:00:00Z'}]}];
 const rows=await f.host.listReviews('local');assert.equal(rows[0].reports?.length,3);assert.equal(new Set(rows[0].reports?.map(r=>r.id)).size,3);
});
test('five writing confirmations preserve versions and create optional independent review; submitting archives without review',async t=>{
 const f=await fixture(t);
 for(let phase=0;phase<5;phase++){
  await f.host.command('local',f.id,{type:'write',message:'合成验证',materialIds:[]});const v=await settled(f.host,f.id);const job=v.record.jobs.at(-1)!;assert.equal(job.state,'completed');assert.equal(v.record.phase,phase);
  if(phase===0)await assert.rejects(f.host.command('local',f.id,{type:'confirm',jobId:job.id,decision:''}),/明确/);
  await f.host.command('local',f.id,{type:'confirm',jobId:job.id,decision:'采用该方向与保护架构'});
 }
 const ready=await f.host.getCase('local',f.id);assert.equal(ready.record.completed,true);assert.equal(ready.queue.length,1);assert.equal(ready.queue[0].archived,false);assert.equal(ready.queue[0].report,undefined);
 const source=ready.queue[0].source;assert.match(source.files[0].relativePath,/\.docx$/);assert.match(ready.record.jobs[0].artifactPath!,/\.md$/);assert.equal((await fs.readFile(await f.service.casePath(f.id,source.files[0].relativePath))).subarray(0,2).toString(),'PK');
 await f.host.command('local',f.id,{type:'review',sourceId:source.id});const reviewed=await settled(f.host,f.id);assert.equal(reviewed.queue[0].report?.state,'completed');assert.deepEqual(f.inputs.at(-1)!.messages,[]);assert.equal(f.inputs.at(-1)!.action,'review');assert.match(f.inputs.at(-1)!.prompt.combined,/审查是可选项/);
 const archive=await f.service.casePath(f.id,'04_内部说明/transfer-qa.json');await atomicJSON(archive,{schema:1,view:{profileKey:'local',caseId:f.id,processId:source.processKey,phase:'submitted'}});
 assert.equal((await f.host.listReviews('local'))[0].archived,true);assert.equal(f.service.findCase(f.id).archived,false);
 await assert.rejects(f.host.command('local',f.id,{type:'review',sourceId:source.id}),/归档/);
});
test('no read evidence cannot complete; completion contract and phase input are enforced',async t=>{
 const f=await fixture(t,{unread:true});await f.host.command('local',f.id,{type:'write',message:'test',materialIds:[]});const v=await settled(f.host,f.id);assert.equal(v.record.jobs[0].state,'failed');assert.match(v.record.jobs[0].error!,/读取记录/);
 assert.throws(()=>parseProfessionalResult('{"kind":"writing","text":"空","documents":{}}','writing',4),/缺少完整/);
 await assert.rejects(f.host.command('local',f.id,{type:'restart',phase:3}),/指定阶段/);
});
test('switching account stops professional run; no late artifact goes into the case',async t=>{
 const f=await fixture(t,{delayed:true});await f.host.command('local',f.id,{type:'write',message:'test',materialIds:[]});f.service.generation++;f.host.noteScopeChange();const v=await settled(f.host,f.id);assert.equal(v.record.jobs[0].state,'stopped');assert.equal(v.record.jobs[0].artifactPath,undefined);
});

test('identical manual drafts in different cases cannot collapse into one review item; changed source is rejected',async t=>{
 const f=await fixture(t);await f.service.createCase({title:'另一件合成装置',number:'QA-2',kind:'write'});
 for(const c of f.service.workspace.cases){c.localDraft='相同人工完成稿';await f.host.command('local',c.id,{type:'ready-manual'});}
 const list=await f.host.listReviews('local');assert.equal(list.length,2);assert.notEqual(list[0].source.id,list[1].source.id);
 const original=path.join(f.root,'稿件.txt');await fs.writeFile(original,'冻结文本');const view=await f.host.addFiles('local',f.id,[original]);const source=view.queue.find(q=>q.source.files.length)!.source;
 await fs.writeFile(await f.service.casePath(f.id,source.files[0].relativePath),'外部改稿');await assert.rejects(f.host.command('local',f.id,{type:'review',sourceId:source.id}),/外部修改/);
});

test('five-stage confirmations cannot continue after the case moves to official waiting',async t=>{
 const f=await fixture(t);await f.host.command('local',f.id,{type:'write',message:'test',materialIds:[]});const v=await settled(f.host,f.id);
 f.service.findCase(f.id).current={kind:'external',processId:'new-proc'};
 await assert.rejects(f.host.command('local',f.id,{type:'confirm',jobId:v.record.jobs[0].id,decision:'采用'}),/流程|撰写/);
});

test('global queue preserves each review attempt and archived reports after restart',async t=>{
 const f=await fixture(t);f.service.findCase(f.id).localDraft='合成待审完整稿';
 await f.host.command('local',f.id,{type:'ready-manual'});
 const source=(await f.host.listReviews('local'))[0].source;
 for(let i=0;i<2;i++){await f.host.command('local',f.id,{type:'review',sourceId:source.id});await settled(f.host,f.id);}
 let q=(await f.host.listReviews('local'))[0];assert.equal(q.reports?.length,2);assert.notEqual(q.reports![0].id,q.reports![1].id);assert.equal(q.report?.id,q.reports![1].id);
 f.service.findCase(f.id).archived=true;q=(await f.host.listReviews('local'))[0];assert.equal(q.archived,true);assert.equal(q.reports?.length,2);
 const persisted=JSON.parse(await fs.readFile(path.join(f.root,'data/profiles/local/professional-work.json'),'utf8'));assert.equal(persisted.records.flatMap((r:any)=>r.jobs).filter((j:any)=>j.kind==='review').length,2);
 const reopened=new ProfessionalHost(f.service,{reviewSources:async()=>[]} as unknown as AgentHost,{} as ModelService,()=>{throw new Error('no model needed to read history');},path.resolve('resources'));
 assert.equal((await reopened.listReviews('local'))[0].reports?.length,2);await reopened.shutdown();
});


test('writing references copy same-name originals separately, isolate cases, feed selected snapshots and retain removed files',async t=>{
 const f=await fixture(t);const a=path.join(f.root,'a'),b=path.join(f.root,'b');await fs.mkdir(a);await fs.mkdir(b);
 await fs.writeFile(path.join(a,'交底.txt'),'甲案技术');await fs.writeFile(path.join(b,'交底.txt'),'第二版本');
 let v=await f.host.addReferences('local',f.id,[path.join(a,'交底.txt'),path.join(b,'交底.txt')]);
 assert.equal(v.materials.length,2);assert.notEqual(v.materials[0].relativePath,v.materials[1].relativePath);
 assert.equal(v.record.selectedMaterialIds?.length,2);
 const saved=v.materials[0];assert.equal(await fs.readFile(path.join(a,'交底.txt'),'utf8'),'甲案技术');
 await f.service.createCase({title:'另案',number:'QA-2',kind:'write'});const other=f.service.workspace.cases.at(-1)!;
 assert.equal((await f.host.getCase('local',other.id)).materials.length,0);
 assert.equal(await f.host.fileAllowed('local',other.id,saved.relativePath!),false);
 await assert.rejects(f.host.removeReference('local',other.id,saved.id),/仅可移除/);
 await f.host.command('local',f.id,{type:'write',message:'采用交底',materialIds:[saved.id]});await settled(f.host,f.id);
 assert.equal(f.inputs.at(-1)!.materials.length,1);assert.equal(f.inputs.at(-1)!.materials[0].name,'交底.txt');
 assert.deepEqual((await f.host.getCase('local',f.id)).record.selectedMaterialIds,[saved.id]);
 v=await f.host.removeReference('local',f.id,saved.id);assert.equal(v.materials.length,1);
 assert.equal(v.record.selectedMaterialIds?.includes(saved.id),false);
 assert.equal(await fs.readFile(await f.service.casePath(f.id,saved.relativePath!),'utf8'),'甲案技术');
 assert.equal(await fs.readFile(path.join(a,'交底.txt'),'utf8'),'甲案技术');
 const disk=JSON.parse(await fs.readFile(path.join(f.root,'data/profiles/local/workspace.json'),'utf8'));assert.equal(disk.cases.find((c:any)=>c.id===f.id).materials.length,1);
 await assert.rejects(f.host.command('local',f.id,{type:'write',message:'已移除',materialIds:[saved.id]}),/尚未准备/);
});

test('writing reference import rejects invalid batches, account changes and active jobs',async t=>{
 const f=await fixture(t,{delayed:true});const good=path.join(f.root,'参考.md'),bad=path.join(f.root,'程序.exe');await fs.writeFile(good,'# 技术交底');await fs.writeFile(bad,'bad');
 await assert.rejects(f.host.addReferences('local',f.id,[good,bad]),/20MB/);assert.equal((await f.host.getCase('local',f.id)).materials.length,0);
 await assert.rejects(f.host.addReferences('other',f.id,[good]),/账号/);
 const v=await f.host.addReferences('local',f.id,[good]);await f.host.command('local',f.id,{type:'write',message:'测试',materialIds:[]});
 await assert.rejects(f.host.removeReference('local',f.id,v.materials[0].id),/停止/);await assert.rejects(f.host.addReferences('local',f.id,[good]),/停止/);
 await f.host.command('local',f.id,{type:'stop'});await settled(f.host,f.id);
 f.service.findCase(f.id).current={kind:'waiting'};await assert.rejects(f.host.addReferences('local',f.id,[good]),/撰写阶段/);
});

test('review source writes are blocked for archived, closed and official-waiting cases',async t=>{
 const f=await fixture(t);const source=path.join(f.root,'完成稿.txt');await fs.writeFile(source,'完成稿正文');
 const c=f.service.findCase(f.id);
 c.current={kind:'waiting'};
 await assert.rejects(f.host.addFiles('local',f.id,[source]),/仅可查看/);
 c.current={kind:'write'};c.archived=true;
 await assert.rejects(f.host.addFiles('local',f.id,[source]),/仅可查看/);
 c.archived=false;c.remoteClosure={finished:true,checkedAt:new Date().toISOString()};
 await assert.rejects(f.host.addFiles('local',f.id,[source]),/仅可查看/);
});
