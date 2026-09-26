import type { Case, Settings, Workspace } from '../domain/workflow.ts';

export type AuthState = {
  phase: 'signed-out' | 'verifying' | 'authenticated' | 'offline' | 'expired' | 'forbidden' | 'unreadable';
  message: string;
  attempts: number;
  lastCheckedAt?: string;
  nextRetryAt?: string;
};

export type Account = {
  username: string;
  displayName: string;
  organization: string;
  origin: string;
  userId: string;
  status: 'authenticated' | 'expired' | 'offline';
  remembered: boolean;
};

export type SyncState = { running: boolean; lastAt?: string; message: string };
export type StorageState = { running: boolean; message: string; lastAt?: string; caseCount?: number };
export type DocumentToolStatus = {
  permissions: { commandsEnabled: boolean; downloadsEnabled: boolean };
  detectedTools: Array<{ name: string; path: string; kind: 'application' | 'command'; note: string }>;
  converter: string | null;
  vision: boolean;
  webEnabled: boolean;
  autoInstall: boolean;
  managed: {
    root: string;
    version: string;
    phase: 'idle' | 'downloading' | 'installing' | 'ready' | 'error';
    downloaded: number;
    total: number;
    message: string;
  };
};

export type MigrationPhase = 'idle' | 'preview' | 'copying' | 'verifying' | 'publishing' | 'committing' | 'done' | 'failed';
export type MigrationPreview = {
  id: string;
  profileKey: string;
  sourceRoot: string;
  destinationRoot: string;
  originalLibrary: string;
  caseDirectoryCount: number;
  extraDirectoryCount: number;
  fileCount: number;
  directoryCount: number;
  byteCount: number;
  emptyNamespace: boolean;
};
export type MigrationProgress = {
  copiedFiles: number;
  verifiedFiles: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
  currentPath: string;
  message: string;
};
export type MigrationState = {
  running: boolean;
  phase: MigrationPhase;
  canCancel: boolean;
  preview?: MigrationPreview;
  progress?: MigrationProgress;
  message: string;
  error?: string;
};

export type FolderOrganizationReport = {
  renamedFolders: number;
  renamedFiles: number;
  skippedFiles: number;
  unknownPaths: string[];
  conflicts: string[];
  cases: number;
  message: string;
};

export type DesktopState = {
  auth?: AuthState;
  profileKey: string;
  /** Monotonic snapshot order, including updates within the same case stage. */
  snapshotVersion: number;
  /** Monotonic desktop-session scope; UI caches must not cross this boundary. */
  scopeVersion: number;
  /** Per-case stage generation; protects case writes from A-B-A stage switches. */
  caseRevisions: Readonly<Record<string, number>>;
  account: Account | null;
  workspace: Workspace;
  sync: SyncState;
  storage: StorageState;
  migration: MigrationState;
  version: string;
  dataDirectory: string;
};

/** Scope captured by a renderer write and rechecked by the main process. */
export type DesktopScope = {
  profileKey: string;
  scopeVersion: number;
  caseId?: string;
  processKey?: string;
  /** Captured case stage generation. New renderer writes include this value. */
  caseRevision?: number;
};

export type FlowNode = {
  name: string;
  user: string;
  running: boolean;
  finished: boolean;
  start: string;
  end: string;
  stayHours?: number;
  type?: string;
  isCurrent?: boolean;
  sort?: number;
  serial?: number;
  total?: number;
};

export type FlowView = {
  at: string;
  currentProcessId?: string;
  processes: Case['remote'];
  nodes: FlowNode[];
  history: { name: string; created: string; finished: string }[];
  currentFlow?: { name: string; user: string; serial?: number; total?: number };
};

export type { Case, Settings, Workspace };
