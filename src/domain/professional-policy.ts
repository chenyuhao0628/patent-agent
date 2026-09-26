export const WRITING_PHASES = [
  '方向构思',
  '技术方案与保护架构',
  '说明书',
  '权利要求书',
  '申请文件整理',
] as const;

export type WritingPhase = (typeof WRITING_PHASES)[number];
