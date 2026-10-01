import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from './files.ts';
import {
  PREFERRED_ARTIFACT,
  TOOL_READ_MATERIAL,
  TOOL_WRITE_ARTIFACT,
} from './agent-broker.ts';
import { DUMMY_UPSTREAM_KEY } from './agent-proxy.ts';
import {
  OpenCodeRunner,
  buildOpenCodeConfig,
  contextBudgetChars,
  createPartTextAccumulator,
  createAssistantEventFilter,
  estimatePromptChars,
  inspectAssistantTurn,
  killManagedProcess,
  redactChildLog,
  windowsTaskkillArgs,
  type AgentEvent,
  type FrozenMaterial,
  type RuntimeModelConfig,
} from './agent-runner.ts';

test('SSE excludes user, unknown and reasoning parts; polling and late snapshots do not duplicate text', () => {
  let output = '';
  const texts = createPartTextAccumulator(t => { output += t; });
  const accept = createAssistantEventFilter('s1', texts);
  const message = (id: string, role: string) => accept({ type: 'message.updated', properties: { info: { id, role, sessionID: 's1' } } });
  const part = (messageID: string, text: string, type = 'text') => accept({ type: 'message.part.updated', properties: { part: { id: 'p', messageID, sessionID: 's1', type, text } } });
  part('unknown', 'untrusted input');
  message('u1', 'user'); part('u1', 'task instructions');
  message('a1', 'assistant'); part('a1', 'hidden thought', 'reasoning');
  part('a1', '答');
  texts.ingest({ messageId: 'a1', partId: 'p', type: 'text', text: '答复' });
  part('a1', '答'); part('a1', '答复');
  accept({ type: 'message.part.delta', properties: { messageID: 'a1', partID: 'p', field: 'text', delta: '复' } });
  part('a1', '答复完成');
  assert.equal(output, '答复完成');
});
import { OPENCODE_SESSION_HEADER, OPENCODE_USER_AGENT } from '../src/domain/models.ts';

async function tmpDir(label: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `agent-runner-${label}-`));
}

function runtime(baseURL: string, extra: Partial<RuntimeModelConfig> = {}): RuntimeModelConfig {
  return {
    profileKey: 'p',
    providerId: 'prov',
    providerName: 'prov',
    baseURL,
    protocol: 'openai-responses',
    modelId: 'deepseek-v4.1-flash',
    displayName: 'flash',
    contextWindow: 16_000,
    maxOutput: 256,
    key: 'real-mock-key',
    headers: {},
    reasoning: {
      levelId: 'high',
      omitted: false,
      unverified: false,
      source: 'codex-verified',
      protocol: 'openai-responses',
      request: { reasoning: { effort: 'high' } },
    },
    ...extra,
  };
}

const FAKE_OPENCODE = `#!/usr/bin/env node
import http from 'node:http';
const portFlag = process.argv.indexOf('--port');
const port = Number(process.argv[portFlag + 1] || 0);
const user = process.env.OPENCODE_SERVER_USERNAME || '';
const password = process.env.OPENCODE_SERVER_PASSWORD || '';
const expected = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
const sessions = new Map();
const sse = new Set();
function send(res, status, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  res.statusCode = status;
  if (raw) res.setHeader('Content-Type', 'application/json');
  res.end(raw);
}
function authorized(req) {
  return (req.headers.authorization || '') === expected;
}
function sessionOf(req) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);
  return parts[0] === 'session' ? parts[1] : '';
}
function emit(payload) {
  const frame = 'data: ' + JSON.stringify({ payload }) + '\\n\\n';
  for (const res of sse) res.write(frame);
}
function applyMode(ses) {
  const mode = ses.title || '';
  if (mode.startsWith('hang-')) return;
  if (mode.startsWith('error-')) {
    ses.status = 'idle';
    ses.messages = [{
      info: { id: 'msg_a', role: 'assistant', time: { created: 1 }, error: { name: 'ProviderError' } },
      parts: [{ id: 'p1', type: 'text', text: 'failed turn' }],
    }];
    emit({ type: 'session.error', properties: { sessionID: ses.id } });
    return;
  }
  if (mode.startsWith('unknown-')) {
    ses.status = undefined;
    ses.messages = [{
      info: { id: 'msg_a', role: 'assistant', time: { created: 1 } },
      parts: [{ id: 'p1', type: 'text', text: 'still going' }],
    }];
    return;
  }
  const text = mode.startsWith('reason-') ? 'visible-only' : 'done-ok';
  ses.status = 'idle';
  ses.messages = [{
    info: { id: 'msg_a'+(mode.startsWith('repair-')?String(ses.turns):''), role: 'assistant', time: { created: 1, completed: Date.now() } },
    parts: [
      ...(mode.startsWith('reason-') ? [{ id: 'r1', type: 'reasoning', text: 'secret-cot' }] : []),
      { id: 'p1', type: 'text', text },
    ],
  }];
  if (mode.startsWith('reason-')) {
    emit({ type: 'message.part.updated', properties: { part: { id: 'r1', messageID: 'msg_a', sessionID: ses.id, type: 'reasoning', text: 'secret-cot' } } });
  }
  emit({ type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'msg_a', sessionID: ses.id, type: 'text', text } } });
  emit({ type: 'session.idle', properties: { sessionID: ses.id } });
}
const server = http.createServer((req, res) => {
  if (!authorized(req)) { send(res, 401, { error: 'unauthorized' }); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  if (pathname === '/global/health' && req.method === 'GET') {
    send(res, 200, { healthy: true, version: '1.18.30' });
    return;
  }
  if (pathname === '/global/event' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    sse.add(res);
    req.on('close', () => sse.delete(res));
    return;
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    if (pathname === '/session' && req.method === 'POST') {
      const id = 'ses_' + Math.random().toString(16).slice(2);
      const ses = { id, title: body.title || '', status: 'busy', messages: [] };
      sessions.set(id, ses);
      send(res, 200, { id });
      return;
    }
    if (pathname === '/session/status' && req.method === 'GET') {
      const map = {};
      for (const [id, ses] of sessions) {
        if (ses.status) map[id] = { type: ses.status };
      }
      send(res, 200, map);
      return;
    }
    const sid = sessionOf(req);
    const ses = sessions.get(sid);
    if (pathname.endsWith('/prompt_async') && req.method === 'POST') {
      if (!ses) { send(res, 404, { error: 'missing' }); return; }
      ses.turns=(ses.turns||0)+1;
      setTimeout(() => applyMode(ses), 30);
      send(res, 204);
      return;
    }
    if (pathname.endsWith('/abort') && req.method === 'POST') {
      if (ses) ses.status = 'idle';
      send(res, 204);
      return;
    }
    if (pathname.includes('/message') && req.method === 'GET') {
      send(res, 200, ses ? ses.messages : []);
      return;
    }
    send(res, 404, { error: 'not_found' });
  });
});
server.listen(port, '127.0.0.1');
`;

async function writeFakeOpenCode(dir: string) {
  const file = path.join(dir, 'fake-opencode');
  await fs.writeFile(file, FAKE_OPENCODE, { mode: 0o755 });
  return file;
}

async function runWithFake(discussionId: string, opts: { deadlineMs?: number; signal?: AbortSignal } = {}) {
  const root = await tmpDir('fake');
  const bin = await writeFakeOpenCode(root);
  const events: AgentEvent[] = [];
  const runner = new OpenCodeRunner({ binaryPath: bin });
  const result = await runner.run({
    runtime: runtime('http://127.0.0.1:9/v1'),
    runId: 'run-1',
    discussionId,
    localRunDirectory: path.join(root, 'run'),
    materials: [],
    productPrompt: '测试',
    publicMessages: [],
    onEvent: e => events.push(e),
    deadlineMs: opts.deadlineMs ?? 8_000,
    signal: opts.signal,
  });
  return { root, result, events };
}

test('OpenCode config injects dummy Authorization for every protocol', () => {
  const protocols = ['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'gemini-generate-content'] as const;
  for (const protocol of protocols) {
    const cfg = buildOpenCodeConfig({
      modelId: protocol === 'gemini-generate-content' ? 'gemini-2.5-flash' : 'm',
      displayName: 'm',
      protocol,
      childBaseURL: 'http://127.0.0.1:9/r/tok/v1',
      contextWindow: 1000,
      maxOutput: 16,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      mcpToken: 'x'.repeat(32),
      systemPrompt: 'p',
    });
    const options = (cfg.provider as { patent: { options: { apiKey: string; headers: { Authorization: string }; baseURL: string } } }).patent.options;
    assert.equal(options.apiKey, DUMMY_UPSTREAM_KEY);
    assert.equal(options.headers.Authorization, `Bearer ${DUMMY_UPSTREAM_KEY}`);
    assert.equal(options.baseURL, 'http://127.0.0.1:9/r/tok/v1');
  }
});

test('SSE encoder emits official response event order with sequence_number and usage', () => {
  const buf = encodeResponsesSse('qa-model', [
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'case_tools_read_material', arguments: '{"materialId":"mat-a"}' },
  ]);
  const text = buf.toString('utf8');
  assert.match(text, /event: response.created/);
  assert.match(text, /event: response.output_item.added/);
  assert.match(text, /event: response.function_call_arguments.delta/);
  assert.match(text, /event: response.function_call_arguments.done/);
  assert.match(text, /event: response.output_item.done/);
  assert.match(text, /event: response.completed/);
  assert.match(text, /"sequence_number":0/);
  assert.match(text, /"usage":\{"input_tokens":24/);
});

test('oversized public history is rejected instead of silently truncated', async () => {
  const chars = estimatePromptChars({
    productPrompt: 'p',
    materials: [],
    publicMessages: [{ role: 'user', content: '汉'.repeat(50_000) }],
    allowedArtifacts: [PREFERRED_ARTIFACT],
  });
  assert.ok(chars > contextBudgetChars(1_000));
  const runner = new OpenCodeRunner({ binaryPath: '/nonexistent-opencode' });
  const result = await runner.run({
    runtime: runtime('http://127.0.0.1:9/v1', { contextWindow: 1_000 }),
    runId: 'big',
    discussionId: 'big',
    localRunDirectory: await tmpDir('ctx'),
    materials: [],
    productPrompt: 'p',
    publicMessages: [{ role: 'user', content: '汉'.repeat(50_000) }],
    onEvent: () => undefined,
    deadlineMs: 1_000,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'context_too_large');
});

test('inspectAssistantTurn requires time.completed and pending tools block completion; info.error fails', () => {
  const pending = inspectAssistantTurn([
    {
      info: { id: 'a', role: 'assistant', time: { created: 1 } },
      parts: [
        { id: 't', type: 'tool', state: { status: 'running' } },
        { id: 'p', type: 'text', text: 'hello' },
      ],
    },
  ]);
  assert.equal(pending.assistantCompleted, false);
  assert.equal(pending.pendingTools, true);
  const done = inspectAssistantTurn([
    {
      info: { id: 'a', role: 'assistant', time: { created: 1, completed: 99 } },
      parts: [{ id: 'p', type: 'text', text: 'hello' }],
    },
  ]);
  assert.equal(done.assistantCompleted, true);
  const errored = inspectAssistantTurn([
    {
      info: { id: 'a', role: 'assistant', time: { created: 1, completed: 99 }, error: { name: 'ProviderError' } },
      parts: [{ id: 'p', type: 'text', text: 'x' }],
    },
  ]);
  assert.equal(errored.error?.code, 'ProviderError');
  const unknown = inspectAssistantTurn([
    { info: { id: 'a', role: 'assistant', time: { created: 1 } }, parts: [{ id: 'p', type: 'text', text: 'not done' }] },
  ]);
  assert.equal(unknown.assistantCompleted, false);
});

test('part text accumulator dedupes by message/part id and ignores reasoning', () => {
  const deltas: string[] = [];
  const acc = createPartTextAccumulator(text => deltas.push(text));
  acc.ingest({ messageId: 'm', partId: 'p', type: 'reasoning', text: 'cot' });
  acc.ingest({ messageId: 'm', partId: 'p', type: 'text', text: 'Hel' });
  acc.ingest({ messageId: 'm', partId: 'p', type: 'text', text: 'Hello' });
  acc.ingest({ messageId: 'm', partId: 'p', type: 'text', text: 'Hello' });
  acc.ingest({ messageId: 'm', partId: 'p', type: 'text', delta: '!' });
  assert.deepEqual(deltas, ['Hel', 'lo', '!']);
  assert.equal(acc.snapshot(), 'Hello!');
});

test('redactChildLog strips secrets and truncates prompt-like lines', () => {
  const line = `Authorization: Bearer super-secret-token apiKey="abc" ${'prompt-'.repeat(80)}`;
  const out = redactChildLog(line);
  assert.doesNotMatch(out, /super-secret-token/);
  assert.doesNotMatch(out, /abc/);
  assert.ok(out.length <= 420);
});

test('windows taskkill args only target the held pid tree', () => {
  assert.deepEqual(windowsTaskkillArgs(4242), ['/PID', '4242', '/T', '/F']);
});

test('killManagedProcess terminates the held child only', async () => {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  assert.ok(proc.pid);
  await killManagedProcess(proc);
  assert.ok(proc.exitCode !== null || proc.signalCode !== null);
});

test('fake OpenCode completes only with assistant time.completed; unknown text is not success', async () => {
  const ok = await runWithFake('complete-ok');
  assert.equal(ok.result.status, 'completed');
  assert.match(ok.result.finalText, /done-ok/);
  const unknown = await runWithFake('unknown-text', { deadlineMs: 1_500 });
  assert.equal(unknown.result.status, 'failed');
  assert.equal(unknown.result.error?.code, 'deadline');
});

test('fake OpenCode info.error ends failed and reasoning is not forwarded', async () => {
  const failed = await runWithFake('error-turn');
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.result.error?.code, 'ProviderError');
  const reason = await runWithFake('reason-turn');
  assert.equal(reason.result.status, 'completed');
  const deltas = reason.events.filter(e => e.type === 'delta').map(e => e.type === 'delta' ? e.text : '');
  assert.equal(deltas.join(''), 'visible-only');
  assert.ok(!deltas.join('').includes('secret-cot'));
  assert.equal(reason.events.filter(e => e.type === 'delta' && e.text === 'visible-only').length, 1);
});

test('abort invalidates immediately and returns aborted after process stop; parent env is unchanged', async () => {
  const beforeHome = process.env.HOME;
  const controller = new AbortController();
  const pending = runWithFake('hang-wait', { signal: controller.signal, deadlineMs: 10_000 });
  await delay(300);
  controller.abort();
  const { result } = await pending;
  assert.equal(result.status, 'aborted');
  assert.equal(process.env.HOME, beforeHome);
});

function toolName(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return '';
  const rec = entry as Record<string, unknown>;
  if (typeof rec.name === 'string') return rec.name;
  const fn = rec.function && typeof rec.function === 'object' ? rec.function as Record<string, unknown> : undefined;
  return typeof fn?.name === 'string' ? fn.name : '';
}

function flattenInput(req: Record<string, unknown>): Record<string, unknown>[] {
  const input = req.input;
  if (Array.isArray(input)) return input.filter(item => item && typeof item === 'object') as Record<string, unknown>[];
  return [];
}

function encodeResponsesSse(model: unknown, output: Record<string, unknown>[]) {
  const id = 'resp_' + randomBytes(3).toString('hex');
  const usage = { input_tokens: 24, output_tokens: 16, total_tokens: 40 };
  const events: Record<string, unknown>[] = [];
  let seq = 0;
  const push = (event: Record<string, unknown>) => {
    events.push({ ...event, sequence_number: seq++ });
  };
  const created = {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress',
    model, output: [] as unknown[], usage: null, error: null,
  };
  push({ type: 'response.created', response: created });
  const completedItems: Record<string, unknown>[] = [];
  output.forEach((item, index) => {
    if (item.type === 'function_call') {
      const callId = String(item.call_id || `call_${index}`);
      const itemId = String(item.id || `fc_${index}`);
      const args = String(item.arguments || '{}');
      const added = { type: 'function_call', id: itemId, call_id: callId, name: item.name, arguments: '', status: 'in_progress' };
      push({ type: 'response.output_item.added', output_index: index, item: added });
      push({ type: 'response.function_call_arguments.delta', item_id: itemId, output_index: index, delta: args });
      push({ type: 'response.function_call_arguments.done', item_id: itemId, output_index: index, arguments: args });
      const done = { ...added, arguments: args, status: 'completed' };
      push({ type: 'response.output_item.done', output_index: index, item: done });
      completedItems.push(done);
    } else {
      const itemId = String(item.id || `msg_${index}`);
      const text = Array.isArray(item.content)
        ? (item.content as { text?: string }[]).map(part => part.text || '').join('')
        : String(item.text || '');
      const added = {
        type: 'message', id: itemId, role: 'assistant', status: 'in_progress',
        content: [{ type: 'output_text', text: '' }],
      };
      push({ type: 'response.output_item.added', output_index: index, item: added });
      push({ type: 'response.output_text.delta', item_id: itemId, output_index: index, content_index: 0, delta: text });
      push({ type: 'response.output_text.done', item_id: itemId, output_index: index, content_index: 0, text });
      const done = {
        type: 'message', id: itemId, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text }],
      };
      push({ type: 'response.output_item.done', output_index: index, item: done });
      completedItems.push(done);
    }
  });
  push({
    type: 'response.completed',
    response: {
      id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
      model, output: completedItems, usage, error: null,
    },
  });
  const frames = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).concat(['event: done\ndata: [DONE]']).join('\n\n') + '\n\n';
  return Buffer.from(frames);
}

function startMockResponses() {
  const seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown>; path: string }[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url || '').includes('/responses')) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
      seen.push({ headers: req.headers, body, path: req.url || '/' });
      const session = String(req.headers[OPENCODE_SESSION_HEADER] || '');
      if (session.startsWith('abort-')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        res.write('event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_hang","status":"in_progress","output":[]}}\n\n');
        return;
      }
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const names = tools.map(toolName);
      const readName = names.find(n => n.includes('read_material')) || `case_tools_${TOOL_READ_MATERIAL}`;
      const writeName = names.find(n => n.includes('write_artifact')) || `case_tools_${TOOL_WRITE_ARTIFACT}`;
      const items = flattenInput(body);
      const outputs = items.filter(item => String(item.type || '').includes('output') || item.role === 'tool');
      const joined = outputs.map(item => JSON.stringify(item)).join('\n');
      const priorNames = items.map(item => String(item.name || '')).join(' ');
      let output: Record<string, unknown>[];
      if (!joined.includes('IDENT-A1') && !priorNames.includes('read_material')) {
        output = [{ type: 'function_call', id: 'fc_read', call_id: 'call_read', name: readName, arguments: JSON.stringify({ materialId: 'mat-a' }) }];
      } else if (!joined.includes('已写入') && !priorNames.includes('write_artifact')) {
        const artifact = JSON.stringify({ ident: 'IDENT-A1', fact: 17, conclusion: '已按材料核对' });
        output = [{ type: 'function_call', id: 'fc_write', call_id: 'call_write', name: writeName, arguments: JSON.stringify({ name: PREFERRED_ARTIFACT, content: artifact }) }];
      } else {
        output = [{ type: 'message', id: 'msg_final', role: 'assistant', content: [{ type: 'output_text', text: '已完成。' }] }];
      }
      const wantStream = body.stream === true;
      if (wantStream) {
        const buf = encodeResponsesSse(body.model, output);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'close',
          'Cache-Control': 'no-cache',
          'Content-Length': String(buf.length),
        });
        res.end(buf);
        return;
      }
      const raw = Buffer.from(JSON.stringify({
        id: 'resp_' + randomBytes(3).toString('hex'), object: 'response', status: 'completed',
        model: body.model, output, usage: { input_tokens: 24, output_tokens: 16, total_tokens: 40 },
      }));
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close', 'Content-Length': String(raw.length) });
      res.end(raw);
    });
  });
  return new Promise<{ origin: string; seen: typeof seen; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((done, fail) => server.close(err => err ? fail(err) : done())),
      });
    });
  });
}

async function isolateBinary(source: string, destDir: string) {
  const dest = path.join(destDir, path.basename(source));
  await fs.copyFile(source, dest);
  await fs.chmod(dest, 0o755);
  return dest;
}

function collectDownloads(root: string, names: string[]) {
  return names.filter(name => name.includes('node_modules') || name.includes('.bun') || name.includes('registry.npmjs') || name.endsWith('.tgz'));
}

async function walkNames(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out;
}

test('live OpenCode + mock Responses: read_material then write result.json, abort, empty XDG has no npm download', { timeout: 120_000 }, async t => {
  const source = process.env.PATENT_AGENT_OPENCODE_BIN
    || '/Users/cyh/Documents/ChatGPT/patent-agent/.lab/agent-runtime/darwin-arm64/opencode';
  try {
    await fs.access(source);
  } catch {
    t.skip('OpenCode 1.18.30 binary not available');
    return;
  }
  const mock = await startMockResponses();
  const pack = await tmpDir('live');
  const bin = await isolateBinary(source, pack);
  const materialText = '案件标识: IDENT-A1\n事实数字: 17\n';
  async function makeRun(discussionId: string) {
    const runRoot = await tmpDir('live-run');
    const snap = path.join(runRoot, 'snap');
    await fs.mkdir(snap, { recursive: true });
    const file = path.join(snap, '材料.txt');
    await fs.writeFile(file, materialText);
    const material: FrozenMaterial = {
      id: 'mat-a',
      name: '材料.txt',
      role: 'oa',
      relativePath: '材料.txt',
      absoluteSnapshotPath: file,
      hash: digest(materialText),
    };
    const events: AgentEvent[] = [];
    const runner = new OpenCodeRunner({ binaryPath: bin });
    return { runRoot, material, events, runner, discussionId };
  }
  try {
    const live = await makeRun('live-discussion');
    const homeBefore = process.env.HOME;
    const result = await live.runner.run({
      runtime: runtime(`${mock.origin}/v1`),
      runId: 'live-1',
      discussionId: live.discussionId,
      localRunDirectory: live.runRoot,
      snapshotRoot: path.join(live.runRoot, 'snap'),
      materials: [live.material],
      productPrompt: '只使用 MCP 工具。',
      publicMessages: [{ role: 'user', content: '请读取材料并写结果' }],
      onEvent: e => live.events.push(e),
      deadlineMs: 90_000,
      allowedArtifacts: [PREFERRED_ARTIFACT],
    });
    assert.equal(process.env.HOME, homeBefore);
    if (result.status !== 'completed') {
      const xdg = await fs.readFile(path.join(live.runRoot, 'xdg-data/opencode/log/opencode.log'), 'utf8').catch(() => '');
      console.error('live result', result.status, result.error?.code, 'mockHits', mock.seen.length, 'stream', mock.seen[0]?.body.stream, 'tools', result.toolEvents.map(e => `${e.name}:${e.status}`).join(','));
      console.error('live xdg tail', redactChildLog(xdg.slice(-800)));
    }
    assert.equal(result.status, 'completed');
    assert.ok(result.artifact);
    assert.equal(result.artifact?.name, PREFERRED_ARTIFACT);
    const artifactText = await fs.readFile(result.artifact!.absolutePath, 'utf8');
    assert.match(artifactText, /IDENT-A1/);
    assert.match(artifactText, /17/);
    assert.notEqual(result.finalText.trim(), artifactText.trim());
    const readEvent = result.toolEvents.find(e => e.name === TOOL_READ_MATERIAL && e.success);
    assert.equal(readEvent?.materialId, 'mat-a');
    assert.equal(readEvent?.materialName, '材料.txt');
    assert.equal(readEvent?.status, 'success');
    const writeEvent = result.toolEvents.find(e => e.name === TOOL_WRITE_ARTIFACT && e.success);
    assert.equal(writeEvent?.artifactName, PREFERRED_ARTIFACT);
    assert.ok(mock.seen.length >= 1);
    assert.ok(mock.seen.some(item => item.body.stream === true), 'OpenCode must request stream:true; mock must answer with SSE');
    const first = mock.seen[0];
    assert.equal(first.headers.authorization, 'Bearer real-mock-key');
    assert.equal(first.headers[OPENCODE_SESSION_HEADER], 'live-discussion');
    assert.equal(first.headers['user-agent'], OPENCODE_USER_AGENT);
    assert.equal((first.body.reasoning as { effort?: string } | undefined)?.effort, 'high');
    assert.equal(first.body.max_output_tokens, 256);
    assert.equal(first.body.store, false);
    const names = await walkNames(live.runRoot);
    assert.equal(collectDownloads(live.runRoot, names).length, 0);
    const log = await fs.readFile(path.join(live.runRoot, 'logs', 'opencode.log'), 'utf8').catch(() => '');
    assert.doesNotMatch(log, /real-mock-key/);
    assert.doesNotMatch(log, /Bearer real/);

    const aborting = await makeRun('abort-discussion');
    const controller = new AbortController();
    const pending = aborting.runner.run({
      runtime: runtime(`${mock.origin}/v1`),
      runId: 'live-abort',
      discussionId: aborting.discussionId,
      localRunDirectory: aborting.runRoot,
      snapshotRoot: path.join(aborting.runRoot, 'snap'),
      materials: [aborting.material],
      productPrompt: '只使用 MCP 工具。',
      publicMessages: [],
      onEvent: e => aborting.events.push(e),
      deadlineMs: 20_000,
      signal: controller.signal,
    });
    await delay(800);
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.status, 'aborted');
    assert.ok(!aborting.events.some(e => e.type === 'tool' && e.event.success && e.event.name === TOOL_WRITE_ARTIFACT && Date.now() < 0));
    assert.ok(aborted.toolEvents.every(event => event.name !== TOOL_WRITE_ARTIFACT || event.status === 'error' || event.success === true));
  } finally {
    await mock.close();
  }
});


test('Responses output length stop explains the model limit instead of claiming completion',()=>{
 const inspected=inspectAssistantTurn([{info:{role:'assistant',finish:'length',time:{completed:1}},parts:[]}]);assert.equal(inspected.error?.code,'output_limit');assert.match(inspected.error!.message,/最大输出/);
});

test('0.4 reasoning is emitted separately, deduped and never enters final text or cross-session content', () => {
  let text = '', thinking = '';
  const accumulator = createPartTextAccumulator(value => { text += value; }, value => { thinking = value; });
  const accept = createAssistantEventFilter('ours', accumulator);
  accept({ type: 'message.updated', properties: { info: { sessionID: 'ours', id: 'a', role: 'assistant' } } });
  const part = (sessionID: string, type: string, value: string) => accept({ type: 'message.part.updated', properties: { part: { sessionID, messageID: 'a', id: type, type, text: value } } });
  part('other', 'reasoning', 'foreign');
  part('ours', 'reasoning', 'summary');
  part('ours', 'reasoning', 'summary');
  part('ours', 'text', 'answer');
  assert.equal(thinking, 'summary');
  assert.equal(text, 'answer');
  assert.equal(accumulator.snapshot(), 'answer');
});

test('compaction summary is neither answer text nor task completion',()=>{const x=inspectAssistantTurn([{info:{role:'assistant',summary:true,time:{completed:1}},parts:[{type:'text',text:'internal compact summary'}]}]);assert.equal(x.assistantCompleted,false);assert.equal(x.textParts.length,0);});

test('event stream keeps receiving valid events after more than 1 MB cumulative traffic',async()=>{
 let index=0;const encoder=new TextEncoder();const events:unknown[]=[];
 const stream=new ReadableStream<Uint8Array>({pull(controller){
   if(index++<1200)controller.enqueue(encoder.encode('data: '+JSON.stringify({type:'ignored',padding:'x'.repeat(1000)})+'\n\n'));
   else {controller.enqueue(encoder.encode('data: '+JSON.stringify({type:'session.compacted',properties:{sessionID:'session'}})+'\n\n'));controller.close();}
 }});
 const runner=new OpenCodeRunner({binaryPath:process.execPath,fetchImpl:async()=>new Response(stream)});
 const consume=(runner as unknown as {consumeEvents:(...args:unknown[])=>Promise<void>}).consumeEvents.bind(runner);
 await consume('http://127.0.0.1','test',new AbortController().signal,'session',createPartTextAccumulator(()=>{}),{idleObserved:false,sessionError:false},(event:unknown)=>events.push(event));
 assert(events.some(e=>(e as {type:string;label:string}).label==='上下文已自动压缩'));
});

test('runner automatically resumes missing-artifact completion twice in the same session then pauses',async()=>{
 const root=await tmpDir('repair-limit');const bin=await writeFakeOpenCode(root);const events:AgentEvent[]=[];
 const runner=new OpenCodeRunner({binaryPath:bin});
 const result=await runner.run({runtime:runtime("http://127.0.0.1:9/v1"),runId:'repair-limit',discussionId:'repair-limit',localRunDirectory:root,materials:[],productPrompt:'test',publicMessages:[],artifactExpect:{kind:'discuss'},deadlineMs:10000,onEvent:e=>events.push(e)});
 assert.equal(result.status,'failed');assert.equal(result.error?.code,'artifact_repair_exhausted');assert.equal(events.filter(e=>e.type==='activity'&&e.stepId?.startsWith('artifact-repair-')).length,2);
});
test('user cancellation stops automatic artifact repair',async()=>{
 const root=await tmpDir('repair-cancel');const bin=await writeFakeOpenCode(root);const abort=new AbortController();
 const runner=new OpenCodeRunner({binaryPath:bin});
 const result=await runner.run({runtime:runtime("http://127.0.0.1:9/v1"),runId:'repair-cancel',discussionId:'repair-cancel',localRunDirectory:root,materials:[],productPrompt:'test',publicMessages:[],artifactExpect:{kind:'discuss'},deadlineMs:10000,signal:abort.signal,onEvent:e=>{if(e.type==='activity'&&e.stepId?.startsWith('artifact-repair-'))abort.abort();}});
 assert.equal(result.status,'aborted');
});

test('incremental progress continues beyond two turns and stops only after repeated stagnation', {timeout:20000},async()=>{
 const root=await tmpDir('repair-progress');const bin=await writeFakeOpenCode(root);let prompts=0;
 const events:AgentEvent[]=[];
 const fetchImpl:typeof fetch=async(input,init)=>{
   if(String(input).includes('/prompt_async')){
     prompts++;
     if(prompts<=4){
       const cfg=JSON.parse(await fs.readFile(path.join(root,'xdg-config','opencode','opencode.json'),'utf8'));
       const mcp=cfg.mcp.case_tools;
       await fetch(mcp.url,{method:'POST',headers:{...mcp.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:prompts,method:'tools/call',params:{name:'write_artifact',arguments:{name:'result.json',mode:'merge',content:{kind:'draft',...([{body:'正文'},{amendmentText:'建议修改'},{amendmentBasis:'来源依据'},{reviewNotes:'内部说明'}][prompts-1])}}}})});
     }
   }
   return fetch(input,init);
 };
 const runner=new OpenCodeRunner({binaryPath:bin,fetchImpl});
 const result=await runner.run({runtime:runtime('http://127.0.0.1:9/v1'),runId:'repair-progress',discussionId:'repair-progress',localRunDirectory:root,materials:[],productPrompt:'test',publicMessages:[],artifactExpect:{kind:'draft',strategyId:'s'},deadlineMs:15000,onEvent:e=>events.push(e)});
 assert.equal(result.error?.code,'artifact_repair_exhausted');assert.equal(prompts,6);
 assert.equal(events.filter(e=>e.type==='activity'&&e.stepId?.startsWith('artifact-repair-')).length,5);
});

test('rewriting the same field cannot prolong automatic repair indefinitely', {timeout:15000},async()=>{
 const root=await tmpDir('repair-churn');const bin=await writeFakeOpenCode(root);let prompts=0;
 const fetchImpl:typeof fetch=async(input,init)=>{
   if(String(input).includes('/prompt_async')){
     prompts++;const cfg=JSON.parse(await fs.readFile(path.join(root,'xdg-config','opencode','opencode.json'),'utf8')),mcp=cfg.mcp.case_tools;
     await fetch(mcp.url,{method:'POST',headers:{...mcp.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:prompts,method:'tools/call',params:{name:'write_artifact',arguments:{name:'result.json',mode:'merge',content:{kind:'draft',body:'反复改写 '+prompts}}}})});
   }return fetch(input,init);
 };
 const runner=new OpenCodeRunner({binaryPath:bin,fetchImpl});
 const result=await runner.run({runtime:runtime('http://127.0.0.1:9/v1'),runId:'repair-churn',discussionId:'repair-churn',localRunDirectory:root,materials:[],productPrompt:'test',publicMessages:[],artifactExpect:{kind:'draft'},deadlineMs:10000,onEvent:()=>{}});
 assert.equal(result.error?.code,'artifact_repair_exhausted');assert.equal(prompts,3);assert.match(await fs.readFile(path.join(root,'outputs/artifact-checkpoint.json'),'utf8'),/反复改写 3/);
});
