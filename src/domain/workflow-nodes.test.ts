import test from 'node:test';
import assert from 'node:assert/strict';
import type { Case, RemoteProcess } from './workflow.ts';
import { workflowNodes } from './workflow-nodes.ts';
function fixture(over: Partial<RemoteProcess> = {}): Case {
 const p = { id:'p',name:'第一次审查意见答复',status:0,node:'',undertaker:'',deadline:'',...over };
 return {id:'c',title:'合成案件',number:'TEST',type:'发明',deadline:'',archived:false,tags:[],rounds:[],source:'baseland',current:{kind:'reply',processId:'p'},remote:{caseId:'r',syncedAt:'',processes:[p]}};
}
test('pending case shows whole chain with only pending intake current',()=>{
 const n=workflowNodes(fixture());assert.equal(n[0].state,'current');assert.equal(n.filter(x=>x.state==='current').length,1);assert.equal(n.at(-1)?.label,'已完成');
});
test('own work and downstream official submission are distinct',()=>{
 const own=workflowNodes(fixture({status:400,handId:'h',canEdit:true,currentFlow:{name:'开始',user:'本人',serial:1,total:2}}));
 assert.equal(own.find(x=>x.label==='打开案件')?.state,'current');
 const next=workflowNodes(fixture({status:400,handId:'h',canEdit:false,currentFlow:{name:'递交官方',user:'杨佳',serial:2,total:2}}));
 assert.equal(next.find(x=>x.label==='提交官方')?.state,'current');assert.equal(next.find(x=>x.label==='确认材料')?.state,'unknown');
});
test('completed preserves complete chain and unknown history without new pending work',()=>{
 // Official completion requires send/hand evidence, not personalStatus alone.
 const n=workflowNodes(fixture({status:500,submission:{state:'sent',source:'hand',checkedAt:'2026-09-12T00:00:00.000Z'}}));
 assert(n.length>10);assert.equal(n.filter(x=>x.state==='pending'||x.state==='current').length,0);assert.equal(n.find(x=>x.label==='提交官方')?.state,'done');assert(n.every(x=>x.state==='done'));assert.equal(n.find(x=>x.label==='选定策略')?.closedBySubmission,true);assert.equal(n.find(x=>x.label==='选定策略')?.at,undefined);
});
test('personalStatus 500 alone does not mark official submission done',()=>{
 const n=workflowNodes(fixture({status:500,personalStatus:500,submission:{state:'draft',source:'hand',checkedAt:'2026-09-12T00:00:00.000Z'}}));
 assert.notEqual(n.find(x=>x.label==='提交官方')?.state,'done');
 assert.notEqual(n.find(x=>x.label==='已完成')?.state,'done');
});
test('known local evidence survives official completion; writing uses its own phases',()=>{
 const c=fixture({status:500,personalStatus:500});
 const n=workflowNodes(c,{caseId:'c',processKey:'p',running:false,steps:[{label:'选定策略',done:true,at:'2026-09-14'}]});
 assert.equal(n.find(x=>x.label==='选定策略')?.state,'done');
 const w=workflowNodes(fixture({name:'提出申请',status:500,personalStatus:500}));assert(w.some(x=>x.label==='确认说明书'));assert(!w.some(x=>x.label==='意见分析'));
});

test('new current process does not inherit official completion from an older process',()=>{const c=fixture();c.remote!.processes.push({...c.remote!.processes[0],id:'old',status:500,personalStatus:500});const n=workflowNodes(c);assert.equal(n[0].state,'current');assert.equal(n.at(-1)?.state,'pending');});
