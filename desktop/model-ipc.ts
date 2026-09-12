import path from 'node:path';
import type { WebContents } from 'electron';
import type { ModelService } from './model-service.ts';
import type { ProviderSaveInput, UpstreamModel } from '../src/domain/models.ts';

export const MODEL_WRITE_METHODS = ['saveProvider', 'deleteProvider', 'setDefault', 'addDiscoveredModels', 'importDshProvider'] as const;
export const MODEL_READ_METHODS = ['list', 'testConnection', 'listRemoteModels', 'previewDshProviders'] as const;
export const MODEL_IPC_METHODS = [...MODEL_WRITE_METHODS, ...MODEL_READ_METHODS] as const;
export type ModelIpcMethod = (typeof MODEL_IPC_METHODS)[number];

const WRITE = new Set<string>(MODEL_WRITE_METHODS);
const ALLOWED = new Set<string>(MODEL_IPC_METHODS);

export function isModelIpcMethod(value: string): value is ModelIpcMethod {
  return ALLOWED.has(value);
}

export function isModelWriteMethod(value: string): boolean {
  return WRITE.has(value);
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
  args: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
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
): Promise<unknown> {
  if (!host.isMainFrame(sender, frame)) throw new Error('不接受非应用窗口请求。');
  if (typeof profileKey !== 'string') throw new Error('账号标识无效。');
  if (!isModelIpcMethod(method)) throw new Error('不支持的模型接口。');
  if (method === 'previewDshProviders' || method === 'importDshProvider') {
    assertChosenDirectory(String(args[0]), host.chosenDsh);
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
      const result = await dispatchModelMethod(host.modelService, method, profileKey, args, signal);
      if (!accountStillCurrent()) throw new Error('账号已切换，本次旧页面操作未保存。');
      return result;
    };
    return await (isModelWriteMethod(method) ? host.serial(run) : run());
  } finally {
    registry.finish(requestId, registrationId);
  }
}
