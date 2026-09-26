import { useEffect, useState } from 'react';
import { updateRound } from './domain/workflow.ts';
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
import { isCaseTab, navigate, readRoute } from './app/navigation.ts';
import { AppShell } from './app/app-shell.tsx';
import { PageContent } from './app/page-content.tsx';
import { completeExpiredJobs, patchCase, persistBrowserOnPageHide, persistBrowserWorkspace } from './app/workspace-store.ts';

export function App({ nativeState, refresh }: { nativeState?: DesktopState; refresh?: (state: DesktopState) => void } = {}) {
  const [loaded] = useState(() => nativeState ? { workspace: nativeState.workspace, error: null } : loadWorkspace());
  const [data, setData] = useState<Workspace>(loaded.workspace);
  const [storageError, setStorageError] = useState<string | null>(loaded.error);
  const [route, setRoute] = useState(readRoute);
  const [syncError, setSyncError] = useState('');
  const [importing, setImporting] = useState(false);
  const page = route[0] || 'library';
  const item = page === 'case' ? data.cases.find(caseItem => caseItem.id === route[1]) : undefined;
  const tab: CaseTab = desktop && route[2] === 'reply' ? 'discussion' : isCaseTab(route[2]) ? route[2] : 'overview';
  const module = ['reply', 'write', 'review', 'transfer'].includes(page) ? page as Module : undefined;
  const activeNav = item
    ? inOfficialWaiting(item)
      ? 'official'
      : ['overview', 'materials', 'history', 'flow', 'discussion'].includes(tab)
        ? 'library'
        : tab === 'outputs'
          ? 'transfer'
          : workModule(item)
    : page;

  useEffect(() => {
    const handler = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    if (nativeState) setData(nativeState.workspace);
  }, [nativeState]);
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

  const openCase = (caseItem: Case, nextTab: CaseTab = 'overview', roundId?: string) => {
    navigate(`/case/${caseItem.id}/${nextTab}${roundId ? `/${roundId}` : ''}`);
  };
  const updateCase = async (id: string, patch: Partial<Case>) => {
    const next = patchCase(data, id, patch);
    setData(next);
    if (desktop && nativeState) {
      try {
        await desktop.saveWorkspace(nativeState.profileKey, next);
      } catch (error) {
        setStorageError((error as Error).message);
        throw error;
      }
    }
  };
  const archiveCases = (ids: string[], archived: boolean) => {
    const next = { ...data, cases: data.cases.map(caseItem => ids.includes(caseItem.id) ? { ...caseItem, archived } : caseItem) };
    setData(next);
    if (desktop && nativeState) void desktop.saveWorkspace(nativeState.profileKey, next).catch(error => setStorageError(error.message));
  };
  const saveSettings = async (settings: Workspace['settings']) => {
    if (desktop && nativeState) {
      const saved = await desktop.saveSettings(nativeState.profileKey, settings);
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
    onSync={() => void desktop?.sync().then(() => setSyncError('')).catch(error => setSyncError(error.message))}
    onOpenSettings={() => navigate('/settings')}
  >
    <PageContent
      page={page}
      tab={tab}
      item={item}
      module={module}
      requestedRoundId={route[3]}
      settingsSection={route[1]}
      data={data}
      nativeState={nativeState}
      refresh={refresh}
      onOpenCase={openCase}
      onUpdateCase={updateCase}
      onDispatch={(caseId, roundId, action) => setData(workspace => updateRound(workspace, caseId, roundId, action))}
      onArchive={archiveCases}
      onImport={() => module ? navigate('/library') : setImporting(true)}
      onSaveSettings={saveSettings}
    />
    {importing && <Modal title={desktop ? '新建本地案件' : '导入通知书 · 示例'} onClose={() => setImporting(false)}>
      {desktop
        ? <LocalCaseForm done={state => {
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
