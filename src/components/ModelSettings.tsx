import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, FolderOpen, Plus, RefreshCw, Star, Trash2 } from 'lucide-react';
import { Modal, Note } from './Primitives.tsx';
import type { ModelAPI } from '../model-api.ts';
import type {
  DshProviderPreview,
  ModelConfigPublic,
  ModelProtocol,
  ProviderPublic,
  UpstreamModel,
} from '../domain/models.ts';
import {
  MODEL_PROTOCOLS,
  PROTOCOL_LABELS,
  VENDOR_DEFAULT_LEVEL_ID,
  effectiveProtocol,
  isModelProtocol,
  modelIdentityKey,
  openaiEffortLevels,
  originOf,
  protocolLabel,
  providerOriginLabel,
  sanitizeSelection,
} from '../domain/models.ts';
import {
  OPENAI_MANUAL_EFFORTS,
  beginFormWork,
  draftCapability,
  effortOptionLabel,
  emptyModel,
  generationStillCurrent,
  indexAfterRefresh,
  isProviderFormDirty,
  mergeDiscoveredDrafts,
  modelsFrom,
  persistShouldRefill,
  revalidateDraftLevel,
  revalidateModels,
  savedProviderFromResult,
  type ModelDraft,
} from './model-settings-logic.ts';
import '../model-settings.css';

type Notice = { type: 'saving' | 'success' | 'error'; text: string } | null;
type View = 'list' | 'create' | 'detail';

export function ModelSettings({
  api,
  profileKey,
  selectDshDirectory,
}: {
  api: ModelAPI;
  profileKey: string;
  selectDshDirectory?: () => Promise<string | null>;
}) {
  const apiRef = useRef(api);
  apiRef.current = api;
  const formGen = useRef(0);
  const editRev = useRef(0);
  const dshGen = useRef(0);
  const selectedModelKeyRef = useRef('');
  const pending = useRef<string[]>([]);
  const leaveNext = useRef<(() => void) | null>(null);
  const [config, setConfig] = useState<ModelConfigPublic | null>(null);
  const [view, setView] = useState<View>('list');
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [protocol, setProtocol] = useState<'' | ModelProtocol>('');
  const [keyInput, setKeyInput] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<ModelDraft[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [saveNotice, setSaveNotice] = useState<Notice>(null);
  const [testNotice, setTestNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [remote, setRemote] = useState<UpstreamModel[]>([]);
  const [pickedRemote, setPickedRemote] = useState<Record<string, boolean>>({});
  const [discoverError, setDiscoverError] = useState('');
  const [dshOpen, setDshOpen] = useState(false);
  const [dshDir, setDshDir] = useState('');
  const [dshList, setDshList] = useState<DshProviderPreview[]>([]);
  const [dshError, setDshError] = useState('');
  const [dshBusy, setDshBusy] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discoverDirtyOpen, setDiscoverDirtyOpen] = useState(false);
  const [editingOpen, setEditingOpen] = useState(false);
  const chooseDsh = selectDshDirectory ?? api.selectDshDirectory;
  const selected = creating ? undefined : config?.providers.find(provider => provider.id === selectedId);
  const currentModel = models[modelIndex];
  const formProvider = { protocol: protocol || undefined, baseURL, source: selected?.source };

  const abortPending = () => {
    const ids = pending.current;
    pending.current = [];
    for (const id of ids) void apiRef.current.cancelRequest(id).catch(() => undefined);
  };

  const trackRequest = () => {
    const id = crypto.randomUUID();
    pending.current.push(id);
    return id;
  };

  const resetBusy = () => {
    setSaving(false);
    setTesting(false);
    setDiscovering(false);
    setDshBusy(false);
    setDiscoverOpen(false);
    setDshOpen(false);
  };

  const markEdit = () => {
    editRev.current++;
    setSaveNotice(current => current?.type === 'success' ? null : current);
  };

  const discoveredAlreadyPresent = (item: UpstreamModel) => {
    const modelId = item.id.trim();
    if (!modelId) return true;
    const declared = item.protocol && isModelProtocol(item.protocol) ? item.protocol : undefined;
    const providerProtocol = protocol || selected?.protocol;
    if (!declared) return models.some(model => model.modelId === modelId);
    const identity = modelIdentityKey(modelId, effectiveProtocol(providerProtocol || undefined, declared));
    return models.some(model => modelIdentityKey(model.modelId, effectiveProtocol(providerProtocol || undefined, model.protocol || undefined)) === identity);
  };

  const fillProvider = (
    provider: ProviderPublic | undefined,
    opts?: {
      keepModel?: { id?: string; modelId?: string; protocol?: string | null };
      defaults?: { defaultProviderId?: string; defaultModelId?: string };
      firstEnter?: boolean;
    },
  ) => {
    setCreating(false);
    setSelectedId(provider?.id);
    setName(provider?.name ?? '');
    setBaseURL(provider?.baseURL ?? '');
    setProtocol(provider?.protocol ?? '');
    setKeyInput('');
    setClearKey(false);
    const nextModels = provider ? modelsFrom(provider) : [];
    setModels(nextModels);
    setModelIndex(indexAfterRefresh(nextModels, opts?.keepModel ?? {}, provider, opts?.defaults ?? {}, opts?.firstEnter));
    setTestNotice(null);
  };

  const resetForm = () => {
    setCreating(false);
    setSelectedId(undefined);
    setName('');
    setBaseURL('');
    setProtocol('');
    setKeyInput('');
    setClearKey(false);
    setModels([]);
    setModelIndex(0);
    setConnectionOpen(true);
    setSaveNotice(null);
    setTestNotice(null);
    setEditingOpen(false);
  };

  const load = async () => {
    const token = beginFormWork(formGen);
    try {
      const next = await apiRef.current.list(profileKey);
      if (!generationStillCurrent(token, formGen)) return;
      setConfig(next);
      setSaveNotice(null);
    } catch (error) {
      if (!generationStillCurrent(token, formGen)) return;
      setSaveNotice({ type: 'error', text: (error as Error).message });
    }
  };

  useEffect(() => {
    beginFormWork(formGen);
    abortPending();
    resetBusy();
    setConfig(null);
    setView('list');
    resetForm();
    setLeaveOpen(false);
    setDeleteOpen(false);
    setDiscoverDirtyOpen(false);
    dshGen.current++;
    void load();
    return () => {
      beginFormWork(formGen);
      dshGen.current++;
      abortPending();
    };
  }, [profileKey]);

  const dirty = isProviderFormDirty(
    { name, baseURL, protocol, keyInput, clearKey },
    models,
    creating ? undefined : selected,
  );

  const runOrConfirmLeave = (next: () => void) => {
    if ((view === 'detail' || view === 'create') && dirty) {
      leaveNext.current = next;
      setLeaveOpen(true);
      return;
    }
    next();
  };

  const confirmDiscard = () => {
    const next = leaveNext.current;
    leaveNext.current = null;
    setLeaveOpen(false);
    beginFormWork(formGen);
    abortPending();
    resetBusy();
    next?.();
  };

  const keepEditing = () => {
    leaveNext.current = null;
    setLeaveOpen(false);
  };

  const goList = () => {
    setView('list');
    resetForm();
  };

  const startCreate = () => {
    runOrConfirmLeave(() => {
      beginFormWork(formGen);
      abortPending();
      resetBusy();
      setView('create');
      setCreating(true);
      setSelectedId(undefined);
      setName('');
      setBaseURL('');
      setProtocol('');
      setKeyInput('');
      setClearKey(false);
      setModels([]);
      setModelIndex(0);
      setConnectionOpen(true);
      setEditingOpen(false);
      setSaveNotice(null);
      setTestNotice(null);
    });
  };

  const enterProvider = (provider: ProviderPublic) => {
    runOrConfirmLeave(() => {
      beginFormWork(formGen);
      abortPending();
      resetBusy();
      setView('detail');
      setConnectionOpen(false);
      setEditingOpen(false);
      setSaveNotice(null);
      fillProvider(provider, {
        firstEnter: true,
        defaults: { defaultProviderId: config?.defaultProviderId, defaultModelId: config?.defaultModelId },
      });
    });
  };

  const persist = async () => {
    if (saving) return;
    const token = beginFormWork(formGen);
    abortPending();
    const revision = editRev.current;
    const keepModel = currentModel
      ? { id: currentModel.id, modelId: currentModel.modelId, protocol: currentModel.protocol }
      : undefined;
    const wasCreating = creating;
    setSaving(true);
    setSaveNotice({ type: 'saving', text: '正在保存…' });
    try {
      const next = await apiRef.current.saveProvider(profileKey, {
        id: creating ? undefined : selectedId,
        name,
        baseURL,
        protocol: protocol || undefined,
        key: clearKey ? undefined : (keyInput.trim() || undefined),
        clearKey: clearKey || undefined,
        models: models.map(model => {
          const saved = selected?.models.find(item => item.id === model.id);
          const cap = draftCapability(formProvider, model, saved, selected);
          return {
            id: model.id,
            modelId: model.modelId,
            displayName: model.displayName,
            protocol: model.protocol || null,
            contextWindow: model.contextWindow.trim() ? Number(model.contextWindow) : undefined,
            maxOutput: model.maxOutput.trim() ? Number(model.maxOutput) : undefined,
            reasoningLevelId: model.reasoningLevelId,
            reasoningBudgetTokens: model.reasoningBudget.trim() ? Number(model.reasoningBudget) : undefined,
            reasoningAdaptive: model.reasoningAdaptive,
            reasoningIncludeThoughts: model.reasoningIncludeThoughts,
            reasoningOverridden: model.reasoningOverridden,
            reasoningLevels: model.reasoningOverridden ? cap.levels : undefined,
            reasoningOutputEffort: model.outputEffort || null,
            geminiMode: model.geminiMode || null,
          };
        }),
      });
      if (!generationStillCurrent(token, formGen)) return;
      setConfig(next);
      const provider = savedProviderFromResult(next, selectedId);
      setCreating(false);
      setSelectedId(provider?.id);
      setKeyInput('');
      setClearKey(false);
      setView('detail');
      if (!persistShouldRefill(revision, editRev.current)) {
        setSaveNotice({ type: 'success', text: '此前配置已保存；当前修改尚未保存。' });
        return;
      }
      fillProvider(provider, {
        keepModel,
        defaults: { defaultProviderId: next.defaultProviderId, defaultModelId: next.defaultModelId },
      });
      setConnectionOpen(wasCreating ? false : connectionOpen);
      setSaveNotice({ type: 'success', text: '当前账号的模型配置已保存。' });
    } catch (error) {
      if (!generationStillCurrent(token, formGen)) return;
      setSaveNotice({ type: 'error', text: (error as Error).message });
    } finally {
      if (generationStillCurrent(token, formGen)) setSaving(false);
    }
  };

  const removeProvider = async () => {
    if (!selectedId || creating || saving) return;
    const token = beginFormWork(formGen);
    abortPending();
    setSaving(true);
    try {
      const next = await apiRef.current.deleteProvider(profileKey, selectedId);
      if (!generationStillCurrent(token, formGen)) return;
      setConfig(next);
      setView('list');
      resetForm();
      setDeleteOpen(false);
      setSaveNotice({ type: 'success', text: '已删除供应商。' });
    } catch (error) {
      if (!generationStillCurrent(token, formGen)) return;
      setSaveNotice({ type: 'error', text: (error as Error).message });
    } finally {
      if (generationStillCurrent(token, formGen)) setSaving(false);
    }
  };

  const makeDefault = async (modelEntryId: string) => {
    if (!selectedId || creating) return;
    const token = formGen.current;
    try {
      const next = await apiRef.current.setDefault(profileKey, selectedId, modelEntryId);
      if (!generationStillCurrent(token, formGen)) return;
      setConfig(next);
    } catch (error) {
      if (!generationStillCurrent(token, formGen)) return;
      setSaveNotice({ type: 'error', text: (error as Error).message });
    }
  };

  const test = async () => {
    if (!selectedId || creating || testing) return;
    const token = formGen.current;
    const target = selectedModelKeyRef.current;
    const label = currentModel?.displayName || currentModel?.modelId || '当前模型';
    const modelId = currentModel?.id;
    setTesting(true);
    setTestNotice({ type: 'saving', text: `正在测试「${label}」的已保存配置…` });
    const requestId = trackRequest();
    try {
      const result = await apiRef.current.testConnection(profileKey, selectedId, { modelEntryId: modelId, requestId });
      if (!generationStillCurrent(token, formGen)) return;
      if (selectedModelKeyRef.current !== target) {
        setTestNotice(current => current?.type === 'saving' ? null : current);
        return;
      }
      const usage = result.usage
        ? [result.usage.inputTokens, result.usage.outputTokens, result.usage.totalTokens].filter(value => value !== undefined).join('/')
        : '';
      setTestNotice({ type: 'success', text: `「${label}」已保存配置返回「${result.text.slice(0, 80)}」${usage ? ` · usage ${usage}` : ''}` });
    } catch (error) {
      if (!generationStillCurrent(token, formGen)) return;
      if (selectedModelKeyRef.current !== target) {
        setTestNotice(current => current?.type === 'saving' ? null : current);
        return;
      }
      setTestNotice({ type: 'error', text: `「${label}」${(error as Error).message}` });
    } finally {
      if (generationStillCurrent(token, formGen)) setTesting(false);
    }
  };

  const openDiscover = async () => {
    if (!selectedId || creating) return;
    if (dirty) {
      setEditingOpen(false);
      setDiscoverDirtyOpen(true);
      return;
    }
    setEditingOpen(false);
    const frozenModelId = currentModel?.id;
    const canList = Boolean(selected?.protocol || (frozenModelId && selected?.models.find(item => item.id === frozenModelId && effectiveProtocol(selected.protocol, item.protocol))));
    setDiscoverOpen(true);
    setDiscovering(true);
    setDiscoverError('');
    setRemote([]);
    setPickedRemote({});
    if (!canList && !selected?.protocol) {
      setDiscovering(false);
      setDiscoverError('请选择协议。请先保存供应商默认协议，或打开一个已保存协议的模型后再获取。');
      return;
    }
    const token = formGen.current;
    const requestId = trackRequest();
    try {
      const list = await apiRef.current.listRemoteModels(profileKey, selectedId, {
        requestId,
        modelEntryId: frozenModelId,
      });
      if (!generationStillCurrent(token, formGen)) return;
      setRemote(list);
    } catch (error) {
      if (!generationStillCurrent(token, formGen)) return;
      setDiscoverError((error as Error).message);
    } finally {
      if (generationStillCurrent(token, formGen)) setDiscovering(false);
    }
  };

  const addDiscovered = async () => {
    if (!selectedId) return;
    const chosen = remote.filter(item => pickedRemote[item.id] && !discoveredAlreadyPresent(item));
    if (!chosen.length) {
      setDiscoverError('');
      setSaveNotice({ type: 'success', text: '所选模型均已存在，未新增。' });
      return;
    }
    const token = formGen.current;
    const keepModel = currentModel
      ? { id: currentModel.id, modelId: currentModel.modelId, protocol: currentModel.protocol }
      : undefined;
    const beforeIds = new Set((selected?.models ?? []).map(item => item.id));
    try {
      const next = await apiRef.current.addDiscoveredModels(profileKey, selectedId, chosen);
      if (!generationStillCurrent(token, formGen)) return;
      setConfig(next);
      const provider = next.providers.find(item => item.id === selectedId);
      const added = provider ? provider.models.filter(item => !beforeIds.has(item.id)).length : 0;
      if (provider) {
        const merged = mergeDiscoveredDrafts(models, modelsFrom(provider));
        setModels(merged);
        setModelIndex(indexAfterRefresh(merged, keepModel ?? {}, provider, next));
      }
      if (added === 0) {
        setSaveNotice({ type: 'success', text: '所选模型均已存在，未新增。' });
        return;
      }
      setDiscoverOpen(false);
      const skipped = chosen.length - added;
      setSaveNotice({
        type: 'success',
        text: skipped > 0
          ? `已添加 ${added} 个模型；${skipped} 个已存在，未重复添加。`
          : '已添加上游模型；已有手填内容未改动。',
      });
    } catch (error) {
      if (!generationStillCurrent(token, formGen)) return;
      setDiscoverError((error as Error).message);
    }
  };

  const closeDsh = () => {
    dshGen.current++;
    setDshOpen(false);
    setDshBusy(false);
    setDshList([]);
    setDshError('');
  };

  const openDsh = async () => {
    const token = ++dshGen.current;
    const profile = profileKey;
    setDshOpen(true);
    setDshError('');
    setDshList([]);
    if (!chooseDsh) {
      setDshError('需要由桌面程序提供目录选择。');
      return;
    }
    try {
      const dir = await chooseDsh();
      if (token !== dshGen.current || profile !== profileKey) return;
      if (!dir) { setDshOpen(false); return; }
      setDshDir(dir);
      const list = await apiRef.current.previewDshProviders(dir);
      if (token !== dshGen.current || profile !== profileKey) return;
      setDshList(list);
    } catch (error) {
      if (token !== dshGen.current || profile !== profileKey) return;
      setDshError((error as Error).message);
    }
  };

  const importDsh = async (providerKey: string) => {
    const token = dshGen.current;
    const profile = profileKey;
    setDshBusy(true);
    try {
      const next = await apiRef.current.importDshProvider(profileKey, dshDir, providerKey);
      if (token !== dshGen.current || profile !== profileKey) return;
      setConfig(next);
      const imported = next.providers.find(item => item.source?.type === 'dsh' && item.source.providerKey === providerKey);
      setDshOpen(false);
      setView('detail');
      setConnectionOpen(false);
      setEditingOpen(false);
      fillProvider(imported ?? next.providers.at(-1), {
        firstEnter: true,
        defaults: { defaultProviderId: next.defaultProviderId, defaultModelId: next.defaultModelId },
      });
      setSaveNotice({ type: 'success', text: '已导入指定供应商。默认模型未改写；请自行选择要使用的模型。' });
    } catch (error) {
      if (token !== dshGen.current || profile !== profileKey) return;
      setDshError((error as Error).message);
    } finally {
      if (token === dshGen.current) setDshBusy(false);
    }
  };

  const patchModel = (index: number, patch: Partial<ModelDraft>) => {
    markEdit();
    setModels(current => current.map((model, i) => {
      if (i !== index) return model;
      const next = { ...model, ...patch };
      if (patch.protocol !== undefined || patch.modelId !== undefined || patch.reasoningOverridden !== undefined) {
        return revalidateDraftLevel(formProvider, next, selected?.models.find(item => item.id === next.id), selected);
      }
      return next;
    }));
  };

  const changeProtocol = (next: '' | ModelProtocol) => {
    markEdit();
    setProtocol(next);
    setModels(current => revalidateModels({ ...formProvider, protocol: next || undefined }, current, selected));
  };

  const changeBaseURL = (next: string) => {
    markEdit();
    setBaseURL(next);
    setModels(current => revalidateModels({ ...formProvider, baseURL: next }, current, selected));
  };

  const hasKey = !!selected?.hasKey && !clearKey;
  const savedOrigin = selected ? originOf(selected.baseURL) : undefined;
  const draftOrigin = originOf(baseURL);
  const originChanged = Boolean(hasKey && savedOrigin && draftOrigin && savedOrigin !== draftOrigin);
  const defaultModelId = config?.defaultModelId;
  const defaultProviderId = config?.defaultProviderId;
  const savedModel = selected?.models.find(item => item.id === currentModel?.id);
  const capability = currentModel ? draftCapability(formProvider, currentModel, savedModel, selected) : undefined;
  const selection = currentModel && capability ? sanitizeSelection(capability, {
    levelId: currentModel.reasoningLevelId,
    budgetTokens: currentModel.reasoningBudget.trim() ? Number(currentModel.reasoningBudget) : undefined,
    adaptive: currentModel.reasoningAdaptive,
    includeThoughts: currentModel.reasoningIncludeThoughts,
    overridden: currentModel.reasoningOverridden,
    outputEffort: currentModel.outputEffort || undefined,
    geminiMode: currentModel.geminiMode || undefined,
  }) : undefined;
  const selectedLevel = capability?.levels.find(level => level.id === selection?.levelId);
  const unverified = !selectedLevel || selectedLevel.source === 'unverified' || selectedLevel.source === 'official-docs' || selectedLevel.source === 'dsh' || selectedLevel.source === 'upstream' || selectedLevel.source === 'manual' || selection?.levelId === VENDOR_DEFAULT_LEVEL_ID;
  const title = creating ? '新供应商' : (selected?.name || name || '供应商');
  selectedModelKeyRef.current = currentModel?.id ?? `idx-${modelIndex}`;
  const currentModelName = currentModel ? (currentModel.displayName || currentModel.modelId || '未命名模型') : '';

  const thinkingLabel = (model: ModelDraft) => {
    const cap = draftCapability(formProvider, model, selected?.models.find(item => item.id === model.id), selected);
    const sel = sanitizeSelection(cap, {
      levelId: model.reasoningLevelId,
      budgetTokens: model.reasoningBudget.trim() ? Number(model.reasoningBudget) : undefined,
      adaptive: model.reasoningAdaptive,
      includeThoughts: model.reasoningIncludeThoughts,
      overridden: model.reasoningOverridden,
      outputEffort: model.outputEffort || undefined,
      geminiMode: model.geminiMode || undefined,
    });
    return cap.levels.find(level => level.id === sel.levelId)?.label ?? '供应商默认';
  };

  const saveBar = (kind: 'provider' | 'connection' | 'models') => (
    <div className={`model-actions${kind === 'models' ? ' is-nearby' : ''}`}>
      <button className="primary" type="button" disabled={saving} onClick={() => void persist()}>
        {saving ? '正在保存…' : kind === 'connection' ? '保存连接' : kind === 'models' ? '保存模型' : '保存供应商'}
      </button>
      {kind === 'provider' && !creating && selectedId && <button type="button" disabled={testing} onClick={() => void test()}>{testing ? '正在测试…' : '测试已保存配置'}</button>}
      {saveNotice && !(saveNotice.type === 'success' && dirty) && <span className={`model-notice is-${saveNotice.type}`} role={saveNotice.type === 'error' ? 'alert' : 'status'}>{saveNotice.type === 'success' && <Check size={14}/>}{saveNotice.text}</span>}
      {testNotice && kind === 'provider' && <span className={`model-notice is-${testNotice.type}`} role={testNotice.type === 'error' ? 'alert' : 'status'}>{testNotice.text}</span>}
    </div>
  );

  const connectionFields = (
    <>
      <label className="field">名称<input value={name} onChange={e => { markEdit(); setName(e.target.value); }} placeholder="例如 OpenCode Go"/></label>
      <div className="model-field-row">
        <label className="field">API 地址<input value={baseURL} onChange={e => changeBaseURL(e.target.value)} placeholder="https://host/v1" spellCheck={false}/></label>
        <label className="field">默认协议
          <select value={protocol} onChange={e => changeProtocol(e.target.value as '' | ModelProtocol)}>
            <option value="">待选择</option>
            {MODEL_PROTOCOLS.map(item => <option key={item} value={item}>{PROTOCOL_LABELS[item]}</option>)}
          </select>
          <small>未单独指定协议的模型使用此项。个别模型可覆盖。</small>
        </label>
      </div>
      <label className="field">API Key
        <input type="password" value={keyInput} onChange={e => { markEdit(); setKeyInput(e.target.value); setClearKey(false); }} autoComplete="off" placeholder={hasKey ? '已保存密钥，输入新密钥将替换' : '输入 API Key'}/>
        <span className="model-key-hint">{hasKey ? '不会回显已保存的密钥。留空并保存表示保持原密钥。' : '密钥加密后写入本机当前账号配置，不进入工作区或共享目录。'}</span>
      </label>
      {selected?.hasKey && <label className="checkbox"><input type="checkbox" checked={clearKey} onChange={e => { markEdit(); setClearKey(e.target.checked); if (e.target.checked) setKeyInput(''); }}/>清除已保存密钥</label>}
      {originChanged && <p className="model-key-warning" role="status">地址来源已改变，仍将使用已保存的密钥。请确认新源可用该密钥，或勾选清除后重新填写。</p>}
    </>
  );

  return <div className="model-settings">
    {view === 'list' ? <>
      <div className="section-heading">
        <div>
          <h2>模型服务</h2>
          <p className="muted">先选择或添加供应商，再管理其下的模型。密钥只在保存时提交，不回显。</p>
        </div>
        <div className="model-heading-actions">
          <button type="button" onClick={startCreate}><Plus size={14}/>添加供应商</button>
          <button type="button" onClick={() => void openDsh()}><FolderOpen size={15}/>从 DSH 导入</button>
        </div>
      </div>
      {saveNotice && view === 'list' && <p className={`model-notice is-${saveNotice.type}`} role={saveNotice.type === 'error' ? 'alert' : 'status'}>{saveNotice.text}</p>}
      {!config?.providers.length ? <div className="model-empty">还没有供应商。请先添加连接信息。</div> : <ul className="model-provider-list">
        {config.providers.map(provider => {
          const isDefault = provider.id === defaultProviderId;
          return <li key={provider.id}>
            <button type="button" className="model-provider-row" onClick={() => enterProvider(provider)}>
              <span className="model-provider-main">
                <b>{provider.name}</b>
                <small>
                  <em className="model-origin">{providerOriginLabel(provider.source)}</em>
                  <span>{provider.models.length} 个模型</span>
                  {isDefault && <span className="is-default">默认</span>}
                </small>
              </span>
              <span className="model-provider-enter">进入</span>
            </button>
          </li>;
        })}
      </ul>}
    </> : <fieldset className="model-detail-fields" disabled={saving}>
      <div className="model-detail-head">
        <button type="button" className="text-button model-back" onClick={() => runOrConfirmLeave(() => { beginFormWork(formGen); abortPending(); resetBusy(); goList(); })}>
          <ArrowLeft size={15}/>返回供应商
        </button>
        <div className="model-detail-head-row">
          <div>
            <h2>{title}</h2>
            <p className="muted">{creating ? '先填写名称、地址、密钥和默认协议并保存连接，然后再添加模型。' : '连接信息与此供应商的模型。'}</p>
          </div>
          <div className="model-heading-actions"><button type="button" onClick={startCreate} disabled={saving}><Plus size={14}/>添加其他供应商</button>{!creating && selectedId && <button type="button" disabled={saving} onClick={() => setDeleteOpen(true)}><Trash2 size={14}/>删除供应商</button>}</div>
        </div>
      </div>

      <section className="model-block">
        <div className="model-block-head">
          <h3>连接</h3>
          {!creating && <button type="button" className="text-button" onClick={() => setConnectionOpen(open => !open)}>
            {connectionOpen ? '收起' : '编辑连接'} <ChevronDown size={14} className={connectionOpen ? 'is-open' : ''}/>
          </button>}
        </div>
        {!creating && !connectionOpen ? <div className="model-connection-summary">
          <div><span>地址</span><b>{baseURL || '未填写'}</b></div>
          <div><span>默认协议</span><b>{protocolLabel(protocol || undefined)}</b></div>
          <div><span>密钥</span><b>{hasKey ? '已保存' : '未保存'}</b></div>
        </div> : connectionFields}
        {dirty && !creating && <p className="model-dirty-hint">有未保存修改。连接测试只使用已保存的地址、协议、模型和思考档位。</p>}
        {creating && saveBar('connection')}
      </section>

      {creating ? <Note>保存连接后即可为此供应商添加模型，或从上游获取。不会预先创建空白模型。</Note> : <section className="model-block">
        <div className="model-block-head">
          <div>
            <h3>此供应商的模型</h3>
            <p className="muted">协议未填写时沿用上方供应商默认协议。</p>
          </div>
          <div className="model-heading-actions">
            <button type="button" onClick={() => { markEdit(); setModels(current => [...current, emptyModel()]); setModelIndex(models.length); setEditingOpen(true); }}><Plus size={14}/>添加模型</button>
            <button type="button" disabled={!selectedId} onClick={() => void openDiscover()}><RefreshCw size={14}/>从上游获取</button>
          </div>
        </div>
        {models.length === 0 ? <div className="model-empty">还没有模型。可手填或从上游列表添加。空列表也可以保存。</div> : <div className="model-table-wrap">
            <table className="model-table">
              <thead>
                <tr>
                  <th>模型 ID</th>
                  <th>协议</th>
                  <th>上下文</th>
                  <th>最大输出</th>
                  <th>思考</th>
                  <th>默认</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model, index) => {
                  const isDefault = Boolean(model.id && selectedId && defaultProviderId === selectedId && defaultModelId === model.id);
                  const rowProtocol = effectiveProtocol(protocol || undefined, model.protocol || undefined);
                  const label = model.displayName || model.modelId || '未命名模型';
                  return <tr key={model.id ?? `new-${index}`} className={index === modelIndex ? 'active' : ''} onClick={() => setModelIndex(index)}>
                    <td>
                      <b>{model.modelId || '未填写 ID'}</b>
                      {model.displayName && model.displayName !== model.modelId && <small>{model.displayName}</small>}
                    </td>
                    <td>{protocolLabel(rowProtocol)}{!model.protocol && <small>供应商默认</small>}</td>
                    <td>{model.contextWindow || '—'}</td>
                    <td>{model.maxOutput || '—'}</td>
                    <td>{thinkingLabel(model)}</td>
                    <td>{isDefault ? '默认' : ''}</td>
                    <td><button type="button" className="text-button model-edit" aria-label={`编辑${model.modelId || label}`} onClick={e => { e.stopPropagation(); setModelIndex(index); setEditingOpen(true); }}>编辑</button></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>}
        <Note>未声明协议显示待选择。导入保留原模型 ID；OpenCode Go 另提供已确认的 deepseek-v4.1-flash。</Note>
      </section>}
      {!creating && saveBar('provider')}
    </fieldset>}

    {editingOpen && currentModel && <Modal title={`编辑 ${title} / ${currentModelName}`} onClose={() => setEditingOpen(false)}>
      <fieldset className="model-detail-fields" disabled={saving}>
      <div className="model-editor">
        <p className="muted">修改保留在此供应商草稿中。关闭后回到模型表格，不会丢掉其他未保存模型。返回供应商列表时如有未保存修改会再确认。</p>
        <label className="field">显示名<input value={currentModel.displayName} onChange={e => patchModel(modelIndex, { displayName: e.target.value })} placeholder="显示名称"/></label>
        <label className="field">模型 ID<input value={currentModel.modelId} onChange={e => patchModel(modelIndex, { modelId: e.target.value })} placeholder="上游模型 ID" spellCheck={false}/></label>
        <div className="model-field-row">
          <label className="field">上下文窗口
            <input inputMode="numeric" value={currentModel.contextWindow} onChange={e => patchModel(modelIndex, { contextWindow: e.target.value })} placeholder="正整数"/>
            {!currentModel.contextWindow && <small>上游未提供</small>}
          </label>
          <label className="field">最大输出
            <input inputMode="numeric" value={currentModel.maxOutput} onChange={e => patchModel(modelIndex, { maxOutput: e.target.value })} placeholder="正整数，且不能大于上下文"/>
            {!currentModel.maxOutput && <small>上游未提供</small>}
          </label>
        </div>
        <label className="field">此模型的协议
          <select value={currentModel.protocol} onChange={e => patchModel(modelIndex, { protocol: e.target.value as ModelDraft['protocol'] })}>
            <option value="">使用供应商默认（{protocolLabel(protocol || undefined)}）</option>
            {MODEL_PROTOCOLS.map(item => <option key={item} value={item}>{PROTOCOL_LABELS[item]}</option>)}
          </select>
        </label>
        <div className="model-thinking">
          <h4>思考等级{unverified && <span className="model-thinking-badge is-unverified">待核验</span>}</h4>
          <p className="muted">{capability?.disabledReason || '仅列出该模型已声明的档位。'}</p>
          <label className="field">档位
            <select
              value={selection?.levelId ?? VENDOR_DEFAULT_LEVEL_ID}
              disabled={!capability?.supported && !currentModel.reasoningOverridden && (capability?.levels.length ?? 0) <= 1}
              onChange={e => patchModel(modelIndex, { reasoningLevelId: e.target.value })}
            >
              {(capability?.levels ?? []).map(level => <option key={level.id} value={level.id}>{level.label}</option>)}
            </select>
          </label>
          {selectedLevel?.hint && <p className="model-effort-help">{selectedLevel.hint}</p>}
          <details className="model-advanced">
            <summary>高级思考参数</summary>
            {capability?.kind === 'gemini-thinking' && capability.allowBudget && <label className="field">Gemini 思考方式
              <select value={currentModel.geminiMode} onChange={e => patchModel(modelIndex, { geminiMode: e.target.value as ModelDraft['geminiMode'], reasoningLevelId: e.target.value === 'budget' ? 'budget' : currentModel.reasoningLevelId === 'budget' ? VENDOR_DEFAULT_LEVEL_ID : currentModel.reasoningLevelId })}>
                <option value="">供应商默认</option>
                <option value="level">thinkingLevel</option>
                <option value="budget">thinkingBudget</option>
              </select>
            </label>}
            {capability?.allowBudget && (selection?.levelId === 'budget' || currentModel.geminiMode === 'budget') && <label className="field">思考预算
              <input inputMode="numeric" value={currentModel.reasoningBudget} onChange={e => patchModel(modelIndex, { reasoningBudget: e.target.value })} placeholder="至少 1024，且小于最大输出"/>
            </label>}
            {capability?.allowAdaptive && <label className="checkbox"><input type="checkbox" checked={currentModel.reasoningAdaptive} onChange={e => patchModel(modelIndex, { reasoningAdaptive: e.target.checked, reasoningLevelId: e.target.checked ? 'adaptive' : currentModel.reasoningLevelId })}/>自适应思考</label>}
            {capability?.allowOutputEffort && <label className="field">输出 effort
              <select value={currentModel.outputEffort} onChange={e => patchModel(modelIndex, { outputEffort: e.target.value })}>
                <option value="">不发送</option>
                {(capability.outputEfforts.length ? capability.outputEfforts : openaiEffortLevels(['low', 'medium', 'high', 'max'], 'manual').filter(level => level.id !== VENDOR_DEFAULT_LEVEL_ID)).map(level => <option key={level.id} value={level.id}>{level.label}</option>)}
              </select>
            </label>}
            {capability?.allowIncludeThoughts && <label className="checkbox"><input type="checkbox" checked={currentModel.reasoningIncludeThoughts} onChange={e => patchModel(modelIndex, { reasoningIncludeThoughts: e.target.checked })}/>包含思考内容</label>}
            <label className="checkbox"><input type="checkbox" checked={currentModel.reasoningOverridden} onChange={e => patchModel(modelIndex, { reasoningOverridden: e.target.checked, customEfforts: [] })}/>手动声明思考档位</label>
            {currentModel.reasoningOverridden && capability?.kind !== 'anthropic-thinking' && <div className="model-override">
              {(capability?.kind === 'gemini-thinking' ? [...OPENAI_MANUAL_EFFORTS, 'budget'] : OPENAI_MANUAL_EFFORTS).map(id => <label key={id}><input type="checkbox" checked={currentModel.customEfforts.includes(id)} onChange={e => {
                const next = e.target.checked ? [...currentModel.customEfforts, id] : currentModel.customEfforts.filter(item => item !== id);
                patchModel(modelIndex, { customEfforts: next });
              }}/>{effortOptionLabel(id)}</label>)}
            </div>}
          </details>
        </div>
        <div className="model-editor-actions">
          {currentModel.id && selectedId && <button type="button" onClick={() => void makeDefault(currentModel.id!)}>{defaultProviderId === selectedId && defaultModelId === currentModel.id ? <><Star size={14}/>当前默认</> : '设为默认模型'}</button>}
          <button type="button" onClick={() => { markEdit(); setModels(current => current.filter((_, i) => i !== modelIndex)); setModelIndex(index => Math.max(0, index - 1)); setEditingOpen(false); }}>移除此模型</button>
          <button type="button" onClick={() => setEditingOpen(false)}>关闭</button>
        </div>
        {saveBar('models')}
      </div>
      </fieldset>
    </Modal>}

    {discoverDirtyOpen && <Modal title="请先保存" onClose={() => setDiscoverDirtyOpen(false)}>
      <p>当前供应商有未保存修改。请先保存，再获取上游模型。获取不会自动保存，也不会覆盖已有手填内容。</p>
      <div className="action-bar">
        <button type="button" onClick={() => setDiscoverDirtyOpen(false)}>继续编辑</button>
      </div>
    </Modal>}
    {deleteOpen && <Modal title="删除供应商" onClose={() => setDeleteOpen(false)}>
      <p>将删除供应商「{title}」及其 {models.length} 个模型。此操作不能恢复。</p>
      <div className="action-bar">
        <button type="button" onClick={() => setDeleteOpen(false)}>取消</button>
        <button className="primary" type="button" disabled={saving} onClick={() => void removeProvider()}>确认删除</button>
      </div>
    </Modal>}
    {leaveOpen && <Modal title="有未保存的修改" onClose={keepEditing}>
      <p>离开前请选择：继续留在此页编辑，或放弃这次未保存的修改。</p>
      <div className="action-bar">
        <button type="button" onClick={keepEditing}>继续编辑</button>
        <button className="primary" type="button" onClick={confirmDiscard}>放弃修改</button>
      </div>
    </Modal>}
    {discoverOpen && <Modal title="上游模型" onClose={() => setDiscoverOpen(false)}>
      <p>{discovering ? '正在获取…' : '勾选后添加尚未保存的模型。未声明协议且已有相同 ID 的条目视为已存在。'}</p>
      {discoverError && <p className="inline-warning" role="alert">{discoverError} 仍可关闭后手工填写。</p>}
      <div className="model-discover-list">
        {remote.map(item => {
          const exists = discoveredAlreadyPresent(item);
          return <label key={item.id + (item.protocol ?? '')}>
            <input type="checkbox" disabled={exists} checked={!exists && !!pickedRemote[item.id]} onChange={e => setPickedRemote(current => ({ ...current, [item.id]: e.target.checked }))}/>
            <span>
              <b>{item.name || item.id}</b>
              <small>
                {item.id}
                {exists ? ' · 已存在' : ''}
                {item.protocol ? ` · ${protocolLabel(item.protocol)}` : ''}
                {item.contextWindow ? ` · 上下文 ${item.contextWindow}` : ' · 上下文 上游未提供'}
                {item.maxOutput ? ` · 输出 ${item.maxOutput}` : ' · 输出 上游未提供'}
                {item.reasoning?.efforts?.length ? ` · 思考 ${item.reasoning.efforts.join('/')}` : ''}
              </small>
            </span>
          </label>;
        })}
        {!discovering && !remote.length && !discoverError && <p className="muted">上游未返回模型。</p>}
      </div>
      <div className="action-bar">
        <button type="button" onClick={() => setDiscoverOpen(false)}>取消</button>
        <button className="primary" type="button" disabled={!remote.some(item => pickedRemote[item.id] && !discoveredAlreadyPresent(item))} onClick={() => void addDiscovered()}>添加所选</button>
      </div>
    </Modal>}
    {dshOpen && <Modal title="从 DSH 导入" onClose={closeDsh}>
      <p>只导入你指定的供应商。会保留其显式的协议、限额和思考声明；不会改写当前默认模型。</p>
      {dshDir && <p className="muted">目录已选择（本机导入）。</p>}
      {dshError && <p className="inline-warning" role="alert">{dshError}</p>}
      <div className="model-dsh-list">
        {dshList.map(item => <button key={item.providerKey} type="button" disabled={dshBusy} onClick={() => void importDsh(item.providerKey)}>
          <span>
            <b>{item.displayName}</b>
            <small>{item.providerKey} · {item.models.map(model => model.id).join('、') || '无模型'}</small>
          </span>
          <span>导入</span>
        </button>)}
      </div>
      {!dshList.length && !dshError && <p className="muted">没有可导入的供应商。</p>}
    </Modal>}
  </div>;
}
