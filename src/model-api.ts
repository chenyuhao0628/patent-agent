import type {
  ConnectionTestResult,
  DshProviderPreview,
  ModelConfigPublic,
  ProviderSaveInput,
  UpstreamModel,
} from './domain/models.ts';

export const MODEL_API_CONTRACT_VERSION = 1 as const;
export type {
  ConnectionTestResult,
  DshImportedModel,
  DshProviderPreview,
  LimitSource,
  ModelConfigPublic,
  ModelProtocol,
  ModelPublic,
  ModelSaveInput,
  ModelSource,
  ProviderPublic,
  ProviderSaveInput,
  ReasoningCapability,
  ReasoningCapabilitySource,
  ReasoningKind,
  ReasoningLevel,
  ReasoningPublic,
  ReasoningSelection,
  UpstreamModel,
  UpstreamReasoning,
} from './domain/models.ts';

/**
 * 渲染进程 / 设置页使用的模型配置 API。
 * 由桌面主进程实现并经 IPC 注入；本模块不创建 IPC，也不包含密钥或运行时凭证。
 *
 * Codex 接线：
 * - 主进程持有 ModelService，仅把 asRendererAPI() 的方法挂到 preload。
 * - resolveRuntimeConfig 只留在主进程，供 agent 调用，不要暴露到 DesktopAPI / window。
 * - 构造 ModelService 时传入 generation: () => service.generation；service.changed 调用 noteAccountChange。
 * - 渲染进程用 requestId + cancelRequest，不要传 AbortSignal。
 * - resolveRuntimeConfig 只留在主进程，不要暴露到 DesktopAPI / window。
 * - selectDshDirectory 由系统目录选择器实现；preview/import 仅接受本次选中的路径。
 */
export type ModelAPI = {
  list(profileKey: string): Promise<ModelConfigPublic>;
  saveProvider(profileKey: string, input: ProviderSaveInput): Promise<ModelConfigPublic>;
  deleteProvider(profileKey: string, providerId: string): Promise<ModelConfigPublic>;
  setDefault(profileKey: string, providerId: string, modelEntryId: string): Promise<ModelConfigPublic>;
  testConnection(profileKey: string, providerId: string, opts?: { modelEntryId?: string; requestId?: string }): Promise<ConnectionTestResult>;
  listRemoteModels(profileKey: string, providerId: string, opts?: { modelEntryId?: string; requestId?: string }): Promise<UpstreamModel[]>;
  addDiscoveredModels(profileKey: string, providerId: string, models: UpstreamModel[]): Promise<ModelConfigPublic>;
  previewDshProviders(dshDir: string): Promise<DshProviderPreview[]>;
  importDshProvider(profileKey: string, dshDir: string, providerKey: string): Promise<ModelConfigPublic>;
  cancelRequest(requestId: string): Promise<void>;
  selectDshDirectory?: () => Promise<string | null>;
};
