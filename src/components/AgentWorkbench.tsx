import { discussionCanDelete } from '../domain/agent.ts';
import {CorrectionContentsEditor} from './CorrectionContentsEditor.tsx';
import { ApplicationPartsEditor } from './ApplicationPartsEditor.tsx';
import { PriorArtPanel } from './PriorArt.tsx';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, PanelRight, Square } from 'lucide-react';
import type { Case } from '../domain/workflow.ts';
import type { AgentMessage, Discussion, MaterialEntry, ToolEvent } from '../domain/agent.ts';
import { activeJob, currentDraft, currentReview, selectedMaterials, selectedStrategy, unhandledIssues } from '../domain/agent.ts';
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
  sendAgentMessage,
  serverFormFingerprint,
  shouldAcceptAgentView,
  shouldInitLocalForm,
  toolEventLabel,
  type ServerFormFingerprint,
} from '../desktop.ts';
import { Modal, Note } from './Primitives.tsx';
import '../agent-workbench.css';

const STAGES = ['材料核对', '选定策略', '起草修改', '独立复核', '用户定稿'] as const;

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

function timeline(discussion: Discussion | undefined, partial?: string, pending?: string): Array<{ key: string; kind: 'message' | 'tool' | 'partial' | 'pending'; at: string; message?: AgentMessage; tool?: ToolEvent; text?: string }> {
  const rows: ReturnType<typeof timeline> = [];
  for (const message of discussion?.messages ?? []) rows.push({ key: 'm-' + message.id, kind: 'message', at: message.at, message });
  for (const tool of discussion?.toolEvents ?? []) rows.push({ key: 't-' + tool.id, kind: 'tool', at: tool.at, tool });
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
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<AgentCaseView | null>(null);
  const [error, setError] = useState('');
  const [discussionId, setDiscussionId] = useState<string>();
  const [showArchived,setShowArchived]=useState(false);
  const [input, setInput] = useState('');
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
    setPatentType('');
    setNoticeCategory('');
    setRound('1');
    setBasis('original');
    setPicked({});
    setStageOpen(false);
    setSelectedStage(undefined);
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
    return () => { gen.current++; unsub(); };
  }, [api, profileKey, caseId, processKey]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [view, pending, discussionId]);

  const run = async (command: AgentCommand) => {
    if (!api) return;
    const token = gen.current;
    const errorDiscussion = command.type === 'run' ? (command.discussionId ?? discussionId) : discussionId;
    setCommandError(null);
    try {
      const next = await api.command(profileKey, caseId, command);
      apply(next, token);
      if(command.type==='discussion')setDiscussionId(next.process.discussions.at(-1)?.id);
      if(command.type==='manageDiscussion')setDiscussionId(command.operation==='restore'?command.discussionId:next.process.mainDiscussionId);
      if (command.type === 'run' && command.action !== 'discuss') { setStageOpen(false); setSelectedStage(undefined); }
      if (command.type === 'adopt') setSelectedStage(3);
      if (command.type === 'finalize') setSelectedStage(4);
    } catch (err) {
      if (token !== gen.current) return;
      setCommandError({ text: sanitizeAgentError((err as Error).message), discussionId: errorDiscussion });
    }
  };

  const send = async () => {
    if (!api || !input.trim() || view?.busy) return;
    const text = input;
    const token = gen.current;
    const sentDiscussion = discussionId;
    setInput('');
    setPending(text);
    setPendingDiscussionId(sentDiscussion);
    setCommandError(null);
    const result = await sendAgentMessage(api, profileKey, caseId, text, sentDiscussion);
    if (token !== gen.current) return;
    setPending('');
    setPendingDiscussionId(undefined);
    if (result.ok) apply(result.view, token);
    else {
      setInput(result.restore);
      setCommandError({ text: sanitizeAgentError(result.error), discussionId: sentDiscussion });
    }
  };

  if (!api) return <Note>当前程序尚未连接本案对话。对话、分析和起草需要在桌面程序中使用。</Note>;
  if (!view && error) return <p className="inline-warning" role="alert">{error}</p>;
  if (!view || view.processKey !== processKey) return <div className="agent-empty">正在读取本案对话…</div>;

  const process = view.process;
  const discussion = process.discussions.find(item => item.id === discussionId) ?? process.discussions.find(item => item.id === process.mainDiscussionId);
  const busy = view.busy;
  const current = stageIndex(view);
  const shownStage = selectedStage ?? current;
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
  const jobAlert = discussionJobAlert(latestDiscussionJob(process, discussion?.id));
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

  return <div className={`agent-workbench${stageOpen ? ' is-stage-open' : ''}`}>
    <header className="agent-workbench-head">
      <div>
        <h3>{formal ? (process.classification.noticeCategory==='补正通知书'?'本案对话 · 补正办理':'本案对话 · 答复办理') : '本案对话'}</h3>
        <nav className="agent-stage-path" aria-label="答复阶段">{formal && STAGES.map((label, index) => <button type="button" key={label} className={index === current ? 'is-current' : ''} onClick={() => openStage(index)}>{index + 1} · {label}</button>)}</nav>
        {!formal && <p>{writeIncomplete ? '完整撰写申请文件尚未完成，当前只开放围绕本案材料的讨论。' : reviewIncomplete ? '独立导入审查尚未完成，当前只开放围绕本案材料的讨论。' : '本页用于材料讨论，正式办理请进入本案对应业务。'}</p>}
      </div>
      <div className="agent-head-actions">
        <p>本次任务：{modelSnapshotLabel(view)}</p>
        <p><a href="#/settings/model">打开模型设置</a> · 新设置只影响下一次任务</p>
        <button type="button" className={stageOpen ? 'primary' : ''} onClick={() => { setSelectedStage(undefined); setStageOpen(open => !open); }}>
          <PanelRight size={14}/>{formal ? '办理步骤' : '选用材料'}
        </button>
      </div>
    </header>
    <div className="agent-workbench-body">
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
      <section className="agent-thread">
        <div className="agent-messages" ref={scroller}>
          {discussion?.archived&&<p className="note">此讨论已归档，恢复后可以继续发送消息。</p>}
          {timeline(discussion, partial, pendingText).map(row => {
            if (row.kind === 'message' && row.message) {
              return <div key={row.key} className={`agent-bubble is-${row.message.role}`}>{row.message.text}</div>;
            }
            if (row.kind === 'tool' && row.tool) {
              return <div key={row.key} className={`agent-tool${row.tool.status === 'error' ? ' is-error' : row.tool.status === 'ok' ? ' is-ok' : ''}`}>
                {toolEventLabel(row.tool)} {row.tool.filename}{row.tool.readRange ? ` · ${row.tool.readRange}` : ''}{row.tool.detail&&<details><summary>查看调用</summary><pre className="tool-command-detail">{row.tool.detail}</pre></details>}
              </div>;
            }
            if (row.kind === 'pending') return <div key={row.key} className="agent-bubble is-user is-pending">{row.text}</div>;
            return <div key={row.key} className="agent-partial">{row.text}</div>;
          })}
          {formal && process.analysis && <button type="button" className="agent-result-link" onClick={() => openStage(current)}>{current === 1 ? '查看意见与策略' : current === 2 ? '查看稿件与修改' : current === 3 ? '查看独立复核' : '查看办理结果'}</button>}
          {jobAlert && <div className="agent-tool is-error" role="alert">{jobAlert.text}</div>}
          {!discussion?.messages.length && !pendingText && !partial && !jobAlert && <div className="agent-empty">还没有消息。可以先提问；只有已选并完成读取的材料才会作为依据。</div>}
        </div>
        <form className="agent-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
          {visibleCommandError && <p className="agent-error" role="alert">{visibleCommandError}</p>}
          <textarea disabled={!!discussion?.archived} value={input} onChange={e => setInput(e.target.value)} placeholder={runningOnThis ? '任务进行中，仍可查看历史。' : discussion?.kind === 'review' ? '在独立复核中讨论…正式修改请回主讨论。' : '围绕本案提问…'} />
          <button className="primary" type="submit" disabled={busy || !!discussion?.archived || !input.trim()}>发送</button>
          <button type="button" disabled={!busy} onClick={() => void run({ type: 'stop', runId: process.activeRunId ?? undefined })}><Square size={14}/>停止</button>
        </form>
      </section>
      {stageOpen && <Modal title={formal ? '办理步骤' : '选用讨论材料'} onClose={() => setStageOpen(false)}>
      <div className="agent-stage">
        {formal && <nav className="agent-stage-tabs" aria-label="查看办理步骤">{STAGES.map((label, index) => <button type="button" key={label} aria-pressed={index === shownStage} onClick={() => setSelectedStage(index)}>{index + 1} · {label}</button>)}</nav>}
        {visibleCommandError && <p className="agent-error" role="alert">{visibleCommandError}</p>}
        {(!formal || shownStage === 0) && <>
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
        </>}
        {formal && <>
          {shownStage === 0 && <>
          <div className="agent-card">
            <h4>{process.classification.status === 'classified' ? '已确认分类' : '自动核对结果'}</h4>
            <p>系统已根据当前流程和通知材料提出建议，请确认；不确定或冲突的字段会留空。</p>
            {view.classificationSuggestion?.evidence.length ? <ul>{view.classificationSuggestion.evidence.map((text, i) => <li key={i}>{text}</li>)}</ul> : null}
            {view.classificationSuggestion?.warnings.map((text, i) => <p className="agent-note" key={i}>{text}</p>)}
            <label className="field">专利类型<select value={patentType} onChange={e => setPatentType(e.target.value)} disabled={busy}><option value="">待核对</option><option>发明</option><option>实用新型</option></select></label>
            <label className="field">通知类型<select value={noticeCategory} onChange={e => setNoticeCategory(e.target.value)} disabled={busy}><option value="">待核对</option><option>审查意见通知书</option><option>补正通知书</option></select></label>
            <label className="field">轮次<input inputMode="numeric" value={round} onChange={e => setRound(e.target.value)} disabled={busy}/></label>
            <label className="field">补正基线<select value={basis} onChange={e => setBasis(e.target.value)} disabled={busy}><option value="original">原始申请</option><option value="other">其他文本</option>{[1, 2, 3, 4, 5].map(n => <option key={n} value={`round_${n}`}>第 {n} 轮文本</option>)}</select></label>
            <button type="button" disabled={busy} onClick={() => void run({
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
            <h4>开始答复</h4>
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
            {selectedStrategy(process) ? <p>已选定：{selectedStrategy(process)!.title}</p> : <p className="agent-note">必须由你点选策略后才能起草。</p>}
            <button type="button" disabled={!!draftBlock || busy} onClick={() => { setDiscussionId(mainId); void run({ type: 'run', action: 'draft', discussionId: mainId }); }}>起草</button>
            {draftBlock && <p className="agent-note">{draftBlock}</p>}
          </div>}
          {shownStage === 2 && !pendingDrafts.length && !adopted && <p className="agent-note">选定策略并起草后，稿件将在这里显示。</p>}
          {shownStage === 2 && (pendingDrafts.length > 0 || adopted) && <div className="agent-card">
            <h4>生成结果</h4>
            <p>待采用版本不会写入手工稿。修订始终在主讨论中进行。</p>
            {pendingDrafts.map(item => <button key={item.id} type="button" onClick={() => setPreviewId(item.id)}>{item.source === 'generated-revise' ? '修改稿' : '初稿'} · {new Date(item.at).toLocaleString('zh-CN')}</button>)}
            {preview && <>
              <div className="agent-preview">{preview.text}</div>
              {preview.amendmentText && <p><b>修改文本</b><br/>{preview.amendmentText}</p>}{preview.applicationParts&&Object.entries(preview.applicationParts).map(([part,text])=><div key={part}><b>{part==='CLAIMS'?'权利要求书':part==='DESCRIPTION'?'说明书':part} · 完整正文</b><pre className="agent-preview">{text}</pre></div>)}
              {preview.amendmentBasis && <p><b>依据</b><br/>{preview.amendmentBasis}</p>}
              {preview.reviewNotes && <p><b>内部说明</b><br/>{preview.reviewNotes}</p>}
              {preview.adoptStatus === 'pending' && <button className="primary" type="button" disabled={busy} onClick={() => void run({ type: 'adopt', versionId: preview.id })}>采用此版本</button>}
            </>}
            {adopted && <>
              <button type="button" disabled={!!reviseBlock || busy} onClick={startRevise}>回主讨论修订</button>
              {reviseBlock && <p className="agent-note">{reviseBlock}</p>}
            </>}
          </div>}
          {shownStage === 3 && <div className="agent-card">
            <h4>独立复核</h4>
            <p>复核使用单独上下文。正式修改请回到主讨论。</p>
            <button type="button" disabled={!!reviewBlock || busy} onClick={() => void run({ type: 'run', action: 'review' })}>开始独立复核</button>
            {reviewBlock && <p className="agent-note">{reviewBlock}</p>}
            {review && <>
              <p>{review.invalidated ? '该复核已过时。' : review.summary}</p>
              {review.issues.map(issue => <label key={issue.id} className="checkbox">
                <input type="checkbox" checked={issue.handled} disabled={busy || review.invalidated} onChange={e => void run({ type: 'issues', reviewId: review.id, issueIds: [issue.id], handled: e.target.checked })}/>
                <span><b>{issue.severity === 'error' ? '需修正' : issue.severity === 'warning' ? '需核对' : '提示'}</b> · {issue.finding}<small>依据：{issue.basis}</small><small>建议：{issue.suggestion}</small><small>{issue.handled ? '已确认处理' : '核对后勾选为已处理'}</small></span>
              </label>)}
              <p>{unhandledIssues(process).length ? `未处理 ${unhandledIssues(process).length} 项` : '问题已勾选处理'}</p>
              {adopted && <button type="button" disabled={!!reviseBlock || busy} onClick={startRevise}>回主讨论修订</button>}
            </>}
          </div>}
          {adopted&&[2,3,4].includes(shownStage)&&!process.finalized&&process.classification.noticeCategory==='补正通知书'&&<CorrectionContentsEditor draft={adopted} busy={busy} onSave={async items=>{const next=await api!.command(profileKey,caseId,{type:'correctionContents',items});apply(next,gen.current);}}/>}
          {adopted&&[2,3,4].includes(shownStage)&&!process.finalized&&<ApplicationPartsEditor draft={adopted} busy={busy} onSave={async parts=>{const next=await api!.command(profileKey,caseId,{type:'applicationParts',parts});apply(next,gen.current);}}/>}
          {shownStage === 4 && <div className="agent-card">
            <h4>用户定稿</h4>{adopted?.applicationParts===undefined&&<p>请先在上方核对本次修改文件；没有修改也要明确保存。</p>}
            <p>核对当前稿件及复核结果后，由你确认定稿。</p>
            <button className="primary" type="button" disabled={!!finalizeBlock || busy || adopted?.applicationParts===undefined || process.classification.noticeCategory==='补正通知书'&&!adopted?.correctionContents?.length} onClick={() => void run({ type: 'finalize' })}>定稿</button>
            {finalizeBlock && <p className="agent-note">{finalizeBlock}</p>}
            {process.finalized && <p>{process.classification.noticeCategory==='补正通知书'?'已保存补正字段和本次修改的申请文件。':process.finalized.word.generated?'已生成正式 Word 文件并归档。':'已保存历史定稿。'}{process.finalized.word.message ? ` ${process.finalized.word.message}` : ''}</p>}
          </div>}
        </>}
        {(!formal || shownStage === 4) && <AgentArtifacts view={view} caseId={caseId}/>}
      </div></Modal>}
    </div>
  </div>;
}

export function AgentArtifacts({ view, caseId }: { view: AgentCaseView; caseId: string }) {
  const [preview, setPreview] = useState<AgentCaseView['artifacts'][number]>();
  const [error, setError] = useState('');
  const draft = view.process.drafts.find(item => item.id === preview?.versionId);
  const text = preview?.kind === 'body' || preview?.kind === 'final-body' ? draft?.text
    : preview?.kind === 'amendmentText' || preview?.kind === 'final-amendment' ? draft?.amendmentText
    : preview?.kind === 'amendmentBasis' || preview?.kind === 'final-basis' ? draft?.amendmentBasis
    : preview?.kind === 'reviewNotes' || preview?.kind === 'final-review-notes' ? draft?.reviewNotes
    : preview?.kind === 'final-correction-form' ? draft?.correctionContents?.map((row,i)=>`条目 ${i+1}\n文件名称：${row.FileName}\n具体位置：${row.PositionInFile}\n补正前：${row.CorrectionBefore}\n补正后：${row.CorrectionAfter}`).join('\n\n') : undefined;
  return <div className="agent-card">
    <h4>本案成果</h4>
    {!view.artifacts.length && <p>还没有生成成果。确认定稿后，按指定模板生成正式 Word；补正内容保存为表单字段记录，工作稿历史另行保留。</p>}
    {[...view.artifacts].sort((a, b) => b.at.localeCompare(a.at) || a.title.localeCompare(b.title, 'zh-CN')).map(item => <button className="agent-artifact" key={item.id} type="button" onClick={() => { setPreview(item); setError(''); }}>
      {item.title}<small>{item.relativePath.split('.').at(-1)?.toUpperCase()} · {new Date(item.at).toLocaleString('zh-CN')}{item.versionId ? ` · ${item.versionId === view.process.currentDraftVersionId ? '当前稿件' : '历史稿件'}` : ''}</small>
    </button>)}
    {preview && <div className="agent-artifact-preview"><h4>{preview.title}</h4><p className="muted">{preview.relativePath}</p>{text && <div className="agent-preview">{text}</div>}<button type="button" onClick={() => void desktop!.openMaterial(caseId, preview.relativePath).catch(err => setError(sanitizeAgentError(err.message)))}>打开此文件</button></div>}
    {error && <p className="agent-error" role="alert">{error}</p>}
    <button type="button" onClick={() => void desktop!.openCaseDirectory(caseId)}><FolderOpen size={14}/>打开案件目录</button>
  </div>;
}
