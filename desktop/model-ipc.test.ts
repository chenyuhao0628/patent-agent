import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { WebContents } from 'electron';
import { ModelService } from './model-service.ts';
import {
  assertChosenDirectory, dispatchModelMethod, handleModelIpc, isModelIpcMethod, isModelWriteMethod,
  MODEL_WRITE_METHODS, ModelRequestRegistry, parseModelIpcRequest,
} from './model-ipc.ts';
import {
  BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID,
  BUILTIN_OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_MODEL_ID,
  OPENCODE_GO_V41_REASONING_LEVELS,
} from '../src/domain/models.ts';

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

test('IPC method whitelist excludes runtime credentials and marks writes', () => {
  assert.equal(isModelIpcMethod('resolveRuntimeConfig'), false);
  assert.equal(isModelIpcMethod('list'), true);
  assert.equal(isModelWriteMethod('saveProvider'), true);
  assert.equal(isModelWriteMethod('list'), false);
  assert.ok(MODEL_WRITE_METHODS.includes('importDshProvider'));
});

test('model IPC parser validates method, scoped arguments and request identity', () => {
  assert.deepEqual(parseModelIpcRequest('list', 'alice', [], undefined), {
    method: 'list', profileKey: 'alice', args: [], requestId: undefined,
  });
  assert.deepEqual(parseModelIpcRequest('previewDshProviders', '', ['/tmp/dsh']), {
    method: 'previewDshProviders', profileKey: '', args: ['/tmp/dsh'], requestId: undefined,
  });
  assert.deepEqual(parseModelIpcRequest('deleteProvider', 'alice', ['provider-1'], 'req-1'), {
    method: 'deleteProvider', profileKey: 'alice', args: ['provider-1'], requestId: 'req-1',
  });
  assert.doesNotThrow(() => parseModelIpcRequest('saveProvider', 'alice', [{
    name: 'x',
    baseURL: 'https://example.test',
    models: [{
      modelId: 'm',
      displayName: 'M',
      protocol: null,
      contextWindow: null,
      maxOutput: null,
      reasoningBudgetTokens: null,
      reasoningOutputEffort: null,
      geminiMode: null,
      reasoningLevels: [{
        id: 'low',
        label: '低',
        protocolValue: 'low',
        source: 'manual',
        hint: '测试级别',
      }],
    }],
  }]));
  assert.throws(() => parseModelIpcRequest('list', 'alice', ['extra']), /参数数量无效/);
  assert.throws(() => parseModelIpcRequest('saveProvider', 'alice', [{ name: 'x', baseURL: 'https://example.test', key: 1 }]), /模型密钥无效/);
  assert.throws(() => parseModelIpcRequest('addDiscoveredModels', 'alice', ['p', [{ id: 1 }]]), /远端模型标识无效/);
  assert.throws(() => parseModelIpcRequest('previewDshProviders', 'alice', ['/tmp/dsh'], ''), /请求标识无效/);
  assert.throws(() => parseModelIpcRequest('unknown', 'alice', []), /不支持的模型接口/);
  assert.throws(() => parseModelIpcRequest('list', '', []), /账号标识无效/);
});

test('request registry binds sender and rejects duplicate ids', () => {
  const registry = new ModelRequestRegistry();
  const first = registry.begin('req-1', 7, 'alice', 1);
  assert.equal(first.signal.aborted, false);
  assert.throws(() => registry.begin('req-1', 7, 'alice', 1), /重复/);
  assert.throws(() => registry.cancel('req-1', 8), /其他窗口/);
  registry.cancel('req-1', 7);
  assert.equal(first.signal.aborted, true);
  assert.equal(registry.has('req-1'), true);
  assert.throws(() => registry.begin('req-1', 7, 'alice', 1), /重复/);
  registry.finish('req-1', 'not-this-registration');
  assert.equal(registry.has('req-1'), true);
  registry.finish('req-1', first.registrationId);
  assert.equal(registry.has('req-1'), false);
  const second = registry.begin('req-1', 7, 'alice', 2);
  registry.finish('req-1', first.registrationId);
  assert.equal(registry.has('req-1'), true);
  registry.begin('req-2', 7, 'alice', 1);
  registry.abortAll();
  assert.equal(registry.has('req-2'), false);
  void second;
});

test('DSH paths must come from the native chooser; handleModelIpc isolates sender', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-model-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new ModelService({ root, profileKey: () => 'alice', generation: () => 3, getVault: vault });
  const chosen = new Set<string>();
  assert.throws(() => assertChosenDirectory('/not/chosen', chosen), /选择器/);
  const dsh = path.join(root, 'dsh');
  await fs.mkdir(dsh);
  chosen.add(path.resolve(dsh));
  assertChosenDirectory(dsh, chosen);

  const sender = { id: 11 } as WebContents;
  const host = {
    modelService: service,
    serial: async <T>(fn: () => Promise<T>) => fn(),
    isMainFrame: () => true,
    senderId: () => 11,
    getProfileKey: () => 'alice',
    getGeneration: () => 3,
    chosenDsh: chosen,
  };
  await assert.rejects(handleModelIpc(host, new ModelRequestRegistry(), sender, {}, 'resolveRuntimeConfig', 'alice', []), /不支持/);
  await assert.rejects(handleModelIpc(host, new ModelRequestRegistry(), sender, {}, 'previewDshProviders', 'alice', ['/tmp/random-dsh']), /选择器/);
  await handleModelIpc(host, new ModelRequestRegistry(), sender, {}, 'list', 'alice', []);
  const listed = await dispatchModelMethod(service, 'list', 'alice', []);
  assert.ok(listed && typeof listed === 'object');
});

test('Go v4.1 Responses high is Codex-verified on the exact preset only', () => {
  const high = OPENCODE_GO_V41_REASONING_LEVELS.find(level => level.id === 'high');
  assert.equal(high?.source, 'codex-verified');
  assert.match(high?.hint ?? '', /已实测/);
  assert.equal(OPENCODE_GO_V41_REASONING_LEVELS.find(level => level.id === 'low')?.source, 'codex-verified');
});

test('serial queue A-B-A rejects the captured IPC write; cancel keeps id until finish', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-model-ipc-aba-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const account = { key: 'alice', generation: 0 };
  const service = new ModelService({
    root,
    profileKey: () => account.key,
    generation: () => account.generation,
    getVault: vault,
  });
  let operations = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const run = operations.then(fn);
    operations = run.then(() => undefined, () => undefined);
    return run;
  };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocker = serial(() => gate);
  const sender = { id: 11 } as WebContents;
  const host = {
    modelService: service,
    serial,
    isMainFrame: () => true,
    senderId: () => 11,
    getProfileKey: () => account.key,
    getGeneration: () => account.generation,
    chosenDsh: new Set<string>(),
  };
  const registry = new ModelRequestRegistry();
  const pending = handleModelIpc(host, registry, sender, {}, 'saveProvider', 'alice', [{
    id: BUILTIN_OPENCODE_GO_PROVIDER_ID,
    name: 'FromStaleIpc',
    baseURL: 'https://opencode.ai/zen/go/v1',
    protocol: 'openai-responses',
    models: [{ id: BUILTIN_OPENCODE_GO_MODEL_ENTRY_ID, modelId: OPENCODE_GO_MODEL_ID, displayName: 'DeepSeek V4.1 Flash' }],
  }], 'ipc-write-1');
  account.key = 'bob';
  account.generation = 1;
  account.key = 'alice';
  account.generation = 2;
  release();
  await blocker;
  await assert.rejects(pending, /账号已切换/);
  const listed = await service.list('alice');
  assert.notEqual(listed.providers[0].name, 'FromStaleIpc');

  const cancelRegistry = new ModelRequestRegistry();
  const first = cancelRegistry.begin('same-id', 11, 'alice', 2);
  cancelRegistry.cancel('same-id', 11);
  assert.throws(() => cancelRegistry.begin('same-id', 11, 'alice', 2), /重复/);
  await assert.rejects(handleModelIpc(host, cancelRegistry, sender, {}, 'list', 'alice', [], 'same-id'), /重复/);
  cancelRegistry.finish('same-id', first.registrationId);
  const reused = cancelRegistry.begin('same-id', 11, 'alice', 2);
  cancelRegistry.finish('same-id', reused.registrationId);
});

test('listRemoteModels IPC forwards modelEntryId and keeps requestId generation guards', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-model-ipc-list-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured: string[] = [];
  const store = vault();
  const service = new ModelService({
    root,
    profileKey: () => 'alice',
    generation: () => 3,
    getVault: () => store,
    fetch: async (input) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: 'remote-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const saved = await service.saveProvider('alice', {
    name: 'NoDefault',
    baseURL: 'https://example.com/v1',
    key: 'sk-fake-test-key-do-not-leak',
    models: [
      { modelId: 'alias', displayName: 'Alias' },
      { modelId: 'canonical', displayName: 'Canonical', protocol: 'openai-responses' },
    ],
  });
  const provider = saved.providers.find(item => item.name === 'NoDefault')!;
  const canonical = provider.models.find(item => item.modelId === 'canonical')!;
  await assert.rejects(dispatchModelMethod(service, 'listRemoteModels', 'alice', [provider.id, {}]), /请选择协议/);
  assert.equal(captured.length, 0);
  const listed = await dispatchModelMethod(service, 'listRemoteModels', 'alice', [provider.id, { modelEntryId: canonical.id }]) as { id: string }[];
  assert.equal(listed[0].id, 'remote-1');
  assert.equal(captured.length, 1);

  const sender = { id: 11 } as WebContents;
  const host = {
    modelService: service,
    serial: async <T>(fn: () => Promise<T>) => fn(),
    isMainFrame: () => true,
    senderId: () => 11,
    getProfileKey: () => 'alice',
    getGeneration: () => 3,
    chosenDsh: new Set<string>(),
  };
  const registry = new ModelRequestRegistry();
  const viaIpc = await handleModelIpc(host, registry, sender, {}, 'listRemoteModels', 'alice', [provider.id, { modelEntryId: canonical.id }], 'list-req-1') as { id: string }[];
  assert.equal(viaIpc[0].id, 'remote-1');
  assert.equal(registry.has('list-req-1'), false);

  await assert.rejects(handleModelIpc(host, new ModelRequestRegistry(), sender, {}, 'listRemoteModels', 'bob', [provider.id, { modelEntryId: canonical.id }], 'list-req-2'), /账号已切换/);
});
