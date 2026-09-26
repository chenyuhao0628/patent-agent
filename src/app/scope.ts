export type DesktopScope = {
  profileKey: string;
  scopeVersion: number;
};

export function sameDesktopScope(current: DesktopScope | undefined, expected: DesktopScope | undefined): boolean {
  if (!expected) return true;
  return !!current
    && current.profileKey === expected.profileKey
    && current.scopeVersion === expected.scopeVersion;
}
