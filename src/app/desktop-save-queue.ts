import type { DesktopState, DesktopScope } from '../contracts/desktop-state.ts';
import type { Case, Workspace } from '../domain/workflow.ts';
import { acceptDesktopState, desktopScopeOf, sameDesktopScope } from './scope.ts';

type PendingEdit = { id: string; patch: Partial<Case>; scope: DesktopScope };
const applyEdit = (workspace:Workspace,edit:PendingEdit):Workspace => ({
  ...workspace,cases:workspace.cases.map(c=>c.id===edit.id?{...c,...edit.patch}:c),
});

export function createDesktopSaveQueue(initial: DesktopState, options: {
  save: (key: string, workspace: Workspace, scope: DesktopScope) => Promise<DesktopState>;
  isActive: () => boolean;
  onChange: (workspace: Workspace) => void;
  onState: (state: DesktopState) => void;
}) {
  let state = initial;
  let tail = Promise.resolve();
  const pending: PendingEdit[] = [];
  const scope = (id?: string) => desktopScopeOf(state, id);
  const preview = () => pending.reduce((workspace, edit) =>
    sameDesktopScope(scope(edit.id), edit.scope) ? applyEdit(workspace, edit) : workspace, state.workspace);
  const receive = (incoming: DesktopState) => {
    state = acceptDesktopState(state, incoming);
    return preview();
  };
  const stale = () => new Error('账号或案件作用域已变化，请重新打开当前页面。');

  async function enqueue(id: string, patch: Partial<Case>, expected?: DesktopScope) {
    if (!options.isActive() || !expected || expected.caseId !== id || !sameDesktopScope(scope(id), expected)) throw stale();
    const edit: PendingEdit = { id, patch: structuredClone(patch), scope: { ...expected } };
    pending.push(edit);
    options.onChange(preview());
    const task = tail.then(async () => {
      if (!options.isActive() || !sameDesktopScope(scope(id), edit.scope)) throw stale();
      const sent = { ...edit.scope };
      const saved = await options.save(sent.profileKey, applyEdit(state.workspace, edit), sent);
      if (!options.isActive() || state.profileKey !== sent.profileKey || state.scopeVersion !== sent.scopeVersion) throw stale();
      const confirmed = desktopScopeOf(saved, id);
      if (!confirmed || saved.profileKey !== sent.profileKey || saved.scopeVersion !== sent.scopeVersion) throw stale();
      // Only already queued edits may follow this queue's own archive change.
      // Never grant an old page a new scope after an external or A-B-A switch.
      if (edit.patch.archived !== undefined && edit.patch.current === undefined
        && sameDesktopScope({ ...confirmed, caseRevision: sent.caseRevision }, sent)
        && confirmed.caseRevision === (sent.caseRevision ?? 0) + 1) {
        for (const next of pending) {
          if (next !== edit && sameDesktopScope(next.scope, sent)) next.scope = { ...confirmed };
        }
      }
      receive(saved);
      options.onState(state);
    }).finally(() => {
      pending.splice(pending.indexOf(edit), 1);
      if (options.isActive()) options.onChange(preview());
    });
    tail = task.catch(() => {});
    return task;
  }
  return { enqueue, receive, scope };
}
