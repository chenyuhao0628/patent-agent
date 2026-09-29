import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from './files.ts';
import { DesktopService } from './service.ts';
import { mergePersonalRows } from './baseland.ts';
import { readSharedCases } from './shared.ts';
import { internalTransferAvailable, editableCurrent } from '../src/domain/lifecycle.ts';

async function setup(t:test.TestContext){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'case-link-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const vault={available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''};
 const service=new DesktopService(path.join(root,'data'),vault);await service.init(false);
 const work=path.join(root,'work');await fs.mkdir(work);await service.settings('local',{provider:'',baseUrl:'',model:'',workRoot:work});
 await service.createCase({title:'先行撰写',number:'LOCAL-1',kind:'write'});await service.createCase({title:'已开卷案件',number:'REMOTE-1',kind:'write'});
 const [local,remote]=service.workspace.cases;local.localDraft='本地独立稿件';remote.localDraft='远端原有稿件';
 remote.source='baseland';remote.remote={caseId:'remote-1',syncedAt:'2026-09-29',processes:[{id:'proc-1',name:'提出申请',status:0,canEdit:true,node:'文件准备',undertaker:'本人',deadline:''}]};remote.current={kind:'write',processId:'proc-1',remoteStatus:0};
 remote.materials=[{id:'source',name:'source.txt',role:'技术交底',location:'合成材料',excerpt:'',ready:true,relativePath:'01_通知与材料/source.txt'}];
 await fs.writeFile(await service.casePath(remote.id,'01_通知与材料/source.txt'),'合成原始材料');
 await service.files().saveDraft(local);await service.files().saveDraft(remote);await service.persist();
 return {service,local,remote,root,work,vault};
}
test('explicit link preserves both folders and manuscripts, survives private and shared reload, and sync uses one active case',async t=>{
 const f=await setup(t),{service,local,remote}=f;const folders=[local.directory,remote.directory];
 const candidate=service.caseLinkCandidates('local',local.id)[0];
 await service.linkCase('local',local.id,remote.id,candidate.token);
 const current=service.findCase(local.id),history=service.findCase(remote.id);
 assert.equal(current.remote!.caseId,'remote-1');assert.equal(current.localDraft,'本地独立稿件');assert.ok(current.localVersions!.some(v=>v.text==='远端原有稿件'));
 assert.equal(current.directory,folders[0]);assert.equal(history.directory,folders[1]);assert.equal(history.localDraft,'远端原有稿件');
 assert.equal(history.linkedTo,local.id);assert.equal(editableCurrent(history),false);assert.equal(internalTransferAvailable(history),false);
 assert.equal(await fs.readFile(await service.casePath(local.id,current.materials![0].relativePath!),'utf8'),'合成原始材料');
 assert.equal(await fs.readFile(await service.casePath(remote.id,'01_通知与材料/source.txt'),'utf8'),'合成原始材料');
 const reopened=new DesktopService(path.join(f.root,'data'),f.vault);await reopened.init(false);assert.equal(reopened.findCase(local.id).association?.sourceCaseId,remote.id);assert.equal(reopened.findCase(remote.id).linkedTo,local.id);
 const shared=await readSharedCases(f.work,'local',[]);assert.equal(shared.cases.find(c=>c.id===remote.id)?.linkedTo,local.id);assert.equal(shared.cases.find(c=>c.id===local.id)?.localDraft,'本地独立稿件');assert.ok(shared.cases.find(c=>c.id===local.id)?.localVersions?.some(v=>v.text==='远端原有稿件'));
 const merged=mergePersonalRows([{CaseId:'remote-1',CaseProcId:'proc-1',CaseProcName:'提出申请',CaseName:'已开卷案件',CaseNo:'REMOTE-1',_status:0}],reopened.workspace.cases,'2026-09-29');
 assert.equal(merged.filter(c=>!c.linkedTo&&c.remote?.caseId==='remote-1').length,1);assert.equal(merged.find(c=>c.id===local.id)?.localDraft,'本地独立稿件');
 await assert.rejects(service.linkCase('local',local.id,remote.id,candidate.token),/变化|关联/);
});
test('link rejects stale confirmation, another profile, and in-flight writes without changing either case',async t=>{
 const {service,local,remote}=await setup(t);const candidate=service.caseLinkCandidates('local',local.id)[0];
 local.localDraft+=' changed';await assert.rejects(service.linkCase('local',local.id,remote.id,candidate.token),/变化/);
 await assert.rejects(service.linkCase('wrong',local.id,remote.id,candidate.token),/账号/);
 const next=service.caseLinkCandidates('local',local.id)[0];service.flowFileWrites=1;await assert.rejects(service.linkCase('local',local.id,remote.id,next.token),/写入/);service.flowFileWrites=0;
 assert.equal(local.source,'local');assert.equal(remote.linkedTo,undefined);
});

for(const phase of ['prepared','committed','draft','current','history'] as const)test(`link interruption at ${phase} recovers without importing partial shared identity`,async t=>{
 const f=await setup(t),{service,local,remote}=f;
 const before=await fs.readFile(await service.casePath(local.id,`02_工作稿/${digest('local').slice(0,10)}/工作稿.json`));
 service.caseLinkTestHook=step=>{if(step===phase)throw new Error('simulated interruption');};
 const candidate=service.caseLinkCandidates('local',local.id)[0];
 await assert.rejects(service.linkCase('local',local.id,remote.id,candidate.token),/simulated/);
 await assert.rejects(readSharedCases(f.work,'local',[]),/关联尚未完成/);
 assert.throws(()=>service.captureScope('local',local.id),/关联/);
 const reopened=new DesktopService(path.join(f.root,'data'),f.vault);await reopened.init(false);
 if(phase==='prepared'){
   assert.equal(reopened.findCase(local.id).source,'local');
   const retry=reopened.caseLinkCandidates('local',local.id)[0];await reopened.linkCase('local',local.id,remote.id,retry.token);
 }
 assert.equal(reopened.findCase(local.id).association?.sourceCaseId,remote.id);
 assert.equal(reopened.findCase(remote.id).linkedTo,local.id);
 const shared=await readSharedCases(f.work,'local',[]),current=shared.cases.find(c=>c.id===local.id)!;
 assert.equal(shared.warnings.length,0);assert.equal(current.localDraft,'本地独立稿件');
 assert.ok(current.localVersions?.some(v=>v.text==='远端原有稿件'));
 assert.deepEqual(await fs.readFile(await reopened.casePath(local.id,`02_工作稿/${digest('local').slice(0,10)}/工作稿.json`)),before);
 await reopened.refreshShared('local');assert.equal(reopened.findCase(local.id).source,'baseland');
});

test('link recovery preserves an externally changed destination and blocks unsafe writes',async t=>{
 const f=await setup(t),{service,local,remote}=f;
 const manifest=await service.casePath(remote.id,'案件信息.json');
 service.caseLinkTestHook=phase=>{if(phase==='committed')throw new Error('interrupted');};
 const candidate=service.caseLinkCandidates('local',local.id)[0];await assert.rejects(service.linkCase('local',local.id,remote.id,candidate.token),/interrupted/);
 const edited=JSON.parse(await fs.readFile(manifest,'utf8'));edited.userNote='外部修改保留';await fs.writeFile(manifest,JSON.stringify(edited));
 const reopened=new DesktopService(path.join(f.root,'data'),f.vault);await reopened.init(false);
 assert.match(reopened.storageState.message,/修改/);assert.equal(reopened.findCase(local.id).source,'baseland');
 assert.throws(()=>reopened.captureScope('local',local.id),/恢复/);
 assert.equal(JSON.parse(await fs.readFile(manifest,'utf8')).userNote,'外部修改保留');
 assert.equal((await fs.stat(path.join(f.root,'data/profiles/local/case-link-publication.json'))).isFile(),true);
});

test('link freezes new operations while files are being published',async t=>{
 const f=await setup(t),{service,local,remote}=f;let release!:()=>void,entered!:()=>void;
 const waiting=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
 service.caseLinkTestHook=async phase=>{if(phase==='prepared'){entered();await waiting;}};
 const candidate=service.caseLinkCandidates('local',local.id)[0],operation=service.linkCase('local',local.id,remote.id,candidate.token);
 await ready;
 try{
  assert.throws(()=>service.captureScope('local',remote.id),/关联/);
  await assert.rejects(service.createCase({title:'不可交错',number:'BUSY',kind:'write'}),/关联/);
  await assert.rejects(service.logout(),/关联/);
  await assert.rejects(service.persist(),/关联/);
 }finally{release();}
 await operation;assert.equal(service.captureScope('local',local.id).processKey,'proc-1');
});

test('link rejects foreign draft at the destination process and chained associations',async t=>{
 const f=await setup(t),{service,local,remote}=f;
 const target=await service.casePath(local.id,`02_工作稿/${digest('proc-1').slice(0,10)}/工作稿.json`);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'独立已有稿件');
 const candidate=service.caseLinkCandidates('local',local.id)[0];await assert.rejects(service.linkCase('local',local.id,remote.id,candidate.token),/目标流程已有/);
 assert.equal(await fs.readFile(target,'utf8'),'独立已有稿件');assert.equal(service.findCase(local.id).source,'local');
 remote.association={sourceCaseId:'another',remoteCaseId:'remote-1',linkedAt:new Date().toISOString(),localProcessKey:'local-write'};
 assert.equal(service.caseLinkCandidates('local',local.id).length,0);
});

for(const markerPresent of [true,false])test(`published link cleanup preserves later draft edits with marker=${markerPresent}`,async t=>{
 const f=await setup(t),{service,local,remote}=f,journal=path.join(f.root,'data/profiles/local/case-link-publication.json');let publication:any;
 service.caseLinkTestHook=async phase=>{if(phase==='history')publication=JSON.parse(await fs.readFile(journal,'utf8'));};
 const candidate=service.caseLinkCandidates('local',local.id)[0];await service.linkCase('local',local.id,remote.id,candidate.token);
 await fs.writeFile(journal,JSON.stringify({...publication,published:true}));
 if(markerPresent)await fs.writeFile(path.join(f.work,'案件/local/.case-link-pending.json'),JSON.stringify({id:publication.id,profile:'local'}));
 const draft=path.join(f.work,publication.entries[0].relative),edited=JSON.parse(await fs.readFile(draft,'utf8'));edited.text='发布完成后的人工编辑';const bytes=JSON.stringify(edited);await fs.writeFile(draft,bytes);
 const reopened=new DesktopService(path.join(f.root,'data'),f.vault);await reopened.init(false);
 assert.equal(reopened.findCase(local.id).localDraft,edited.text);assert.equal(await fs.readFile(draft,'utf8'),bytes);
 assert.equal(reopened.findCase(remote.id).linkedTo,local.id);assert.doesNotThrow(()=>reopened.captureScope('local',local.id));
 await assert.rejects(fs.stat(journal),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(f.work,'案件/local/.case-link-pending.json')),{code:'ENOENT'});
});

test('damaged pending link journal stays intact and blocks writes without touching case identities',async t=>{
 const f=await setup(t),{service,local,remote}=f,journal=path.join(f.root,'data/profiles/local/case-link-publication.json');
 await fs.writeFile(journal,'{invalid pending publication');const before=await fs.readFile(journal);
 const reopened=new DesktopService(path.join(f.root,'data'),f.vault);await reopened.init(false);
 assert.equal(reopened.findCase(local.id).source,'local');assert.equal(reopened.findCase(remote.id).linkedTo,undefined);
 assert.throws(()=>reopened.captureScope('local',local.id),/恢复/);assert.deepEqual(await fs.readFile(journal),before);
});

test('conflicting manuscript version identities are refused before publishing a link',async t=>{
 const {service,local,remote}=await setup(t),id=crypto.randomUUID();
 local.localVersions=[{id,text:'原本地版本',at:'2026-09-29'}];remote.localVersions=[{id,text:'不同远端版本',at:'2026-09-29'}];
 const candidate=service.caseLinkCandidates('local',local.id)[0];await assert.rejects(service.linkCase('local',local.id,remote.id,candidate.token),/冲突的稿件版本/);
 assert.equal(service.findCase(local.id).source,'local');assert.equal(service.findCase(remote.id).linkedTo,undefined);
});
