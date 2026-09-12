import type {
  ModelProtocol,
  ModelPublic,
  ModelSource,
  ProviderPublic,
  ReasoningCapability,
  ReasoningLevel,
} from '../domain/models.ts';
import {
  VENDOR_DEFAULT_LEVEL_ID,
  effectiveProtocol,
  openaiEffortLevels,
  originOf,
  preferredModelIndex,
  reasoningCapabilityFor,
  sameOptionalProtocol,
} from '../domain/models.ts';

export type ModelDraft = {
  id?: string;
  modelId: string;
  displayName: string;
  protocol: '' | ModelProtocol;
  contextWindow: string;
  maxOutput: string;
  reasoningLevelId: string;
  reasoningBudget: string;
  reasoningAdaptive: boolean;
  reasoningIncludeThoughts: boolean;
  reasoningOverridden: boolean;
  customEfforts: string[];
  outputEffort: string;
  geminiMode: 'level' | 'budget' | '';
  contextWindowSource?: string;
  maxOutputSource?: string;
};

export type ProviderForm = {
  protocol?: ModelProtocol;
  baseURL: string;
  source?: ModelSource;
};

export type GenerationBox = { current: number };

export const OPENAI_MANUAL_EFFORTS = ['none', 'low', 'medium', 'high', 'max', 'minimal', 'xhigh'];

export function emptyModel(): ModelDraft {
  return {
    modelId: '',
    displayName: '',
    protocol: '',
    contextWindow: '',
    maxOutput: '',
    reasoningLevelId: VENDOR_DEFAULT_LEVEL_ID,
    reasoningBudget: '',
    reasoningAdaptive: false,
    reasoningIncludeThoughts: false,
    reasoningOverridden: false,
    customEfforts: [],
    outputEffort: '',
    geminiMode: '',
  };
}

export function modelsFrom(provider: ProviderPublic): ModelDraft[] {
  return provider.models.map(model => ({
    id: model.id,
    modelId: model.modelId,
    displayName: model.displayName,
    protocol: model.protocol ?? '',
    contextWindow: model.contextWindow?.toString() ?? '',
    maxOutput: model.maxOutput?.toString() ?? '',
    reasoningLevelId: model.reasoning.selection.levelId,
    reasoningBudget: model.reasoning.selection.budgetTokens?.toString() ?? '',
    reasoningAdaptive: model.reasoning.selection.adaptive === true,
    reasoningIncludeThoughts: model.reasoning.selection.includeThoughts === true,
    reasoningOverridden: model.reasoning.selection.overridden,
    customEfforts: model.reasoning.selection.overridden
      ? model.reasoning.capability.levels.map(level => level.id).filter(id => id !== VENDOR_DEFAULT_LEVEL_ID)
      : [],
    outputEffort: model.reasoning.selection.outputEffort ?? '',
    geminiMode: model.reasoning.selection.geminiMode ?? '',
    contextWindowSource: model.contextWindowSource,
    maxOutputSource: model.maxOutputSource,
  }));
}

export function draftCapability(
  form: ProviderForm,
  draft: ModelDraft,
  saved?: ModelPublic,
  savedProvider?: Pick<ProviderPublic, 'protocol' | 'baseURL'>,
): ReasoningCapability {
  const providerProtocol = form.protocol;
  const protocol = effectiveProtocol(providerProtocol, draft.protocol || undefined);
  if (draft.reasoningOverridden) {
    if (protocol === 'anthropic-messages') {
      const levels: ReasoningLevel[] = [
        { id: VENDOR_DEFAULT_LEVEL_ID, label: '供应商默认', protocolValue: '', source: 'manual' },
        { id: 'none', label: '关闭', protocolValue: 'disabled', source: 'manual' },
        { id: 'budget', label: '预算', protocolValue: 'enabled', source: 'manual' },
        { id: 'adaptive', label: '自适应', protocolValue: 'adaptive', source: 'manual' },
      ];
      return {
        supported: true,
        kind: 'anthropic-thinking',
        levels,
        allowBudget: true,
        allowAdaptive: true,
        allowOff: true,
        allowIncludeThoughts: false,
        allowOutputEffort: true,
        outputEfforts: openaiEffortLevels(['low', 'medium', 'high', 'max'], 'manual').filter(level => level.id !== VENDOR_DEFAULT_LEVEL_ID),
        source: 'manual',
        unverified: true,
      };
    }
    if (protocol === 'gemini-generate-content') {
      const declared = draft.customEfforts.length ? draft.customEfforts : [];
      return {
        supported: true,
        kind: 'gemini-thinking',
        levels: openaiEffortLevels(declared, 'manual').map(level => (
          level.id === 'none' ? { ...level, protocolValue: '0' } : { ...level, protocolValue: level.protocolValue.toUpperCase() }
        )),
        allowBudget: declared.includes('budget'),
        allowAdaptive: false,
        allowOff: declared.includes('none'),
        allowIncludeThoughts: true,
        allowOutputEffort: false,
        outputEfforts: [],
        source: 'manual',
        unverified: true,
      };
    }
    return {
      supported: true,
      kind: 'openai-effort',
      levels: openaiEffortLevels(draft.customEfforts, 'manual'),
      allowBudget: false,
      allowAdaptive: false,
      allowOff: draft.customEfforts.includes('none'),
      allowIncludeThoughts: false,
      allowOutputEffort: false,
      outputEfforts: [],
      source: 'manual',
      unverified: true,
    };
  }
  const canReuseStored = Boolean(
    saved
    && savedProvider
    && saved.modelId === draft.modelId
    && sameOptionalProtocol(saved.protocol, draft.protocol || undefined)
    && sameOptionalProtocol(form.protocol, savedProvider.protocol)
    && originOf(form.baseURL) === originOf(savedProvider.baseURL),
  );
  return reasoningCapabilityFor(
    form.source,
    form.baseURL,
    providerProtocol,
    draft.modelId,
    draft.protocol || undefined,
    canReuseStored ? saved?.reasoning.capability : undefined,
  );
}

export function revalidateDraftLevel(
  form: ProviderForm,
  draft: ModelDraft,
  saved?: ModelPublic,
  savedProvider?: Pick<ProviderPublic, 'protocol' | 'baseURL'>,
): ModelDraft {
  const next = { ...draft };
  const capability = draftCapability(form, next, saved, savedProvider);
  if (!next.reasoningOverridden && !capability.levels.some(level => level.id === next.reasoningLevelId)) {
    next.reasoningLevelId = VENDOR_DEFAULT_LEVEL_ID;
  }
  return next;
}

export function revalidateModels(
  form: ProviderForm,
  models: ModelDraft[],
  savedProvider?: ProviderPublic,
): ModelDraft[] {
  return models.map(model => revalidateDraftLevel(
    form,
    model,
    savedProvider?.models.find(item => item.id === model.id),
    savedProvider,
  ));
}

export function isConnectionDirty(
  form: { name: string; baseURL: string; protocol: '' | ModelProtocol; keyInput: string; clearKey: boolean },
  saved?: ProviderPublic,
): boolean {
  if (!saved) return Boolean(form.name.trim() || form.baseURL.trim() || form.protocol || form.keyInput.trim() || form.clearKey);
  return form.name !== saved.name
    || form.baseURL !== saved.baseURL
    || !sameOptionalProtocol(form.protocol, saved.protocol)
    || Boolean(form.keyInput.trim())
    || form.clearKey;
}

function modelFingerprint(model: ModelDraft) {
  return {
    id: model.id,
    modelId: model.modelId,
    displayName: model.displayName,
    protocol: model.protocol || '',
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    reasoningLevelId: model.reasoningLevelId,
    reasoningBudget: model.reasoningBudget,
    reasoningAdaptive: model.reasoningAdaptive,
    reasoningIncludeThoughts: model.reasoningIncludeThoughts,
    reasoningOverridden: model.reasoningOverridden,
    customEfforts: [...model.customEfforts].sort(),
    outputEffort: model.outputEffort,
    geminiMode: model.geminiMode || '',
  };
}

export function isModelsDirty(models: ModelDraft[], saved?: ProviderPublic): boolean {
  if (!saved) return models.length > 0;
  return JSON.stringify(models.map(modelFingerprint)) !== JSON.stringify(modelsFrom(saved).map(modelFingerprint));
}

export function isProviderFormDirty(
  form: { name: string; baseURL: string; protocol: '' | ModelProtocol; keyInput: string; clearKey: boolean },
  models: ModelDraft[],
  saved?: ProviderPublic,
): boolean {
  return isConnectionDirty(form, saved) || isModelsDirty(models, saved);
}

export function beginFormWork(gen: GenerationBox): number {
  return ++gen.current;
}

export function generationStillCurrent(token: number, gen: GenerationBox): boolean {
  return token === gen.current;
}

export function mergeDiscoveredDrafts(current: ModelDraft[], server: ModelDraft[]): ModelDraft[] {
  const have = new Set(current.map(model => `${model.modelId}\0${model.protocol || ''}`));
  const added = server.filter(model => model.modelId && !have.has(`${model.modelId}\0${model.protocol || ''}`));
  return [...current, ...added];
}

export function savedProviderFromResult(next: { providers: ProviderPublic[] }, selectedId?: string): ProviderPublic | undefined {
  return next.providers.find(item => item.id === selectedId) ?? next.providers.at(-1) ?? next.providers[0];
}

export function persistShouldRefill(revisionAtStart: number, revisionNow: number): boolean {
  return revisionAtStart === revisionNow;
}

export function indexAfterRefresh(
  models: ModelDraft[],
  keep: { id?: string; modelId?: string; protocol?: string | null },
  provider: ProviderPublic | undefined,
  defaults: { defaultProviderId?: string; defaultModelId?: string },
  firstEnter = false,
): number {
  return preferredModelIndex(models, {
    keepId: firstEnter ? undefined : keep.id,
    keepModelId: firstEnter ? undefined : keep.modelId,
    keepProtocol: firstEnter ? undefined : keep.protocol,
    providerId: provider?.id,
    defaultProviderId: defaults.defaultProviderId,
    defaultModelId: defaults.defaultModelId,
  });
}

export function effortOptionLabel(id: string) {
  return ({ none: '关闭', low: '低', medium: '中', high: '高', max: '最大', minimal: 'minimal', xhigh: 'xhigh', budget: '预算' } as Record<string, string>)[id] ?? id;
}
