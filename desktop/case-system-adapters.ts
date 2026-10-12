import { createAdapterRegistry, type AdapterDefinition } from '../src/contracts/adapter-registry.ts';
import { BaselandClient } from './baseland.ts';
import type { CaseSystemClient, CaseSystemFactory } from './case-system-contract.ts';
export type CaseSystemOptions={origin:string;token?:string;fetchImpl?:typeof fetch};
export const CASE_SYSTEM_CAPABILITIES=['personal-cases','case-files','process-query','internal-transfer'] as const;
export type CaseSystemAdapter=AdapterDefinition<CaseSystemOptions,CaseSystemClient>;
export const baselandAdapter:CaseSystemAdapter={id:'baseland',contractVersion:1,capabilities:CASE_SYSTEM_CAPABILITIES,create:options=>new BaselandClient(options.origin,options.token,options.fetchImpl)};
export function createCaseSystemAdapters(adapters:readonly CaseSystemAdapter[]){return createAdapterRegistry(adapters,CASE_SYSTEM_CAPABILITIES);}
export const caseSystemAdapters=createCaseSystemAdapters([baselandAdapter]);
export const defaultCaseSystemFactory:CaseSystemFactory=(origin,token)=>caseSystemAdapters.create('baseland',{origin,token});
