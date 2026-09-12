import appIcon from '../resources/branding/icon.png';
import { ReviewQueue } from './components/ProfessionalWork.tsx';
import { useEffect, useState } from 'react';
import { ArrowRightLeft, Clock3, ChevronRight, FileSearch, FileText, Folder, ListTodo, MessageSquare, PenLine, Settings, UserRound } from 'lucide-react';
import { pauseRunning, updateRound } from './domain/workflow.ts';
import type { Case } from './domain/workflow.ts';
import { loadWorkspace, storageKey } from './domain/persistence.ts';
import { CaseSpace, caseTabs } from './components/CaseSpace.tsx';
import type { CaseTab } from './components/CaseSpace.tsx';
import { Library, moduleLabels } from './components/Library.tsx';
import type { Module } from './components/Library.tsx';
import { ImportCases } from './components/ImportCases.tsx';
import { TaskCenter } from './components/TaskCenter.tsx';
import { AgentTasks } from './components/AgentTasks.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { Empty, Modal } from './components/Primitives.tsx';
import { desktop } from './desktop.ts';
import type { DesktopState } from './desktop.ts';
import { LocalCaseForm } from './components/LocalCaseForm.tsx';
import { inOfficialWaiting } from './domain/library.ts';
import { currentRoute, editableCurrent, workModule } from './domain/lifecycle.ts';

const navItems = [{ id: 'library', label: '案件库', icon: Folder }, { id: 'official', label: '等待官方', icon: Clock3 }, { id: 'tasks', label: '工作任务', icon: ListTodo }, { id: 'reply', label: '答复', icon: MessageSquare }, { id: 'write', label: '撰写', icon: PenLine }, { id: 'review', label: '审查', icon: FileSearch }, { id: 'transfer', label: '内部流转', icon: ArrowRightLeft }];
function navigate(path: string) { location.hash = path; }
function readRoute() { return location.hash.slice(1).split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } }); }

export function App({nativeState,refresh}:{nativeState?:DesktopState;refresh?:(s:DesktopState)=>void} = {}) {
  const [loaded] = useState(()=>nativeState?{workspace:nativeState.workspace,error:null}:loadWorkspace()); const [data, setData] = useState(loaded.workspace);
  const [storageError, setStorageError] = useState(loaded.error); const [route, setRoute] = useState(readRoute);
  const [importing, setImporting] = useState(false); const [notice, setNotice] = useState('');
  const page = route[0] || 'library'; const item = page === 'case' ? data.cases.find(c => c.id === route[1]) : undefined;
  const tab: CaseTab = desktop&&route[2]==='reply'?'discussion':route[2] && route[2] in caseTabs ? route[2] as CaseTab : 'overview';
  const module = ['reply', 'write', 'review', 'transfer'].includes(page) ? page as Module : undefined;
  const activeNav = item ? inOfficialWaiting(item) ? 'official' : ['overview','materials','history','flow','discussion'].includes(tab) ? 'library' : tab === 'outputs' ? 'transfer' : workModule(item) : page;
  const jobs = data.cases.flatMap(c => editableCurrent(c) ? c.rounds.filter(r => r.job).map(r => ({ c, r })) : []);
  useEffect(() => { const handler = () => { setRoute(readRoute()); window.scrollTo(0, 0); }; window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(()=>{if(nativeState)setData(nativeState.workspace);},[nativeState]);
  useEffect(() => {
    if (loaded.error || desktop) return;
    try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch { setStorageError('本机存储写入失败。当前操作仅保留在此页面，关闭前请保留重要内容。'); }
  }, [data, loaded.error]);
  useEffect(() => {
    const handler = () => { if (!loaded.error && !desktop) { try { localStorage.setItem(storageKey, JSON.stringify(pauseRunning(data))); } catch { /* UI already reports write errors. */ } } };
    window.addEventListener('pagehide', handler); return () => window.removeEventListener('pagehide', handler);
  }, [data, loaded.error]);
  useEffect(() => {
    if (desktop) return;
    const id = setInterval(() => setData(w => {
    let next = w;
    for (const c of w.cases) for (const r of c.rounds) if (r.job?.status === 'running' && r.job.due <= Date.now()) next = updateRound(next, c.id, r.id, { type: 'complete', jobId: r.job.id });
    return next;
  }), 350); return () => clearInterval(id); }, []);
  const openCase = (c: Case, t: CaseTab = 'overview', roundId?: string) => navigate(`/case/${c.id}/${t}${roundId ? `/${roundId}` : ''}`);
  const updateCase = async(id:string,patch:Partial<Case>)=>{const next={...data,cases:data.cases.map(c=>c.id===id?{...c,...patch}:c)};setData(next);if(desktop&&nativeState)try{await desktop.saveWorkspace(nativeState.profileKey,next);}catch(e){setStorageError((e as Error).message);throw e;}};
  return <div className="app-shell"><aside className="global-sidebar"><a className="brand" aria-label="专利工作台" href="#/library"><img src={appIcon} alt="" className="app-brand-icon"/><span>专利工作台</span></a><div className="nav-group-label">工作空间</div><nav aria-label="全局工作空间">{navItems.map((n, i) => <div key={n.id}>{i === 3 && <div className="nav-group-label business-label">业务工作</div>}<a className={activeNav === n.id ? 'active' : ''} href={`#/${n.id}`} title={n.label}><n.icon/><span>{n.label}</span>{n.id === 'official' && <small>{data.cases.filter(c => !c.archived && inOfficialWaiting(c)).length}</small>}{n.id === 'tasks' && !desktop && jobs.length > 0 && <small>{jobs.length}</small>}</a></div>)}</nav><div className="sidebar-bottom"><a href="#/settings" aria-label="设置" className={page === 'settings' ? 'active' : ''}><Settings/><span>设置</span></a><div><UserRound/><span>{nativeState?.account?.displayName??'本机工作空间'}</span></div></div></aside>
    <main><div className="topbar"><div className="breadcrumbs">{item ? <><a href={inOfficialWaiting(item)?"#/official":"#/library"}>{inOfficialWaiting(item)?'等待官方':'案件库'}</a><ChevronRight/><span>{item.number}</span>{tab !== 'overview' && <><ChevronRight/><span>{caseTabs[tab]}</span></>}</> : <span>{page === 'official' ? '等待官方' : page === 'settings' ? '设置' : page === 'tasks' ? '工作任务' : module ? moduleLabels[module] : '案件库'}</span>}</div><span className="prototype-note">{desktop?`桌面版${nativeState?.version?` ${nativeState.version}`:''}`:'浏览器设计预览 · 示例数据'}</span></div>
      {storageError && <div className="error-banner" role="alert">{storageError}</div>}{notice && <div className="toast" role="status">{notice}<button className="text-button" onClick={() => setNotice('')}>关闭</button></div>}
      <div className="main-surface">{nativeState&&['library','official'].includes(page)&&<div className="sync-toolbar"><p>{nativeState.account?nativeState.sync.message:'在设置中登录贝思兰德，选择工作文件夹后同步个人案件。'}</p><button onClick={()=>navigate('/settings')}>账号与目录设置</button></div>}{item ? <CaseSpace key={`${item.id}-${route[3] ?? ''}`} requestedRoundId={route[3]} item={item} tab={tab} profileKey={nativeState?.profileKey} navigate={t => openCase(item, t)} updateCase={p => updateCase(item.id, p)} dispatch={(roundId, a) => setData(w => updateRound(w, item.id, roundId, a))}/> : page === 'case' ? <Empty title="找不到该案件"><a href="#/library">返回案件库</a></Empty> : page === 'tasks' ? (desktop&&nativeState?<AgentTasks key={nativeState.profileKey} profileKey={nativeState.profileKey} open={(id,t)=>{const found=data.cases.find(c=>c.id===id);if(found)openCase(found,t);}}/>:<><p className="quiet-banner">浏览器预览中的示例任务，仅供查看界面。</p><TaskCenter cases={data.cases} open={openCase} dispatch={(caseId, roundId, a) => setData(w => updateRound(w, caseId, roundId, a))}/></>) : page === 'review'&&desktop&&nativeState ? <ReviewQueue profileKey={nativeState.profileKey} open={(id,source)=>{const c=data.cases.find(c=>c.id===id);if(c)openCase(c,'review',source);}}/> : page === 'settings' ? <SettingsPage nativeState={nativeState} refresh={refresh} initialSection={route[1]} settings={data.settings} save={async settings=>{if(desktop&&nativeState){const saved=await desktop.saveSettings(nativeState.profileKey,settings);refresh?.(saved);return saved.workspace.settings;}setData(w=>({...w,settings}));return settings;}}/> : <Library key={page} scope={page === 'official' ? 'official' : 'workspace'} archiveCases={(ids,archived)=>{const next={...data,cases:data.cases.map(c=>ids.includes(c.id)?{...c,archived}:c)};setData(next);if(desktop&&nativeState)void desktop.saveWorkspace(nativeState.profileKey,next).catch(e=>setStorageError(e.message));}} cases={data.cases} module={module} openCase={c => openCase(c, module === 'transfer' ? 'submit' : module ? currentRoute(c) as CaseTab : 'overview')} onImport={()=>module?navigate('/library'):setImporting(true)}/>}</div>
    </main>
    {importing&&<Modal title={desktop?'新建本地案件':'导入通知书 · 示例'} onClose={()=>setImporting(false)}>{desktop?<LocalCaseForm done={state=>{refresh?.(state);setImporting(false);const c=state.workspace.cases.at(-1);if(c)openCase(c,currentRoute(c) as CaseTab);}}/>:<ImportCases create={created=>{setData(w=>({...w,cases:[...created,...w.cases]}));setImporting(false);if(created.length===1)openCase(created[0]);}}/>}</Modal>}
  </div>;
}
