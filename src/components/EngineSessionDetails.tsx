import type { EngineSessionView } from '../domain/engine-session.ts';

export function EngineSessionDetails({session}:{session?:EngineSessionView}) {
  if (!session) return null;
  return <details className="agent-execution-detail">
    <summary className="task-disclosure">会话与上下文缓存 · {session.reused ? '已接续' : '新上下文'}</summary>
    <div className="agent-detail-panel">
      <p>{session.retained ? '本机会话已保留；账号、案件、办理阶段和分支分别管理。' : '本次会话记录仅属于当前任务。'}</p>
      <p>{session.cacheReadTokens > 0 ? `后台记录缓存读取 ${session.cacheReadTokens.toLocaleString()} tokens。` : session.usageReported ? '已允许上下文缓存，本次未报告缓存命中。' : '已允许上下文缓存，尚未收到用量统计。'}{session.cacheWriteTokens > 0 ? ` 缓存写入 ${session.cacheWriteTokens.toLocaleString()} tokens。` : ''}</p>
      {session.compactions > 0 && <p>本次自动压缩 {session.compactions} 次；公开原文与用户决定保存在本机。</p>}
      <p className="muted">OpenCode {session.runtimeVersion} · 会话 {session.id}</p>
    </div>
  </details>;
}
