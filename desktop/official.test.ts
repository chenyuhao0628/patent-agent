import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopService } from './service.ts';
import { CaseFiles, atomicJSON, digest } from './files.ts';
import {
  applySubmissionToCurrent, assignCurrentProcess, BaselandClient, combineOfficialSubmission, mapFlowNodes, mergePersonalRows, officialDate,
  preserveStale, processRow, selectCurrentProcess, sendStatusState, SUBMISSION_REFRESH_ERROR, withOfficialWait,
} from './baseland.ts';
import { caseStatus, editableCurrent, effectiveSubmission, historyRecords, isConfirmedOfficialSubmission, processSubmission, UNVERIFIED_OFFICIAL_LABEL, WAITING_OFFICIAL_LABEL } from '../src/domain/lifecycle.ts';
import { businessKind } from '../src/domain/library.ts';
import type { Case, RemoteProcess, Submission } from '../src/domain/workflow.ts';
import { readSharedCases } from './shared.ts';

const origin='https://fixture.baselandtec.com';
function sent(at='2026-01-01T00:00:00.000Z'):Submission {return {state:'sent',source:'hand',checkedAt:at,message:'已递交，等待官方处理'};}
function proc(partial:Partial<RemoteProcess>&Pick<RemoteProcess,'id'|'name'>):RemoteProcess {
  return {status:-1,node:'',undertaker:'',deadline:'',...partial};
}

test('official date rejects blanks, null and impossible calendar values',()=>{
  assert.equal(officialDate(null),'');
  assert.equal(officialDate(''),'');
  assert.equal(officialDate('  '),'');
  assert.equal(officialDate('2026-13-01'),'');
  assert.equal(officialDate('2026-02-30'),'');
  assert.equal(officialDate('2026-09-31'),'');
  assert.equal(officialDate('0000-00-00'),'');
  assert.equal(officialDate('2026-10-01'),'2026-10-01');
  assert.equal(officialDate('2026-10-01T12:00:00'),'2026-10-01');
  assert.equal(officialDate('  2026-10-01'),'2026-10-01');
  assert.equal(officialDate('2026-10-01  '),'2026-10-01');
  assert.equal(officialDate(' 2026-02-31 '),'');
});

test('process rows store CaseProcLegalDate as Baseland deadline, never as official, and keep internal secondary',()=>{
  const p=processRow({CaseProcId:'p1',CaseProcName:'第一次审查意见答复',CaseProcLegalDate:'2026-10-01',CaseProcCustomDate:'2026-09-28',ProcStatusCode:0});
  assert.equal(p.deadline,'2026-10-01');
  assert.equal(p.baselandDeadline,'2026-10-01');
  assert.equal(p.officialDeadline,undefined);
  assert.equal(p.internalDeadline,'2026-09-28');
  const missing=processRow({CaseProcId:'p2',CaseProcName:'答复',CaseProcLegalDate:null,CaseProcCustomDate:'2027-01-07'});
  assert.equal(missing.deadline,'');
  assert.equal(missing.baselandDeadline,undefined);
  assert.equal(missing.officialDeadline,undefined);
  assert.equal(missing.internalDeadline,'2027-01-07');
});

test('process refresh keeps genuine official provenance while updating Baseland legal date',()=>{
  const previous=proc({id:'p1',name:'第一次审查意见答复',officialDeadline:'2026-11-01',officialDeadlineSource:'cpc',baselandDeadline:'2026-08-01',deadline:'2026-11-01'});
  const next=processRow({CaseProcId:'p1',CaseProcName:'第一次审查意见答复',CaseProcLegalDate:'2026-10-01',CaseProcCustomDate:'2026-09-28',ProcStatusCode:0},previous);
  assert.equal(next.officialDeadline,'2026-11-01');
  assert.equal(next.officialDeadlineSource,'cpc');
  assert.equal(next.baselandDeadline,'2026-10-01');
  assert.equal(next.deadline,'2026-11-01');
  assert.equal(next.internalDeadline,'2026-09-28');
});

test('send-status dictionary codes map exactly and never coerce null or 4/5 to draft',()=>{
  assert.equal(sendStatusState(0),'draft');
  assert.equal(sendStatusState(1),'queued');
  assert.equal(sendStatusState(2),'sent');
  assert.equal(sendStatusState(3),'failed');
  assert.equal(sendStatusState(6),'received');
  assert.equal(sendStatusState(100),'sending');
  assert.equal(sendStatusState(null),undefined);
  assert.equal(sendStatusState(''),undefined);
  assert.equal(sendStatusState({SendStatus:null}),undefined);
  assert.equal(sendStatusState({SendStatus:''}),undefined);
  assert.equal(sendStatusState(4),undefined);
  assert.equal(sendStatusState(5),undefined);
  assert.equal(sendStatusState(7),undefined);
});

test('primary hand flag plus send-info combinations follow confirmed official mapping',()=>{
  const at='2026-09-12T00:00:00.000Z';
  const trueNull=combineOfficialSubmission(true,null,at);
  assert.equal(trueNull.state,'sent');
  assert.equal(trueNull.source,'hand');
  assert.equal(trueNull.message,'已递交，等待官方处理');
  const falseNull=combineOfficialSubmission(false,null,at);
  assert.equal(falseNull.state,'draft');
  assert.equal(falseNull.source,'hand');
  assert.equal(falseNull.message,'未递交官方');
  const absentNull=combineOfficialSubmission(undefined,null,at);
  assert.equal(absentNull.state,'unknown');
  const packageOnly=combineOfficialSubmission(undefined,null,at);
  assert.equal(packageOnly.state,'unknown');
  const staleFail=combineOfficialSubmission(true,{SendStatus:3},at);
  assert.equal(staleFail.state,'sent');
  assert.equal(staleFail.source,'hand');
  const receipt=combineOfficialSubmission(true,{SendStatus:6},at);
  assert.equal(receipt.state,'received');
  assert.equal(receipt.source,'send-status');
});

test('F1 processSubmission only matches the explicit current process and does not block a new stage',()=>{
  const c:Case={id:'c',title:'合成装置',number:'SYN-1',type:'发明',deadline:'',archived:false,tags:[],rounds:[],source:'baseland',
    current:{kind:'reply',processId:'new',remoteStatus:0},
    remote:{caseId:'r1',syncedAt:'',processes:[proc({id:'old',name:'提出申请',status:500,deadline:'2026-06-01',officialDeadline:'2026-06-01',submission:sent()})]}};
  assert.equal(processSubmission(c),undefined);
  assert.equal(editableCurrent(c),true);
  assert.match(caseStatus(c),/待核对|审查意见/);
  const external:Case={...c,current:{kind:'external',label:'不在当前个人案件结果中，请核对分配情况'}};
  assert.equal(processSubmission(external),undefined);
  assert.equal(editableCurrent(external),false);
  assert.match(caseStatus(external),/不在当前个人案件/);
});

test('F2 unknown and draft keep local progress except meaningful 300/400 递交办理',()=>{
  const base:Case={id:'c',title:'合成装置',number:'SYN-2',type:'发明',deadline:'2026-10-01',archived:false,tags:[],rounds:[{id:'r',name:'第一次审查意见',stage:'materials',confirmed:false,materials:[],strategy:null,draft:'',versions:[],discussions:[],review:null,job:null,final:null,finalHistory:[]}],source:'baseland'};
  const unknown:Case={...base,current:{kind:'reply',processId:'p',roundId:'r',remoteStatus:0,label:'第一次审查意见答复'},remote:{caseId:'r',syncedAt:'',processes:[proc({id:'p',name:'第一次审查意见答复',status:0,submission:{state:'unknown',checkedAt:'2026-09-12T00:00:00.000Z',message:'官方递交状态未确认'}})]}};
  assert.match(caseStatus(unknown),/待处理/);
  assert.equal(processSubmission(unknown)?.state,'unknown');
  const draftWait:Case={...unknown,current:{...unknown.current!,remoteStatus:0},remote:{caseId:'r',syncedAt:'',processes:[proc({id:'p',name:'第一次审查意见答复',status:0,submission:{state:'draft',source:'hand',checkedAt:'2026-09-12T00:00:00.000Z',message:'未递交官方'}})]}};
  assert.match(caseStatus(draftWait),/待处理/);
  const delivering:Case={...unknown,current:{kind:'reply',processId:'p',roundId:'r',remoteStatus:400,label:'第一次审查意见答复'},remote:{caseId:'r',syncedAt:'',processes:[proc({id:'p',name:'第一次审查意见答复',status:400,node:'递交官方',undertaker:'PersonB',submission:{state:'draft',source:'hand',checkedAt:'2026-09-12T00:00:00.000Z',message:'未递交官方'}})]}};
  assert.match(caseStatus(delivering),/^递交中/);
  assert.equal(editableCurrent(delivering),false);
  const queued:Case={...delivering,remote:{caseId:'r',syncedAt:'',processes:[proc({id:'p',name:'第一次审查意见答复',status:400,submission:{state:'queued',source:'send-status',checkedAt:'2026-09-12T00:00:00.000Z'}})]}};
  assert.equal(caseStatus(queued),'准备递交中');
  const sentCase:Case={...delivering,remote:{caseId:'r',syncedAt:'',processes:[proc({id:'p',name:'第一次审查意见答复',status:400,submission:sent()})]}};
  applySubmissionToCurrent(sentCase,sentCase.remote!.processes[0]);
  assert.equal(sentCase.current?.kind,'waiting');
  assert.equal(sentCase.current?.label,WAITING_OFFICIAL_LABEL);
  assert.equal(sentCase.current?.processId,'p');
  assert.equal(caseStatus(sentCase),'已递交，等待官方处理结果');
  assert.equal(editableCurrent(sentCase),false);
  assert.equal(businessKind(sentCase),'审查意见');
});

test('F3 CurrentFlowInfo wins exclusively over a stale unfinished IsCurrentFlowNode mark',()=>{
  const nodes=mapFlowNodes([
    {FlowStepName:'开始',FlowUserName:'PersonA',IsRunning:true,IsFinish:false,IsCurrentFlowNode:true,Sort:1,SerialNumber:1},
    {FlowStepName:'递交官方',FlowUserName:'PersonB',IsRunning:true,IsFinish:false,IsCurrentFlowNode:false,Sort:2,SerialNumber:2},
    {FlowStepName:'结束',IsRunning:false,IsFinish:false,IsCurrentFlowNode:false,Sort:3},
  ],{name:'递交官方',user:'PersonB',serial:2,total:3});
  assert.equal(nodes.filter(n=>n.isCurrent).length,1);
  assert.equal(nodes[0].isCurrent,false);
  assert.equal(nodes[1].isCurrent,true);
  assert.equal(nodes[1].user,'PersonB');
  const finishedRunning=mapFlowNodes([
    {FlowStepName:'开始',IsRunning:true,IsFinish:true,IsCurrentFlowNode:true,Sort:1},
    {FlowStepName:'递交官方',IsRunning:true,IsFinish:false,IsCurrentFlowNode:true,Sort:2},
  ],{name:'递交官方',user:'PersonB',serial:2,total:3});
  assert.equal(finishedRunning[0].finished,true);
  assert.equal(finishedRunning[0].running,false);
  assert.equal(finishedRunning[0].isCurrent,false);
  assert.equal(finishedRunning[1].isCurrent,true);
  const repeated=mapFlowNodes([
    {FlowStepName:'核稿',IsFinish:false,IsCurrentFlowNode:true,Sort:1,SerialNumber:1},
    {FlowStepName:'核稿',IsFinish:false,IsCurrentFlowNode:true,Sort:2,SerialNumber:2},
  ],{name:'核稿',user:'PersonB',serial:2,total:2});
  assert.equal(repeated.filter(n=>n.isCurrent).length,1);
  assert.equal(repeated[1].isCurrent,true);
});

test('F4 newer active or dated completed main beats stale preferred; personal scope ignores another person in full case',()=>{
  const old=proc({id:'old',name:'提出申请',status:500,handId:'h-old'});
  const newerCompleted=proc({id:'newer',name:'第一次审查意见答复',status:500,handId:'h-new'});
  const rows=[{CaseProcId:'old',CaseProcFinishDate:'2026-01-01'},{CaseProcId:'newer',CaseProcFinishDate:'2026-06-01'}];
  assert.equal(selectCurrentProcess([old,newerCompleted],rows,'old')?.id,'newer');
  const active=proc({id:'reply',name:'第一次审查意见答复',status:0});
  assert.equal(selectCurrentProcess([old,active],rows,'old')?.id,'reply');
  const otherMain=proc({id:'other-reply',name:'第一次审查意见答复',status:0});
  const aux=proc({id:'fee',name:'缴申请费',status:0});
  assert.equal(selectCurrentProcess([old,otherMain,aux],[{CaseProcId:'old',CaseProcFinishDate:'2026-01-01',CaseProcOperateInfo:{IsExistsHand:true}}], 'old', ['old'])?.id,'old');
  assert.equal(selectCurrentProcess([old,proc({id:'new',name:'请求复审',status:0})],[],old.id)?.id,'new');
  assert.equal(selectCurrentProcess([proc({id:'a',name:'答复审查意见',status:0}),proc({id:'b',name:'答复补正',status:0})],[],'a')?.id,'a');
  assert.equal(selectCurrentProcess([proc({id:'a',name:'答复审查意见',status:0}),proc({id:'b',name:'答复补正',status:0})],[],'gone'),undefined);
  assert.equal(selectCurrentProcess([proc({id:'a',name:'答复审查意见',status:0}),proc({id:'b',name:'答复补正',status:0})],[]),undefined);
  assert.equal(selectCurrentProcess([old,proc({id:'fee',name:'缴申请费',status:0})],[],old.id)?.id,old.id);
  const staleReceived=proc({id:'old',name:'答复审查意见',status:400,handId:'hand',submission:{state:'received',checkedAt:'2026-09-12T00:00:00.000Z'}});
  const fresh=proc({id:'new',name:'答复审查意见（二）',status:0});
  assert.equal(selectCurrentProcess([staleReceived,fresh],[],'old')?.id,'new');
  const restore=proc({id:'new',name:'恢复权利请求',status:0});
  assert.equal(selectCurrentProcess([{...staleReceived,status:500},restore],[],'old')?.id,'new');
  assert.equal(selectCurrentProcess([restore,proc({id:'other',name:'办理登记手续',status:0})],[],'old'),undefined);
});

test('unknown non-auxiliary process is current external, not an OA reply round',()=>{
  const c:Case={id:'c',title:'合成装置',number:'SYN-EXT',type:'发明',deadline:'',archived:false,tags:[],rounds:[],source:'baseland',
    current:{kind:'waiting',processId:'old',remoteStatus:500,label:'答复审查意见'},
    remote:{caseId:'r',syncedAt:'',processes:[
      proc({id:'old',name:'答复审查意见',status:500,handId:'h',submission:{state:'received',checkedAt:'2026-09-12T00:00:00.000Z'}}),
      proc({id:'new',name:'恢复权利请求',status:0}),
    ]}};
  assignCurrentProcess(c,c.remote!.processes[1],'2026-09-12T00:00:00.000Z');
  assert.equal(c.current?.kind,'external');
  assert.equal(c.current?.processId,'new');
  assert.equal(c.rounds.some(r=>r.id==='proc-new'),false);
  const merged=mergePersonalRows([
    {CaseId:'r',CaseProcId:'old',CaseName:'装置',CaseNo:'1',CaseProcName:'答复审查意见',_status:500,CaseProcFinishDate:'2026-01-01',CaseProcOperateInfo:{IsExistsHand:true}},
    {CaseId:'r',CaseProcId:'new',CaseName:'装置',CaseNo:'1',CaseProcName:'恢复权利请求',_status:0},
  ],[c],'2026-09-12')[0];
  assert.equal(merged.current?.kind,'external');
  assert.equal(merged.current?.processId,'new');
});

test('received is completed evidence; official result remains the current waiting step',()=>{
  const unfinished={name:'核稿',user:'A',finished:false,running:true,isCurrent:true,start:'',end:''};
  const ended={name:'结束',user:'递交人',finished:true,running:false,isCurrent:false,start:'',end:''};
  const n=withOfficialWait([unfinished,ended],{state:'received',source:'send-status',checkedAt:'2026-09-01T00:00:00.000Z'});
  assert.equal(n.find(x=>x.name==='核稿')?.finished,false);
  assert.equal(n.find(x=>x.name==='结束')?.finished,true);
  const current=n.filter(x=>x.isCurrent);
  assert.equal(current.length,1);
  assert.match(current[0].name,/等待.*官方|官方.*等待/);
  assert.equal(current[0].user,'官方');
  assert.equal(current[0].finished,false);
  assert(n.some(x=>/回执/.test(x.name)&&x.finished&&!x.isCurrent));
  const sentNodes=withOfficialWait([ended],sent());
  assert.equal(sentNodes.at(-1)!.name,'等待官方处理结果');
  assert.equal(sentNodes.at(-1)!.user,'官方');
  assert.equal(sentNodes.find(x=>x.name==='结束')?.finished,true);
});

test('F7 failed refresh keeps confirmed sent state, old checkedAt, and a visible refresh error',()=>{
  const previous=sent('2026-01-01T00:00:00.000Z');
  const kept=preserveStale(previous,{state:'unknown',checkedAt:'2026-09-12T00:00:00.000Z',message:'未能确认官方递交状态，请稍后重试。'});
  assert.equal(kept.state,'sent');
  assert.equal(kept.checkedAt,'2026-01-01T00:00:00.000Z');
  assert.equal(kept.message,'已递交，等待官方处理');
  assert.equal(kept.refreshError,SUBMISSION_REFRESH_ERROR);
  assert.notEqual(kept.message,kept.refreshError);
});

test('merge keeps Baseland legal date and does not take the earlier internal date',()=>{
  const c=mergePersonalRows([{CaseId:'c1',CaseProcId:'now',CaseName:'装置',CaseNo:'1',CaseProcName:'补正',_status:0,CaseProcLegalDate:'2026-10-01',CaseProcCustomDate:'2026-09-28'}],[],'2026-09-12')[0];
  assert.equal(c.deadline,'2026-10-01');
  assert.equal(c.remote?.processes[0].baselandDeadline,'2026-10-01');
  assert.equal(c.remote?.processes[0].officialDeadline,undefined);
  assert.equal(c.remote?.processes[0].internalDeadline,'2026-09-28');
});

test('sync receipt waits on the current process; a later OA on the same account resumes reply',()=>{
  const received=proc({id:'app',name:'提出申请',status:500,submission:{state:'received',source:'send-status',checkedAt:'2026-01-01T00:00:00.000Z',message:'已收到回执'}});
  const existing:Case={id:'c',title:'合成装置',number:'SYN-OA',type:'发明',deadline:'',archived:false,tags:[],rounds:[{
    id:'proc-app',name:'提出申请',stage:'draft',confirmed:true,
    materials:[{id:'m1',name:'申请文件.pdf',role:'系统材料',location:'',excerpt:'',ready:true}],
    strategy:null,draft:'申请轮次正文',versions:[],discussions:[],review:null,
    job:{id:'job-1',kind:'drafting',status:'paused',due:1},final:null,finalHistory:[],
  }],source:'baseland',
    current:{kind:'write',processId:'app',roundId:'proc-app',label:'提出申请',remoteStatus:500},localDraft:'申请稿件',
    remote:{caseId:'c1',syncedAt:'',processes:[received]}};
  const leftover=structuredClone(existing);
  leftover.rounds[0].job={id:'job-run',kind:'drafting',status:'running',due:1};
  applySubmissionToCurrent(existing,received);
  assert.equal(existing.current?.kind,'waiting');
  assert.equal(existing.current?.processId,'app');
  assert.equal(existing.localDraft,'申请稿件');
  assert.equal(existing.rounds[0].job,null);
  assert.equal(existing.rounds[0].draft,'申请轮次正文');
  assert.equal(existing.rounds[0].materials[0]?.name,'申请文件.pdf');
  const synced=mergePersonalRows([{CaseId:'c1',CaseProcId:'app',CaseName:'装置',CaseNo:'1',CaseProcName:'提出申请',_status:500,CaseProcLegalDate:'2026-01-01',CaseProcFinishDate:'2026-01-01'}],[leftover],'2026-09-12')[0];
  assert.equal(synced.current?.kind,'waiting');
  assert.equal(synced.rounds[0].job,null);
  assert.equal(synced.rounds[0].draft,'申请轮次正文');
  assert.equal(synced.rounds[0].materials[0]?.name,'申请文件.pdf');
  const next=mergePersonalRows([
    {CaseId:'c1',CaseProcId:'app',CaseName:'装置',CaseNo:'1',CaseProcName:'提出申请',_status:500,CaseProcLegalDate:'2026-01-01',CaseProcFinishDate:'2026-01-01'},
    {CaseId:'c1',CaseProcId:'oa',CaseName:'装置',CaseNo:'1',CaseProcName:'第一次审查意见答复',_status:0,CaseProcLegalDate:'2026-10-01'},
  ],[existing],'2026-09-12')[0];
  assert.equal(next.current?.kind,'reply');
  assert.equal(next.current?.processId,'oa');
  assert.equal(next.localDraft,'');
  assert(next.localVersions?.some(v=>v.text==='申请稿件'&&v.processId==='app'));
  assert.equal(editableCurrent(next),true);
  assert.equal(businessKind(next),'审查意见');
});

async function tempService(t:test.TestContext) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'patent-official-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const work=path.join(root,'work');await fs.mkdir(work);
  const vault={available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''};
  return {root,work,vault};
}

test('IsNeedSendToOfficail false does not force official-filing verification on internal 500',async()=>{
  const client=new BaselandClient(origin,'fixture',async input=>{
    const u=new URL(String(input));
    if(u.pathname.endsWith('/GetHandInfo'))return Response.json({IsSuccess:true,Data:{IsNeedSendToOfficail:false,HandInfo:{CaseHandId:'hand-1'}}});
    if(u.pathname.endsWith('/GetCaseHandSendInfo'))return Response.json({IsSuccess:true,Data:null});
    throw new Error('Unexpected endpoint: '+u.pathname);
  });
  const result=await client.queryOfficial('proc-1','hand-1');
  assert.equal(result.needSendOfficial,false);
  assert.equal(result.submission.state,'unknown');
  const c:Case={id:'c',title:'合成装置',number:'SYN-NS',type:'发明',deadline:'',archived:false,tags:[],rounds:[],source:'baseland',
    current:{kind:'write',processId:'app',remoteStatus:500,label:'提出申请'},
    remote:{caseId:'r',syncedAt:'',processes:[proc({id:'app',name:'提出申请',status:500,needSendOfficial:false})]}};
  applySubmissionToCurrent(c,c.remote!.processes[0]);
  assert.notEqual(c.current?.label,UNVERIFIED_OFFICIAL_LABEL);
  assert.doesNotMatch(caseStatus(c),/官方递交待核验/);
  assert.doesNotMatch(caseStatus(c),/授权|驳回/);
  const needed:Case={...c,remote:{caseId:'r',syncedAt:'',processes:[proc({id:'app',name:'提出申请',status:500,needSendOfficial:true})]}};
  needed.current={kind:'write',processId:'app',remoteStatus:500,label:'提出申请'};
  applySubmissionToCurrent(needed,needed.remote!.processes[0]);
  assert.equal(needed.current?.label,UNVERIFIED_OFFICIAL_LABEL);
});

test('GetHandInfo IsPackage or IsNeedSendToOfficail alone never counts as official success',async()=>{
  const client=new BaselandClient(origin,'fixture',async input=>{
    const u=new URL(String(input));
    if(u.pathname.endsWith('/GetHandInfo'))return Response.json({IsSuccess:true,Data:{IsNeedSendToOfficail:true,HandInfo:{CaseHandId:'hand-1',IsPackage:true,SendDate:null}}});
    if(u.pathname.endsWith('/GetCaseHandSendInfo'))return Response.json({IsSuccess:true,Data:null});
    throw new Error('Unexpected endpoint: '+u.pathname);
  });
  const result=await client.queryOfficial('proc-1','hand-1');
  assert.equal(result.ok,true);
  assert.equal(result.submission.state,'unknown');
});

test('queryOfficial primary true with send-info Data null is sent without claiming receipt',async()=>{
  const client=new BaselandClient(origin,'fixture',async input=>{
    const u=new URL(String(input));
    if(u.pathname.endsWith('/GetHandInfo'))return Response.json({IsSuccess:true,Data:{IsPackageSendSuccess:true,IsNeedSendToOfficail:true,HandInfo:{CaseHandId:'hand-1',IsPackage:true,SendDate:null}}});
    if(u.pathname.endsWith('/GetCaseHandSendInfo'))return Response.json({IsSuccess:true,Data:null});
    throw new Error('Unexpected endpoint: '+u.pathname);
  });
  const result=await client.queryOfficial('proc-1');
  assert.equal(result.submission.state,'sent');
  assert.equal(result.submission.source,'hand');
  assert.equal(result.submission.message,'已递交，等待官方处理');
});

test('flow optional submission failure still returns nodes, and history failure does not drop confirmed official state',async()=>{
  const c:Case={id:'c',title:'合成装置',number:'SYN-3',type:'发明',deadline:'',archived:false,tags:[],rounds:[],source:'baseland',
    current:{kind:'reply',processId:'proc-1',remoteStatus:400},
    remote:{caseId:'case-1',syncedAt:'',processes:[proc({id:'proc-1',name:'第一次审查意见答复',status:400,submission:sent('2026-01-01T00:00:00.000Z'),handId:'hand-1'})]}};
  const client=new BaselandClient(origin,'fixture',async input=>{
    const u=new URL(String(input));
    if(u.pathname.endsWith('/GetCaseDetailProcList'))return Response.json({IsSuccess:true,Data:[{CaseProcId:'proc-1',CaseProcName:'第一次审查意见答复',ProcStatusCode:400,CaseProcLegalDate:'2026-10-01'}]});
    if(u.pathname.endsWith('/GetProcFlowRecord'))return Response.json({IsSuccess:true,Data:[{FlowStepName:'递交官方',FlowUserName:'PersonB',IsRunning:true,IsFinish:false,IsCurrentFlowNode:true,Sort:2}]});
    if(u.pathname.endsWith('/GetHandInfo'))return Response.json({IsSuccess:false,Message:'temporary'});
    if(u.pathname.endsWith('/GetCaseAllFlowHistoryInfo'))return Response.json({IsSuccess:false,Message:'history-unavailable'});
    throw new Error('Unexpected endpoint: '+u.pathname);
  });
  const view=await client.flow(c);
  assert.equal(view.currentProcessId,'proc-1');
  assert.equal(view.nodes.length,2);
  assert.equal(view.nodes[0].name,'递交官方');
  assert.equal(view.nodes[1].type,'official');
  assert.equal(view.processes?.processes[0].submission?.state,'sent');
  assert.equal(view.processes?.processes[0].submission?.checkedAt,'2026-01-01T00:00:00.000Z');
  assert.equal(view.processes?.processes[0].submission?.refreshError,SUBMISSION_REFRESH_ERROR);
  assert.deepEqual(view.history,[]);
});

test('full-case auxiliary and another person main process do not replace the personal selected process',async()=>{
  const c:Case={id:'c',title:'合成申请',number:'SYN-4',type:'发明',deadline:'2026-10-01',archived:false,tags:[],rounds:[],source:'baseland',
    current:{kind:'write',processId:'app',remoteStatus:500,label:'提出申请'},
    remote:{caseId:'case-1',syncedAt:'',processes:[proc({id:'app',name:'提出申请',status:500,handId:'hand-app',officialDeadline:'2026-10-01',deadline:'2026-10-01'})]}};
  const requested:string[]=[];
  const client=new BaselandClient(origin,'fixture',async input=>{
    const u=new URL(String(input));requested.push(u.pathname);
    if(u.pathname.endsWith('/GetCaseDetailProcList'))return Response.json({IsSuccess:true,Data:[
      {CaseProcId:'app',CaseProcName:'提出申请',ProcStatusCode:500,CaseProcLegalDate:'2026-10-01',CaseProcFinishDate:'2026-01-01',CaseProcUndertakerUserName:'本人'},
      {CaseProcId:'other-reply',CaseProcName:'第一次审查意见答复',ProcStatusCode:0,CaseProcUndertakerUserName:'其他人'},
      {CaseProcId:'fee',CaseProcName:'缴申请费',ProcStatusCode:0,CaseProcUndertakerUserName:'其他人'},
    ]});
    if(u.pathname.endsWith('/GetProcFlowRecord')){assert.equal(u.searchParams.get('caseProcId'),'app');return Response.json({IsSuccess:true,Data:[{FlowStepName:'结束',IsFinish:true,IsRunning:false,Sort:3}]});}
    if(u.pathname.endsWith('/GetHandInfo'))return Response.json({IsSuccess:true,Data:{IsPackageSendSuccess:true,HandInfo:{CaseHandId:'hand-app'},CurrentFlowInfo:null}});
    if(u.pathname.endsWith('/GetCaseHandSendInfo'))return Response.json({IsSuccess:true,Data:{SendStatus:6}});
    if(u.pathname.endsWith('/GetCaseAllFlowHistoryInfo'))return Response.json({IsSuccess:true,Data:{List:[]}});
    throw new Error('Unexpected endpoint: '+u.pathname);
  });
  const view=await client.flow(c);
  assert.equal(view.currentProcessId,'app');
  assert.equal(view.processes?.processes.length,3);
  assert.equal(view.processes?.processes.find(p=>p.id==='app')?.submission?.state,'received');
  assert.equal(requested.filter(p=>p.endsWith('/GetProcFlowRecord')).length,1);
  assert(!requested.some(p=>/StartHand|StartPack|Submit|Cancel|Upload|FiveFormsGetPack|send-start/.test(p)));
});

test('shared index keeps official metadata and clears legacy mixed remote deadlines',async t=>{
  const {work}=await tempService(t);
  const profile='alice';
  const dir=path.join(work,'案件',profile,'SYN_official');
  await fs.mkdir(path.join(dir,'02_工作稿'),{recursive:true});
  await fs.writeFile(path.join(dir,'案件信息.json'),JSON.stringify({schema:2,id:'case-new',profile,title:'合成官方',number:'SYN-NEW',type:'发明',deadline:'2026-09-28',source:'baseland',remoteCaseId:'r1',current:{kind:'reply',processId:'p1',remoteStatus:0},remote:{caseId:'r1',syncedAt:'2026-09-12',processes:[{id:'p1',name:'第一次审查意见答复',status:0,node:'开始',undertaker:'PersonB',deadline:'2026-09-28',officialDeadline:'2026-10-01',internalDeadline:'2026-09-28',submission:sent()}]},materials:[],rounds:[]}));
  const kept=(await readSharedCases(work,profile,[])).cases[0];
  assert.equal(kept.deadline,'2026-10-01');
  assert.equal(kept.remote?.processes[0].baselandDeadline,'2026-10-01');
  assert.equal(kept.remote?.processes[0].officialDeadline,undefined);
  assert.equal(kept.remote?.processes[0].submission?.state,'sent');
  assert.equal(kept.current?.kind,'waiting');
  assert.equal(kept.current?.label,WAITING_OFFICIAL_LABEL);
  assert.equal(kept.current?.processId,'p1');
  const legacyDir=path.join(work,'案件',profile,'SYN_legacy');
  await fs.mkdir(legacyDir,{recursive:true});
  await fs.writeFile(path.join(legacyDir,'案件信息.json'),JSON.stringify({schema:2,id:'case-old',profile,title:'合成旧期限',number:'SYN-OLD',type:'发明',deadline:'2026-09-28',source:'baseland',remoteCaseId:'r2',current:{kind:'reply',processId:'p2'},remote:{caseId:'r2',syncedAt:'',processes:[{id:'p2',name:'第一次审查意见答复',status:0,node:'',undertaker:'',deadline:'2026-09-28'}]},materials:[],rounds:[]}));
  const cleared=(await readSharedCases(work,profile,[])).cases.find(c=>c.id==='case-old')!;
  assert.equal(cleared.deadline,'');
  assert.equal(cleared.remote?.processes[0].officialDeadline,undefined);
  assert.equal(cleared.remote?.processes[0].baselandDeadline,undefined);
  assert.equal(cleared.remote?.processes[0].deadline,'');
});

test('shared reload keeps genuine official, normalizes legacy receipt, and does not rewrite drafts',async t=>{
  const {work}=await tempService(t);
  const profile='alice',processId='p1';
  const dir=path.join(work,'案件',profile,'SYN_receipt');
  const realDraft=path.join(dir,'02_工作稿',digest(processId).slice(0,10),'工作稿.json');
  await fs.mkdir(path.dirname(realDraft),{recursive:true});
  await fs.writeFile(path.join(dir,'案件信息.json'),JSON.stringify({schema:2,id:'case-recv',profile,title:'合成回执',number:'SYN-RECV',type:'发明',deadline:'2026-09-28',source:'baseland',remoteCaseId:'r3',current:{kind:'reply',processId,roundId:'proc-p1',remoteStatus:0,label:'第一次审查意见答复'},remote:{caseId:'r3',syncedAt:'2026-09-12',processes:[{id:processId,name:'第一次审查意见答复',status:0,node:'开始',undertaker:'PersonB',deadline:'2026-09-28',officialDeadline:'2026-11-01',officialDeadlineSource:'cpc',baselandDeadline:'2026-10-01',internalDeadline:'2026-09-28',submission:{state:'received',source:'send-status',checkedAt:'2026-09-12T00:00:00.000Z',message:'已收到回执'}}]},materials:[],rounds:[{id:'proc-p1',name:'第一次审查意见答复',materials:[]}] }));
  await fs.writeFile(realDraft,JSON.stringify({caseId:'case-recv',processId,text:'保留的答复稿',versions:[]},null,2));
  const before=(await fs.stat(realDraft)).mtimeMs;
  const loaded=(await readSharedCases(work,profile,[])).cases[0];
  const after=(await fs.stat(realDraft)).mtimeMs;
  assert.equal(after,before);
  assert.equal(loaded.current?.kind,'waiting');
  assert.equal(loaded.current?.processId,processId);
  assert.equal(loaded.localDraft,'保留的答复稿');
  assert.equal(loaded.localVersions?.length??0,0);
  assert.equal(loaded.deadline,'2026-11-01');
  assert.equal(loaded.remote?.processes[0].officialDeadline,'2026-11-01');
  assert.equal(loaded.remote?.processes[0].officialDeadlineSource,'cpc');
  assert.equal(loaded.remote?.processes[0].baselandDeadline,'2026-10-01');
  assert(historyRecords(loaded).some(r=>r.text==='保留的答复稿'));
});

test('shared index keeps currentFlow, needSendOfficial and current node fields',async t=>{
  const {work}=await tempService(t);
  const profile='alice';
  const dir=path.join(work,'案件',profile,'SYN_flow');
  await fs.mkdir(path.join(dir,'02_工作稿'),{recursive:true});
  await fs.writeFile(path.join(dir,'案件信息.json'),JSON.stringify({schema:2,id:'case-flow',profile,title:'合成节点',number:'SYN-FLOW',type:'发明',deadline:'',source:'baseland',remoteCaseId:'r4',current:{kind:'reply',processId:'p1',remoteStatus:200,label:'第一次审查意见答复',node:'核稿',party:'内部',handler:'办理人'},remote:{caseId:'r4',syncedAt:'2026-09-12',processes:[{id:'p1',name:'第一次审查意见答复',status:200,node:'核稿',undertaker:'承办人',deadline:'',currentFlow:{name:'核稿',user:'办理人',serial:2,total:4},needSendOfficial:true}]},materials:[],rounds:[]}));
  const kept=(await readSharedCases(work,profile,[])).cases[0];
  assert.equal(kept.current?.node,'核稿');
  assert.equal(kept.current?.party,'内部');
  assert.equal(kept.current?.handler,'办理人');
  assert.equal(kept.remote?.processes[0].currentFlow?.name,'核稿');
  assert.equal(kept.remote?.processes[0].currentFlow?.user,'办理人');
  assert.equal(kept.remote?.processes[0].needSendOfficial,true);
});

test('shared reload switches stale official current to unique personal active and does not bounce a new current back',async t=>{
  const {work}=await tempService(t);
  const profile='alice',oldProcess='p1',newProcess='restore';
  const staleDir=path.join(work,'案件',profile,'SYN_stale');
  const staleDraft=path.join(staleDir,'02_工作稿',digest(oldProcess).slice(0,10),'工作稿.json');
  await fs.mkdir(path.dirname(staleDraft),{recursive:true});
  await fs.writeFile(path.join(staleDir,'案件信息.json'),JSON.stringify({schema:2,id:'case-stale',profile,title:'合成冲突',number:'SYN-STALE',type:'发明',deadline:'',source:'baseland',remoteCaseId:'r5',current:{kind:'waiting',processId:oldProcess,remoteStatus:500,label:'等待官方处理结果'},remote:{caseId:'r5',syncedAt:'2026-09-12',processes:[{id:oldProcess,name:'第一次审查意见答复',status:500,node:'结束',undertaker:'甲',deadline:'',submission:{state:'received',source:'send-status',checkedAt:'2026-01-01T00:00:00.000Z',message:'已收到回执'}},{id:newProcess,name:'恢复权利请求',status:0,node:'待办',undertaker:'甲',deadline:'',officialDeadline:'2026-10-01',officialDeadlineSource:'cpc'}]},materials:[],rounds:[{id:'proc-p1',name:'第一次审查意见答复',materials:[]}] }));
  await fs.writeFile(staleDraft,JSON.stringify({caseId:'case-stale',processId:oldProcess,text:'旧阶段稿件',versions:[]},null,2));
  const switched=(await readSharedCases(work,profile,[])).cases[0];
  assert.equal(switched.current?.processId,newProcess);
  assert.equal(switched.current?.kind,'external');
  assert(switched.localVersions?.some(v=>v.text==='旧阶段稿件'&&v.processId===oldProcess));
  assert.equal(switched.rounds.some(r=>r.id==='proc-p1'),true);
  assert.notEqual(switched.current?.kind,'waiting');
  const freshDir=path.join(work,'案件',profile,'SYN_fresh');
  const freshDraft=path.join(freshDir,'02_工作稿',digest(newProcess).slice(0,10),'工作稿.json');
  await fs.mkdir(path.dirname(freshDraft),{recursive:true});
  await fs.writeFile(path.join(freshDir,'案件信息.json'),JSON.stringify({schema:2,id:'case-fresh',profile,title:'合成已切',number:'SYN-FRESH',type:'发明',deadline:'',source:'baseland',remoteCaseId:'r6',current:{kind:'external',processId:newProcess,remoteStatus:0,label:'恢复权利请求'},remote:{caseId:'r6',syncedAt:'2026-09-12',processes:[{id:oldProcess,name:'第一次审查意见答复',status:500,node:'结束',undertaker:'甲',deadline:'',submission:{state:'received',source:'send-status',checkedAt:'2026-01-01T00:00:00.000Z',message:'已收到回执'}},{id:newProcess,name:'恢复权利请求',status:0,node:'待办',undertaker:'甲',deadline:''}]},materials:[],rounds:[{id:'proc-p1',name:'第一次审查意见答复',materials:[]}] }));
  await fs.writeFile(freshDraft,JSON.stringify({caseId:'case-fresh',processId:newProcess,text:'新阶段稿件',versions:[]},null,2));
  const kept=(await readSharedCases(work,profile,[])).cases.find(c=>c.id==='case-fresh')!;
  assert.equal(kept.current?.processId,newProcess);
  assert.equal(kept.current?.kind,'external');
  assert.equal(kept.localDraft,'新阶段稿件');
});

test('F5 stage change archives the previous draft and persists the same currentProcessId as the flow view',async t=>{
  const {root,work,vault}=await tempService(t);
  const s=new DesktopService(path.join(root,'data'),vault);
  s.key='account-a';s.workspace.settings.workRoot=work;s.account={username:'a',displayName:'A',organization:'T',origin,userId:'u',status:'authenticated',remembered:false};
  await s.createCase({title:'合成阶段',number:'SYN-STAGE',kind:'write'});
  const c=s.workspace.cases[0];
  c.source='baseland';c.localDraft='上一阶段稿件';c.current={kind:'write',processId:'old',remoteStatus:500,label:'提出申请'};
  c.remote={caseId:'case-1',syncedAt:'',processes:[proc({id:'old',name:'提出申请',status:500,deadline:'2026-06-01',officialDeadline:'2026-06-01'}),proc({id:'reply',name:'第一次审查意见答复',status:0,deadline:'2026-10-01',officialDeadline:'2026-10-01'})]};
  await s.files().saveDraft(c);await s.persist();
  s.client={flow:async()=>({at:'2026-09-12T00:00:00.000Z',currentProcessId:'reply',processes:{caseId:'case-1',syncedAt:'2026-09-12T00:00:00.000Z',processes:c.remote!.processes},nodes:[],history:[]})} as never;
  const view=await s.flow(c.id);
  assert.equal(view.currentProcessId,'reply');
  assert.equal(s.workspace.cases[0].current?.processId,'reply');
  assert.equal(s.workspace.cases[0].localDraft,'');
  assert(s.workspace.cases[0].localVersions?.some(v=>v.text==='上一阶段稿件'&&v.processId==='old'));
});

test('F6 account switch during flow filesystem write does not leak the previous case into the new account root',async t=>{
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

test('send-info transport failure keeps received receipt and never leaks the raw error',async()=>{
  const previous=Object.assign(sent('2026-01-01T00:00:00.000Z'),{state:'received' as const,source:'send-status' as const,message:'已收到回执'});
  const client=new BaselandClient(origin,'fixture',async input=>{
    const u=new URL(String(input));
    if(u.pathname.endsWith('/GetHandInfo'))return Response.json({IsSuccess:true,Data:{IsPackageSendSuccess:true,HandInfo:{CaseHandId:'hand-1'}}});
    if(u.pathname.endsWith('/GetCaseHandSendInfo'))throw new Error('socket reset fixture-secret');
    throw new Error('Unexpected endpoint: '+u.pathname);
  });
  const result=await client.queryOfficial('proc-1','hand-1',undefined,previous);
  assert.equal(result.ok,true);
  assert.equal(result.submission.state,'received');
  assert.equal(result.submission.checkedAt,'2026-01-01T00:00:00.000Z');
  assert.equal(result.submission.refreshError,SUBMISSION_REFRESH_ERROR);
  assert.equal(result.submission.message,'已收到回执');
  assert.notEqual(result.submission.state,'sent');
  assert.doesNotMatch(JSON.stringify(result),/socket reset|fixture-secret/);
});

test('send-info transport failure with primary true and no prior receipt still counts as sent',async()=>{
  const client=new BaselandClient(origin,'fixture',async input=>{
    const u=new URL(String(input));
    if(u.pathname.endsWith('/GetHandInfo'))return Response.json({IsSuccess:true,Data:{IsPackageSendSuccess:true,HandInfo:{CaseHandId:'hand-1'}}});
    if(u.pathname.endsWith('/GetCaseHandSendInfo'))throw new Error('send-info unavailable');
    throw new Error('Unexpected endpoint: '+u.pathname);
  });
  const result=await client.queryOfficial('proc-1','hand-1');
  assert.equal(result.ok,true);
  assert.equal(result.submission.state,'sent');
  assert.equal(result.submission.source,'hand');
  assert.equal(result.submission.message,'已递交，等待官方处理');
  assert.equal(result.submission.refreshError,undefined);
  assert.doesNotMatch(JSON.stringify(result),/unavailable/);
});

test('send-status dictionary endpoint is optional and does not invent unknown codes',async()=>{
  const client=new BaselandClient(origin,'fixture',async()=>Response.json({IsSuccess:true,Data:[{label:'待递交',value:0},{label:'准备递交中',value:1},{label:'递交成功',value:2},{label:'递交失败',value:3},{label:'已收到回执',value:6},{label:'递交中',value:100}]}));
  const list=await client.sendStatusViewTypes();
  assert.deepEqual(list.map(x=>x.value),[0,1,2,3,6,100]);
  assert.equal(list.find(x=>x.value===2)?.state,'sent');
  assert.equal(sendStatusState(4),undefined);
});


test('started hand edit permission is read from server and personal completion has separate provenance',async()=>{
  for(const permission of [true,false,undefined]){
    const client=new BaselandClient(origin,'fixture',async(input)=>Response.json({IsSuccess:true,Data:String(input).includes('GetHandInfo')?{HandInfo:{CaseHandId:'h'},IsReviewing:permission,IsPackageSendSuccess:false,CurrentFlowInfo:{FlowNodeName:'开始',FlowUserName:'陈雨浩'}}:null}));
    const result=await client.queryOfficial('p');assert.equal(result.canEdit,permission);assert.equal(result.submission.state,'draft');
  }
  const completed=processRow({CaseProcId:'p',CaseProcName:'提出申请',_status:500});
  assert.equal(completed.personalStatus,500);
  const ordinaryEnd=processRow({CaseProcId:'p',CaseProcName:'提出申请',StatusCode:500});
  assert.equal(ordinaryEnd.personalStatus,undefined);
});

test('A1 _status:500 + needSendOfficial:false must NOT count as officially submitted',()=>{
  const row=processRow({CaseProcId:'app',CaseProcName:'提出申请',_status:500});
  assert.equal(row.personalStatus,500);
  row.needSendOfficial=false;
  row.submission={state:'draft',source:'hand',checkedAt:'2026-09-12T00:00:00.000Z',message:'未递交官方'};
  assert.equal(effectiveSubmission(row)?.state,'draft');
  assert.equal(isConfirmedOfficialSubmission(effectiveSubmission(row)),false);
  const c:Case={id:'c',title:'合成装置',number:'SYN-A1',type:'发明',deadline:'',archived:false,tags:[],rounds:[],source:'baseland',
    current:{kind:'write',processId:'app',remoteStatus:500,label:'提出申请'},
    remote:{caseId:'r',syncedAt:'',processes:[row]}};
  applySubmissionToCurrent(c,c.remote!.processes[0]);
  assert.equal(isConfirmedOfficialSubmission(c.remote!.processes[0].submission),false);
  assert.notEqual(c.current?.party,'官方');
  assert.doesNotMatch(caseStatus(c),/已提交官方|已交官方/);
  assert.match(c.current?.node??'',/内部流程已结束|等待后续/);
});
