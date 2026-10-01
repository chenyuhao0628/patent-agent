import { CheckCheck, ChevronRight, CircleAlert, Files } from 'lucide-react';
import type { TaskProgress } from '../domain/task-progress.ts';
import '../task-evidence.css';

const fileStates = { saved: '已保存', reused: '已核对并复用', changed: '文件变化，未复用', missing: '文件不可读取，未复用' } as const;

export function TaskBusinessProgress({ progress }: { progress?: TaskProgress }) {
  if (!progress) return null;
  const visible = (items: TaskProgress['saved']) => items.filter(item => !['kind', 'strategyId', 'draftVersionId'].includes(item.id));
  const saved = visible(progress.saved), pending = visible(progress.pending), recovery = progress.recovery;
  const unknown = recovery?.operations.filter(operation => operation.state === 'started') ?? [];
  const hasRecovery = !!(progress.checkpoint || recovery?.files.length || recovery?.operations.length);
  const status = progress.accepted ? '产物检查通过' : pending.length ? '待补齐 ' + pending.length + ' 项' : saved.length ? '已保存分项' : '等待保存';

  return <section className="task-panel task-business-progress" aria-label="本次任务产物">
    <header className="task-panel-heading" role="status">
      <span className="task-panel-title"><CheckCheck size={16} aria-hidden="true"/>本次任务产物</span>
      <span className={'task-panel-badge' + (progress.accepted ? ' is-complete' : '')}>{status}</span>
    </header>
    <div className="task-progress-content">
      <dl className="task-progress-rows">
        <div><dt>已保存</dt><dd>{saved.length ? saved.map(item => item.label).join('、') : '尚未保存业务正文'}{progress.opinions > 0 && <span className="task-progress-extra">通知意见拆解 {progress.opinions} 项</span>}</dd></div>
        {pending.length > 0 && <div><dt>待补齐</dt><dd>{pending.map(item => item.label).join('、')}</dd></div>}
        {progress.warnings > 0 && <div><dt>待核对</dt><dd>{progress.warnings} 项提示<span className="task-progress-hint">详见本次任务依据</span></dd></div>}
      </dl>
      {progress.problem && !pending.length && <p className="task-panel-note">下一步：{progress.problem}</p>}
      {recovery?.note && <p className="task-panel-note">{recovery.note}</p>}
      {unknown.length > 0 && <p className="task-progress-warning"><CircleAlert size={15} aria-hidden="true"/><span>{unknown.length} 项外部操作结果尚未确认。记录已保留，续办时先核对，不自动重复执行。</span></p>}
    </div>
    {hasRecovery && <details className="task-recovery">
      <summary className="task-disclosure"><Files size={15} aria-hidden="true"/><span>续办资料与文件摘要</span><ChevronRight className="task-disclosure-chevron" size={15} aria-hidden="true"/></summary>
      <div className="task-recovery-content">
        {progress.checkpoint && <div className="task-file-record"><span className="task-record-label">分项检查点</span><strong>{progress.checkpoint.relativePath}</strong><code aria-label="内容摘要 SHA-256">{progress.checkpoint.hash}</code></div>}
        {!!recovery?.files.length && <ul className="task-recovery-list">{recovery.files.map(file => <li className="task-file-record" key={file.relativePath}><span className="task-record-label">{fileStates[file.state]}</span><strong>{file.relativePath}</strong><code aria-label="文件摘要 SHA-256">{file.hash}</code></li>)}</ul>}
        {!!recovery?.operations.length && <ul className="task-recovery-list">{recovery.operations.map(operation => <li className="task-operation-record" key={operation.id}><span>{operation.name}<small>{operation.id.slice(0, 12)}</small></span><span className="task-record-label">{operation.state === 'started' ? '结果不明' : operation.success === false ? '已返回错误' : '已收到返回'}</span></li>)}</ul>}
        <p className="task-panel-note">已保存内容供续办使用；通过检查不等于论证、Word 版式或递交已验收。</p>
      </div>
    </details>}
  </section>;
}
