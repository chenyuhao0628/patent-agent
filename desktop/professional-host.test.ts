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

async function fixture(t:test.TestContext,options:{delayed?:boolean;unread?:boolean;hold?:Promise<void>}={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'professional-'));
 const service=new DesktopService(path.join(root,'data'),{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});await service.init();await fs.mkdir(path.join(root,'work'));await service.settings('local',{provider:'',baseUrl:'',model:'',workRoot:path.join(root,'work')});await service.createCase({title:'隔离夹持装置',number:'QA-1',kind:'write'});
 const inputs:AgentHostRunInput[]=[];
 const run:AgentHostRun=input=>{inputs.push(input);let stopped=false;return {abort:()=>{stopped=true;},wait:(async()=>{
  if(options.delayed)await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));
  if(options.hold)await Promise.race([options.hold,new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}))]);
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
test('professional history reads sources and jobs across prior process records',async t=>{
 const f=await fixture(t);
 f.service.findCase(f.id).localDraft='第一流程稿';
 await f.host.command('local',f.id,{type:'ready-manual'});
 f.service.findCase(f.id).current={kind:'write',processId:'later-process'};
 f.service.findCase(f.id).localDraft='后续流程稿';
 await f.host.command('local',f.id,{type:'ready-manual'});
 const history=await f.host.history('local',f.id);
 assert.equal(history.sources.length,2);
 assert.deepEqual(new Set(history.sources.map(source=>source.processKey)),new Set(['local-write','later-process']));
 assert.equal(history.jobs.length,0);
});
test('full sync that only updates observation metadata preserves a running writing task',async t=>{
 let release!:()=>void;
 const hold=new Promise<void>(resolve=>{release=resolve;});
 const f=await fixture(t,{hold}),s=f.service,c=s.findCase(f.id);
 c.source='baseland';c.current={kind:'write',processId:'p1',remoteStatus:0};
 c.remote={caseId:'remote',syncedAt:'old',processes:[{id:'p1',name:'提出申请',status:0,node:'',undertaker:'',deadline:''}]};
 c.remoteClosure={finished:false,checkedAt:'2026-01-01T00:00:00.000Z'};
 c.officialOutcome={state:'none',checkedAt:'2026-01-01T00:00:00.000Z'};
 await s.files().saveDraft(c);await s.persist();
 s.account={username:'a',displayName:'A',organization:'T',origin:'https://fixture.baselandtec.com',userId:'u',status:'authenticated',remembered:false};
 const stamp='2026-09-26T12:00:00.000Z';
 s.client={
  personalCasesSnapshot:async()=>({rows:[{CaseId:'remote',CaseProcId:'p1',CaseName:c.title,CaseNo:c.number,CaseProcName:'提出申请',_status:0}],stats:[]}),
  caseClosure:async()=>({finished:false,checkedAt:stamp}),
  officialOutcome:async()=>({state:'none',checkedAt:stamp}),
  files:async()=>[],
 } as never;
 s.changed=()=>f.host.noteScopeChange();
 await f.host.command('local',f.id,{type:'write',message:'Synthetic writing',materialIds:[]});
 const revision=s.caseRevisionOf(f.id);
 await s.sync({source:'manual'});
 assert.match(s.syncState.message,/已同步/);
 assert.equal(s.findCase(f.id).remoteClosure?.checkedAt,stamp);
 assert.equal(s.caseRevisionOf(f.id),revision);
 assert.equal(f.inputs[0].signal.aborted,false);
 release();
 const done=await settled(f.host,f.id);
 assert.equal(done.record.jobs[0].state,'completed');
 assert.ok(done.record.jobs[0].artifactPath);
});
test('historical attachments and reports stay permitted without reappearing in the editable current queue',async t=>{
 const f=await fixture(t),original=path.join(f.root,'historical.txt');
 await fs.writeFile(original,'historical body');
 const attached=await f.host.addFiles('local',f.id,[original]),source=attached.queue[0].source;
 await f.host.command('local',f.id,{type:'review',sourceId:source.id});
 const reviewed=await settled(f.host,f.id),report=reviewed.record.jobs[0];
 const next=structuredClone(f.service.workspace);next.cases[0].current={kind:'write',processId:'later'};
 await f.service.save('local',next,f.service.captureScope('local',f.id));
 assert.equal((await f.host.getCase('local',f.id)).queue.length,0);
 const history=await f.host.history('local',f.id);
 assert.equal(history.sources[0].files[0].relativePath,source.files[0].relativePath);
 assert.equal(history.jobs[0].artifactPath,report.artifactPath);
 for(const file of [source.files[0].relativePath,report.artifactPath!]){
  assert.equal(await f.host.fileAllowed('local',f.id,file),true);
  assert.ok((await fs.stat(await f.service.casePath(f.id,file))).isFile());
 }
 await f.service.createCase({title:'Other',number:'OTHER',kind:'review'});
 const other=f.service.workspace.cases.at(-1)!;
 assert.equal(await f.host.fileAllowed('local',other.id,source.files[0].relativePath),false);
 await assert.rejects(f.host.fileAllowed('another-profile',f.id,report.artifactPath!),/账号/);
});
test('professional history keeps source reports and jobs without a source',async t=>{
 const f=await fixture(t);
 f.service.findCase(f.id).localDraft='待审稿';
 await f.host.command('local',f.id,{type:'ready-manual'});
 const store=(f.host as any).stores.get('local');
 const record=store.records.find((item:any)=>item.caseId===f.id);
 const source=record.sources[0];
 const report={id:'report-in-source',caseId:f.id,processKey:record.processKey,kind:'review',sourceId:source.id,state:'completed',at:'2026-09-26T02:00:00.000Z',text:'来源内复核',tools:[],skillName:'review',skillHash:''};
 source.reports=[report];
 record.jobs.push({...report,id:'orphan-review',sourceId:undefined,text:'孤立复核'});
 const history=await f.host.history('local',f.id);
 assert.deepEqual(new Set(history.jobs.map(job=>job.id)),new Set(['report-in-source','orphan-review']));
 assert.equal(history.sources[0].reports?.length,1);
});
test('professional queued mutations reject account and process ABA before reading or writing sources',async t=>{
 const f=await fixture(t);
 f.service.findCase(f.id).localDraft='保留人工稿';
 for(const change of ['account','stage']){
  let release!:()=>void;
  (f.host as any).operations=new Promise<void>(resolve=>{release=resolve;});
  const pending=f.host.command('local',f.id,{type:'ready-manual'});
  const rejected=assert.rejects(pending,/作用域已变化|重新切换/);
  if(change==='account'){f.service.key='other';f.service.generation++;f.service.key='local';f.service.generation++;}
  else for(const kind of ['review','write'] as const){
   const next=structuredClone(f.service.workspace);next.cases[0].current={kind};
   await f.service.save('local',next,f.service.captureScope('local',f.id));
  }
  release();await rejected;
  await assert.rejects(fs.stat(path.join(f.service.root,'profiles/local/professional-work.json')),/ENOENT/);
 }
 assert.equal(f.inputs.length,0);
});
test('damaged professional storage reports an error and never overwrites the original',async t=>{
 const f=await fixture(t),file=path.join(f.service.root,'profiles/local/professional-work.json');
 await fs.writeFile(file,'{"schema":1,"records":');
 const original=await fs.readFile(file);
 await assert.rejects(f.host.history('local',f.id),/原文件已保留/);
 await assert.rejects(f.host.command('local',f.id,{type:'write',message:'test',materialIds:[]}),/原文件已保留/);
 assert.deepEqual(await fs.readFile(file),original);
 assert.equal(f.inputs.length,0);
});
test('professional views, queue, tasks and file permissions reject cross-case/process report identities',async t=>{
 const f=await fixture(t);f.service.findCase(f.id).localDraft='本案稿';
 await f.host.command('local',f.id,{type:'ready-manual'});
 const record=(f.host as any).stores.get('local').records[0],source=record.sources[0];
 const report={id:'own',caseId:f.id,processKey:record.processKey,sourceId:source.id,kind:'review',state:'completed',at:'2026-09-26',text:'本案报告',tools:[],skillName:'review',skillHash:''};
 source.reports=[report,{...report,id:'foreign',caseId:'another-case'},{...report,id:'wrong-process',processKey:'old'},{...report,id:'wrong-source',sourceId:'another-source'}];
 record.jobs=[report,{...report,id:'foreign-job',caseId:'another-case',artifactPath:'foreign.md'},{...report,id:'wrong-process-job',processKey:'old'}];
 record.sources.push({...source,id:'foreign-source',caseId:'another-case'});
 const view=await f.host.getCase('local',f.id);
 assert.deepEqual(view.record.jobs.map(j=>j.id),['own']);
 assert.equal(view.record.sources.length,1);
 assert.deepEqual(view.record.sources[0].reports?.map(j=>j.id),['own']);
 assert.deepEqual(view.queue[0].reports?.map(j=>j.id),['own']);
 assert.deepEqual(view.queue[0].source.reports?.map(j=>j.id),['own']);
 const history=await f.host.history('local',f.id);
 assert.deepEqual(history.jobs.map(j=>j.id),['own']);
 assert.deepEqual((await f.host.listTasks('local')).map(j=>j.runId),['own']);
 assert.equal(await f.host.fileAllowed('local',f.id,'foreign.md'),false);
});
test('five writing confirmations preserve versions and create optional independent review; submitting archives without review',async t=>{
 const f=await fixture(t);
 for(let phase=0;phase<5;phase++){
  await f.host.command('local',f.id,{type:'write',message:'合成验证',materialIds:[]});const v=await settled(f.host,f.id);const job=v.record.jobs.at(-1)!;assert.equal(job.state,'completed');assert.equal(v.record.phase,phase);
  if(phase===0)await assert.rejects(f.host.command('local',f.id,{type:'confirm',jobId:job.id,decision:''}),/明确/);
  await f.host.command('local',f.id,{type:'confirm',jobId:job.id,decision:'采用该方向与保护架构'});
 }
 const ready=await f.host.getCase('local',f.id);assert.equal(ready.record.completed,true);assert.equal(ready.queue.length,1);assert.equal(ready.queue[0].archived,false);assert.equal(ready.queue[0].report,undefined);
 const source=ready.queue[0].source;assert.match(source.files[0].relativePath,/\.docx$/);assert.match(ready.record.jobs[0].artifactPath!,/\.docx$/);assert.match(ready.record.jobs[0].rawArtifactPath!,/\.md$/);assert.equal((await fs.readFile(await f.service.casePath(f.id,source.files[0].relativePath))).subarray(0,2).toString(),'PK');
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

test('review history becomes readonly when the current business is external',async t=>{
 const f=await fixture(t);f.service.findCase(f.id).localDraft='待审稿件';
 await f.host.command('local',f.id,{type:'ready-manual'});
 const source=(await f.host.listReviews('local'))[0].source;
 f.service.findCase(f.id).current={kind:'external',processId:source.processKey};
 const view=await f.host.listReviews('local');
 assert.equal(view[0].archived,true);
 assert.match(view[0].archiveReason??'',/不可继续审查/);
 await assert.rejects(f.host.command('local',f.id,{type:'review',sourceId:source.id}),/归档|不属于/);
});

test('professional source writes reuse the main-process editable business boundary',async t=>{
 const f=await fixture(t);const reference=path.join(f.root,'参考.md');const finished=path.join(f.root,'完成稿.txt');
 await fs.writeFile(reference,'技术交底');await fs.writeFile(finished,'完成稿正文');
 const imported=await f.host.addReferences('local',f.id,[reference]);
 const c=f.service.findCase(f.id);
 c.localDraft='已有完成稿';
 await f.host.command('local',f.id,{type:'ready-manual'});
 c.source='baseland';
 c.current={kind:'reply',processId:'reply-1',remoteStatus:200};
 c.remote={caseId:'remote-1',syncedAt:'',processes:[{id:'reply-1',name:'审查意见答复',status:200,node:'审核',undertaker:'其他人',deadline:'',canEdit:false}]};
 c.localDraft='不应进入审查队列';
 await assert.rejects(f.host.command('local',f.id,{type:'ready-manual'}),/没有可列入审查/);
 await assert.rejects(f.host.addFiles('local',f.id,[finished]),/仅可查看/);
 await assert.rejects(f.host.removeReference('local',f.id,imported.materials[0].id),/可编辑的撰写阶段/);
 const source=(await f.host.listReviews('local'))[0];
 assert.equal(source.archived,true);
 await assert.rejects(f.host.command('local',f.id,{type:'review',sourceId:source.source.id}),/归档/);
});

test('stage preview reads exact DOCX and rejects tampered files or foreign version identities',async t=>{
 const f=await fixture(t);await f.host.command('local',f.id,{type:'write',message:'test',materialIds:[]});
 const view=await settled(f.host,f.id),job=view.record.jobs[0];
 const preview=await f.host.previewDocument('local',f.id,job.processKey,job.id);
 assert.equal(preview.relativePath,job.artifactPath);assert.equal(preview.hash,job.artifactHash);assert.ok(preview.blocks.length);
 await assert.rejects(f.host.previewDocument('local',f.id,'other',job.id),/不属于/);
 await fs.appendFile(await f.service.casePath(f.id,job.artifactPath!),'tampered');
 await assert.rejects(f.host.previewDocument('local',f.id,job.processKey,job.id),/修改/);
});
test('explicit link continues local writing confirmations under remote process and preserves old history',async t=>{
 const f=await fixture(t);await f.host.command('local',f.id,{type:'write',message:'test',materialIds:[]});
 const view=await settled(f.host,f.id),job=view.record.jobs[0];await f.host.command('local',f.id,{type:'confirm',jobId:job.id,decision:'采用方向'});
 await f.service.createCase({title:'远端合成案件',number:'REMOTE-LINK',kind:'write'});const remote=f.service.workspace.cases.find(c=>c.id!==f.id)!;
 remote.source='baseland';remote.current={kind:'write',processId:'remote-proc',remoteStatus:0};remote.remote={caseId:'remote-case',syncedAt:'',processes:[{id:'remote-proc',name:'提出申请',status:0,node:'文件准备',undertaker:'本人',deadline:''}]};
 const selected=f.service.caseLinkCandidates('local',f.id)[0];await f.service.linkCase('local',f.id,remote.id,selected.token);
 const linked=await f.host.getCase('local',f.id);assert.equal(linked.processKey,'remote-proc');assert.equal(linked.record.phase,1);assert.equal(linked.record.confirmations[0].decision,'采用方向');
 const preview=await f.host.previewDocument('local',f.id,'remote-proc',job.id);assert.equal(preview.relativePath,job.artifactPath);
 const old=await f.host.history('local',f.id);assert.ok(old.jobs.some(j=>j.processKey==='local-write'));assert.ok(old.jobs.some(j=>j.processKey==='remote-proc'));
  const reopenedService=new DesktopService(path.join(f.root,'data'),{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});await reopenedService.init(false);
  const reopened=new ProfessionalHost(reopenedService,f.agent,f.host.models,f.host.run,path.resolve('resources'));t.after(()=>reopened.shutdown());
  const restored=await reopened.getCase('local',f.id);assert.equal(restored.record.phase,1);assert.equal(restored.record.confirmations[0].decision,'采用方向');
  assert.equal((await reopened.previewDocument('local',f.id,'remote-proc',job.id)).hash,preview.hash);
});

test('legacy Markdown stage converts once to an exact DOCX without replacing the original',async t=>{
 const f=await fixture(t);await f.host.command('local',f.id,{type:'write',message:'test',materialIds:[]});
 const view=await settled(f.host,f.id),job=view.record.jobs[0];await f.host.shutdown();
 const file=path.join(f.root,'data/profiles/local/professional-work.json'),stored=JSON.parse(await fs.readFile(file,'utf8'));
 const saved=stored.records[0].jobs[0];saved.artifactPath=job.rawArtifactPath;delete saved.artifactHash;delete saved.rawArtifactPath;await atomicJSON(file,stored);
 const raw=await f.service.casePath(f.id,job.rawArtifactPath!),before=await fs.readFile(raw);
 const reader=new ProfessionalHost(f.service,f.agent,f.host.models,f.host.run,path.resolve('resources'));t.after(()=>reader.shutdown());
 const preview=await reader.previewDocument('local',f.id,job.processKey,job.id);assert.match(preview.relativePath,/\.docx$/);assert.ok(preview.hash);
 assert.deepEqual(await fs.readFile(raw),before);assert.equal((await reader.previewDocument('local',f.id,job.processKey,job.id)).relativePath,preview.relativePath);
});
