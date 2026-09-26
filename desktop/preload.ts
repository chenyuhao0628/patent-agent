import { contextBridge, ipcRenderer } from 'electron';
import type { AgentPreparation } from '../src/agent-api.ts';
import type { DesktopAPI } from '../src/contracts/desktop-api.ts';
import type { NameDiscrepancyRequest, TransferFilePreviewRef, TransferReview, TransferSource } from '../src/transfer-api.ts';
import type { ProfessionalCommand } from '../src/professional-api.ts';
import type { ConnectionTestResult, DshProviderPreview, ModelConfigPublic, ProviderSaveInput, UpstreamModel } from '../src/domain/models.ts';
import type { ApplicationPreferences } from '../src/application-api.ts';
import type { Extension } from './extensions.ts';
import type { DesktopEventPayloads, IpcArgs, IpcChannel, IpcResult, ModelIpcArgs, ModelIpcMethod, ModelIpcMethodArgs } from '../src/contracts/ipc.ts';
import type { DesktopState } from '../src/contracts/desktop-state.ts';
import { DESKTOP_CONTRACT_VERSION, deserializeContractError } from '../src/contracts/version.ts';

const call = async <Name extends IpcChannel>(name: Name, ...args: IpcArgs<Name>): Promise<IpcResult<Name>> => {
  try {
    return await ipcRenderer.invoke(`desktop:${name}`, ...args) as IpcResult<Name>;
  } catch (error) {
    throw deserializeContractError(error);
  }
};

function objectResult<T>(value: unknown, label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}响应无效。`);
  return value as T;
}

function arrayResult<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label}响应无效。`);
  return value as T[];
}

function extensionList(value: IpcResult<'extensions'>): Extension[] {
  return arrayResult<Extension>(value, '扩展');
}

function extensionTools(value: IpcResult<'extensions'>): { tools: number } {
  const result = objectResult<{ tools?: unknown }>(value, '扩展');
  if (!Number.isSafeInteger(result.tools) || Number(result.tools) < 0) throw new Error('扩展响应无效。');
  return { tools: result.tools as number };
}

function priorArtConfig(value: IpcResult<'priorArt'>): { configured: boolean } {
  const result = objectResult<{ configured?: unknown }>(value, '对比文件');
  if (typeof result.configured !== 'boolean') throw new Error('对比文件响应无效。');
  return { configured: result.configured };
}

function priorArtState(value: IpcResult<'priorArt'>): DesktopState {
  return objectResult<DesktopState>(value, '对比文件');
}

type ModelResultFor<Method extends ModelIpcMethod> =
  Method extends 'testConnection' ? ConnectionTestResult :
  Method extends 'listRemoteModels' ? UpstreamModel[] :
  Method extends 'previewDshProviders' ? DshProviderPreview[] :
  ModelConfigPublic;

const modelCall = async <Method extends ModelIpcMethod>(
  method: Method,
  profileKey: string,
  args: ModelIpcMethodArgs[Method],
  requestId?: string,
): Promise<ModelResultFor<Method>> => {
  const value = await call('model', ...( [method, profileKey, args, requestId] as ModelIpcArgs));
  if (method === 'listRemoteModels') return arrayResult<UpstreamModel>(value, '远端模型') as ModelResultFor<Method>;
  if (method === 'previewDshProviders') return arrayResult<DshProviderPreview>(value, 'DSH 供应商') as ModelResultFor<Method>;
  return objectResult<ModelConfigPublic | ConnectionTestResult>(value, '模型') as ModelResultFor<Method>;
};

const onState = <Name extends keyof DesktopEventPayloads>(
  channel: Name,
  callback: (value: DesktopEventPayloads[Name]) => void,
): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: DesktopEventPayloads[Name]) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: DesktopAPI = {
  contractVersion: DESKTOP_CONTRACT_VERSION,
  diagnosticExport: () => call('diagnosticExport'),
  diagnosticReport: input => call('diagnosticReport', input),
  extensions: {
    test: async (profileKey, id) => extensionTools(await call('extensions', 'test', profileKey, id)),
    list: async profileKey => extensionList(await call('extensions', 'list', profileKey)),
    toggle: async (profileKey, id, value) => extensionList(await call('extensions', 'toggle', profileKey, id, value)),
    remove: async (profileKey, id) => extensionList(await call('extensions', 'remove', profileKey, id)),
    saveMcp: async (profileKey, raw, id) => extensionList(await call('extensions', 'saveMcp', profileKey, raw, id)),
    saveSkill: async (profileKey, name, text, id) => extensionList(await call('extensions', 'saveSkill', profileKey, name, text, id)),
    importSkill: async profileKey => extensionList(await call('extensions', 'importSkill', profileKey)),
  },
  priorArt: {
    status: async profileKey => priorArtConfig(await call('priorArt', 'status', profileKey)),
    save: async (profileKey, value) => priorArtConfig(await call('priorArt', 'save', profileKey, value)),
    clear: async profileKey => priorArtConfig(await call('priorArt', 'clear', profileKey)),
    importLegacy: async profileKey => priorArtConfig(await call('priorArt', 'importLegacy', profileKey)),
    test: async profileKey => priorArtConfig(await call('priorArt', 'test', profileKey)),
    prepare: async (profileKey, caseId, value) => priorArtState(await call('priorArt', 'prepare', profileKey, caseId, value)),
  },
  verifyLogin: () => call('verifyLogin'),
  bootstrap: () => call('bootstrap'),
  login: input => call('login', input),
  logout: () => call('logout'),
  selectDirectory: kind => call('selectDirectory', kind),
  saveSettings: (profileKey, settings) => call('saveSettings', profileKey, settings),
  saveWorkspace: (profileKey, workspace) => call('saveWorkspace', profileKey, workspace),
  refreshShared: profileKey => call('refreshShared', profileKey),
  sync: source => call('sync', source),
  createCase: input => call('createCase', input),
  flow: caseId => call('flow', caseId),
  caseInfo: (profileKey, caseId) => call('caseInfo', profileKey, caseId),
  refreshCaseOutcomes: profileKey => call('refreshCaseOutcomes', profileKey),
  refreshCaseOutcome: (profileKey, caseId) => call('refreshCaseOutcome', profileKey, caseId),
  selectCurrentProcess: (profileKey, caseId, processId) => call('selectCurrentProcess', profileKey, caseId, processId),
  openCaseDirectory: caseId => call('openCaseDirectory', caseId),
  openMaterial: (caseId, relativePath) => call('openMaterial', caseId, relativePath),
  findOriginals: caseId => call('findOriginals', caseId),
  copyOriginal: (caseId, sourceId) => call('copyOriginal', caseId, sourceId),
  previewWorkMigration: (profileKey, destination) => call('previewWorkMigration', profileKey, destination),
  startWorkMigration: (profileKey, previewId) => call('startWorkMigration', profileKey, previewId),
  cancelWorkMigration: () => call('cancelWorkMigration'),
  organizeWorkFolders: profileKey => call('organizeWorkFolders', profileKey),
  selectDshDirectory: () => call('selectDshDirectory'),
  models: {
    list: profileKey => modelCall('list', profileKey, []),
    saveProvider: (profileKey, input: ProviderSaveInput) => modelCall('saveProvider', profileKey, [input]),
    deleteProvider: (profileKey, providerId) => modelCall('deleteProvider', profileKey, [providerId]),
    setDefault: (profileKey, providerId, modelEntryId) => modelCall('setDefault', profileKey, [providerId, modelEntryId]),
    testConnection: (profileKey, providerId, options) =>
      modelCall('testConnection', profileKey, [providerId, options], options?.requestId),
    listRemoteModels: (profileKey, providerId, options) =>
      modelCall('listRemoteModels', profileKey, [providerId, options], options?.requestId),
    addDiscoveredModels: (profileKey, providerId, models: UpstreamModel[]) =>
      modelCall('addDiscoveredModels', profileKey, [providerId, models]),
    previewDshProviders: dshDirectory => modelCall('previewDshProviders', '', [dshDirectory]),
    importDshProvider: (profileKey, dshDirectory, providerKey) =>
      modelCall('importDshProvider', profileKey, [dshDirectory, providerKey]),
    cancelRequest: requestId => call('modelCancel', requestId),
    selectDshDirectory: () => call('selectDshDirectory'),
  },
  agent: {
    onPreparation: (callback: (event: AgentPreparation) => void) => onState('desktop:agentPreparation', callback),
    listProgress: profileKey => call('agentProgress', profileKey),
    getCase: (profileKey, caseId) => call('agentGetCase', profileKey, caseId),
    reviewSources: async profileKey => arrayResult(await call('agentReviewSources', profileKey), '答复历史'),
    command: (profileKey, caseId, command) => call('agentCommand', profileKey, caseId, command),
    listTasks: profileKey => call('agentTasks', profileKey),
    onState: callback => onState('desktop:agentState', callback),
  },
  transfer: {
    inspect: (profileKey, caseId) => call('transferInspect', profileKey, caseId),
    prepare: (profileKey, caseId, sourceMode: TransferSource | undefined) =>
      call('transferPrepare', profileKey, caseId, sourceMode),
    pickFile: (profileKey, caseId, role) => call('transferPickFile', profileKey, caseId, role),
    removeFile: (profileKey, caseId, role) => call('transferRemoveFile', profileKey, caseId, role),
    clearRemote: (profileKey, caseId) => call('transferClearRemote', profileKey, caseId),
    previewFile: (profileKey, caseId, fileRef: TransferFilePreviewRef) =>
      call('transferPreviewFile', profileKey, caseId, fileRef),
    startHand: (profileKey, caseId) => call('transferStartHand', profileKey, caseId),
    saveLocalReview: (profileKey, caseId, review: TransferReview) =>
      call('transferSaveLocalReview', profileKey, caseId, review),
    save: (profileKey, caseId, review: TransferReview) => call('transferSave', profileKey, caseId, review),
    submit: (profileKey, caseId, review?: TransferReview) => call('transferSubmit', profileKey, caseId, review),
    refresh: (profileKey, caseId) => call('transferRefresh', profileKey, caseId),
    reprepare: (profileKey, caseId) => call('transferReprepare', profileKey, caseId),
    revoke: (profileKey, caseId) => call('transferRevoke', profileKey, caseId),
    onConfirmNameRequest: (callback: (request: NameDiscrepancyRequest) => void) =>
      onState('desktop:transferConfirmNameRequest', callback),
    respondConfirmName: (requestId, confirmed) => {
      ipcRenderer.send('desktop:transferConfirmNameResponse', requestId, confirmed);
    },
  },
  professional: {
    pickReferences: (profileKey, caseId) => call('professionalPickReferences', profileKey, caseId),
    removeReference: (profileKey, caseId, materialId) => call('professionalRemoveReference', profileKey, caseId, materialId),
    getCase: (profileKey, caseId) => call('professionalGet', profileKey, caseId),
    listReviews: profileKey => call('professionalReviews', profileKey),
    command: (profileKey, caseId, command: ProfessionalCommand) =>
      call('professionalCommand', profileKey, caseId, command),
    pickFiles: (profileKey, caseId) => call('professionalPick', profileKey, caseId),
    openFile: (profileKey, caseId, relativePath) => call('professionalOpen', profileKey, caseId, relativePath),
    onState: callback => onState('desktop:professionalState', callback),
  },
  application: {
    get: () => call('applicationGet'),
    save: (preferences: ApplicationPreferences) => call('applicationSave', preferences),
    minimize: () => call('applicationMinimize'),
    quit: () => call('applicationQuit'),
  },
  documentTools: {
    detect: () => call('documentToolsDetect'),
    status: () => call('documentToolsStatus'),
    selectConverter: () => call('documentToolsSelect'),
    installConverter: () => call('documentToolsInstall'),
    configure: value => call('documentToolsConfigure', value),
    openDirectory: () => call('documentToolsOpen'),
    removeConverter: () => call('documentToolsRemove'),
  },
  onState: callback => onState('desktop:state', callback),
};

contextBridge.exposeInMainWorld('patentDesktop', api);
