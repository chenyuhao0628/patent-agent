import { LocalWorkflow } from '../components/LocalWorkflow.tsx';
import { ReviewQueue } from '../components/ProfessionalWork.tsx';
import { CaseSpace } from '../components/CaseSpace.tsx';
import type { CaseTab } from '../components/CaseSpace.tsx';
import { CaseOutcomeCenter } from '../components/CaseOutcomeCenter.tsx';
import { Library } from '../components/Library.tsx';
import type { Module } from '../components/Library.tsx';
import { TaskCenter } from '../components/TaskCenter.tsx';
import { AgentTasks } from '../components/AgentTasks.tsx';
import { SettingsPage } from '../components/SettingsPage.tsx';
import { Empty } from '../components/Primitives.tsx';
import { desktop } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
import type { Action, Case, Workspace } from '../domain/workflow.ts';
import { currentRoute, internalTransferAvailable } from '../domain/lifecycle.ts';
import { FEATURE_MODULE_BY_ID } from './features.ts';

type PageContentProps = {
  page: string;
  tab: CaseTab;
  item?: Case;
  module?: Module;
  requestedRoundId?: string;
  settingsSection?: string;
  data: Workspace;
  nativeState?: DesktopState;
  refresh?: (state: DesktopState) => void;
  onOpenCase: (item: Case, tab?: CaseTab, roundId?: string) => void;
  onUpdateCase: (id: string, patch: Partial<Case>, scope?: { profileKey?: string; scopeVersion?: number }) => Promise<void>;
  onDispatch: (caseId: string, roundId: string, action: Action) => void;
  onArchive: (ids: string[], archived: boolean) => void;
  onImport: () => void;
  onSaveSettings: (settings: Workspace['settings']) => Promise<Workspace['settings']>;
};

export function PageContent({
  page,
  tab,
  item,
  module,
  requestedRoundId,
  settingsSection,
  data,
  nativeState,
  refresh,
  onOpenCase,
  onUpdateCase,
  onDispatch,
  onArchive,
  onImport,
  onSaveSettings,
}: PageContentProps) {
  if (item) {
    return <CaseSpace
      key={`${nativeState?.profileKey ?? 'preview'}-${nativeState?.scopeVersion ?? 0}-${item.id}-${requestedRoundId ?? ''}`}
      requestedRoundId={requestedRoundId}
      item={item}
      tab={tab}
      profileKey={nativeState?.profileKey}
      scopeVersion={nativeState?.scopeVersion}
      navigate={nextTab => onOpenCase(item, nextTab)}
      updateCase={(patch, scope) => onUpdateCase(item.id, patch, scope)}
    />;
  }

  if (page === 'case') {
    return <Empty title="找不到该案件"><a href="#/library">返回案件库</a></Empty>;
  }

  if (page === 'tasks') {
    if (desktop && nativeState) {
      return <AgentTasks
        key={nativeState.profileKey}
        profileKey={nativeState.profileKey}
        open={(id, nextTab) => {
          const found = data.cases.find(caseItem => caseItem.id === id);
          if (found) onOpenCase(found, nextTab);
        }}
      />;
    }
    return <>
      <p className="quiet-banner">浏览器预览中的示例任务，仅供查看界面。</p>
      <TaskCenter cases={data.cases} open={onOpenCase} dispatch={onDispatch}/>
    </>;
  }

  if (page === 'transfer' && desktop && nativeState) {
    return <LocalWorkflow
      key={nativeState.profileKey}
      profileKey={nativeState.profileKey}
      cases={data.cases}
      open={caseItem => onOpenCase(caseItem, internalTransferAvailable(caseItem) ? 'submit' : ['reply', 'correction'].includes(caseItem.current?.kind ?? '') ? 'discussion' : currentRoute(caseItem) as CaseTab)}
    />;
  }

  if (page === 'review' && desktop && nativeState) {
    return <ReviewQueue
      profileKey={nativeState.profileKey}
      open={(id, source) => {
        const found = data.cases.find(caseItem => caseItem.id === id);
        if (found) onOpenCase(found, 'review', source);
      }}
    />;
  }

  if (module && !FEATURE_MODULE_BY_ID[module]) {
    return <Empty title="业务模块不可用"><a href="#/library">返回案件库</a></Empty>;
  }

  if (page === 'settings') {
    return <SettingsPage
      nativeState={nativeState}
      refresh={refresh}
      initialSection={settingsSection}
      settings={data.settings}
      save={onSaveSettings}
    />;
  }

  if (page === 'status') {
    return <CaseOutcomeCenter
      key={nativeState?.profileKey ?? 'preview'}
      cases={data.cases}
      profileKey={nativeState?.profileKey}
      refresh={refresh}
      openCase={caseItem => onOpenCase(caseItem, 'overview')}
    />;
  }

  return <Library
    key={page}
    scope={page === 'official' ? 'official' : 'workspace'}
    archiveCases={onArchive}
    cases={data.cases}
    module={module}
    openCase={caseItem => onOpenCase(caseItem, module === 'transfer' ? 'submit' : module ? currentRoute(caseItem) as CaseTab : 'overview')}
    onImport={onImport}
  />;
}
