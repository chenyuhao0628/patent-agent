import { StartCaseWork } from './StartCaseWork.tsx';
import { ProfessionalWork } from './ProfessionalWork.tsx';
import { useEffect, useState } from 'react';
import { InternalTransfer } from './InternalTransfer.tsx';
import { CaseMetadata } from './CaseMetadata.tsx';
import { ChevronRight, Clock3, FileText, MoreHorizontal } from 'lucide-react';
import type { Case, RemoteProcess } from '../domain/workflow.ts';
import { activeRound, currentWork, editableCurrent, internalTransferAvailable, isInternallyActiveProcess, processBusinessKind, workNames } from '../domain/lifecycle.ts';
import { currentHandling, flowStatusSummary } from '../domain/handling.ts';
import { DEFAULT_INTERNAL_TRANSFER_RECIPIENT } from '../domain/workflow-nodes.ts';
import { hasOfficialOutcome, outcomeApplies, outcomeDetail, outcomeLabel, outcomeStatement, outcomeView } from '../domain/outcome.ts';
import '../outcome.css';
import { deadlineFieldLabel, deadlineFieldValue, deadlineView, processDeadlineView } from '../domain/deadlines.ts';
import { WritingWorkbench } from './WritingWorkbench.tsx';
import { ReviewWorkbench } from './ReviewWorkbench.tsx';
import { TransferWorkbench } from './TransferWorkbench.tsx';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';
import { artifactsFor, initialDesign, reviewMatchesWriting } from '../domain/designFlows.ts';
import { MaterialsView } from './MaterialsView.tsx';
import { Modal, Note } from './Primitives.tsx';
import { CaseHistory, CurrentCase, RemoteFlow, setCaseFlowCache } from './CurrentCase.tsx';
import { agentProcessKey, desktop } from '../desktop.ts';
import { FEATURE_MODULES, featureAvailable, featureContextForDesktop, featureEditable, featureVisible } from '../app/features.ts';
import { projectCaseView } from '../domain/case-view.ts';
import type { DesktopScope } from '../app/scope.ts';

export const caseTabs={overview:'概览',materials:'材料',discussion:'本案对话',reply:'答复',write:'撰写',review:'审查',history:'办理历史',outputs:'成果',flow:'贝思兰德流程',submit:'提交'};
export type CaseTab=keyof typeof caseTabs;
export function CaseSpace({requestedRoundId,item,tab,navigate,updateCase,profileKey,scopeVersion}:{requestedRoundId?:string;item:Case;tab:CaseTab;navigate:(t:CaseTab)=>void;updateCase:(patch:Partial<Case>,scope?:DesktopScope)=>void|Promise<void>;profileKey?:string;scopeVersion?:number}){
  const projected = projectCaseView(item);
  const current=projected.stage.current,r=activeRound(item),design=item.design??initialDesign(),handling=currentHandling(item);
  const primary:CaseTab=current.kind==='correction'?'reply':['write','reply','review'].includes(current.kind)?current.kind as CaseTab:'overview';
  const childReview=current.kind==='write'&&design.review?.source==='writing';
  const featureCtx = featureContextForDesktop(desktop ?? undefined);
  const canOpenFeature = (id: 'reply' | 'write' | 'review' | 'transfer') => featureAvailable(FEATURE_MODULES.find(feature => feature.id === id)!, featureCtx, item);
  const canViewFeature = (id: 'reply' | 'write' | 'review' | 'transfer') => featureVisible(FEATURE_MODULES.find(feature => feature.id === id)!, featureCtx, item);
  const canEditFeature = (id: 'reply' | 'write' | 'review' | 'transfer') => featureEditable(FEATURE_MODULES.find(feature => feature.id === id)!, featureCtx, item);
  const scope = desktop && profileKey && scopeVersion !== undefined
    ? { profileKey, scopeVersion, caseId: item.id, processKey: agentProcessKey(item) }
    : undefined;
  const editable = projected.stage.editable && (
    !desktop || (
      ((current.kind === 'reply' || current.kind === 'correction') ? canEditFeature('reply') : true)
      && (current.kind === 'write' ? canEditFeature('write') : true)
    )
  );
  const allowed = tab === primary || tab === 'review' && (childReview || canOpenFeature('review'));
  const featureTabs: CaseTab[] = [
    ...(desktop && canViewFeature('reply') ? ['discussion' as CaseTab] : []),
    ...(!desktop && canViewFeature('reply') ? ['reply' as CaseTab] : []),
    ...(canViewFeature('write') ? ['write' as CaseTab] : []),
    ...(canViewFeature('review') ? ['review' as CaseTab] : []),
    ...(canViewFeature('transfer') ? ['submit' as CaseTab] : []),
  ];
  const tabs:CaseTab[]=['overview','materials',...featureTabs,'history','outputs','flow'];
  const [refreshing, setRefreshing] = useState(false);
  const [flowRefreshError, setFlowRefreshError] = useState('');
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [openError, setOpenError] = useState('');
  const [processPickError, setProcessPickError] = useState('');
  const [processHint, setProcessHint] = useState('');
  const [switchTarget, setSwitchTarget] = useState<RemoteProcess | null>(null);
  const [selectingProcess, setSelectingProcess] = useState(false);
  const localProcessKey = agentProcessKey(item);
  useEffect(() => {
    let active = true;
    if (profileKey && desktop) void desktop.agent.command(profileKey, item.id, { type: 'opened' }).catch(e => { if (active) setOpenError(e.message); });
    return () => { active = false; };
  }, [profileKey, item.id, localProcessKey]);
  const [showInfo,setShowInfo]=useState(false),[preview,setPreview]=useState<string|null>(null);
  const flow=flowStatusSummary(item);
  const refreshWholeCase = async () => {
    if (!desktop || item.source !== 'baseland') return;
    setRefreshing(true);
    setFlowRefreshError('');
    try {
      await desktop.sync('manual');
      if (item.remote) {
        const flowView = await desktop.flow(item.id);
        setCaseFlowCache(profileKey, item.id, flowView, scopeVersion);
      }
      if (profileKey && item.remote) {
        await desktop.refreshCaseOutcome(profileKey, item.id);
        await desktop.caseInfo(profileKey, item.id);
      }
      setRefreshSeq(s => s + 1);
    } catch (e) {
      setFlowRefreshError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const internallyActive = (item.remote?.processes ?? []).filter(isInternallyActiveProcess);
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
        });
      }
      setSwitchTarget(null);
      const round = item.rounds.find(r => r.id === 'proc-' + p.id);
      if (item.source === 'baseland' && !round?.materials.some(m => m.ready)) {
        setProcessHint('新流程材料尚未落盘，请点击「刷新本案」拉取。');
      } else setProcessHint('');
    } catch (e) {
      setProcessPickError((e as Error).message);
    } finally {
      setSelectingProcess(false);
    }
  };
  const officialConclusion = hasOfficialOutcome(item) ? outcomeStatement(item) : '';
  const canTransfer = projected.stage.transferAvailable;
  const submitCopy = officialConclusion
    ? `官方结论已到：${officialConclusion}。`
    : handling.officialWaiting
    ? '本次提交已结束，文件与办理记录保留查看。'
    : !canTransfer
    ? '当前阶段不能内部转交。'
    : `核对本次材料、表单和下一办理人（默认：${DEFAULT_INTERNAL_TRANSFER_RECIPIENT}），保存后转交内部流程。本程序仅办理内部流转，不直接递交官方。`;
  const updateDesign=(next:typeof design)=>{if(editable&&allowed)void updateCase({design:next},scope);};
  const recentFiles=artifactsFor(item,design).slice(-3).reverse();
  return <div className={`case-space ${tab==='discussion'||tab==='reply'?'conversation-space':''} ${['reply','write','review','discussion'].includes(tab)?'focused-space':''}`}>
    {flowRefreshError && <p role="alert">{flowRefreshError}</p>}{openError && <p role="alert">本机打开记录未保存：{openError}</p>}{processPickError && <p role="alert">{processPickError}</p>}{processHint && <p role="status">{processHint}</p>}
    <header className="case-intro"><span className="case-emblem"><FileText/></span><div><h1>{item.title}</h1><p>{item.number}<span>·</span>{item.type}{outcomeApplies(item)&&<span className={`outcome-badge is-${outcomeView(item)}`} title={outcomeDetail(item)}>案件状态 · {outcomeLabel(item)}</span>}{item.tags.map(t=><span className="tag" key={t}>{t}</span>)}</p></div><div className="case-header-actions">{desktop&&item.source==='baseland'&&<button disabled={refreshing} title="会同步个人案件并更新本流程、材料和官方结论" onClick={()=>void refreshWholeCase()}>{refreshing?'正在同步并刷新本案…':'刷新本案'}</button>}<button className="icon-button more" aria-label="案件管理操作" onClick={()=>setShowInfo(true)}><MoreHorizontal/></button></div></header>
    <nav className="case-tabs" aria-label="本案业务">{tabs.map(id=><button key={id} className={tab===id||desktop&&id==='discussion'&&tab==='reply'?'active':''} onClick={()=>navigate(id)}>{id==='discussion'?'本案对话':id==='reply'&&current.kind==='correction'?'补正':caseTabs[id]}</button>)}</nav>
    {tab==='overview'&&<div className="overview-grid"><div><h2>当前办理</h2><div className="current-work"><p>{handling.processName}</p><h3>{handling.node}</h3><p>{handling.status}</p><p>办理主体：{handling.party}{handling.handlerKind==='pending-undertaker'&&handling.handler?` · 待办承办人 ${handling.handler}`:handling.handlerKind==='flow-user'&&handling.handler?` · 当前办理人 ${handling.handler}`:handling.unverified?' · 待核验':''}</p><p>本案当前办理以实际流程节点为准；已结束的阶段在办理历史中查看。</p><div><span className="current-status"><Clock3 size={15}/>{item.source==='baseland'?'已关联贝思兰德':desktop?'本地案件':'设计示例'}</span><StartCaseWork item={item} profileKey={profileKey}/>{primary!=='overview'&&<button className="primary" onClick={()=>navigate(primary)}>进入当前工作<ChevronRight size={17}/></button>}</div></div>
      {current.kind==='needs-confirmation'&&<div className="inline-warning"><h3>请确认当前办理阶段</h3><p>同一案件只能办理一个当前阶段。请选择本次要办理的流程；其余保留查看。</p><div className="button-row">{internallyActive.length?internallyActive.map(p=><button key={p.id} disabled={selectingProcess} onClick={()=>void chooseProcess(p,true)}>{processChoiceLabel(p)}</button>):!desktop?<>{item.rounds.slice(0,1).map(round=><button key={round.id} onClick={()=>void updateCase({current:{kind:round.name.includes('补正')?'correction':'reply',roundId:round.id}})}>以{round.name}为当前</button>)}{design.writing.disclosure&&<button onClick={()=>void updateCase({current:{kind:'write'}})}>以撰写为当前</button>}</>:<p>暂无未结束的内部流程，请刷新本案。</p>}</div></div>}
      {current.kind!=='needs-confirmation'&&otherActive.length>0&&<div className="inline-warning"><h3>本案还有其他未结束流程</h3><p>同一案件只能办理一个当前阶段，其余保留查看。</p><div className="button-row">{otherActive.map(p=><button key={p.id} disabled={selectingProcess} onClick={()=>void chooseProcess(p)}>切换到{p.name}</button>)}</div></div>}
      <h2 className="business-heading">案件记录</h2><div className="business-links"><button onClick={()=>navigate('history')}><FileText/><span><b>办理历史与稿件版本</b><small>查看以往撰写、通知和答复记录</small></span><ChevronRight size={18}/></button><button onClick={()=>navigate('flow')}><Clock3/><span><b>贝思兰德流程</b><small>查看节点、办理人和流转情况</small></span><ChevronRight size={18}/></button></div></div><aside className="case-aside"><h2>案件信息</h2><dl><div><dt>公司名称</dt><dd>{item.companyName || '未提供'}</dd></div><div><dt>当前业务</dt><dd>{handling.processName}</dd></div><div><dt>当前办理节点</dt><dd>{handling.node}</dd></div><div><dt>流程状态</dt><dd>{flow.process} · {flow.node}{flow.handler?` · ${flow.handler}`:''}{flow.unverified&&!flow.handler?' · 待核验':''}{flow.submission?<small>官方递交：{flow.submission}</small>:null}</dd></div><div><dt>案件状态</dt><dd><span className={`outcome-badge is-${outcomeView(item)}`} title={outcomeDetail(item)}>{outcomeLabel(item)}</span>{item.officialOutcome?.noticeName?<small>{item.officialOutcome.noticeName}{item.officialOutcome.postDate?` · ${item.officialOutcome.postDate}`:''}</small>:null}{!outcomeApplies(item)?<small>本机案件不参与官方结论判读</small>:null}</dd></div><div><dt>{deadlineFieldLabel(item)}</dt><dd>{deadlineFieldValue(item)}</dd></div><div><dt>文件归属</dt><dd>本案独立目录</dd></div></dl><CaseMetadata item={item} profileKey={profileKey}/><h2>本案成果</h2>{desktop?<button className="recent-file" onClick={()=>navigate('outputs')}><FileText/><span>查看生成文件与定稿<small>按版本查看正文、修改文本和复核记录</small></span><ChevronRight size={16}/></button>:recentFiles.length?recentFiles.map(file=><button className="recent-file" key={file.id} onClick={()=>setPreview(`${file.title}\n${file.text}`)}><FileText/><span>{file.title}<small>{file.detail}</small></span></button>):<Note>确认的定稿成果将在这里显示。</Note>}</aside></div>}
    {tab==='materials'&&(desktop?<CurrentCase item={item} update={updateCase} materialsOnly profileKey={profileKey} scope={scope} onRefresh={refreshWholeCase} refreshing={refreshing}/>:r?<MaterialsView key={r.id} item={{...item,rounds:[r]}} round={r} selectRound={()=>{}} change={next=>{if(editable)void updateCase({rounds:item.rounds.map(x=>x.id===r.id?next:x)},scope);}}/>:<Note>当前阶段尚无通知书材料，可在办理历史中查看旧轮次。</Note>)}
    {(tab==='discussion'||tab==='reply')&&desktop&&profileKey&&canViewFeature('reply')&&(
      current.kind==='reply'||current.kind==='correction'
        ? <CurrentCase key={`${item.id}-discussion-${agentProcessKey(item)}`} item={item} update={updateCase} profileKey={profileKey} scope={scope} conversationOnly/>
        : <CaseHistory item={item} profileKey={profileKey}/>
    )}
    {desktop&&profileKey&&tab==='write'&&canViewFeature('write')&&(
      current.kind==='write'
        ? <ProfessionalWork key={`${item.id}-${agentProcessKey(item)}-${tab}`} profileKey={profileKey} item={item} mode="writing" sourceId={requestedRoundId} navigate={navigate}/>
        : <CaseHistory item={item} profileKey={profileKey}/>
    )}
    {desktop&&profileKey&&tab==='review'&&canViewFeature('review')&&<ProfessionalWork key={`${item.id}-${agentProcessKey(item)}-${tab}`} profileKey={profileKey} item={item} mode="review" sourceId={requestedRoundId} navigate={navigate}/>}
    {desktop&&profileKey&&['discussion','reply','write','review'].includes(tab)&&
      !(tab==='discussion'||tab==='reply'?canViewFeature('reply'):tab==='write'?canViewFeature('write'):canViewFeature('review'))&&
      <section className="business-workspace"><h2>当前业务不可用</h2><Note>本案仍可查看概览、材料、办理历史和成果；当前入口不允许启动或读取其他案件的业务。</Note><button onClick={()=>navigate('overview')}>返回案件概览</button></section>}
    {['reply','write','review'].includes(tab)&&!desktop&&(tab==='reply'
      ? <section className="business-workspace"><h2>答复办理</h2><Note>答复和补正统一使用桌面 Agent 工作流。浏览器预览只保留案件和历史查看，不提供第二套答复状态机。</Note></section>
      : allowed
        ? tab==='write'
          ? <WritingWorkbench item={item} design={design} update={updateDesign} openReview={()=>navigate('review')} openMaterials={()=>navigate('materials')} openOutputs={()=>navigate('outputs')}/>
          : <ReviewWorkbench item={item} design={design} update={updateDesign} openWriting={()=>{if(current.kind==='write'){updateDesign({...design,writing:{...design.writing,stage:design.review?.completed&&reviewMatchesWriting(design)?'final':'draft'}});navigate('write');}}} openMaterials={()=>navigate('materials')}/>
        : <section className="business-workspace"><h2>本案当前为{current.label??workNames[current.kind]}</h2><Note>本案不能同时开启其他主业务。历史工作内容仍保留。</Note><button onClick={()=>navigate(primary)}>返回当前阶段</button></section>)}
    {tab==='history'&&<CaseHistory item={item} profileKey={profileKey}/>}
    {tab==='flow'&&<RemoteFlow item={item} profileKey={profileKey} scopeVersion={scopeVersion}/>}
    {tab==='submit'&&(desktop&&profileKey?<section className="business-workspace"><h2>提交</h2>{officialConclusion&&<p className="submission-complete">官方结论：{officialConclusion}。本案已有授权或驳回结论，当前不能内部转交。</p>}{!officialConclusion&&handling.officialWaiting&&<p className="submission-complete">已递交，等待官方处理结果，无需重复提交。历史文件可在成果和办理历史中查看。</p>}{!officialConclusion&&!handling.officialWaiting&&!canTransfer&&<p className="submission-complete">当前阶段不能内部转交。</p>}<p className="section-copy">{submitCopy}</p>{canTransfer&&<InternalTransfer profileKey={profileKey} item={item} refreshSeq={refreshSeq} navigate={navigate}/>}</section>:<Note>请在桌面程序中使用贝思兰德内部提交。</Note>)}
    {tab==='outputs'&&(desktop&&profileKey?<CurrentCase item={item} update={updateCase} profileKey={profileKey} scope={scope} outputsOnly/>:<TransferWorkbench item={item} design={design} update={next=>{if(current.kind!=='needs-confirmation')void updateCase({design:next},scope);}} openWriting={()=>navigate(primary)} openReply={()=>navigate(primary)}/>)}
    {showInfo&&<Modal title="案件管理" onClose={()=>setShowInfo(false)}><CaseForm item={item} save={patch=>{void updateCase(patch,scope);setShowInfo(false);}}/></Modal>}
    {preview&&<Modal title="成果预览" onClose={()=>setPreview(null)}><FormattedFormulaText text={preview}/></Modal>}
    {switchTarget&&<Modal title="切换当前阶段" onClose={()=>{if(!selectingProcess)setSwitchTarget(null);}}><p>同一案件只能办理一个当前阶段，其余保留查看。</p><p>{processChoiceLabel(switchTarget)}</p><div className="button-row"><button type="button" disabled={selectingProcess} onClick={()=>setSwitchTarget(null)}>取消</button><button type="button" className="primary" disabled={selectingProcess} onClick={()=>void chooseProcess(switchTarget,true)}>确认切换</button></div></Modal>}
  </div>;
}
function processStatusText(status:number){
  return ({0:'待处理',200:'审核中',300:'待递交',400:'递交处理中',500:'已结束'} as Record<number,string>)[status]??'以系统记录为准';
}
function processChoiceLabel(p:RemoteProcess){
  const due=processDeadlineView(p);
  return `${p.name} · ${processStatusText(p.status)} · 期限 ${due.display==='—'?'未提供':due.display} · 承办人 ${p.undertaker||'未提供'}`;
}
function CaseForm({ item, save }: { item: Case; save: (p: Partial<Case>) => void }) {
  const due=deadlineView(item);
  const [title, setTitle] = useState(item.title); const [tags, setTags] = useState(item.tags.join('，')); const [deadline, setDeadline] = useState(item.source==='baseland'?(due.raw??''):item.deadline);
  const fieldLabel=deadlineFieldLabel(item);
  return <form onSubmit={e => { e.preventDefault(); save({ title: title.trim(), deadline, tags: [...new Set(tags.split(/[,，]/).map(t => t.trim()).filter(Boolean))] }); }}><label className="field">案件名称<input required readOnly={!!desktop&&item.source==='baseland'} value={title} onChange={e => setTitle(e.target.value)}/></label><label className="field">{fieldLabel}{item.source==='baseland'&&!due.raw?<input readOnly value={deadlineFieldValue(item)}/>:<input readOnly={!!desktop&&item.source==='baseland'} type="date" value={deadline} onChange={e => setDeadline(e.target.value)}/>}</label>{!!desktop&&item.source==='baseland'&&<Note>案件名称与办理期限以同步结果为准；提出申请采用内部期限；其他业务官方期限优先于贝思兰德期限。</Note>}{!!desktop&&item.source==='local'&&<Note>本地案件使用自设日期，与官方期限和贝思兰德期限分开标记。</Note>}<label className="field">标签<input value={tags} onChange={e => setTags(e.target.value)} placeholder="以逗号分隔"/></label><div className="action-bar"><button type="button" onClick={() => save({ archived: !item.archived })}>{item.archived ? '取消归档' : '归档案件'}</button><button className="primary" disabled={!title.trim()}>保存修改</button></div></form>;
}
