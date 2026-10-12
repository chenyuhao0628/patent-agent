import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeRunner, inspectAssistantTurn } from './agent-runner.ts';
import type { AgentRunInput } from './agent-runner.ts';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-'));
  const binary = path.join(root, 'engine.mjs');
  await fs.writeFile(binary, `#!${process.execPath}
import http from 'node:http';
import fs from 'node:fs/promises';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),mcp=config.mcp.servers.case_tools;
let mode='',messages=[],status='idle',prompt='';
const json=(res,value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
const write=async reply=>fetch(mcp.url,{method:'POST',headers:{...mcp.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'write_artifact',arguments:{name:'result.json',content:{kind:'discuss',reply}}}})}).then(r=>r.json());
http.createServer(async(req,res)=>{
 let raw='';for await(const b of req)raw+=b;
 const u=new URL(req.url,'http://127.0.0.1');
 if(u.pathname==='/api/info')return json(res,{version:'2.99.0',pid:process.pid});
 if(u.pathname==='/api/event'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\\n\\n');return;}
 if(u.pathname==='/api/session'&&req.method==='POST'){mode=JSON.parse(raw).title;return json(res,{data:{id:'s'}});}
 if(u.pathname==='/api/mcp')return json(res,{data:[{name:'case_tools',status:{status:'connected'}}]});
 if(u.pathname.endsWith('/prompt')){
  prompt=JSON.parse(raw).text;
  status='busy';
  if(mode==='crash'){json(res,{},204);setTimeout(()=>process.exit(17),40);return;}
  if(mode==='empty-idle'){status='idle';json(res,{},204);return;}
  status='busy';await write('intermediate');
  messages=[{info:{id:'a1',role:'assistant',time:{created:1,completed:Date.now()},finish:mode==='busy-boundary'?'stop':'tool-calls'},parts:[{id:'t1',type:'tool',tool:'case_tools_write_artifact',state:{status:'completed'}}]}];
  json(res,{},204);
  setTimeout(async()=>{
   await write('final checked');await fs.writeFile('final-reached','yes');
   messages.push({info:{id:'a2',role:'assistant',time:{created:2,completed:Date.now()},finish:'stop'},parts:[{id:'p2',type:'text',text:'final checked'}]});status='idle';
  },650);return;
 }
 if(u.pathname==='/api/session/active')return json(res,{data:status==='busy'?{s:{type:'running'}}:{}});
 if(u.pathname.endsWith('/message')){const rows=[{id:'u',type:'user',text:prompt},...messages.map(row=>({id:row.info.id,type:'assistant',time:row.info.time,finish:row.info.finish,content:row.parts}))];if(status==='idle')rows.push({id:'idle',type:'idle',outcome:'succeeded'});return json(res,{data:rows.reverse(),cursor:{next:null}});}
 return json(res,{});
}).listen(port,'127.0.0.1');
`, { mode: 0o700 });
  const input: AgentRunInput = {
    runId: 'audit', discussionId: 'tool-boundary', localRunDirectory: path.join(root, 'run'),
    runtime: { profileKey: 'local', providerId: 'synthetic', providerName: 'synthetic', baseURL: 'http://127.0.0.1:1/v1', protocol: 'openai-responses', modelId: 'test', displayName: 'test', contextWindow: 32000, maxOutput: 1000, key: 'synthetic-key', headers: {}, reasoning: { levelId: 'vendor-default', omitted: true, unverified: true, source: 'unverified', protocol: 'openai-responses' } },
    materials: [], productPrompt: 'Synthetic lifecycle test', publicMessages: [], onEvent: () => {},
    allowedArtifacts: ['result.json'], artifactExpect: { kind: 'discuss' }, deadlineMs: 5000,
  };
  return { root, binary, input };
}

test('completed tool-call and unknown-finish turns are not terminal answers', () => {
  for (const finish of ['tool-calls', 'unknown']) {
    const inspected = inspectAssistantTurn([{ info: { id: 'a', role: 'assistant', time: { completed: 1 }, finish }, parts: [{ type: 'tool', state: { status: 'completed' } }] }]);
    assert.equal(inspected.assistantCompleted, false);
  }
});

for (const mode of ['tool-boundary', 'busy-boundary']) test(`runner waits past ${mode} and adopts the final checked artifact`, async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const result = await new OpenCodeRunner({ binaryPath: process.execPath, binaryArgs: [f.binary] }).run({ ...f.input, discussionId: mode });
  assert.equal(result.status, 'completed');
  assert.equal(await fs.readFile(path.join(f.input.localRunDirectory, 'home/.config/opencode/final-reached'), 'utf8'), 'yes');
  assert.equal(JSON.parse(await fs.readFile(result.artifact!.absolutePath, 'utf8')).reply, 'final checked');
  assert.match(result.finalText, /final checked/);
});

for (const point of ['before-start', 'broker-initializing']) test(`cancellation at ${point} leaves no listening task services`, async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const getHandles = () => (process as typeof process & { _getActiveHandles: () => Array<{ constructor: { name: string }; listening?: boolean; closeAllConnections?: () => void; close?: (cb: () => void) => void }> })._getActiveHandles();
  const before = new Set(getHandles()), controller = new AbortController();
  if (point === 'before-start') controller.abort();
  const result = await new OpenCodeRunner({ binaryPath: process.execPath, binaryArgs: [f.binary] }).run({ ...f.input, signal: controller.signal, onEvent: e => { if (point === 'broker-initializing' && e.type === 'progress') controller.abort(); } });
  const leaked = getHandles().filter(h => !before.has(h) && h.constructor.name === 'Server' && h.listening);
  t.after(async () => { for (const h of leaked) { h.closeAllConnections?.(); await new Promise<void>(r => h.close?.(r)); } });
  assert.equal(result.status, 'aborted');
  assert.equal(leaked.length, 0, 'aborted tasks must revoke both model and tool servers');
});

test('child exit after prompt is reported as server_exited rather than the task deadline', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const result = await new OpenCodeRunner({ binaryPath: process.execPath, binaryArgs: [f.binary] }).run({ ...f.input, discussionId: 'crash' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'server_exited');
});

test('idle success without a final assistant fails promptly and preserves the task record', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const result = await new OpenCodeRunner({ binaryPath: process.execPath, binaryArgs: [f.binary] }).run({ ...f.input, discussionId: 'empty-idle' });
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'incomplete_response');
});

test('session record write failure preserves the artifact and does not claim task success', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await fs.mkdir(path.join(f.input.localRunDirectory, 'session.json'), {recursive:true});
  const result = await new OpenCodeRunner({ binaryPath: process.execPath, binaryArgs: [f.binary] }).run({...f.input,discussionId:'busy-boundary'});
  assert.equal(result.status,'failed');assert.equal(result.error?.code,'session_persist_failed');
  assert.equal(JSON.parse(await fs.readFile(result.artifact!.absolutePath,'utf8')).reply,'final checked');
});
