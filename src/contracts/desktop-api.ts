import type { AgentAPI } from '../agent-api.ts';
import type { ApplicationAPI } from '../application-api.ts';
import type { ModelAPI } from '../model-api.ts';
import type { ProfessionalAPI } from '../professional-api.ts';
import type { TransferAPI } from '../transfer-api.ts';
import type { Settings } from '../domain/workflow.ts';
import type {
  DesktopState,
  DocumentToolStatus,
  FlowView,
  FolderOrganizationReport,
  MigrationPreview,
} from './desktop-state.ts';
export type { DesktopEventPayloads, DesktopIpcChannels, IpcArgs, IpcChannel, IpcResult } from './ipc.ts';

export type DesktopCaseAPI = {
  saveWorkspace(key: string, workspace: import('../domain/workflow.ts').Workspace): Promise<void>;
  saveSettings(key: string, settings: Settings): Promise<DesktopState>;
  refreshShared(key: string): Promise<DesktopState>;
  sync(source?: 'manual' | 'focus'): Promise<DesktopState>;
  createCase(input: { title: string; number: string; kind: 'write' | 'review' }): Promise<DesktopState>;
  caseInfo(key: string, caseId: string): Promise<DesktopState>;
  refreshCaseOutcomes(key: string): Promise<DesktopState>;
  refreshCaseOutcome(key: string, caseId: string): Promise<DesktopState>;
  selectCurrentProcess(key: string, caseId: string, processId: string): Promise<DesktopState>;
  flow(caseId: string): Promise<FlowView>;
  openCaseDirectory(caseId: string): Promise<void>;
  findOriginals(caseId: string): Promise<{ id: string; name: string }[]>;
  copyOriginal(caseId: string, sourceId: string): Promise<DesktopState>;
  openMaterial(caseId: string, relativePath: string): Promise<void>;
  selectDirectory(kind: 'originalLibrary' | 'workRoot'): Promise<string | null>;
  previewWorkMigration(key: string, destination: string): Promise<MigrationPreview>;
  startWorkMigration(key: string, previewId: string): Promise<DesktopState>;
  cancelWorkMigration(): Promise<DesktopState>;
  organizeWorkFolders(key: string): Promise<FolderOrganizationReport>;
};

export type DesktopAccountAPI = {
  bootstrap(): Promise<DesktopState>;
  verifyLogin?: () => Promise<DesktopState>;
  login(input: { origin: string; username: string; password: string; remember: boolean }): Promise<DesktopState>;
  logout(): Promise<DesktopState>;
  onState(callback: (state: DesktopState) => void): () => void;
};

export type DesktopToolAPI = {
  diagnosticExport: () => Promise<{ canceled: boolean; path?: string; count?: number; droppedWrites?: number }>;
  diagnosticReport: (input: { type: string; line?: number; column?: number }) => Promise<void>;
  selectDshDirectory(): Promise<string | null>;
  priorArt: {
    status(key: string): Promise<{ configured: boolean }>;
    save(key: string, value: string): Promise<{ configured: boolean }>;
    clear(key: string): Promise<{ configured: boolean }>;
    importLegacy(key: string): Promise<{ configured: boolean }>;
    test(key: string): Promise<{ configured: boolean }>;
    prepare(key: string, id: string, value: string): Promise<DesktopState>;
  };
  extensions: {
    test(key: string, id: string): Promise<{ tools: number }>;
    list(key: string): Promise<import('../../desktop/extensions.ts').Extension[]>;
    toggle(key: string, id: string, value: boolean): Promise<import('../../desktop/extensions.ts').Extension[]>;
    remove(key: string, id: string): Promise<import('../../desktop/extensions.ts').Extension[]>;
    saveMcp(key: string, raw: string, id?: string): Promise<import('../../desktop/extensions.ts').Extension[]>;
    saveSkill(key: string, name: string, text: string, id?: string): Promise<import('../../desktop/extensions.ts').Extension[]>;
    importSkill(key: string): Promise<import('../../desktop/extensions.ts').Extension[]>;
  };
  documentTools: {
    detect(): Promise<DocumentToolStatus>;
    status(): Promise<DocumentToolStatus>;
    selectConverter(): Promise<DocumentToolStatus>;
    installConverter(): Promise<DocumentToolStatus>;
    configure(value: { webEnabled: boolean; autoInstall: boolean; commandsEnabled: boolean; downloadsEnabled: boolean }): Promise<DocumentToolStatus>;
    openDirectory(): Promise<void>;
    removeConverter(): Promise<DocumentToolStatus>;
  };
};

export type DesktopAPI = DesktopCaseAPI & DesktopAccountAPI & DesktopToolAPI & {
  contractVersion: 1;
  models: ModelAPI;
  agent: AgentAPI;
  transfer: TransferAPI;
  professional: ProfessionalAPI;
  application: ApplicationAPI;
};
