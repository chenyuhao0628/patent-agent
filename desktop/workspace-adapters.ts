import { createAdapterRegistry, type AdapterDefinition } from '../src/contracts/adapter-registry.ts';
import { FileWorkspaceRepository, type WorkspaceRepository } from './workspace-repository.ts';
export const WORKSPACE_CAPABILITIES=['profile-isolation','checked-records','guarded-writes','preserve-unknown-fields'] as const;
export type WorkspaceAdapter=AdapterDefinition<{root:string},WorkspaceRepository>;
export const localWorkspaceAdapter:WorkspaceAdapter={id:'local-files',contractVersion:1,capabilities:WORKSPACE_CAPABILITIES,create:({root})=>new FileWorkspaceRepository(root)};
export function createWorkspaceAdapters(adapters:readonly WorkspaceAdapter[]){return createAdapterRegistry(adapters,WORKSPACE_CAPABILITIES);}
export const workspaceAdapters=createWorkspaceAdapters([localWorkspaceAdapter]);
