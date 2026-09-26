import type { AgentStage, ClassificationInput } from './agent.ts';
import type { ApplicationParts } from './application-parts.ts';
import type { CorrectionContent } from './correction.ts';

export type AgentCommand =
  | { type: 'queue'; discussionId: string; operation: 'add' | 'edit' | 'remove' | 'send'; id?: string; text?: string; purpose?: 'workflow' | 'discuss'; expectedRunId?: string }
  | { type: 'conversation'; queueId?: string; discussionId: string; operation: 'continue' | 'retry' | 'edit' | 'regenerate'; runId?: string; messageId?: string; text?: string }
  | { type: 'opened' }
  | { type: 'clearConversation'; discussionId: string }
  | { type: 'branch'; discussionId: string; branchId: string }
  | { type: 'classify'; classification: ClassificationInput }
  | { type: 'materials'; selectedIds: string[] }
  | { type: 'discussion'; title?: string }
  | { type: 'manageDiscussion'; discussionId: string; operation: 'delete' | 'archive' | 'restore' }
  | { type: 'run'; queueId?: string; action: import('./agent.ts').AgentAction; discussionId?: string; userMessage?: string; resumeFromRunId?: string }
  | { type: 'stop'; runId?: string }
  | { type: 'strategy'; queueId?: string; strategyId: string; startDraft?: boolean; userMessage?: string }
  | { type: 'restoreDraft'; versionId: string }
  | { type: 'adopt'; versionId: string }
  | { type: 'issues'; reviewId: string; issueIds: string[]; handled?: boolean }
  | { type: 'applicationParts'; parts: ApplicationParts }
  | { type: 'correctionContents'; items: CorrectionContent[] }
  | { type: 'updateDraft'; text?: string; amendmentText?: string; applicationParts?: ApplicationParts; correctionContents?: CorrectionContent[]; amendmentBasis?: string; reviewNotes?: string }
  | { type: 'finalize' }
  | { type: 'unfinalize' }
  | { type: 'setStage'; stage: AgentStage };
