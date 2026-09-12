import { pauseRunning, seedWorkspace } from './workflow.ts';
import type { Workspace } from './workflow.ts';
import { normalizeWorkspace } from './lifecycle.ts';

// A separate local fixture keeps automated UI checks away from the user's prototype.
export const storageKey = 'patent-workbench.prototype.v2' + (new URLSearchParams(location.search).get('qa') === '1' ? '.qa' : '');
export function loadWorkspace(): { workspace: Workspace; error: string | null } {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { workspace: normalizeWorkspace(seedWorkspace()), error: null };
    const data = JSON.parse(raw) as Workspace;
    if (data.schema !== 1 || !Array.isArray(data.cases) || !data.settings || data.cases.some(c => !c.id || !Array.isArray(c.rounds) || !c.rounds.length || c.rounds.some(r => !Array.isArray(r.materials) || !Array.isArray(r.versions) || !Array.isArray(r.finalHistory) || !r.discussions?.length))) throw new Error('Unsupported snapshot');
    return { workspace: normalizeWorkspace(pauseRunning(data)), error: null };
  } catch {
    return { workspace: seedWorkspace(), error: '本机原型记录无法读取，已保留原数据。本次进入临时预览，操作不会覆盖旧记录。' };
  }
}
