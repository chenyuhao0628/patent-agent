import type { AgentCommand } from '../src/domain/agent-command.ts';
import type { ProfessionalCommand } from '../src/professional-api.ts';
import type { TransferReview } from '../src/transfer-api.ts';
import { assertCaseId, assertProfileKey, assertRecord, assertString } from '../src/contracts/version.ts';

const AGENT_COMMANDS = new Set([
  'queue', 'conversation', 'opened', 'clearConversation', 'branch', 'classify',
  'materials', 'discussion', 'manageDiscussion', 'run', 'stop', 'strategy',
  'restoreDraft', 'adopt', 'issues', 'applicationParts', 'correctionContents',
  'updateDraft', 'finalize', 'unfinalize', 'setStage',
]);

const PROFESSIONAL_COMMANDS = new Set(['write', 'confirm', 'restart', 'review', 'ready-manual', 'stop']);

export function ipcProfileKey(value: unknown): string {
  return assertProfileKey(value);
}

export function ipcCaseId(value: unknown): string {
  return assertCaseId(value);
}

export function ipcProcessId(value: unknown): string {
  return assertString(value, '流程标识', 256);
}

export function ipcMaterialId(value: unknown): string {
  return assertString(value, '材料标识', 256);
}

export function ipcRelativePath(value: unknown): string {
  const relativePath = assertString(value, '文件路径', 1024).replaceAll('\\', '/');
  if (relativePath.startsWith('/') || relativePath.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('文件路径无效。');
  }
  return relativePath;
}

export function ipcTransferRole(value: unknown): 'baseline' | 'application' | 'reply' {
  const role = assertString(value, '文件用途', 32);
  if (role !== 'baseline' && role !== 'application' && role !== 'reply') {
    throw new Error('文件用途无效。');
  }
  return role;
}

export function ipcTransferSource(value: unknown): 'workbench' | 'local' {
  const source = assertString(value, '材料来源', 32);
  if (source !== 'workbench' && source !== 'local') {
    throw new Error('材料来源无效。');
  }
  return source;
}

export function ipcAgentCommand(value: unknown): AgentCommand {
  const record = assertRecord(value, 'Agent 请求无效。');
  const type = assertString(record.type, 'Agent 操作类型', 64);
  if (!AGENT_COMMANDS.has(type)) throw new Error('不支持的 Agent 操作。');
  return value as AgentCommand;
}

export function ipcProfessionalCommand(value: unknown): ProfessionalCommand {
  const record = assertRecord(value, '撰写或审查请求无效。');
  const type = assertString(record.type, '专业工作操作类型', 64);
  if (!PROFESSIONAL_COMMANDS.has(type)) throw new Error('不支持的专业工作操作。');
  return value as ProfessionalCommand;
}

export function ipcTransferReview(value: unknown): TransferReview {
  const record = assertRecord(value, '内部流转核对内容无效。');
  if (!Array.isArray(record.keepCodes) || !record.form || typeof record.stepId !== 'string' || typeof record.userId !== 'string' || typeof record.remark !== 'string') {
    throw new Error('内部流转核对内容不完整。');
  }
  return value as TransferReview;
}
