import { LocalWorkflow } from '../components/LocalWorkflow.tsx';
import { ReviewQueue } from '../components/ProfessionalWork.tsx';
import { CaseOutcomeCenter } from '../components/CaseOutcomeCenter.tsx';
import { Library } from '../components/Library.tsx';
import { TaskCenter } from '../components/TaskCenter.tsx';
import { AgentTasks } from '../components/AgentTasks.tsx';
import { SettingsPage } from '../components/SettingsPage.tsx';
import { Empty } from '../components/Primitives.tsx';
import { desktop } from '../desktop.ts';
import { currentRoute, internalTransferAvailable } from '../domain/lifecycle.ts';
import { globalContext } from '../app/panel-context.ts';
import type { PanelProps } from '../app/panel-types.ts';

export function LibraryPanel({context}:PanelProps){const p=globalContext(context);return <Library key={p.page} scope={p.page==='official'?'official':'workspace'} archiveCases={p.onArchive} cases={p.data.cases} module={p.module} openCase={c=>p.onOpenCase(c,p.module==='transfer'?'submit':p.module?currentRoute(c):'overview')} onImport={p.onImport}/>;}
export function TasksPanel({context}:PanelProps){const p=globalContext(context);return desktop&&p.nativeState?<AgentTasks profileKey={p.nativeState.profileKey} open={(id,tab,target)=>{const c=p.data.cases.find(c=>c.id===id);if(c)p.onOpenCase(c,tab,target);}}/>:<><p className="quiet-banner">浏览器预览中的示例任务，仅供查看界面。</p><TaskCenter cases={p.data.cases} open={p.onOpenCase}/></>;}
export function TransferPanel({context}:PanelProps){const p=globalContext(context);if(!desktop||!p.nativeState)return <Empty title="内部流转需要桌面能力"/>;return <LocalWorkflow profileKey={p.nativeState.profileKey} cases={p.data.cases} open={c=>p.onOpenCase(c,internalTransferAvailable(c)?'submit':['reply','correction'].includes(c.current?.kind??'')?'discussion':currentRoute(c))}/>;}
export function ReviewPanel({context}:PanelProps){const p=globalContext(context);if(!desktop||!p.nativeState)return <Empty title="审查队列需要桌面能力"/>;return <ReviewQueue profileKey={p.nativeState.profileKey} open={(id,source,target)=>{const c=p.data.cases.find(c=>c.id===id);if(c)p.onOpenCase(c,target?'history':'review',target??{sourceId:source});}}/>;}
export function SettingsPanel({context}:PanelProps){const p=globalContext(context);return <SettingsPage nativeState={p.nativeState} refresh={p.refresh} initialSection={p.settingsSection} settings={p.data.settings} save={p.onSaveSettings}/>;}
export function StatusPanel({context}:PanelProps){const p=globalContext(context);return <CaseOutcomeCenter cases={p.data.cases} profileKey={p.nativeState?.profileKey} refresh={p.refresh} openCase={c=>p.onOpenCase(c,'overview')}/>;}
