import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest, atomicWrite } from './files.ts';
import {
  MCP_BODY_MAX_BYTES,
  PREFERRED_ARTIFACT,
  TOOL_READ_DRAFT,
  TOOL_READ_MATERIAL,
  TOOL_WRITE_ARTIFACT,
  pickPreferredArtifact,
  randomRunToken,
  startAgentBroker,
  type FrozenMaterial,
  type ToolEvent,
} from './agent-broker.ts';

async function tmpDir(label: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `agent-broker-${label}-`));
}

async function writeMaterial(root: string, name: string, text: string, id?: string): Promise<FrozenMaterial> {
  const relativePath = name;
  const absoluteSnapshotPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absoluteSnapshotPath), { recursive: true });
  const buffer = Buffer.from(text, 'utf8');
  await fs.writeFile(absoluteSnapshotPath, buffer);
  return {
    id: id || `mat-${digest(name + text).slice(0, 8)}`,
    name,
    role: 'evidence',
    relativePath,
    absoluteSnapshotPath,
    hash: digest(buffer),
  };
}

async function rpc(url: string, token: string, method: string, params?: unknown, extra: RequestInit = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const response = await fetch(url, {
    method: extra.method || 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(extra.headers as Record<string, string> || {}),
    },
    body: extra.method === 'GET' ? undefined : body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: response.status, headers: response.headers, parsed, text };
}

async function callTool(url: string, token: string, name: string, args: Record<string, unknown>) {
  return rpc(url, token, 'tools/call', { name, arguments: args });
}

test('two MCP tokens cannot read each other materials, and tool records include id/name/range/status', async () => {
  const root = await tmpDir('iso');
  const snapA = path.join(root, 'a', 'snap');
  const snapB = path.join(root, 'b', 'snap');
  const outA = path.join(root, 'a', 'out');
  const outB = path.join(root, 'b', 'out');
  const matA = await writeMaterial(snapA, '意见.txt', '甲案件标识 ALPHA\n事实 11\n', 'mat-a');
  const matB = await writeMaterial(snapB, '意见.txt', '乙案件标识 BETA\n事实 22\n', 'mat-b');
  const eventsA: ToolEvent[] = [];
  const eventsB: ToolEvent[] = [];
  const tokenA = randomRunToken();
  const tokenB = randomRunToken();
  const brokerA = await startAgentBroker({ token: tokenA, snapshotRoot: snapA, outputsRoot: outA, materials: [matA], onToolEvent: e => eventsA.push(e) });
  const brokerB = await startAgentBroker({ token: tokenB, snapshotRoot: snapB, outputsRoot: outB, materials: [matB], onToolEvent: e => eventsB.push(e) });
  try {
    const okA = await callTool(brokerA.url, tokenA, TOOL_READ_MATERIAL, { materialId: matA.id, startLine: 1, endLine: 1 });
    assert.equal(okA.status, 200);
    const bodyA = JSON.stringify(okA.parsed);
    assert.match(bodyA, /ALPHA/);
    assert.doesNotMatch(bodyA, /BETA/);
    const cross = await callTool(brokerA.url, tokenA, TOOL_READ_MATERIAL, { materialId: matB.id });
    assert.match(JSON.stringify(cross.parsed), /不在本次运行清单/);
    const otherToken = await fetch(brokerA.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_READ_MATERIAL, arguments: { materialId: matA.id } } }),
    });
    assert.equal(otherToken.status, 401);
    assert.equal(eventsA[0]?.name, TOOL_READ_MATERIAL);
    assert.equal(eventsA[0]?.materialId, matA.id);
    assert.equal(eventsA[0]?.materialName, '意见.txt');
    assert.equal(eventsA[0]?.status, 'success');
    assert.equal(eventsA[0]?.success, true);
    assert.equal(eventsA[0]?.range?.startLine, 1);
    assert.equal(eventsA.find(e => e.error === 'unknown_material')?.status, 'error');
    assert.equal(eventsB.length, 0);
  } finally {
    await brokerA.close();
    await brokerB.close();
  }
});

test('symlink, traversal and hash mismatch are rejected; raw snapshot hash is unchanged', async () => {
  const root = await tmpDir('fs');
  const snap = path.join(root, 'snap');
  const out = path.join(root, 'out');
  const mat = await writeMaterial(snap, '材料.txt', '原文 HASHME\n');
  const original = await fs.readFile(mat.absoluteSnapshotPath);
  const outside = path.join(root, 'outside.txt');
  await fs.writeFile(outside, 'SECRET');
  const link = path.join(snap, 'link.txt');
  await fs.symlink(outside, link);
  const linked: FrozenMaterial = { ...mat, id: 'link', name: 'link.txt', absoluteSnapshotPath: link, relativePath: 'link.txt' };
  const trav: FrozenMaterial = { ...mat, id: 'trav', name: 'trav', absoluteSnapshotPath: path.join(snap, '..', 'outside.txt'), relativePath: '../outside.txt' };
  const events: ToolEvent[] = [];
  const token = randomRunToken();
  const broker = await startAgentBroker({
    token,
    snapshotRoot: snap,
    outputsRoot: out,
    materials: [mat, linked, trav],
    onToolEvent: e => events.push(e),
  });
  try {
    const badLink = await callTool(broker.url, token, TOOL_READ_MATERIAL, { materialId: 'link' });
    assert.match(JSON.stringify(badLink.parsed), /符号链接|失败|不在/);
    const badTrav = await callTool(broker.url, token, TOOL_READ_MATERIAL, { materialId: 'trav' });
    assert.match(JSON.stringify(badTrav.parsed), /范围|符号|失败|不属于/);
    await fs.writeFile(mat.absoluteSnapshotPath, Buffer.concat([original, Buffer.from('tamper')]));
    const mismatch = await callTool(broker.url, token, TOOL_READ_MATERIAL, { materialId: mat.id });
    assert.match(JSON.stringify(mismatch.parsed), /哈希|失败/);
    await fs.writeFile(mat.absoluteSnapshotPath, original);
    const ok = await callTool(broker.url, token, TOOL_READ_MATERIAL, { materialId: mat.id });
    assert.match(JSON.stringify(ok.parsed), /HASHME/);
    assert.equal(digest(await fs.readFile(mat.absoluteSnapshotPath)), mat.hash);
    assert.ok(events.some(e => e.status === 'error'));
  } finally {
    await broker.close();
  }
});

test('binary and unknown encoding are unsupported, not treated as read', async () => {
  const root = await tmpDir('bin');
  const snap = path.join(root, 'snap');
  const out = path.join(root, 'out');
  const absoluteSnapshotPath = path.join(snap, 'x.bin');
  await fs.mkdir(snap, { recursive: true });
  const buffer = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x00, 0x10]);
  await fs.writeFile(absoluteSnapshotPath, buffer);
  const material: FrozenMaterial = {
    id: 'bin1', name: 'x.bin', role: 'file', relativePath: 'x.bin', absoluteSnapshotPath, hash: digest(buffer),
  };
  const token = randomRunToken();
  const events: ToolEvent[] = [];
  const broker = await startAgentBroker({ token, snapshotRoot: snap, outputsRoot: out, materials: [material], onToolEvent: e => events.push(e) });
  try {
    const res = await callTool(broker.url, token, TOOL_READ_MATERIAL, { materialId: 'bin1' });
    const text = JSON.stringify(res.parsed);
    assert.match(text, /二进制|未知编码|未读取/);
    assert.equal(events[0]?.status, 'error');
    assert.equal(events[0]?.error, 'unsupported_encoding');
  } finally {
    await broker.close();
  }
});

test('write_artifact only allows scheduled names, prefers result.json, rejects traversal/symlink, and closes access', async () => {
  const root = await tmpDir('write');
  const snap = path.join(root, 'snap');
  const out = path.join(root, 'out');
  await fs.mkdir(snap, { recursive: true });
  await fs.mkdir(out, { recursive: true });
  const token = randomRunToken();
  const events: ToolEvent[] = [];
  const broker = await startAgentBroker({ token, snapshotRoot: snap, outputsRoot: out, materials: [], onToolEvent: e => events.push(e) });
  try {
    const bad = await callTool(broker.url, token, TOOL_WRITE_ARTIFACT, { name: '../x.json', content: '{}' });
    assert.match(JSON.stringify(bad.parsed), /预定|缺少/);
    const also = await callTool(broker.url, token, TOOL_WRITE_ARTIFACT, { name: 'secret.key', content: 'x' });
    assert.match(JSON.stringify(also.parsed), /预定/);
    const payload = JSON.stringify({ ident: 'ALPHA', fact: 9 });
    const ok = await callTool(broker.url, token, TOOL_WRITE_ARTIFACT, { name: PREFERRED_ARTIFACT, content: payload });
    assert.equal(ok.status, 200);
    const written = broker.artifacts();
    assert.equal(written[0]?.name, PREFERRED_ARTIFACT);
    assert.equal(await fs.readFile(written[0].absolutePath, 'utf8'), payload);
    assert.equal(pickPreferredArtifact(written)?.name, PREFERRED_ARTIFACT);
    assert.equal(events.at(-1)?.artifactName, PREFERRED_ARTIFACT);
    assert.equal(events.at(-1)?.status, 'success');
    const link = path.join(out, 'result.json');
    await fs.rm(link);
    await fs.symlink(path.join(root, 'nope'), link);
    const viaLink = await callTool(broker.url, token, TOOL_WRITE_ARTIFACT, { name: PREFERRED_ARTIFACT, content: '{}' });
    assert.match(JSON.stringify(viaLink.parsed), /失败|符号/);
    await broker.close();
    const after = await fetch(`http://127.0.0.1:${broker.port}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_WRITE_ARTIFACT, arguments: { name: PREFERRED_ARTIFACT, content: 'late' } } }),
    }).catch((error: { code?: string }) => ({ status: 0, ok: false, code: error.code }));
    assert.ok(!('ok' in after && after.ok) || after.status === 503 || after.status === 500 || after.status === 0);
  } finally {
    await broker.close().catch(() => undefined);
  }
});

test('MCP HTTP rejects anonymous, GET, oversize body and foreign origin; initialize sets session header', async () => {
  const root = await tmpDir('http');
  const token = randomRunToken();
  const broker = await startAgentBroker({
    token,
    snapshotRoot: path.join(root, 'snap'),
    outputsRoot: path.join(root, 'out'),
    materials: [],
  });
  try {
    const anon = await fetch(broker.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(anon.status, 401);
    const get = await fetch(broker.url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(get.status, 405);
    const origin = await fetch(broker.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    assert.equal(origin.status, 403);
    const init = await rpc(broker.url, token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.status, 200);
    assert.ok(init.headers.get('mcp-session-id'));
    const huge = 'x'.repeat(MCP_BODY_MAX_BYTES + 20);
    const big = await fetch(broker.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { huge } }),
    });
    assert.equal(big.status, 413);
    const draft = await callTool(broker.url, token, TOOL_READ_DRAFT, {});
    assert.match(JSON.stringify(draft.parsed), /没有冻结稿件/);
  } finally {
    await broker.close();
  }
});

test('read_draft uses frozen text only and custom readMaterial can return image content', async () => {
  const root = await tmpDir('draft');
  const snap = path.join(root, 'snap');
  const mat = await writeMaterial(snap, '图.txt', 'placeholder');
  const token = randomRunToken();
  const broker = await startAgentBroker({
    token,
    snapshotRoot: snap,
    outputsRoot: path.join(root, 'out'),
    materials: [mat],
    draftText: '冻结稿件正文 LINE2',
    readMaterial: async () => [{ type: 'image', data: Buffer.from('img').toString('base64'), mimeType: 'image/png' }],
  });
  try {
    const draft = await callTool(broker.url, token, TOOL_READ_DRAFT, { startLine: 1, endLine: 1 });
    assert.match(JSON.stringify(draft.parsed), /冻结稿件正文/);
    const img = await callTool(broker.url, token, TOOL_READ_MATERIAL, { materialId: mat.id });
    const content = (img.parsed as { result?: { content?: { type: string }[] } }).result?.content;
    assert.equal(content?.[0]?.type, 'image');
  } finally {
    await broker.close();
  }
});

test('default read records actual startLine/endLine and does not expose absolute paths', async () => {
  const root = await tmpDir('range');
  const snap = path.join(root, 'snap');
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n');
  const mat = await writeMaterial(snap, '多行.txt', lines, 'mat-range');
  const events: ToolEvent[] = [];
  const token = randomRunToken();
  const broker = await startAgentBroker({
    token, snapshotRoot: snap, outputsRoot: path.join(root, 'out'), materials: [mat],
    onToolEvent: e => events.push(e),
  });
  try {
    const res = await callTool(broker.url, token, TOOL_READ_MATERIAL, { materialId: 'mat-range' });
    const packed = JSON.stringify(res.parsed);
    assert.doesNotMatch(packed, new RegExp(root.replace(/[/\\]/g, '[/\\\\]')));
    assert.equal(events[0]?.range?.startLine, 1);
    assert.ok((events[0]?.range?.endLine ?? 0) >= 1);
    assert.match(packed, /truncated=/);
  } finally {
    await broker.close();
  }
});

test('readMaterial callback after close is rejected and does not emit late success', async () => {
  const root = await tmpDir('race');
  const snap = path.join(root, 'snap');
  const mat = await writeMaterial(snap, 'x.txt', 'hello', 'mat-race');
  let resume: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const events: ToolEvent[] = [];
  const token = randomRunToken();
  const broker = await startAgentBroker({
    token, snapshotRoot: snap, outputsRoot: path.join(root, 'out'), materials: [mat],
    onToolEvent: e => events.push(e),
    readMaterial: async () => {
      await gate;
      return [{ type: 'text', text: 'late-body', startLine: 1, endLine: 1 }];
    },
  });
  const pending = callTool(broker.url, token, TOOL_READ_MATERIAL, { materialId: 'mat-race' });
  await new Promise(r => setTimeout(r, 30));
  await broker.close();
  resume();
  const res = await pending.catch((error: Error) => ({ status: 0, parsed: { error: error.message } }));
  assert.ok(!events.some(e => e.success));
  assert.ok(events.some(e => e.error === 'run_closed') || res.status === 0 || JSON.stringify(res.parsed).includes('结束'));
});

test('write_artifact started before close is rejected after await and does not keep the file', async () => {
  const root = await tmpDir('write-race');
  const snap = path.join(root, 'snap');
  const out = path.join(root, 'out');
  const mat = await writeMaterial(snap, 'x.txt', 'hello', 'mat-w');
  const events: ToolEvent[] = [];
  const token = randomRunToken();
  const broker = await startAgentBroker({
    token, snapshotRoot: snap, outputsRoot: out, materials: [mat],
    onToolEvent: e => events.push(e),
  });
  await broker.close();
  const res = await callTool(broker.url, token, TOOL_WRITE_ARTIFACT, {
    name: PREFERRED_ARTIFACT,
    content: '{"kind":"discuss","reply":"late"}',
  }).catch((error: Error) => ({ status: 0, parsed: { error: error.message } }));
  assert.ok(res.status === 0 || res.status >= 400);
  assert.ok(!events.some(e => e.name === TOOL_WRITE_ARTIFACT && e.success));
  const written: string[] = await fs.readdir(out).catch(() => [] as string[]);
  assert.equal(written.includes(PREFERRED_ARTIFACT), false);
});

test('standard skill resources are immutable allowlisted run inputs, not filesystem access',async t=>{
 const root=await tmpDir('skills'),token=randomRunToken();t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const events:ToolEvent[]=[];
 const broker=await startAgentBroker({token,snapshotRoot:path.join(root,'snapshot'),outputsRoot:path.join(root,'output'),materials:[],skillResources:[{path:'review/SKILL.md',text:'标准审查规则\n第二行'},{path:'review/references/source.md',text:'来源与程序阶段'}],onToolEvent:e=>events.push(e)});t.after(()=>broker.close());
 const list=await rpc(broker.url,token,'tools/list');assert.match(list.text,/read_skill/);
 const read=await callTool(broker.url,token,'read_skill',{path:'review/references/source.md'});assert.match(read.text,/来源与程序阶段/);assert.equal(events.at(-1)?.status,'success');
 const denied=await callTool(broker.url,token,'read_skill',{path:'../../session.json'});assert.match(denied.text,/不在|不属于|未授权/);assert.doesNotMatch(denied.text,/encrypted/);
});

test('artifact validation feeds errors back, preserves prior bytes, and accepts corrected structured content',async()=>{
 const root=await tmpDir('repair');const token=randomRunToken();const out=path.join(root,'out');
 const broker=await startAgentBroker({token,snapshotRoot:path.join(root,'snap'),outputsRoot:out,materials:[],allowedArtifacts:['result.json'],artifactExpect:{kind:'draft',strategyId:'s2'}});
 const draft={kind:'draft',strategyId:'s2',body:'正文含"引用"\n第二段',amendmentText:'建议',amendmentBasis:'说明书0018段',reviewNotes:'待核对'};
 const save=async(content:unknown)=>(await callTool(broker.url,token,TOOL_WRITE_ARTIFACT,{name:'result.json',content})).parsed as {result:{isError?:boolean;content:Array<{text:string}>}};
 try{
 const syntax=await save('{"kind":"draft",');assert(syntax.result.isError);assert.match(syntax.result.content[0].text,/JSON 语法错误/);assert.equal(broker.artifacts().length,0);
 const missing=await save({...draft,body:''});assert(missing.result.isError);assert.match(missing.result.content[0].text,/正文/);
 const wrong=await save({...draft,strategyId:'s1'});assert(wrong.result.isError);assert.match(wrong.result.content[0].text,/策略/);
 const good=await save(draft);assert(!good.result.isError);assert.equal(broker.artifacts().length,1);assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'result.json'),'utf8')),draft);
 const rejected=await save('{broken');assert(rejected.result.isError);assert.equal(broker.artifacts().length,0);assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'result.json'),'utf8')),draft);assert.equal(JSON.parse(await fs.readFile(path.join(out,'result.json.rejected.json'),'utf8')).content,'{broken');
 assert(!(await save({...draft,body:'修正正文'})).result.isError);assert.equal(broker.artifacts().length,1);
 }finally{await broker.close();await fs.rm(root,{recursive:true,force:true});}
});

test('incremental artifact saves survive restart, isolate inputs, and require completion feedback',async t=>{
 const root=await tmpDir('checkpoint');t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const token=randomRunToken(), out=path.join(root,'out'), snap=path.join(root,'snap');
 const mat=await writeMaterial(snap,'notice.txt','notice','n1');let read=false;
 const options={token,snapshotRoot:snap,outputsRoot:out,materials:[mat],artifactExpect:{kind:'draft' as const,strategyId:'s2'},validateArtifact:async()=>read?undefined:'请读取 notice.txt',onToolEvent:(e:ToolEvent)=>{if(e.name==='read_material'&&e.success)read=true;}};
 let broker=await startAgentBroker(options);t.after(()=>broker.close());
 const save=(content:unknown)=>callTool(broker.url,token,TOOL_WRITE_ARTIFACT,{name:'result.json',mode:'merge',content});
 const partial=await save({kind:'draft',strategyId:'s2',body:'保留的正文'});assert.match(partial.text,/分项已保存/);assert.equal(broker.artifacts().length,0);
 // Concurrent independent fields must not overwrite each other's checkpoint.
 await Promise.all([save({amendmentText:'修改文本'}),save({amendmentBasis:'修改依据'})]);
 await broker.close();
 broker=await startAgentBroker({...options,outputsRoot:path.join(root,'resumed'),recoveryArtifactRoot:out,materials:[{...mat,id:'renewed-n1'}]});
 const inspect=await callTool(broker.url,token,'inspect_artifact',{field:'body'});assert.match(inspect.text,/保留的正文/);assert.match(inspect.text,/amendmentBasis/);
 const gated=await save({reviewNotes:'复核说明'});assert.match(gated.text,/请读取 notice/);assert.equal((gated.parsed as any).result.isError,true);assert.equal(broker.artifacts().length,0);
 await callTool(broker.url,token,'read_material',{materialId:'renewed-n1'});
 const done=await save({});assert.match(done.text,/已写入并通过校验/);assert.equal(broker.artifacts().length,1);
 assert.equal(JSON.parse(await fs.readFile(broker.artifacts()[0].absolutePath,'utf8')).body,'保留的正文');
 await broker.close();
 broker=await startAgentBroker({...options,outputsRoot:path.join(root,'different'),recoveryArtifactRoot:out,artifactExpect:{kind:'draft',strategyId:'other'}});
 const isolated=await callTool(broker.url,token,'inspect_artifact',{field:'body'});assert.doesNotMatch(isolated.text,/保留的正文/);
 const invalid=await save({'unexpected':'x'});assert.equal((invalid.parsed as any).result.isError,true);
});

test('result.json adopt is atomic (temp+rename class) and rejects invalid before accept', async t => {
  const root = await tmpDir('atomic-adopt'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const out = path.join(root, 'out');
  const token = randomRunToken();
  const draft = { kind: 'draft', strategyId: 's2', body: '正文一段', amendmentText: '改', amendmentBasis: '依据', reviewNotes: '核' };
  const broker = await startAgentBroker({
    token,
    snapshotRoot: path.join(root, 'snap'),
    outputsRoot: out,
    materials: [],
    allowedArtifacts: ['result.json'],
    artifactExpect: { kind: 'draft', strategyId: 's2' },
  });
  t.after(() => broker.close());
  const save = async (content: unknown) =>
    (await callTool(broker.url, token, TOOL_WRITE_ARTIFACT, { name: 'result.json', content })).parsed as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };

  // Invalid shape must not create or register result.json.
  const bad = await save({ kind: 'draft', strategyId: 's2', body: '' });
  assert(bad.result.isError);
  assert.equal(broker.artifacts().length, 0);
  assert.equal(await fs.access(path.join(out, 'result.json')).then(() => true, () => false), false);
  const leftovers = (await fs.readdir(out).catch(() => [] as string[])).filter(n => n.endsWith('.tmp') || n === 'result.json');
  assert.deepEqual(leftovers, []);

  // Valid accept writes complete JSON via atomicWrite class; no temp leftovers.
  const good = await save(draft);
  assert(!good.result.isError);
  assert.equal(broker.artifacts().length, 1);
  const target = path.join(out, 'result.json');
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), draft);
  assert.equal((await fs.readdir(out)).filter(n => n.endsWith('.tmp')).length, 0);

  // Failed replacement must keep prior accepted bytes (validate before accept).
  const prior = await fs.readFile(target, 'utf8');
  const rejected = await save({ ...draft, strategyId: 'wrong' });
  assert(rejected.result.isError);
  assert.equal(broker.artifacts().length, 0);
  assert.equal(await fs.readFile(target, 'utf8'), prior);
  assert.equal((await fs.readdir(out)).filter(n => n.endsWith('.tmp')).length, 0);
});

test('atomicWrite matches checkpoint class: rename replaces without partial final file', async t => {
  const root = await tmpDir('atomic-write'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'result.json');
  await atomicWrite(file, '{"a":1}');
  assert.equal(await fs.readFile(file, 'utf8'), '{"a":1}');
  await atomicWrite(file, Buffer.from('{"a":2,"b":"x"}'));
  assert.equal(await fs.readFile(file, 'utf8'), '{"a":2,"b":"x"}');
  assert.equal((await fs.readdir(root)).filter(n => n.endsWith('.tmp')).length, 0);
});

test('quality loop repairs only notice gaps and verifies actual quote before accepting',async t=>{
 const root=await tmpDir('quality'),snap=path.join(root,'snap'),out=path.join(root,'out');
 const material=await writeMaterial(snap,'通知.txt','第一行真实意见\n第二行真实依据\n第三行其他意见','notice');material.role='当前通知';
 const reports:import('../src/domain/agent-evidence.ts').ArtifactQuality[]=[];
 const broker=await startAgentBroker({token:randomRunToken(),snapshotRoot:snap,outputsRoot:out,materials:[material],evidencePolicy:{formal:true,noticeCoverage:true},onQuality:q=>reports.push(q)});
 t.after(async()=>{await broker.close();await fs.rm(root,{recursive:true,force:true});});
 const invoke=async(name:string,args:Record<string,unknown>)=>(await callTool(broker.url,broker.token,name,args)).parsed as {result:{isError?:boolean;content:unknown;structuredContent?:unknown}};
 await invoke('read_material',{materialId:material.id,startLine:1,endLine:1});
 const partial=await invoke('write_artifact',{name:'result.json',content:{kind:'discuss',reply:'候选'}});assert(partial.result.isError);assert.match(JSON.stringify(partial),/2-3/);assert.equal(broker.artifacts().length,0);
 await invoke('read_material',{materialId:material.id,startLine:2,endLine:3});
 const wrong={kind:'discuss',reply:'候选',evidenceCitations:[{id:'c1',materialId:material.id,hash:material.hash,unit:'line',start:2,end:2,quote:'编造的引文'}]};
 assert((await invoke('write_artifact',{name:'result.json',content:wrong})).result.isError);
 wrong.evidenceCitations[0].quote='第二行真实依据';assert(!(await invoke('write_artifact',{name:'result.json',content:wrong})).result.isError);
 assert.equal(reports.at(-1)?.citations[0].status,'verified');assert.equal(reports.at(-1)?.materials[0].status,'complete');
 assert.equal(JSON.parse(await fs.readFile(path.join(out,'evidence-report.json'),'utf8')).citations[0].status,'verified');
 assert.equal(digest(await fs.readFile(material.absoluteSnapshotPath)),material.hash);
});
test('task-local memory paginates exactly, disallows another task and requires deferred text before acceptance',async t=>{
 const root=await tmpDir('memory'),text='早期用户限制'.repeat(3000),token=randomRunToken();
 const broker=await startAgentBroker({token,snapshotRoot:path.join(root,'snap'),outputsRoot:path.join(root,'out'),materials:[],taskMemory:{schema:1,caseId:'a',processKey:'p',entries:[{id:'u1',kind:'user-statement',source:'用户消息u1',text}]},requiredMemoryIds:['u1']});
 t.after(async()=>{await broker.close();await fs.rm(root,{recursive:true,force:true});});
 const invoke=async(name:string,args:Record<string,unknown>)=>(await callTool(broker.url,token,name,args)).parsed as {result:{isError?:boolean;content:Array<{text:string}>}};
 assert((await invoke('read_task_memory',{id:'another-case'})).result.isError);
 assert((await invoke('write_artifact',{name:'result.json',content:{ok:true}})).result.isError);
 const first=await invoke('read_task_memory',{id:'u1'});assert.equal(JSON.parse(first.result.content[0].text).nextOffset,12000);
 assert((await invoke('write_artifact',{name:'result.json',content:{ok:true}})).result.isError);
 const last=await invoke('read_task_memory',{id:'u1',offset:12000});assert.equal(JSON.parse(last.result.content[0].text).nextOffset,null);
 assert(!(await invoke('write_artifact',{name:'result.json',content:{ok:true}})).result.isError);
});
test('empty range cannot satisfy a read and ordinary partial reference only produces a warning',async t=>{
 const root=await tmpDir('reference'),snap=path.join(root,'snap');const mat=await writeMaterial(snap,'参考.txt','一\n二\n三');
 const broker=await startAgentBroker({token:randomRunToken(),snapshotRoot:snap,outputsRoot:path.join(root,'out'),materials:[mat],evidencePolicy:{formal:true,noticeCoverage:true}});
 t.after(async()=>{await broker.close();await fs.rm(root,{recursive:true,force:true});});
 assert.match(JSON.stringify((await callTool(broker.url,broker.token,'read_material',{materialId:mat.id,startLine:999})).parsed),/没有可读取文本/);
 await callTool(broker.url,broker.token,'read_material',{materialId:mat.id,startLine:1,endLine:1});
 const result=await callTool(broker.url,broker.token,'write_artifact',{name:'result.json',content:{kind:'discuss',reply:'仅讨论已读范围'}});
 assert(!((result.parsed as {result:{isError?:boolean}}).result.isError));assert.equal(broker.artifacts().length,1);
});

test('professional document checkpoints resume, report business gaps, and complete via local merge',async t=>{
 const root=await tmpDir('professional-resume');t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {parseProfessionalResult}=await import('./professional-host.ts');
 const token=randomRunToken(),contract={kind:'writing' as const,professional:true,phase:4};
 const options={token,snapshotRoot:path.join(root,'snap'),outputsRoot:path.join(root,'old/outputs'),materials:[],taskContract:contract,artifactScope:'case-phase',validateArtifact:async(raw:string)=>{try{parseProfessionalResult(raw,'writing',4);}catch(e){return (e as Error).message;}}};
 let broker=await startAgentBroker(options);t.after(()=>broker.close());
 const save=(content:unknown)=>callTool(broker.url,token,'write_artifact',{name:'result.json',mode:'merge',content});
 assert.match((await save({kind:'writing',text:'整理说明',documents:{ABSTRACT:'摘要',CLAIMS:'权利要求'}})).text,/分项已保存/);
 const p=broker.progress();assert(p.saved.some(s=>s.id==='documents.CLAIMS'));assert(p.pending.some(s=>s.id==='documents.DESCRIPTION'));assert.equal(p.accepted,false);
 await broker.close();broker=await startAgentBroker({...options,outputsRoot:path.join(root,'new/outputs'),recoveryArtifactRoot:options.outputsRoot});
 assert.equal(broker.progress().recovery?.status,'restored');
 const inspect=await callTool(broker.url,token,'inspect_artifact',{field:'documents'});assert.match(inspect.text,/权利要求/);
 assert.match((await save({documents:{DESCRIPTION:'说明书',ABSTRACT_IMAGE:'',DRAWINGS:''}})).text,/已写入并通过校验/);
 assert.equal(broker.progress().accepted,true);const result=JSON.parse(await fs.readFile(broker.artifacts()[0].absolutePath,'utf8'));assert.equal(result.documents.ABSTRACT,'摘要');
 const saved=JSON.parse(await fs.readFile(path.join(root,'new/outputs/task-progress.json'),'utf8'));assert.equal(saved.pending.length,0);assert.equal(saved.accepted,true);
});
