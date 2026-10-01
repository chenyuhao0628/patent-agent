import test from 'node:test';
import assert from 'node:assert/strict';
import {taskProgress,RepairProgressTracker} from './task-progress.ts';
const quality={schema:1 as const,materials:[],citations:[],issues:[]};
const contract={kind:'draft' as const,strategyId:'s'};
test('business progress distinguishes saved body, remaining basis and warnings from acceptance',()=>{
 const p=taskProgress({kind:'draft',strategyId:'s',body:'正文'},contract,{...quality,issues:[{code:'warn',severity:'warning',message:'人工核对'}]});
 assert(p.saved.some(i=>i.id==='body'));assert(p.pending.some(i=>i.id==='amendmentBasis'));assert.equal(p.accepted,false);assert.equal(p.warnings,1);
});
test('prose churn, removed-and-restored fields, repeated reads and warnings do not reset repair stagnation',()=>{
 const tracker=new RepairProgressTracker(),p=(body:string,basis?:string)=>taskProgress({kind:'draft',body,amendmentBasis:basis},contract,quality);
 assert.equal(tracker.observe(p('甲')),0);assert.equal(tracker.observe(p('乙')),1);assert.equal(tracker.observe(p('丙')),2);
 assert.equal(tracker.observe(p('丙','依据')),0);assert.equal(tracker.observe(p('丙')),1);assert.equal(tracker.observe(p('丙','依据')),2);
});
test('completing genuine subtasks and required ranges permits longer useful repair',()=>{
 const tracker=new RepairProgressTracker();
 for(const [index,key] of ['body','amendmentText','amendmentBasis','reviewNotes'].entries()){
  assert.equal(tracker.observe({metrics:{completed:['kind',key],errors:5-index,requiredReadUnits:0}}),0);
 }
 assert.equal(tracker.observe({metrics:{completed:['kind','reviewNotes'],errors:2,requiredReadUnits:10}}),0);
 assert.equal(tracker.observe({metrics:{completed:['kind','reviewNotes'],errors:2,requiredReadUnits:10}}),1);
});
test('professional writing tracks document parts and review does not require writing parts',()=>{
 const writing=taskProgress({kind:'writing',text:'说明',documents:{ABSTRACT:'摘要'}},{kind:'writing',professional:true,phase:4},quality);
 assert(writing.saved.some(s=>s.id==='documents.ABSTRACT'));assert(writing.pending.some(s=>s.id==='documents.CLAIMS'));
 const review=taskProgress({kind:'review',text:'审查报告'},{kind:'review',professional:true},quality,true);
 assert.equal(review.pending.length,0);assert.equal(review.accepted,true);
});
