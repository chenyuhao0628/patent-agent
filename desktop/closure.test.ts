import test from 'node:test';
import assert from 'node:assert/strict';
import {applyRemoteClosure,BaselandClient,mergePersonalRows} from './baseland.ts';
import {libraryStatus} from '../src/domain/library.ts';
const at='2026-09-12T00:00:00Z';
const make=()=>mergePersonalRows([{CaseId:'c',CaseProcId:'p',ProcStatusCode:500,CaseProcName:'取消提出申请',CaseName:'合成',CaseNo:'QA'}],[],at)[0];
test('finished process alone is not case closure or official waiting; explicit case closure archives once',()=>{
 const c=make();assert.equal(c.archived,false);assert.equal(libraryStatus(c).short,'流程已结束');
 applyRemoteClosure(c,undefined);assert.equal(c.archived,false);
 applyRemoteClosure(c,{finished:false,checkedAt:at});assert.equal(c.archived,false);
 applyRemoteClosure(c,{finished:true,checkedAt:at});assert.equal(c.archived,true);
 c.archived=false;applyRemoteClosure(c,{finished:true,checkedAt:at});assert.equal(c.archived,false,'manual unarchive is not overwritten');
 assert.equal(libraryStatus(c).short,'已结案');
});
test('closure endpoint uses case identity and requires explicit finish flag',async()=>{
 let result:any={CaseInfo:{CaseId:'c',IsFinishCase:true}};
 const client=new BaselandClient('https://fixture.baselandtec.com','fixture',async(input,init)=>{assert.match(String(input),/GetUpdateCaseInfo.*caseId=c/);assert.equal(init?.method,'GET');return Response.json({IsSuccess:true,Data:result});});
 const c=make();assert.equal((await client.caseClosure(c))?.finished,true);
 result={CaseInfo:{CaseId:'c',CaseStatusType:8}};assert.equal(await client.caseClosure(c),undefined,'unverified numeric status is insufficient');
 result={CaseInfo:{CaseId:'other',IsFinishCase:true}};await assert.rejects(client.caseClosure(c),/不匹配/);
});
