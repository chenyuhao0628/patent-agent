import { memo } from 'react';
import { ChevronRight, FileCheck2 } from 'lucide-react';
import type { ArtifactQuality, EvidenceUnit } from '../domain/agent-evidence.ts';
import type { TaskMemoryView } from '../domain/task-memory.ts';
import '../task-evidence.css';
const unitLabel=(unit:EvidenceUnit)=>unit==='page'?'页':unit==='line'?'行':unit==='image'?'图':'范围';
const memoryLabels={'user-statement':'用户原话（含问题）',confirmed:'用户已确认',version:'指定版本',pending:'尚待决定'};
const citationLabels={verified:'原文匹配',visual:'待视觉核对',unverified:'待人工核对',invalid:'待修正'};

/** Read-only provenance. Warnings never become workflow confirmation gates. */
export const TaskEvidenceDetails=memo(function TaskEvidenceDetails({memory,quality}:{memory?:TaskMemoryView;quality?:ArtifactQuality}){
  const errors=quality?.issues.filter(i=>i.severity==='error')??[];
  const warnings=quality?.issues.filter(i=>i.severity==='warning')??[];
  return <details className="task-panel task-evidence">
    <summary className="task-panel-heading task-disclosure"><span className="task-panel-title"><FileCheck2 size={16} aria-hidden="true"/>本次任务依据</span><span className="task-panel-badge is-neutral">{errors.length>0?'待补齐 '+errors.length+' 项':warnings.length>0?'待核对 '+warnings.length+' 项':quality?'检查记录':'来源记录'}</span><ChevronRight className="task-disclosure-chevron" size={15} aria-hidden="true"/></summary>
    <div className="task-evidence-content">
      <p className="task-evidence-note">这里展示实际读取范围、用户要求来源和引用检查。检查通过不代表论证或 Word 版式已验收；提示事项不新增定稿或提交门槛。</p>
      {!quality&&<p>尚无本次结构化证据报告。旧任务记录仍保留，不能据此推定已经核验。</p>}
      {quality&&<section aria-label="材料阅读范围"><h4>材料阅读范围</h4>
        {!quality.materials.length?<p>本任务未使用文件材料。</p>:<ul className="task-evidence-materials">{quality.materials.map(m=><li key={m.materialId}>
          <strong>{m.name}</strong><span>{m.status==='complete'?(m.visual?'范围已返回 · 含页图':'范围已返回'):m.status==='partial'?'部分范围已返回':m.status==='unread'?'尚未读取':'覆盖范围待核对'}</span>
          <small>{m.ranges.length?m.ranges.map(r=>r.start===r.end?String(r.start):r.start+'–'+r.end).join('、')+' '+unitLabel(m.unit):'没有可确认的完整范围'}{m.total?' / 共 '+m.total+' '+unitLabel(m.unit):''} · 版本 {m.hash.slice(0,12)}</small>
          {m.derived&&<small>含模型声明关联的转换结果，未自动等同于原件。</small>}
        </li>)}</ul>}
      </section>}
      {quality&&<section aria-label="引用核对"><h4>引用核对</h4>
        {!quality.citations.length?<p>未提供结构化原文引用，文字依据仍需核对。</p>:quality.citations.map((c,index)=><div className="task-evidence-citation" key={c.id+'-'+index}>
          <strong>{c.id} · {citationLabels[c.status]}</strong><p>{c.name??c.materialId}{c.start?' · '+c.start+(c.end!==c.start?'–'+c.end:'')+' '+unitLabel(c.unit??'unknown'):''}{c.target?' · 对应 '+c.target:''}</p>
          {c.quote&&<blockquote>{c.quote}</blockquote>}<small>{c.detail}</small>
        </div>)}
      </section>}
      {quality&&quality.issues.length>0&&<section aria-label="待核对事项"><h4>待核对事项</h4><ul>{quality.issues.map((issue,index)=><li key={issue.code+'-'+index} className={issue.severity==='error'?'task-evidence-error':''}>{issue.severity==='error'?'需补齐：':'提示：'}{issue.message}</li>)}</ul></section>}
      <section aria-label="任务记忆来源"><h4>任务记忆来源</h4>
        <p className="task-evidence-note">用户原话保留问题和假设，只有界面确认才标记为已确认。原文完整保存在本次任务中，超长内容可由模型分段读取；此处展示来源及节选。</p>
        {!memory?.entries.length?<p>此记录未包含额外的用户要求或确认状态。</p>:memory.entries.map(entry=><details className="task-memory-entry" key={entry.id}>
          <summary className="task-disclosure"><span>{memoryLabels[entry.kind]} · {entry.source}</span><ChevronRight className="task-disclosure-chevron" size={14} aria-hidden="true"/></summary><p>{entry.preview}</p>{entry.characters>entry.preview.length&&<small>展示前 {entry.preview.length} / {entry.characters} 字，原文未删除。</small>}
        </details>)}
      </section>
    </div>
  </details>;
});
