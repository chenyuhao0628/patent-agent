import { PriorArtPanel } from './PriorArt.tsx';
import { ProfessionalArtifacts } from './ProfessionalWork.tsx';
import { useEffect, useRef, useState } from 'react';
import { createDraftAutosave } from './draft-autosave.ts';
import { ExternalLink, FileText, FolderOpen, RefreshCw } from 'lucide-react';
import type { RemoteProcess } from '../domain/workflow.ts';
import { officialStatusLabel, type HistoryRecord, type HistoryTarget } from '../domain/lifecycle.ts';
import { handlingForView } from '../domain/case-view.ts';
import { handlingHandlerText, INTERNAL_FLOW_END, isInternalEndNode, officialWaitProgressCaption, processRowHandling } from '../domain/handling.ts';
import { agentHistoryRecords, caseHistoryRecords, professionalHistoryRecords, selectHistoryRecords, transferHistoryRecords } from '../domain/history.ts';
import { processDeadlineView } from '../domain/deadlines.ts';
import { agentProcessKey, desktop, shouldAcceptAgentView } from '../desktop.ts';
import type { AgentCaseView, FlowNode, FlowView } from '../desktop.ts';
import { stamp as safeStamp } from '../domain/outcome.ts';
import { outcomeStatementForView, deadlineForView } from '../domain/case-view.ts';
import { ErrorState, LoadingState, Modal, Note, ReadonlyState } from './Primitives.tsx';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';
import { AgentArtifacts, AgentWorkbench } from './AgentWorkbench.tsx';
import type { DesktopScope } from '../app/scope.ts';
import type { CaseHistoryView, CaseProfessionalView, CaseReplyView, CaseTransferModuleView } from '../domain/case-view.ts';
import type { CaseTab } from './CaseSpace.tsx';
import '../flow.css';

const flowCache = new Map<string, FlowView>();
function flowCacheKey(profileKey: string | undefined, caseId: string, scopeVersion?: number,processKey?:string,caseRevision?:number): string {
  return JSON.stringify([profileKey ?? 'preview',scopeVersion ?? 0,caseId,processKey,caseRevision??0]);
}
export function setCaseFlowCache(profileKey: string | undefined, caseId: string, view: FlowView, scopeVersion?: number,processKey?:string,caseRevision?:number){
  if(flowCache.size>=200)flowCache.delete(flowCache.keys().next().value!);
  flowCache.set(flowCacheKey(profileKey, caseId, scopeVersion,processKey,caseRevision), view);
}

function historyDate(value?: string): string {
  if (!value) return '时间未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

export function CaseHistory({caseView,profileKey,navigate,target}:{caseView:CaseHistoryView;profileKey?:string;navigate?:(tab:CaseTab,target?:HistoryTarget)=>void;target?:HistoryTarget}){
  const [preview,setPreview]=useState<HistoryRecord|null>(null);
  const [remoteRecords,setRemoteRecords]=useState<HistoryRecord[]>([]);
  const [remoteLoading,setRemoteLoading]=useState(!!desktop&&!!profileKey),[remoteError,setRemoteError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    let alive=true;
    setRemoteRecords([]);
    setPreview(null);
    setRemoteError('');
    if(!desktop||!profileKey)return;
    setRemoteLoading(true);
    const loads:Promise<HistoryRecord[]>[]=[];
    loads.push(desktop.agent.history
      ? desktop.agent.history(profileKey,caseView.identity.id).then(processes=>processes.filter(p=>p.scope.caseId===caseView.identity.id).flatMap(agentHistoryRecords))
      : Promise.resolve([]));
    if(desktop.agent.reviewSources){
      loads.push(desktop.agent.reviewSources(profileKey,caseView.identity.id).then(sources=>professionalHistoryRecords({
        profileKey,caseId:caseView.identity.id,sources,jobs:[],
      })));
    }
    loads.push(desktop.professional.history(profileKey,caseView.identity.id).then(view=>{
      if(view.profileKey!==profileKey||view.caseId!==caseView.identity.id)throw new Error('历史记录不属于当前案件。');
      return professionalHistoryRecords(view);
    }));
    loads.push(desktop.transfer.history(profileKey,caseView.identity.id).then(views=>transferHistoryRecords(views.filter(v=>v.profileKey===profileKey&&v.caseId===caseView.identity.id))));
    void Promise.allSettled(loads).then(results=>{
      if(!alive)return;
      const seen=new Set<string>();
      const groups=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
      const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason instanceof Error?result.reason.message:'历史成果读取失败');
      setRemoteRecords(groups.flat().filter(record=>!seen.has(record.id)&&seen.add(record.id)));
      setRemoteError([...new Set(failures.filter(Boolean))].join('；'));
    }).finally(()=>{if(alive)setRemoteLoading(false);});
    return()=>{alive=false;};
  },[caseView.identity.id,profileKey,retry]);
  const all=[...new Map([...caseHistoryRecords(caseView),...remoteRecords].map(r=>[r.id,r])).values()];
  const records=target?selectHistoryRecords(all,target):all;
  return <section className="business-workspace"><div className="section-heading"><h2>{target?'历史记录 · 只读':'办理历史'}</h2>{target&&navigate&&<button onClick={()=>navigate('history')}>全部办理历史</button>}</div>{remoteError&&<ErrorState message={remoteError} onRetry={()=>setRetry(n=>n+1)}/>}
    {target?records.map(record=><article className="history-record-detail" key={record.id}><h3>{record.title}</h3><p className="muted">{record.detail}</p><HistoryFiles record={record} profileKey={profileKey} caseId={caseView.identity.id}/><FormattedFormulaText text={record.text}/></article>)
      :<div className="artifact-catalog">{records.map(record=><div key={record.id}><div className="history-record-row"><button onClick={()=>setPreview(record)}><FileText/><span><b>{record.title}</b><small>{record.detail}</small></span></button>{record.target&&navigate&&<button type="button" className="small-button" onClick={()=>navigate(record.target!.tab as CaseTab||'history',{...record.target,historyId:record.id})}>定位</button>}</div><HistoryFiles record={record} profileKey={profileKey} caseId={caseView.identity.id}/></div>)}</div>}
    {remoteLoading&&!records.length&&<LoadingState>正在读取历史记录…</LoadingState>}
    {!remoteLoading&&!records.length&&(target?<ErrorState message={remoteError?'未能读取指定历史记录，请重试失败的历史来源。':'找不到指定历史目标；当前办理阶段未改变。'}/>:!remoteError&&<Note>暂无历史办理记录。</Note>)}
    {preview&&<Modal title="历史内容 · 只读" onClose={()=>setPreview(null)}><HistoryFiles record={preview} profileKey={profileKey} caseId={caseView.identity.id}/><FormattedFormulaText text={preview.text}/></Modal>}</section>;
}
function HistoryFiles({record,profileKey,caseId}:{record:HistoryRecord;profileKey?:string;caseId:string}){
  const [opening,setOpening]=useState(''),[error,setError]=useState('');
  const lifetime=useRef(0);
  useEffect(()=>{lifetime.current++;setOpening('');setError('');return()=>{lifetime.current++;};},[profileKey,caseId,record.id]);
  if(!desktop||!profileKey)return null;
  const files=record.files?.filter(file=>file.caseId===caseId&&file.processId===record.target?.processId)??[];
  const open=async(relativePath:string)=>{
    const token=lifetime.current;
    setOpening(relativePath);setError('');
    try{await desktop!.professional.openFile(profileKey,caseId,relativePath);}
    catch(e){if(token===lifetime.current)setError((e as Error).message);}
    finally{if(token===lifetime.current)setOpening('');}
  };
  return <>{files.length>0&&<div className="history-file-list">{files.map((file,index)=><button key={`${file.relativePath}-${index}`} type="button" title={`打开 ${file.name}`} aria-label={`打开 ${file.name}`} disabled={!!opening} onClick={()=>void open(file.relativePath)}><ExternalLink size={15}/><span>{file.name}</span></button>)}</div>}{error&&<ErrorState message={error}/>}</>;
}
function stepClass(n:FlowNode){
  if(n.type==='official'&&n.isCurrent)return 'flow-step is-current is-official';
  if(n.finished)return 'flow-step is-done';
  if(n.isCurrent)return 'flow-step is-current';
  return 'flow-step is-upcoming';
}
function wallStamp(value?:string){
  const raw=(value??'').trim();
  if(!raw)return '';
  const m=/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?/.exec(raw);
  if(!m)return raw;
  return m[2]?`${m[1]} ${m[2]}:${m[3]}`:m[1];
}
function nodeCaption(n:FlowNode){
  if(n.type==='official')return n.user||'官方';
  if(n.type==='receipt'||(/回执/.test(n.name)&&n.finished))return '回执证据';
  if(isInternalEndNode(n.name)&&n.finished)return INTERNAL_FLOW_END;
  if(n.isCurrent)return n.user||'未提供办理人';
  if(n.finished)return n.user||'';
  return '尚未到达';
}
function nodeTitle(n:FlowNode){
  if(n.type==='official'&&n.isCurrent)return `${n.name} · 当前`;
  if(isInternalEndNode(n.name)&&n.finished)return `${n.name} · ${INTERNAL_FLOW_END}`;
  if(n.isCurrent&&!n.finished)return `${n.name} · 当前`;
  if(n.finished)return `${n.name} · 已完成`;
  return `${n.name} · 后续`;
}
function processTag(p:RemoteProcess,currentId:string|undefined){
  const row=processRowHandling(p,currentId);
  return row.tag?<span className="tag">{row.tag}</span>:null;
}
export function RemoteFlow({caseView,profileKey,scopeVersion,caseRevision}:{caseView:CaseTransferModuleView;profileKey?:string;scopeVersion?:number;caseRevision?:number}){
  const caseId = caseView.identity.id;
  const processKey=caseView.stage.current.processId||caseView.stage.current.roundId||`local-${caseView.stage.kind}`;
  const cacheKey = flowCacheKey(profileKey, caseId, scopeVersion,processKey,caseRevision);
  const generation=useRef(0);
  const [cachedFlow,setFlow]=useState<FlowView|null>(()=>flowCache.get(cacheKey)??null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const refresh=async()=>{
    const token=++generation.current;
    setBusy(true);setError('');
    try{
      const view=await desktop!.flow(caseId);
      if(token!==generation.current)return;
      setCaseFlowCache(profileKey,caseId,view,scopeVersion,processKey,caseRevision);
      setFlow(view);
    }catch(e){
      if(token===generation.current)setError((e as Error).message);
    }finally{
      if(token===generation.current)setBusy(false);
    }
  };
  useEffect(()=>{
    const c=flowCache.get(cacheKey);
    setFlow(c??null);setError('');setBusy(false);
    if(!c&&desktop&&caseView.transfer.remoteCaseId){
      void refresh();
    }
    return()=>{generation.current++;};
  },[cacheKey,caseId,caseView.transfer.remoteCaseId]);
  const flow=cachedFlow&&cachedFlow.currentProcessId===caseView.stage.current.processId&&(!cachedFlow.processes?.caseId||!caseView.transfer.remoteCaseId||cachedFlow.processes.caseId===caseView.transfer.remoteCaseId)?cachedFlow:null;
  const processes=flow?.processes?.processes??caseView.transfer.processes;
  const currentId=caseView.stage.current.processId??flow?.currentProcessId;
  const currentProc=processes.find(p=>p.id===currentId);
  const sub=caseView.transfer.currentSubmission??currentProc?.submission;
  const handling=handlingForView(caseView,flow?{currentProcessId:flow.currentProcessId,currentFlow:flow.currentFlow,nodes:flow.nodes}:undefined);
  const officialWaiting=handling.officialWaiting;
  const infoStamp=flow?.at??sub?.checkedAt;
  const infoStampText=safeStamp(infoStamp);
  const handlerText=handlingHandlerText(handling);
  const progressCaption=officialWaitProgressCaption(handling,flow?.nodes);
  const conclusion=outcomeStatementForView(caseView.officialOutcome);
  const deadline=deadlineForView(caseView);
  return <section className="business-workspace remote-flow"><div className="section-heading"><div><h2>贝思兰德流程</h2><p className="section-copy">当前办理以实际流程节点为准；提交官方后由官方继续办理，回执只证明接收成功。</p></div>{busy&&<div className="transfer-inspecting"><RefreshCw size={14} className="spin"/><span>正在查询最新流程…</span></div>}</div>{error&&<ErrorState message={error} onRetry={()=>void refresh()}/>} {!caseView.transfer.remoteCaseId?<Note>本案尚未关联贝思兰德，登录后同步的案件会显示系统流程。</Note>:<><p className="muted">流程信息时间：{infoStampText||'尚未查询'}</p>
    {conclusion&&<p className="flow-official-conclusion">官方结论：{conclusion}。结论来自官文清单只读判读；贝思兰德所内流程不会自动推进，下面仍是最后一次递交与回执记录。</p>}
    <div className={`flow-official${sub?` is-${sub.state}`:''}${sub?.refreshError?' is-stale':''}${officialWaiting?' is-current-handling':''}`}><h3>{sub?officialStatusLabel(sub):'官方递交状态未确认'}{officialWaiting&&<span className="tag">当前办理</span>}</h3>
      <p>{sub?.message&&sub.message!==officialStatusLabel(sub)?sub.message:officialWaiting?(sub?.state==='received'?'已收到官方回执，继续等待官方处理结果。':'已递交，等待官方处理结果。'):sub?.state==='unknown'?'不能仅凭内部节点或承办人判断是否已递交官方。':sub?.state==='draft'?'未递交官方，当前仍在内部递交办理。':'查询后显示官方递交结果。'}</p>
      <p className="flow-official-deadline">{deadline.label}：{deadline.value}</p>
      <p>当前办理节点：{handling.node} · 办理主体：{handling.party}{handlerText&&handling.handlerKind!=='official'?` · ${handling.handlerKind==='pending-undertaker'?'待办承办人':'当前办理人'}：${handling.handler}`:''}</p>
      {sub?.refreshError&&<p className="flow-official-stale">{sub.refreshError}</p>}
      {sub?.checkedAt&&safeStamp(sub.checkedAt)&&<p className="flow-official-time">{sub.refreshError?'上次确认：':'确认时间：'}{safeStamp(sub.checkedAt)}</p>}
    </div>
    {!flow&&<Note>当前显示本地已同步的流程与承办信息。点击顶栏【刷新本案】会重新读取本案流程、历史、附件清单、备注和官方结论，并只下载新增或待重试材料。</Note>}
    {flow&&<><h3>节点进度</h3>{progressCaption?<p className="muted">{progressCaption}</p>:null}
      {flow.nodes.length?<ol className="flow-stepper">{flow.nodes.map((n,i)=>{const cap=nodeCaption(n);const start=wallStamp(n.start);const end=wallStamp(n.end);return <li className={stepClass(n)} key={i}><span className="flow-dot" aria-hidden/><div className="flow-step-body"><b>{nodeTitle(n)}</b><p>{cap}{n.stayHours!==undefined?`${cap?' · ':''}停留 ${n.stayHours} 小时`:''}{start?`${cap||n.stayHours!==undefined?' · ':''}${start}`:''}{end?` → ${end}`:''}</p></div></li>;})}</ol>:<Note>系统未返回流转节点，待办案件可能尚未创建流转实例。</Note>}</>}
    <div className="flow-history"><details className="flow-details"><summary>内部流程与承办人</summary>
      <p className="section-copy">各流程按自身状态标记；已递交的选定流程为官方处理中，其他仍在内部办理的流程不是历史。</p>
      <div className="remote-processes">{processes.map(p=>{const procDue=processDeadlineView(p);return <div key={p.id}><h3>{p.name}{processTag(p,currentId)}</h3><dl className="compact-facts"><div><dt>内部节点</dt><dd>{p.node||'系统未提供'}</dd></div><div><dt>承办人</dt><dd>{p.undertaker||'系统未提供'}</dd></div><div><dt>{procDue.ordinal===null?'办理期限':procDue.label}</dt><dd>{procDue.display==='—'?'未提供':procDue.display}</dd></div>{p.internalDeadline&&<div><dt>内部期限</dt><dd>{p.internalDeadline}</dd></div>}</dl></div>;})}</div>
      {!processes.length&&<Note>暂无内部流程记录。</Note>}
    </details>
    {flow&&<details className="flow-details"><summary>全案流程历史</summary>{flow.history.length?flow.history.map((h,i)=><div className="flow-history-row" key={i}><b>{h.name}</b><p>{[wallStamp(h.created),h.finished?`→ ${wallStamp(h.finished)}`:'· 未完结'].filter(Boolean).join(' ')}</p></div>):<Note>没有可展开的全案历史。</Note>}<p className="muted">查询时间：{safeStamp(flow.at)||'未记录'}</p></details>}</div></>}</section>;
}
export function CurrentCase({caseView,professionalView,update,materialsOnly=false,discussionOnly=false,outputsOnly=false,conversationOnly=false,profileKey,scope,onRefresh,refreshing=false,discussionId}:{caseView:CaseReplyView;professionalView?:CaseProfessionalView;update:(p:{localDraft?:string;localVersions?:Array<{id:string;text:string;at:string;processId?:string}>},scope?:DesktopScope)=>void|Promise<void>;materialsOnly?:boolean;discussionOnly?:boolean;outputsOnly?:boolean;conversationOnly?:boolean;profileKey?:string;scope?:DesktopScope;onRefresh?:()=>Promise<void>;refreshing?:boolean;discussionId?:string}){
  const caseId=caseView.identity.id;
  const [draft,setDraft]=useState(caseView.manuscripts.localDraft??''),[dirty,setDirty]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[candidates,setCandidates]=useState<{id:string;name:string}[]|null>(null);
  useEffect(()=>{if(!dirty)setDraft(caseView.manuscripts.localDraft??'');},[caseView.manuscripts.localDraft,dirty]);
  const [showDraft,setShowDraft]=useState(false);
  const editSequence=useRef(0);
  const draftRef=useRef(draft);
  draftRef.current=draft;
  const autosaveRef=useRef<ReturnType<typeof createDraftAutosave>|null>(null);
  const generation=useRef(0);
  const materials=caseView.materials.all;
  const readyMaterials=materials.filter(m=>m.ready&&m.relativePath).length,pendingMaterials=materials.length-readyMaterials,editable=caseView.stage.editable;
  const kind=caseView.stage.kind;
  const formal=editable && (kind==='reply' || kind==='correction');
  const processKey=(caseView.stage.current.processId||caseView.stage.current.roundId||`local-${kind}`).trim();
  const action=async(fn:(current:()=>boolean)=>Promise<unknown>)=>{const token=generation.current;setError('');try{await fn(()=>token===generation.current);}catch(e){if(token===generation.current)setError((e as Error).message);}};
  useEffect(()=>{
    const token=++generation.current;
    const saveUpdate=update;
    const ctrl=createDraftAutosave({
      save:async(text)=>{
        const seq=editSequence.current;
        if(token===generation.current)setError('');
        try{
          await saveUpdate({localDraft:text},scope);
          if(token===generation.current&&seq===editSequence.current&&!autosaveRef.current?.hasPending()&&draftRef.current===text){
            setDirty(false);
            setMessage('工作稿已自动保存。');
          }
        }catch(e){
          if(token===generation.current)setError((e as Error).message);
        }
      },
    });
    autosaveRef.current=ctrl;
    return()=>{
      generation.current++;
      void ctrl.flush();
      if(autosaveRef.current===ctrl)autosaveRef.current=null;
    };
  },[caseId, scope?.profileKey, scope?.scopeVersion, scope?.caseId, scope?.processKey, scope?.caseRevision]);
  async function save(version:boolean){
    autosaveRef.current?.cancel();
    const sequence=++editSequence.current;
    const versions=version?[...caseView.manuscripts.localVersions,{id:crypto.randomUUID(),text:draft,at:new Date().toISOString(),processId:caseView.stage.current.processId}]:[...caseView.manuscripts.localVersions];
    await action(async current=>{await update({localDraft:draft,localVersions:versions},scope);if(current()&&sequence===editSequence.current){setDirty(false);setMessage(version?'新版本已保存到本案目录。':'工作稿已保存。');}});
  }
  function edit(text:string){
    editSequence.current++;
    setDraft(text);
    setDirty(true);
    setMessage('');
    autosaveRef.current?.onChange(text);
  }
  function flushAutosave(){void autosaveRef.current?.flush();}
  const handling=caseView.stage.handling;
  const agentScope={scopeVersion:scope?.scopeVersion,caseRevision:scope?.caseRevision};
  if(conversationOnly && profileKey) return <AgentWorkbench key={`${profileKey}-${caseId}-${processKey}-${discussionId ?? ''}`} {...agentScope} profileKey={profileKey} caseView={caseView} formal={formal} initialDiscussionId={discussionId}/>;
  if(discussionOnly && profileKey) return <section className="business-workspace"><AgentWorkbench key={`${profileKey}-${caseId}-${processKey}-${discussionId ?? ''}`} {...agentScope} profileKey={profileKey} caseView={caseView} formal={false} initialDiscussionId={discussionId}/></section>;
  if(outputsOnly && profileKey) return <section className="business-workspace"><div className="section-heading"><div><h2>本案成果</h2><p className="section-copy">生成文件可预览正文，或打开案件目录查看。答复 Word 使用确认模板，修改文本与内部说明分别归档。</p></div><button onClick={()=>void action(()=>desktop!.openCaseDirectory(caseId))}><FolderOpen size={16}/>打开案件目录</button></div><CaseArtifacts {...agentScope} profileKey={profileKey} caseId={caseId} processKey={processKey}/>{professionalView&&<ProfessionalArtifacts profileKey={profileKey} profileView={professionalView}/>}</section>;
  return <section className="business-workspace"><div className="section-heading"><div><h2>{materialsOnly?'案件材料':'当前办理'}</h2><p className="section-copy">{handling.node} · {handling.status}</p></div><button onClick={()=>void action(()=>desktop!.openCaseDirectory(caseId))}><FolderOpen size={16}/>打开案件目录</button></div>{error&&<p role="alert" className="inline-warning">{error}</p>}
    {materialsOnly&&<div className={`material-source-summary ${pendingMaterials?'is-warning':'is-ready'}`} role="status"><FileText size={18}/><div><b>{caseView.identity.source==='baseland'?'本案材料已同步到本机目录':'本案材料已保存在本机目录'}</b><p>{readyMaterials} 份材料可直接打开{pendingMaterials?`，${pendingMaterials} 份仍待下载或核对`:''}。文件就绪不等于已完成模型阅读；分析任务会单独保留真实读取证据。</p></div><span>{materials.length} 份材料</span></div>}
    {!materialsOnly&&profileKey&&<AgentWorkbench key={`${profileKey}-${caseId}-${processKey}-${discussionId ?? ''}`} {...agentScope} profileKey={profileKey} caseView={caseView} formal={formal} initialDiscussionId={discussionId}/>}
    {!materialsOnly&&<><div className="manual-draft-heading"><div><h3>手工工作稿</h3><p>用于直接编辑正文、自动保存与保留版本；运行中也不会中断或覆盖这段人工稿。</p></div><button onClick={()=>setShowDraft(!showDraft)}>{showDraft?'收起手工稿':caseView.manuscripts.localDraft?.trim()?'打开已保存的手工稿':'打开手工编辑器'}</button></div>{showDraft&&<><label className="field">手工稿正文<textarea className="native-draft" value={draft} onChange={e=>edit(e.target.value)} onBlur={flushAutosave} readOnly={!editable} placeholder="在这里直接编辑正文，保存到本案工作目录…"/></label><div className="action-bar"><span className="muted">{dirty?'正在保存…':message||'稿件保存在本案工作目录'}</span><div className="button-row"><button disabled={!editable||!dirty} onClick={()=>void save(false)}>保存工作稿</button><button className="primary" disabled={!editable||!draft.trim()||dirty} onClick={()=>void save(true)}>保存新版本</button></div></div></>}{!editable&&<ReadonlyState>当前阶段仅可查看稿件；从贝思兰德更新当前办理状态后，再继续对应业务。</ReadonlyState>}</>}
    {materialsOnly&&profileKey&&<PriorArtPanel caseView={caseView} profileKey={profileKey} onUpdated={()=>{}}/>}
    <div className="section-heading"><h3>本案材料 · {materials.length}</h3><button onClick={()=>void action(async current=>{const found=await desktop!.findOriginals(caseId);if(current())setCandidates(found);})}>匹配原始申请文件</button></div><div className="artifact-catalog">{materials.map(m=>m.ready&&m.relativePath?<button key={m.id} onClick={()=>void action(()=>desktop!.openMaterial(caseId,m.relativePath!))}><FileText/><span><b>{m.name}</b><small>{m.role} · 已保存到本案</small></span></button>:<button key={m.id} disabled={!onRefresh||refreshing} onClick={()=>void action(async()=>{if(onRefresh)await onRefresh();})}><FileText/><span><b>{m.name}</b><small>{m.role} · 待下载重试</small></span></button>)}</div>{!materials.length&&<Note>暂无材料。同步通知书或从原始申请文件库复制匹配文件后显示。</Note>}
    {candidates&&<Modal title="原始申请文件匹配" onClose={()=>setCandidates(null)}>{candidates.length?<div className="artifact-catalog">{candidates.map(c=><button key={c.id} onClick={()=>void action(async current=>{await desktop!.copyOriginal(caseId,c.id);if(current())setCandidates(null);})}><FileText/><span><b>{c.name}</b><small>复制到本案，保留文件库原件</small></span></button>)}</div>:<Note>未找到唯一案号或准确名称匹配。请检查设置中的原始申请文件库与文件命名。</Note>}</Modal>}
  </section>;
}
function CaseArtifacts({profileKey,caseId,processKey,scopeVersion,caseRevision}:{profileKey:string;caseId:string;processKey:string;scopeVersion?:number;caseRevision?:number}){
  const gen=useRef(0);
  const [view,setView]=useState<AgentCaseView|null>(null);
  const [error,setError]=useState('');
  const expected={profileKey,caseId,processKey,scopeVersion,caseRevision};
  useEffect(()=>{
    const token=++gen.current;
    setView(null);
    setError('');
    const api=desktop?.agent;
    if(!api)return;
    void api.getCase(profileKey,caseId).then(next=>{
      if(token!==gen.current)return;
      if(!shouldAcceptAgentView(next,expected))return;
      setView(next);
    }).catch(err=>{if(token===gen.current)setError((err as Error).message);});
    const unsub=api.onState(next=>{
      if(token!==gen.current)return;
      if(!shouldAcceptAgentView(next,expected))return;
      setView(next);
    });
    return()=>{gen.current++;unsub();};
  },[profileKey,caseId,processKey,scopeVersion,caseRevision]);
  if(error)return <ErrorState message={error}/>;
  if(!view || view.processKey!==processKey)return <LoadingState>正在读取成果列表…</LoadingState>;
  return <AgentArtifacts view={view} caseId={caseId}/>;
}
