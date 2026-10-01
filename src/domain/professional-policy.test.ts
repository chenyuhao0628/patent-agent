import test from 'node:test';
import assert from 'node:assert/strict';
import { canChooseWritingStart, currentWritingJobs } from './professional-policy.ts';
import type { ProfessionalJob, ProfessionalRecord } from '../professional-api.ts';

const job=(id:string,contextHash?:string):ProfessionalJob=>({id,caseId:'case',processKey:'process',kind:'writing',phase:2,state:'completed',at:'2026-09-30',tools:[],skillName:'draft',skillHash:'',...(contextHash?{recovery:{files:[],contextHash}}:{})});
const record=(jobs:ProfessionalJob[],revision?:string):ProfessionalRecord=>({caseId:'case',processKey:'process',phase:2,confirmations:[],jobs,sources:[],completed:false,revision});

test('writing selection keeps compatible legacy work but rejects previous contexts after a return',()=>{
 const r=record([job('legacy'),job('old','previous'),job('current','current'),{...job('foreign','current'),caseId:'other'}]);
 assert.deepEqual(currentWritingJobs(r).map(j=>j.id),['legacy','old','current']);
 r.revision='changed';assert.deepEqual(currentWritingJobs(r,'current').map(j=>j.id),['current']);
 assert.deepEqual(currentWritingJobs(r).map(j=>j.id),[]);
});

test('starting-point selection is available only before current results or confirmations',()=>{
 const r=record([job('history','previous')],'changed');
 assert.equal(canChooseWritingStart(r,'current'),true);
 r.jobs.push(job('current','current'));assert.equal(canChooseWritingStart(r,'current'),false);
 r.jobs=[];r.confirmations=[{jobId:'saved',phase:0,decision:'确认',at:'2026-09-30'}];assert.equal(canChooseWritingStart(r,'current'),false);
});
