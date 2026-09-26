export type { DesktopScope } from '../contracts/desktop-state.ts';
import type { DesktopScope } from '../contracts/desktop-state.ts';

export function sameDesktopScope(current: DesktopScope | undefined, expected: DesktopScope | undefined): boolean {
  if (!expected) return true;
  return !!current
    && current.profileKey === expected.profileKey
    && current.scopeVersion === expected.scopeVersion
    && (!expected.caseId || current.caseId === expected.caseId)
    && (!expected.processKey || current.processKey === expected.processKey);
}
