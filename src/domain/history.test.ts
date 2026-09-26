import test from 'node:test';
import assert from 'node:assert/strict';
import { agentHistoryRecords, professionalHistoryRecords, selectHistoryRecords } from './history.ts';
import type { ProfessionalJob, ReviewSource } from '../professional-api.ts';
import type { HistoryTarget } from './lifecycle.ts';
import { createAgentProcess, type AgentProcessState } from './agent.ts';

function sample(): AgentProcessState {
  const result = createAgentProcess({ caseId: 'case-1', processKey: 'process-1' });
  if (!result.ok) throw new Error(result.error);
  const state = result.state;
  state.discussions[0].messages.push(
    { id: 'm-user', role: 'user', text: '请核对本轮意见。', at: '2026-09-26T01:00:00.000Z' },
    { id: 'm-assistant', role: 'assistant', text: '已记录，等待继续。', at: '2026-09-26T01:01:00.000Z', incomplete: true },
  );
  state.jobs.push({ runId: 'run-1', discussionId: state.mainDiscussionId, action: 'analysis', state: 'failed', startedAt: '2026-09-26T01:02:00.000Z', userMessage: '分析意见', error: '材料读取失败' });
  state.drafts.push({ id: 'draft-1', source: 'generated-initial', text: '待采用稿', applicationParts: { CLAIMS: '1. 一种装置。' }, amendmentText: '', amendmentBasis: '', reviewNotes: '', at: '2026-09-26T01:03:00.000Z', adoptStatus: 'pending' });
  state.analysis = { runId: 'analysis-1', opinions: [{ id: 'op-1', title: '问题', summary: '需要核对', basis: '第1页' }], strategies: [], at: '2026-09-26T01:04:00.000Z', materialFingerprint: 'fp', classificationKey: 'key' };
  return state;
}

test('agent history keeps conversations, unfinished tasks, analysis and unadopted drafts', () => {
  const records = agentHistoryRecords(sample());
  assert.ok(records.some(record => record.id.endsWith('-message-m-user')));
  assert.ok(records.some(record => record.detail.includes('未完成输出')));
  assert.ok(records.some(record => record.id.endsWith('-job-run-1') && record.detail.includes('失败')));
  assert.ok(records.some(record => record.id.endsWith('-analysis-analysis-1') && record.text.includes('问题')));
  assert.ok(records.some(record => record.id.endsWith('-draft-draft-1') && record.title.includes('待采用')));
});

test('history matching intersects exact targets and never substitutes a current or similarly named record',()=>{
  const a=sample(),b=structuredClone(a);
  b.scope.processKey='process-2';
  const records=[...agentHistoryRecords(a),...agentHistoryRecords(b)];
  const target:HistoryTarget={tab:'history',processId:'process-1',runId:'run-1'};
  const selected=selectHistoryRecords(records,target);
  assert.equal(selected.length,1);
  assert.match(selected[0].id,/process-1/);
  assert.equal(selectHistoryRecords(records,{...target,processId:'missing'}).length,0);
  assert.equal(selectHistoryRecords(records,{...target,historyId:'draft-1'}).length,0);
  assert.equal(selectHistoryRecords(records,{tab:'history',processId:'process-2',historyId:'draft-1'})[0].text.includes('待采用稿'),true);
});

test('professional history exposes exact process and source for multiple attempts and excludes foreign cases',()=>{
  const job:ProfessionalJob={id:'job',caseId:'case-1',processKey:'p1',sourceId:'source',kind:'review',state:'completed',at:'2026-09-26',text:'Report',tools:[],skillName:'review',skillHash:''};
  const records=professionalHistoryRecords({profileKey:'local',caseId:'case-1',sources:[],jobs:[job,{...job,processKey:'p2'},{...job,caseId:'other',id:'foreign'}]});
  assert.equal(records.length,2);
  const selected=selectHistoryRecords(records,{tab:'review',processId:'p2',sourceId:'source',runId:'job'});
  assert.equal(selected.length,1);
  assert.match(selected[0].id,/p2/);
});

test('professional history rejects misplaced nested reports and prefers the canonical task',()=>{
  const job:ProfessionalJob={id:'job',caseId:'case-1',processKey:'p1',sourceId:'source',kind:'review',state:'completed',at:'2026-09-26',text:'Current report',tools:[],skillName:'review',skillHash:''};
  const source:ReviewSource={id:'source',caseId:'case-1',processKey:'p1',title:'Draft',business:'申请',at:'2026-09-26',text:'Input',files:[],reports:[
    {...job,text:'Older snapshot'},
    {...job,id:'wrong-process',processKey:'p2'},
    {...job,id:'wrong-source',sourceId:'another-source'},
    {...job,id:'wrong-kind',kind:'writing'},
    {...job,id:'wrong-case',caseId:'another-case'},
  ]};
  const records=professionalHistoryRecords({profileKey:'local',caseId:'case-1',sources:[
    source,{...source,caseId:'another-case',reports:[{...job,id:'foreign-container'}]},
  ],jobs:[job]});
  assert.equal(records.length,2);
  const [report]=selectHistoryRecords(records,{tab:'review',processId:'p1',sourceId:'source',runId:'job'});
  assert.equal(report.text,'Current report');
  assert.equal(records.some(record=>record.id.includes('wrong-')||record.id.includes('foreign-container')),false);
});

test('reply review sources alone resolve queue report targets and retain the complete input version',()=>{
  const source:ReviewSource={
    id:'agent-draft',caseId:'case-1',processKey:'p1',title:'Adopted reply',business:'答复',
    at:'2026-09-26',text:'Reply body',files:[],applicationParts:{CLAIMS:'Amended claims'},
    amendmentBasis:'Original paragraph 12',
    reports:[{id:'reply-review-1',caseId:'case-1',processKey:'p1',sourceId:'agent-draft',
      kind:'review',state:'completed',at:'2026-09-26',text:'Exact reply review',
      tools:[],skillName:'review',skillHash:''}],
  };
  const records=professionalHistoryRecords({profileKey:'local',caseId:'case-1',sources:[source],jobs:[]});
  const [report]=selectHistoryRecords(records,{processId:'p1',sourceId:source.id,runId:'reply-review-1'});
  assert.equal(report?.text,'Exact reply review');
  const [input]=selectHistoryRecords(records,{historyId:'source-p1-agent-draft'});
  assert.match(input.text,/Amended claims/);
  assert.match(input.text,/Original paragraph 12/);
  assert.equal(selectHistoryRecords(records,{processId:'p2',sourceId:source.id,runId:'reply-review-1'}).length,0);
});

test('professional history carries case and process bound file references for sources and reports',()=>{
  const job:ProfessionalJob={id:'job',caseId:'case-1',processKey:'old-process',sourceId:'source',kind:'review',state:'completed',at:'2026-09-26',text:'Report',tools:[],skillName:'review',skillHash:'',artifactPath:'reports/review.md'};
  const source:ReviewSource={id:'source',caseId:'case-1',processKey:'old-process',title:'Prior draft',business:'申请',at:'2026-09-26',text:'',files:[{name:'draft.docx',relativePath:'drafts/draft.docx',role:'当前完成稿'}]};
  const records=professionalHistoryRecords({profileKey:'local',caseId:'case-1',sources:[source,{...source,caseId:'foreign'}],jobs:[job,{...job,id:'foreign',caseId:'foreign'}]});
  assert.equal(records.length,2);
  assert.deepEqual(records.flatMap(r=>r.files),[
    {kind:'professional',caseId:'case-1',processId:'old-process',name:'draft.docx',relativePath:'drafts/draft.docx'},
    {kind:'professional',caseId:'case-1',processId:'old-process',name:'review.md',relativePath:'reports/review.md'},
  ]);
  assert.equal(selectHistoryRecords(records,{processId:'later-process'}).length,0);
});

test('agent history namespaces records by process and keeps structured evidence', () => {
  const first = sample();
  const second = structuredClone(first);
  second.scope = { caseId: 'case-1', processKey: 'process-2' };
  const firstRecords = agentHistoryRecords(first);
  const secondRecords = agentHistoryRecords(second);
  assert.notEqual(firstRecords[0].id, secondRecords[0].id);
  assert.ok(firstRecords.some(record => record.text.includes('申请文件部分')));
  assert.equal(new Set(firstRecords.map(record => record.id)).size, firstRecords.length);
});
