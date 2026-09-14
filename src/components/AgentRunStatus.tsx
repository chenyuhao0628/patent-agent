import { useEffect, useState } from 'react';
import type { AgentJob, ToolEvent } from '../domain/agent.ts';
import { toolEventLabel } from '../desktop.ts';

function seconds(from: string, to: number) { return Math.max(0, Math.floor((to - Date.parse(from)) / 1000)); }
function duration(value: number) { return value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分 ${value % 60} 秒`; }

export function AgentRunStatus({ job, tools = [] }: { job: AgentJob; tools?: ToolEvent[] }) {
  const [now, setNow] = useState(Date.now());
  const running = job.state === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const end = job.endedAt ? Date.parse(job.endedAt) : now;
  const quiet = seconds(job.lastActivityAt ?? job.startedAt, now);
  const label = running ? quiet >= 30 ? '等待响应，暂无新活动' : job.activity ?? '连接模型' : ({ running: '运行中', stopped: '已停止', failed: '失败', completed: '已完成' } as const)[job.state];
  return <div className={`agent-run-status${running ? ' is-running' : ''}`}>
    <div className="agent-run-heading"><span role="status">{running && <span className="agent-running-dot"/>}{label}</span><small>耗时 {duration(seconds(job.startedAt, end))}</small></div>
    {running && <small>距最近活动 {duration(quiet)}{quiet >= 30 ? '；尚未收到新进展，可等待或停止。' : ''}</small>}
    <div className="agent-run-details">
      <details name={`run-detail-${job.runId}`}><summary>思考内容{job.thinkingText ? '' : '（暂无）'}</summary><div className="agent-detail-panel">
        {job.thinkingText ? <><small>供应商返回的可展示内容</small><pre>{job.thinkingText}</pre></> : <><p>本次尚未收到可展示的思考内容，可能与模型返回或协议适配有关。以下为执行进展。</p><ol>{job.steps?.slice(-6).map(step=><li key={step.id}>{step.label} · {step.status === 'completed' ? '完成' : step.status === 'running' ? '进行中' : '已结束'}</li>)}</ol></>}
      </div></details>
      <details name={`run-detail-${job.runId}`}><summary>执行记录（{job.steps?.length ?? tools.length}）</summary><div className="agent-detail-panel">
        <ol>{job.steps?.map(step => <li key={step.id}>{step.label} · {({ running: '进行中', completed: '完成', error: '失败', stopped: '已停止' } as Record<string, string>)[step.status] ?? step.status} · {new Date(step.at).toLocaleTimeString()}{step.endedAt ? ` · ${duration(seconds(step.at, Date.parse(step.endedAt)))}` : ''}</li>)}</ol>
        {tools.map(tool => <div key={tool.id}>{toolEventLabel(tool)} · {tool.filename}{tool.readRange ? ` · ${tool.readRange}` : ''}{tool.detail && <pre>{tool.detail}</pre>}</div>)}
        {!job.steps?.length && !tools.length && <p>尚无工具执行记录。</p>}
      </div></details>
    </div>
  </div>;
}
