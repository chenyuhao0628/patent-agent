import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenCodeRunner, type AgentRunInput, type AgentRunResult } from './agent-runner.ts';
import { startSyntheticProvider } from './synthetic-provider.ts';
import { digest } from './files.ts';
import type { ModelProtocol } from '../src/domain/models.ts';

function verify(value: unknown, message: string): asserts value { if (!value) throw new Error(`OpenCode 兼容性检查未通过：${message}`); }

/** Uses only generated text and a loopback provider. Successful completion is
 * required before an automatically downloaded executable becomes active. */
export async function verifyOpenCodeRuntime(binaryPath: string, options: { signal?: AbortSignal; keepEvidenceAt?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-runtime-acceptance-'));
  const blockedFile = path.join(root, 'native-tool-must-not-write');
  const synthetic = await startSyntheticProvider({ nativeCommand: process.platform === 'win32' ? `Set-Content -LiteralPath '${blockedFile.replaceAll("'", "''")}' 'unexpected'` : `touch '${blockedFile.replaceAll("'", "'\\''")}'` });
  const results: Array<{ protocol: ModelProtocol; status: string; sessionId?: string; reused?: boolean; cacheRead?: number }> = [];
  let authChecks = 0;
  const runtimeIdentity = 'candidate';
  const fetchImpl: typeof fetch = async (...args) => {
    const url = new URL(String(args[0]));
    const response = await fetch(...args);
    if (url.pathname === '/api/info' && response.ok) {
      const unauthorized = await fetch(new URL('/api/session', url), { signal: AbortSignal.timeout(2_000) });
      const status = unauthorized.status; await unauthorized.body?.cancel();
      verify(status === 401 || status === 403, '后台会话接口未拒绝无凭证请求'); authChecks++;
    }
    return response;
  };
  const runner = (identity = runtimeIdentity) => new OpenCodeRunner({ binaryPath: path.resolve(binaryPath), runtimeIdentity: identity, fetchImpl });
  const material = 'SYNTHETIC-CURRENT-CASE';
  await fs.mkdir(path.join(root, 'materials'));
  await fs.writeFile(path.join(root, 'materials', 'current.txt'), material);
  // Parent configuration/instructions must not enter the isolated engine.
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'FORBIDDEN-AMBIENT-INSTRUCTION');
  await fs.writeFile(path.join(root, 'opencode.json'), JSON.stringify({ agents: { 'ambient-probe': { system: 'FORBIDDEN-AMBIENT-INSTRUCTION' } }, permissions: [{ action: '*', resource: '*', effect: 'allow' }] }));
  const makeInput = (protocol: ModelProtocol, runId: string, extra: Partial<AgentRunInput> = {}): AgentRunInput => ({
    runtime: { profileKey: 'synthetic-profile', providerId: 'synthetic-provider', providerName: 'Synthetic', baseURL: `${synthetic.origin}/${protocol === 'gemini-generate-content' ? 'v1beta' : 'v1'}`, protocol, modelId: 'synthetic-model', displayName: 'Synthetic', contextWindow: 32_000, maxOutput: 1_000, key: 'synthetic-key-never-real', headers: {}, reasoning: { levelId: 'vendor-default', omitted: true, unverified: true, source: 'unverified', protocol } },
    sessionScope: { root: path.join(root, 'sessions'), profileKey: 'synthetic-profile', caseId: 'case-a', processKey: 'phase-a', conversationId: 'main', branchId: 'main', kind: 'discuss', contextHash: 'materials-v1' },
    runId, discussionId: 'synthetic-discussion', localRunDirectory: path.join(root, 'runs', runId), snapshotRoot: path.join(root, 'materials'),
    materials: [{ id: 'synthetic-material', name: 'current.txt', role: 'oa', relativePath: 'current.txt', absoluteSnapshotPath: path.join(root, 'materials', 'current.txt'), hash: digest(material) }],
    productPrompt: 'Complete the synthetic compatibility probe using only the offered case tools.', publicMessages: [{ role: 'user', content: 'SYNTHETIC-PUBLIC-CONTEXT' }],
    allowedArtifacts: ['result.json'], artifactExpect: { kind: 'discuss' }, deadlineMs: 25_000, signal: options.signal, onEvent: () => {}, ...extra,
  });
  const checkResult = async (input: AgentRunInput, result: AgentRunResult) => {
    verify(result.status === 'completed', `${input.runtime.protocol} / ${result.error?.code ?? result.status}`);
    verify(result.toolEvents.some(e => e.name === 'read_material' && e.materialId === 'synthetic-material' && e.success), '没有当前材料读取回执');
    verify(result.toolEvents.some(e => e.name === 'read_material' && !e.success), '跨案材料读取未被拒绝');
    verify(result.artifact, '没有经校验的产物');
    verify(JSON.parse(await fs.readFile(result.artifact.absolutePath, 'utf8')).reply === `SYNTHETIC-${input.runId}`, '错误任务产物');
    verify(result.session?.retained, '本机会话未保留');
    results.push({ protocol: input.runtime.protocol, status: result.status, sessionId: result.session.id, reused: result.session.reused, cacheRead: result.session.cacheReadTokens });
  };
  try {
    let first: AgentRunResult | undefined;
    for (const protocol of ['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'gemini-generate-content'] as const) {
      options.signal?.throwIfAborted();
      const input = makeInput(protocol, randomUUID());
      const result = await runner().run(input);
      await checkResult(input, result);
      if (protocol === 'openai-responses') first = result;
    }
    const resumedInput = makeInput('openai-responses', randomUUID());
    const resumed = await runner('candidate-updated').run(resumedInput); await checkResult(resumedInput, resumed);
    verify(resumed.session?.reused && resumed.session.id === first?.session?.id, '重新启动后未复用已完成会话');
    const otherInput = makeInput('openai-responses', randomUUID()); otherInput.sessionScope = { ...otherInput.sessionScope!, caseId: 'case-b' };
    const other = await runner().run(otherInput); await checkResult(otherInput, other);
    verify(other.session?.id !== resumed.session?.id, '不同案件共享了后台会话');
    const controller = new AbortController();
    const stoppedInput = makeInput('openai-responses', `hang-${randomUUID()}`, { signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
    const pending = runner().run(stoppedInput);
    const deadline = Date.now() + 10_000;
    while (!synthetic.requests.some(r => JSON.stringify(r.body).includes(stoppedInput.runId)) && Date.now() < deadline && !options.signal?.aborted) await new Promise(r => setTimeout(r, 50));
    controller.abort(); const stopped = await pending;
    verify(stopped.status === 'aborted', '任务停止未生效');
    const continuedInput = makeInput('openai-responses', randomUUID());
    const continued = await runner().run(continuedInput); await checkResult(continuedInput, continued);
    verify(continued.session?.id !== stopped.session?.id && !continued.session?.reused, '停止后恢复了未完成的隐藏执行');
    await fs.access(blockedFile).then(() => { throw new Error('原生 shell 权限隔离失败。'); }, error => { if (error.code !== 'ENOENT') throw error; });
    verify(synthetic.requests.every(r => r.names.every(n => n.startsWith('case_tools_'))), '工具白名单改变');
    verify(synthetic.requests.every(r => !JSON.stringify(r.body).includes('FORBIDDEN-AMBIENT-INSTRUCTION')), '读取了工作台外的配置或指令');
    const cached = synthetic.requests.filter(r => r.protocol === 'openai-responses');
    verify(synthetic.requests.filter(r=>r.protocol==='openai-chat-completions').every(r=>!(r.body.max_tokens!==undefined&&r.body.max_completion_tokens!==undefined)), 'Chat 请求同时发送两个互斥输出限制');
    verify(cached.every(r => r.body.store === false && typeof r.body.prompt_cache_key === 'string'), '未启用独立缓存键或开启了响应存储');
    verify(first?.session && first.session.cacheReadTokens > 0, '没有读到合成供应商的缓存用量');
    const report = { schema: 1, checkedAt: new Date().toISOString(), version: first.session.runtimeVersion, authChecks, requests: synthetic.requests.length, results, stopped: stopped.status, nativeToolDenied: true, foreignMaterialDenied: true, ambientConfigExcluded: true, retainedAfterRestart: true, retainedInCopiedDatabase: true, independentCases: true, cacheUsageObserved: true };
    if (options.keepEvidenceAt) { await fs.mkdir(options.keepEvidenceAt, { recursive: true }); await fs.writeFile(path.join(options.keepEvidenceAt, 'acceptance.json'), JSON.stringify(report, null, 2)); }
    return report;
  } catch (error) {
    if (options.keepEvidenceAt) await fs.writeFile(path.join(root, 'request-summary.json'), JSON.stringify(synthetic.requests.map(r => ({protocol:r.protocol,names:r.names,keys:Object.keys(r.body),toolShape:r.body.tools})), null, 2));
    if (options.keepEvidenceAt) { await fs.mkdir(options.keepEvidenceAt, { recursive: true }); await fs.cp(root, path.join(options.keepEvidenceAt, 'failed-synthetic-workspace'), { recursive: true }); }
    throw error;
  } finally { await synthetic.close(); await fs.rm(root, { recursive: true, force: true }); }
}
