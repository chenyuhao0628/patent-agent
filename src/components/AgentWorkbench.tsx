import { AgentRunStatus } from './AgentRunStatus.tsx';
import { discussionJobs, workflowMessageCommand } from '../domain/conversation.ts';
import { discussionCanDelete } from '../domain/agent.ts';
import { CorrectionContentsEditor } from './CorrectionContentsEditor.tsx';
import { ApplicationPartsEditor } from './ApplicationPartsEditor.tsx';
import { PriorArtPanel } from './PriorArt.tsx';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, PanelRight, Square } from 'lucide-react';
import type { Case } from '../domain/workflow.ts';
import type { AgentJob, AgentMessage, Discussion, MaterialEntry, ToolEvent } from '../domain/agent.ts';
import { activeJob, artifactPreviewText, currentDraft, currentReview, selectedMaterials, selectedStrategy, unhandledIssues } from '../domain/agent.ts';
import { currentWork } from '../domain/lifecycle.ts';
import { desktop } from '../desktop.ts';
import type { AgentCaseView, AgentCommand } from '../desktop.ts';
import {
  agentActionBlocker,
  agentProcessKey,
  canSelectCaseMaterials,
  classificationFields,
  discussionJobAlert,
  latestDiscussionJob,
  materialReadIds,
  modelSnapshotLabel,
  partialTextForDiscussion,
  pickedFromMaterials,
  reviseRunDiscussionId,
  sanitizeAgentError,
  serverFormFingerprint,
  shouldAcceptAgentView,
  shouldInitLocalForm,
  toolEventLabel,
  type ServerFormFingerprint,
} from '../desktop.ts';
import { Modal, Note } from './Primitives.tsx';
import '../agent-workbench.css';

const STAGES = ['材料核对', '策略讨论', '起草修改', '独立复核（可选）', '用户定稿'] as const;

function stageIndex(view: AgentCaseView | undefined): number {
  const stage = view?.process.stage;
  if (stage === 'strategy') return 1;
  if (stage === 'draft') return 2;
  if (stage === 'review') return 3;
  if (stage === 'final') return 4;
  return 0;
}

function materialGroup(role: string): string {
  if (/原始/.test(role)) return '原件';
  if (/通知|审查意见|补正/.test(role)) return '通知材料';
  return role || '其他';
}

function timeline(discussion: Discussion | undefined, partial?: string, pending?: string, jobs:AgentJob[]=[]): Array<{ key: string; kind: 'message' | 'tool' | 'partial' | 'pending' | 'run'; job?:AgentJob; at: string; message?: AgentMessage; tool?: ToolEvent; text?: string }> {
  const rows: ReturnType<typeof timeline> = [];
  for (const message of discussion?.messages ?? []) rows.push({ key: 'm-' + message.id, kind: 'message', at: message.at, message });
  for(const job of jobs) rows.push({key:'run-'+job.runId,kind:'run',at:job.startedAt,job});
  for (const tool of discussion?.toolEvents ?? []) if(!jobs.some(j=>j.runId===tool.runId)) rows.push({ key: 't-' + tool.id, kind: 'tool', at: tool.at, tool });
  rows.sort((a, b) => a.at.localeCompare(b.at));
  if (pending) rows.push({ key: 'pending', kind: 'pending', at: '', text: pending });
  if (partial) rows.push({ key: 'partial', kind: 'partial', at: '', text: partial });
  return rows;
}

export function AgentWorkbench({
  profileKey,
  item,
  formal,
}: {
  profileKey: string;
  item: Case;
  formal: boolean;
}) {
  const caseId = item.id;
  const processKey = agentProcessKey(item);
  const kind = currentWork(item).kind;
  const gen = useRef(0);
  const formSync = useRef<ServerFormFingerprint | undefined>(undefined);
  const frame = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const [view, setView] = useState<AgentCaseView | null>(null);
  const [error, setError] = useState('');
  const [clearConfirm, setClearConfirm] = useState(false);
  const [discussionId, setDiscussionId] = useState<string>();
  const [showArchived,setShowArchived]=useState(false);
  const [input, setInput] = useState('');
  const [discussionListOpen,setDiscussionListOpen]=useState(()=>window.innerWidth>=1250);
  const [hasNewContent,setHasNewContent]=useState(false);
  const [queueEditing,setQueueEditing]=useState<{id:string;text:string}>();
  const [compare,setCompare]=useState(false);
  const [restoreId,setRestoreId]=useState<string>();
  const [discussionOnly, setDiscussionOnly] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [commandBusy, setCommandBusy] = useState(false);
  const [preparation,setPreparation]=useState('');
  const [pending, setPending] = useState('');
  const [pendingDiscussionId, setPendingDiscussionId] = useState<string>();
  const [patentType, setPatentType] = useState('');
  const [noticeCategory, setNoticeCategory] = useState('');
  const [round, setRound] = useState('1');
  const [basis, setBasis] = useState('original');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [previewId, setPreviewId] = useState<string>();
  const [stageOpen, setStageOpen] = useState(false);
  const [selectedStage, setSelectedStage] = useState<number>();
  const [originals, setOriginals] = useState<{ id: string; name: string }[] | null>(null);
  const [commandError, setCommandError] = useState<{ text: string; discussionId?: string } | null>(null);
  const api = desktop?.agent;
  const expected = { profileKey, caseId, processKey };

  const apply = (next: AgentCaseView, token: number) => {
    if (token !== gen.current) return;
    if (!shouldAcceptAgentView(next, expected)) return;
    const displayClassification = next.process.classification.status === 'classified' ? next.process.classification : next.classificationSuggestion?.classification ?? next.process.classification;
    const fingerprint = serverFormFingerprint({ ...next.process, classification: displayClassification });
    const previous = formSync.current;
    if (shouldInitLocalForm(previous, fingerprint, 'classification')) {
      const fields = classificationFields(displayClassification);
      setPatentType(fields.patentType);
      setNoticeCategory(fields.noticeCategory);
      setRound(fields.round);
      setBasis(fields.basis);
    }
    if (shouldInitLocalForm(previous, fingerprint, 'selected')) {
      setPicked(pickedFromMaterials(next.process.materials));
    }
    formSync.current = fingerprint;
    setView(next);
    setDiscussionId(current => {
      if (current && next.process.discussions.some(item => item.id === current)) return current;
      return next.process.mainDiscussionId || next.process.discussions[0]?.id;
    });
  };

  useEffect(() => {
    const token = ++gen.current;
    formSync.current = undefined;
    setView(null);
    setError('');
    setPending('');
    setPendingDiscussionId(undefined);
    setInput('');
    setDiscussionId(undefined);
    setPreviewId(undefined);
    setEditing(undefined);
    setCommandBusy(false);
    setPreparation('');
    setPatentType('');
    setNoticeCategory('');
    setRound('1');
    setBasis('original');
    setPicked({});
    setStageOpen(false);
    setSelectedStage(undefined);
    setOriginals(null);
    setCommandError(null);
    if (!api) return;
    void api.getCase(profileKey, caseId).then(next => apply(next, token)).catch(err => {
      if (token !== gen.current) return;
      setError(sanitizeAgentError((err as Error).message));
    });
    const unsub = api.onState(next => {
      if (token !== gen.current) return;
      apply(next, token);
    });
    const unsubPreparation=api.onPreparation?.(event=>{
      if(token!==gen.current||event.profileKey!==profileKey||event.caseId!==caseId||event.processKey!==processKey)return;
      setPreparation(({queued:'等待本机任务队列',preparing:'正在核对本案任务',materials:'正在准备本次材料',permission:'正在核验本案办理权限',dispatch:'正在启动后台',done:''})[event.step]);
    });
    return () => { gen.current++; unsub();unsubPreparation?.(); };
  }, [api, profileKey, caseId, processKey]);

  useEffect(() => {
    if (followOutput.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    else setHasNewContent(true);
  }, [view, pending, discussionId]);

  useEffect(() => { setEditing(undefined);setQueueEditing(undefined); followOutput.current = true;setHasNewContent(false); }, [discussionId]);
  useEffect(()=>{const resize=()=>{if(window.innerWidth<1100)setDiscussionListOpen(false);};resize();window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);

  useLayoutEffect(() => {
    const resize = () => { if (frame.current) frame.current.style.height = `${Math.max(260, window.innerHeight - frame.current.getBoundingClientRect().top - 16)}px`; };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [!!view, caseId, formal]);

  const run = async (command: AgentCommand) => {
    if (!api || commandBusy) return;
    setCommandBusy(true);
    const token = gen.current;
    const errorDiscussion = command.type === 'run' ? (command.discussionId ?? discussionId) : discussionId;
    setCommandError(null);
    try {
      const next = await api.command(profileKey, caseId, command);
      apply(next, token);
      if (command.type === 'conversation') setEditing(undefined);
      if(command.type==='queue')setQueueEditing(undefined);
      if(command.type==='discussion')setDiscussionId(next.process.discussions.at(-1)?.id);
      if(command.type==='manageDiscussion')setDiscussionId(command.operation==='restore'?command.discussionId:next.process.mainDiscussionId);
      if (command.type === 'run' && command.action !== 'discuss') { setStageOpen(false); setSelectedStage(undefined); }
      if (command.type === 'adopt') setSelectedStage(3);
      if(command.type==='restoreDraft')setRestoreId(undefined);
      if(command.type==='strategy'&&command.startDraft)setStageOpen(false);
      if (command.type === 'finalize') setSelectedStage(4);
    } catch (err) {
      if (token !== gen.current) return;
      setCommandError({ text: sanitizeAgentError((err as Error).message), discussionId: errorDiscussion });
    } finally { if (token === gen.current) setCommandBusy(false); }
  };

  const send = async () => {
    if (!api || !input.trim() || commandBusy) return;
    const text = input;
    const token = gen.current;
    const sentDiscussion = discussionId;
    setInput('');
    setPending(text);
    setPendingDiscussionId(sentDiscussion);
    setCommandError(null);
    setCommandBusy(true);
    try {
      const command: AgentCommand = view?.busy ? {type:'queue',operation:'add',discussionId:sentDiscussion??view.process.mainDiscussionId,text:text.trim(),purpose:formal&&!discussionOnly?'workflow':'discuss',expectedRunId:view.process.activeRunId??undefined} : formal && !discussionOnly && view
        ? workflowMessageCommand(view.process, sentDiscussion ?? view.process.mainDiscussionId, text.trim())
        : { type: 'run', action: 'discuss', discussionId: sentDiscussion, userMessage: text.trim() };
      const next = await api.command(profileKey, caseId, command);
      if (token === gen.current) apply(next, token);
    } catch (err) {
      if (token === gen.current) {
        setInput(text);
        setCommandError({ text: sanitizeAgentError((err as Error).message), discussionId: sentDiscussion });
      }
    } finally {
      if (token === gen.current) { setPending(''); setPendingDiscussionId(undefined); setCommandBusy(false); }
    }
  };

  if (!api) return <Note>当前程序尚未连接本案对话。对话、分析和起草需要在桌面程序中使用。</Note>;
  if (!view && error) return <p className="inline-warning" role="alert">{error}</p>;
  if (!view || view.processKey !== processKey) return <div className="agent-empty">正在读取本案对话…</div>;

  const process = view.process;
  const discussion = process.discussions.find(item => item.id === discussionId) ?? process.discussions.find(item => item.id === process.mainDiscussionId);
  const busy = view.busy || commandBusy;
  const current = stageIndex(view);
  const shownStage = selectedStage ?? current;
  const showProgress=formal||!!process.analysis||process.drafts.length>0||['reply','correction'].includes(currentWork(item).kind);

  const openStage = (index: number) => { setSelectedStage(index); setStageOpen(true); };
  const analysisBlock = agentActionBlocker(view, 'analysis', formal);
  const draftBlock = agentActionBlocker(view, 'draft', formal);
  const reviseBlock = agentActionBlocker(view, 'revise', formal);
  const reviewBlock = agentActionBlocker(view, 'review', formal);
  const finalizeBlock = agentActionBlocker(view, 'finalize', formal);
  const strategyBlock = agentActionBlocker(view, 'strategy', formal);
  const pendingDrafts = process.drafts.filter(item => item.adoptStatus === 'pending');
  const adopted = currentDraft(process);
  const preview = process.drafts.find(item => item.id === previewId) ?? pendingDrafts[0] ?? adopted;
  const review = currentReview(process);
  const groups = new Map<string, MaterialEntry[]>();
  for (const material of process.materials) {
    const key = materialGroup(material.role);
    groups.set(key, [...(groups.get(key) ?? []), material]);
  }
  const selected = selectedMaterials(process);
  const readIds = materialReadIds(process);
  const canEditMaterials = canSelectCaseMaterials({
    formal,
    busy,
    access: process.access,
    finalized: !!process.finalized,
  });
  const writeIncomplete = kind === 'write';
  const reviewIncomplete = kind === 'review';
  const mainId = reviseRunDiscussionId(process);
  const partial = partialTextForDiscussion(view, discussion?.id);
  const pendingText = pending && pendingDiscussionId === discussion?.id ? pending : undefined;
  const runningOnThis = busy && activeJob(process)?.discussionId === discussion?.id;
  const latestJob = latestDiscussionJob(process, discussion?.id);
  const jobs = discussion ? discussionJobs(process, discussion) : [];
  const jobAlert = discussionJobAlert(latestJob);
  const queue=discussion?.queuedMessages?.filter(q=>q.branchId===(discussion.activeBranchId??'original'))??[];
  const branchPicker=discussion?.branches?.length?<label className="agent-branch-picker">对话版本<select aria-label="对话分支" disabled={busy} value={discussion.activeBranchId??'original'} onChange={e=>void run({type:'branch',discussionId:discussion.id,branchId:e.target.value})}>{discussion.branches.map((b,i)=><option key={b.id} value={b.id}>{i+1} · {b.title}</option>)}</select></label>:null;
  const nextAction=discussionOnly||discussion?.kind!=='main'?'仅讨论':!process.materialsConfirmed||process.classification.status!=='classified'?'先核对材料':!process.analysis?'继续意见分析':!process.userSelectedStrategyId?'先选定策略':process.currentDraftVersionId?'修订当前稿件':'起草答复';
  const visibleCommandError = commandError && (!commandError.discussionId || commandError.discussionId === discussion?.id)
    ? commandError.text
    : '';

  const startRevise = () => {
    setDiscussionId(mainId);
    void run({
      type: 'run',
      action: 'revise',
      discussionId: mainId,
      userMessage: input.trim() || '请按主讨论修订当前稿件。',
    });
  };

  return <div ref={frame} className={`agent-workbench${stageOpen ? ' is-stage-open' : ''}`}>
    <header className="agent-workbench-head">
      <div>
        <h3>{formal ? (process.classification.noticeCategory==='补正通知书'?'本案对话 · 补正办理':'本案对话 · 答复办理') : '本案对话'}</h3>
        <p className="agent-current-stage">{showProgress?`当前阶段：${STAGES[current]}`:"材料讨论"}</p>
        {!formal && !showProgress && <p>{writeIncomplete ? '完整撰写申请文件尚未完成，当前只开放围绕本案材料的讨论。' : reviewIncomplete ? '独立导入审查尚未完成，当前只开放围绕本案材料的讨论。' : '本页用于材料讨论，正式办理请进入本案对应业务。'}</p>}
      </div>
      <div className="agent-head-actions">{branchPicker}
        <button type="button" disabled={busy || !discussion || !!discussion.archived} onClick={()=>setClearConfirm(true)}>清理会话</button><details className="agent-model-details"><summary>模型与设置</summary><p>{modelSnapshotLabel(view)}</p><a href="#/settings/model">模型设置</a></details>
        <button type="button" aria-expanded={discussionListOpen} onClick={()=>setDiscussionListOpen(v=>!v)}>讨论列表</button>
        <button type="button" className={stageOpen ? 'primary' : ''} onClick={() => { setSelectedStage(undefined); setStageOpen(open => !open); }}>
          <PanelRight size={14}/>{showProgress ? '办理步骤' : '选用材料'}
        </button>
      </div>
    </header>
    {showProgress&&<nav className="agent-progress-nav" aria-label="当前办理进度">{STAGES.map((label,index)=>{
      const done=index===0?process.materialsConfirmed:index===1?!!process.userSelectedStrategyId:index===2?!!adopted:index===3?!!review&&!review.invalidated&&!unhandledIssues(process).length:!!process.finalized;
      return <button type="button" key={label} className={`${done?'is-done':''} ${index===current?'is-current':''}`} aria-current={index===current?'step':undefined} onClick={()=>openStage(index)}><span>{done?'✓':index+1}</span><b>{label}</b><small>{done?'已完成':index===3?'可跳过':index===current?'当前办理':'查看步骤'}</small></button>;
    })}</nav>}
    <div className={`agent-workbench-body${discussionListOpen?'':' discussions-collapsed'}`}>
      <nav className="agent-discussions" aria-label="讨论">
        <h4>讨论</h4>
        {process.discussions.filter(item=>showArchived?item.archived:!item.archived).map(item => <button key={item.id} type="button" className={item.id === discussion?.id ? 'active' : ''} onClick={() => setDiscussionId(item.id)}>
          {item.kind === 'review' ? '独立复核' : item.title || '主讨论'}
          <small>{item.kind === 'review' ? '单独上下文' : '本案讨论'}</small>
        </button>)}
        <button type="button" disabled={busy} onClick={() => {setShowArchived(false);void run({ type: 'discussion' });}}>新建讨论</button>
        <button type="button" onClick={()=>setShowArchived(!showArchived)}>{showArchived?'返回当前讨论':`已归档（${process.discussions.filter(d=>d.archived).length}）`}</button>
        {discussion&&discussion.id!==process.mainDiscussionId&&discussion.kind!=='review'&&<div className="discussion-actions">
          {discussionCanDelete(process,discussion.id)&&<button disabled={busy} onClick={()=>void run({type:'manageDiscussion',discussionId:discussion.id,operation:'delete'})}>删除空讨论</button>}
          <button disabled={busy} onClick={()=>{void run({type:'manageDiscussion',discussionId:discussion.id,operation:discussion.archived?'restore':'archive'});if(discussion.archived)setShowArchived(false);}}>{discussion.archived?'恢复讨论':'归档讨论'}</button>
        </div>}
      </nav>
      {clearConfirm && discussion && <Modal title="清理当前会话" onClose={()=>setClearConfirm(false)}><p>清空当前对话上下文，旧消息保存在对话版本中，可切换恢复。材料、策略、稿件和办理进度保留。</p><div className="button-row"><button onClick={()=>setClearConfirm(false)}>取消</button><button disabled={busy} onClick={()=>{setClearConfirm(false);void run({type:'clearConversation',discussionId:discussion.id});}}>清理并开始新上下文</button></div></Modal>}
      <section className="agent-thread">
        {commandBusy&&preparation&&<p className="agent-note" role="status">{preparation}</p>}
        <div className="agent-messages" ref={scroller} onScroll={e => { const el = e.currentTarget; followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;if(followOutput.current)setHasNewContent(false); }}>
          {discussion?.archived&&<p className="note">此讨论已归档，恢复后可以继续发送消息。</p>}
          {timeline(discussion, partial, pendingText,jobs).map(row => {
            if(row.kind==='run'&&row.job)return <div className="agent-turn" key={row.key}><AgentRunStatus job={row.job} tools={discussion?.toolEvents.filter(t=>t.runId===row.job!.runId)}/>{row.job.error&&<p className="agent-error">{row.job.error}</p>}{!busy&&['failed','stopped'].includes(row.job.state)&&row.job.runId===latestJob?.runId&&<div className="agent-recovery-actions"><button onClick={()=>void run({type:'conversation',discussionId:discussion!.id,runId:row.job!.runId,operation:'continue'})}>继续{row.job.action==='analysis'?'意见分析':'任务'}</button><button onClick={()=>void run({type:'conversation',discussionId:discussion!.id,runId:row.job!.runId,operation:'retry'})}>重新尝试</button></div>}</div>;
            if (row.kind === 'message' && row.message) {
              return <div key={row.key} className={`agent-message-group is-${row.message.role}`}><div className={`agent-bubble is-${row.message.role}`}>
                {row.message.incomplete && <small className="agent-incomplete">未完成的输出</small>}{row.message.text}
                {!discussion?.archived && <div className="agent-message-actions">
                  {row.message.role === 'user' ? <button type="button" disabled={commandBusy} onClick={() => setEditing({ id: row.message!.id, text: row.message!.text })}>编辑并重新发送</button>
                    : row.message.runId && <button type="button" disabled={commandBusy} onClick={() => void run({ type: 'conversation', discussionId: discussion!.id, operation: 'regenerate', messageId: row.message!.id })}>重新生成</button>}
                </div>}
              </div></div>;
            }
            if (row.kind === 'tool' && row.tool) {
              return <div key={row.key} className={`agent-tool${row.tool.status === 'error' ? ' is-error' : row.tool.status === 'ok' ? ' is-ok' : ''}`}>
                {toolEventLabel(row.tool)} {row.tool.filename}{row.tool.readRange ? ` · ${row.tool.readRange}` : ''}{row.tool.detail&&<details><summary>查看调用</summary><pre className="tool-command-detail">{row.tool.detail}</pre></details>}
              </div>;
            }
            if (row.kind === 'pending') return <div key={row.key} className="agent-bubble is-user is-pending">{row.text}</div>;
            return <div key={row.key} className="agent-partial">{row.text}</div>;
          })}

          {formal&&discussion?.id===process.mainDiscussionId&&process.analysis&&!process.userSelectedStrategyId&&<section className="agent-strategy-results"><h3>选定答复策略</h3><p>比较方向后，选择本次答复采用的策略。</p>{process.analysis.strategies.map((strategy,index)=><article className="agent-card" key={strategy.id}><h4>方案 {index+1} · {strategy.title}</h4><p>{strategy.summary}</p><details><summary>查看收益、风险与依据</summary><p>收益：{strategy.benefits}</p><p>风险：{strategy.risks}</p><p>依据：{strategy.basis}</p></details><button className="primary" disabled={busy||!!strategyBlock} onClick={()=>void run({type:'strategy',strategyId:strategy.id,startDraft:true})}>选定此策略并开始起草</button></article>)}</section>}
          {formal&&process.drafts.length>0&&<section className="agent-artifact-card"><b>{pendingDrafts.length?`有 ${pendingDrafts.length} 份稿件待采用`:'当前正式稿件'}</b><p>{pendingDrafts.length?'下一步：查看与比较稿件，采用需要的版本后，可选独立复核或直接核对定稿。':'下一步：核对修改文件并定稿；独立复核可按需进行。'}</p><button onClick={()=>openStage(2)}>查看与比较稿件</button>{!pendingDrafts.length&&adopted&&<button disabled={busy} onClick={()=>openStage(3)}>查看独立复核与待办</button>}</section>}
          {jobAlert && <div className="agent-tool is-error" role="alert">{jobAlert.text}</div>}
          {!discussion?.messages.length && !pendingText && !partial && !jobAlert && !jobs.length && !runningOnThis && <div className="agent-empty">还没有消息。可以先提问；只有已选并完成读取的材料才会作为依据。</div>}
        </div>
        {hasNewContent&&<button className="agent-jump-latest" onClick={()=>{followOutput.current=true;setHasNewContent(false);scroller.current?.scrollTo({top:scroller.current.scrollHeight,behavior:'smooth'});}}>回到最新内容 ↓</button>}
        {runningOnThis&&!editing&&<div className="agent-live-strip" role="status">正在工作 · {latestJob?.activity??'等待模型响应'}<button onClick={()=>{followOutput.current=false;const panel=scroller.current?.querySelector<HTMLElement>('.agent-run-status.is-running');if(panel){const detail=panel.querySelectorAll('details')[1];if(detail)detail.open=true;panel.scrollIntoView({block:'center',behavior:'smooth'});}}}>查看进展</button></div>}
        {queue.length>0&&<details className="agent-queue" open><summary>待发送（{queue.length}） · {busy?'当前任务完成后按序发送':'已保留，请继续发送'}</summary><div>{queue.map(q=><div key={q.id}><span>{q.text}</span>{q.error&&<small role="alert">{q.error}</small>}{queueEditing?.id===q.id?<><textarea aria-label="编辑待发送消息" value={queueEditing.text} onChange={e=>setQueueEditing({id:q.id,text:e.target.value})}/><button onClick={()=>void run({type:'queue',discussionId:discussion!.id,operation:'edit',id:q.id,text:queueEditing.text})}>保存</button><button onClick={()=>setQueueEditing(undefined)}>取消</button></>:<><button disabled={commandBusy} onClick={()=>setQueueEditing({id:q.id,text:q.text})}>编辑</button><button disabled={commandBusy} onClick={()=>void run({type:'queue',discussionId:discussion!.id,operation:'remove',id:q.id})}>移除</button>{!busy&&<button onClick={()=>void run({type:'queue',discussionId:discussion!.id,operation:'send',id:q.id})}>发送此条</button>}</>}</div>)}</div></details>}
        {editing && <div className="agent-edit-message"><label>编辑历史消息<textarea aria-label="编辑历史消息" value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })}/></label>
          <small>重发后保留原分支及文件。{view.busy ? '将先停止当前任务。' : ''}</small>
          <div><button disabled={commandBusy || !editing.text.trim()} onClick={() => void run({ type: 'conversation', discussionId: discussion!.id, operation: 'edit', messageId: editing.id, text: editing.text })}>{commandBusy ? '正在处理…' : view.busy ? '停止并重新发送' : '重新发送'}</button><button disabled={commandBusy} onClick={() => setEditing(undefined)}>取消编辑</button></div>
        </div>}
        {!editing && <form className="agent-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
          {visibleCommandError && <p className="agent-error" role="alert">{visibleCommandError}</p>}
          <label className="agent-send-mode">本次发送：{formal ? nextAction : '仅讨论（当前流程不可办理）'}<select aria-label="发送用途" disabled={commandBusy} value={!formal || discussionOnly ? 'discuss' : 'workflow'} onChange={e => setDiscussionOnly(e.target.value === 'discuss')}><option value="workflow" disabled={!formal}>办理当前步骤</option><option value="discuss">仅讨论</option></select></label>
          <textarea disabled={!!discussion?.archived} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}} placeholder={runningOnThis ? '补充要求将排队；当前后台不支持途中追加。' : discussion?.kind === 'review' ? '在独立复核中讨论…正式修改请回主讨论。' : '围绕本案提问…'} />
          <button className="primary" type="submit" disabled={commandBusy || !!discussion?.archived || !input.trim()}>{view.busy?'完成后发送':'发送'}</button>
          <button type="button" disabled={!view.busy||commandBusy} onClick={() => void run({ type: 'stop', runId: process.activeRunId ?? undefined })}><Square size={14}/>停止</button>
        </form>}
      </section>
      {stageOpen && <Modal title={showProgress ? '办理步骤' : '选用讨论材料'} onClose={() => setStageOpen(false)}>
      <div className="agent-stage">
        {showProgress && <nav className="agent-stage-tabs" aria-label="查看办理步骤">{STAGES.map((label, index) => <button type="button" key={label} aria-pressed={index === shownStage} onClick={() => setSelectedStage(index)}>{index + 1} · {label}</button>)}</nav>}
        {visibleCommandError && <p className="agent-error" role="alert">{visibleCommandError}</p>}
        {(!showProgress || shownStage === 0) && <>
        <PriorArtPanel item={item} profileKey={profileKey} onUpdated={()=>void api!.getCase(profileKey,caseId).then(v=>apply(v,gen.current))}/>

        <div className="agent-card">
          <h4>已选材料</h4>
          {selected.length ? <ul className="agent-selected-list">{selected.map(material => <li key={material.id}>
            {material.name}
            <small> · {material.role}{readIds.has(material.id) ? ' · 已读取材料' : ' · 尚未读取'}{material.ready ? '' : ' · 未就绪'}</small>
          </li>)}</ul> : <p>还没有已选材料。未指定时讨论不会假定已经读过文件。</p>}
          {formal && !canEditMaterials && <p className="muted">当前不能改正式答复用材料。</p>}
          {!formal && <p className="muted">材料讨论可勾选本案已列出的材料。实际能否读取由程序按案件范围决定，不会当作正式答复确认。</p>}
        </div>
        <div className="agent-card">
          <h4>{formal ? '确认材料' : '选用讨论材料'}</h4>
          <p>{formal ? '原件、当前通知和历史材料分开列出。未勾选的不送给模型。' : '勾选后用于本次材料讨论。等待官方或已定稿时也可选用，不会推进正式答复。'}</p>
          {[...groups.entries()].map(([group, items]) => <div key={group}>
            <small>{group}</small>
            <div className="agent-materials">{items.map(material => <label key={material.id}>
              <input type="checkbox" checked={!!picked[material.id]} disabled={!canEditMaterials} onChange={e => setPicked(current => ({ ...current, [material.id]: e.target.checked }))}/>
              <span>{material.name}<small> · {material.role}{readIds.has(material.id) ? ' · 已读取材料' : ''}{material.ready ? '' : ' · 未就绪'}</small></span>
            </label>)}</div>
          </div>)}
          <button type="button" disabled={!canEditMaterials} onClick={() => void run({ type: 'materials', selectedIds: Object.keys(picked).filter(id => picked[id]) })}>{formal ? '确认用于分析的材料' : '保存讨论用材料'}</button>
        </div>
        <div className="agent-card">
          <h4>原始申请文件</h4>
          <p className="muted">按案号或准确名称从原始申请文件库匹配；复制到本案后出现在上方材料列表，由你勾选后进入分析，文件库原件保留。</p>
          <button type="button" disabled={busy} onClick={() => void (async () => {
            try { setOriginals(await desktop!.findOriginals(caseId)); }
            catch (err) { setCommandError({ text: sanitizeAgentError((err as Error).message) }); }
          })()}>匹配原始申请文件</button>
        </div>
        </>}
        {showProgress && <>
          {shownStage === 0 && <>
          <div className="agent-card">
            <h4>{process.classification.status === 'classified' ? '已确认分类' : '自动核对结果'}</h4>
            <p>系统已根据当前流程和通知材料提出建议，请确认；不确定或冲突的字段会留空。</p>
            {view.classificationSuggestion?.evidence.length ? <ul>{view.classificationSuggestion.evidence.map((text, i) => <li key={i}>{text}</li>)}</ul> : null}
            {view.classificationSuggestion?.warnings.map((text, i) => <p className="agent-note" key={i}>{text}</p>)}
            <label className="field">专利类型<select value={patentType} onChange={e => setPatentType(e.target.value)} disabled={busy || !formal}><option value="">待核对</option><option>发明</option><option>实用新型</option></select></label>
            <label className="field">通知类型<select value={noticeCategory} onChange={e => setNoticeCategory(e.target.value)} disabled={busy || !formal}><option value="">待核对</option><option>审查意见通知书</option><option>补正通知书</option></select></label>
            <label className="field">轮次<input inputMode="numeric" value={round} onChange={e => setRound(e.target.value)} disabled={busy || !formal}/></label>
            <label className="field">补正基线<select value={basis} onChange={e => setBasis(e.target.value)} disabled={busy || !formal}><option value="original">原始申请</option><option value="other">其他文本</option>{[1, 2, 3, 4, 5].map(n => <option key={n} value={`round_${n}`}>第 {n} 轮文本</option>)}</select></label>
            <button type="button" disabled={busy || !formal} onClick={() => void run({
              type: 'classify',
              classification: {
                patentType: patentType === '发明' || patentType === '实用新型' ? patentType : '待核对',
                noticeCategory: noticeCategory === '审查意见通知书' || noticeCategory === '补正通知书' ? noticeCategory : '待核对',
                officeActionRound: Number(round) || undefined,
                correctionBasis: basis as 'original' | 'other' | `round_${number}`,
              },
            })}>确认分类</button>
          </div>
          <div className="agent-card">
            <h4>开始答复</h4><p className="agent-note">待处理案件将在开始时启动贝思兰德递交流程；确认进入本人办理后再分析，不会转交或提交官方。</p>
            <button className="primary" type="button" disabled={!!analysisBlock || busy} onClick={() => void run({ type: 'run', action: 'analysis', discussionId: mainId })}>开始答复</button>
            {analysisBlock && <p className="agent-note">{analysisBlock}</p>}
            {!process.analysis && process.stage !== 'materials' && <p className="agent-note">分类或材料已变化，需要重新分析。</p>}
          </div>
          </>}
          {shownStage === 1 && !process.analysis && <p className="agent-note">请先完成材料核对并开始答复，分析完成后可在此选择策略。</p>}
          {shownStage === 1 && process.analysis && <div className="agent-card">
            <h4>意见与策略</h4>
            {process.analysis.opinions.map(item => <p key={item.id}><b>{item.title}</b> {item.summary}<br/><small>{item.basis}</small></p>)}
            {process.analysis.strategies.map(item => <button key={item.id} type="button" className={`agent-strategy${process.userSelectedStrategyId === item.id ? ' is-picked' : ''}`} disabled={!!strategyBlock || busy} onClick={() => void run({ type: 'strategy', strategyId: item.id })}>
              <b>{item.title}</b>
              <span>{item.summary}</span>
              <small>收益：{item.benefits}</small>
              <small>风险：{item.risks}</small>
              <small>依据：{item.basis}</small>
            </button>)}
            {selectedStrategy(process) ? <p>已选定：{selectedStrategy(process)!.title}</p> : <p className="agent-note">必须由你明确选定策略后才能起草。</p>}
            <button type="button" disabled={!!draftBlock || busy} onClick={() => { setDiscussionId(mainId); void run({ type: 'run', action: 'draft', discussionId: mainId }); }}>起草</button>
            {draftBlock && <p className="agent-note">{draftBlock}</p>}
          </div>}
          {shownStage === 2 && !pendingDrafts.length && !adopted && <p className="agent-note">选定策略并起草后，稿件将在这里显示。</p>}
          {shownStage === 2 && (process.drafts.length > 0 || adopted) && <div className="agent-card">
            <h4>生成结果</h4>
            <p>待采用版本不会写入手工稿。修订始终在主讨论中进行。</p>
            {process.drafts.map(item => <button key={item.id} type="button" onClick={() => setPreviewId(item.id)}>{item.source === 'generated-revise' ? '修改稿' : '初稿'} · {new Date(item.at).toLocaleString('zh-CN')}</button>)}
            {preview && <>
              {adopted&&preview.id!==adopted.id&&<label className="checkbox"><input type="checkbox" checked={compare} onChange={e=>setCompare(e.target.checked)}/>与当前采用稿并排比较</label>}
              <div className={compare&&adopted&&preview.id!==adopted.id?'agent-version-compare':''}>{compare&&adopted&&preview.id!==adopted.id&&<section><h4>当前采用稿</h4><FormattedFormulaText className="agent-preview" text={adopted.text}/></section>}<section><h4>预览版本 · {new Date(preview.at).toLocaleString()}</h4><FormattedFormulaText className="agent-preview" text={preview.text}/></section></div>
              {preview.amendmentText && <p><b>修改文本</b><br/>{preview.amendmentText}</p>}{preview.applicationParts&&Object.entries(preview.applicationParts).map(([part,text])=><div key={part}><b>{part==='CLAIMS'?'权利要求书':part==='DESCRIPTION'?'说明书':part} · 完整正文</b><FormattedFormulaText className="agent-preview" text={text}/></div>)}
              {preview.amendmentBasis && <p><b>依据</b><br/>{preview.amendmentBasis}</p>}
              {preview.reviewNotes && <p><b>内部说明</b><br/>{preview.reviewNotes}</p>}
              {preview.adoptStatus==='adopted'&&preview.id!==adopted?.id&&<div>{restoreId===preview.id?<><p>恢复将建立一个新版本，并保留当前稿件；已有复核需要重新核对。</p><button disabled={busy || !formal} onClick={()=>void run({type:'restoreDraft',versionId:preview.id})}>确认恢复为当前稿</button><button onClick={()=>setRestoreId(undefined)}>取消</button></>:<button disabled={busy||!formal||!!process.finalized} onClick={()=>setRestoreId(preview.id)}>恢复此历史稿件</button>}</div>}
              {preview.adoptStatus === 'pending' && <button className="primary" type="button" disabled={busy || !formal} onClick={() => void run({ type: 'adopt', versionId: preview.id })}>采用此版本</button>}
            </>}
            {adopted && <>
              <button type="button" disabled={!!reviseBlock || busy} onClick={startRevise}>回主讨论修订</button>
              {reviseBlock && <p className="agent-note">{reviseBlock}</p>}
            </>}
          </div>}
          {shownStage === 3 && <div className="agent-card">
            <h4>独立复核（可选）</h4>
            <p>可按需进行独立复核，使用单独上下文。报告供参考，不阻止定稿或提交。正式修改请回主讨论。</p>
            <button type="button" disabled={!!reviewBlock || busy} onClick={() => void run({ type: 'run', action: 'review' })}>开始独立复核</button>
            {reviewBlock && <p className="agent-note">{reviewBlock}</p>}{adopted&&<button disabled={busy} onClick={()=>openStage(4)}>前往定稿（可跳过复核）</button>}
            {review && <>
              <p>{review.invalidated ? '该复核已过时。' : review.summary}</p>
              {review.issues.map(issue => <label key={issue.id} className="checkbox">
                <input type="checkbox" checked={issue.handled} disabled={busy || !formal || review.invalidated} onChange={e => void run({ type: 'issues', reviewId: review.id, issueIds: [issue.id], handled: e.target.checked })}/>
                <span><b>{issue.severity === 'error' ? '需修正' : issue.severity === 'warning' ? '需核对' : '提示'}</b> · {issue.finding}<small>依据：{issue.basis}</small><small>建议：{issue.suggestion}</small><small>{issue.handled ? '已确认处理' : '核对后勾选为已处理'}</small></span>
              </label>)}
              <p>{unhandledIssues(process).length ? `未处理 ${unhandledIssues(process).length} 项` : '问题已勾选处理'}</p>
              {adopted && <button type="button" disabled={!!reviseBlock || busy} onClick={startRevise}>回主讨论修订</button>}
            </>}
          </div>}
          {adopted&&[2,3,4].includes(shownStage)&&!process.finalized&&process.classification.noticeCategory==='补正通知书'&&<CorrectionContentsEditor draft={adopted} busy={busy || !formal} onSave={async items=>{const next=await api!.command(profileKey,caseId,{type:'correctionContents',items});apply(next,gen.current);}}/>}
          {adopted&&[2,3,4].includes(shownStage)&&!process.finalized&&<ApplicationPartsEditor draft={adopted} busy={busy || !formal} onSave={async parts=>{const next=await api!.command(profileKey,caseId,{type:'applicationParts',parts});apply(next,gen.current);}}/>}
          {shownStage === 4 && <div className="agent-card">
            <h4>用户定稿</h4>{adopted?.applicationParts===undefined&&<p>请先在上方核对本次修改文件；没有修改也要明确保存。</p>}
            <p>核对当前稿件后，由你确认定稿。独立复核可选；已有报告和未处理问题保留供参考。</p>
            <button className="primary" type="button" disabled={!!finalizeBlock || busy || adopted?.applicationParts===undefined || process.classification.noticeCategory==='补正通知书'&&!adopted?.correctionContents?.length} onClick={() => void run({ type: 'finalize' })}>定稿</button>
            {finalizeBlock && <p className="agent-note">{finalizeBlock}</p>}
            {process.finalized && <div className="finalized-status-block">
              <p><b>定稿已完成</b>：{process.classification.noticeCategory==='补正通知书'?'已保存补正字段和本次修改的申请文件。':process.finalized.word.generated?'已生成正式 Word 文件并归档。':'已保存历史定稿。'}{process.finalized.word.message ? ` ${process.finalized.word.message}` : ''}</p>
              <p className="agent-note">已自动生成正式文件，并在下方展开正文预览。核对无误后，可在左侧切换至【提交】页转交下一办理人。</p>
            </div>}
          </div>}
        </>}
        {(!formal || shownStage === 4) && <AgentArtifacts view={view} caseId={caseId}/>}
      </div></Modal>}
      {originals && <Modal title="原始申请文件匹配" onClose={() => setOriginals(null)}>
        {originals.length ? <div className="artifact-catalog">{originals.map(candidate => <button key={candidate.id} onClick={() => void (async () => {
          try {
            await desktop!.copyOriginal(caseId, candidate.id);
            setOriginals(null);
            apply(await api!.getCase(profileKey, caseId), gen.current);
          } catch (err) { setCommandError({ text: sanitizeAgentError((err as Error).message) }); }
        })()}><FileText/><span><b>{candidate.name}</b><small>复制到本案，保留文件库原件</small></span></button>)}</div> : <Note>未找到唯一案号或准确名称匹配。请检查设置中的原始申请文件库与文件命名。</Note>}
      </Modal>}
    </div>
  </div>;
}

export function AgentArtifacts({ view, caseId }: { view: AgentCaseView; caseId: string }) {
  const [selectedPreview, setSelectedPreview] = useState<AgentCaseView['artifacts'][number]>();
  const [error, setError] = useState('');
  const sortedArtifacts = [...view.artifacts].sort((a, b) => b.at.localeCompare(a.at) || a.title.localeCompare(b.title, 'zh-CN'));
  const preview = selectedPreview ?? sortedArtifacts.find(a => a.kind === 'final-word' || a.kind === 'final-correction-form') ?? sortedArtifacts[0];
  const draft = view.process.drafts.find(item => item.id === preview?.versionId)
    ?? (view.process.finalized ? view.process.drafts.find(item => item.id === view.process.finalized?.draftVersionId) : undefined)
    ?? view.process.drafts.at(-1);
  const text = preview ? artifactPreviewText(preview.kind, draft) : undefined;
  return <div className="agent-card">
    <h4>本案成果与定稿预览</h4>
    {!view.artifacts.length && <p>还没有生成成果。确认定稿后，按指定模板生成正式 Word；补正内容保存为表单字段记录，工作稿历史另行保留。</p>}
    {sortedArtifacts.map(item => <button className={`agent-artifact${preview?.id === item.id ? ' is-active' : ''}`} key={item.id} type="button" onClick={() => { setSelectedPreview(item); setError(''); }}>
      {item.title}<small>{item.relativePath.split('.').at(-1)?.toUpperCase()} · {new Date(item.at).toLocaleString('zh-CN')}{item.versionId ? ` · ${item.versionId === view.process.currentDraftVersionId ? '当前稿件' : '历史稿件'}` : ''}</small>
    </button>)}
    {preview && <div className="agent-artifact-preview">
      <div className="section-heading">
        <div>
          <h4>{preview.title}</h4>
          <p className="muted">{preview.relativePath}</p>
        </div>
        <button type="button" onClick={() => void desktop!.openMaterial(caseId, preview.relativePath).catch(err => setError(sanitizeAgentError(err.message)))}>打开此文件</button>
      </div>
      {text ? <div className="agent-preview">{text}</div> : <p className="muted">当前文件已保存至本案目录，可点击上方按钮在外部应用中打开。</p>}
    </div>}
    {error && <p className="agent-error" role="alert">{error}</p>}
    <button type="button" onClick={() => void desktop!.openCaseDirectory(caseId)}><FolderOpen size={14}/>打开案件目录</button>
  </div>;
}
