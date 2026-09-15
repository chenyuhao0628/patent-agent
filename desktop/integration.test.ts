import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DesktopService } from './service.ts';
import { BaselandClient, mergePersonalRows } from './baseland.ts';
import { CaseFiles, managedPath, safeName, validateRoots } from './files.ts';
import { currentWork, editableCurrent } from '../src/domain/lifecycle.ts';
import type { Case } from '../src/domain/workflow.ts';

const origin='https://fixture.baselandtec.com';
const pdf=Buffer.from('%PDF-1.7\nFictional patent fixture\n%%EOF');
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'patent-agent-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const originals=path.join(root,'原始申请库'),work=path.join(root,'工作文件夹');await fs.mkdir(originals);await fs.mkdir(work);
  const key=randomBytes(32);
  const vault={available:()=>true,encrypt:(s:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(s),c.final(),c.getAuthTag()]);},decrypt:(b:Buffer)=>{const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString();}};
  const requests:{path:string;username?:string}[]=[];let broken=true;
  const fetcher:typeof fetch=async(input,init)=>{
    const u=new URL(String(input));requests.push({path:u.pathname});
    const body=init?.body?JSON.parse(String(init.body)):null,token=(init?.headers as Record<string,string>)?.Authorization??'',user=token.replace('secret-token-','');
    let data:unknown={};
    if(u.pathname.endsWith('/Auth/GetToken')){if(body.Password==='bad')return Response.json({IsSuccess:false,Message:'bad secret-token-DO-NOT-ECHO'});data={Token:'secret-token-'+body.UserName};}
    else if(u.pathname.endsWith('/Auth/GetLoginInfo')||u.pathname.endsWith('/TenantUser/GetCurrentUserInfo'))data={UserName:user,RealName:'测试同事 '+user,UserId:'user-'+user,TenantName:'隔离测试机构'};
    else if(u.pathname.endsWith('/GetPersonalProcStatistics'))data=[0,200,300,400,500].map(Code=>({Code,Count:Code===0?1:0}));
    else if(u.pathname.endsWith('/GetPersonalCaseCount'))data=body.ActiveName==='waitHand'?1:0;
    else if(u.pathname.endsWith('/GetPersonalCase'))data={List:body.ActiveName==='waitHand'?[{CaseId:'case-'+user,CaseProcId:'proc-'+user,CaseName:'夹持装置',CaseNo:'202612345678.9',CaseProcName:'第一次审查意见答复',CaseProcUndertakerUserName:user,CaseProcLegalDate:'2026-10-01',CaseHandId:'hand-'+user}]:[],Total:body.ActiveName==='waitHand'?1:0};
    else if(u.pathname.endsWith('/GetCaseProcFileList'))data=[{FileNo:'notice-'+user,FileName:'审查意见.pdf'},{FileNo:'retry-'+user,FileName:'对比文件.pdf'}];
    else if(u.pathname.endsWith('/GetNoticeListByCaseId')){assert.equal(typeof body.caseId,'string');assert.ok(body.PagedInfo,'the notice list endpoint rejects an empty body');data=[{NoticeName:'办理登记手续通知书',NoticeTypeCode:'200602',PostDate:'2026-09-14T00:00:00',NoticeStatusName:'待导入'},{NoticeName:'第一次审查意见通知书',NoticeTypeCode:'210401',PostDate:'2026-08-26T00:00:00'}];}
    else if(u.pathname.endsWith('/FileStorageGetFile'))return new Response(u.searchParams.get('fileNo')?.startsWith('retry')&&broken?Buffer.from('<html>failed</html>'):pdf);
    else if(u.pathname.endsWith('/GetCaseDetailProcList')){assert.equal(body.TableType,80001);assert(Array.isArray(body.UserTableTitleColumnList));data=[{CaseProcId:'proc-'+user,CaseProcName:'第一次审查意见答复',ProcStatusCode:200,StatusCode:200,CaseProcCurrentFlowName:'最新核稿节点',CaseProcUndertakerUserName:'主管',CaseProcLegalDate:'2026-10-01',CaseProcCustomDate:'2026-09-28',CaseProcNameInfo:{CaseProcName:'第一次审查意见答复'}}];}
    else if(u.pathname.endsWith('/GetCaseAllFlowHistoryInfo'))data={List:[{CaseProcName:'提出申请',ProcCreateDate:'2026-01-01',FinishDate:'2026-02-01'}]};
    else if(u.pathname.endsWith('/GetProcFlowRecord'))data=[{FlowStepName:'开始',FlowUserName:user,IsRunning:true,IsFinish:false,IsCurrentFlowNode:true,Sort:1,StayHours:2,StartDate:'2026-09-01T00:00:00',EndTDate:null},{FlowStepName:'递交官方',FlowUserName:'PersonB',IsRunning:false,IsFinish:false,IsCurrentFlowNode:false,Sort:2},{FlowStepName:'结束',FlowUserName:'',IsRunning:false,IsFinish:false,IsCurrentFlowNode:false,Sort:3}];
    else if(u.pathname.endsWith('/GetHandInfo'))data={IsPackageSendSuccess:false,IsNeedSendToOfficail:true,HandInfo:{CaseHandId:'hand-'+user,IsPackage:false,SendDate:null},CurrentFlowInfo:{FlowNodeName:'开始',FlowUserName:user,SerialNumber:1,TotalStepNumber:3}};
    else if(u.pathname.endsWith('/GetCaseHandSendInfo'))return Response.json({IsSuccess:true,Data:null});
    else if(u.pathname.endsWith('/GetCaseHandSendStatusViewTypeList'))data=[{label:'待递交',value:0},{label:'准备递交中',value:1},{label:'递交成功',value:2},{label:'递交失败',value:3},{label:'已收到回执',value:6},{label:'递交中',value:100}];
    else throw new Error('Unexpected endpoint: '+u.pathname);
    return Response.json({IsSuccess:true,Data:data});
  };
  const make=(device='本机记录')=>new DesktopService(path.join(root,device),vault,(o,token)=>new BaselandClient(o,token,fetcher));
  return {root,originals,work,make,requests,repair:()=>{broken=false;}};
}
test('native files use stable case folders, preserve originals, reject symlink escapes and unsafe names',async t=>{
  const f=await fixture(t),files=new CaseFiles({provider:'',baseUrl:'',model:'',originalLibrary:f.originals,workRoot:f.work},'alice');
  const c:Case={id:'one',number:'202612345678.9',title:'CON:夹持/装置',type:'发明',deadline:'',archived:false,tags:[],rounds:[],current:{kind:'write'}};
  const source=path.join(f.originals,'202612345678.9_原始申请.pdf');await fs.writeFile(source,pdf);
  const found=await files.findOriginals(c);assert.equal(found.length,1);
  const saved=await files.copyOriginal(c,found[0].id);c.directory=saved.directory;
  assert.deepEqual(await fs.readFile(source),pdf);
  assert.equal((await files.copyOriginal(c,found[0].id)).relativePath,saved.relativePath);
  const changed=await files.writeMaterial(c,'01_通知与材料','notice','CON.pdf',Buffer.from('%PDF-1.7 changed'));
  assert.notEqual(changed.relativePath,saved.relativePath);assert.equal(await files.ensureCase({...c,title:'已更名'}),saved.directory);
  await assert.rejects(validateRoots({...files.settings,workRoot:f.originals}),/不能/);
  const nestedWork=path.join(f.originals,'嵌套工作总目录');await fs.mkdir(nestedWork);
  const validatedNested=await validateRoots({...files.settings,originalLibrary:f.originals,workRoot:nestedWork});
  assert.equal(validatedNested.workRoot,await fs.realpath(nestedWork));
  const invertedLib=path.join(f.work,'库在工作目录内');await fs.mkdir(invertedLib);
  await assert.rejects(validateRoots({...files.settings,originalLibrary:invertedLib,workRoot:f.work}),/不能/);
  await assert.rejects(validateRoots({...files.settings,workRoot:path.join(f.root,'不存在的目录')}));
  await fs.symlink(f.originals,path.join(f.work,'escape'));
  await assert.rejects(managedPath(f.work,'escape/should-not-write.pdf',true),/符号链接/);
  await assert.rejects(managedPath(f.work,'../outside'),/不属于/);
  assert.equal(safeName('CON'),'_CON');assert(!/[<>:"/\\|?*]/.test(safeName('a:b/c?')));
  await fs.writeFile(path.join(f.originals,'测试客户+一种精密夹持装置+【发明】+测试同事.docx'),Buffer.from('PK fixture'));
  const byTitle=await files.findOriginals({...c,number:'LOCAL-002',title:'一种精密夹持装置'});assert.equal(byTitle.length,1);assert.match(byTitle[0].name,/测试客户/);
  await fs.writeFile(path.join(f.originals,'1234567_其他案件.pdf'),pdf);
  assert.equal((await files.findOriginals({...c,number:'123456',title:'不应匹配相邻案号'})).length,0);
  await fs.writeFile(path.join(f.originals,'NOTICE-001_第一次审查意见通知书.pdf'),pdf);assert.equal((await files.findOriginals({...c,number:'NOTICE-001',title:'不把通知书当原件'})).length,0);
  const nestedCopyDir=path.join(nestedWork,'案件/alice/00_原始申请');await fs.mkdir(nestedCopyDir,{recursive:true});
  await fs.writeFile(path.join(nestedCopyDir,'202612345678.9_原始申请.pdf'),pdf);
  await fs.writeFile(path.join(nestedWork,'202612345678.9_原始申请_副本.pdf'),pdf);
  const nestedFiles=new CaseFiles({...files.settings,originalLibrary:f.originals,workRoot:nestedWork},'alice');
  const foundUnderNested=await nestedFiles.findOriginals(c);
  assert.equal(foundUnderNested.length,1);assert.equal(foundUnderNested[0].id,'202612345678.9_原始申请.pdf');
});
test('remote process rows merge to one case and only one current business, keeping historical drafts',()=>{
  const rows=[{CaseId:'c1',CaseProcId:'old',CaseName:'装置',CaseNo:'1',CaseProcName:'提出申请',_status:500},{CaseId:'c1',CaseProcId:'now',CaseName:'装置',CaseNo:'1',CaseProcName:'补正',_status:0}];
  const c=mergePersonalRows(rows,[],'2026-09-12')[0];assert.equal(currentWork(c).kind,'correction');assert.equal(c.remote?.processes.length,2);assert.equal(c.rounds.length,1);
  c.localDraft='保留用户草稿';c.current={kind:'write',processId:'old'};
  const moved=mergePersonalRows(rows,[c],'2026-09-12')[0];assert.equal(moved.localDraft,'');assert.equal(moved.localVersions?.[0].text,'保留用户草稿');
  const invalid=mergePersonalRows([...rows,{...rows[1],CaseProcId:'second'}],[],'2026-09-12')[0];assert.equal(invalid.current?.kind,'needs-confirmation');assert.equal(editableCurrent(invalid),false);
});
test('login, personal sync, retry, native draft persistence and account switching remain isolated',async t=>{
  const f=await fixture(t),service=f.make();await service.init();
  await service.login({origin,username:'alice',password:'fixture-password',remember:true});const aliceKey=service.key;
  await service.settings(aliceKey,{...service.workspace.settings,originalLibrary:f.originals,workRoot:f.work});
  await service.sync();assert.equal(service.workspace.cases.length,1);const c=service.workspace.cases[0];
  assert.equal(c.officialOutcome?.state,'granted','官方结论与案件数据在同一轮同步里判读并落库');
  assert.equal(c.officialOutcome?.noticeTypeCode,'200602');
  await service.refreshCaseOutcomes(aliceKey);
  assert.equal(service.workspace.cases[0].officialOutcome?.state,'granted','手动重新判读同样只读官文清单');
  assert.equal(c.rounds[0].materials.filter(m=>m.ready).length,1);assert.match(service.syncState.message,/需重试/);
  f.repair();await service.sync();assert.equal(service.workspace.cases[0].rounds[0].materials.filter(m=>m.ready).length,2);
  const edit=structuredClone(service.workspace);edit.cases[0].localDraft='用户亲自撰写的工作稿';edit.cases[0].localVersions=[{id:randomUUID(),text:edit.cases[0].localDraft,at:new Date().toISOString(),processId:c.current?.processId}];
  await service.save(aliceKey,edit);await service.save(aliceKey,edit);assert.equal(service.workspace.cases[0].localVersions?.length,1);
  const flow=await service.flow(c.id);assert.equal(flow.nodes[0].user,'alice');assert.equal(flow.processes?.processes[0].node,'最新核稿节点');assert.equal(flow.processes?.processes[0].undertaker,'主管');assert.equal(flow.processes?.processes[0].deadline,'2026-10-01');assert.equal(flow.processes?.processes[0].baselandDeadline,'2026-10-01');assert.equal(flow.processes?.processes[0].officialDeadline,undefined);assert.equal(flow.processes?.processes[0].internalDeadline,'2026-09-28');assert.equal(flow.nodes[0].finished,false);assert.equal(flow.history[0].name,'提出申请');
  await assert.rejects(service.login({origin,username:'bob',password:'bad',remember:true}),error=>!String(error).includes('DO-NOT-ECHO'));
  assert.equal(service.account?.username,'alice');
  await service.shutdown();const reopened=f.make();await reopened.init();assert.equal(reopened.account?.username,'alice');assert.equal(reopened.workspace.cases[0].localDraft,'用户亲自撰写的工作稿');
  const sessionText=await fs.readFile(path.join(f.root,'本机记录/session.json'),'utf8');assert(!sessionText.includes('secret-token-'));assert(!JSON.stringify(reopened.state()).includes('secret-token-'));assert(!sessionText.includes('fixture-password'));
  await reopened.login({origin,username:'bob',password:'fixture-password',remember:false});assert.equal(reopened.workspace.cases.length,0);assert.equal(reopened.workspace.settings.workRoot,undefined);
  await assert.rejects(reopened.save(aliceKey,edit),/账号已切换/);
  await reopened.settings(reopened.key,{...reopened.workspace.settings,workRoot:f.work});await reopened.sync();assert.equal(reopened.workspace.cases[0].remote?.caseId,'case-bob');assert.notEqual(reopened.workspace.cases[0].directory,c.directory);
  await reopened.logout();assert.equal(reopened.account,null);assert.equal(reopened.workspace.cases.length,0);
  assert(!f.requests.some(r=>/StartHand|StartPack|Submit|Cancel|Upload|SaveForm|FiveFormsGetPack|send-start/.test(r.path)));
  assert(f.requests.some(r=>r.path.endsWith('/GetHandInfo')));
  assert(f.requests.some(r=>r.path.endsWith('/GetCaseHandSendInfo')));
});
test('a pending sync cannot import the previous account into a newly logged in workspace',async t=>{
  const f=await fixture(t),s=f.make();await s.init();await s.login({origin,username:'alice',password:'fixture',remember:false});await s.settings(s.key,{...s.workspace.settings,workRoot:f.work});
  const client=s.client!,original=client.personalCasesSnapshot.bind(client);let release!:()=>void;let started!:()=>void;const begun=new Promise<void>(resolve=>{started=resolve;});
  client.personalCasesSnapshot=async(signal,initial)=>{const rows=await original(signal,initial);started();await new Promise<void>(resolve=>{release=resolve;});return rows;};
  const syncing=s.sync();await begun;await s.login({origin,username:'bob',password:'fixture',remember:false});release();await syncing;
  assert.equal(s.account?.username,'bob');assert.equal(s.workspace.cases.length,0);
});

test('personal-case pagination accepts top-level DataList without losing the next page',async()=>{
  const pages:number[]=[];
  const client=new BaselandClient(origin,'fixture',async(_input,init)=>{
    if(String(_input).includes('/GetPersonalProcStatistics'))return Response.json({IsSuccess:true,Data:[0,200,300,400,500].map(Code=>({Code,Count:Code===0?101:0}))});
    const b=JSON.parse(String(init?.body)),page=b.PagedInfo.pageIndex;
    if(String(_input).includes('/GetPersonalCaseCount'))return Response.json({IsSuccess:true,Data:b.ActiveName==='waitHand'?101:0});
    if(b.ActiveName==='waitHand')pages.push(page);
    return Response.json({IsSuccess:true,Data:null,DataList:b.ActiveName==='waitHand'?Array.from({length:page===1?100:1},(_,i)=>({CaseId:`case-${page}-${i}`,CaseProcId:`proc-${page}-${i}`})):[]});
  });
  const rows=await client.personalCases(new AbortController().signal);
  assert.equal(rows.length,101);assert.deepEqual(pages,[1,2]);
});
test('credential encryption failure preserves the current account and local case renaming preserves its directory',async t=>{
  const f=await fixture(t),s=f.make();await s.init();await s.settings('local',{...s.workspace.settings,workRoot:f.work});
  await s.createCase({title:'原名称',number:'LOCAL-001',kind:'write'});const directory=s.workspace.cases[0].directory;
  const edit=structuredClone(s.workspace);edit.cases[0].title='更新名称';edit.cases[0].deadline='2026-10-01';await s.save('local',edit);
  assert.equal(s.workspace.cases[0].title,'更新名称');assert.equal(s.workspace.cases[0].directory,directory);
  await s.login({origin,username:'alice',password:'fixture',remember:false});s.vault.encrypt=()=>{throw new Error('vault unavailable');};
  await assert.rejects(s.login({origin,username:'bob',password:'fixture',remember:true}));assert.equal(s.account?.username,'alice');
});

test('login checks nested business result and does not replace Data.Token with an empty list',async()=>{
  let result:unknown={IsSuccess:true,Token:'fixture-token'};
  let identityCalls=0;
  const client=new BaselandClient(origin,'',async input=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/Auth/GetToken'))return Response.json({IsSuccess:true,Data:result,DataList:[]});
    identityCalls++;return Response.json({IsSuccess:true,Data:{UserName:'alice',RealName:'测试同事'},DataList:[]});
  });
  const account=await client.login('alice','fixture');assert.equal(account.displayName,'测试同事');assert.equal(client.token,'fixture-token');
  const calls=identityCalls;
  for(const [reason,expected] of [['LicenseExpired',/授权已过期/],['InvalidUserNameOrPassword',/核对系统地址/],['AccountLocked',/锁定/],['unknown-secret-token',/未通过登录验证/]] as const){
    result={IsSuccess:false,ResultString:reason,Token:'must-not-use'};
    await assert.rejects(client.login('alice','fixture'),expected);
    assert.equal(identityCalls,calls);assert.equal(client.token,'fixture-token');
  }
});

test('a second device reads a shared work folder and preserves private conversations and changed drafts',async t=>{
  const f=await fixture(t);f.repair();const a=f.make('电脑A'),b=f.make('电脑B');
  await a.init();await a.login({origin,username:'alice',password:'fixture',remember:false});
  await a.settings(a.key,{...a.workspace.settings,workRoot:f.work});await a.sync();
  a.workspace.cases[0].rounds[0].discussions[0].messages.push({id:'local-chat',role:'user',text:'PRIVATE_CONVERSATION_SENTINEL'});
  const first=structuredClone(a.workspace);first.cases[0].localDraft='电脑A工作稿';first.cases[0].localVersions=[{id:randomUUID(),text:'电脑A工作稿',at:new Date().toISOString(),processId:first.cases[0].current?.processId}];await a.save(a.key,first);
  const sharedB=path.join(f.root,'另一电脑云盘路径');await fs.cp(f.work,sharedB,{recursive:true});
  await b.init();await b.login({origin,username:'alice',password:'fixture',remember:false});await b.settings(b.key,{...b.workspace.settings,workRoot:sharedB});await b.refreshShared(b.key);
  assert.equal(b.workspace.cases.length,1);assert.equal(b.workspace.cases[0].localDraft,'电脑A工作稿');assert.equal(b.workspace.cases[0].localVersions?.length,1);
  assert.equal(b.workspace.cases[0].current?.processId,a.workspace.cases[0].current?.processId);assert(b.workspace.cases[0].rounds[0].materials.every(m=>m.ready));
  assert(!JSON.stringify(b.workspace).includes('PRIVATE_CONVERSATION_SENTINEL'));
  const sharedManifest=await fs.readFile(path.join(sharedB,b.workspace.cases[0].directory!,'案件信息.json'),'utf8');assert(!/PRIVATE_CONVERSATION|discussions|password|token|jobs/.test(sharedManifest));
  const next=structuredClone(b.workspace);next.cases[0].localDraft='电脑B更新稿';await b.save(b.key,next);
  await fs.cp(sharedB,f.work,{recursive:true,force:true});
  const stale=structuredClone(a.workspace);stale.cases[0].localDraft='旧电脑不能覆盖新稿';await assert.rejects(a.save(a.key,stale),/其他位置更新/);
  await a.refreshShared(a.key);assert.equal(a.workspace.cases[0].localDraft,'电脑B更新稿');assert(JSON.stringify(a.workspace).includes('PRIVATE_CONVERSATION_SENTINEL'));
  await b.login({origin,username:'bob',password:'fixture',remember:false});await b.settings(b.key,{...b.workspace.settings,workRoot:sharedB});assert.equal(b.workspace.cases.length,0);
});
test('shared directory reading handles portable paths and incomplete cloud files without discarding local records',async t=>{
  const f=await fixture(t),s=f.make();await s.init();await s.settings('local',{...s.workspace.settings,workRoot:f.work});await s.createCase({title:'共享目录测试装置',number:'SHARED-001',kind:'write'});
  const edit=structuredClone(s.workspace);edit.cases[0].localDraft='保留本机稿件';await s.save('local',edit);
  const c=s.workspace.cases[0],manifest=path.join(f.work,c.directory!,'案件信息.json');let raw=JSON.parse(await fs.readFile(manifest,'utf8'));
  raw.materials=[{id:'cloud-file',name:'云盘尚未下载.pdf',role:'材料',relativePath:'01_通知与材料\\尚未下载.pdf'}];await fs.writeFile(manifest,JSON.stringify(raw));
  await s.refreshShared('local');assert.equal(s.workspace.cases[0].materials?.[0].ready,false);assert.equal(s.workspace.cases[0].materials?.[0].relativePath,'01_通知与材料/尚未下载.pdf');
  await fs.writeFile(manifest,'{unfinished cloud sync');await s.refreshShared('local');assert.match(s.storageState.message,/需核对/);assert.equal(s.workspace.cases[0].localDraft,'保留本机稿件');assert.equal(await fs.readFile(manifest,'utf8'),'{unfinished cloud sync');
});

test('shared stage changes preserve the old draft as history instead of carrying it into the next stage',async t=>{
  const f=await fixture(t),s=f.make();await s.init();await s.settings('local',{...s.workspace.settings,workRoot:f.work});await s.createCase({title:'阶段同步测试装置',number:'SHARED-002',kind:'write'});
  const edit=structuredClone(s.workspace);edit.cases[0].localDraft='上一阶段的工作稿';await s.save('local',edit);
  const c=s.workspace.cases[0],manifest=path.join(f.work,c.directory!,'案件信息.json'),raw=JSON.parse(await fs.readFile(manifest,'utf8'));
  raw.current={kind:'reply',processId:'next-process'};await fs.writeFile(manifest,JSON.stringify(raw));
  await s.refreshShared('local');const restored=s.workspace.cases[0];
  assert.equal(restored.current?.processId,'next-process');assert.equal(restored.localDraft,'');assert.equal(restored.sharedDraftHash,undefined);assert(restored.localVersions?.some(v=>v.text==='上一阶段的工作稿'));
  const next=structuredClone(s.workspace);next.cases[0].localDraft='新阶段稿件';await s.save('local',next);
  const reopened=f.make();await reopened.init();assert.equal(reopened.workspace.cases[0].localDraft,'新阶段稿件');assert(reopened.workspace.cases[0].localVersions?.some(v=>v.text==='上一阶段的工作稿'));
});

test('original-only directory settings persist across restart without requiring workRoot or sync, and invalid save preserves prior roots',async t=>{
  const f=await fixture(t),service=f.make();await service.init();
  const saved=await service.settings('local',{...service.workspace.settings,originalLibrary:f.originals,workRoot:''});
  assert.equal(saved.workspace.settings.originalLibrary,await fs.realpath(f.originals));
  assert.equal(saved.workspace.settings.workRoot,'');
  assert.equal(service.storageState.running,false);
  assert(!service.storageState.message.includes('工作目录未读取完成'));
  const reopened=f.make();await reopened.init();
  assert.equal(reopened.workspace.settings.originalLibrary,await fs.realpath(f.originals));
  assert.equal(reopened.workspace.settings.workRoot,'');
  assert(!reopened.storageState.message.includes('工作目录未读取完成'));

  await reopened.settings('local',{...reopened.workspace.settings,workRoot:f.work});
  assert.equal(reopened.workspace.settings.workRoot,await fs.realpath(f.work));

  await assert.rejects(reopened.settings('local',{...reopened.workspace.settings,workRoot:path.join(f.root,'不存在的目录')}));
  assert.equal(reopened.workspace.settings.workRoot,await fs.realpath(f.work));
  assert.equal(reopened.workspace.settings.originalLibrary,await fs.realpath(f.originals));

  await assert.rejects(reopened.settings('local',{...reopened.workspace.settings,workRoot:reopened.workspace.settings.originalLibrary}),/不能/);
  assert.equal(reopened.workspace.settings.workRoot,await fs.realpath(f.work));

  await reopened.createCase({title:'搬迁守卫测试',number:'RELOC-001',kind:'write'});
  const otherWork=path.join(f.root,'另一个工作文件夹');await fs.mkdir(otherWork);
  await assert.rejects(reopened.settings('local',{...reopened.workspace.settings,workRoot:otherWork}),/已有案件/);
  assert.equal(reopened.workspace.settings.workRoot,await fs.realpath(f.work));
});

test('settings disk write failure after path validation preserves old settings in memory, on disk, and after reopen',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
  const f=await fixture(t),service=f.make('chmod-profile');await service.init();
  await service.settings('local',{...service.workspace.settings,originalLibrary:f.originals,workRoot:f.work});
  const previous=structuredClone(service.workspace.settings);
  const profile=service.profileFile(),before=await fs.readFile(profile),profileDir=path.dirname(profile);
  const otherLib=path.join(f.root,'另一原始申请库');await fs.mkdir(otherLib);
  const attempted={...service.workspace.settings,originalLibrary:otherLib,workRoot:f.work,model:'must-not-persist'};
  assert.equal((await validateRoots(attempted)).originalLibrary,await fs.realpath(otherLib));
  try{
    await fs.chmod(profileDir,0o500);
    await assert.rejects(service.settings('local',attempted),error=>['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''));
    assert.deepEqual(service.workspace.settings,previous);
    assert.deepEqual(await fs.readFile(profile),before);
  }finally{await fs.chmod(profileDir,0o700);}
  const reopened=f.make('chmod-profile');await reopened.init();
  assert.deepEqual(reopened.workspace.settings,JSON.parse(JSON.stringify(previous)));
  assert.equal(reopened.workspace.settings.originalLibrary,await fs.realpath(f.originals));
  assert.equal(reopened.workspace.settings.workRoot,await fs.realpath(f.work));
});

test('saving settings during an active sync keeps unchanged roots, persists a model change, and does not drop the imported case',async t=>{
  const f=await fixture(t),s=f.make();await s.init();
  await s.login({origin,username:'alice',password:'fixture',remember:true});
  await s.settings(s.key,{...s.workspace.settings,originalLibrary:f.originals,workRoot:f.work});
  const client=s.client!,original=client.personalCasesSnapshot.bind(client);let release!:()=>void;let started!:()=>void;const begun=new Promise<void>(resolve=>{started=resolve;});
  client.personalCasesSnapshot=async(signal,initial)=>{const rows=await original(signal,initial);started();await new Promise<void>(resolve=>{release=resolve;});return rows;};
  const syncing=s.sync();await begun;assert.equal(s.syncState.running,true);
  const saved=await s.settings(s.key,{...s.workspace.settings,model:'saved-during-sync'});
  assert.equal(saved.workspace.settings.model,'saved-during-sync');
  assert.equal(saved.workspace.settings.originalLibrary,await fs.realpath(f.originals));
  assert.equal(saved.workspace.settings.workRoot,await fs.realpath(f.work));
  assert.equal(s.syncState.running,true);
  release();await syncing;
  assert.equal(s.workspace.cases.length,1);assert.equal(s.workspace.cases[0].remote?.caseId,'case-alice');
  assert.equal(s.workspace.settings.model,'saved-during-sync');
  assert.equal(s.workspace.settings.originalLibrary,await fs.realpath(f.originals));
  assert.equal(s.workspace.settings.workRoot,await fs.realpath(f.work));
  await s.shutdown();const reopened=f.make();await reopened.init();
  assert.equal(reopened.account?.username,'alice');
  assert.equal(reopened.workspace.settings.model,'saved-during-sync');
  assert.equal(reopened.workspace.settings.originalLibrary,await fs.realpath(f.originals));
  assert.equal(reopened.workspace.settings.workRoot,await fs.realpath(f.work));
  assert.equal(reopened.workspace.cases.length,1);assert.equal(reopened.workspace.cases[0].remote?.caseId,'case-alice');
});

test('original-only then nested workRoot settings reopen and findOriginals excludes matching files under the work root',async t=>{
  const f=await fixture(t),service=f.make();await service.init();
  await service.settings('local',{...service.workspace.settings,originalLibrary:f.originals,workRoot:''});
  const nestedWork=path.join(f.originals,'嵌套工作总目录');await fs.mkdir(nestedWork);
  const nestedSaved=await service.settings('local',{...service.workspace.settings,workRoot:nestedWork});
  assert.equal(nestedSaved.workspace.settings.originalLibrary,await fs.realpath(f.originals));
  assert.equal(nestedSaved.workspace.settings.workRoot,await fs.realpath(nestedWork));
  await fs.writeFile(path.join(f.originals,'202612345678.9_原始申请.pdf'),pdf);
  await service.createCase({title:'夹持装置',number:'202612345678.9',kind:'write'});
  const found=await service.findOriginals(service.workspace.cases[0].id);
  assert.equal(found.length,1);assert.equal(found[0].id,'202612345678.9_原始申请.pdf');
  await service.copyOriginal(service.workspace.cases[0].id,found[0].id);
  await fs.writeFile(path.join(nestedWork,'202612345678.9_原始申请_副本.pdf'),pdf);
  const nestedCopyDir=path.join(nestedWork,service.workspace.cases[0].directory!,'00_原始申请');
  await fs.writeFile(path.join(nestedCopyDir,'202612345678.9_原始申请.pdf'),pdf);
  assert.equal((await service.findOriginals(service.workspace.cases[0].id)).length,1);
  const reopened=f.make();await reopened.init();
  assert.equal(reopened.workspace.settings.originalLibrary,await fs.realpath(f.originals));
  assert.equal(reopened.workspace.settings.workRoot,await fs.realpath(nestedWork));
  const foundAgain=await reopened.findOriginals(reopened.workspace.cases[0].id);
  assert.equal(foundAgain.length,1);assert.equal(foundAgain[0].id,'202612345678.9_原始申请.pdf');
  const files=new CaseFiles(reopened.workspace.settings,reopened.key);
  const fromFiles=await files.findOriginals(reopened.workspace.cases[0]);
  assert.equal(fromFiles.length,1);assert.equal(fromFiles[0].id,'202612345678.9_原始申请.pdf');
});

test('ClientName and process remarks persist, preserve omitted values and accept explicit clears',async t=>{
 const row={CaseId:'meta-case',CaseProcId:'meta-proc',CaseName:'合成装置',CaseNo:'QA-META',CaseProcName:'提出申请',CaseProcNameInfo:{ProcCode:105},ClientName:'合成客户有限公司',CaseRemark:'案件备注',FlowRemark:'流程备注',CaseProcOfficeNote:'内勤备注',CaseProcProcNote:'办理备注',CaseProcCustomDate:'2026-09-20',CaseProcLegalDate:'2026-11-01',_status:0};
 const first=mergePersonalRows([row], [],new Date().toISOString());const c=first[0];assert.equal(c.companyName,row.ClientName);assert.equal(c.deadline,'2026-09-20');assert.equal(c.remote?.processes[0].flowRemark,'流程备注');
 const {ClientName,CaseRemark,FlowRemark,...omitted}=row;
 const preserved=mergePersonalRows([omitted],first,new Date().toISOString());assert.equal(preserved[0].companyName,ClientName);assert.equal(preserved[0].caseRemark,CaseRemark);assert.equal(preserved[0].remote?.processes[0].flowRemark,FlowRemark);
 const cleared=mergePersonalRows([{...omitted,ClientName:'',CaseRemark:'',FlowRemark:''}],preserved,new Date().toISOString());assert.equal(cleared[0].companyName,'');assert.equal(cleared[0].remote?.processes[0].flowRemark,'');
 const calls:string[]=[];const client=new BaselandClient(origin,'test',async(input,init)=>{assert.equal(init?.method,'GET');const u=new URL(String(input));calls.push(u.pathname);return Response.json({IsSuccess:true,Data:u.pathname.endsWith('GetUpdateCaseInfo')?{CaseInfo:{CaseId:'meta-case',Remark:'最新案件备注'}}:{CaseProc:{CaseProcId:'meta-proc',OfficeNote:'最新内勤备注',ProcNote:''}}});});
 const info=await client.caseInfo(c);assert.equal(info.caseRemark,'最新案件备注');assert.equal(info.process?.officeNote,'最新内勤备注');assert.equal(info.process?.procNote,'');assert.equal(calls.length,2);
 const wrong=new BaselandClient(origin,'test',async()=>Response.json({IsSuccess:true,Data:{CaseInfo:{CaseId:'other'},CaseProc:{CaseProcId:'other'}}}));await assert.rejects(wrong.caseInfo(c),/不一致/);
});


test('0.5 login: startup is nonblocking, transient failures recover, expiration stops retries, credentials survive',async t=>{
  const f=await fixture(t),service=f.make();await service.init();
  await service.login({origin,username:'alice',password:'fixture-password',remember:true});
  const sessionFile=path.join(service.root,'session.json'),before=await fs.readFile(sessionFile);
  const reopened=f.make();await reopened.init(false);
  assert.equal(reopened.auth.phase,'verifying');assert.equal(reopened.account?.status,'offline');
  const client=reopened.client!,identity=client.identity.bind(client);let calls=0;
  client.identity=async()=>{calls++;throw new Error('network secret should not leak');};
  await reopened.verifyLogin(true);assert.equal(reopened.auth.phase,'offline');assert.ok(reopened.auth.nextRetryAt);
  assert(!JSON.stringify(reopened.state()).includes('secret should'));
  await reopened.retryLoginIfDue();assert.equal(calls,1);
  reopened.auth.nextRetryAt=new Date(0).toISOString();client.identity=identity;
  await reopened.retryLoginIfDue();assert.equal(reopened.account?.status,'authenticated');
  const {BaselandAuthError}=await import('./baseland.ts');
  client.identity=async()=>{throw new BaselandAuthError('expired','expired');};
  await reopened.verifyLogin(true);assert.equal(reopened.auth.phase,'expired');assert.equal(reopened.auth.nextRetryAt,undefined);
  assert.deepEqual(await fs.readFile(sessionFile),before);
  client.identity=async()=>{throw new Error('offline');};
  for(let i=0;i<4;i++)await reopened.verifyLogin(true);
  assert.equal(reopened.auth.nextRetryAt,undefined);
});

test('0.5 login: late validation cannot restore logged-out identity, unreadable credentials retain account workspace',async t=>{
  const f=await fixture(t),service=f.make();await service.init();await service.login({origin,username:'alice',password:'fixture-password',remember:true});
  const original={...service.account!};let release!:(v:typeof original)=>void;
  service.client!.identity=()=>new Promise(resolve=>{release=resolve;});
  const pending=service.verifyLogin(true);await service.logout();release(original);await pending;
  assert.equal(service.account,null);assert.equal(service.auth.phase,'signed-out');
  const saved=f.make();await saved.init();await saved.login({origin,username:'alice',password:'fixture-password',remember:true});
  const key=saved.key;const reopened=f.make();reopened.vault={...reopened.vault,decrypt:()=>{throw new Error('unavailable');}};
  await reopened.init();assert.equal(reopened.key,key);assert.equal(reopened.auth.phase,'unreadable');assert.equal(reopened.client,null);
});
