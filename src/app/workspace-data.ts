import type { DesktopAPI } from '../contracts/desktop-api.ts';
import type { DesktopScope, DesktopState } from '../contracts/desktop-state.ts';
import type { Case, Workspace } from '../domain/workflow.ts';
import { caseScopeFingerprint } from '../domain/lifecycle.ts';
import { createDesktopSaveQueue } from './desktop-save-queue.ts';
import { acceptDesktopState, desktopScopeOf, sameDesktopScope } from './scope.ts';

export type WorkspaceSnapshot = { workspace: Workspace; nativeState?: DesktopState; error: string | null };
type DataAPI = Pick<DesktopAPI, 'saveWorkspace' | 'saveSettings'>;
const empty = (): Workspace => ({schema:1,cases:[],settings:{provider:'',baseUrl:'',model:''}});

/** The only renderer owner of the working case snapshot. Pending edits are
 * projections over the main-process snapshot, never an independent database. */
export function createWorkspaceStore(options: { initial?: DesktopState; preview?: Workspace; error?: string | null; api?: DataAPI } = {}) {
  let alive = true, epoch = 0;
  let snapshot: WorkspaceSnapshot = {workspace:options.initial?.workspace ?? options.preview ?? empty(),nativeState:options.initial,error:options.error ?? null};
  let authority = options.initial;
  let queue: ReturnType<typeof createDesktopSaveQueue> | undefined;
  const listeners = new Set<() => void>();
  const previewRevisions: Record<string, number> = {};
  const publish = (next: WorkspaceSnapshot) => {
    if (!alive || next.workspace === snapshot.workspace && next.nativeState === snapshot.nativeState && next.error === snapshot.error) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const setError = (message: string | null) => publish({...snapshot,error:message});
  const setupQueue = (initial: DesktopState) => {
    const token = ++epoch;
    return createDesktopSaveQueue(initial, {
      save: options.api!.saveWorkspace,
      isActive: () => alive && epoch === token,
      onChange: workspace => { if (alive && epoch === token) publish({...snapshot,workspace}); },
      onState: state => {
        if (!alive || epoch !== token) return;
        authority = acceptDesktopState(authority ?? null, state);
        publish({...snapshot,nativeState:authority});
      },
    });
  };
  if (authority && options.api) queue = setupQueue(authority);
  const receive = (incoming: DesktopState) => {
    if (!alive) return;
    const next = acceptDesktopState(authority ?? null, incoming);
    if (next === authority) return;
    const changed = !authority || authority.profileKey !== next.profileKey || authority.scopeVersion !== next.scopeVersion;
    authority = next;
    if (options.api && changed) queue = setupQueue(next);
    publish({workspace:queue?.receive(next) ?? next.workspace,nativeState:next,error:changed ? null : snapshot.error});
  };
  const previewState = (): DesktopState => ({
    profileKey:'preview',scopeVersion:0,snapshotVersion:0,caseRevisions:previewRevisions,workspace:snapshot.workspace,
    account:null,sync:{running:false,message:''},storage:{running:false,message:''},migration:{running:false,phase:'idle',canCancel:false,message:''},version:'preview',dataDirectory:'',
  });
  const scope = (caseId?: string) => alive ? queue?.scope(caseId) ?? (!options.api ? desktopScopeOf(previewState(),caseId) : undefined) : undefined;
  const updatePreview = (update: (workspace: Workspace) => Workspace) => {
    if (options.api) throw new Error('桌面案件必须通过受控写入保存。');
    if (!alive) throw new Error('工作区已关闭。');
    const next = update(snapshot.workspace);
    for (const item of next.cases) {
      const previous = snapshot.workspace.cases.find(c=>c.id===item.id);
      if (previous && caseScopeFingerprint(previous)!==caseScopeFingerprint(item)) previewRevisions[item.id]=(previewRevisions[item.id]??0)+1;
    }
    publish({...snapshot,workspace:next});
  };
  const updateCase = async (id: string, patch: Partial<Case>, expected?: DesktopScope) => {
    try {
      if (!alive) throw new Error('工作区已关闭。');
      if (options.api) {
        if (!queue) throw new Error('工作区尚未加载。');
        await queue.enqueue(id,patch,expected);
      } else {
        if (expected && !sameDesktopScope(scope(id),expected)) throw new Error('案件作用域已变化。');
        updatePreview(workspace=>({...workspace,cases:workspace.cases.map(c=>c.id===id?{...c,...structuredClone(patch)}:c)}));
      }
    } catch (error) {
      if (alive && sameDesktopScope(scope(expected?.caseId),expected)) setError((error as Error).message);
      throw error;
    }
  };
  const saveSettings = async (settings: Workspace['settings']) => {
    const expected=scope();
    if (!alive) throw new Error('工作区已关闭。');
    if (options.api) {
      if (!expected) throw new Error('工作区尚未加载。');
      const saved=await options.api.saveSettings(expected.profileKey,settings);
      if (!alive || !sameDesktopScope(scope(),expected)) throw new Error('账号已变化，请重新读取设置。');
      receive(saved);
      return snapshot.workspace.settings;
    }
    updatePreview(workspace=>({...workspace,settings}));
    return settings;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {listeners.add(listener);return () => {listeners.delete(listener);};},
    receive,scope,updateCase,saveSettings,updatePreview,setError,
    archive: (ids: string[], archived: boolean) => Promise.all(ids.map(id=>updateCase(id,{archived},scope(id)))),
    dispose: () => {alive=false;epoch++;listeners.clear();},
  };
}
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
