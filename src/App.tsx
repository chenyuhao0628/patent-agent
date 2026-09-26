import { useEffect, useRef, useState } from 'react';
import type { Case, Workspace } from './domain/workflow.ts';
import { loadWorkspace } from './domain/persistence.ts';
import type { CaseTab } from './components/CaseSpace.tsx';
import { ImportCases } from './components/ImportCases.tsx';
import { Modal } from './components/Primitives.tsx';
import { LocalCaseForm } from './components/LocalCaseForm.tsx';
import { desktop } from './desktop.ts';
import type { DesktopState } from './desktop.ts';
import { inOfficialWaiting, type Module } from './domain/library.ts';
import { workModule } from './domain/lifecycle.ts';
import { casePath, isCaseTab, navigate, readRoute, type CaseNavigationTarget } from './app/navigation.ts';
import { AppShell } from './app/app-shell.tsx';
import { PageContent } from './app/page-content.tsx';
import { sameDesktopScope } from './app/scope.ts';
import type { DesktopScope } from './app/scope.ts';
import { createDesktopSaveQueue } from './app/desktop-save-queue.ts';
import { completeExpiredJobs, patchCase, persistBrowserOnPageHide, persistBrowserWorkspace } from './app/workspace-store.ts';

export function App({ nativeState, refresh }: { nativeState?: DesktopState; refresh?: (state: DesktopState) => void } = {}) {
  const [loaded] = useState(() => nativeState ? { workspace: nativeState.workspace, error: null } : loadWorkspace());
  const [data, setData] = useState<Workspace>(loaded.workspace);
  const active=useRef(true);
  const [saveQueue]=useState(()=>desktop&&nativeState?createDesktopSaveQueue(nativeState,{
    save:desktop.saveWorkspace,
    isActive:()=>active.current,
    onChange:setData,
    onState:state=>refresh?.(state),
  }):undefined);
  const [receivedWorkspace,setReceivedWorkspace]=useState(nativeState?.workspace);
  if(nativeState&&receivedWorkspace!==nativeState.workspace){
    setReceivedWorkspace(nativeState.workspace);
    setData(saveQueue?.receive(nativeState)??nativeState.workspace);
  }
  const [storageError, setStorageError] = useState<string | null>(loaded.error);
  const [route, setRoute] = useState(readRoute);
  const [syncError, setSyncError] = useState('');
  const [importing, setImporting] = useState(false);
  const nativeStateRef = useRef(nativeState);
  const dataRef = useRef(data);
  nativeStateRef.current = nativeState;
  dataRef.current = data;
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const page = route[0] || 'library';
  const item = page === 'case' ? data.cases.find(caseItem => caseItem.id === route[1]) : undefined;
  const tab: CaseTab = isCaseTab(route[2]) ? route[2] : 'overview';
  const module = ['reply', 'write', 'review', 'transfer'].includes(page) ? page as Module : undefined;
  const activeNav = item
    ? inOfficialWaiting(item)
      ? 'official'
      : 'library'
    : page === 'reply' || page === 'write' ? 'library' : page;

  useEffect(() => {
    const handler = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    if (loaded.error || desktop) return;
    persistBrowserWorkspace(data, setStorageError);
  }, [data, loaded.error]);
  useEffect(() => {
    const handler = () => {
      if (!loaded.error && !desktop) persistBrowserOnPageHide(data, setStorageError);
    };
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [data, loaded.error]);
  useEffect(() => {
    if (desktop) return;
    const id = setInterval(() => setData(workspace => completeExpiredJobs(workspace)), 350);
    return () => clearInterval(id);
  }, []);

  const openCase = (caseItem: Case, nextTab: CaseTab = 'overview', target?: CaseNavigationTarget | string) => {
    const navigationTarget = typeof target === 'string' ? { roundId: target } : target;
    location.hash = casePath(caseItem.id, nextTab, navigationTarget);
  };
  const currentScope = (caseId?: string): DesktopScope | undefined => saveQueue?.scope(caseId);
  const updateCase = async (id: string, patch: Partial<Case>, expectedScope?: DesktopScope) => {
    try {
      if (saveQueue) await saveQueue.enqueue(id,patch,expectedScope);
      else {
        const next = patchCase(dataRef.current, id, patch);
        dataRef.current = next;
        setData(next);
      }
    } catch (error) {
      if(active.current&&sameDesktopScope(currentScope(expectedScope?.caseId),expectedScope))setStorageError((error as Error).message);
      throw error;
    }
  };
  const archiveCases = (ids: string[], archived: boolean) => {
    if (saveQueue) {
      void Promise.all(ids.map(id=>saveQueue.enqueue(id,{archived},currentScope(id))))
        .catch(error=>{if(active.current)setStorageError(error.message);});
      return;
    }
    const next = { ...dataRef.current, cases: dataRef.current.cases.map(caseItem => ids.includes(caseItem.id) ? { ...caseItem, archived } : caseItem) };
    dataRef.current = next;
    setData(next);
  };
  const saveSettings = async (settings: Workspace['settings']) => {
    if (desktop && nativeState) {
      const expected=currentScope();
      const saved = await desktop.saveSettings(nativeState.profileKey, settings);
      if(!active.current||!sameDesktopScope(currentScope(),expected))throw new Error('账号已变化，请重新读取设置。');
      refresh?.(saved);
      return saved.workspace.settings;
    }
    setData(workspace => ({ ...workspace, settings }));
    return settings;
  };

  return <AppShell
    page={page}
    item={item}
    tab={tab}
    module={module}
    activeNav={activeNav}
    data={data}
    nativeState={nativeState}
    storageError={storageError}
    syncError={syncError}
    onSync={() => void desktop?.sync().then(() => {if(active.current)setSyncError('');}).catch(error => {if(active.current)setSyncError(error.message);})}
    onOpenSettings={() => navigate('/settings')}
  >
    <PageContent
      page={page}
      tab={tab}
      item={item}
      module={module}
      requestedTarget={route[3]}
      settingsSection={route[1]}
      data={data}
      nativeState={nativeState}
      refresh={refresh}
      onOpenCase={openCase}
      onUpdateCase={updateCase}
      onArchive={archiveCases}
      onImport={() => module ? navigate('/library') : setImporting(true)}
      onSaveSettings={saveSettings}
    />
    {importing && <Modal title={desktop ? '新建本地案件' : '导入通知书 · 示例'} onClose={() => setImporting(false)}>
      {desktop
        ? <LocalCaseForm done={state => {
          if(!active.current||state.profileKey!==nativeStateRef.current?.profileKey||state.scopeVersion!==nativeStateRef.current?.scopeVersion)return;
          refresh?.(state);
          setImporting(false);
          const created = state.workspace.cases.at(-1);
          if (created) openCase(created, workModule(created) as CaseTab);
        }}/>
        : <ImportCases create={created => {
          setData(workspace => ({ ...workspace, cases: [...created, ...workspace.cases] }));
          setImporting(false);
          if (created.length === 1) openCase(created[0]);
        }}/>}
    </Modal>}
  </AppShell>;
}
