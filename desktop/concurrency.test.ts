import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopService } from './service.ts';
import { CaseFiles, atomicJSON, datedFolder, digest, processFolder } from './files.ts';
import { selectCurrentProcess } from './baseland.ts';
import { WAITING_OFFICIAL_LABEL } from '../src/domain/lifecycle.ts';
import type { Case, RemoteProcess, Submission } from '../src/domain/workflow.ts';

const origin='https://fixture.baselandtec.com';
function sent(at='2026-01-01T00:00:00.000Z'):Submission {return {state:'sent',source:'hand',checkedAt:at,message:'已递交，等待官方处理'};}
function proc(partial:Partial<RemoteProcess>&Pick<RemoteProcess,'id'|'name'>):RemoteProcess {
  return {status:-1,node:'',undertaker:'',deadline:'',...partial};
}
async function tempService(t:test.TestContext) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'patent-concurrency-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const work=path.join(root,'work');await fs.mkdir(work);
  const vault={available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''};
  return {root,work,vault};
}
async function emptyDir(root:string,name:string) {
  const dir=path.join(root,name);await fs.mkdir(dir);return dir;
}

test('same-account save during paused flow query keeps local edits and new official metadata',async t=>{
  const {root,work,vault}=await tempService(t);
  const s=new DesktopService(path.join(root,'data'),vault);
  s.key='synthetic-a';s.workspace.settings.workRoot=work;
  await s.createCase({title:'合成测试',number:'SYNTHETIC',kind:'write'});
  const c=s.workspace.cases[0];
  c.source='baseland';c.current={kind:'write',processId:'p1',remoteStatus:0};
  c.remote={caseId:'synthetic',syncedAt:'',processes:[proc({id:'p1',name:'提出申请',status:0,officialDeadline:'2026-01-15',officialDeadlineSource:'cpc',baselandDeadline:'2026-01-01',deadline:'2026-01-15'})]};
  await s.files().saveDraft(c);await s.persist();
  let started!:()=>void,release!:()=>void;
  const begun=new Promise<void>(r=>{started=r;});
  const held=new Promise<void>(r=>{release=r;});
  s.account={username:'a',displayName:'A',organization:'T',origin,userId:'u',status:'authenticated',remembered:false};
  s.client={flow:async()=>{
    const processes=structuredClone(c.remote);
    delete processes!.processes[0].officialDeadlineSource;
    processes!.processes[0].officialDeadline='2026-12-31';
    processes!.processes[0].baselandDeadline='2026-12-31';
    processes!.processes[0].deadline='2026-12-31';
    processes!.processes[0].submission=sent();
    started();await held;
    return {at:new Date().toISOString(),currentProcessId:'p1',processes,nodes:[],history:[]};
  }} as never;
  const pending=s.flow(c.id);
  await begun;
  const incoming=structuredClone(s.workspace);
  incoming.cases[0].tags=['编辑期间新增'];
  incoming.cases[0].localDraft='查询期间保存的新正文';
  await s.save(s.key,incoming);
  release();
  await pending;
  const state=s.workspace.cases[0];
  const disk=JSON.parse(await fs.readFile(s.profileFile(),'utf8'));
  assert.deepEqual(state.tags,['编辑期间新增']);
  assert.equal(state.localDraft,'查询期间保存的新正文');
  assert.equal(state.current?.kind,'waiting');
  assert.equal(state.current?.label,WAITING_OFFICIAL_LABEL);
  assert.equal(state.current?.processId,'p1');
  assert.equal(state.remote?.processes[0].officialDeadline,'2026-01-15');
  assert.equal(state.remote?.processes[0].officialDeadlineSource,'cpc');
  assert.equal(state.remote?.processes[0].baselandDeadline,'2026-12-31');
  assert.equal(state.remote?.processes[0].submission?.state,'sent');
  assert.deepEqual(disk.cases[0].tags,['编辑期间新增']);
  assert.equal(disk.cases[0].localDraft,'查询期间保存的新正文');
  assert.equal(disk.cases[0].current.kind,'waiting');
  assert.equal(disk.cases[0].remote.processes[0].officialDeadline,'2026-01-15');
});

test('workspace save rechecks the captured case process in the main process',async t=>{
  const {root,work,vault}=await tempService(t);
  const s=new DesktopService(path.join(root,'data'),vault);
  s.key='account-a';s.workspace.settings.workRoot=work;
  await s.createCase({title:'作用域案件',number:'SCOPE-001',kind:'write'});
  const c=s.workspace.cases[0];
  const scope={profileKey:s.key,scopeVersion:s.generation,caseId:c.id,processKey:'local-write'};
  const incoming=structuredClone(s.workspace);
  incoming.cases[0].localDraft='旧页面稿件';
  c.current={kind:'review'};
  await assert.rejects(s.save(s.key,incoming,scope),/流程已变化/);
  assert.equal(s.workspace.cases[0].localDraft,'');
});

test('account switch during flow filesystem write does not leak into the new account root',async t=>{
  const {root,work,vault}=await tempService(t);
  const workB=path.join(root,'work-b');await fs.mkdir(workB);
  const s=new DesktopService(path.join(root,'data'),vault);
  s.key='account-a';s.workspace.settings.workRoot=work;
  await s.createCase({title:'合成测试案件',number:'SYNTHETIC-A',kind:'write'});
  const c=s.workspace.cases[0];
  c.source='baseland';c.current={kind:'write',processId:'p1',remoteStatus:0};c.remote={caseId:'remote-a',syncedAt:'',processes:[proc({id:'p1',name:'提出申请',status:0})]};
  await s.files().saveDraft(c);await s.persist();
  await atomicJSON(path.join(s.root,'profiles','local','workspace.json'),{schema:1,cases:[],settings:{provider:'',baseUrl:'',model:'',workRoot:workB}});
  s.account={username:'a',displayName:'A',organization:'T',origin,userId:'u',status:'authenticated',remembered:false};
  s.client={flow:async()=>({at:new Date().toISOString(),currentProcessId:'p1',processes:structuredClone(c.remote),nodes:[],history:[]})} as never;
  const original=CaseFiles.prototype.ensureCase;
  let started!:()=>void,release!:()=>void;
  const begun=new Promise<void>(r=>{started=r;});
  const held=new Promise<void>(r=>{release=r;});
  CaseFiles.prototype.ensureCase=async function(...args:Parameters<typeof original>){started();await held;return original.apply(this,args);};
  t.after(()=>{CaseFiles.prototype.ensureCase=original;});
  const pending=s.flow(c.id).then(()=>({resolved:true as const}),e=>({resolved:false as const,message:(e as Error).message}));
  await begun;await s.logout();release();
  const result=await pending;
  let leaked=false;try{await fs.stat(path.join(workB,c.directory!,'案件信息.json'));leaked=true;}catch{/* expected missing */}
  assert.equal(leaked,false);
  assert.equal(result.resolved,false);
  assert.match(result.message??'',/账号已切换/);
});

test('admitted stage-change flow finishes drafts while migration waits; re-preview migrates complete new and old stages',async t=>{
  const {root,work,vault}=await tempService(t);
  const s=new DesktopService(path.join(root,'data'),vault);
  s.key='synthetic-a';s.workspace.settings.workRoot=work;
  await s.createCase({title:'合成测试',number:'SYNTHETIC',kind:'write'});
  const c=s.workspace.cases[0];
  c.source='baseland';c.current={kind:'write',processId:'p1',remoteStatus:0};c.localDraft='必须保留的旧阶段正文';c.sharedDraftHash=undefined;
  c.remote={caseId:'synthetic',syncedAt:'',processes:[proc({id:'p1',name:'提出申请',status:0}),proc({id:'p2',name:'第一次审查意见答复',status:0})]};
  await s.files().saveDraft(c);await s.persist();
  const dest=await emptyDir(root,'target');
  const preview=await s.previewWorkMigration(s.key,dest);
  s.account={username:'a',displayName:'A',organization:'T',origin,userId:'u',status:'authenticated',remembered:false};
  s.client={flow:async()=>({at:new Date().toISOString(),currentProcessId:'p2',processes:structuredClone(c.remote),nodes:[],history:[]})} as never;
  const original=CaseFiles.prototype.ensureCase;
  let started!:()=>void,release!:()=>void,delay=true;
  const begun=new Promise<void>(r=>{started=r;});
  const held=new Promise<void>(r=>{release=r;});
  CaseFiles.prototype.ensureCase=async function(...args:Parameters<typeof original>){if(delay){delay=false;started();await held;}return original.apply(this,args);};
  t.after(()=>{CaseFiles.prototype.ensureCase=original;});
  const pendingFlow=s.flow(c.id);
  await begun;
  const pendingMig=s.startWorkMigration(s.key,preview.id).then(()=>({ok:true as const}),e=>({ok:false as const,message:(e as Error).message}));
  await new Promise(r=>setTimeout(r,40));
  assert.equal(s.workspace.settings.workRoot,work);
  await assert.rejects(fs.stat(path.join(dest,'案件')),/ENOENT/);
  release();
  await pendingFlow;
  const mig=await pendingMig;
  assert.equal(mig.ok,false);
  assert.match(mig.message??'',/变化/);
  const live=s.workspace.cases[0];
  assert.equal(live.current?.processId,'p2');
  assert.equal(live.localDraft,'');
  assert(live.localVersions?.some(v=>v.text==='必须保留的旧阶段正文'&&v.processId==='p1'));
  const caseDir=path.join(work,c.directory!);
  const manifest=JSON.parse(await fs.readFile(path.join(caseDir,'案件信息.json'),'utf8'));
  assert.equal(manifest.current.processId,'p2');
  assert.equal(JSON.parse(await fs.readFile(path.join(caseDir,'02_工作稿',digest('p2').slice(0,10),'工作稿.json'),'utf8')).text,'');
  const oldVersion=live.localVersions!.find(v=>v.processId==='p1'&&v.text==='必须保留的旧阶段正文')!;
  assert.equal(await fs.readFile(path.join(caseDir,'02_工作稿',processFolder(live,'p1'),`${datedFolder('手工稿版本',oldVersion.id,oldVersion.at)}.txt`),'utf8'),'必须保留的旧阶段正文');
  const dest2=await emptyDir(root,'target-2');
  const preview2=await s.previewWorkMigration(s.key,dest2);
  const migrated=await s.startWorkMigration(s.key,preview2.id);
  const destCase=path.join(migrated.workspace.settings.workRoot!,c.directory!);
  assert.equal(JSON.parse(await fs.readFile(path.join(destCase,'案件信息.json'),'utf8')).current.processId,'p2');
  assert.equal(JSON.parse(await fs.readFile(path.join(destCase,'02_工作稿',digest('p2').slice(0,10),'工作稿.json'),'utf8')).text,'');
  assert.equal(await fs.readFile(path.join(destCase,'02_工作稿',processFolder(live,'p1'),`${datedFolder('手工稿版本',oldVersion.id,oldVersion.at)}.txt`),'utf8'),'必须保留的旧阶段正文');
});

test('repeated flow query keeps personal process scope and does not adopt another-person active main',async t=>{
  const {root,work,vault}=await tempService(t);
  const s=new DesktopService(path.join(root,'data'),vault);
  s.key='account-a';s.workspace.settings.workRoot=work;
  s.account={username:'a',displayName:'A',organization:'T',origin,userId:'u',status:'authenticated',remembered:false};
  await s.createCase({title:'合成范围',number:'SYN-SCOPE',kind:'write'});
  const c=s.workspace.cases[0];
  const personal=proc({id:'app',name:'提出申请',status:500,officialDeadline:'2026-10-01',deadline:'2026-10-01',submission:sent()});
  const other=proc({id:'other-reply',name:'第一次审查意见答复',status:0,officialDeadline:'2026-11-01',deadline:'2026-11-01'});
  const fee=proc({id:'fee',name:'缴申请费',status:0});
  const all=[personal,other,fee];
  const rows=[{CaseProcId:'app',CaseProcFinishDate:'2026-01-01'},{CaseProcId:'other-reply'},{CaseProcId:'fee'}];
  c.source='baseland';c.current={kind:'write',processId:'app',remoteStatus:500,label:'提出申请'};
  c.remote={caseId:'case-1',syncedAt:'',processes:[personal]};
  await s.files().saveDraft(c);await s.persist();
  s.client={flow:async(caseValue:Case)=>({
    at:'2026-09-12T00:00:00.000Z',
    currentProcessId:selectCurrentProcess(all,rows,caseValue.current?.processId,caseValue.remote!.processes.map(p=>p.id))?.id,
    processes:{caseId:'case-1',syncedAt:'2026-09-12T00:00:00.000Z',processes:all},
    nodes:[],history:[],
  })} as never;
  const first=await s.flow(c.id);
  assert.equal(first.currentProcessId,'app');
  assert.equal(first.processes?.processes.length,3);
  assert.deepEqual(s.workspace.cases[0].remote?.processes.map(p=>p.id),['app']);
  assert.equal(s.workspace.cases[0].current?.kind,'waiting');
  assert.equal(s.workspace.cases[0].current?.label,WAITING_OFFICIAL_LABEL);
  const second=await s.flow(c.id);
  assert.equal(second.currentProcessId,'app');
  assert.equal(s.workspace.cases[0].current?.processId,'app');
  assert.equal(s.workspace.cases[0].current?.kind,'waiting');
  const disk=JSON.parse(await fs.readFile(s.profileFile(),'utf8'));
  assert.deepEqual(disk.cases[0].remote.processes.map((p:{id:string})=>p.id),['app']);
  assert.equal(disk.cases[0].current.kind,'waiting');
});

test('stale flow view is rejected after current stage or personal scope changed during the query',async t=>{
  const {root,work,vault}=await tempService(t);
  const s=new DesktopService(path.join(root,'data'),vault);
  s.key='account-a';s.workspace.settings.workRoot=work;
  s.account={username:'a',displayName:'A',organization:'T',origin,userId:'u',status:'authenticated',remembered:false};
  await s.createCase({title:'合成过期查询',number:'SYN-STALE',kind:'write'});
  const c=s.workspace.cases[0];
  const p1=proc({id:'p1',name:'提出申请',status:500,deadline:'2026-06-01',officialDeadline:'2026-06-01'});
  const p2=proc({id:'p2',name:'第一次审查意见答复',status:0,deadline:'2026-10-01',officialDeadline:'2026-10-01'});
  c.source='baseland';c.current={kind:'write',processId:'p1',remoteStatus:500,label:'提出申请'};
  c.remote={caseId:'case-1',syncedAt:'2026-09-01T00:00:00.000Z',processes:[p1]};
  c.tags=['保留标签'];c.localDraft='保留的正文';
  await s.files().saveDraft(c);await s.persist();
  let started!:()=>void,release!:()=>void;
  const begun=new Promise<void>(r=>{started=r;});
  const held=new Promise<void>(r=>{release=r;});
  s.client={flow:async()=>{
    started();await held;
    return {at:'2026-09-12T00:00:00.000Z',currentProcessId:'p1',processes:{caseId:'case-1',syncedAt:'2026-09-12T00:00:00.000Z',processes:[p1,p2]},nodes:[{name:'过期节点',user:'旧办理人',running:true,finished:false,isCurrent:true,start:'',end:''}],history:[]};
  }} as never;
  const stale=s.flow(c.id);
  await begun;
  const live=s.workspace.cases[0];
  live.current={kind:'reply',processId:'p2',remoteStatus:0,label:'第一次审查意见答复'};
  live.remote={caseId:'case-1',syncedAt:'2026-09-12T01:00:00.000Z',processes:[structuredClone(p1),structuredClone(p2)]};
  live.tags=['保留标签','查询后新增'];
  await s.persist();
  release();
  await assert.rejects(stale,/请重新查询/);
  const after=s.workspace.cases[0];
  assert.equal(after.current?.processId,'p2');
  assert.deepEqual(after.remote?.processes.map(p=>p.id),['p1','p2']);
  assert.equal(after.remote?.syncedAt,'2026-09-12T01:00:00.000Z');
  assert.deepEqual(after.tags,['保留标签','查询后新增']);
  assert.equal(after.localDraft,'保留的正文');
  const disk=JSON.parse(await fs.readFile(s.profileFile(),'utf8'));
  assert.equal(disk.cases[0].current.processId,'p2');
  assert.deepEqual(disk.cases[0].remote.processes.map((p:{id:string})=>p.id),['p1','p2']);
});

test('repeated case refresh shares one in-flight request and never refreshes another case',async t=>{
 const {root,work,vault}=await tempService(t),s=new DesktopService(path.join(root,'data'),vault);s.key='synthetic';s.workspace.settings.workRoot=work;
 await s.createCase({title:'当前案件',number:'CURRENT',kind:'write'});await s.createCase({title:'其他案件',number:'OTHER',kind:'write'});
 const c=s.workspace.cases[0],other=structuredClone(s.workspace.cases[1]);c.source='baseland';c.current={kind:'write',processId:'p',remoteStatus:0};c.remote={caseId:'one',syncedAt:'',processes:[proc({id:'p',name:'提出申请',status:0})]};
 s.account={username:'a',displayName:'A',organization:'T',origin,userId:'u',status:'authenticated',remembered:false};
 let release!:()=>void;const held=new Promise<void>(r=>release=r);const queried:string[]=[];
 s.client={flow:async(item:Case)=>{queried.push(item.id);await held;return {at:new Date().toISOString(),currentProcessId:'p',processes:structuredClone(c.remote),nodes:[],history:[]};}} as never;
 const first=s.flow(c.id),second=s.flow(c.id);assert.equal(first,second);release();await Promise.all([first,second]);assert.deepEqual(queried,[c.id]);assert.deepEqual(s.workspace.cases[1],other);
});

test('human-readable work directory guide includes historical files and skips external symlinks',async t=>{
 const {root,work,vault}=await tempService(t),s=new DesktopService(path.join(root,'data'),vault);s.workspace.settings.workRoot=work;
 await s.createCase({title:'合成<案件>',number:'QA',kind:'write'});const c=s.workspace.cases[0],dir=await s.casePath(c.id);
 const historic=path.join(dir,'02_工作稿','old-uuid');await fs.mkdir(historic);await fs.writeFile(path.join(historic,'历史正文.txt'),'正文');
 const external=path.join(root,'outside');await fs.mkdir(external);await fs.writeFile(path.join(external,'不可列出.txt'),'隔离');await fs.symlink(external,path.join(dir,'02_工作稿','外部目录'));
 await s.files().writeFileGuide(c);const guide=await fs.readFile(path.join(dir,'工作文件目录.html'),'utf8');assert.match(guide,/历史正文.txt/);assert.match(guide,/合成&lt;案件&gt;/);assert.doesNotMatch(guide,/不可列出/);assert.equal(await fs.readFile(path.join(historic,'历史正文.txt'),'utf8'),'正文');
});
