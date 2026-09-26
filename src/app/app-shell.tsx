import type { ReactNode } from 'react';
import { ChevronRight, UserRound } from 'lucide-react';
import appIcon from '../../resources/branding/icon.png';
import type { Case, Workspace } from '../domain/workflow.ts';
import type { DesktopState } from '../desktop.ts';
import { caseTabs, type CaseTab } from '../components/CaseSpace.tsx';
import { inOfficialWaiting, type Module } from '../domain/library.ts';
import { MODULE_LABELS, NAV_ITEMS, PAGE_LABELS, SETTINGS_NAVIGATION } from './navigation.ts';

type AppShellProps = {
  page: string;
  item?: Case;
  tab: CaseTab;
  module?: Module;
  activeNav: string;
  data: Workspace;
  nativeState?: DesktopState;
  storageError: string | null;
  syncError: string;
  onSync?: () => void;
  onOpenSettings: () => void;
  notice?: string;
  onDismissNotice?: () => void;
  children: ReactNode;
};

export function AppShell({
  page,
  item,
  tab,
  module,
  activeNav,
  data,
  nativeState,
  storageError,
  syncError,
  onSync,
  onOpenSettings,
  notice,
  onDismissNotice,
  children,
}: AppShellProps) {
  const jobs = data.cases.flatMap(c => c.rounds.filter(r => r.job).map(r => ({ c, r })));
  const backHref = item && inOfficialWaiting(item) ? '#/official' : '#/library';
  const backLabel = item && inOfficialWaiting(item) ? '等待官方' : '案件库';
  const pageLabel = PAGE_LABELS[page] ?? (module ? MODULE_LABELS[module] : '案件库');

  return <div className="app-shell">
    <aside className="global-sidebar">
      <a className="brand" aria-label="专利工作台" href="#/library">
        <img src={appIcon} alt="" className="app-brand-icon"/>
        <span>专利工作台</span>
      </a>
      <div className="nav-group-label">工作空间</div>
      <nav aria-label="全局工作空间">
        {NAV_ITEMS.map((navItem, index) => <div key={navItem.id}>
          {index === 3 && <div className="nav-group-label business-label">业务工作</div>}
          <a className={activeNav === navItem.id ? 'active' : ''} href={`#/${navItem.id}`} title={navItem.label}>
            <navItem.icon/>
            <span>{navItem.label}</span>
            {navItem.id === 'official' && <small>{data.cases.filter(c => !c.archived && inOfficialWaiting(c)).length}</small>}
            {navItem.id === 'tasks' && !nativeState && jobs.length > 0 && <small>{jobs.length}</small>}
          </a>
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <a href="#/settings" aria-label={SETTINGS_NAVIGATION.label} className={page === 'settings' ? 'active' : ''}>
          <SETTINGS_NAVIGATION.icon/>
          <span>{SETTINGS_NAVIGATION.label}</span>
        </a>
        <div>
          <UserRound/>
          <span>{nativeState?.account?.displayName ?? '本机工作空间'}</span>
        </div>
      </div>
    </aside>
    <main>
      <div className="topbar">
        <div className="breadcrumbs">
          {item ? <>
            <a href={backHref}>{backLabel}</a>
            <ChevronRight/>
            <span>{item.number}</span>
            {tab !== 'overview' && <><ChevronRight/><span>{caseTabs[tab]}</span></>}
          </> : <span>{pageLabel}</span>}
        </div>
        <span className="prototype-note">{nativeState ? `桌面版${nativeState.version ? ` ${nativeState.version}` : ''}` : '浏览器设计预览 · 示例数据'}</span>
      </div>
      {storageError && <div className="error-banner" role="alert">{storageError}</div>}
      {notice && <div className="toast" role="status">{notice}<button className="text-button" onClick={onDismissNotice}>关闭</button></div>}
      <div className="main-surface">
        {nativeState && ['library', 'official'].includes(page) && <div className="sync-toolbar">
          <p>{nativeState.account ? nativeState.sync.message : '在设置中登录贝思兰德，选择工作文件夹后同步个人案件。'}</p>
          {syncError && <span role="alert">{syncError}</span>}
          <button disabled={nativeState.sync.running || !nativeState.account} onClick={onSync}>
            {nativeState.sync.running ? '同步中…' : '刷新案件'}
          </button>
          <button onClick={onOpenSettings}>账号与目录设置</button>
        </div>}
        {children}
      </div>
    </main>
  </div>;
}
