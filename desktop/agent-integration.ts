import type { ExtensionService } from './extensions.ts';
import * as fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentHostRun, AgentHostRunEvent, AgentHostRunInput } from './agent-host.ts';
import {
  PREFERRED_ARTIFACT,
  TOOL_READ_SKILL,
  TOOL_READ_DRAFT,
  TOOL_READ_MATERIAL,
  TOOL_WRITE_ARTIFACT,
  type AgentRunner,
  type AgentRunResult,
  type ToolEvent,
  type ToolRange,
  type WrittenArtifact,
} from './agent-runner.ts';
import { digest, managedPath } from './files.ts';
import { createReadMaterialCallback } from './agent-document-reader.ts';

export const REPLY_RULES_RELATIVE = path.join('resources', 'reply-rules');
export const AGENT_RUNTIME_DIR = 'agent-runtime';
export const LAB_RUNTIME_RELATIVE = path.join('.lab', 'agent-runtime');

export function replyRulesRoot(appPath: string): string {
  return path.join(appPath, REPLY_RULES_RELATIVE);
}

export function draftTextForRunner(draft: AgentHostRunInput['draft']): string | undefined {
  if (!draft) return undefined;
  return [
    `稿件版本：${draft.id}`,
    '## 正文',
    draft.text,
    '## 建议修改文本',
    draft.amendmentText ?? '',
    '## 本次修改后的完整申请正文',
    JSON.stringify(draft.applicationParts??null),
    '## 补正内容字段',
    JSON.stringify(draft.correctionContents??null),
    '## 修改依据',
    draft.amendmentBasis ?? '',
  ].join('\n');
}

export function accumulatePartial(previous: string, incoming: string): string {
  if (!incoming) return previous;
  return previous + incoming;
}

export function formatToolRange(range?: ToolRange): string | undefined {
  if (!range) return undefined;
  if (range.startLine != null || range.endLine != null) {
    return `${range.startLine ?? ''}-${range.endLine ?? ''}`.replace(/^-+|-+$/g, '') || undefined;
  }
  if (range.offset != null) return range.limit != null ? `${range.offset}:${range.limit}` : String(range.offset);
  return undefined;
}

function toolKindOf(name: string): 'read_material' | 'read_draft' | 'read_skill' | 'write_artifact' | 'web_search' | 'web_fetch' | 'ensure_tool' | 'discover_tools' | 'execute_command' | 'download_file' | 'prepare_material' | 'read_work_file' | 'custom_mcp' | null {
  if(/^custom_[a-f0-9]+_/.test(name))return 'custom_mcp';
  if (name === TOOL_READ_MATERIAL || name.endsWith(`_${TOOL_READ_MATERIAL}`)) return 'read_material';
  if (name === TOOL_READ_SKILL || name.endsWith(`_${TOOL_READ_SKILL}`)) return 'read_skill';
  if (name === TOOL_READ_DRAFT || name.endsWith(`_${TOOL_READ_DRAFT}`)) return 'read_draft';
  if (name === TOOL_WRITE_ARTIFACT || name.endsWith(`_${TOOL_WRITE_ARTIFACT}`)) return 'write_artifact';
  for(const key of ['web_search','web_fetch','ensure_tool','discover_tools','execute_command','download_file','prepare_material','read_work_file'] as const)if(name===key||name.endsWith('_'+key))return key;
  return null;
}

export function mapRunnerToolEvent(event: ToolEvent): Extract<AgentHostRunEvent, { type: 'tool' }> | null {
  const toolKind = toolKindOf(event.name);
  if (!toolKind) return null;
  return {
    type: 'tool',
    filename: ['execute_command','download_file','web_fetch'].includes(toolKind) ? toolKind : event.materialName || event.artifactName || event.name,
    detail: ['execute_command','download_file','web_fetch'].includes(toolKind) ? event.materialName : undefined,
    readRange: formatToolRange(event.range),
    status: event.success || event.status === 'success' ? 'ok' : 'error',
    materialId: event.materialId,
    toolKind,
  };
}

function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function assertNoSymlinkChain(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let cursor = path.resolve(target);
  for (;;) {
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('产物路径不受控。');
    if (cursor === resolvedRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('产物路径不受控。');
    cursor = parent;
  }
  const realFile = await fs.realpath(target);
  const realRoot = await fs.realpath(root);
  if (path.dirname(realFile) !== realRoot || !insideRoot(realRoot, realFile)) {
    throw new Error('产物路径不受控。');
  }
}

export async function readVerifiedArtifact(artifact: WrittenArtifact, outputsRoot: string): Promise<string> {
  const relative = portableRelative(artifact.relativePath || artifact.name);
  if (path.basename(artifact.name || '') !== PREFERRED_ARTIFACT || relative !== PREFERRED_ARTIFACT) {
    throw new Error('任务没有完整 JSON 产物。');
  }
  const expected = await managedPath(outputsRoot, PREFERRED_ARTIFACT);
  if (path.resolve(artifact.absolutePath) !== expected) throw new Error('产物路径不受控。');
  await assertNoSymlinkChain(outputsRoot, expected);
  const stat = await fs.lstat(expected);
  if (!stat.isFile()) throw new Error('产物不是普通文件。');
  const buf = await fs.readFile(expected);
  if (digest(buf) !== artifact.hash) throw new Error('产物哈希不一致。');
  return buf.toString('utf8');
}

function portableRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(value)) return '';
  return normalized;
}

export async function writeHostRunOutput(outputDir: string, runId: string, text: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const primary = await managedPath(outputDir, PREFERRED_ARTIFACT, true);
  try {
    await fs.writeFile(primary, text, { mode: 0o600, flag: 'wx' });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const existing = await fs.readFile(primary);
  if (digest(existing) === digest(text)) return;
  const safeName = `${runId.replace(/[^a-zA-Z0-9._-]+/g, '').slice(0, 48) || randomUUID()}.result.json`;
  const alt = await managedPath(outputDir, safeName, true);
  await fs.writeFile(alt, text, { mode: 0o600, flag: 'wx' });
}

export function bundledOpenCodePath(options: {
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error('当前系统尚未捆绑 OpenCode 运行时，无法启动 Agent。');
  }
  const exe = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const nested = platform === 'win32'
    ? path.join('win32-x64', exe)
    : path.join(arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64', exe);
  const labRoot = path.join(options.appPath, LAB_RUNTIME_RELATIVE);
  const preparedRoot = path.join(options.appPath, 'resources', AGENT_RUNTIME_DIR);
  const candidates = [
    path.join(options.resourcesPath, AGENT_RUNTIME_DIR, exe),
    path.join(options.resourcesPath, AGENT_RUNTIME_DIR, nested),
    path.join(preparedRoot, nested),
    path.join(preparedRoot, exe),
    path.join(labRoot, nested),
    path.join(labRoot, exe),
  ];
  for (const candidate of candidates) {
    try {
      const stat = fsSync.lstatSync(candidate);
      if (!stat.isSymbolicLink() && stat.isFile()) return candidate;
    } catch { /* only explicit bundled / .lab paths */ }
  }
  throw new Error('产品未捆绑 OpenCode 运行时，无法启动 Agent。请使用带运行时的安装包。');
}

export function createHostRun(runner: Pick<AgentRunner, 'run'>, extensions?:ExtensionService): AgentHostRun {
  return input => {
    const local = new AbortController();
    const signal = input.signal.aborted
      ? input.signal
      : AbortSignal.any([input.signal, local.signal]);
    const engineDir = path.join(path.dirname(input.snapshotDir), 'engine');
    const outputsDir = path.join(engineDir, 'outputs');
    let partial = '';
    const aborted = () => signal.aborted || input.signal.aborted || local.signal.aborted;
    const wait = (async () => {
      const custom=await extensions?.runtime(input.runtime.profileKey);
      const result: AgentRunResult = await runner.run({
        artifactExpect:input.artifactExpect,
        validateArtifact:input.validateArtifact,
        artifactScope:input.artifactScope,
        recoveryArtifactRoot: input.resumeFromRunId ? path.join(path.dirname(path.dirname(input.snapshotDir)), input.resumeFromRunId, 'engine', 'outputs') : undefined,
        customMcp: input.resumeFromRunId ? undefined : custom?.mcp,
        recoveryJournalPath: input.resumeFromRunId ? path.join(path.dirname(path.dirname(input.snapshotDir)), input.resumeFromRunId, 'engine', 'operation-journal.json') : undefined,
        runtime: input.runtime,
        runId: input.runId,
        discussionId: input.discussionId,
        localRunDirectory: engineDir,
        materials: input.materials.map(item => ({
          id: item.id,
          name: item.name,
          role: item.role,
          relativePath: item.relativePath,
          absoluteSnapshotPath: item.snapshotPath,
          hash: item.hash,
        })),
        draftText: draftTextForRunner(input.draft),
        productPrompt: input.prompt.combined+(custom?.prompt||'')+(input.resumeFromRunId ? '\n本次恢复不自动重放自定义 MCP 操作；需要此类操作时说明已完成与待核对项，请用户核对后发起新的明确请求。相同命令、下载及安装由持久执行记录防止重复；先检查已有结果。' : ''),
        publicMessages: input.action === 'review'
          ? []
          : input.messages.map(item => ({ role: item.role, content: item.text })),
        review: input.action === 'review',
        allowedArtifacts: [PREFERRED_ARTIFACT],
        snapshotRoot: input.snapshotDir,
        readMaterial: createReadMaterialCallback(signal),
        skillResources: [...(input.skillResources||[]),...(custom?.skills||[])],
        signal,
        onEvent(event) {
          if (aborted()) return;
          if (event.type === 'thinking' || event.type === 'activity') { void input.onEvent(event); return; }
          if (event.type === 'delta') {
            partial = accumulatePartial(partial, event.text);
            void input.onEvent({ type: 'partial', text: partial });
            return;
          }
          if (event.type === 'tool') {
            const mapped = mapRunnerToolEvent(event.event);
            if (mapped) void input.onEvent(mapped);
          }
        },
      });
      if (aborted() || result.status === 'aborted') {
        await input.onEvent({ type: 'stopped' });
        return;
      }
      if (result.status !== 'completed' || !result.artifact) {
        await input.onEvent({ type: 'failed', error: result.error?.message || '任务没有完整 JSON 产物。' });
        return;
      }
      const text = await readVerifiedArtifact(result.artifact, outputsDir);
      if (aborted()) {
        await input.onEvent({ type: 'stopped' });
        return;
      }
      await writeHostRunOutput(input.outputDir, input.runId, text);
      if (aborted()) {
        await input.onEvent({ type: 'stopped' });
        return;
      }
      await input.onEvent({ type: 'completed', outputText: text });
    })();
    return {
      wait,
      abort() { local.abort(); },
    };
  };
}
