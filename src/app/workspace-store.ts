import { pauseRunning, updateRound } from '../domain/workflow.ts';
import type { Case, Workspace } from '../domain/workflow.ts';
import { storageKey } from '../domain/persistence.ts';

export function persistBrowserWorkspace(workspace: Workspace, onError: (message: string) => void) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(workspace));
  } catch {
    onError('本机存储写入失败。当前操作仅保留在此页面，关闭前请保留重要内容。');
  }
}

export function persistBrowserOnPageHide(workspace: Workspace, onError: (message: string) => void) {
  persistBrowserWorkspace(pauseRunning(workspace), onError);
}

export function patchCase(workspace: Workspace, id: string, patch: Partial<Case>) {
  return { ...workspace, cases: workspace.cases.map(item => item.id === id ? { ...item, ...patch } : item) };
}

export function completeExpiredJobs(workspace: Workspace) {
  let next = workspace;
  for (const item of workspace.cases) {
    for (const round of item.rounds) {
      if (round.job?.status === 'running' && round.job.due <= Date.now()) {
        next = updateRound(next, item.id, round.id, { type: 'complete', jobId: round.job.id });
      }
    }
  }
  return next;
}
