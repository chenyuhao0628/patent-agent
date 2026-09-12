import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentArtifact } from './agent-artifact.ts';

test('draft correction content requires all four fields and stays distinct from application Word text',()=>{
 const content={FileName:'权利要求书',PositionInFile:'权利要求 1',CorrectionBefore:'原文',CorrectionAfter:'修改后'};
 const input={kind:'draft',strategyId:'s2',body:'本次办理说明',amendmentText:'修改摘要',applicationParts:{CLAIMS:'1. 完整权利要求。'},correctionContents:[content],amendmentBasis:'说明书第0018段',reviewNotes:'核对位置'};
 const accepted=parseAgentArtifact(JSON.stringify(input),{kind:'draft',strategyId:'s2'});
 assert(accepted.ok&&accepted.artifact.kind==='draft');assert.deepEqual(accepted.artifact.correctionContents,[content]);
 for(const key of Object.keys(content)){
  const invalid=parseAgentArtifact(JSON.stringify({...input,correctionContents:[{...content,[key]:''}]}),{kind:'draft',strategyId:'s2'});assert.equal(invalid.ok,false,key);
 }
 assert.equal(parseAgentArtifact(JSON.stringify({...input,correctionContents:[{...content,FileName:'补正说明.docx'}]}),{kind:'draft',strategyId:'s2'}).ok,false);
});

test('统一 JSON 产物接受围栏，拒绝缺段、错 kind、错策略和空正文', () => {
  const draft = parseAgentArtifact(`\`\`\`json
{"kind":"draft","strategyId":"s2","body":"尊敬的审查员：\\n陈述如下。","amendmentText":"1. 一种装置。","amendmentBasis":"说明书第0018段","reviewNotes":"需人工核对比文件页码"}
\`\`\``, { kind: 'draft', strategyId: 's2' });
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  assert.equal(draft.artifact.kind, 'draft');
  if (draft.artifact.kind === 'draft') assert.match(draft.artifact.body, /尊敬的审查员/);

  const missing = parseAgentArtifact(JSON.stringify({ kind: 'draft', strategyId: 's2', body: '正文', amendmentText: '改', amendmentBasis: '依据' }), { kind: 'draft', strategyId: 's2' });
  assert.equal(missing.ok, false);

  const emptyBody = parseAgentArtifact(JSON.stringify({ kind: 'draft', strategyId: 's2', body: '  ', amendmentText: '改', amendmentBasis: '依据', reviewNotes: '核' }), { kind: 'draft', strategyId: 's2' });
  assert.equal(emptyBody.ok, false);

  const wrongKind = parseAgentArtifact(JSON.stringify({ kind: 'discuss', reply: 'hi' }), { kind: 'draft', strategyId: 's2' });
  assert.equal(wrongKind.ok, false);

  const wrongStrategy = parseAgentArtifact(JSON.stringify({ kind: 'draft', strategyId: 's1', body: '正文够长', amendmentText: '改', amendmentBasis: '依据', reviewNotes: '核' }), { kind: 'draft', strategyId: 's2' });
  assert.equal(wrongStrategy.ok, false);
  if (!wrongStrategy.ok) assert.equal(wrongStrategy.code, 'STRATEGY_INVALID');
});

test('analysis/discuss/review 只 JSON.parse，不执行表达式，围栏未闭合则失败', () => {
  const analysis = parseAgentArtifact(JSON.stringify({
    kind: 'analysis',
    opinions: [{ id: 'o1', title: '创造性', summary: '意见1', basis: '通知.pdf' }],
    strategies: [
      { id: 's1', title: '争辩', summary: '维持', benefits: '范围大', risks: '风险', basis: '申请.docx' },
      { id: 's2', title: '修改', summary: '补特征', benefits: '稳妥', risks: '收窄', basis: '申请.docx' },
    ],
  }), { kind: 'analysis' });
  assert.equal(analysis.ok, true);

  const discuss = parseAgentArtifact('```json\n{"kind":"discuss","reply":"期限按官方日期"}\n```', { kind: 'discuss' });
  assert.equal(discuss.ok, true);

  const expr = parseAgentArtifact('{"kind":"discuss","reply": (function(){return "x"})()}', { kind: 'discuss' });
  assert.equal(expr.ok, false);

  const incomplete = parseAgentArtifact('```json\n{"kind":"discuss","reply":"未结束"', { kind: 'discuss' });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.match(incomplete.error, /围栏未结束|不能从残缺文本猜测结束/);

  const trailing = parseAgentArtifact('```json\n{"kind":"discuss","reply":"ok"}\n```\nDONE', { kind: 'discuss' });
  assert.equal(trailing.ok, false);

  const prose = parseAgentArtifact('模型已完成分析，任务成功。', { kind: 'analysis' });
  assert.equal(prose.ok, false);
});

test('仅当整段以围栏开头才拆外层；JSON 字符串内的围栏不当作产物边界', () => {
  const innerFence = parseAgentArtifact(JSON.stringify({ kind: 'discuss', reply: '示例：```json\n{"x":1}\n``` 不是外层围栏' }), { kind: 'discuss' });
  assert.equal(innerFence.ok, true);
  if (innerFence.ok && innerFence.artifact.kind === 'discuss') assert.match(innerFence.artifact.reply, /```json/);

  const prefixed = parseAgentArtifact('好的\n```json\n{"kind":"discuss","reply":"hi"}\n```', { kind: 'discuss' });
  assert.equal(prefixed.ok, false);

  const mixed = parseAgentArtifact('```json\n{"kind":"discuss","reply":"hi"}\n```\n额外说明', { kind: 'discuss' });
  assert.equal(mixed.ok, false);
});
