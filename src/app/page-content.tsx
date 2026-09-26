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
import { agentProcessKey, desktop } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
import type { Case, Workspace } from '../domain/workflow.ts';
import { currentRoute, internalTransferAvailable } from '../domain/lifecycle.ts';
import { FEATURE_MODULE_BY_ID } from './features.ts';
import type { CaseNavigationTarget } from './navigation.ts';
import type { DesktopScope } from './scope.ts';

type PageContentProps = {
  page: string;
  tab: CaseTab;
  item?: Case;
  module?: Module;
  requestedTarget?: CaseNavigationTarget;
  settingsSection?: string;
  data: Workspace;
  nativeState?: DesktopState;
  refresh?: (state: DesktopState) => void;
  onOpenCase: (item: Case, tab?: CaseTab, target?: CaseNavigationTarget) => void;
  onUpdateCase: (id: string, patch: Partial<Case>, scope?: DesktopScope) => Promise<void>;
  onArchive: (ids: string[], archived: boolean) => void;
  onImport: () => void;
  onSaveSettings: (settings: Workspace['settings']) => Promise<Workspace['settings']>;
};

export function PageContent({
  page,
  tab,
  item,
  module,
  requestedTarget,
  settingsSection,
  data,
  nativeState,
  refresh,
  onOpenCase,
  onUpdateCase,
  onArchive,
  onImport,
  onSaveSettings,
}: PageContentProps) {
  if (item) {
    return <CaseSpace
      key={JSON.stringify([nativeState?.profileKey,nativeState?.scopeVersion,item.id,nativeState?.caseRevisions[item.id],agentProcessKey(item),requestedTarget])}
      requestedTarget={requestedTarget}
      item={item}
      tab={tab}
      profileKey={nativeState?.profileKey}
      scopeVersion={nativeState?.scopeVersion}
      caseRevision={nativeState?.caseRevisions[item.id] ?? 0}
      navigate={(nextTab, target) => onOpenCase(item, nextTab, target)}
      updateCase={(patch, scope) => onUpdateCase(item.id, patch, scope)}
    />;
  }

  if (page === 'case') {
    return <Empty title="找不到该案件"><a href="#/library">返回案件库</a></Empty>;
  }

  if (page === 'tasks') {
    if (desktop && nativeState) {
      return <AgentTasks
        key={`${nativeState.profileKey}:${nativeState.scopeVersion}`}
        profileKey={nativeState.profileKey}
        open={(id, nextTab, target) => {
          const found = data.cases.find(caseItem => caseItem.id === id);
          if (found) onOpenCase(found, nextTab,target);
        }}
      />;
    }
    return <>
      <p className="quiet-banner">浏览器预览中的示例任务，仅供查看界面。</p>
      <TaskCenter cases={data.cases} open={onOpenCase}/>
    </>;
  }

  if (page === 'transfer' && desktop && nativeState) {
    return <LocalWorkflow
      key={`${nativeState.profileKey}:${nativeState.scopeVersion}`}
      profileKey={nativeState.profileKey}
      cases={data.cases}
      open={caseItem => onOpenCase(caseItem, internalTransferAvailable(caseItem) ? 'submit' : ['reply', 'correction'].includes(caseItem.current?.kind ?? '') ? 'discussion' : currentRoute(caseItem) as CaseTab)}
    />;
  }

  if (page === 'review' && desktop && nativeState) {
    return <ReviewQueue
      key={`${nativeState.profileKey}:${nativeState.scopeVersion}`}
      profileKey={nativeState.profileKey}
      open={(id, source, target) => {
          const found = data.cases.find(caseItem => caseItem.id === id);
          if (found) onOpenCase(found, target?'history':'review', target??{ sourceId: source });
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
      key={`${nativeState?.profileKey ?? 'preview'}:${nativeState?.scopeVersion??0}`}
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
