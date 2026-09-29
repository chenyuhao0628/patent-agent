import type {
  AgentAction,
  AgentJobState,
  AgentProcessState,
} from './domain/agent.ts';
import type { AgentCommand } from './domain/agent-command.ts';
import type { ReviewSource } from './professional-api.ts';
export type { AgentCommand } from './domain/agent-command.ts';

export const AGENT_API_CONTRACT_VERSION = 1 as const;
export type ClassificationSuggestion = { classification: import('./domain/agent.ts').OpenClassification; evidence: string[]; warnings: string[] };
export type AgentPreparation={profileKey:string;scopeVersion:number;caseId:string;caseRevision:number;processKey:string;step:'queued'|'preparing'|'materials'|'permission'|'dispatch'|'done'};

export type AgentCaseView = {
  classificationSuggestion?: ClassificationSuggestion;
  profileKey: string;
  scopeVersion: number;
  caseId: string;
  caseRevision: number;
  processKey: string;
  process: AgentProcessState;
  busy: boolean;
  partialText?: string;
  /** Terminal persist failed; UI/recovery should treat in-memory state as not on disk. */
  persistAlert?: string;
  model?: { providerName: string; modelId: string; protocol: string; reasoningLevel: string };
  artifacts: Array<{ id: string; title: string; kind: string; relativePath: string; at: string; versionId?: string; externallyModified?: boolean; text?: string; extractionError?: string }>;
};

export type AgentTaskView = {
  professionalKind?:'writing'|'review';
  caseId: string;
  caseNumber: string;
  caseTitle: string;
  processKey: string;
  discussionId: string;
  runId: string;
  action: AgentAction;
  state: AgentJobState;
  startedAt: string;
  endedAt?: string;
  error?: string;
};

export type AgentAPI = {
  onPreparation?: (callback:(event:AgentPreparation)=>void)=>()=>void;
  listProgress?: (profileKey: string) => Promise<import('./domain/local-progress.ts').LocalProgress[]>;
  getCase(profileKey: string, caseId: string): Promise<AgentCaseView>;
  history?: (profileKey: string, caseId: string) => Promise<AgentProcessState[]>;
  reviewSources?: (profileKey: string, caseId?: string) => Promise<ReviewSource[]>;
  command(profileKey: string, caseId: string, command: AgentCommand): Promise<AgentCaseView>;
  listTasks(profileKey: string): Promise<AgentTaskView[]>;
  onState(callback: (view: AgentCaseView) => void): () => void;
};
