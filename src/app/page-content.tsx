import { CaseSpace, type CaseTab } from '../components/CaseSpace.tsx';
import { Empty } from '../components/Primitives.tsx';
import { agentProcessKey } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
import type { Case, Workspace } from '../domain/workflow.ts';
import type { Module } from '../domain/library.ts';
import type { CaseNavigationTarget } from './navigation.ts';
import type { DesktopScope } from './scope.ts';
import { PanelHost } from './panel-host.tsx';

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

export function PageContent(props:PageContentProps){
 const {item,nativeState,requestedTarget,tab,onOpenCase,onUpdateCase}=props;
 if(item)return <CaseSpace key={JSON.stringify([nativeState?.profileKey,nativeState?.scopeVersion,item.id,nativeState?.caseRevisions[item.id],agentProcessKey(item),requestedTarget])} requestedTarget={requestedTarget} item={item} tab={tab} profileKey={nativeState?.profileKey} scopeVersion={nativeState?.scopeVersion} caseRevision={nativeState?.caseRevisions[item.id]??0} navigate={(next,target)=>onOpenCase(item,next,target)} updateCase={(patch,scope)=>onUpdateCase(item.id,patch,scope)}/>;
 if(props.page==='case')return <Empty title="找不到该案件"><a href="#/library">返回案件库</a></Empty>;
 return <PanelHost context={{kind:'global',...props}}/>;
}
