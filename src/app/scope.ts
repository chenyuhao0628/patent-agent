export type { DesktopScope } from '../contracts/desktop-state.ts';
import type { DesktopScope } from '../contracts/desktop-state.ts';

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
    && current.processKey === expected.processKey;
}
