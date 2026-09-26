export type { DesktopScope } from '../contracts/desktop-state.ts';
import type { DesktopScope } from '../contracts/desktop-state.ts';
import type { DesktopState } from '../contracts/desktop-state.ts';
import { currentWork } from '../domain/lifecycle.ts';

export function acceptDesktopState(current:DesktopState|null,incoming:DesktopState):DesktopState {
  if(current&&(incoming.scopeVersion<current.scopeVersion
    ||incoming.scopeVersion===current.scopeVersion&&incoming.profileKey!==current.profileKey))return current;
  if(current&&incoming.scopeVersion===current.scopeVersion&&incoming.snapshotVersion<current.snapshotVersion)return current;
  if(current&&incoming.scopeVersion===current.scopeVersion
    &&Object.entries(current.caseRevisions??{}).some(([id,revision])=>(incoming.caseRevisions?.[id]??0)<revision))return current;
  return incoming;
}

export function desktopScopeOf(state:DesktopState,caseId?:string):DesktopScope|undefined {
  const account={profileKey:state.profileKey,scopeVersion:state.scopeVersion};
  if(!caseId)return account;
  const c=state.workspace.cases.find(item=>item.id===caseId);
  if(!c)return undefined;
  const work=currentWork(c);
  return {...account,caseId,processKey:(work.processId||work.roundId||`local-${work.kind}`).trim(),caseRevision:state.caseRevisions[caseId]??0};
}

function validScopeShape(scope: DesktopScope): boolean {
  return (scope.caseId === undefined) === (scope.processKey === undefined);
}

export function sameDesktopScope(current: DesktopScope | undefined, expected: DesktopScope | undefined): boolean {
  if (!expected) return true;
  return !!current
    && validScopeShape(current)
    && validScopeShape(expected)
    && current.profileKey === expected.profileKey
    && current.scopeVersion === expected.scopeVersion
    && current.caseId === expected.caseId
    && current.processKey === expected.processKey
    && current.caseRevision === expected.caseRevision;
}
