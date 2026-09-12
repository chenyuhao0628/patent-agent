import type {
  AgentAction,
  AgentJobState,
  AgentProcessState,
  ClassificationInput,
} from './domain/agent.ts';

export type ClassificationSuggestion = { classification: import('./domain/agent.ts').OpenClassification; evidence: string[]; warnings: string[] };

export type AgentCaseView = {
  classificationSuggestion?: ClassificationSuggestion;
  profileKey: string;
  caseId: string;
  processKey: string;
  process: AgentProcessState;
  busy: boolean;
  partialText?: string;
  model?: { providerName: string; modelId: string; protocol: string; reasoningLevel: string };
  artifacts: Array<{ id: string; title: string; kind: string; relativePath: string; at: string; versionId?: string }>;
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

export type AgentCommand =
  | { type: 'classify'; classification: ClassificationInput }
  | { type: 'materials'; selectedIds: string[] }
  | { type: 'discussion'; title?: string }
  | { type: 'manageDiscussion'; discussionId:string; operation:'delete'|'archive'|'restore' }
  | { type: 'run'; action: AgentAction; discussionId?: string; userMessage?: string; resumeFromRunId?: string }
  | { type: 'stop'; runId?: string }
  | { type: 'strategy'; strategyId: string }
  | { type: 'adopt'; versionId: string }
  | { type: 'issues'; reviewId: string; issueIds: string[]; handled?: boolean }
  | { type: 'applicationParts'; parts:import('./domain/application-parts.ts').ApplicationParts }
  | { type: 'correctionContents'; items:import('./domain/correction.ts').CorrectionContent[] }
  | { type: 'finalize' };

export type AgentAPI = {
  getCase(profileKey: string, caseId: string): Promise<AgentCaseView>;
  command(profileKey: string, caseId: string, command: AgentCommand): Promise<AgentCaseView>;
  listTasks(profileKey: string): Promise<AgentTaskView[]>;
  onState(callback: (view: AgentCaseView) => void): () => void;
};
