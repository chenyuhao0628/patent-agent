import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Case, Workspace } from './domain/workflow.ts';
import type { CaseTab } from './components/CaseSpace.tsx';
import { ImportCases } from './components/ImportCases.tsx';
import { Modal } from './components/Primitives.tsx';
import { LocalCaseForm } from './components/LocalCaseForm.tsx';
import { desktop } from './desktop.ts';
import { inOfficialWaiting, type Module } from './domain/library.ts';
import { workModule } from './domain/lifecycle.ts';
import { casePath, isCaseTab, navigate, readRoute, type CaseNavigationTarget } from './app/navigation.ts';
import { AppShell } from './app/app-shell.tsx';
import { PageContent } from './app/page-content.tsx';
import type { DesktopScope } from './app/scope.ts';
import type { WorkspaceStore } from './app/workspace-data.ts';
import { completeExpiredJobs, persistBrowserOnPageHide, persistBrowserWorkspace } from './app/workspace-store.ts';

export function App({ store }: { store: WorkspaceStore }) {
  const {workspace:data,nativeState,error:storageError}=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const [loadedError]=useState(storageError);
  const refresh=store.receive,setStorageError=store.setError;
  const active=useRef(true);
  const [route, setRoute] = useState(readRoute);
  const [syncError, setSyncError] = useState('');
  const [importing, setImporting] = useState(false);
  const nativeStateRef = useRef(nativeState);
  nativeStateRef.current = nativeState;
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
    if (loadedError || desktop) return;
    persistBrowserWorkspace(data, setStorageError);
  }, [data, loadedError]);
  useEffect(() => {
    const handler = () => {
      if (!loadedError && !desktop) persistBrowserOnPageHide(data, setStorageError);
    };
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [data, loadedError]);
  useEffect(() => {
    if (desktop) return;
    const id = setInterval(() => store.updatePreview(completeExpiredJobs), 350);
    return () => clearInterval(id);
  }, []);

  const openCase = (caseItem: Case, nextTab: CaseTab = 'overview', target?: CaseNavigationTarget | string) => {
    const navigationTarget = typeof target === 'string' ? { roundId: target } : target;
    location.hash = casePath(caseItem.id, nextTab, navigationTarget);
  };
  const updateCase=(id:string,patch:Partial<Case>,expectedScope?:DesktopScope)=>store.updateCase(id,patch,expectedScope);
  const archiveCases=(ids:string[],archived:boolean)=>{void store.archive(ids,archived).catch(error=>{if(active.current)setStorageError(error.message);});};
  const saveSettings=store.saveSettings;

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
          store.updatePreview(workspace => ({ ...workspace, cases: [...created, ...workspace.cases] }));
          setImporting(false);
          if (created.length === 1) openCase(created[0]);
        }}/>}
    </Modal>}
  </AppShell>;
}
