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
const EXTENSION_METHODS = new Set(['test', 'list', 'toggle', 'remove', 'saveMcp', 'saveSkill', 'importSkill']);
const PRIOR_ART_METHODS = new Set(['status', 'save', 'clear', 'importLegacy', 'test', 'prepare']);

function fieldString(record: Record<string, unknown>, key: string, label = key): string {
  return assertString(record[key], label, 4096);
}

function fieldArray(record: Record<string, unknown>, key: string, label = key): unknown[] {
  if (!Array.isArray(record[key])) throw new Error(`${label}无效。`);
  return record[key];
}

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

export function ipcBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}无效。`);
  return value;
}

export function ipcExtensionMethod(value: unknown): string {
  const method = assertString(value, '扩展操作', 32);
  if (!EXTENSION_METHODS.has(method)) throw new Error('不支持的扩展操作。');
  return method;
}

export function ipcPriorArtMethod(value: unknown): string {
  const method = assertString(value, '对比文件操作', 32);
  if (!PRIOR_ART_METHODS.has(method)) throw new Error('不支持的对比文件操作。');
  return method;
}

export function ipcAgentCommand(value: unknown): AgentCommand {
  const record = assertRecord(value, 'Agent 请求无效。');
  const type = assertString(record.type, 'Agent 操作类型', 64);
  if (!AGENT_COMMANDS.has(type)) throw new Error('不支持的 Agent 操作。');
  if (type === 'queue') {
    fieldString(record, 'discussionId', '讨论标识');
    const operation = fieldString(record, 'operation', '队列操作');
    if (!['add', 'edit', 'remove', 'send'].includes(operation)) throw new Error('队列操作无效。');
  } else if (type === 'conversation') {
    fieldString(record, 'discussionId', '讨论标识');
    const operation = fieldString(record, 'operation', '对话操作');
    if (!['continue', 'retry', 'edit', 'regenerate'].includes(operation)) throw new Error('对话操作无效。');
  } else if (type === 'clearConversation' || type === 'branch' || type === 'manageDiscussion') {
    fieldString(record, 'discussionId', '讨论标识');
  } else if (type === 'classify') {
    assertRecord(record.classification, '分类内容无效。');
  } else if (type === 'materials') {
    fieldArray(record, 'selectedIds', '材料选择');
  } else if (type === 'run') {
    fieldString(record, 'action', 'Agent 动作');
  } else if (type === 'strategy') {
    fieldString(record, 'strategyId', '策略标识');
  } else if (type === 'restoreDraft' || type === 'adopt') {
    fieldString(record, 'versionId', '版本标识');
  } else if (type === 'issues') {
    fieldString(record, 'reviewId', '复核标识');
    fieldArray(record, 'issueIds', '问题标识');
  } else if (type === 'applicationParts' || type === 'correctionContents') {
    fieldArray(record, type === 'applicationParts' ? 'parts' : 'items', '产物内容');
  } else if (type === 'setStage') {
    fieldString(record, 'stage', '办理阶段');
  }
  return value as AgentCommand;
}

export function ipcProfessionalCommand(value: unknown): ProfessionalCommand {
  const record = assertRecord(value, '撰写或审查请求无效。');
  const type = assertString(record.type, '专业工作操作类型', 64);
  if (!PROFESSIONAL_COMMANDS.has(type)) throw new Error('不支持的专业工作操作。');
  if (type === 'write') {
    fieldString(record, 'message', '撰写要求');
    fieldArray(record, 'materialIds', '材料选择');
  } else if (type === 'confirm') {
    fieldString(record, 'jobId', '任务标识');
  } else if (type === 'restart') {
    if (!Number.isInteger(record.phase) || Number(record.phase) < 0 || Number(record.phase) > 4) throw new Error('撰写阶段无效。');
  } else if (type === 'review') {
    fieldString(record, 'sourceId', '稿件标识');
  }
  return value as ProfessionalCommand;
}

export function ipcTransferReview(value: unknown): TransferReview {
  const record = assertRecord(value, '内部流转核对内容无效。');
  if (!Array.isArray(record.keepCodes) || !record.form || typeof record.stepId !== 'string' || typeof record.userId !== 'string' || typeof record.remark !== 'string') {
    throw new Error('内部流转核对内容不完整。');
  }
  return value as TransferReview;
}
