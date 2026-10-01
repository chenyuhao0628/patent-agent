import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentProcess } from './agent.ts';
import { replyTaskMemory, professionalTaskMemory, taskMemoryView } from './task-memory.ts';
import type { ProfessionalRecord } from '../professional-api.ts';
function fixture(){const result=createAgentProcess({caseId:'case-a',processKey:'round-a',classification:{status:'unknown'},materials:[]});if(!result.ok)throw Error(result.error);return result.state;}
test('memory retains user originals and distinguishes questions, unchosen suggestions and confirmed state',()=>{
 const state=fixture(),main=state.discussions[0];
 main.messages=[{id:'u1',role:'user',text:'只能修改权利要求3',at:'a'},{id:'a1',role:'assistant',text:'我建议选择新策略',at:'b'},{id:'u2',role:'user',text:'可以考虑改选吗？',at:'c'}];
 const memory=replyTaskMemory(state,main.id,'discuss');
 assert.deepEqual(memory.entries.filter(e=>e.kind==='user-statement').map(e=>e.text),['只能修改权利要求3','可以考虑改选吗？']);
 assert(!memory.entries.some(e=>e.kind==='confirmed'));assert(!JSON.stringify(memory).includes('我建议选择新策略'));assert(memory.entries.some(e=>e.kind==='pending'));
 assert.equal(memory.caseId,'case-a');assert.equal(memory.processKey,'round-a');
 const view=taskMemoryView(memory);assert.equal(view.entries.find(e=>e.id==='u1')?.source,'用户消息 u1 / a');
});
test('active branches and independent review never inherit hidden or main-discussion instructions',()=>{
 const state=fixture(),main=state.discussions[0];main.activeBranchId='active';main.messages=[{id:'active-u',role:'user',text:'当前分支要求',at:'a'}];main.branches=[{id:'old',title:'old',messages:[{id:'old-u',role:'user',text:'废弃分支要求',at:'a'}],toolEvents:[],runIds:[]}];
 state.discussions.push({id:'review',kind:'review',title:'review',messages:[],toolEvents:[],boundDraftVersionId:'draft-v2'});
 state.activeRunId='review-run';state.jobs.push({runId:'review-run',discussionId:'review',action:'review',state:'running',startedAt:'a',boundDraftVersionId:'draft-v2'});
 const active=replyTaskMemory(state,main.id,'discuss');assert.equal(active.branchId,'active');assert(!JSON.stringify(active).includes('废弃分支'));
 const review=replyTaskMemory(state,'review','review');assert(!JSON.stringify(review).includes('当前分支'));assert.deepEqual(review.entries.map(e=>e.kind),['version']);assert.match(review.entries[0].text,/draft-v2/);
});
test('writing remembers prior confirmed-stage input while review only receives frozen version',()=>{
 const record:ProfessionalRecord={caseId:'c',processKey:'p',phase:1,confirmations:[{phase:0,jobId:'j0',decision:'选方向二',at:'a'}],sources:[],completed:false,jobs:[{id:'j0',caseId:'c',processKey:'p',phase:0,kind:'writing',state:'completed',at:'a',tools:[],skillName:'draft',skillHash:'h',input:'交底中的温度上限为40℃'}]};
 record.jobs.unshift({...record.jobs[0],id:'early-j0',input:'不得添加未验证的实验结果'});
 record.jobs.push({...record.jobs[1],id:'abandoned-later',phase:3,input:'未确认后续阶段要求'});
 const memory=professionalTaskMemory(record,{runId:'j1',kind:'writing',message:'构思下一步'});assert(memory.entries.some(e=>e.text==='交底中的温度上限为40℃'));assert(memory.entries.some(e=>e.kind==='confirmed'&&e.text.includes('选方向二')));
 assert(memory.entries.some(e=>e.id==='early-j0'&&e.text==='不得添加未验证的实验结果'&&e.kind==='user-statement'));
 assert(!memory.entries.some(e=>e.id==='abandoned-later'));
 const review=professionalTaskMemory(record,{runId:'r',kind:'review',message:'',source:{id:'v1',caseId:'c',processKey:'p',title:'稿件v1',business:'申请',text:'冻结正文',at:'a',files:[]}});assert.equal(review.entries.length,1);assert.equal(review.entries[0].kind,'version');assert(!JSON.stringify(review).includes('温度'));
});
