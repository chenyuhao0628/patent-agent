import type { EngineSessionScope } from './engine-sessions.ts';
import type { EngineSessionView } from '../src/domain/engine-session.ts';
import type { TaskProgress, TaskContract } from '../src/domain/task-progress.ts';
import type { TaskMemory } from '../src/domain/task-memory.ts';
import type { ArtifactQuality, EvidencePolicy } from '../src/domain/agent-evidence.ts';
import type { McpConfig } from './extensions.ts';
import type { RuntimeModelConfig } from './model-service.ts';
import type { FrozenMaterial, ReadMaterialCallback, ToolEvent, WrittenArtifact } from './agent-broker.ts';

/** Version 1 execution contract shared by hosts and engine adapters. */
export const AGENT_EXECUTION_CONTRACT_VERSION=1 as const;
export type PublicChatMessage = {
  sourceId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type AgentEvent =
  | { type: 'session'; session: EngineSessionView }
  | { type:'progress'; progress:TaskProgress }
  | { type: 'quality'; quality: ArtifactQuality }
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'activity'; label: string; stepId?: string; status?: string }
  | { type: 'tool'; event: ToolEvent }
  | { type: 'status'; status: string }
  | { type: 'error'; code: string; message: string };

export type AgentRunInput = {
  sessionScope?: EngineSessionScope;
  taskContract?:TaskContract;
  taskMemory?: TaskMemory;
  evidencePolicy?: EvidencePolicy;
  recoveryJournalPath?: string;
  customMcp?:Record<string,McpConfig>;
  skillResources?: Array<{path:string;text:string}>;
  runtime: RuntimeModelConfig;
  runId: string;
  discussionId: string;
  localRunDirectory: string;
  materials: FrozenMaterial[];
  draftText?: string;
  productPrompt: string;
  publicMessages: PublicChatMessage[];
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
  deadlineMs?: number;
  review?: boolean;
  allowedArtifacts?: string[];
  artifactExpect?: import('./agent-artifact.ts').ParseArtifactExpect;
  validateArtifact?: (raw: string) => Promise<string | undefined>;
  artifactScope?: string;
  recoveryArtifactRoot?: string;
  snapshotRoot?: string;
  readMaterial?: ReadMaterialCallback;
};

export type AgentRunResult = {
  session?: EngineSessionView;
  status: 'completed' | 'aborted' | 'failed';
  finalText: string;
  toolEvents: ToolEvent[];
  artifact?: WrittenArtifact;
  error?: { code: string; message: string; detail?: string };
};

export type AgentRunner = {
  run(input: AgentRunInput): Promise<AgentRunResult>;
};
