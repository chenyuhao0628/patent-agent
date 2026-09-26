import type { AgentCommand } from '../src/domain/agent-command.ts';
import { validateApplicationParts } from '../src/domain/application-parts.ts';
import { validateCorrectionContents } from '../src/domain/correction.ts';
import type { ClassificationInput } from '../src/domain/agent.ts';
import type { ProfessionalCommand } from '../src/professional-api.ts';
import type { TransferFilePreviewRef, TransferReview } from '../src/transfer-api.ts';
import type { Settings, Workspace } from '../src/domain/workflow.ts';
import { assertCaseId, assertProfileKey, assertRecord, assertString } from '../src/contracts/version.ts';
import { validateApplicationPreferences } from './application-settings.ts';

const AGENT_COMMANDS = new Set([
  'queue', 'conversation', 'opened', 'clearConversation', 'branch', 'classify',
  'materials', 'discussion', 'manageDiscussion', 'run', 'stop', 'strategy',
  'restoreDraft', 'adopt', 'issues', 'applicationParts', 'correctionContents',
  'updateDraft', 'finalize', 'unfinalize', 'setStage',
]);

const PROFESSIONAL_COMMANDS = new Set(['write', 'confirm', 'restart', 'review', 'ready-manual', 'stop']);
const EXTENSION_METHODS = new Set(['test', 'list', 'toggle', 'remove', 'saveMcp', 'saveSkill', 'importSkill']);
const PRIOR_ART_METHODS = new Set(['status', 'save', 'clear', 'importLegacy', 'test', 'prepare']);
const DIRECTORY_KINDS = ['originalLibrary', 'workRoot'] as const;
const SYNC_SOURCES = ['manual', 'focus'] as const;

function fieldString(record: Record<string, unknown>, key: string, label = key): string {
  return assertString(record[key], label, 4096);
}

function fieldArray(record: Record<string, unknown>, key: string, label = key): unknown[] {
  if (!Array.isArray(record[key])) throw new Error(`${label}无效。`);
  return record[key];
}

function optionalString(record: Record<string, unknown>, key: string, label = key, maxLength = 4096): string | undefined {
  if (record[key] === undefined) return undefined;
  return assertString(record[key], label, maxLength);
}

function requiredText(record: Record<string, unknown>, key: string, label = key, maxLength = 4096): string {
  if (typeof record[key] !== 'string' || record[key].length > maxLength) throw new Error(`${label}无效。`);
  return record[key] as string;
}

function stringArray(record: Record<string, unknown>, key: string, label = key, maxLength = 256): string[] {
  const values = fieldArray(record, key, label);
  if (values.length > 1000 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > maxLength)) {
    throw new Error(`${label}无效。`);
  }
  return values as string[];
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const candidate = assertString(value, label, 128);
  if (!values.includes(candidate as T)) throw new Error(`${label}无效。`);
  return candidate as T;
}

export type IpcArgumentParser = (args: readonly unknown[]) => unknown[];

export function ipcArgs(...parsers: Array<(value: unknown) => unknown>): IpcArgumentParser {
  return args => {
    if (args.length !== parsers.length) throw new Error('IPC 参数数量无效。');
    return parsers.map((parser, index) => parser(args[index]));
  };
}

export function ipcNoArgs(args: readonly unknown[]): unknown[] {
  if (args.length !== 0) throw new Error('IPC 不接受参数。');
  return [];
}

export function ipcOptional(parser: (value: unknown) => unknown): (value: unknown) => unknown {
  return value => value === undefined ? undefined : parser(value);
}

export function ipcDirectoryKind(value: unknown): 'originalLibrary' | 'workRoot' {
  return oneOf(value, DIRECTORY_KINDS, '目录类型');
}

export function ipcSyncSource(value: unknown): 'manual' | 'focus' | undefined {
  return value === undefined ? undefined : oneOf(value, SYNC_SOURCES, '同步来源');
}

export function ipcText(label: string, maxLength = 4096): (value: unknown) => string {
  return value => assertString(value, label, maxLength);
}

export function ipcDiagnosticReport(value: unknown): { type?: string; line?: number; column?: number } {
  const record = assertRecord(value, '诊断内容无效。');
  if (record.type !== undefined && typeof record.type !== 'string') throw new Error('诊断内容无效。');
  for (const key of ['line', 'column'] as const) {
    if (record[key] !== undefined && (!Number.isInteger(record[key]) || Number(record[key]) < 0 || Number(record[key]) > 1000000)) {
      throw new Error('诊断内容无效。');
    }
  }
  return { type: typeof record.type === 'string' ? record.type.slice(0, 64) : undefined, line: record.line as number | undefined, column: record.column as number | undefined };
}

export function ipcApplicationPreferences(value: unknown) {
  return validateApplicationPreferences(value);
}

export function ipcDocumentToolsConfig(value: unknown): { webEnabled: boolean; autoInstall: boolean; commandsEnabled: boolean; downloadsEnabled: boolean } {
  const record = assertRecord(value, '工具权限设置无效。');
  for (const key of ['webEnabled', 'autoInstall', 'commandsEnabled', 'downloadsEnabled'] as const) {
    if (typeof record[key] !== 'boolean') throw new Error('工具权限设置无效。');
  }
  return {
    webEnabled: record.webEnabled as boolean,
    autoInstall: record.autoInstall as boolean,
    commandsEnabled: record.commandsEnabled as boolean,
    downloadsEnabled: record.downloadsEnabled as boolean,
  };
}

export function ipcExtensionsArgs(args: readonly unknown[]): unknown[] {
  if (args.length < 2 || args.length > 5) throw new Error('扩展请求参数数量无效。');
  const method = ipcExtensionMethod(args[0]);
  const key = ipcProfileKey(args[1]);
  if (method === 'list' || method === 'importSkill') {
    if (args.length !== 2) throw new Error('扩展请求参数数量无效。');
    return [method, key];
  }
  if (method === 'test' || method === 'toggle' || method === 'remove') {
    if (args.length !== (method === 'toggle' ? 4 : 3)) throw new Error('扩展请求参数数量无效。');
    const id = ipcMaterialId(args[2]);
    return method === 'toggle' ? [method, key, id, ipcBoolean(args[3], '扩展启用状态')] : [method, key, id];
  }
  if (method === 'saveMcp') {
    if (args.length < 3 || args.length > 4) throw new Error('扩展请求参数数量无效。');
    return [method, key, requiredText({ value: args[2] }, 'value', 'MCP 配置', 200000), args[3] === undefined ? undefined : ipcMaterialId(args[3])];
  }
  if (method === 'saveSkill') {
    if (args.length < 4 || args.length > 5) throw new Error('扩展请求参数数量无效。');
    return [method, key, requiredText({ value: args[2] }, 'value', '技能名称', 256), requiredText({ value: args[3] }, 'value', '技能内容', 300000), args[4] === undefined ? undefined : ipcMaterialId(args[4])];
  }
  throw new Error('不支持的扩展操作。');
}

export function ipcPriorArtArgs(args: readonly unknown[]): unknown[] {
  if (args.length < 2 || args.length > 4) throw new Error('对比文件请求参数数量无效。');
  const method = ipcPriorArtMethod(args[0]);
  const key = ipcProfileKey(args[1]);
  if (['status', 'clear', 'importLegacy', 'test'].includes(method)) {
    if (args.length !== 2) throw new Error('对比文件请求参数数量无效。');
    return [method, key];
  }
  if (method === 'save') {
    if (args.length !== 3) throw new Error('对比文件请求参数数量无效。');
    return [method, key, requiredText({ value: args[2] }, 'value', '对比文件凭证', 10000)];
  }
  if (args.length < 3 || args.length > 4) throw new Error('对比文件请求参数数量无效。');
  const caseId = ipcCaseId(args[2]);
  if (args[3] !== undefined && typeof args[3] !== 'string') throw new Error('对比文件说明无效。');
  return [method, key, caseId, args[3]];
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
  if (relativePath.startsWith('/') || /^[A-Za-z]:($|\/)/.test(relativePath) || relativePath.split('/').some(part => part === '..' || part === '.' || part === '')) {
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

export function ipcLoginInput(value: unknown): { origin: string; username: string; password: string; remember: boolean } {
  const record = assertRecord(value, '登录请求无效。');
  return {
    origin: fieldString(record, 'origin', '服务地址'),
    username: fieldString(record, 'username', '账号'),
    password: fieldString(record, 'password', '密码'),
    remember: ipcBoolean(record.remember, '记住登录'),
  };
}

export function ipcCreateCaseInput(value: unknown): { title: string; number: string; kind: 'write' | 'review' } {
  const record = assertRecord(value, '新建案件请求无效。');
  const kind = fieldString(record, 'kind', '当前业务');
  if (kind !== 'write' && kind !== 'review') throw new Error('当前业务无效。');
  return { title: fieldString(record, 'title', '案件名称'), number: fieldString(record, 'number', '案号'), kind };
}

export function ipcWorkspace(value: unknown): Workspace {
  const record = assertRecord(value, '案件记录无效。');
  if (record.schema !== 1 || !Array.isArray(record.cases) || !record.settings || typeof record.settings !== 'object') {
    throw new Error('案件记录格式不正确。');
  }
  if (record.cases.length > 100000) throw new Error('案件记录格式不正确。');
  return value as Workspace;
}

export function ipcSettings(value: unknown): Settings {
  const record = assertRecord(value, '设置内容无效。');
  for (const key of ['provider', 'baseUrl', 'model'] as const) {
    try { requiredText(record, key); } catch { throw new Error('设置内容无效。'); }
  }
  for (const key of ['provider', 'baseUrl', 'model', 'originalLibrary', 'workRoot', 'sharedDirectory', 'localDirectory', 'templatePath'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') throw new Error('设置内容无效。');
  }
  if (record.extensions !== undefined) {
    if (!Array.isArray(record.extensions) || record.extensions.length > 500 || record.extensions.some(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
      const extension = value as Record<string, unknown>;
      return typeof extension.id !== 'string' || typeof extension.name !== 'string'
        || (extension.kind !== '技能' && extension.kind !== 'MCP') || typeof extension.enabled !== 'boolean';
    })) throw new Error('设置内容无效。');
  }
  return value as Settings;
}

export function ipcTransferFilePreviewRef(value: unknown): TransferFilePreviewRef {
  const record = assertRecord(value, '文件预览请求无效。');
  for (const key of ['role', 'partCode', 'fileNo', 'name'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') throw new Error('文件预览请求无效。');
  }
  return value as TransferFilePreviewRef;
}

export function ipcAgentCommand(value: unknown): AgentCommand {
  const record = assertRecord(value, 'Agent 请求无效。');
  const type = assertString(record.type, 'Agent 操作类型', 64);
  if (!AGENT_COMMANDS.has(type)) throw new Error('不支持的 Agent 操作。');
  if (type === 'queue') {
    fieldString(record, 'discussionId', '讨论标识');
    oneOf(record.operation, ['add', 'edit', 'remove', 'send'], '队列操作');
    optionalString(record, 'id', '队列消息标识');
    optionalString(record, 'text', '队列内容', 100000);
    optionalString(record, 'expectedRunId', '任务标识');
  } else if (type === 'conversation') {
    fieldString(record, 'discussionId', '讨论标识');
    oneOf(record.operation, ['continue', 'retry', 'edit', 'regenerate'], '对话操作');
    optionalString(record, 'queueId', '队列标识');
    optionalString(record, 'runId', '任务标识');
    optionalString(record, 'messageId', '消息标识');
    optionalString(record, 'text', '对话内容', 100000);
  } else if (type === 'clearConversation' || type === 'branch' || type === 'manageDiscussion') {
    fieldString(record, 'discussionId', '讨论标识');
    if (type === 'branch') fieldString(record, 'branchId', '分支标识');
    if (type === 'manageDiscussion') oneOf(record.operation, ['delete', 'archive', 'restore'], '讨论操作');
  } else if (type === 'classify') {
    ipcClassification(record.classification);
  } else if (type === 'materials') {
    stringArray(record, 'selectedIds', '材料选择');
  } else if (type === 'discussion') {
    optionalString(record, 'title', '讨论标题');
  } else if (type === 'run') {
    oneOf(record.action, ['analysis', 'discuss', 'draft', 'revise', 'review'], 'Agent 动作');
    optionalString(record, 'queueId', '队列标识');
    optionalString(record, 'discussionId', '讨论标识');
    optionalString(record, 'userMessage', '用户要求', 100000);
    optionalString(record, 'resumeFromRunId', '恢复任务标识');
  } else if (type === 'stop') {
    optionalString(record, 'runId', '任务标识');
  } else if (type === 'strategy') {
    fieldString(record, 'strategyId', '策略标识');
    optionalString(record, 'queueId', '队列标识');
    if (record.startDraft !== undefined) ipcBoolean(record.startDraft, '直接起草');
    optionalString(record, 'userMessage', '用户要求', 100000);
  } else if (type === 'restoreDraft' || type === 'adopt') {
    fieldString(record, 'versionId', '版本标识');
  } else if (type === 'issues') {
    fieldString(record, 'reviewId', '复核标识');
    stringArray(record, 'issueIds', '问题标识');
    if (record.handled !== undefined) ipcBoolean(record.handled, '处理状态');
  } else if (type === 'applicationParts' || type === 'correctionContents') {
    if (type === 'applicationParts') validateApplicationParts(record.parts);
    else validateCorrectionContents(record.items);
  } else if (type === 'updateDraft') {
    const hasContent = ['text', 'amendmentText', 'applicationParts', 'correctionContents', 'amendmentBasis', 'reviewNotes']
      .some(key => record[key] !== undefined);
    if (!hasContent) throw new Error('稿件更新内容无效。');
    optionalString(record, 'text', '答复正文', 300000);
    optionalString(record, 'amendmentText', '修改说明', 300000);
    optionalString(record, 'amendmentBasis', '修改依据', 100000);
    optionalString(record, 'reviewNotes', '复核说明', 100000);
    if (record.applicationParts !== undefined) validateApplicationParts(record.applicationParts);
    if (record.correctionContents !== undefined) validateCorrectionContents(record.correctionContents);
  } else if (type === 'setStage') {
    oneOf(record.stage, ['materials', 'strategy', 'draft', 'review', 'final'], '办理阶段');
  }
  return value as AgentCommand;
}

export function ipcProfessionalCommand(value: unknown): ProfessionalCommand {
  const record = assertRecord(value, '撰写或审查请求无效。');
  const type = assertString(record.type, '专业工作操作类型', 64);
  if (!PROFESSIONAL_COMMANDS.has(type)) throw new Error('不支持的专业工作操作。');
  if (type === 'write') {
    if (record.message !== undefined && typeof record.message !== 'string') throw new Error('撰写要求无效。');
    if (typeof record.message === 'string' && record.message.length > 100000) throw new Error('撰写要求无效。');
    stringArray(record, 'materialIds', '材料选择');
  } else if (type === 'confirm') {
    fieldString(record, 'jobId', '任务标识');
    if (record.decision !== undefined && typeof record.decision !== 'string') throw new Error('确认意见无效。');
    if (typeof record.decision === 'string' && record.decision.length > 100000) throw new Error('确认意见无效。');
  } else if (type === 'restart') {
    if (!Number.isInteger(record.phase) || Number(record.phase) < 0 || Number(record.phase) > 4) throw new Error('撰写阶段无效。');
  } else if (type === 'review') {
    fieldString(record, 'sourceId', '稿件标识');
  }
  return value as ProfessionalCommand;
}

function ipcClassification(value: unknown): ClassificationInput {
  const record = assertRecord(value, '分类内容无效。');
  if (record.status !== 'classified' && record.status !== 'unclassified' && record.status !== 'unknown') {
    throw new Error('分类状态无效。');
  }
  if (record.patentType !== undefined && !['发明', '实用新型', '待核对', 'unknown'].includes(record.patentType as string)) {
    throw new Error('专利类型无效。');
  }
  if (record.noticeCategory !== undefined && !['审查意见通知书', '补正通知书', '待核对', 'unknown'].includes(record.noticeCategory as string)) {
    throw new Error('通知类型无效。');
  }
  if (record.officeActionRound !== undefined && record.officeActionRound !== null
    && (!Number.isInteger(record.officeActionRound) || Number(record.officeActionRound) < 1 || Number(record.officeActionRound) > 100)) {
    throw new Error('审查意见轮次无效。');
  }
  if (record.correctionBasis !== undefined && !/^(original|other|round_[1-9]\d*)$/.test(String(record.correctionBasis)) && record.correctionBasis !== 'unknown') {
    throw new Error('补正依据无效。');
  }
  return value as ClassificationInput;
}

export function ipcTransferReview(value: unknown): TransferReview {
  const record = assertRecord(value, '内部流转核对内容无效。');
  if (!Array.isArray(record.keepCodes) || !record.form || typeof record.stepId !== 'string' || typeof record.userId !== 'string' || typeof record.remark !== 'string') {
    throw new Error('内部流转核对内容不完整。');
  }
  return value as TransferReview;
}
