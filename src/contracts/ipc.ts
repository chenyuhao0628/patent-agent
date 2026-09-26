import type { AgentCaseView, AgentTaskView, AgentPreparation } from '../agent-api.ts';
import type { ReviewSource } from '../professional-api.ts';
import type { ApplicationPreferences, ApplicationSettingsView } from '../application-api.ts';
import type { LocalProgress } from '../domain/local-progress.ts';
import type { ModelConfigPublic, ProviderSaveInput, UpstreamModel, ConnectionTestResult, DshProviderPreview } from '../domain/models.ts';
import type { ProfessionalCaseView, ProfessionalCommand, ReviewQueueItem } from '../professional-api.ts';
import type {
  NameDiscrepancyRequest,
  TransferFilePreviewRef,
  TransferFilePreviewResult,
  TransferReview,
  TransferSource,
  TransferView,
  TransferFileRole,
} from '../transfer-api.ts';
import type { Extension } from '../../desktop/extensions.ts';
import type {
  DesktopState,
  DocumentToolStatus,
  FlowView,
  FolderOrganizationReport,
  MigrationPreview,
} from './desktop-state.ts';
import type { Settings, Workspace } from '../domain/workflow.ts';
import type { AgentCommand } from '../domain/agent-command.ts';

export type ExtensionIpcArgs =
  | [method: 'test', profileKey: string, id: string]
  | [method: 'list', profileKey: string]
  | [method: 'toggle', profileKey: string, id: string, value: boolean]
  | [method: 'remove', profileKey: string, id: string]
  | [method: 'saveMcp', profileKey: string, raw: string, id?: string]
  | [method: 'saveSkill', profileKey: string, name: string, text: string, id?: string]
  | [method: 'importSkill', profileKey: string];

export type ExtensionIpcResult = Extension[] | { tools: number };

export type PriorArtIpcArgs =
  | [method: 'status' | 'clear' | 'importLegacy' | 'test', profileKey: string]
  | [method: 'save', profileKey: string, value: string]
  | [method: 'prepare', profileKey: string, caseId: string, note?: string];

export type PriorArtIpcResult = { configured: boolean; provider: string; baseURL: string } | DesktopState;

export type ModelRequestOptions = {
  modelEntryId?: string;
  requestId?: string;
};

export type ModelIpcMethodArgs = {
  saveProvider: [input: ProviderSaveInput];
  deleteProvider: [providerId: string];
  setDefault: [providerId: string, modelEntryId: string];
  addDiscoveredModels: [providerId: string, models: UpstreamModel[]];
  importDshProvider: [dshDirectory: string, providerKey: string];
  list: [];
  testConnection: [providerId: string, options?: ModelRequestOptions];
  listRemoteModels: [providerId: string, options?: ModelRequestOptions];
  previewDshProviders: [dshDirectory: string];
};

export type ModelIpcMethod = keyof ModelIpcMethodArgs;
export type ModelIpcArgs = {
  [Method in ModelIpcMethod]: [
    method: Method,
    profileKey: string,
    args: ModelIpcMethodArgs[Method],
    requestId?: string,
  ]
}[ModelIpcMethod];

export type ModelIpcResult =
  | ModelConfigPublic
  | ConnectionTestResult
  | UpstreamModel[]
  | DshProviderPreview[]
  | void;

export type DesktopIpcChannels = {
  diagnosticExport: { args: []; result: { canceled: boolean; path?: string; count?: number; droppedWrites?: number } };
  diagnosticReport: { args: [{ type?: string; line?: number; column?: number }]; result: void };
  applicationGet: { args: []; result: ApplicationSettingsView };
  applicationSave: { args: [ApplicationPreferences]; result: ApplicationSettingsView };
  applicationMinimize: { args: []; result: void };
  applicationQuit: { args: []; result: void };
  extensions: { args: ExtensionIpcArgs; result: ExtensionIpcResult };
  priorArt: { args: PriorArtIpcArgs; result: PriorArtIpcResult };
  verifyLogin: { args: []; result: DesktopState };
  bootstrap: { args: []; result: DesktopState };
  login: { args: [{ origin: string; username: string; password: string; remember: boolean }]; result: DesktopState };
  logout: { args: []; result: DesktopState };
  selectDirectory: { args: ['originalLibrary' | 'workRoot']; result: string | null };
  saveSettings: { args: [string, Settings]; result: DesktopState };
  saveWorkspace: { args: [string, Workspace]; result: void };
  refreshShared: { args: [string]; result: DesktopState };
  sync: { args: [source?: 'manual' | 'focus']; result: DesktopState };
  createCase: { args: [{ title: string; number: string; kind: 'write' | 'review' }]; result: DesktopState };
  flow: { args: [caseId: string]; result: FlowView };
  caseInfo: { args: [profileKey: string, caseId: string]; result: DesktopState };
  refreshCaseOutcomes: { args: [profileKey: string]; result: DesktopState };
  refreshCaseOutcome: { args: [profileKey: string, caseId: string]; result: DesktopState };
  selectCurrentProcess: { args: [profileKey: string, caseId: string, processId: string]; result: DesktopState };
  openCaseDirectory: { args: [caseId: string]; result: void };
  openMaterial: { args: [caseId: string, relativePath: string]; result: void };
  findOriginals: { args: [caseId: string]; result: { id: string; name: string }[] };
  copyOriginal: { args: [caseId: string, sourceId: string]; result: DesktopState };
  previewWorkMigration: { args: [profileKey: string, destination: string]; result: MigrationPreview };
  startWorkMigration: { args: [profileKey: string, previewId: string]; result: DesktopState };
  cancelWorkMigration: { args: []; result: DesktopState };
  organizeWorkFolders: { args: [profileKey: string]; result: FolderOrganizationReport };
  selectDshDirectory: { args: []; result: string | null };
  model: { args: ModelIpcArgs; result: ModelIpcResult };
  modelCancel: { args: [requestId: string]; result: void };
  professionalGet: { args: [profileKey: string, caseId: string]; result: ProfessionalCaseView };
  professionalReviews: { args: [profileKey: string]; result: ReviewQueueItem[] };
  professionalCommand: { args: [profileKey: string, caseId: string, command: ProfessionalCommand]; result: ProfessionalCaseView };
  professionalPick: { args: [profileKey: string, caseId: string]; result: ProfessionalCaseView };
  professionalPickReferences: { args: [profileKey: string, caseId: string]; result: ProfessionalCaseView };
  professionalRemoveReference: { args: [profileKey: string, caseId: string, materialId: string]; result: ProfessionalCaseView };
  professionalOpen: { args: [profileKey: string, caseId: string, relativePath: string]; result: void };
  agentGetCase: { args: [profileKey: string, caseId: string]; result: AgentCaseView };
  agentReviewSources: { args: [profileKey: string]; result: ReviewSource[] };
  agentCommand: { args: [profileKey: string, caseId: string, command: AgentCommand]; result: AgentCaseView };
  agentProgress: { args: [profileKey: string]; result: LocalProgress[] };
  agentTasks: { args: [profileKey: string]; result: AgentTaskView[] };
  documentToolsStatus: { args: []; result: DocumentToolStatus };
  documentToolsDetect: { args: []; result: DocumentToolStatus };
  documentToolsSelect: { args: []; result: DocumentToolStatus };
  documentToolsInstall: { args: []; result: DocumentToolStatus };
  documentToolsRemove: { args: []; result: DocumentToolStatus };
  documentToolsConfigure: { args: [{ webEnabled: boolean; autoInstall: boolean; commandsEnabled: boolean; downloadsEnabled: boolean }]; result: DocumentToolStatus };
  documentToolsOpen: { args: []; result: void };
  transferInspect: { args: [profileKey: string, caseId: string]; result: TransferView | null };
  transferPrepare: { args: [profileKey: string, caseId: string, sourceMode?: TransferSource]; result: TransferView };
  transferPickFile: { args: [profileKey: string, caseId: string, role: TransferFileRole]; result: TransferView };
  transferRemoveFile: { args: [profileKey: string, caseId: string, role: TransferFileRole]; result: TransferView };
  transferClearRemote: { args: [profileKey: string, caseId: string]; result: TransferView };
  transferPreviewFile: { args: [profileKey: string, caseId: string, file: TransferFilePreviewRef]; result: TransferFilePreviewResult };
  transferStartHand: { args: [profileKey: string, caseId: string]; result: TransferView };
  transferSaveLocalReview: { args: [profileKey: string, caseId: string, review: TransferReview]; result: TransferView };
  transferSave: { args: [profileKey: string, caseId: string, review: TransferReview]; result: TransferView };
  transferSubmit: { args: [profileKey: string, caseId: string, review?: TransferReview]; result: TransferView };
  transferRefresh: { args: [profileKey: string, caseId: string]; result: TransferView };
  transferReprepare: { args: [profileKey: string, caseId: string]; result: TransferView };
  transferRevoke: { args: [profileKey: string, caseId: string]; result: TransferView };
};

export type IpcChannel = keyof DesktopIpcChannels;
export type IpcArgs<Name extends IpcChannel> = DesktopIpcChannels[Name]['args'];
export type IpcResult<Name extends IpcChannel> = DesktopIpcChannels[Name]['result'];

export type DesktopEventPayloads = {
  'desktop:state': DesktopState;
  'desktop:agentState': AgentCaseView;
  'desktop:agentPreparation': AgentPreparation;
  'desktop:professionalState': string;
  'desktop:transferConfirmNameRequest': NameDiscrepancyRequest;
};
