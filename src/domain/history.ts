import type { AgentProcessState } from './agent.ts';
import type { HistoryRecord, HistoryTarget } from './lifecycle.ts';
import type { CaseHistoryView } from './case-view.ts';
import type { ProfessionalHistoryView, ReviewSource } from '../professional-api.ts';
import type { TransferView } from '../transfer-api.ts';

function historyDate(value?: string): string {
  if (!value) return '时间未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

export function agentHistoryRecords(process: AgentProcessState): HistoryRecord[] {
  const stateLabel = (state: string) => ({ running: '运行中', stopped: '已停止', failed: '失败', completed: '已完成' } as Record<string, string>)[state] ?? state;
  const actionLabel = (action: string) => ({ analysis: '意见分析', discuss: '讨论', draft: '起草', revise: '修改起草', review: '独立复核' } as Record<string, string>)[action] ?? action;
  const records: HistoryRecord[] = [];
  const prefix = `agent-${encodeURIComponent(process.scope.processKey)}-`;
  const seen = new Set<string>();
  const add = (record: HistoryRecord) => {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    records.push(record);
  };
  const id = (kind: string, value: string) => `${prefix}${kind}-${value}`;
  const discussionNames = new Map(process.discussions.map(discussion => [discussion.id, discussion.title]));
  const seenMessages = new Set<string>();
  for (const discussion of process.discussions) {
    for (const message of discussion.messages) {
      if (seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);
      add({
        id: id('message', message.id),
        title: `${discussion.title} · ${message.role === 'user' ? '用户消息' : 'Agent 回复'}`,
        detail: `${historyDate(message.at)} · ${message.incomplete ? '未完成输出 · 只读' : '只读'}`,
        text: message.text,
        target: { tab: 'discussion', processId: process.scope.processKey, discussionId: discussion.id, historyId: message.id },
      });
    }
    for (const branch of discussion.branches ?? []) {
      for (const message of branch.messages) {
        if (seenMessages.has(message.id)) continue;
        seenMessages.add(message.id);
        add({
          id: id('branch-message', message.id),
          title: `${discussion.title} · ${branch.title} · ${message.role === 'user' ? '用户消息' : 'Agent 回复'}`,
          detail: `${historyDate(message.at)} · 历史分支 · 只读`,
          text: message.text,
          target: { tab: 'discussion', processId: process.scope.processKey, discussionId: discussion.id, historyId: message.id },
        });
      }
    }
    for (const queued of discussion.queuedMessages ?? []) {
      add({
        id: id('queued', queued.id),
        title: `${discussion.title} · 排队消息`,
        detail: `${historyDate(queued.at)} · ${queued.error ? '跳过失败项' : '未完成任务'} · 只读`,
        text: [queued.text, queued.error ? `处理结果：${queued.error}` : '该消息尚未形成完成回复。'].join('\n\n'),
        target: { tab: 'discussion', processId: process.scope.processKey, discussionId: discussion.id, historyId: queued.id },
      });
    }
  }
  for (const job of process.jobs) {
    const tools = process.discussions.flatMap(discussion => discussion.toolEvents)
      .filter(event => event.runId === job.runId)
      .map(event => `${event.toolKind ?? event.filename} · ${event.status}${event.detail ? ` · ${event.detail}` : ''}`);
    add({
      id: id('job', job.runId),
      title: `${actionLabel(job.action)}任务${discussionNames.has(job.discussionId) ? ` · ${discussionNames.get(job.discussionId)}` : ''}`,
      detail: `${historyDate(job.startedAt)} · ${stateLabel(job.state)} · 只读`,
      text: [
        job.userMessage ? `用户要求：${job.userMessage}` : '',
        job.partialText ? `已输出内容：\n${job.partialText}` : '',
        job.thinkingText ? `思考记录：\n${job.thinkingText}` : '',
        job.activity ? `最近动作：${job.activity}` : '',
        tools.length ? `工具记录：\n${tools.join('\n')}` : '',
        job.error ? `任务结果：${job.error}` : `任务状态：${stateLabel(job.state)}`,
      ].filter(Boolean).join('\n\n'),
      target: { tab: 'discussion', processId: process.scope.processKey, discussionId: job.discussionId, runId: job.runId },
    });
  }
  const analyses = [...new Map([...process.analysisHistory, ...(process.analysis ? [process.analysis] : [])].map(analysis => [analysis.runId, analysis])).values()];
  for (const analysis of analyses) {
    add({
      id: id('analysis', analysis.runId),
      title: '意见分析与策略',
      detail: `${historyDate(analysis.at)} · ${analysis.runId === process.analysis?.runId ? '当前分析' : '历史分析'} · 只读`,
      text: [
        '意见分析',
        ...analysis.opinions.map((opinion, index) => `${index + 1}. ${opinion.title}\n${opinion.summary}\n依据：${opinion.basis}`),
        '策略候选',
        ...analysis.strategies.map((strategy, index) => `${index + 1}. ${strategy.title}\n${strategy.summary}\n优点：${strategy.benefits}\n风险：${strategy.risks}\n依据：${strategy.basis}`),
      ].join('\n\n'),
      target: { tab: 'discussion', processId: process.scope.processKey, runId: analysis.runId },
    });
  }
  for (const draft of process.drafts) {
    add({
      id: id('draft', draft.id),
      title: `答复稿件 · ${draft.adoptStatus === 'adopted' ? '已采用' : draft.adoptStatus === 'pending' ? '待采用' : draft.adoptStatus === 'conflict' ? '冲突' : '未采用'}`,
      detail: `${historyDate(draft.at)} · ${draft.source === 'user' ? '人工版本' : 'Agent 版本'} · 只读`,
      text: [
        draft.text,
        draft.applicationParts ? `申请文件部分：\n${JSON.stringify(draft.applicationParts, null, 2)}` : '',
        draft.amendmentText ? `建议修改文本：\n${draft.amendmentText}` : '',
        draft.amendmentBasis ? `修改依据：\n${draft.amendmentBasis}` : '',
        draft.reviewNotes ? `复核说明：\n${draft.reviewNotes}` : '',
        draft.correctionContents?.length ? `补正条目：\n${JSON.stringify(draft.correctionContents, null, 2)}` : '',
      ].filter(Boolean).join('\n\n'),
      target: { tab: 'discussion', processId: process.scope.processKey, historyId: draft.id },
    });
  }
  for (const review of process.reviews) {
    add({
      id: id('review', review.id),
      title: '答复独立复核',
      detail: `${historyDate(review.at)} · ${review.invalidated ? '已失效' : '只读'}`,
      text: [
        review.summary,
        ...review.issues.map((issue, index) => `${index + 1}. ${issue.finding}\n依据：${issue.basis}\n建议：${issue.suggestion}\n处理：${issue.handled ? '已记录处理' : '未记录处理'}`),
      ].join('\n\n'),
      target: { tab: 'discussion', processId: process.scope.processKey, historyId: review.id },
    });
  }
  for (const final of [...process.finalizeHistory, ...(process.finalized ? [process.finalized] : [])]) {
    add({
      id: id('final', `${final.draftVersionId}-${final.at}`),
      title: '答复定稿',
      detail: `${historyDate(final.at)} · ${final.word.status === 'generated' ? '已生成 Word' : final.word.message} · 只读`,
      text: final.text,
      target: { tab: 'outputs', processId: process.scope.processKey, historyId: `${final.draftVersionId}-${final.at}` },
    });
  }
  return records;
}

export function caseHistoryRecords(view: CaseHistoryView): HistoryRecord[] {
  const current = view.stage.current;
  const editable = view.stage.editable;
  const records: HistoryRecord[] = [];
  for (const round of view.manuscripts.replyRounds) {
    const discussion = round.discussions.flatMap(item => item.messages.map(message => message.text)).join('\n\n');
    const body = round.final?.text || round.draft || '';
    records.push({
      id: `round-${round.id}`,
      title: round.name,
      detail: '历史轮次 · 只读',
      text: [round.name, body || '该轮次未保存正文', discussion].filter(Boolean).join('\n\n'),
      target: { tab: 'history', roundId: round.id, historyId: round.id },
    });
    for(const version of round.versions)records.push({
      id:`round-${round.id}-version-${version.id}`,title:`${round.name} · ${version.label}`,
      detail:`${historyDate(version.at)} · 只读`,text:version.text,
      target:{tab:'history',roundId:round.id,historyId:version.id},
    });
    for(const final of round.finalHistory)records.push({
      id:`round-${round.id}-final-${final.versionId}-${final.at}`,title:`${round.name} · 历史定稿`,
      detail:`${historyDate(final.at)} · 只读`,text:final.text,
      target:{tab:'history',roundId:round.id,historyId:`${final.versionId}-${final.at}`},
    });
  }
  for (const [index, version] of view.manuscripts.localVersions.entries()) {
    records.push({
      id: version.id,
      title: `人工保存版本 ${index + 1}`,
      detail: `${new Date(version.at).toLocaleString('zh-CN')} · 只读`,
      text: version.text,
      target: { tab: 'history', processId: version.processId, historyId: version.id },
    });
  }
  const draft = view.manuscripts.localDraft;
  if (draft?.trim() && !editable) {
    const duplicate = view.manuscripts.localVersions.some(version => version.text === draft)
      || view.manuscripts.replyRounds.some(round => round.draft === draft || round.final?.text === draft);
    if (!duplicate) records.push({ id: 'current-draft', title: '当前稿件', detail: '只读', text: draft, target: { tab: 'history', historyId: 'current-draft' } });
  }
  if (view.manuscripts.design.writing.disclosure && current.kind !== 'write') {
    const text = view.manuscripts.design.writing.documents.map(document => `${document.title}\n${document.text}`).join('\n\n')
      || view.manuscripts.design.writing.disclosure;
    records.push({ id: 'writing', title: '历史撰写内容', detail: '只读', text, target: { tab: 'history', historyId: 'writing' } });
  }
  for(const version of view.manuscripts.design.writing.versions)records.push({
    id:`writing-${version.id}`,title:'撰写保存版本',detail:`${historyDate(version.at)} · 只读`,
    text:version.documents.map(d=>`${d.title}\n${d.text}`).join('\n\n'),
    target:{tab:'history',historyId:`writing-${version.id}`},
  });
  for(const review of [...view.manuscripts.design.reviewHistory,...(view.manuscripts.design.review?[view.manuscripts.design.review]:[])])records.push({
    id:`design-review-${review.id}`,title:'历史独立审查',detail:`${historyDate(review.at)} · ${review.versionLabel} · 只读`,
    text:review.issues.map(i=>`${i.title}\n${i.quote}\n${i.suggestion}\n${i.disposition} ${i.comment}`).join('\n\n')||'未记录问题。',
    target:{tab:'history',historyId:`design-review-${review.id}`},
  });
  for(const receipt of view.transfer.localRecords)records.push({
    id:`receipt-${receipt.id}`,title:'内部流转回执',detail:`${historyDate(receipt.at)} · 只读`,
    text:[receipt.process,receipt.receiver,receipt.files.join('\n'),receipt.note].join('\n\n'),
    target:{tab:'history',historyId:`receipt-${receipt.id}`},
  });
  return records;
}

export function sourceHistoryRecord(source:ReviewSource):HistoryRecord{
  return {
    id: `source-${encodeURIComponent(source.processKey)}-${source.id}`, title:source.title,
    detail:`${source.business}成果 · ${historyDate(source.at)} · 只读`,
    text:[source.title,source.text,
      source.applicationParts?`申请文件部分：\n${JSON.stringify(source.applicationParts,null,2)}`:'',
      source.amendmentText,source.amendmentBasis?`修改依据：\n${source.amendmentBasis}`:'',
      source.correctionContents?JSON.stringify(source.correctionContents):'',source.files.map(f=>f.name).join('\n')].filter(Boolean).join('\n\n'),
    target:{tab:'review',processId:source.processKey,sourceId:source.id},
    files:source.files.map(file=>({kind:'professional',caseId:source.caseId,processId:source.processKey,name:file.name,relativePath:file.relativePath})),
  };
}

export function professionalHistoryRecords(view:ProfessionalHistoryView):HistoryRecord[]{
  const sources=view.sources.filter(source=>source.caseId===view.caseId);
  const records=sources.map(sourceHistoryRecord);
  const reports=sources.flatMap(source=>(source.reports??[]).filter(job=>
    job.kind==='review'&&job.caseId===source.caseId&&job.processKey===source.processKey&&job.sourceId===source.id));
  // A nested snapshot cannot replace a newer task from the canonical job list.
  const jobs=new Map([...reports,...view.jobs.filter(job=>job.caseId===view.caseId)].map(job=>[JSON.stringify([job.processKey,job.id]),job]));
  for(const job of jobs.values())records.push({
    id:`professional-job-${encodeURIComponent(job.processKey)}-${job.id}`,
    title:job.kind==='review'?'独立审查任务':'专利撰写任务',
    detail:`${historyDate(job.at)} · ${{completed:'已完成',failed:'失败',stopped:'已停止',running:'运行中'}[job.state]} · 只读`,
    text:[job.text,job.error,job.documents?JSON.stringify(job.documents,null,2):'',job.tools.map(t=>`${t.name} · ${t.status}${t.detail?` · ${t.detail}`:''}`).join('\n')].filter(Boolean).join('\n\n')||'该任务未保存正文。',
    target:{tab:job.kind==='review'?'review':'write',processId:job.processKey,sourceId:job.sourceId,runId:job.id},
    files:job.artifactPath?[{kind:'professional',caseId:job.caseId,processId:job.processKey,name:job.artifactPath.split(/[\\/]/).at(-1)!,relativePath:job.artifactPath}]:[],
  });
  return records;
}

export function transferHistoryRecords(views:TransferView[]):HistoryRecord[]{
  return views.map(view=>({
    id:`transfer-${view.processId}-${view.id}`,title:`${view.processName} · 内部流转`,
    detail:`${historyDate(view.at)} · ${{draft:'草稿',saved:'已保存',uncertain:'待核验',submitted:'已内部转交',superseded:'历史方案'}[view.phase]} · 只读`,
    text:[`案件：${view.caseNumber} ${view.caseTitle}`,`流程：${view.processName}`,
      `接收节点：${view.review.stepId || '未选择'}；接收人：${view.review.userId || '未选择'}`,
      view.submissionAttempted?'曾发出内部转交请求，结果以回读记录为准。':'',
      view.files.map(f=>`${f.name} · ${f.hash}`).join('\n'),view.review.remark,
      JSON.stringify(view.review.form,null,2),view.results.join('\n'),view.error].filter(Boolean).join('\n\n'),
    target:{tab:'submit',processId:view.processId,historyId:view.id},
  }));
}

export function selectHistoryRecords(records:HistoryRecord[],target:HistoryTarget):HistoryRecord[]{
  const keys=['processId','roundId','discussionId','sourceId','runId','historyId'] as const;
  return records.filter(record=>keys.every(key=>!target[key]
    || key==='historyId'&&(record.id===target.historyId||record.target?.historyId===target.historyId)
    || record.target?.[key]===target[key]));
}
