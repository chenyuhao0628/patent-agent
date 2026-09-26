import { PriorArtPanel } from './PriorArt.tsx';
import { ProfessionalArtifacts } from './ProfessionalWork.tsx';
import { useEffect, useRef, useState } from 'react';
import { createDraftAutosave } from './draft-autosave.ts';
import { FileText, FolderOpen, RefreshCw } from 'lucide-react';
import type { Case, RemoteProcess } from '../domain/workflow.ts';
import { currentWork, editableCurrent, historyRecords, officialStatusLabel, processSubmission } from '../domain/lifecycle.ts';
import { currentHandling, handlingHandlerText, INTERNAL_FLOW_END, isInternalEndNode, officialWaitProgressCaption, processRowHandling } from '../domain/handling.ts';
import { deadlineFieldLabel, deadlineFieldValue, processDeadlineView } from '../domain/deadlines.ts';
import { agentProcessKey, desktop, shouldAcceptAgentView } from '../desktop.ts';
import type { AgentCaseView, FlowNode, FlowView } from '../desktop.ts';
import { hasOfficialOutcome, outcomeStatement, stamp as safeStamp } from '../domain/outcome.ts';
import { Modal, Note } from './Primitives.tsx';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';
import { AgentArtifacts, AgentWorkbench } from './AgentWorkbench.tsx';
import '../flow.css';

const flowCache = new Map<string, FlowView>();
export function setCaseFlowCache(caseId: string, view: FlowView){ flowCache.set(caseId, view); }

export function CaseHistory({item}:{item:Case}){
  const [preview,setPreview]=useState('');
  const records=historyRecords(item);
  return <section className="business-workspace"><h2>办理历史</h2><p className="section-copy">历史记录可查看，当前办理阶段保持不变。</p><div className="artifact-catalog">{records.map(record=><button key={record.id} onClick={()=>setPreview(record.text)}><FileText/><span><b>{record.title}</b><small>{record.detail}</small></span></button>)}</div>{!records.length&&<Note>暂无历史办理记录。</Note>}{preview&&<Modal title="历史内容 · 只读" onClose={()=>setPreview('')}><FormattedFormulaText text={preview}/></Modal>}</section>;
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
export function RemoteFlow({item}:{item:Case}){
  const [cachedFlow,setFlow]=useState<FlowView|null>(()=>flowCache.get(item.id)??null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const refresh=async()=>{
    setBusy(true);setError('');
    try{
      const view=await desktop!.flow(item.id);
      flowCache.set(item.id,view);
      setFlow(view);
    }catch(e){
      setError((e as Error).message);
    }finally{
      setBusy(false);
    }
  };
  useEffect(()=>{
    const c=flowCache.get(item.id);
    if(c)setFlow(c);
    else if(desktop&&item.remote&&!busy){
      void refresh();
    }
  },[item.id,item.remote?.syncedAt]);
  const flow=cachedFlow&&cachedFlow.currentProcessId===item.current?.processId&&(!cachedFlow.processes?.caseId||!item.remote?.caseId||cachedFlow.processes.caseId===item.remote.caseId)?cachedFlow:null;
  const processes=flow?.processes?.processes??item.remote?.processes??[];
  const currentId=item.current?.processId??flow?.currentProcessId;
  const currentProc=processes.find(p=>p.id===currentId);
  const sub=processSubmission(item)??currentProc?.submission;
  const handling=currentHandling(item,flow?{currentProcessId:flow.currentProcessId,currentFlow:flow.currentFlow,nodes:flow.nodes}:undefined);
  const officialWaiting=handling.officialWaiting;
  const infoStamp=flow?.at??sub?.checkedAt??item.remote?.syncedAt;
  const infoStampText=safeStamp(infoStamp);
  const handlerText=handlingHandlerText(handling);
  const progressCaption=officialWaitProgressCaption(handling,flow?.nodes);
  const conclusion=hasOfficialOutcome(item)?outcomeStatement(item):undefined;
  return <section className="business-workspace remote-flow"><div className="section-heading"><div><h2>贝思兰德流程</h2><p className="section-copy">当前办理以实际流程节点为准；提交官方后由官方继续办理，回执只证明接收成功。</p></div>{busy&&<div className="transfer-inspecting"><RefreshCw size={14} className="spin"/><span>正在查询最新流程…</span></div>}</div>{error&&<p role="alert" className="inline-warning">{error}</p>}{!item.remote?<Note>本案尚未关联贝思兰德，登录后同步的案件会显示系统流程。</Note>:<><p className="muted">流程信息时间：{infoStampText||'尚未查询'}</p>
    {conclusion&&<p className="flow-official-conclusion">官方结论：{conclusion}。结论来自官文清单只读判读；贝思兰德所内流程不会自动推进，下面仍是最后一次递交与回执记录。</p>}
    <div className={`flow-official${sub?` is-${sub.state}`:''}${sub?.refreshError?' is-stale':''}${officialWaiting?' is-current-handling':''}`}><h3>{sub?officialStatusLabel(sub):'官方递交状态未确认'}{officialWaiting&&<span className="tag">当前办理</span>}</h3>
      <p>{sub?.message&&sub.message!==officialStatusLabel(sub)?sub.message:officialWaiting?(sub?.state==='received'?'已收到官方回执，继续等待官方处理结果。':'已递交，等待官方处理结果。'):sub?.state==='unknown'?'不能仅凭内部节点或承办人判断是否已递交官方。':sub?.state==='draft'?'未递交官方，当前仍在内部递交办理。':'查询后显示官方递交结果。'}</p>
      <p className="flow-official-deadline">{deadlineFieldLabel(item)}：{deadlineFieldValue(item)}</p>
      <p>当前办理节点：{handling.node} · 办理主体：{handling.party}{handlerText&&handling.handlerKind!=='official'?` · ${handling.handlerKind==='pending-undertaker'?'待办承办人':'当前办理人'}：${handling.handler}`:''}</p>
      {sub?.refreshError&&<p className="flow-official-stale">{sub.refreshError}</p>}
      {sub?.checkedAt&&safeStamp(sub.checkedAt)&&<p className="flow-official-time">{sub.refreshError?'上次确认：':'确认时间：'}{safeStamp(sub.checkedAt)}</p>}
    </div>
    {!flow&&<Note>当前显示本地已同步的流程与承办信息。如需查看最新流转节点进度图或全案流转历史，请点击顶栏【刷新本案】。</Note>}
    {flow&&<><h3>节点进度</h3>{progressCaption?<p className="muted">{progressCaption}</p>:null}
      {flow.nodes.length?<ol className="flow-stepper">{flow.nodes.map((n,i)=>{const cap=nodeCaption(n);const start=wallStamp(n.start);const end=wallStamp(n.end);return <li className={stepClass(n)} key={i}><span className="flow-dot" aria-hidden/><div className="flow-step-body"><b>{nodeTitle(n)}</b><p>{cap}{n.stayHours!==undefined?`${cap?' · ':''}停留 ${n.stayHours} 小时`:''}{start?`${cap||n.stayHours!==undefined?' · ':''}${start}`:''}{end?` → ${end}`:''}</p></div></li>;})}</ol>:<Note>系统未返回流转节点，待办案件可能尚未创建流转实例。</Note>}</>}
    <div className="flow-history"><details className="flow-details"><summary>内部流程与承办人</summary>
      <p className="section-copy">各流程按自身状态标记；已递交的选定流程为官方处理中，其他仍在内部办理的流程不是历史。</p>
      <div className="remote-processes">{processes.map(p=>{const procDue=processDeadlineView(p);return <div key={p.id}><h3>{p.name}{processTag(p,currentId)}</h3><dl className="compact-facts"><div><dt>内部节点</dt><dd>{p.node||'系统未提供'}</dd></div><div><dt>承办人</dt><dd>{p.undertaker||'系统未提供'}</dd></div><div><dt>{procDue.ordinal===null?'办理期限':procDue.label}</dt><dd>{procDue.display==='—'?'未提供':procDue.display}</dd></div>{p.internalDeadline&&<div><dt>内部期限</dt><dd>{p.internalDeadline}</dd></div>}</dl></div>;})}</div>
      {!processes.length&&<Note>暂无内部流程记录。</Note>}
    </details>
    {flow&&<details className="flow-details"><summary>全案流程历史</summary>{flow.history.length?flow.history.map((h,i)=><div className="flow-history-row" key={i}><b>{h.name}</b><p>{[wallStamp(h.created),h.finished?`→ ${wallStamp(h.finished)}`:'· 未完结'].filter(Boolean).join(' ')}</p></div>):<Note>没有可展开的全案历史。</Note>}<p className="muted">查询时间：{safeStamp(flow.at)||'未记录'}</p></details>}</div></>}</section>;
}
export function CurrentCase({item,update,materialsOnly=false,discussionOnly=false,outputsOnly=false,conversationOnly=false,profileKey,onRefresh,refreshing=false}:{item:Case;update:(p:Partial<Case>)=>void|Promise<void>;materialsOnly?:boolean;discussionOnly?:boolean;outputsOnly?:boolean;conversationOnly?:boolean;profileKey?:string;onRefresh?:()=>Promise<void>;refreshing?:boolean}){
  const [draft,setDraft]=useState(item.localDraft??''),[dirty,setDirty]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[candidates,setCandidates]=useState<{id:string;name:string}[]|null>(null);
  useEffect(()=>{if(!dirty)setDraft(item.localDraft??'');},[item.localDraft,dirty]);
  const [showDraft,setShowDraft]=useState(false);
  const editSequence=useRef(0);
  const draftRef=useRef(draft);
  draftRef.current=draft;
  const updateRef=useRef(update);
  updateRef.current=update;
  const autosaveRef=useRef<ReturnType<typeof createDraftAutosave>|null>(null);
  const mountedRef=useRef(true);
  const materials=[...(item.materials??[]),...item.rounds.flatMap(r=>r.materials)],readyMaterials=materials.filter(m=>m.ready&&m.relativePath).length,pendingMaterials=materials.length-readyMaterials,editable=editableCurrent(item);
  const kind=currentWork(item).kind;
  const formal=editable && (kind==='reply' || kind==='correction');
  const processKey=agentProcessKey(item);
  const action=async(fn:()=>Promise<unknown>)=>{setError('');try{await fn();}catch(e){setError((e as Error).message);}};
  useEffect(()=>{
    mountedRef.current=true;
    const ctrl=createDraftAutosave({
      save:async(text)=>{
        const seq=editSequence.current;
        setError('');
        try{
          await updateRef.current({localDraft:text});
          if(mountedRef.current&&seq===editSequence.current&&!autosaveRef.current?.hasPending()&&draftRef.current===text){
            setDirty(false);
            setMessage('工作稿已自动保存。');
          }
        }catch(e){
          if(mountedRef.current)setError((e as Error).message);
        }
      },
    });
    autosaveRef.current=ctrl;
    return()=>{
      mountedRef.current=false;
      void ctrl.flush();
      if(autosaveRef.current===ctrl)autosaveRef.current=null;
    };
  },[item.id]);
  async function save(version:boolean){
    autosaveRef.current?.cancel();
    editSequence.current++;
    const versions=version?[...(item.localVersions??[]),{id:crypto.randomUUID(),text:draft,at:new Date().toISOString(),processId:item.current?.processId}]:item.localVersions;
    await action(async()=>{await update({localDraft:draft,localVersions:versions});setDirty(false);setMessage(version?'新版本已保存到本案目录。':'工作稿已保存。');});
  }
  function edit(text:string){
    editSequence.current++;
    setDraft(text);
    setDirty(true);
    setMessage('');
    autosaveRef.current?.onChange(text);
  }
  function flushAutosave(){void autosaveRef.current?.flush();}
  const handling=currentHandling(item);
  if(conversationOnly && profileKey) return <AgentWorkbench key={`${profileKey}-${item.id}-${processKey}`} profileKey={profileKey} item={item} formal={formal}/>;
  if(discussionOnly && profileKey) return <section className="business-workspace"><AgentWorkbench key={`${profileKey}-${item.id}-${processKey}`} profileKey={profileKey} item={item} formal={false}/></section>;
  if(outputsOnly && profileKey) return <section className="business-workspace"><div className="section-heading"><div><h2>本案成果</h2><p className="section-copy">生成文件可预览正文，或打开案件目录查看。答复 Word 使用确认模板，修改文本与内部说明分别归档。</p></div><button onClick={()=>void action(()=>desktop!.openCaseDirectory(item.id))}><FolderOpen size={16}/>打开案件目录</button></div><CaseArtifacts profileKey={profileKey} caseId={item.id} processKey={processKey}/><ProfessionalArtifacts profileKey={profileKey} item={item}/></section>;
  return <section className="business-workspace"><div className="section-heading"><div><h2>{materialsOnly?'案件材料':'当前办理'}</h2><p className="section-copy">{handling.node} · {handling.status}</p></div><button onClick={()=>void action(()=>desktop!.openCaseDirectory(item.id))}><FolderOpen size={16}/>打开案件目录</button></div>{error&&<p role="alert" className="inline-warning">{error}</p>}
    {materialsOnly&&<div className={`material-source-summary ${pendingMaterials?'is-warning':'is-ready'}`} role="status"><FileText size={18}/><div><b>{item.source==='baseland'?'本案材料已同步到本机目录':'本案材料已保存在本机目录'}</b><p>{readyMaterials} 份材料可直接打开{pendingMaterials?`，${pendingMaterials} 份仍待下载或核对`:''}。文件就绪不等于已完成模型阅读；分析任务会单独保留真实读取证据。</p></div><span>{materials.length} 份材料</span></div>}
    {!materialsOnly&&profileKey&&<AgentWorkbench key={`${profileKey}-${item.id}-${processKey}`} profileKey={profileKey} item={item} formal={formal}/>}
    {!materialsOnly&&<><div className="manual-draft-heading"><div><h3>手工工作稿</h3><p>用于直接编辑正文、自动保存与保留版本；运行中也不会中断或覆盖这段人工稿。</p></div><button onClick={()=>setShowDraft(!showDraft)}>{showDraft?'收起手工稿':item.localDraft?.trim()?'打开已保存的手工稿':'打开手工编辑器'}</button></div>{showDraft&&<><label className="field">手工稿正文<textarea className="native-draft" value={draft} onChange={e=>edit(e.target.value)} onBlur={flushAutosave} readOnly={!editable} placeholder="在这里直接编辑正文，保存到本案工作目录…"/></label><div className="action-bar"><span className="muted">{dirty?'正在保存…':message||'稿件保存在本案工作目录'}</span><div className="button-row"><button disabled={!editable||!dirty} onClick={()=>void save(false)}>保存工作稿</button><button className="primary" disabled={!editable||!draft.trim()||dirty} onClick={()=>void save(true)}>保存新版本</button></div></div></>}{!editable&&<Note>当前阶段仅可查看稿件；从贝思兰德更新当前办理状态后，再继续对应业务。</Note>}</>}
    {materialsOnly&&profileKey&&<PriorArtPanel item={item} profileKey={profileKey} onUpdated={()=>{}}/>}
    <div className="section-heading"><h3>本案材料 · {materials.length}</h3><button onClick={()=>void action(async()=>setCandidates(await desktop!.findOriginals(item.id)))}>匹配原始申请文件</button></div><div className="artifact-catalog">{materials.map(m=>m.ready&&m.relativePath?<button key={m.id} onClick={()=>void action(()=>desktop!.openMaterial(item.id,m.relativePath!))}><FileText/><span><b>{m.name}</b><small>{m.role} · 已保存到本案</small></span></button>:<button key={m.id} disabled={!onRefresh||refreshing} onClick={()=>void action(async()=>{if(onRefresh)await onRefresh();})}><FileText/><span><b>{m.name}</b><small>{m.role} · 待下载重试</small></span></button>)}</div>{!materials.length&&<Note>暂无材料。同步通知书或从原始申请文件库复制匹配文件后显示。</Note>}
    {candidates&&<Modal title="原始申请文件匹配" onClose={()=>setCandidates(null)}>{candidates.length?<div className="artifact-catalog">{candidates.map(c=><button key={c.id} onClick={()=>void action(async()=>{await desktop!.copyOriginal(item.id,c.id);setCandidates(null);})}><FileText/><span><b>{c.name}</b><small>复制到本案，保留文件库原件</small></span></button>)}</div>:<Note>未找到唯一案号或准确名称匹配。请检查设置中的原始申请文件库与文件命名。</Note>}</Modal>}
  </section>;
}
function CaseArtifacts({profileKey,caseId,processKey}:{profileKey:string;caseId:string;processKey:string}){
  const gen=useRef(0);
  const [view,setView]=useState<AgentCaseView|null>(null);
  const [error,setError]=useState('');
  const expected={profileKey,caseId,processKey};
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
  },[profileKey,caseId,processKey]);
  if(error)return <p className="inline-warning" role="alert">{error}</p>;
  if(!view || view.processKey!==processKey)return <Note>正在读取成果列表…</Note>;
  return <AgentArtifacts view={view} caseId={caseId}/>;
}
