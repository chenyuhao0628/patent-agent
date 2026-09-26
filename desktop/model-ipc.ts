import path from 'node:path';
import type { WebContents } from 'electron';
import type { ModelService } from './model-service.ts';
import type { ProviderSaveInput, UpstreamModel } from '../src/domain/models.ts';
import { assertProfileKey, assertRecord, assertString } from '../src/contracts/version.ts';
import { MODEL_PROTOCOLS } from '../src/domain/models.ts';
import type { ModelIpcMethod as SharedModelIpcMethod, ModelIpcMethodArgs, ModelIpcResult } from '../src/contracts/ipc.ts';

export const MODEL_WRITE_METHODS = ['saveProvider', 'deleteProvider', 'setDefault', 'addDiscoveredModels', 'importDshProvider'] as const;
export const MODEL_READ_METHODS = ['list', 'testConnection', 'listRemoteModels', 'previewDshProviders'] as const;
export const MODEL_IPC_METHODS = [...MODEL_WRITE_METHODS, ...MODEL_READ_METHODS] as const;
export type ModelIpcMethod = SharedModelIpcMethod;
export type ParsedModelIpcRequest = {
  method: ModelIpcMethod;
  profileKey: string;
  args: ModelIpcMethodArgs[ModelIpcMethod];
  requestId?: string;
};

const WRITE = new Set<string>(MODEL_WRITE_METHODS);
const ALLOWED = new Set<string>(MODEL_IPC_METHODS);

export function isModelIpcMethod(value: string): value is ModelIpcMethod {
  return ALLOWED.has(value);
}

export function isModelWriteMethod(value: string): boolean {
  return WRITE.has(value);
}

function optionalString(record: Record<string, unknown>, key: string, label: string, maxLength = 4096, nullable = false): void {
  if (record[key] !== undefined && record[key] !== null && (typeof record[key] !== 'string' || (record[key] as string).length > maxLength)) {
    throw new Error(`${label}无效。`);
  }
  if (!nullable && record[key] === null) throw new Error(`${label}无效。`);
}

function optionalBoolean(record: Record<string, unknown>, key: string, label: string, nullable = false): void {
  if (nullable && record[key] === null) return;
  if (record[key] !== undefined && typeof record[key] !== 'boolean') throw new Error(`${label}无效。`);
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string, label: string, nullable = false): void {
  if (nullable && record[key] === null) return;
  if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || Number(record[key]) < 1)) {
    throw new Error(`${label}无效。`);
  }
}

function validateModelSaveInput(value: unknown): ProviderSaveInput {
  const record = assertRecord(value, '模型供应商设置无效。');
  assertString(record.name, '供应商名称', 256);
  assertString(record.baseURL, 'API 地址', 2048);
  optionalString(record, 'id', '供应商标识', 256);
  optionalString(record, 'key', '模型密钥', 100000);
  optionalBoolean(record, 'clearKey', '清除密钥');
  if (record.protocol !== undefined && record.protocol !== null && !MODEL_PROTOCOLS.includes(record.protocol as typeof MODEL_PROTOCOLS[number])) {
    throw new Error('模型协议无效。');
  }
  if (record.models !== undefined) {
    if (!Array.isArray(record.models) || record.models.length > 200) throw new Error('模型列表无效。');
    for (const value of record.models) {
      const model = assertRecord(value, '模型项无效。');
      assertString(model.modelId, '模型标识', 512);
      assertString(model.displayName, '模型名称', 512);
      optionalString(model, 'id', '模型项标识', 256);
      if (model.protocol !== undefined && model.protocol !== null && !MODEL_PROTOCOLS.includes(model.protocol as typeof MODEL_PROTOCOLS[number])) throw new Error('模型协议无效。');
      for (const key of ['contextWindow', 'maxOutput', 'reasoningBudgetTokens'] as const) optionalPositiveInteger(model, key, key, true);
      for (const key of ['reasoningAdaptive', 'reasoningIncludeThoughts', 'reasoningOverridden'] as const) optionalBoolean(model, key, key);
      optionalString(model, 'reasoningLevelId', '思考级别', 256);
      optionalString(model, 'reasoningOutputEffort', '输出思考级别', 256, true);
      if (model.geminiMode !== undefined && model.geminiMode !== null && model.geminiMode !== 'level' && model.geminiMode !== 'budget') throw new Error('Gemini 思考模式无效。');
      if (model.reasoningLevels !== undefined) {
        if (!Array.isArray(model.reasoningLevels) || model.reasoningLevels.length > 100) throw new Error('思考级别列表无效。');
        for (const levelValue of model.reasoningLevels) {
          const level = assertRecord(levelValue, '思考级别无效。');
          assertString(level.id, '思考级别标识', 256);
          assertString(level.label, '思考级别名称', 256);
          if (typeof level.protocolValue !== 'string' || level.protocolValue.length > 256) throw new Error('思考级别参数无效。');
          assertString(level.source, '思考级别来源', 64);
          optionalString(level, 'hint', '思考级别说明', 2000);
        }
      }
    }
  }
  return value as ProviderSaveInput;
}

function validateUpstreamModels(value: unknown): UpstreamModel[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('远端模型列表无效。');
  for (const item of value) {
    const model = assertRecord(item, '远端模型项无效。');
    assertString(model.id, '远端模型标识', 512);
    optionalString(model, 'name', '远端模型名称', 512);
    if (model.protocol !== undefined && model.protocol !== null && !MODEL_PROTOCOLS.includes(model.protocol as typeof MODEL_PROTOCOLS[number])) throw new Error('模型协议无效。');
    optionalPositiveInteger(model, 'contextWindow', '上下文窗口');
    optionalPositiveInteger(model, 'maxOutput', '最大输出');
    if (model.reasoning !== undefined) assertRecord(model.reasoning, '远端思考能力无效。');
  }
  return value as UpstreamModel[];
}

function validateModelOptions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = assertRecord(value, '模型请求选项无效。');
  optionalString(record, 'modelEntryId', '模型项标识', 256);
  optionalString(record, 'requestId', '请求标识', 256);
  return record;
}

export function parseModelIpcRequest(
  methodValue: unknown,
  profileKeyValue: unknown,
  argsValue: unknown,
  requestIdValue?: unknown,
): ParsedModelIpcRequest {
  const method = assertString(methodValue, '模型接口', 64);
  if (!isModelIpcMethod(method)) throw new Error('不支持的模型接口。');
  const profileKey = method === 'previewDshProviders'
    ? (profileKeyValue === '' ? '' : assertProfileKey(profileKeyValue))
    : assertProfileKey(profileKeyValue);
  if (!Array.isArray(argsValue)) throw new Error('模型接口参数无效。');
  const args = [...argsValue] as ModelIpcMethodArgs[ModelIpcMethod];
  const exact = (count: number) => { if (args.length !== count) throw new Error('模型接口参数数量无效。'); };
  switch (method) {
    case 'list':
      exact(0);
      break;
    case 'saveProvider':
      exact(1);
      validateModelSaveInput(args[0]);
      break;
    case 'deleteProvider':
      exact(1);
      assertString(args[0], '供应商标识', 256);
      break;
    case 'setDefault':
      exact(2);
      assertString(args[0], '供应商标识', 256);
      assertString(args[1], '模型项标识', 256);
      break;
    case 'addDiscoveredModels':
      exact(2);
      assertString(args[0], '供应商标识', 256);
      validateUpstreamModels(args[1]);
      break;
    case 'importDshProvider':
      exact(2);
      assertString(args[0], 'DSH 目录', 4096);
      assertString(args[1], 'DSH 供应商标识', 256);
      break;
    case 'previewDshProviders':
      exact(1);
      assertString(args[0], 'DSH 目录', 4096);
      break;
    case 'testConnection':
    case 'listRemoteModels':
      if (args.length !== 1 && args.length !== 2) throw new Error('模型接口参数数量无效。');
      assertString(args[0], '供应商标识', 256);
      validateModelOptions(args[1]);
      break;
  }
  const requestId = requestIdValue === undefined ? undefined : assertString(requestIdValue, '请求标识', 256);
  return { method, profileKey, args, requestId };
}

type LiveRequest = { senderId: number; profileKey: string; generation: number; controller: AbortController; registrationId: string };

export class ModelRequestRegistry {
  private readonly live = new Map<string, LiveRequest>();
  private nextRegistration = 1;

  begin(requestId: string, senderId: number, profileKey: string, generation: number): { signal: AbortSignal; registrationId: string } {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('请求标识无效。');
    if (this.live.has(requestId)) throw new Error('请求标识重复。');
    const controller = new AbortController();
    const registrationId = String(this.nextRegistration++);
    this.live.set(requestId, { senderId, profileKey, generation, controller, registrationId });
    return { signal: controller.signal, registrationId };
  }

  cancel(requestId: string, senderId: number) {
    const live = this.live.get(requestId);
    if (!live) return;
    if (live.senderId !== senderId) throw new Error('不能取消其他窗口的请求。');
    live.controller.abort('cancelled');
  }

  finish(requestId: string | undefined, registrationId?: string) {
    if (!requestId || registrationId === undefined) return;
    const live = this.live.get(requestId);
    if (!live || live.registrationId !== registrationId) return;
    this.live.delete(requestId);
  }

  abortAll() {
    for (const live of this.live.values()) live.controller.abort('cancelled');
    this.live.clear();
  }

  has(requestId: string) {
    return this.live.has(requestId);
  }
}

export function assertChosenDirectory(dir: string, chosen: Set<string>) {
  if (typeof dir !== 'string' || !dir) throw new Error('请使用系统文件夹选择器选择 DSH 目录。');
  const resolved = path.resolve(dir);
  if (!chosen.has(dir) && !chosen.has(resolved)) throw new Error('请使用系统文件夹选择器选择 DSH 目录。');
}

export async function dispatchModelMethod(
  service: ModelService,
  method: ModelIpcMethod,
  profileKey: string,
  args: ModelIpcMethodArgs[ModelIpcMethod],
  signal?: AbortSignal,
): Promise<ModelIpcResult> {
  switch (method) {
    case 'list':
      return service.list(profileKey);
    case 'saveProvider':
      return service.saveProvider(profileKey, args[0] as ProviderSaveInput);
    case 'deleteProvider':
      return service.deleteProvider(profileKey, String(args[0]));
    case 'setDefault':
      return service.setDefault(profileKey, String(args[0]), String(args[1]));
    case 'addDiscoveredModels':
      return service.addDiscoveredModels(profileKey, String(args[0]), args[1] as UpstreamModel[]);
    case 'importDshProvider':
      return service.importDshProvider(profileKey, String(args[0]), String(args[1]));
    case 'previewDshProviders':
      return service.previewDshProviders(String(args[0]));
    case 'testConnection': {
      const opts = asRecord(args[1]);
      return service.testConnection(profileKey, String(args[0]), {
        modelEntryId: typeof opts?.modelEntryId === 'string' ? opts.modelEntryId : undefined,
        signal,
      });
    }
    case 'listRemoteModels': {
      const opts = asRecord(args[1]);
      return service.listRemoteModels(profileKey, String(args[0]), {
        modelEntryId: typeof opts?.modelEntryId === 'string' ? opts.modelEntryId : undefined,
        signal,
      });
    }
    default:
      throw new Error('不支持的模型接口。');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export type ModelIpcHost = {
  modelService: ModelService;
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
  isMainFrame: (sender: WebContents, frame: unknown) => boolean;
  senderId: (sender: WebContents) => number;
  getProfileKey: () => string;
  getGeneration: () => number;
  chosenDsh: Set<string>;
};

export async function handleModelIpc(
  host: ModelIpcHost,
  registry: ModelRequestRegistry,
  sender: WebContents,
  frame: unknown,
  method: string,
  profileKey: string,
  args: unknown[],
  requestId?: string,
): Promise<ModelIpcResult> {
  if (!host.isMainFrame(sender, frame)) throw new Error('不接受非应用窗口请求。');
  if (typeof profileKey !== 'string') throw new Error('账号标识无效。');
  if (!isModelIpcMethod(method)) throw new Error('不支持的模型接口。');
  const typedArgs = args as ModelIpcMethodArgs[ModelIpcMethod];
  if (method === 'previewDshProviders' || method === 'importDshProvider') {
    assertChosenDirectory(String(typedArgs[0]), host.chosenDsh);
  }
  const generation = host.getGeneration();
  if (method !== 'previewDshProviders' && profileKey !== host.getProfileKey()) throw new Error('账号已切换，本次旧页面操作未保存。');
  let signal: AbortSignal | undefined;
  let registrationId: string | undefined;
  if (requestId) {
    const begun = registry.begin(requestId, host.senderId(sender), profileKey, generation);
    signal = begun.signal;
    registrationId = begun.registrationId;
  }
  const accountStillCurrent = () => {
    if (generation !== host.getGeneration()) return false;
    if (method !== 'previewDshProviders' && profileKey !== host.getProfileKey()) return false;
    return true;
  };
  try {
    const run = async () => {
      if (!accountStillCurrent()) throw new Error('账号已切换，本次旧页面操作未保存。');
      const result = await dispatchModelMethod(host.modelService, method, profileKey, typedArgs, signal);
      if (!accountStillCurrent()) throw new Error('账号已切换，本次旧页面操作未保存。');
      return result;
    };
    return await (isModelWriteMethod(method) ? host.serial(run) : run());
  } finally {
    registry.finish(requestId, registrationId);
  }
}
