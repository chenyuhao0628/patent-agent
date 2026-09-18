import type {
  AgentAction,
  AgentJobState,
  AgentProcessState,
  ClassificationInput,
} from './domain/agent.ts';

export type ClassificationSuggestion = { classification: import('./domain/agent.ts').OpenClassification; evidence: string[]; warnings: string[] };
export type AgentPreparation={profileKey:string;caseId:string;processKey:string;step:'queued'|'preparing'|'materials'|'permission'|'dispatch'|'done'};

export type AgentCaseView = {
  classificationSuggestion?: ClassificationSuggestion;
  profileKey: string;
  caseId: string;
  processKey: string;
  process: AgentProcessState;
  busy: boolean;
  partialText?: string;
  /** Terminal persist failed; UI/recovery should treat in-memory state as not on disk. */
  persistAlert?: string;
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
  | { type:'queue'; discussionId:string; operation:'add'|'edit'|'remove'|'send'; id?:string; text?:string; purpose?:'workflow'|'discuss'; expectedRunId?:string }
  | { type: 'conversation'; queueId?:string; discussionId: string; operation: 'continue' | 'retry' | 'edit' | 'regenerate'; runId?: string; messageId?: string; text?: string }
  | { type: 'opened' }
  | { type: 'clearConversation'; discussionId: string }
  | { type: 'branch'; discussionId: string; branchId: string }
  | { type: 'classify'; classification: ClassificationInput }
  | { type: 'materials'; selectedIds: string[] }
  | { type: 'discussion'; title?: string }
  | { type: 'manageDiscussion'; discussionId:string; operation:'delete'|'archive'|'restore' }
  | { type: 'run'; queueId?:string; action: AgentAction; discussionId?: string; userMessage?: string; resumeFromRunId?: string }
  | { type: 'stop'; runId?: string }
  | { type: 'strategy'; queueId?:string; strategyId: string; startDraft?:boolean; userMessage?:string }
  | {type:'restoreDraft';versionId:string}
  | { type: 'adopt'; versionId: string }
  | { type: 'issues'; reviewId: string; issueIds: string[]; handled?: boolean }
  | { type: 'applicationParts'; parts:import('./domain/application-parts.ts').ApplicationParts }
  | { type: 'correctionContents'; items:import('./domain/correction.ts').CorrectionContent[] }
  | { type: 'updateDraft'; text?: string; amendmentText?: string; applicationParts?: import('./domain/application-parts.ts').ApplicationParts; correctionContents?: import('./domain/correction.ts').CorrectionContent[]; amendmentBasis?: string; reviewNotes?: string }
  | { type: 'finalize' }
  | { type: 'unfinalize' }
  | { type: 'setStage'; stage: import('./domain/agent.ts').AgentStage };

export type AgentAPI = {
  onPreparation?: (callback:(event:AgentPreparation)=>void)=>()=>void;
  listProgress?: (profileKey: string) => Promise<import('./domain/local-progress.ts').LocalProgress[]>;
  getCase(profileKey: string, caseId: string): Promise<AgentCaseView>;
  command(profileKey: string, caseId: string, command: AgentCommand): Promise<AgentCaseView>;
  listTasks(profileKey: string): Promise<AgentTaskView[]>;
  onState(callback: (view: AgentCaseView) => void): () => void;
};
