export type DesktopScope = {
  profileKey: string;
  scopeVersion?: number;
};

export function sameDesktopScope(current: DesktopScope | undefined, expected: Partial<DesktopScope> | undefined): boolean {
  if (!expected) return true;
  return !!current
    && (expected.profileKey === undefined || current.profileKey === expected.profileKey)
    && (expected.scopeVersion === undefined || current.scopeVersion === expected.scopeVersion);
}
