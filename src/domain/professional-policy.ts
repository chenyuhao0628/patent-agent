import type { Case } from './workflow.ts';
import { currentWork, editableCurrent } from './lifecycle.ts';

export const WRITING_PHASES = [
  '方向构思',
  '技术方案与保护架构',
  '说明书',
  '权利要求书',
  '申请文件整理',
] as const;

export type WritingPhase = (typeof WRITING_PHASES)[number];

export const PROFESSIONAL_BUSINESS_KINDS = ['write', 'reply', 'correction', 'review'] as const;

export function professionalWorkEditable(caseItem: Case): boolean {
  return editableCurrent(caseItem)
    && PROFESSIONAL_BUSINESS_KINDS.includes(currentWork(caseItem).kind as (typeof PROFESSIONAL_BUSINESS_KINDS)[number]);
}

export function professionalWritingEditable(caseItem: Case): boolean {
  return professionalWorkEditable(caseItem) && currentWork(caseItem).kind === 'write';
}
