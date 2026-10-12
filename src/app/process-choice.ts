import type { RemoteProcess } from '../domain/workflow.ts';
import { processDeadlineView } from '../domain/deadlines.ts';
function processStatusText(status:number){
  return ({0:'待处理',200:'审核中',300:'待递交',400:'递交处理中',500:'已结束'} as Record<number,string>)[status]??'以系统记录为准';
}
export function processChoiceLabel(p:RemoteProcess){
  const due=processDeadlineView(p);
  return `${p.name} · ${processStatusText(p.status)} · 期限 ${due.display==='—'?'未提供':due.display} · 承办人 ${p.undertaker||'未提供'}`;
}
