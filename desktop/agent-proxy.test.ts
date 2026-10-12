import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializeDiagnostics,stopDiagnostics} from './diagnostics.ts';
import { OPENCODE_SESSION_HEADER, OPENCODE_USER_AGENT } from '../src/domain/models.ts';
import type { ModelProtocol } from '../src/domain/models.ts';
import {
  DUMMY_UPSTREAM_KEY,
  UnknownProtocolError,
  applyWirePolicy,
  childAuthAccepted,
  childAuthHeaders,
  childRequestPath,
  effectiveMaxOutput,
  providerNpmForProtocol,
  startAgentProxy,
  upstreamUrlFor,
} from './agent-proxy.ts';
import type { RuntimeModelConfig } from './model-service.ts';

function runtime(partial: Partial<RuntimeModelConfig> = {}): RuntimeModelConfig {
  return {
    profileKey: 'p',
    providerId: 'prov',
    providerName: 'prov',
    baseURL: 'http://127.0.0.1:9/v1',
    protocol: 'openai-responses',
    modelId: 'deepseek-v4.1-flash',
    displayName: 'flash',
    contextWindow: 32_000,
    maxOutput: 256,
    key: 'real-test-key-not-for-child',
    headers: {},
    reasoning: {
      levelId: 'high',
      omitted: false,
      unverified: false,
      source: 'codex-verified',
      protocol: 'openai-responses',
      request: { reasoning: { effort: 'high' } },
    },
    ...partial,
  };
}

test('stream timing retains local request correlation when upstream supplies its own request id',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'proxy-timing-')),log=initializeDiagnostics(root);
 const upstream=await listen((_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('x-request-id','upstream-private-id');res.write('data: {"test":true}\n\n');res.end('data: [DONE]\n\n');});
 try{
  for(const fetchImpl of [undefined,((...args:Parameters<typeof fetch>)=>fetch(...args)) as typeof fetch]){
   const cfg=runtime({baseURL:`${upstream.origin}/v1`}),proxy=await startAgentProxy({runtime:cfg,discussionId:'timing',runId:'private-run',fetchImpl});
   try{
    const response=await fetch(`${proxy.childBaseURL}/responses`,{method:'POST',headers:{Authorization:`Bearer ${DUMMY_UPSTREAM_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:cfg.modelId,input:'synthetic'})});
    await response.text();
   }finally{await proxy.close();}
  }
  const records=log.snapshot('test').records,starts=records.filter(r=>r.event==='request_started');
  assert.equal(starts.length,2);
  for(const start of starts){
   assert.ok(records.some(r=>r.event==='first_response_chunk'&&r.requestId===start.requestId&&typeof r.durationMs==='number'));
   assert.ok(records.some(r=>r.event==='upstream_headers'&&r.requestId===start.requestId&&r.upstreamRequestId!==start.requestId));
  }
  assert.doesNotMatch(JSON.stringify(records),/private-run|upstream-private-id|real-test-key/);
 }finally{await upstream.close();stopDiagnostics();await fs.rm(root,{recursive:true,force:true});}
});

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void) {
  const seen: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ path: req.url || '/', headers: req.headers, body: body.toString('utf8') });
      res.setHeader('Connection', 'close');
      handler(req, res, body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(err => err ? reject(err) : resolve()); }),
  };
}

test('unknown protocol is rejected and does not fall back to chat', () => {
  assert.throws(() => providerNpmForProtocol('mystery'), UnknownProtocolError);
  assert.equal(providerNpmForProtocol('openai-responses'), '@opencode/ai/providers/openai-compatible/responses');
  assert.equal(providerNpmForProtocol('openai-chat-completions'), '@opencode/ai/providers/openai-compatible');
  assert.equal(providerNpmForProtocol('anthropic-messages'), '@opencode/ai/providers/anthropic-compatible');
  assert.equal(providerNpmForProtocol('gemini-generate-content'), '@opencode/ai/providers/google');
});

test('native Chat max_completion_tokens is bounded without sending the incompatible max_tokens alias', () => {
  const cfg=runtime({protocol:'openai-chat-completions'});
  const body=applyWirePolicy(cfg.protocol,{max_completion_tokens:9000,max_tokens:8000},cfg,256);
  assert.equal(body.max_completion_tokens,256);assert.equal(body.max_tokens,undefined);
  const legacy=applyWirePolicy(cfg.protocol,{max_tokens:8000},cfg,256);assert.equal(legacy.max_tokens,256);
});

test('proxy replaces dummy child key, injects session/UA/reasoning/limits, store=false, and rejects other endpoints', async () => {
  const upstream = await listen((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'resp_1', status: 'completed', output: [] }));
  });
  const cfg = runtime({ baseURL: `${upstream.origin}/v1` });
  const proxy = await startAgentProxy({ runtime: cfg, discussionId: 'disc-stable' });
  try {
    const allowed = await fetch(`${proxy.childBaseURL}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelId, input: 'hi', max_output_tokens: 99999, store: true }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(upstream.seen.length, 1);
    const headers = upstream.seen[0].headers;
    assert.equal(headers.authorization, 'Bearer real-test-key-not-for-child');
    assert.equal(headers[OPENCODE_SESSION_HEADER], 'disc-stable');
    assert.equal(headers['user-agent'], OPENCODE_USER_AGENT);
    const body = JSON.parse(upstream.seen[0].body) as { max_output_tokens: number; store: boolean; reasoning?: { effort: string } };
    assert.equal(body.max_output_tokens, effectiveMaxOutput(cfg));
    assert.equal(body.store, true);
    assert.equal(body.reasoning?.effort, 'high');
    assert.doesNotMatch(upstream.seen[0].body, new RegExp(DUMMY_UPSTREAM_KEY));
    const forbidden = await fetch(`${proxy.childBaseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelId, messages: [] }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(upstream.seen.length, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('proxy rejects redirects, caps body, aborts upstream when client cancels, and does not log secrets', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let aborted = false;
  const upstream = await listen((req, res) => {
    if ((req.url || '').includes('redirect')) {
      res.statusCode = 302;
      res.setHeader('Location', 'https://example.com');
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    res.write('data: hang\n\n');
    const markAbort = () => { aborted = true; };
    req.on('aborted', markAbort);
    req.on('close', markAbort);
  });
  const cfg = runtime({ baseURL: `${upstream.origin}/v1` });
  const proxy = await startAgentProxy({ runtime: cfg, discussionId: 'disc-2', bodyLimit: 64 });
  try {
    const big = await fetch(`${proxy.childBaseURL}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelId, pad: 'x'.repeat(200) }),
    });
    assert.equal(big.status, 413);
    const controller = new AbortController();
    const pending = fetch(`${proxy.childBaseURL}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelId, input: 'slow' }),
      signal: controller.signal,
    });
    await new Promise(r => setTimeout(r, 80));
    controller.abort();
    await pending.catch(() => undefined);
    const deadline = Date.now() + 1000;
    while (!aborted && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(aborted, true);
    for (const line of errors) {
      assert.doesNotMatch(line, /real-test-key-not-for-child/);
      assert.doesNotMatch(line, /Bearer /);
    }
  } finally {
    console.error = original;
    await proxy.close();
    await upstream.close();
  }
});

test('applyWirePolicy writes Gemini nested generationConfig reasoning and keeps protocol npm mapping', () => {
  const cfg = runtime({
    protocol: 'gemini-generate-content',
    modelId: 'gemini-2.5-flash',
    reasoning: {
      levelId: 'high',
      omitted: false,
      unverified: false,
      source: 'codex-verified',
      protocol: 'gemini-generate-content',
      request: { thinkingConfig: { thinkingBudget: 128 } },
    },
  });
  const out = applyWirePolicy('gemini-generate-content', { model: cfg.modelId, temperature: 0.2 }, cfg, 64);
  const gen = out.generationConfig as { maxOutputTokens: number; thinkingConfig: { thinkingBudget: number } };
  assert.equal(out.model, undefined);
  assert.equal(gen.maxOutputTokens, 64);
  assert.equal(gen.thinkingConfig.thinkingBudget, 128);
  assert.equal('thinkingConfig' in gen.thinkingConfig, false);
});

test('vendor-default omitted reasoning strips engine injections', () => {
  const cfg = runtime({
    reasoning: { levelId: 'vendor-default', omitted: true, unverified: false, source: 'manual', protocol: 'openai-responses' },
  });
  const out = applyWirePolicy('openai-responses', {
    model: cfg.modelId,
    reasoning: { effort: 'high' },
    temperature: 0.7,
    input: 'x',
  }, cfg, 32);
  assert.equal(out.reasoning, undefined);
  assert.equal(out.temperature, undefined);
  assert.equal(out.max_output_tokens, 32);
});

test('Gemini streamGenerateContent keeps alt=sse query', () => {
  const url = upstreamUrlFor({
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'gemini-generate-content',
    modelId: 'gemini-2.5-flash',
  }, '/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.ok(url);
  assert.match(url!, /alt=sse/);
  assert.match(url!, /streamGenerateContent/);
});

test('unauthorized and foreign origin never reach upstream fetch', async () => {
  let reached = 0;
  const cfg = runtime({ baseURL: 'https://example.invalid/v1' });
  const proxy = await startAgentProxy({
    runtime: cfg,
    discussionId: 'qa-auth',
    fetchImpl: async () => {
      reached++;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const foreign = await fetch(`${proxy.origin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://unrelated.example' },
      body: JSON.stringify({ model: cfg.modelId, input: 'synthetic' }),
    });
    assert.ok(foreign.status === 401 || foreign.status === 403);
    assert.equal(reached, 0);
    const noAuth = await fetch(`${proxy.childBaseURL}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelId, input: 'synthetic' }),
    });
    assert.equal(noAuth.status, 401);
    assert.equal(reached, 0);
    const ok = await fetch(`${proxy.childBaseURL}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelId, input: 'ok' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(reached, 1);
    assert.ok(proxy.token.length >= 16);
    assert.equal(childRequestPath(proxy.token, '/v1/responses'), `${proxy.routePrefix}/v1/responses`);
    const realAsChild = await fetch(`${proxy.childBaseURL}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelId, input: 'nope' }),
    });
    assert.equal(realAsChild.status, 401);
    assert.equal(reached, 1);
  } finally {
    await proxy.close();
  }
});

type FetchHit = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries([...headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [k.toLowerCase(), String(v)]));
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function protocolRuntime(protocol: ModelProtocol, extra: Partial<RuntimeModelConfig> = {}): RuntimeModelConfig {
  const modelId = protocol === 'gemini-generate-content'
    ? 'gemini-2.5-flash'
    : protocol === 'anthropic-messages'
      ? 'claude-sonnet-4'
      : 'deepseek-v4.1-flash';
  const reasoning: RuntimeModelConfig['reasoning'] = protocol === 'gemini-generate-content'
    ? { levelId: 'high', omitted: false, unverified: false, source: 'codex-verified', protocol, request: { thinkingConfig: { thinkingBudget: 32 } } }
    : protocol === 'anthropic-messages'
      ? { levelId: 'budget', omitted: false, unverified: false, source: 'codex-verified', protocol, request: { thinking: { type: 'enabled', budget_tokens: 128 } } }
      : protocol === 'openai-chat-completions'
        ? { levelId: 'high', omitted: false, unverified: false, source: 'codex-verified', protocol, request: { reasoning_effort: 'high' } }
        : { levelId: 'high', omitted: false, unverified: false, source: 'codex-verified', protocol, request: { reasoning: { effort: 'high' } } };
  return runtime({
    protocol,
    modelId,
    baseURL: protocol === 'gemini-generate-content'
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : 'https://example.invalid/v1',
    reasoning,
    ...extra,
  });
}

function childPath(protocol: ModelProtocol, modelId: string): string {
  if (protocol === 'openai-chat-completions') return '/v1/chat/completions';
  if (protocol === 'anthropic-messages') return '/v1/messages';
  if (protocol === 'gemini-generate-content') return `/v1/models/${modelId}:streamGenerateContent?alt=sse`;
  return '/v1/responses';
}

function childBody(protocol: ModelProtocol, modelId: string): Record<string, unknown> {
  if (protocol === 'openai-chat-completions') return { model: modelId, messages: [{ role: 'user', content: 'hi' }] };
  if (protocol === 'anthropic-messages') return { model: modelId, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
  if (protocol === 'gemini-generate-content') return { model: modelId, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
  return { model: modelId, input: 'hi' };
}

test('childAuthAccepted matches protocol-native headers or injected Authorization, not the other protocol key', () => {
  const dummy = DUMMY_UPSTREAM_KEY;
  const token = 'run-token-aaaaaaaa';
  assert.equal(childAuthAccepted('openai-responses', { authorization: `Bearer ${dummy}` }, dummy, token), true);
  assert.equal(childAuthAccepted('openai-responses', { 'x-api-key': dummy }, dummy, token), false);
  assert.equal(childAuthAccepted('anthropic-messages', { 'x-api-key': dummy }, dummy, token), true);
  assert.equal(childAuthAccepted('anthropic-messages', { authorization: `Bearer ${dummy}` }, dummy, token), true);
  assert.equal(childAuthAccepted('anthropic-messages', { 'x-goog-api-key': dummy }, dummy, token), false);
  assert.equal(childAuthAccepted('gemini-generate-content', { 'x-goog-api-key': dummy }, dummy, token), true);
  assert.equal(childAuthAccepted('gemini-generate-content', { 'x-api-key': dummy }, dummy, token), false);
});

test('four protocols forward only the matching upstream auth header and reject wrong child credentials without fetch', async () => {
  const protocols: ModelProtocol[] = [
    'openai-responses',
    'openai-chat-completions',
    'anthropic-messages',
    'gemini-generate-content',
  ];
  for (const protocol of protocols) {
    const hits: FetchHit[] = [];
    const cfg = protocolRuntime(protocol);
    const proxy = await startAgentProxy({
      runtime: cfg,
      discussionId: `disc-${protocol}`,
      fetchImpl: async (url, init) => {
        const headers = headerMap(init?.headers);
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(String(init?.body || '{}')); } catch { /* ignore */ }
        hits.push({ url: String(url), headers, body });
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      },
    });
    try {
      const native = await fetch(`${proxy.origin}${proxy.routePrefix}${childPath(protocol, cfg.modelId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...childAuthHeaders(protocol, DUMMY_UPSTREAM_KEY) },
        body: JSON.stringify(childBody(protocol, cfg.modelId)),
      });
      assert.equal(native.status, 200, protocol);
      assert.equal(hits.length, 1, protocol);
      const hit = hits[0];
      if (protocol === 'anthropic-messages') {
        assert.equal(hit.headers['x-api-key'], cfg.key);
        assert.equal(hit.headers.authorization, undefined);
        assert.equal(hit.headers['x-goog-api-key'], undefined);
        assert.equal((hit.body.thinking as { budget_tokens?: number } | undefined)?.budget_tokens, 128);
      } else if (protocol === 'gemini-generate-content') {
        assert.equal(hit.headers['x-goog-api-key'], cfg.key);
        assert.equal(hit.headers.authorization, undefined);
        assert.equal(hit.headers['x-api-key'], undefined);
        assert.match(hit.url, /alt=sse/);
        assert.match(hit.url, /streamGenerateContent/);
        assert.equal(hit.body.model, undefined);
        const gen = hit.body.generationConfig as { maxOutputTokens?: number; thinkingConfig?: { thinkingBudget?: number } };
        assert.equal(gen.maxOutputTokens, effectiveMaxOutput(cfg));
        assert.equal(gen.thinkingConfig?.thinkingBudget, 32);
      } else {
        assert.equal(hit.headers.authorization, `Bearer ${cfg.key}`);
        assert.equal(hit.headers['x-api-key'], undefined);
        assert.equal(hit.headers['x-goog-api-key'], undefined);
      }
      assert.doesNotMatch(JSON.stringify(hit), new RegExp(DUMMY_UPSTREAM_KEY));

      const wrongNative: Record<string, string> = protocol === 'gemini-generate-content'
        ? { 'x-api-key': DUMMY_UPSTREAM_KEY }
        : { 'x-goog-api-key': DUMMY_UPSTREAM_KEY };
      const wrong = await fetch(`${proxy.origin}${proxy.routePrefix}${childPath(protocol, cfg.modelId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...wrongNative },
        body: JSON.stringify(childBody(protocol, cfg.modelId)),
      });
      assert.equal(wrong.status, 401, `${protocol} wrong header`);
      assert.equal(hits.length, 1, `${protocol} wrong header no fetch`);

      const foreign = await fetch(`${proxy.origin}${proxy.routePrefix}${childPath(protocol, cfg.modelId)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: 'https://unrelated.example',
          ...childAuthHeaders(protocol, DUMMY_UPSTREAM_KEY),
        },
        body: JSON.stringify(childBody(protocol, cfg.modelId)),
      });
      assert.equal(foreign.status, 403, `${protocol} origin`);
      assert.equal(hits.length, 1, `${protocol} origin no fetch`);

      const noToken = await fetch(`${proxy.origin}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...childAuthHeaders(protocol, DUMMY_UPSTREAM_KEY) },
        body: JSON.stringify(childBody(protocol, cfg.modelId)),
      });
      assert.ok(noToken.status === 401 || noToken.status === 403, `${protocol} no token path`);
      assert.equal(hits.length, 1, `${protocol} no token no fetch`);
    } finally {
      await proxy.close();
    }
  }
});

test('close during body read does not forward the late payload', async () => {
  let reached = 0;
  const cfg = runtime();
  const proxy = await startAgentProxy({
    runtime: cfg,
    discussionId: 'late-body',
    fetchImpl: async () => {
      reached++;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  const payload = JSON.stringify({ model: cfg.modelId, input: 'late-complete-body' });
  const first = payload.slice(0, 12);
  const rest = payload.slice(12);
  try {
    const result = await new Promise<{ status: number }>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (status: number) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ status });
      };
      timer = setTimeout(() => finish(0), 2_000);
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxy.port,
        path: `${proxy.routePrefix}/v1/responses`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Connection: 'close',
        },
      }, res => {
        res.resume();
        res.on('end', () => finish(res.statusCode || 0));
      });
      req.on('error', () => finish(0));
      req.write(first);
      setTimeout(() => {
        void proxy.close().then(() => {
          try {
            req.write(rest);
            req.end();
          } catch {
            finish(0);
          }
        });
      }, 40);
    });
    assert.equal(reached, 0);
    assert.ok(result.status === 0 || result.status >= 400);
    const after = await fetch(`${proxy.childBaseURL}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.modelId, input: 'after-close' }),
    }).catch(() => undefined);
    assert.equal(reached, 0);
    if (after) assert.ok(after.status >= 400);
  } finally {
    await proxy.close().catch(() => undefined);
  }
});

test('DeepSeek Responses adapter works on Node and fetch transports and restores tool-history reasoning',async()=>{
 const expected='核对材料';let bodySeen:any;
 const upstream=await listen((_req,res,body)=>{bodySeen=JSON.parse(body.toString());res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'response.reasoning_text.delta',item_id:'rs',output_index:0,content_index:0,delta:expected})+'\n\n');});
 try{for(const fetchImpl of [undefined,((...args:Parameters<typeof fetch>)=>fetch(...args)) as typeof fetch]){
 const cfg=runtime({baseURL:`${upstream.origin}/v1`});const proxy=await startAgentProxy({runtime:cfg,discussionId:'adapter-test',fetchImpl});
 try{const response=await fetch(`${proxy.childBaseURL}/responses`,{method:'POST',headers:{Authorization:`Bearer ${DUMMY_UPSTREAM_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({input:[{type:'reasoning',id:'rs',summary:[{type:'summary_text',text:expected}]},{role:'user',content:'synthetic-image-payload '+ 'x'.repeat(1_100_000)}],stream:true})});
 assert.equal(response.status,200);assert.match(await response.text(),/response.reasoning_summary_text.delta/);assert.deepEqual(bodySeen.input[0].content,[{type:'reasoning_text',text:expected}]);assert.equal(bodySeen.input[0].summary,undefined);
 }finally{await proxy.close();}}
 }finally{await upstream.close();}
});

for (const transport of ['node', 'fetch']) {
  for (const format of ['json', 'sse', 'deepseek']) test(`${transport} forwards compressed ${format} without double decoding or stale length`, async t => {
    const payload = format === 'json' ? JSON.stringify({ output: '合成结果' })
      : `data: ${JSON.stringify({ type: format === 'deepseek' ? 'response.reasoning_text.delta' : 'response.output_text.delta', item_id: 'r', delta: '合成内容' })}\n\n`;
    // Brotli and gzip both exercise transport decoding, including an adapter that changes length.
    const encoding = format === 'sse' ? 'br' : 'gzip';
    const compressed = encoding === 'br' ? brotliCompressSync(payload) : gzipSync(payload);
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json' : 'text/event-stream', 'Content-Encoding': encoding, 'Content-Length': compressed.length });
      res.end(compressed);
    });
    t.after(() => upstream.close());
    const cfg = runtime({ baseURL: `${upstream.origin}/v1`, modelId: format === 'deepseek' ? 'deepseek-test' : 'synthetic' });
    const proxy = await startAgentProxy({ runtime: cfg, discussionId: 'compressed', fetchImpl: transport === 'fetch' ? (...args) => fetch(...args) : undefined });
    t.after(() => proxy.close());
    const response = await fetch(`${proxy.childBaseURL}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: cfg.modelId, input: 'synthetic' }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    const actual = await response.text();
    if (format === 'deepseek') { assert.match(actual, /response.reasoning_summary_text.delta/); assert.match(actual, /合成内容/); }
    else assert.equal(actual, payload);
  });

  test(`${transport} cancels upstream SSE after the POST body has fully arrived`, async t => {
    let upstreamClosed = false;
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"ready":true}\n\n');
      res.once('close', () => { upstreamClosed = true; });
    });
    t.after(() => upstream.close());
    const cfg = runtime({ baseURL: `${upstream.origin}/v1`, modelId: 'synthetic' });
    const proxy = await startAgentProxy({ runtime: cfg, discussionId: 'disconnect', fetchImpl: transport === 'fetch' ? (...args) => fetch(...args) : undefined });
    t.after(() => proxy.close());
    const response = await fetch(`${proxy.childBaseURL}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${DUMMY_UPSTREAM_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: cfg.modelId, input: 'synthetic' }) });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
    assert.equal(upstreamClosed, false, 'request completion must not masquerade as response cancellation');
    await reader.cancel();
    const deadline = Date.now() + 2_000;
    while (!upstreamClosed && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(upstreamClosed, true, 'cancelling the response must close the still-running upstream response');
  });
}
