import { createAdapterRegistry, type AdapterDefinition } from '../src/contracts/adapter-registry.ts';
import { AGENT_EXECUTION_CONTRACT_VERSION, type AgentRunner } from './agent-contract.ts';
import { OpenCodeRunner } from './agent-runner.ts';
export type EngineAdapterOptions={binaryPath:string;runtimeIdentity?:string;fetchImpl?:typeof fetch};
export const ENGINE_CAPABILITIES=['structured-events','cancellation','scoped-tools','validated-artifacts','retained-sessions'] as const;
export type EngineAdapter=AdapterDefinition<EngineAdapterOptions,AgentRunner>;
export const openCodeAdapter:EngineAdapter={id:'opencode',contractVersion:AGENT_EXECUTION_CONTRACT_VERSION,capabilities:ENGINE_CAPABILITIES,create:options=>new OpenCodeRunner(options)};
export function createEngineAdapters(adapters:readonly EngineAdapter[]){return createAdapterRegistry(adapters,ENGINE_CAPABILITIES,AGENT_EXECUTION_CONTRACT_VERSION);}
export const engineAdapters=createEngineAdapters([openCodeAdapter]);
