import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ModelService } from './model-service.ts';
import {
  preferredModelIndex,
  providerOriginLabel,
  sameOptionalProtocol,
} from '../src/domain/models.ts';
import {
  beginFormWork,
  draftCapability,
  emptyModel,
  generationStillCurrent,
  indexAfterRefresh,
  isConnectionDirty,
  isProviderFormDirty,
  mergeDiscoveredDrafts,
  modelsFrom,
  persistShouldRefill,
  revalidateDraftLevel,
  savedProviderFromResult,
} from '../src/components/model-settings-logic.ts';
import type { ModelDraft } from '../src/components/model-settings-logic.ts';
import type { ModelConfigPublic, ModelProtocol, ProviderPublic } from '../src/domain/models.ts';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-model-ui-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function service(root: string, beforeCommit?: () => void) {
  return new ModelService({
    root,
    profileKey: () => 'alice',
    getVault: vault,
    beforeCommit,
  });
}

function providerFixture(over: Partial<ProviderPublic> & { models: ProviderPublic['models'] }): ProviderPublic {
  return {
    id: 'p1',
    name: 'Custom',
    baseURL: 'https://example.com/v1',
    hasKey: false,
    ...over,
  };
}

type Session = {
  formGen: { current: number };
  editRev: number;
  saving: boolean;
  formLocked: boolean;
  creating: boolean;
  selectedId?: string;
  name: string;
  baseURL: string;
  protocol: '' | ModelProtocol;
  keyInput: string;
  clearKey: boolean;
  models: ModelDraft[];
  modelIndex: number;
  config?: ModelConfigPublic;
};

function dirtyOf(session: Session, saved?: ProviderPublic) {
  return isProviderFormDirty(
    { name: session.name, baseURL: session.baseURL, protocol: session.protocol, keyInput: session.keyInput, clearKey: session.clearKey },
    session.models,
    session.creating ? undefined : saved,
  );
}

async function persistLikeUi(session: Session, api: ReturnType<ModelService['asRendererAPI']>) {
  if (session.saving) throw new Error('blocked by in-flight save');
  if (session.formLocked) throw new Error('form locked');
  const token = beginFormWork(session.formGen);
  const revision = session.editRev;
  const keep = session.models[session.modelIndex];
  session.saving = true;
  session.formLocked = true;
  try {
    const next = await api.saveProvider('alice', {
      id: session.creating ? undefined : session.selectedId,
      name: session.name,
      baseURL: session.baseURL,
      protocol: session.protocol || undefined,
      models: session.models.map(model => ({
        id: model.id,
        modelId: model.modelId,
        displayName: model.displayName,
        protocol: model.protocol || null,
      })),
    });
    if (!generationStillCurrent(token, session.formGen)) return;
    session.config = next;
    const provider = savedProviderFromResult(next, session.selectedId);
    session.creating = false;
    session.selectedId = provider?.id;
    session.keyInput = '';
    session.clearKey = false;
    if (!persistShouldRefill(revision, session.editRev)) return;
    if (!provider) return;
    session.name = provider.name;
    session.baseURL = provider.baseURL;
    session.protocol = provider.protocol ?? '';
    session.models = modelsFrom(provider);
    session.modelIndex = indexAfterRefresh(session.models, keep ?? {}, provider, next);
  } finally {
    if (generationStillCurrent(token, session.formGen)) {
      session.saving = false;
      session.formLocked = false;
    }
  }
}

test('empty protocol and saved undefined are not dirty; source labels and model index keep defaults only with a real relation', () => {
  assert.equal(sameOptionalProtocol('', undefined), true);
  assert.equal(sameOptionalProtocol('openai-responses', undefined), false);
  assert.equal(providerOriginLabel({ type: 'builtin', providerKey: 'opencode-go' }), '预置');
  assert.equal(providerOriginLabel({ type: 'dsh', providerKey: 'opencode-go' }), 'DSH导入');
  assert.equal(providerOriginLabel(undefined), '自定义');
  const models = [
    { id: 'a', modelId: 'first', protocol: '' as const },
    { id: 'b', modelId: 'second', protocol: 'openai-responses' as const },
  ];
  assert.equal(preferredModelIndex(models, { keepId: 'b' }), 1);
  assert.equal(preferredModelIndex(models, { keepModelId: 'second', keepProtocol: 'openai-responses' }), 1);
  assert.equal(preferredModelIndex(models, { providerId: 'p1', defaultProviderId: 'p1', defaultModelId: 'b' }), 1);
  assert.equal(preferredModelIndex(models, { providerId: 'p2', defaultProviderId: 'p1', defaultModelId: 'b' }), 0);
  const saved = providerFixture({
    protocol: undefined,
    models: [{
      id: 'a',
      modelId: 'first',
      displayName: 'First',
      contextWindowSource: 'missing',
      maxOutputSource: 'missing',
      reasoning: {
        capability: { supported: false, kind: 'none', levels: [{ id: 'vendor-default', label: '供应商默认', protocolValue: '', source: 'unverified' }], allowBudget: false, allowAdaptive: false, allowOff: false, allowIncludeThoughts: false, allowOutputEffort: false, outputEfforts: [], source: 'unverified', unverified: true },
        selection: { levelId: 'vendor-default', overridden: false },
      },
    }],
  });
  assert.equal(isConnectionDirty({ name: 'Custom', baseURL: 'https://example.com/v1', protocol: '', keyInput: '', clearKey: false }, saved), false);
  const drafts = modelsFrom(saved);
  assert.equal(isProviderFormDirty({ name: 'Custom', baseURL: 'https://example.com/v1', protocol: '', keyInput: '', clearKey: false }, drafts, saved), false);
  assert.equal(emptyModel().modelId, '');
});

test('capability follows the form protocol and URL, and protocol switch does not wipe manual efforts', () => {
  const saved = providerFixture({
    protocol: 'openai-responses',
    baseURL: 'https://opencode.ai/zen/go/v1',
    source: { type: 'builtin', providerKey: 'opencode-go' },
    models: [{
      id: 'm1',
      modelId: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      protocol: undefined,
      contextWindowSource: 'missing',
      maxOutputSource: 'missing',
      reasoning: {
        capability: {
          supported: true,
          kind: 'openai-effort',
          levels: [{ id: 'vendor-default', label: '供应商默认', protocolValue: '', source: 'preset' }, { id: 'high', label: '高', protocolValue: 'high', source: 'codex-verified' }],
          allowBudget: false,
          allowAdaptive: false,
          allowOff: true,
          allowIncludeThoughts: false,
          allowOutputEffort: false,
          outputEfforts: [],
          source: 'preset',
          unverified: true,
        },
        selection: { levelId: 'high', overridden: false },
      },
    }],
  });
  const draft: ModelDraft = { ...modelsFrom(saved)[0], customEfforts: ['none', 'xhigh'] };
  const goCap = draftCapability({ protocol: 'openai-responses', baseURL: 'https://opencode.ai/zen/go/v1', source: saved.source }, draft, saved.models[0], saved);
  assert.ok(goCap.levels.some(level => level.id === 'high'));
  const switched = draftCapability({ protocol: 'anthropic-messages', baseURL: 'https://example.com/v1', source: saved.source }, draft, saved.models[0], saved);
  assert.equal(switched.kind, 'anthropic-thinking');
  assert.ok(!switched.levels.some(level => level.id === 'high'));
  const manual: ModelDraft = { ...draft, reasoningOverridden: true, customEfforts: ['none', 'xhigh'], reasoningLevelId: 'xhigh' };
  const afterSwitch = revalidateDraftLevel({ protocol: 'openai-chat-completions', baseURL: 'https://example.com/v1' }, manual, saved.models[0], saved);
  assert.deepEqual(afterSwitch.customEfforts, ['none', 'xhigh']);
  assert.equal(afterSwitch.reasoningLevelId, 'xhigh');
});

test('consecutive save, empty models, identity bind and default keep the selected model', async t => {
  const root = await tempDir(t);
  const api = service(root).asRendererAPI();
  const created = await api.saveProvider('alice', {
    name: 'KeepIndex',
    baseURL: 'https://example.com/v1',
    protocol: 'openai-responses',
    models: [
      { modelId: 'first', displayName: 'First' },
      { modelId: 'second', displayName: 'Second' },
    ],
  });
  const provider = created.providers.find(item => item.name === 'KeepIndex')!;
  const second = provider.models.find(item => item.modelId === 'second')!;
  const session: Session = {
    formGen: { current: 0 },
    editRev: 0,
    saving: false,
    formLocked: false,
    creating: false,
    selectedId: provider.id,
    name: provider.name,
    baseURL: provider.baseURL,
    protocol: 'openai-responses',
    keyInput: '',
    clearKey: false,
    models: modelsFrom(provider),
    modelIndex: 1,
    config: created,
  };

  session.name = 'KeepIndex-1';
  session.editRev++;
  await persistLikeUi(session, api);
  assert.equal(session.saving, false);
  assert.equal(session.formLocked, false);
  assert.equal(session.models[session.modelIndex]?.id, second.id);
  const saved = session.config!.providers.find(item => item.id === session.selectedId)!;
  assert.equal(dirtyOf(session, saved), false);

  session.name = 'KeepIndex-2';
  session.editRev++;
  await persistLikeUi(session, api);
  assert.equal(session.saving, false);
  assert.equal(session.models[session.modelIndex]?.modelId, 'second');
  assert.equal(session.selectedId, provider.id);
  assert.equal((await api.list('alice')).providers.filter(item => item.id === provider.id).length, 1);

  session.models = [];
  session.modelIndex = 0;
  session.editRev++;
  await persistLikeUi(session, api);
  assert.equal(session.saving, false);
  assert.equal(session.models.length, 0);
  assert.equal(dirtyOf(session, session.config!.providers.find(item => item.id === session.selectedId)), false);

  const restored = await api.saveProvider('alice', {
    id: session.selectedId,
    name: 'KeepIndex-2',
    baseURL: 'https://example.com/v1',
    protocol: 'openai-responses',
    models: [
      { modelId: 'first', displayName: 'First' },
      { modelId: 'second', displayName: 'Second' },
    ],
  });
  const again = restored.providers.find(item => item.id === session.selectedId)!;
  session.models = modelsFrom(again);
  session.modelIndex = 1;
  session.config = restored;
  const currentId = session.models[1].id!;
  const afterDefault = await api.setDefault('alice', session.selectedId!, again.models[0].id);
  session.config = afterDefault;
  assert.equal(session.modelIndex, 1);
  assert.equal(session.models[session.modelIndex]?.id, currentId);
  assert.equal(afterDefault.defaultModelId, again.models[0].id);
});

test('create persist binds new provider id even if revision changes mid-save', async t => {
  const root = await tempDir(t);
  const bump = { value: 0 };
  const api = service(root, () => { bump.value++; }).asRendererAPI();
  const session: Session = {
    formGen: { current: 0 },
    editRev: 0,
    saving: false,
    formLocked: false,
    creating: true,
    selectedId: undefined,
    name: 'BrandNew',
    baseURL: 'https://example.com/v1',
    protocol: 'openai-responses',
    keyInput: '',
    clearKey: false,
    models: [],
    modelIndex: 0,
  };
  const token = beginFormWork(session.formGen);
  const revision = session.editRev;
  session.saving = true;
  session.formLocked = true;
  const next = await api.saveProvider('alice', {
    name: session.name,
    baseURL: session.baseURL,
    protocol: session.protocol || undefined,
    models: [],
  });
  session.editRev += bump.value;
  assert.equal(persistShouldRefill(revision, session.editRev), false);
  const provider = savedProviderFromResult(next, session.selectedId);
  session.creating = false;
  session.selectedId = provider?.id;
  if (generationStillCurrent(token, session.formGen)) {
    session.saving = false;
    session.formLocked = false;
  }
  assert.equal(session.creating, false);
  assert.ok(session.selectedId);
  const id = session.selectedId;
  session.name = 'BrandNew-2';
  session.editRev++;
  await persistLikeUi(session, api);
  assert.equal(session.selectedId, id);
  assert.equal((await api.list('alice')).providers.filter(item => item.name.startsWith('BrandNew')).length, 1);
});

test('discovered models merge into local drafts and do not overwrite dirty fields', () => {
  const current: ModelDraft[] = [
    { ...emptyModel(), id: 'keep', modelId: 'canonical', displayName: '手改名称', protocol: 'openai-responses' },
  ];
  const server: ModelDraft[] = [
    { ...emptyModel(), id: 'keep', modelId: 'canonical', displayName: '上游想覆盖', protocol: 'openai-responses' },
    { ...emptyModel(), id: 'new', modelId: 'extra', displayName: 'Extra', protocol: '' },
  ];
  const merged = mergeDiscoveredDrafts(current, server);
  assert.equal(merged.find(item => item.modelId === 'canonical')?.displayName, '手改名称');
  assert.ok(merged.some(item => item.modelId === 'extra'));
});

test('ModelSettings keeps provider hierarchy, locked save, and accessible model edit', async () => {
  const src = await fs.readFile(new URL('../src/components/ModelSettings.tsx', import.meta.url), 'utf8');
  assert.match(src, /fieldset className="model-detail-fields" disabled=\{saving\}/);
  assert.match(src, /保存供应商/);
  assert.match(src, /保存模型/);
  assert.match(src, /返回供应商/);
  assert.match(src, /此供应商的模型/);
  assert.match(src, /aria-label=\{`编辑\$\{model\.modelId \|\| label\}`\}/);
  assert.match(src, />编辑</);
  assert.match(src, /编辑 \$\{title\} \/ \$\{currentModelName\}/);
  assert.match(src, /setEditingOpen\(true\)/);
  assert.match(src, /onClose=\{\(\) => setEditingOpen\(false\)\}/);
  assert.match(src, /将删除供应商/);
  assert.match(src, /请先保存，再获取上游模型/);
  assert.match(src, /mergeDiscoveredDrafts/);
  assert.match(src, /savedProviderFromResult/);
  assert.doesNotMatch(src, /applyProviderAfterPersist/);
  assert.doesNotMatch(src, /has-editor/);
  const editorBlock = src.slice(src.lastIndexOf('className="model-editor"'));
  assert.doesNotMatch(editorBlock.slice(0, 2200), /删除供应商/);
  assert.doesNotMatch(editorBlock.slice(0, 2200), /API Key/);
  const css = await fs.readFile(new URL('../src/model-settings.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /minmax\(280px,360px\)/);
  assert.doesNotMatch(css, /min-width:640px/);
});
