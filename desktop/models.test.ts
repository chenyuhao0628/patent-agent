import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ModelService } from './model-service.ts';
import {
  BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID,
  BUILTIN_OPENCODE_GO_PROVIDER_ID,
  CONNECTION_TEST_PROMPT,
  OPENCODE_GO_MODEL_ID,
  OPENCODE_USER_AGENT,
  VENDOR_DEFAULT_LEVEL_ID,
  mapOpenCodeGoV41Effort,
  normalizeEffortId,
  parseDshProtocol,
  validateBaseURL,
} from '../src/domain/models.ts';
import type { ModelProtocol, ProviderSaveInput } from '../src/domain/models.ts';

const SECRET = 'sk-fake-test-key-do-not-leak';
const DSH_SECRET = 'fake-dsh-opencode-key';
const OTHER_SECRET = 'fake-other-key-must-not-be-read';

type Captured = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

function vault() {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: (text: string) => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]);
    },
    decrypt: (data: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString();
    },
  };
}

async function tempDir(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-models-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function service(root: string, opts?: {
  key?: { value: string };
  fetch?: typeof fetch;
  timeout?: number;
  vault?: ReturnType<typeof vault>;
  generation?: () => number;
  beforeCommit?: () => void | Promise<void>;
}) {
  const profile = opts?.key ?? { value: 'alice' };
  const store = opts?.vault ?? vault();
  return new ModelService({
    root,
    profileKey: () => profile.value,
    getVault: () => store,
    fetch: opts?.fetch,
    requestTimeoutMs: opts?.timeout,
    generation: opts?.generation,
    beforeCommit: opts?.beforeCommit,
  });
}

async function listen(t: test.TestContext, handler: (req: http.IncomingMessage, res: http.ServerResponse, captured: Captured) => void | Promise<void>) {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const item: Captured = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() };
      captured.push(item);
      void Promise.resolve(handler(req, res, item)).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  return { origin: `http://127.0.0.1:${address.port}`, captured };
}

function assertPublic(value: unknown, ...secrets: string[]) {
  const json = JSON.stringify(value);
  assert(!json.includes('encryptedKey'));
  assert(!/"key"\s*:/.test(json));
  assert(!json.includes('apiKey'));
  for (const secret of secrets) {
    if (secret) assert(!json.includes(secret), 'public DTO leaked a secret');
  }
}

function saveInput(over: Partial<ProviderSaveInput> & { baseURL: string }): ProviderSaveInput {
  return {
    id: BUILTIN_OPENCODE_GO_PROVIDER_ID,
    name: 'OpenCode Go',
    protocol: 'openai-responses',
    models: [{ id: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID, modelId: OPENCODE_GO_MODEL_ID, displayName: 'DeepSeek V4.1 Flash' }],
    ...over,
  };
}

test('base URL accepts https and localhost http, rejects credentials, hash, remote http and API suffixes', () => {
  assert.equal(validateBaseURL('https://opencode.ai/zen/go/v1/'), 'https://opencode.ai/zen/go/v1');
  assert.equal(validateBaseURL('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  assert.equal(validateBaseURL('http://localhost/v1'), 'http://localhost/v1');
  assert.throws(() => validateBaseURL('http://example.com/v1'), /https/);
  assert.throws(() => validateBaseURL('https://user:pass@opencode.ai/v1'), /用户名或密码/);
  assert.throws(() => validateBaseURL('https://opencode.ai/v1#x'), /hash/);
  assert.throws(() => validateBaseURL('https://api.openai.com/v1/chat/completions'), /\/chat\/completions/);
  assert.throws(() => validateBaseURL('https://api.openai.com/v1/responses'), /\/responses/);
  assert.throws(() => validateBaseURL('https://api.openai.com/v1/models'), /\/models/);
  assert.throws(() => validateBaseURL('https://host/v1?api_key=x'), /查询参数/);
});

test('empty profile seeds OpenCode Go with Responses and deepseek-v4.1-flash without writing', async t => {
  const root = await tempDir(t);
  const models = service(root);
  const listed = await models.list('alice');
  assert.equal(listed.providers[0].name, 'OpenCode Go');
  assert.equal(listed.providers[0].protocol, 'openai-responses');
  assert.equal(listed.providers[0].models[0].modelId, OPENCODE_GO_MODEL_ID);
  assert.equal(listed.providers[0].models[0].reasoning.selection.levelId, VENDOR_DEFAULT_LEVEL_ID);
  assert.deepEqual(listed.providers[0].models[0].reasoning.capability.levels.map(level => level.id), ['vendor-default', 'none', 'low', 'high', 'max']);
  assert.ok(!listed.providers[0].models[0].reasoning.capability.levels.some(level => level.id === 'xhigh'));
  assert.equal(listed.providers[0].models[0].reasoning.capability.levels.find(level => level.id === 'high')?.source, 'codex-verified');
  assert.equal(listed.providers[0].hasKey, false);
  assertPublic(listed, SECRET);
  await assert.rejects(fs.access(models.configPath('alice')), /ENOENT/);
});

test('saving a key encrypts into the profile file and never appears in public DTO or workspace', async t => {
  const root = await tempDir(t);
  const models = service(root);
  const saved = await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', key: SECRET }));
  assert.equal(saved.providers[0].hasKey, true);
  assertPublic(saved, SECRET);
  const disk = JSON.parse(await fs.readFile(models.configPath('alice'), 'utf8')) as { encryptedKey?: string; providers: { encryptedKey: string }[] };
  assert.equal(disk.providers[0].encryptedKey.length > 20, true);
  assert.doesNotMatch(JSON.stringify(disk), new RegExp(SECRET));
  await assert.rejects(fs.access(path.join(root, 'profiles', 'alice', 'workspace.json')));
  await assert.rejects(fs.access(path.join(root, 'workspace.json')));
});

test('mutations serialize, profile switch rejects stale work, failed write keeps previous file', async t => {
  const root = await tempDir(t);
  const profile = { value: 'alice' };
  const models = service(root, { key: profile });
  await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'KeepMe', key: SECRET }));
  const names: string[] = [];
  const a = models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'Alpha' })).then(result => names.push(result.providers[0].name));
  const b = models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'Beta' })).then(result => names.push(result.providers[0].name));
  await Promise.all([a, b]);
  assert.deepEqual(names.sort(), ['Alpha', 'Beta']);
  JSON.parse(await fs.readFile(models.configPath('alice'), 'utf8'));
  profile.value = 'bob';
  await assert.rejects(models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'FromAlice' })), /账号已切换/);
  await assert.rejects(fs.access(path.join(root, 'profiles', 'bob', 'models.json')));
  profile.value = 'alice';
  const dir = path.dirname(models.configPath('alice'));
  await fs.chmod(dir, 0o500);
  await assert.rejects(models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'ShouldFail' })));
  await fs.chmod(dir, 0o700);
  const after = JSON.parse(await fs.readFile(models.configPath('alice'), 'utf8')) as { providers: { name: string; encryptedKey: string }[] };
  assert.notEqual(after.providers[0].name, 'ShouldFail');
  assert.ok(['Alpha', 'Beta'].includes(after.providers[0].name));
  assert.equal(typeof after.providers[0].encryptedKey, 'string');
  assert.ok(after.providers[0].encryptedKey.length > 20);
});

test('OpenAI Responses connection test requires text and usage and reuses one OpenCode session id', async t => {
  const root = await tempDir(t);
  const { origin, captured } = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      output_text: 'OK',
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }));
  });
  const models = service(root);
  await models.saveProvider('alice', saveInput({ baseURL: origin + '/v1', key: SECRET }));
  const result = await models.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'OK');
  assert.equal(result.usage?.totalTokens, 3);
  assert.equal(result.protocol, 'openai-responses');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, '/v1/responses');
  const body = JSON.parse(captured[0].body) as { input: string; model: string; store?: boolean; reasoning?: unknown; max_output_tokens: number };
  assert.equal(body.input, CONNECTION_TEST_PROMPT);
  assert.equal(body.model, OPENCODE_GO_MODEL_ID);
  assert.equal(body.store, false);
  assert.equal(body.reasoning, undefined);
  assert.ok(body.max_output_tokens >= 1);
  assert.equal(captured[0].headers.authorization, 'Bearer ' + SECRET);
  assert.equal(captured[0].headers['user-agent'], OPENCODE_USER_AGENT);
  assert.equal(typeof captured[0].headers['x-opencode-session'], 'string');
  assert.match(String(captured[0].headers['x-opencode-session']), /[0-9a-f-]{36}/i);
  assertPublic(result, SECRET);
});

test('connection test succeeds without usage, rejects missing text and unsafe HTTP bodies', async t => {
  const root = await tempDir(t);
  let mode: 'ok' | 'text' | 'http' | 'failed' | 'truncated' = 'ok';
  const { origin } = await listen(t, (_req, res) => {
    if (mode === 'http') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid ' + SECRET, leaked: SECRET } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'ok') res.end(JSON.stringify({ output_text: 'OK', status: 'completed' }));
    else if (mode === 'text') res.end(JSON.stringify({ status: 'completed', usage: { total_tokens: 1 } }));
    else if (mode === 'failed') res.end(JSON.stringify({ status: 'failed', error: { message: SECRET } }));
    else res.end(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'O' }));
  });
  const models = service(root);
  await models.saveProvider('alice', saveInput({ baseURL: origin, key: SECRET }));
  const ok = await models.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID);
  assert.equal(ok.text, 'OK');
  assert.equal(ok.usage, undefined);
  mode = 'text';
  await assert.rejects(models.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID), /最终文本/);
  mode = 'failed';
  await assert.rejects(models.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID), error => {
    assert.match((error as Error).message, /失败|错误/);
    assert.equal((error as Error).message.includes(SECRET), false);
    return true;
  });
  mode = 'truncated';
  await assert.rejects(models.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID), /截断/);
  mode = 'http';
  await assert.rejects(models.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID), error => {
    const message = (error as Error).message;
    assert.match(message, /认证失败/);
    assert.equal(message.includes(SECRET), false);
    assert.equal(message.includes('invalid'), false);
    return true;
  });
});

test('protocol-specific test and model list requests, abort, and switch-during-fetch', async t => {
  const root = await tempDir(t);
  const cases: { protocol: ModelProtocol; path: string; listPath: string }[] = [
    { protocol: 'openai-chat-completions', path: '/chat/completions', listPath: '/models' },
    { protocol: 'anthropic-messages', path: '/messages', listPath: '/models' },
    { protocol: 'gemini-generate-content', path: '/models/gemini-flash:generateContent', listPath: '/models' },
  ];
  for (const item of cases) {
    const { origin, captured } = await listen(t, (req, res) => {
      const pathName = (req.url ?? '').split('?')[0];
      if (pathName === '/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (item.protocol === 'gemini-generate-content') {
          res.end(JSON.stringify({ models: [{ name: 'models/gemini-flash', displayName: 'Flash', inputTokenLimit: 128000, outputTokenLimit: 8192 }] }));
        } else if (item.protocol === 'anthropic-messages') {
          res.end(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }));
        } else {
          res.end(JSON.stringify({ data: [{ id: 'gpt-x' }] }));
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (item.protocol === 'openai-chat-completions') res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      else if (item.protocol === 'anthropic-messages') res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 } }));
      else res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }));
    });
    const models = service(root);
    const saved = await models.saveProvider('alice', {
      name: item.protocol,
      baseURL: origin,
      protocol: item.protocol,
      key: SECRET,
      models: [{ modelId: item.protocol === 'gemini-generate-content' ? 'gemini-flash' : 'gpt-x', displayName: 'X' }],
    });
    const providerId = saved.providers.find(provider => provider.name === item.protocol)!.id;
    const tested = await models.testConnection('alice', providerId);
    assert.equal(tested.text, 'OK');
    assert.ok(tested.usage);
    const post = captured.find(row => row.method === 'POST');
    assert.equal(post?.url, item.path);
    if (item.protocol === 'anthropic-messages') {
      assert.equal(post?.headers['x-api-key'], SECRET);
      assert.equal(post?.headers['anthropic-version'], '2023-06-01');
      assert.equal(post?.headers.authorization, undefined);
    } else if (item.protocol === 'gemini-generate-content') {
      assert.equal(post?.headers['x-goog-api-key'], SECRET);
    } else {
      assert.equal(post?.headers.authorization, 'Bearer ' + SECRET);
    }
    const listed = await models.listRemoteModels('alice', providerId);
    if (item.protocol === 'gemini-generate-content') {
      assert.equal(listed[0].id, 'models/gemini-flash');
      assert.equal(listed[0].contextWindow, 128000);
      assert.equal(listed[0].maxOutput, 8192);
    } else {
      assert.ok(listed[0].id);
      assert.equal(listed[0].contextWindow, undefined);
    }
    const get = captured.find(row => row.method === 'GET');
    assert.equal(get?.url?.split('?')[0], item.listPath);
    if (item.protocol === 'anthropic-messages') assert.equal(get?.headers['anthropic-version'], '2023-06-01');
  }

  const slow = await listen(t, (_req, res) => {
    setTimeout(() => { res.writeHead(200).end('{}'); }, 400);
  });
  const profile = { value: 'alice' };
  const models = service(root, { key: profile, timeout: 80 });
  const saved = await models.saveProvider('alice', saveInput({ id: undefined, name: 'Slow', baseURL: slow.origin, key: SECRET, models: [{ modelId: 'm', displayName: 'm' }] }));
  const id = saved.providers.find(provider => provider.name === 'Slow')!.id;
  await assert.rejects(models.testConnection('alice', id), /超时/);
  const controller = new AbortController();
  const pending = models.testConnection('alice', id, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /取消/);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const gated = await listen(t, async (_req, res) => {
    await gate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output_text: 'OK', usage: { total_tokens: 1 } }));
  });
  const racing = service(root, { key: profile });
  await racing.saveProvider('alice', saveInput({ id: undefined, name: 'Race', baseURL: gated.origin, key: SECRET, models: [{ modelId: 'm', displayName: 'm' }] }));
  const raceId = (await racing.list('alice')).providers.find(provider => provider.name === 'Race')!.id;
  const inflight = racing.testConnection('alice', raceId);
  profile.value = 'bob';
  release();
  await assert.rejects(inflight, /账号已切换/);
});

test('discovered models dedupe by id and do not overwrite hand-filled fields', async t => {
  const root = await tempDir(t);
  const models = service(root);
  const saved = await models.saveProvider('alice', saveInput({
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: [{ id: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID, modelId: OPENCODE_GO_MODEL_ID, displayName: '手填名称', contextWindow: 111, maxOutput: 22 }],
  }));
  const next = await models.addDiscoveredModels('alice', saved.providers[0].id, [
    { id: OPENCODE_GO_MODEL_ID, name: '上游想覆盖', contextWindow: 999, maxOutput: 888 },
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
  ]);
  const builtin = next.providers[0].models.find(model => model.modelId === OPENCODE_GO_MODEL_ID)!;
  assert.equal(builtin.displayName, '手填名称');
  assert.equal(builtin.contextWindow, 111);
  assert.equal(builtin.maxOutput, 22);
  assert.ok(next.providers[0].models.some(model => model.modelId === 'deepseek-flash'));
});

test('DSH import keeps original model ids, encrypts only the specified credential, and does not remap to v4.1', async t => {
  const root = await tempDir(t);
  const dsh = path.join(root, 'dsh-fixture');
  await fs.mkdir(dsh);
  await fs.writeFile(path.join(dsh, 'settings.yaml'), `
llm-pi-ai:
  providers:
    opencode-go:
      displayName: OpenCode Go
      baseURL: https://opencode.ai/zen/go/v1
      apiKeyEnv: OPENCODE_API_KEY
      headers:
        Authorization: should-not-import
        x-opencode-session: should-not-import
      models:
        - id: deepseek-flash
          name: DeepSeek V4.1 Flash
          protocol: openai-responses
          contextWindow: 128000
          maxOutput: 8192
          availableEfforts: [none, low, high]
          reasoning: true
          reasoningEffort: low
    other:
      displayName: Other
      baseURL: https://example.com/v1
      apiKeyEnv: OTHER_KEY
      models:
        - id: other-model
          name: Other
`);
  await fs.writeFile(path.join(dsh, '.credentials.yaml'), `
version: 1
refs:
  OPENCODE_API_KEY: ${DSH_SECRET}
  OTHER_KEY: ${OTHER_SECRET}
records:
  leftover: secret-record-must-not-be-read
`);
  const models = service(root);
  const preview = await models.previewDshProviders(dsh);
  assert.deepEqual(preview.map(item => item.providerKey).sort(), ['opencode-go', 'other']);
  const imported = await models.importDshProvider('alice', dsh, 'opencode-go');
  const dshProvider = imported.providers.find(provider => provider.source?.type === 'dsh' && provider.source.providerKey === 'opencode-go');
  assert.ok(dshProvider);
  assert.equal(dshProvider!.protocol, undefined);
  const flash = dshProvider!.models.find(model => model.modelId === 'deepseek-flash');
  assert.ok(flash);
  assert.equal(flash!.protocol, 'openai-responses');
  assert.equal(flash!.contextWindow, 128000);
  assert.equal(flash!.maxOutput, 8192);
  assert.ok(flash!.reasoning.capability.levels.some(level => level.id === 'low'));
  assert.equal(flash!.reasoning.selection.levelId, 'low');
  const canonical = dshProvider!.models.find(model => model.modelId === OPENCODE_GO_MODEL_ID && model.protocol === 'openai-responses');
  assert.ok(canonical);
  assert.equal(imported.defaultModelId, BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID);
  assert.equal(dshProvider!.hasKey, true);
  assertPublic(imported, DSH_SECRET, OTHER_SECRET, 'secret-record-must-not-be-read', 'should-not-import');
  const disk = await fs.readFile(models.configPath('alice'), 'utf8');
  assert.equal(disk.includes(DSH_SECRET), false);
  assert.equal(disk.includes(OTHER_SECRET), false);
  assert.equal(disk.includes('secret-record-must-not-be-read'), false);
  await models.setDefault('alice', dshProvider!.id, dshProvider!.models[0].id);
  const runtime = await models.resolveRuntimeConfig('alice', 'conv-import');
  assert.equal(runtime.key, DSH_SECRET);
  assert.equal(runtime.modelId, 'deepseek-flash');
  assert.notEqual(runtime.modelId, OPENCODE_GO_MODEL_ID);
  assert.equal(runtime.protocol, 'openai-responses');
  assert.equal(runtime.headers.Authorization, 'Bearer ' + DSH_SECRET);
  assert.equal(runtime.headers['User-Agent'], OPENCODE_USER_AGENT);
  assert.equal(runtime.headers['x-opencode-session'], 'conv-import');
});

test('resolveRuntimeConfig is main-process only and OpenCode headers cannot be overridden by stored junk', async t => {
  const root = await tempDir(t);
  const models = service(root);
  await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', key: SECRET }));
  const file = models.configPath('alice');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  const providers = raw.providers as Record<string, unknown>[];
  providers[0].headers = { Authorization: 'Bearer evil', 'x-opencode-session': 'evil-session', 'User-Agent': 'evil-agent' };
  providers[0].key = 'plaintext-should-be-ignored';
  providers[0].authorization = 'Bearer evil';
  await fs.writeFile(file, JSON.stringify(raw, null, 2));
  const runtime = await models.resolveRuntimeConfig('alice', 'conversation-stable-1');
  assert.equal(runtime.baseURL, 'https://opencode.ai/zen/go/v1');
  assert.equal(runtime.protocol, 'openai-responses');
  assert.equal(runtime.modelId, OPENCODE_GO_MODEL_ID);
  assert.equal(runtime.key, SECRET);
  assert.equal(runtime.headers.Authorization, 'Bearer ' + SECRET);
  assert.equal(runtime.headers['User-Agent'], OPENCODE_USER_AGENT);
  assert.equal(runtime.headers['x-opencode-session'], 'conversation-stable-1');
  const other = await models.resolveRuntimeConfig('alice', 'conversation-stable-2');
  assert.equal(other.headers['x-opencode-session'], 'conversation-stable-2');
  assert.notEqual(runtime.headers['x-opencode-session'], other.headers['x-opencode-session']);
  const api = models.asRendererAPI();
  assert.equal('resolveRuntimeConfig' in api, false);
  assert.equal(typeof (api as { resolveRuntimeConfig?: unknown }).resolveRuntimeConfig, 'undefined');
  const listed = await api.list('alice');
  assertPublic(listed, SECRET, 'plaintext-should-be-ignored', 'evil-session');
});

test('unsupported model list still leaves room for hand-filled models', async t => {
  const root = await tempDir(t);
  const { origin } = await listen(t, (_req, res) => { res.writeHead(404).end('nope ' + SECRET); });
  const models = service(root);
  const saved = await models.saveProvider('alice', saveInput({ baseURL: origin, key: SECRET }));
  await assert.rejects(models.listRemoteModels('alice', saved.providers[0].id), error => {
    const message = (error as Error).message;
    assert.match(message, /接口不存在/);
    assert.equal(message.includes(SECRET), false);
    assert.equal(message.includes('nope'), false);
    return true;
  });
  const again = await models.saveProvider('alice', saveInput({
    baseURL: origin,
    models: [{ id: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID, modelId: 'hand-filled-id', displayName: '手填' }],
  }));
  assert.equal(again.providers[0].models[0].modelId, 'hand-filled-id');
});

test('generic efforts keep xhigh and minimal; only Go v4.1 preset maps xhigh to high', () => {
  assert.equal(normalizeEffortId('xhigh'), 'xhigh');
  assert.equal(normalizeEffortId('minimal'), 'minimal');
  assert.equal(mapOpenCodeGoV41Effort('xhigh'), 'high');
  assert.equal(mapOpenCodeGoV41Effort('minimal'), 'low');
  assert.equal(parseDshProtocol('openai-completions'), 'openai-chat-completions');
  assert.equal(parseDshProtocol('openai-responses'), 'openai-responses');
  assert.equal(parseDshProtocol('anthropic-messages'), 'anthropic-messages');
  assert.equal(parseDshProtocol('google-generative-ai'), 'gemini-generate-content');
});

test('OpenCode Go reasoning request uses reasoning.effort; other models do not inherit the same ladder', async t => {
  const root = await tempDir(t);
  const { origin, captured } = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output_text: 'OK', status: 'completed', reasoning: { effort: 'low' } }));
  });
  const models = service(root);
  await models.saveProvider('alice', saveInput({
    baseURL: origin + '/v1',
    key: SECRET,
    models: [{
      id: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID,
      modelId: OPENCODE_GO_MODEL_ID,
      displayName: 'DeepSeek V4.1 Flash',
      reasoningLevelId: 'low',
    }],
  }));
  await models.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID);
  const body = JSON.parse(captured[0].body) as { reasoning?: { effort?: string }; store?: boolean };
  assert.equal(body.reasoning?.effort, 'low');
  assert.equal(body.store, false);
  const runtime = await models.resolveRuntimeConfig('alice', 'conv-think');
  assert.equal(runtime.reasoning.effort, 'low');
  assert.equal(runtime.reasoning.omitted, false);
  assert.equal(runtime.reasoning.unverified, false);
  assert.deepEqual(runtime.reasoning.request, { reasoning: { effort: 'low' } });

  const other = await models.saveProvider('alice', {
    name: 'Other',
    baseURL: origin,
    protocol: 'openai-responses',
    key: SECRET,
    models: [{ modelId: 'some-other-model', displayName: 'Other' }],
  });
  const otherModel = other.providers.find(provider => provider.name === 'Other')!.models[0];
  assert.equal(otherModel.reasoning.capability.supported, false);
  assert.ok(!otherModel.reasoning.capability.levels.some(level => level.id === 'max'));
  await assert.rejects(models.saveProvider('alice', {
    id: other.providers.find(provider => provider.name === 'Other')!.id,
    name: 'Other',
    baseURL: origin,
    protocol: 'openai-responses',
    models: [{ id: otherModel.id, modelId: 'some-other-model', displayName: 'Other', reasoningLevelId: 'max' }],
  }), /未声明|不兼容|不能发送/);
});

test('model protocol override is used at runtime and Chat/Anthropic/Gemini send real thinking fields', async t => {
  const root = await tempDir(t);
  const { origin, captured } = await listen(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.includes('chat/completions')) res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    else if (req.url === '/messages') res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
    else if (req.url?.includes('generateContent')) res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }));
    else res.end(JSON.stringify({ output_text: 'OK', status: 'completed' }));
  });
  const models = service(root);
  const saved = await models.saveProvider('alice', {
    name: 'Mixed',
    baseURL: origin,
    protocol: 'openai-responses',
    key: SECRET,
    models: [
      { modelId: OPENCODE_GO_MODEL_ID, displayName: 'DS', protocol: 'openai-responses' },
      {
        modelId: 'mimo-chat',
        displayName: 'MiMo',
        protocol: 'openai-chat-completions',
        reasoningOverridden: true,
        reasoningLevelId: 'low',
        reasoningLevels: [
          { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'manual' },
          { id: 'low', label: '低', protocolValue: 'low', source: 'manual' },
        ],
      },
      {
        modelId: 'claude-x',
        displayName: 'Claude',
        protocol: 'anthropic-messages',
        reasoningOverridden: true,
        reasoningLevelId: 'budget',
        reasoningBudgetTokens: 1024,
        reasoningLevels: [
          { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'manual' },
          { id: 'budget', label: '预算', protocolValue: 'enabled', source: 'manual' },
        ],
      },
      {
        modelId: 'gemini-flash',
        displayName: 'Gemini',
        protocol: 'gemini-generate-content',
        reasoningOverridden: true,
        reasoningLevelId: 'low',
        reasoningLevels: [
          { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'manual' },
          { id: 'low', label: '低', protocolValue: 'LOW', source: 'manual' },
        ],
      },
    ],
  });
  const provider = saved.providers.find(item => item.name === 'Mixed')!;
  const mimo = provider.models.find(item => item.modelId === 'mimo-chat')!;
  const claude = provider.models.find(item => item.modelId === 'claude-x')!;
  const gemini = provider.models.find(item => item.modelId === 'gemini-flash')!;
  await models.testConnection('alice', provider.id, { modelEntryId: mimo.id });
  await models.testConnection('alice', provider.id, { modelEntryId: claude.id });
  await models.testConnection('alice', provider.id, { modelEntryId: gemini.id });
  const chat = captured.find(item => item.url === '/chat/completions');
  const messages = captured.find(item => item.url === '/messages');
  const generate = captured.find(item => item.url?.includes(':generateContent'));
  assert.equal(JSON.parse(chat!.body).reasoning_effort, 'low');
  assert.deepEqual(JSON.parse(messages!.body).thinking, { type: 'enabled', budget_tokens: 1024 });
  assert.equal(JSON.parse(generate!.body).generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  await models.setDefault('alice', provider.id, mimo.id);
  const runtime = await models.resolveRuntimeConfig('alice', 'conv-mimo');
  assert.equal(runtime.protocol, 'openai-chat-completions');
  assert.equal(runtime.modelId, 'mimo-chat');
  assert.equal(runtime.reasoning.request?.reasoning_effort, 'low');
});

test('unsupported thinking is rejected instead of silently dropped', async t => {
  const root = await tempDir(t);
  const models = service(root);
  await assert.rejects(models.saveProvider('alice', {
    name: 'Plain',
    baseURL: 'https://example.invalid/v1',
    protocol: 'openai-responses',
    key: SECRET,
    models: [{ modelId: 'plain', displayName: 'Plain', reasoningLevelId: 'max' }],
  }), /未声明|不能发送|不兼容/);
});

test('clearKey removes the credential; blank key keeps it', async t => {
  const root = await tempDir(t);
  const models = service(root);
  await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', key: SECRET }));
  const kept = await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1' }));
  assert.equal(kept.providers[0].hasKey, true);
  const cleared = await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', clearKey: true }));
  assert.equal(cleared.providers[0].hasKey, false);
});

test('duplicate model id with same protocol is rejected; different protocol is allowed', async t => {
  const root = await tempDir(t);
  const models = service(root);
  await assert.rejects(models.saveProvider('alice', saveInput({
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: [
      { modelId: 'same', displayName: 'A' },
      { modelId: 'same', displayName: 'B' },
    ],
  })), /重复/);
  const saved = await models.saveProvider('alice', saveInput({
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: [
      { modelId: 'same', displayName: 'A', protocol: 'openai-responses' },
      { modelId: 'same', displayName: 'B', protocol: 'openai-chat-completions' },
    ],
  }));
  assert.equal(saved.providers[0].models.length, 2);
});

test('maxOutput cannot exceed contextWindow and unsafe integers are rejected', async t => {
  const root = await tempDir(t);
  const models = service(root);
  await assert.rejects(models.saveProvider('alice', saveInput({
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: [{ modelId: 'm', displayName: 'm', contextWindow: 10, maxOutput: 20 }],
  })), /不能大于/);
  await assert.rejects(models.saveProvider('alice', saveInput({
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: [{ modelId: 'm', displayName: 'm', contextWindow: Number.MAX_VALUE }],
  })), /正整数/);
});

test('corrupt stored providers are not silently dropped', async t => {
  const root = await tempDir(t);
  const models = service(root);
  await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'KeepMe', key: SECRET }));
  const file = models.configPath('alice');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { providers: unknown[] };
  raw.providers.push({ id: 'broken' });
  await fs.writeFile(file, JSON.stringify(raw, null, 2));
  await assert.rejects(models.list('alice'), /原文件已保留/);
  const disk = JSON.parse(await fs.readFile(file, 'utf8')) as { providers: { name?: string }[] };
  assert.equal(disk.providers[0].name, 'KeepMe');
  assert.equal(disk.providers.length, 2);
});

test('generation guard aborts A→B→A requests and refuses rename after switch', async t => {
  const root = await tempDir(t);
  const acc = { value: 'alice', gen: 0 };
  let flip = false;
  const models = service(root, {
    key: acc,
    generation: () => acc.gen,
    beforeCommit: () => { if (flip) acc.gen++; },
  });
  await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'KeepMe', key: SECRET }));
  flip = true;
  await assert.rejects(models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'ShouldFail' })), /账号已切换/);
  const disk = JSON.parse(await fs.readFile(models.configPath('alice'), 'utf8')) as { providers: { name: string }[] };
  assert.equal(disk.providers[0].name, 'KeepMe');

  acc.gen++;
  acc.value = 'alice';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const gated = await listen(t, async (_req, res) => {
    await gate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output_text: 'OK', status: 'completed' }));
  });
  acc.gen++;
  const racing = service(root, { key: acc, generation: () => acc.gen, vault: undefined });
  await racing.saveProvider('alice', saveInput({ baseURL: gated.origin, key: SECRET }));
  const inflight = racing.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID);
  acc.value = 'bob';
  acc.gen++;
  acc.value = 'alice';
  acc.gen++;
  racing.noteAccountChange();
  release();
  await assert.rejects(inflight, /账号已切换|已取消/);
});

test('fetch uses redirect error, bounded bodies, and Anthropic/Gemini same-origin pagination', async t => {
  const root = await tempDir(t);
  const inits: RequestInit[] = [];
  const { origin, captured } = await listen(t, (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/models' && url.searchParams.get('after_id') === 'a') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'b' }], has_more: false }));
      return;
    }
    if (url.pathname === '/models' && !url.searchParams.get('pageToken')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.headers['anthropic-version']) res.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'a' }], has_more: true, last_id: 'a' }));
      else res.end(JSON.stringify({ models: [{ name: 'models/one' }], nextPageToken: 'page-2' }));
      return;
    }
    if (url.searchParams.get('pageToken') === 'page-2') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'models/two' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output_text: 'OK', status: 'completed' }));
  });
  const realFetch = globalThis.fetch;
  const wrapped: typeof fetch = async (input, init) => {
    inits.push(init ?? {});
    return realFetch(input, init);
  };
  const anthropic = service(root, { fetch: wrapped });
  const saved = await anthropic.saveProvider('alice', {
    name: 'Anthropic',
    baseURL: origin,
    protocol: 'anthropic-messages',
    key: SECRET,
    models: [{ modelId: 'claude-x', displayName: 'Claude' }],
  });
  const listed = await anthropic.listRemoteModels('alice', saved.providers.find(item => item.name === 'Anthropic')!.id);
  assert.deepEqual(listed.map(item => item.id), ['a', 'b']);
  assert.ok(captured.some(item => item.url.includes('after_id=a')));
  assert.equal(inits[0].redirect, 'error');

  const gemini = service(root, { fetch: wrapped });
  const geminiSaved = await gemini.saveProvider('alice', {
    name: 'Gemini',
    baseURL: origin,
    protocol: 'gemini-generate-content',
    key: SECRET,
    models: [{ modelId: 'gemini-flash', displayName: 'G' }],
  });
  const geminiList = await gemini.listRemoteModels('alice', geminiSaved.providers.find(item => item.name === 'Gemini')!.id);
  assert.deepEqual(geminiList.map(item => item.id), ['models/one', 'models/two']);

  const huge = service(root, {
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-length': '2000000' } }),
  });
  await huge.saveProvider('alice', saveInput({ baseURL: origin, key: SECRET }));
  await assert.rejects(huge.testConnection('alice', BUILTIN_OPENCODE_GO_PROVIDER_ID), /过大/);
});

test('discovery does not overwrite hand-filled reasoning or limits', async t => {
  const root = await tempDir(t);
  const models = service(root);
  const saved = await models.saveProvider('alice', saveInput({
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: [{
      id: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID,
      modelId: OPENCODE_GO_MODEL_ID,
      displayName: '手填名称',
      contextWindow: 111,
      maxOutput: 22,
      reasoningLevelId: 'none',
    }],
  }));
  const next = await models.addDiscoveredModels('alice', saved.providers[0].id, [{
    id: OPENCODE_GO_MODEL_ID,
    name: '上游想覆盖',
    contextWindow: 999,
    maxOutput: 888,
    reasoning: { supported: true, efforts: ['max'] },
  }]);
  const builtin = next.providers[0].models.find(model => model.modelId === OPENCODE_GO_MODEL_ID)!;
  assert.equal(builtin.displayName, '手填名称');
  assert.equal(builtin.contextWindow, 111);
  assert.equal(builtin.reasoning.selection.levelId, 'none');
});

test('supported=true without efforts does not invent a ladder', async t => {
  const root = await tempDir(t);
  const models = service(root);
  const saved = await models.saveProvider('alice', {
    name: 'Plain',
    baseURL: 'https://example.invalid/v1',
    protocol: 'openai-responses',
    key: SECRET,
    models: [{ modelId: 'plain', displayName: 'Plain' }],
  });
  const model = saved.providers.find(item => item.name === 'Plain')!.models[0];
  assert.equal(model.reasoning.capability.supported, false);
  assert.deepEqual(model.reasoning.capability.levels.map(level => level.id), [VENDOR_DEFAULT_LEVEL_ID]);
  const added = await models.addDiscoveredModels('alice', saved.providers.find(item => item.name === 'Plain')!.id, [
    { id: 'declared-only', name: 'Declared', reasoning: { supported: true } },
  ]);
  const declared = added.providers.find(item => item.name === 'Plain')!.models.find(item => item.modelId === 'declared-only')!;
  assert.equal(declared.reasoning.capability.supported, true);
  assert.ok(!declared.reasoning.capability.levels.some(level => level.id === 'low' || level.id === 'medium' || level.id === 'high'));
});

test('Gemini budget and thinkingLevel are exclusive; Anthropic effort is output_config', async t => {
  const root = await tempDir(t);
  const { origin, captured } = await listen(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/messages') res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
    else res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }));
  });
  const models = service(root);
  const saved = await models.saveProvider('alice', {
    name: 'Think',
    baseURL: origin,
    protocol: 'gemini-generate-content',
    key: SECRET,
    models: [{
      modelId: 'gemini-flash',
      displayName: 'G',
      reasoningOverridden: true,
      reasoningLevelId: 'low',
      geminiMode: 'level',
      reasoningLevels: [
        { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'manual' },
        { id: 'low', label: '低', protocolValue: 'LOW', source: 'manual' },
        { id: 'budget', label: '预算', protocolValue: 'budget', source: 'manual' },
      ],
    }],
  });
  const gemini = saved.providers.find(item => item.name === 'Think')!;
  await models.testConnection('alice', gemini.id);
  const body = JSON.parse(captured.at(-1)!.body) as { generationConfig: { thinkingConfig: Record<string, unknown> } };
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, undefined);

  await assert.rejects(models.saveProvider('alice', {
    name: 'Claude',
    baseURL: origin,
    protocol: 'anthropic-messages',
    key: SECRET,
    models: [{ modelId: 'claude-x', displayName: 'C', reasoningLevelId: 'budget', reasoningBudgetTokens: 16, maxOutput: 100 }],
  }), /至少 1024/);

  const claude = await models.saveProvider('alice', {
    name: 'Claude',
    baseURL: origin,
    protocol: 'anthropic-messages',
    key: SECRET,
    models: [{
      modelId: 'claude-x',
      displayName: 'C',
      maxOutput: 4096,
      reasoningOverridden: true,
      reasoningLevelId: 'adaptive',
      reasoningOutputEffort: 'high',
      reasoningLevels: [
        { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'manual' },
        { id: 'adaptive', label: '自适应', protocolValue: 'adaptive', source: 'manual' },
      ],
    }],
  });
  const claudeId = claude.providers.find(item => item.name === 'Claude')!;
  await models.testConnection('alice', claudeId.id);
  const anthropic = JSON.parse(captured.find(item => item.url === '/messages')!.body) as { thinking?: { type: string }; output_config?: { effort: string }; max_tokens: number };
  assert.equal(anthropic.thinking?.type, 'adaptive');
  assert.equal(anthropic.output_config?.effort, 'high');
  assert.equal(anthropic.max_tokens, 4096);

  await assert.rejects(models.saveProvider('alice', {
    name: 'Small',
    baseURL: origin,
    protocol: 'anthropic-messages',
    key: SECRET,
    models: [{ modelId: 'c2', displayName: 'C2', maxOutput: 256, reasoningOverridden: true, reasoningLevelId: 'budget', reasoningBudgetTokens: 1024, reasoningLevels: [
      { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'manual' },
      { id: 'budget', label: '预算', protocolValue: 'enabled', source: 'manual' },
    ] }],
  }), /小于最大输出|不足以容纳/);
});

test('corrupt JSON is not seeded over and mutate stamp is taken before the queue', async t => {
  const root = await tempDir(t);
  const models = service(root);
  await models.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'KeepMe', key: SECRET }));
  const file = models.configPath('alice');
  await fs.writeFile(file, '{');
  await assert.rejects(models.list('alice'), /无法读取|原文件已保留/);
  assert.equal(await fs.readFile(file, 'utf8'), '{');
  await fs.rm(file);

  const acc = { gen: 0 };
  const queued = service(root, { generation: () => acc.gen });
  await queued.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'First', key: SECRET }));
  const pending = queued.saveProvider('alice', saveInput({ baseURL: 'https://opencode.ai/zen/go/v1', name: 'Second' }));
  acc.gen++;
  await assert.rejects(pending, /账号已切换/);
});

const SYNTHETIC_REASONING = 'SYNTHETIC_REASONING_MARKER';
const SYNTHETIC_OUTPUT = 'SYNTHETIC_ASSISTANT_OUTPUT';

function mixedPayload(protocol: ModelProtocol): unknown {
  if (protocol === 'openai-responses') {
    return {
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: SYNTHETIC_REASONING }], content: [{ type: 'output_text', text: SYNTHETIC_REASONING }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: SYNTHETIC_OUTPUT }] },
      ],
      output_text: SYNTHETIC_REASONING,
    };
  }
  if (protocol === 'openai-chat-completions') {
    return {
      choices: [{
        message: {
          content: [{ type: 'reasoning', text: SYNTHETIC_REASONING }, { type: 'text', text: SYNTHETIC_OUTPUT }],
          reasoning_content: SYNTHETIC_REASONING,
        },
      }],
    };
  }
  if (protocol === 'anthropic-messages') {
    return { content: [{ type: 'thinking', thinking: SYNTHETIC_REASONING, text: SYNTHETIC_REASONING }, { type: 'text', text: SYNTHETIC_OUTPUT }] };
  }
  return { candidates: [{ content: { parts: [{ text: SYNTHETIC_REASONING, thought: true }, { text: SYNTHETIC_OUTPUT }] } }] };
}

function onlyReasoningPayload(protocol: ModelProtocol): unknown {
  if (protocol === 'openai-responses') {
    return {
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: SYNTHETIC_REASONING }], content: [{ type: 'output_text', text: SYNTHETIC_REASONING }] }],
      output_text: SYNTHETIC_REASONING,
    };
  }
  if (protocol === 'openai-chat-completions') {
    return { choices: [{ message: { content: '', reasoning_content: SYNTHETIC_REASONING } }] };
  }
  if (protocol === 'anthropic-messages') {
    return { content: [{ type: 'thinking', thinking: SYNTHETIC_REASONING, text: SYNTHETIC_REASONING }] };
  }
  return { candidates: [{ content: { parts: [{ text: SYNTHETIC_REASONING, thought: true }] } }] };
}

test('connection test extracts only assistant text and rejects reasoning-only payloads', async t => {
  const root = await tempDir(t);
  const protocols: ModelProtocol[] = ['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'gemini-generate-content'];
  for (const protocol of protocols) {
    const { origin } = await listen(t, (req, res) => {
      const mixed = (req.url ?? '').includes('mixed');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mixed ? mixedPayload(protocol) : onlyReasoningPayload(protocol)));
    });
    const models = service(root);
    const mixedSaved = await models.saveProvider('alice', {
      name: protocol + '-mixed',
      baseURL: origin + '/mixed',
      protocol,
      key: SECRET,
      models: [{ modelId: protocol === 'gemini-generate-content' ? 'gemini-flash' : 'm', displayName: 'M' }],
    });
    const mixedId = mixedSaved.providers.find(item => item.name === protocol + '-mixed')!.id;
    const mixedResult = await models.testConnection('alice', mixedId);
    assert.equal(mixedResult.text, SYNTHETIC_OUTPUT, protocol);
    assert.equal(mixedResult.text.includes(SYNTHETIC_REASONING), false, protocol);
    const onlySaved = await models.saveProvider('alice', {
      name: protocol + '-only',
      baseURL: origin + '/only',
      protocol,
      key: SECRET,
      models: [{ modelId: protocol === 'gemini-generate-content' ? 'gemini-flash' : 'm', displayName: 'M' }],
    });
    const onlyId = onlySaved.providers.find(item => item.name === protocol + '-only')!.id;
    await assert.rejects(models.testConnection('alice', onlyId), error => {
      const message = (error as Error).message;
      assert.match(message, /最终文本/);
      assert.equal(message.includes(SYNTHETIC_REASONING), false);
      return true;
    });
  }
});

test('new provider can be saved without a placeholder model', async t => {
  const root = await tempDir(t);
  const models = service(root);
  const saved = await models.saveProvider('alice', {
    name: 'Empty',
    baseURL: 'https://example.com/v1',
    protocol: 'openai-responses',
    models: [],
  });
  const empty = saved.providers.find(item => item.name === 'Empty');
  assert.ok(empty);
  assert.equal(empty!.models.length, 0);
});

test('listRemoteModels uses selected model effective protocol and does not guess siblings', async t => {
  const root = await tempDir(t);
  const { origin, captured } = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'from-upstream' }] }));
  });
  const models = service(root);
  const saved = await models.saveProvider('alice', {
    name: 'DSH-like',
    baseURL: origin,
    key: SECRET,
    models: [
      { modelId: 'alias', displayName: 'Alias' },
      { modelId: 'canonical', displayName: 'Canonical', protocol: 'openai-responses' },
    ],
  });
  const provider = saved.providers.find(item => item.name === 'DSH-like')!;
  assert.equal(provider.protocol, undefined);
  const alias = provider.models.find(item => item.modelId === 'alias')!;
  const canonical = provider.models.find(item => item.modelId === 'canonical')!;
  await assert.rejects(models.listRemoteModels('alice', provider.id), /请选择协议/);
  assert.equal(captured.length, 0);
  await assert.rejects(models.listRemoteModels('alice', provider.id, { modelEntryId: alias.id }), /请选择协议/);
  assert.equal(captured.length, 0);
  const listed = await models.listRemoteModels('alice', provider.id, { modelEntryId: canonical.id });
  assert.equal(listed[0].id, 'from-upstream');
  assert.equal(captured.length, 1);
  const api = models.asRendererAPI();
  const viaApi = await api.listRemoteModels('alice', provider.id, { modelEntryId: canonical.id });
  assert.equal(viaApi[0].id, 'from-upstream');

  const withDefault = await models.saveProvider('alice', {
    name: 'HasDefault',
    baseURL: origin,
    protocol: 'openai-responses',
    key: SECRET,
    models: [{ modelId: 'm', displayName: 'M' }],
  });
  const listedDefault = await models.listRemoteModels('alice', withDefault.providers.find(item => item.name === 'HasDefault')!.id);
  assert.equal(listedDefault[0].id, 'from-upstream');
});

test('undeclared upstream protocol does not duplicate same modelId; explicit protocol still adds; repeat is idempotent', async t => {
  const root = await tempDir(t);
  const models = service(root);
  const saved = await models.saveProvider('alice', {
    name: 'DSH Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    key: SECRET,
    models: [{
      modelId: OPENCODE_GO_MODEL_ID,
      displayName: 'DeepSeek V4.1 Flash',
      protocol: 'openai-responses',
      contextWindow: 1048576,
      maxOutput: 8192,
      reasoningLevelId: 'low',
    }],
  });
  const provider = saved.providers.find(item => item.name === 'DSH Go')!;
  assert.equal(provider.protocol, undefined);
  const before = provider.models.filter(item => item.modelId === OPENCODE_GO_MODEL_ID);
  assert.equal(before.length, 1);
  const original = before[0];
  assert.equal(original.protocol, 'openai-responses');
  assert.equal(original.contextWindow, 1048576);
  assert.equal(original.maxOutput, 8192);
  assert.equal(original.reasoning.selection.levelId, 'low');

  const payload = [{ id: OPENCODE_GO_MODEL_ID, name: 'DeepSeek V4.1 Flash' }];
  const once = await models.addDiscoveredModels('alice', provider.id, payload);
  const afterOnce = once.providers.find(item => item.id === provider.id)!;
  assert.equal(afterOnce.models.filter(item => item.modelId === OPENCODE_GO_MODEL_ID).length, 1);
  const kept = afterOnce.models.find(item => item.modelId === OPENCODE_GO_MODEL_ID)!;
  assert.equal(kept.id, original.id);
  assert.equal(kept.protocol, 'openai-responses');
  assert.equal(kept.contextWindow, 1048576);
  assert.equal(kept.maxOutput, 8192);
  assert.equal(kept.reasoning.selection.levelId, 'low');

  const twice = await models.addDiscoveredModels('alice', provider.id, payload);
  assert.equal(twice.providers.find(item => item.id === provider.id)!.models.filter(item => item.modelId === OPENCODE_GO_MODEL_ID).length, 1);

  const withChat = await models.addDiscoveredModels('alice', provider.id, [{
    id: OPENCODE_GO_MODEL_ID,
    name: 'DeepSeek Chat',
    protocol: 'openai-chat-completions',
  }]);
  const dsh = withChat.providers.find(item => item.id === provider.id)!;
  const sameId = dsh.models.filter(item => item.modelId === OPENCODE_GO_MODEL_ID);
  assert.equal(sameId.length, 2);
  assert.ok(sameId.some(item => item.protocol === 'openai-responses' && item.contextWindow === 1048576));
  assert.ok(sameId.some(item => item.protocol === 'openai-chat-completions'));

  const other = await models.saveProvider('alice', {
    name: 'Other Go',
    baseURL: 'https://example.com/v1',
    protocol: 'openai-responses',
    key: SECRET,
    models: [{ modelId: OPENCODE_GO_MODEL_ID, displayName: 'Other copy' }],
  });
  const otherId = other.providers.find(item => item.name === 'Other Go')!.id;
  assert.ok(other.providers.find(item => item.id === provider.id)!.models.some(item => item.modelId === OPENCODE_GO_MODEL_ID));
  assert.ok(other.providers.find(item => item.id === otherId)!.models.some(item => item.modelId === OPENCODE_GO_MODEL_ID));
});


