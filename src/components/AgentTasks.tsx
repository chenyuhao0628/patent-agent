import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { CaseTab } from './CaseSpace.tsx';
import type { CaseNavigationTarget } from '../app/navigation.ts';
import { desktop } from '../desktop.ts';
import type { AgentTaskView } from '../desktop.ts';
import { Empty, ErrorState, LoadingState } from './Primitives.tsx';
import '../agent-tasks.css';

const LABELS: Record<string, string> = {
  running: '进行中',
  stopped: '已停止',
  failed: '失败',
  completed: '已完成',
  analysis: '意见分析',
  discuss: '讨论',
  draft: '起草',
  revise: '修订',
  review: '独立复核',
};

export function AgentTasks({
  profileKey,
  open,
}: {
  profileKey: string;
  open: (caseId: string, tab: CaseTab, target?:CaseNavigationTarget) => void;
}) {
  const gen = useRef(0);
  const [tasks, setTasks] = useState<AgentTaskView[] | null>(null);
  const [error, setError] = useState('');
  const api = desktop?.agent;

  const load = async (token: number) => {
    if (!api) return;
    try {
      const next = await api.listTasks(profileKey);
      if (token !== gen.current) return;
      setTasks(next);
      setError('');
    } catch (err) {
      if (token !== gen.current) return;
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    const token = ++gen.current;
    setTasks(null);
    setError('');
    if (!api) return;
    void load(token);
    const unsub = api.onState(view => {
      if (view.profileKey !== profileKey) return;
      void load(gen.current);
    });
    const professionalUnsub=desktop!.professional.onState(key=>{if(key===profileKey)void load(gen.current);});
    return () => { gen.current++; unsub();professionalUnsub(); };
  }, [api, profileKey]);

  if (!api) return <div className="page-pad"><h1>工作任务</h1><p>当前程序尚未连接任务列表。请使用桌面程序查看进行中的任务。</p></div>;
  if (error && !tasks) return <div className="page-pad"><h1>工作任务</h1><ErrorState message={error}/></div>;
  if (!tasks) return <div className="page-pad"><h1>工作任务</h1><LoadingState>正在读取工作任务…</LoadingState></div>;
  const shown = [...(tasks ?? [])].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.runId.localeCompare(a.runId));
  return <div className="page-pad">
    <div className="page-heading"><div><h1>工作任务</h1><p>按任务开始时间从新到旧排列，可打开所属案件或讨论。</p></div></div>
    {error && <p className="inline-warning" role="alert">{error}</p>}
    {shown.length ? <div className="agent-task-list">{shown.map(task => <div className="agent-task" key={task.runId}>
      <div>
        <h3>{task.professionalKind==='writing'?'专利撰写':task.professionalKind==='review'?'个人独立审查':LABELS[task.action] ?? task.action} · {LABELS[task.state] ?? task.state}</h3>
        <p>{task.caseTitle} · {task.caseNumber}</p>
        <small>{new Date(task.startedAt).toLocaleString('zh-CN')}{task.endedAt ? ` → ${new Date(task.endedAt).toLocaleString('zh-CN')}` : ''}{task.error ? ` · ${task.error}` : ''}</small>
      </div>
      <div className="agent-task-actions">
        <button type="button" onClick={() => open(task.caseId, task.professionalKind==='writing'?'write':task.professionalKind==='review'?'review':'discussion',{processId:task.processKey,runId:task.runId,...(!task.professionalKind?{discussionId:task.discussionId}:{})})}>查看此任务<ArrowUpRight size={15}/></button>
        <button type="button" onClick={() => open(task.caseId, 'overview')}>打开案件概览<ArrowUpRight size={15}/></button>
      </div>
    </div>)}</div> : <Empty title="当前没有 Agent 任务">开始答复或发送讨论后，进行中的任务会显示在这里。</Empty>}
  </div>;
}
