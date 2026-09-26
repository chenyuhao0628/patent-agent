import { contextBridge, ipcRenderer } from 'electron';
import type { AgentPreparation } from '../src/agent-api.ts';
import type { DesktopAPI } from '../src/contracts/desktop-api.ts';
import type { NameDiscrepancyRequest, TransferFilePreviewRef, TransferReview, TransferSource } from '../src/transfer-api.ts';
import type { ProfessionalCommand } from '../src/professional-api.ts';
import type { ProviderSaveInput, UpstreamModel } from '../src/domain/models.ts';
import type { ApplicationPreferences } from '../src/application-api.ts';
import { DESKTOP_CONTRACT_VERSION, deserializeContractError } from '../src/contracts/version.ts';

const call = async <T>(name: string, ...args: unknown[]): Promise<T> => {
  try {
    return await ipcRenderer.invoke(`desktop:${name}`, ...args) as T;
  } catch (error) {
    throw deserializeContractError(error);
  }
};

const modelCall = <T>(method: string, profileKey: string, args: unknown[], requestId?: string) =>
  call<T>('model', method, profileKey, args, requestId);

const onState = <T>(channel: string, callback: (value: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: DesktopAPI = {
  contractVersion: DESKTOP_CONTRACT_VERSION,
  diagnosticExport: () => call('diagnosticExport'),
  diagnosticReport: input => call('diagnosticReport', input),
  extensions: {
    test: (profileKey, id) => call('extensions', 'test', profileKey, id),
    list: profileKey => call('extensions', 'list', profileKey),
    toggle: (profileKey, id, value) => call('extensions', 'toggle', profileKey, id, value),
    remove: (profileKey, id) => call('extensions', 'remove', profileKey, id),
    saveMcp: (profileKey, raw, id) => call('extensions', 'saveMcp', profileKey, raw, id),
    saveSkill: (profileKey, name, text, id) => call('extensions', 'saveSkill', profileKey, name, text, id),
    importSkill: profileKey => call('extensions', 'importSkill', profileKey),
  },
  priorArt: {
    status: profileKey => call('priorArt', 'status', profileKey),
    save: (profileKey, value) => call('priorArt', 'save', profileKey, value),
    clear: profileKey => call('priorArt', 'clear', profileKey),
    importLegacy: profileKey => call('priorArt', 'importLegacy', profileKey),
    test: profileKey => call('priorArt', 'test', profileKey),
    prepare: (profileKey, caseId, value) => call('priorArt', 'prepare', profileKey, caseId, value),
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
    previewDshProviders: dshDirectory => call('model', 'previewDshProviders', '', [dshDirectory]),
    importDshProvider: (profileKey, dshDirectory, providerKey) =>
      call('model', 'importDshProvider', profileKey, [dshDirectory, providerKey]),
    cancelRequest: requestId => call('modelCancel', requestId),
    selectDshDirectory: () => call('selectDshDirectory'),
  },
  agent: {
    onPreparation: (callback: (event: AgentPreparation) => void) => onState('desktop:agentPreparation', callback),
    listProgress: profileKey => call('agentProgress', profileKey),
    getCase: (profileKey, caseId) => call('agentGetCase', profileKey, caseId),
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
