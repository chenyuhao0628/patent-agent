import { useEffect, useRef, useState } from 'react';
import { FileText, MoreHorizontal } from 'lucide-react';
import type { Case, RemoteProcess } from '../domain/workflow.ts';
import { currentWork, processBusinessKind, workNames } from '../domain/lifecycle.ts';
import { flowStatusSummary } from '../domain/handling.ts';
import { hasOfficialOutcome, outcomeApplies, outcomeDetail, outcomeLabel, outcomeStatement, outcomeView } from '../domain/outcome.ts';
import '../outcome.css';
import { deadlineFieldLabel, deadlineFieldValue, deadlineView, processDeadlineView } from '../domain/deadlines.ts';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';
import { Modal, Note } from './Primitives.tsx';
import { agentProcessKey, desktop } from '../desktop.ts';
import { FEATURE_MODULES, featureAccessForView, featureContextForDesktop } from '../app/features.ts';
import { historyViewFromWorkspace, professionalViewFromWorkspace, projectCaseView, replyViewFromWorkspace, transferViewFromWorkspace } from '../domain/case-view.ts';
import type { DesktopScope } from '../app/scope.ts';
import type { CaseNavigationTarget } from '../app/navigation.ts';
import { isHistoryTarget } from '../app/navigation.ts';

import { panels, casePanelLabels } from '../app/panels.ts';
import { PanelHost } from '../app/panel-host.tsx';
import type { CasePanelContext } from '../app/panel-context.ts';
import { processChoiceLabel } from '../app/process-choice.ts';
export const caseTabs=casePanelLabels;
export type CaseTab=string;
export function CaseSpace({requestedTarget,item,tab,navigate,updateCase,profileKey,scopeVersion,caseRevision=0}:{requestedTarget?:CaseNavigationTarget;item:Case;tab:CaseTab;navigate:(t:CaseTab,target?:CaseNavigationTarget)=>void;updateCase:(patch:Partial<Case>,scope?:DesktopScope)=>void|Promise<void>;profileKey?:string;scopeVersion?:number;caseRevision?:number}){
  const projected = projectCaseView(item);
  const replyView = replyViewFromWorkspace(projected);
  const professionalView = professionalViewFromWorkspace(projected);
  const transferView = transferViewFromWorkspace(projected);
  const historyView = historyViewFromWorkspace(projected);
  const current=projected.stage.current,r=replyView.manuscripts.replyRounds.find(r=>r.id===current.roundId),design=projected.manuscripts.design,handling=projected.stage.handling;
  const primary:CaseTab=current.kind==='correction'?'reply':['write','reply','review'].includes(current.kind)?current.kind as CaseTab:'overview';
  const childReview=current.kind==='write'&&design.review?.source==='writing';
  const featureCtx = featureContextForDesktop(desktop ?? undefined);
  const featureAccessFor = (id: 'reply' | 'write' | 'review' | 'transfer') =>
    featureAccessForView(FEATURE_MODULES.find(feature => feature.id === id)!, featureCtx, projected);
  const canOpenFeature = (id: 'reply' | 'write' | 'review' | 'transfer') => featureAccessFor(id).startable;
  const canViewFeature = (id: 'reply' | 'write' | 'review' | 'transfer') => featureAccessFor(id).visible;
  const canEditFeature = (id: 'reply' | 'write' | 'review' | 'transfer') => featureAccessFor(id).editable;
  const canUseConversation = featureCtx.capabilities.has('agent.reply');
  const scope = desktop && profileKey && scopeVersion !== undefined
    ? {
      profileKey,
      scopeVersion,
      caseId: item.id,
      processKey: agentProcessKey(item),
      caseRevision,
    }
    : undefined;
  const editable = projected.stage.editable && (
    !desktop || (
      ((current.kind === 'reply' || current.kind === 'correction') ? canEditFeature('reply') : true)
      && (current.kind === 'write' ? canEditFeature('write') : true)
    )
  );
  const allowed = tab === primary || tab === 'review' && (childReview || canOpenFeature('review'));
  const panelAccess={...featureCtx,caseView:projected,historical:isHistoryTarget(requestedTarget)||!!item.linkedTo};
  const tabs=panels.navigation('case',panelAccess).map(p=>p.route);
  const [refreshing, setRefreshing] = useState(false);
  const [flowRefreshError, setFlowRefreshError] = useState('');
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [processPickError, setProcessPickError] = useState('');
  const [processHint, setProcessHint] = useState('');
  const [switchTarget, setSwitchTarget] = useState<RemoteProcess | null>(null);
  const [selectingProcess, setSelectingProcess] = useState(false);
  const localProcessKey = agentProcessKey(item);
  const historical=isHistoryTarget(requestedTarget);
  const lifetime=useRef(true);
  useEffect(()=>{lifetime.current=true;return()=>{lifetime.current=false;};},[]);
  const [showInfo,setShowInfo]=useState(false),[preview,setPreview]=useState<string|null>(null);
  const flow=flowStatusSummary(item);
  const refreshWholeCase = async () => {
    if (!desktop || !profileKey || item.source !== 'baseland') return;
    setRefreshing(true);
    setFlowRefreshError('');
    try {
      const result=await desktop.refreshCase(profileKey,item.id);
      if(!lifetime.current)return;
      const {setCaseFlowCache}=await import('./CurrentCase.tsx');
      if(!lifetime.current)return;
      setCaseFlowCache(profileKey, item.id, result.flow, scopeVersion,localProcessKey,caseRevision);
      setRefreshSeq(s => s + 1);
    } catch (e) {
      if(lifetime.current)setFlowRefreshError((e as Error).message);
    } finally {
      if(lifetime.current)setRefreshing(false);
    }
  };
  const internallyActive = projected.transfer.activeProcesses;
  const otherActive = internallyActive.filter(p => p.id !== current.processId);
  const chooseProcess = async (p: RemoteProcess, confirmed = false) => {
    if (current.processId && current.processId !== p.id && !confirmed) {
      setSwitchTarget(p);
      return;
    }
    setSelectingProcess(true);
    setProcessPickError('');
    try {
      if (desktop) {
        if (!profileKey) throw new Error('请先登录后再选择当前阶段。');
        await desktop.selectCurrentProcess(profileKey, item.id, p.id);
      } else {
        await updateCase({
          current: {
            kind: processBusinessKind(p.name) ?? 'external',
            processId: p.id,
            roundId: item.rounds.find(r => r.id === 'proc-' + p.id)?.id,
            label: p.name,
            remoteStatus: p.status,
          },
        },scope);
      }
      if(!lifetime.current)return;
      setSwitchTarget(null);
      const round = item.rounds.find(r => r.id === 'proc-' + p.id);
      if (item.source === 'baseland' && !round?.materials.some(m => m.ready)) {
        setProcessHint('新流程材料尚未落盘，请点击「刷新本案」拉取。');
      } else setProcessHint('');
    } catch (e) {
      if(lifetime.current)setProcessPickError((e as Error).message);
    } finally {
      if(lifetime.current)setSelectingProcess(false);
    }
  };
  const updateDesign=(next:typeof design)=>{if(editable&&allowed)void updateCase({design:next},scope);};
  const context:CasePanelContext={kind:'case',item,tab,requestedTarget,profileKey,scopeVersion,caseRevision,scope,projected,replyView,professionalView,transferView,historyView,primary,editable,allowed,historical,canViewFeature,canUseConversation,navigate,updateCase,updateDesign,refreshWholeCase,refreshing,refreshSeq,chooseProcess,selectingProcess,setPreview};
  const panelLayout=panels.resolve('case',tab)?.layout;
  if(item.linkedTo)return <div className="case-space"><header className="case-intro"><h1>{item.title} · 关联来源历史</h1></header><Note>本案已关联至案件标识 {item.linkedTo}，当前办理请从案件库打开关联后的案件。原目录、稿件及对话保留，此入口只读。</Note><PanelHost context={{...context,tab:'history',historical:true}}/>{desktop&&<button onClick={()=>void desktop!.openCaseDirectory(item.id)}>打开原案件目录</button>}</div>;
  if(historical)return <div className="case-space"><header className="case-intro"><span className="case-emblem"><FileText/></span><div><h1>{item.title}</h1><p>{item.number} · 历史只读</p></div><button onClick={()=>navigate('overview')}>返回案件</button></header><PanelHost context={context}/></div>;
  return <div className={`case-space ${panelLayout==='conversation'?'conversation-space':''} ${panelLayout==='focused'||panelLayout==='conversation'?'focused-space':''}`}>
    {flowRefreshError && <p role="alert">{flowRefreshError}</p>}{processPickError && <p role="alert">{processPickError}</p>}{processHint && <p role="status">{processHint}</p>}
    <header className="case-intro"><span className="case-emblem"><FileText/></span><div><h1>{item.title}</h1><p>{item.number}<span>·</span>{item.type}<span className="case-current-work">当前：{current.label??workNames[current.kind]}</span>{outcomeApplies(item)&&<span className={`outcome-badge is-${outcomeView(item)}`} title={outcomeDetail(item)}>案件状态 · {outcomeLabel(item)}</span>}{item.tags.map(t=><span className="tag" key={t}>{t}</span>)}</p></div><div className="case-header-actions">{desktop&&item.source==='baseland'&&<button disabled={refreshing} title="只更新本案流程、材料清单、备注和官方结论" onClick={()=>void refreshWholeCase()}>{refreshing?'正在刷新本案…':'刷新本案'}</button>}<button className="icon-button more" aria-label="案件管理操作" onClick={()=>setShowInfo(true)}><MoreHorizontal/></button></div></header>
    <nav className="case-tabs" aria-label="本案业务">{tabs.map(id=><button key={id} className={tab===id||desktop&&id==='reply'&&tab==='discussion'?'active':''} onClick={()=>navigate(id)}>{id==='discussion'?'本案对话':id==='reply'&&current.kind==='correction'?'补正':caseTabs[id]}</button>)}</nav>
    <PanelHost context={context}/>
    {showInfo&&<Modal title="案件管理" onClose={()=>setShowInfo(false)}><CaseForm item={item} save={patch=>{void updateCase(patch,scope);setShowInfo(false);}}/></Modal>}
    {preview&&<Modal title="成果预览" onClose={()=>setPreview(null)}><FormattedFormulaText text={preview}/></Modal>}
    {switchTarget&&<Modal title="切换当前阶段" onClose={()=>{if(!selectingProcess)setSwitchTarget(null);}}><p>同一案件只能办理一个当前阶段，其余保留查看。</p><p>{processChoiceLabel(switchTarget)}</p><div className="button-row"><button type="button" disabled={selectingProcess} onClick={()=>setSwitchTarget(null)}>取消</button><button type="button" className="primary" disabled={selectingProcess} onClick={()=>void chooseProcess(switchTarget,true)}>确认切换</button></div></Modal>}
  </div>;
}
function CaseForm({ item, save }: { item: Case; save: (p: Partial<Case>) => void }) {
  const due=deadlineView(item);
  const [title, setTitle] = useState(item.title); const [tags, setTags] = useState(item.tags.join('，')); const [deadline, setDeadline] = useState(item.source==='baseland'?(due.raw??''):item.deadline);
  const fieldLabel=deadlineFieldLabel(item);
  return <form onSubmit={e => { e.preventDefault(); save({ title: title.trim(), deadline, tags: [...new Set(tags.split(/[,，]/).map(t => t.trim()).filter(Boolean))] }); }}><label className="field">案件名称<input required readOnly={!!desktop&&item.source==='baseland'} value={title} onChange={e => setTitle(e.target.value)}/></label><label className="field">{fieldLabel}{item.source==='baseland'&&!due.raw?<input readOnly value={deadlineFieldValue(item)}/>:<input readOnly={!!desktop&&item.source==='baseland'} type="date" value={deadline} onChange={e => setDeadline(e.target.value)}/>}</label>{!!desktop&&item.source==='baseland'&&<Note>案件名称与办理期限以同步结果为准；提出申请采用内部期限；其他业务官方期限优先于贝思兰德期限。</Note>}{!!desktop&&item.source==='local'&&<Note>本地案件使用自设日期，与官方期限和贝思兰德期限分开标记。</Note>}<label className="field">标签<input value={tags} onChange={e => setTags(e.target.value)} placeholder="以逗号分隔"/></label><div className="action-bar"><button type="button" onClick={() => save({ archived: !item.archived })}>{item.archived ? '取消归档' : '归档案件'}</button><button className="primary" disabled={!title.trim()}>保存修改</button></div></form>;
}
