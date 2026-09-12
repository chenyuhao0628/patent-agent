import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  accumulatePartial,
  bundledOpenCodePath,
  createHostRun,
  draftTextForRunner,
  LAB_RUNTIME_RELATIVE,
  mapRunnerToolEvent,
  readVerifiedArtifact,
  replyRulesRoot,
  writeHostRunOutput,
} from './agent-integration.ts';
import type { AgentHostRunEvent, AgentHostRunInput } from './agent-host.ts';
import type { AgentRunInput, AgentRunResult, RuntimeModelConfig } from './agent-runner.ts';
import { PREFERRED_ARTIFACT } from './agent-runner.ts';
import { digest } from './files.ts';

const runtime: RuntimeModelConfig = {
  profileKey: 'local',
  providerId: 'p',
  providerName: 'OpenCode Go',
  baseURL: 'https://example.invalid',
  protocol: 'openai-responses',
  modelId: 'deepseek-v4.1-flash',
  displayName: 'Flash',
  key: 'memory-only-key',
  headers: { 'x-opencode-session': 'd1' },
  reasoning: { levelId: 'vendor-default', protocol: 'openai-responses', request: {}, omitted: false, unverified: false, source: 'preset' },
};

function hostInput(over: Partial<AgentHostRunInput> & { snapshotDir: string; outputDir: string; onEvent: AgentHostRunInput['onEvent'] }): AgentHostRunInput {
  return {
    runId: 'run-1',
    caseId: 'c1',
    processKey: 'p1',
    action: 'analysis',
    discussionId: 'd1',
    prompt: { rules: 'rules', task: 'task', combined: 'product-prompt' },
    materials: [{
      id: 'snap-1',
      name: '通知.txt',
      role: '当前通知',
      relativePath: 'materials/snap-1/通知.txt',
      hash: 'h1',
      snapshotPath: path.join(over.snapshotDir, 'materials', 'snap-1', '通知.txt'),
    }],
    messages: [{ role: 'user', text: '主讨论内容' }],
    runtime,
    signal: new AbortController().signal,
    ...over,
  };
}

test('纯增量 delta 两次“哈”累积为“哈哈”；未知工具名不归为 read_material', () => {
  assert.equal(accumulatePartial('', '哈'), '哈');
  assert.equal(accumulatePartial('哈', '哈'), '哈哈');
  assert.equal(accumulatePartial('哈哈', ''), '哈哈');
  const mapped = mapRunnerToolEvent({
    name: 'read_material',
    materialId: 'snap-1',
    materialName: '通知.txt',
    range: { startLine: 1, endLine: 2 },
    status: 'success',
    success: true,
  });
  for(const suffix of ['read_material','read_draft','read_skill','write_artifact'])assert.equal(mapRunnerToolEvent({name:'custom_abcd_'+suffix,status:'success',success:true})?.toolKind,'custom_mcp');
  assert.equal(mapped?.materialId, 'snap-1');
  assert.equal(mapped?.toolKind, 'read_material');
  assert.equal(mapped?.filename, '通知.txt');
  assert.equal(mapped?.readRange, '1-2');
  assert.equal(mapRunnerToolEvent({
    name: 'write_artifact',
    artifactName: 'result.json',
    status: 'success',
    success: true,
  })?.toolKind, 'write_artifact');
  assert.equal(mapRunnerToolEvent({
    name: 'bash',
    status: 'success',
    success: true,
  }), null);
  assert.equal(mapRunnerToolEvent({
    name: 'read',
    materialId: 'snap-1',
    status: 'success',
    success: true,
  }), null);
});

test('适配器把 Host 输入映射到 Runner：review 不带主讨论，draft 分节，产物读文件不取最后一句', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-adapt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshotDir = path.join(root, 'snapshot');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(path.join(snapshotDir, 'materials', 'snap-1'), { recursive: true });
  await fs.writeFile(path.join(snapshotDir, 'materials', 'snap-1', '通知.txt'), '通知正文');
  const json = '{"kind":"analysis","opinions":[],"strategies":[]}';
  const captured: AgentRunInput[] = [];
  const events: AgentHostRunEvent[] = [];
  const run = createHostRun({
    async run(input) {
      captured.push(input);
      input.onEvent({ type: 'delta', text: '哈' });
      input.onEvent({ type: 'delta', text: '哈' });
      input.onEvent({
        type: 'tool',
        event: { name: 'read_material', materialId: 'snap-1', materialName: '通知.txt', status: 'success', success: true, range: { startLine: 1, endLine: 2 } },
      });
      input.onEvent({ type: 'tool', event: { name: 'bash', status: 'success', success: true } });
      const outputs = path.join(input.localRunDirectory, 'outputs');
      await fs.mkdir(outputs, { recursive: true });
      const abs = path.join(outputs, PREFERRED_ARTIFACT);
      await fs.writeFile(abs, json);
      const hash = createHash('sha256').update(json).digest('hex');
      return {
        status: 'completed',
        finalText: '模型口头说已完成。',
        toolEvents: [],
        artifact: { name: PREFERRED_ARTIFACT, relativePath: PREFERRED_ARTIFACT, absolutePath: abs, hash, bytes: Buffer.byteLength(json) },
      } satisfies AgentRunResult;
    },
  });
  const handle = await Promise.resolve(run(hostInput({
    snapshotDir,
    outputDir,
    action: 'review',
    draft: { id: 'dv1', text: '稿正文', amendmentText: '改', applicationParts:{CLAIMS:'完整版本中的标记CLAIM_79'}, amendmentBasis: '说明书第0018段' },
    onEvent: event => { events.push(event); },
  })));
  await handle.wait;
  assert.equal(captured[0].review, true);
  assert.deepEqual(captured[0].publicMessages, []);
  assert.match(captured[0].draftText ?? '', /稿件版本：dv1/);
  assert.match(captured[0].draftText ?? '', /完整版本中的标记CLAIM_79/);
  assert.match(captured[0].draftText ?? '', /## 修改依据/);
  assert.match(captured[0].draftText ?? '', /说明书第0018段/);
  assert.equal(captured[0].productPrompt, 'product-prompt');
  assert.equal(captured[0].allowedArtifacts?.[0], PREFERRED_ARTIFACT);
  assert.equal(captured[0].materials[0].id, 'snap-1');
  const completed = events.find(item => item.type === 'completed');
  assert.equal(completed && completed.type === 'completed' ? completed.outputText : '', json);
  assert.equal(events.some(item => item.type === 'completed' && 'outputText' in item && item.outputText === '模型口头说已完成。'), false);
  const lastPartial = events.filter(item => item.type === 'partial').at(-1);
  assert.equal(lastPartial && lastPartial.type === 'partial' ? lastPartial.text : '', '哈哈');
  assert.equal(events.filter(item => item.type === 'tool').length, 1);
  assert.equal(await fs.readFile(path.join(outputDir, PREFERRED_ARTIFACT), 'utf8'), json);
});

test('产物只认 engine/outputs/result.json；Host 输出不覆盖已有不同内容', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-adapt-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine');
  const outputs = path.join(engine, 'outputs');
  await fs.mkdir(outputs, { recursive: true });
  const json = '{"kind":"analysis"}';
  const abs = path.join(outputs, PREFERRED_ARTIFACT);
  await fs.writeFile(abs, json);
  const hash = createHash('sha256').update(json).digest('hex');
  const ok = await readVerifiedArtifact({
    name: PREFERRED_ARTIFACT,
    relativePath: PREFERRED_ARTIFACT,
    absolutePath: abs,
    hash,
    bytes: Buffer.byteLength(json),
  }, outputs);
  assert.equal(ok, json);
  const escaped = path.join(engine, PREFERRED_ARTIFACT);
  await fs.writeFile(escaped, json);
  await assert.rejects(readVerifiedArtifact({
    name: PREFERRED_ARTIFACT,
    relativePath: PREFERRED_ARTIFACT,
    absolutePath: escaped,
    hash,
    bytes: Buffer.byteLength(json),
  }, outputs), /不受控|产物/);
  await assert.rejects(readVerifiedArtifact({
    name: PREFERRED_ARTIFACT,
    relativePath: '../result.json',
    absolutePath: escaped,
    hash,
    bytes: Buffer.byteLength(json),
  }, outputs), /产物/);
  await assert.rejects(readVerifiedArtifact({
    name: PREFERRED_ARTIFACT,
    relativePath: PREFERRED_ARTIFACT,
    absolutePath: abs,
    hash: 'deadbeef',
    bytes: Buffer.byteLength(json),
  }, outputs), /哈希/);

  const outputDir = path.join(root, 'output');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, PREFERRED_ARTIFACT), '旧内容不能覆盖');
  await writeHostRunOutput(outputDir, 'run-safe', json);
  assert.equal(await fs.readFile(path.join(outputDir, PREFERRED_ARTIFACT), 'utf8'), '旧内容不能覆盖');
  assert.equal(await fs.readFile(path.join(outputDir, 'run-safe.result.json'), 'utf8'), json);
});

test('无产物失败；读产物后若已中断则不发 completed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-adapt-fail-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshotDir = path.join(root, 'snapshot');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(snapshotDir, { recursive: true });
  const events: AgentHostRunEvent[] = [];
  const missing = createHostRun({
    async run() {
      return { status: 'completed', finalText: '{"kind":"analysis"}', toolEvents: [] };
    },
  });
  await (await Promise.resolve(missing(hostInput({ snapshotDir, outputDir, onEvent: event => { events.push(event); } })))).wait;
  assert.equal(events.at(-1)?.type, 'failed');

  events.length = 0;
  const abort = new AbortController();
  const late = createHostRun({
    async run(input) {
      const outputs = path.join(input.localRunDirectory, 'outputs');
      await fs.mkdir(outputs, { recursive: true });
      const file = path.join(outputs, PREFERRED_ARTIFACT);
      const json = '{"kind":"analysis"}';
      await fs.writeFile(file, json);
      abort.abort();
      return {
        status: 'completed',
        finalText: json,
        toolEvents: [],
        artifact: {
          name: PREFERRED_ARTIFACT,
          relativePath: PREFERRED_ARTIFACT,
          absolutePath: file,
          hash: createHash('sha256').update(json).digest('hex'),
          bytes: Buffer.byteLength(json),
        },
      };
    },
  });
  await (await Promise.resolve(late(hostInput({ snapshotDir, outputDir, signal: abort.signal, onEvent: event => { events.push(event); } })))).wait;
  assert.equal(events.some(item => item.type === 'completed'), false);
  assert.equal(events.at(-1)?.type, 'stopped');
});

test('捆绑路径只看产品 resources 与明确 .lab 路径，不读 PATH；非 mac/win 明确失败', async t => {
  assert.throws(() => bundledOpenCodePath({
    resourcesPath: '/tmp/missing-resources',
    appPath: '/tmp/missing-app',
    platform: 'linux',
  }), /尚未捆绑 OpenCode 运行时/);
  assert.throws(() => bundledOpenCodePath({
    resourcesPath: '/tmp/missing-resources',
    appPath: '/tmp/missing-app',
    platform: 'darwin',
    arch: 'arm64',
  }), /未捆绑 OpenCode 运行时/);
  const appPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lab-runtime-'));
  t.after(() => fs.rm(appPath, { recursive: true, force: true }));
  const nested = path.join(appPath, LAB_RUNTIME_RELATIVE, 'darwin-arm64');
  await fs.mkdir(nested, { recursive: true });
  const binary = path.join(nested, 'opencode');
  await fs.writeFile(binary, 'fake');
  assert.equal(bundledOpenCodePath({
    resourcesPath: '/tmp/missing-resources',
    appPath,
    platform: 'darwin',
    arch: 'arm64',
  }), binary);
  assert.equal(replyRulesRoot('/app'), path.join('/app', 'resources', 'reply-rules'));
  assert.equal(draftTextForRunner(undefined), undefined);
});

test('createHostRun 注入 readMaterial：只读冻结快照，捕获 abort，不改 Runner 合同', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-read-material-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshotDir = path.join(root, 'snapshot');
  const outputDir = path.join(root, 'output');
  const file = path.join(snapshotDir, 'materials', 'snap-1', '通知.txt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = Buffer.from('通知正文中文\n第二行');
  await fs.writeFile(file, body);
  const hash = digest(body);
  const ac = new AbortController();
  let seen: AgentRunInput | undefined;
  const run = createHostRun({
    async run(input) {
      seen = input;
      const readMaterial = input.readMaterial;
      assert.equal(typeof readMaterial, 'function');
      if (!readMaterial) throw new Error('missing readMaterial');
      const contents = await readMaterial({
        material: {
          id: 'snap-1',
          name: '通知.txt',
          role: '当前通知',
          relativePath: 'materials/snap-1/通知.txt',
          absoluteSnapshotPath: file,
          hash,
        },
      });
      assert.equal(contents?.[0]?.type, 'text');
      if (contents?.[0]?.type === 'text') {
        assert.match(contents[0].text, /通知正文中文/);
        assert.match(contents[0].text, /format: text/);
        assert.equal(contents[0].startLine, 1);
        assert.equal(contents[0].endLine, 2);
      }
      ac.abort();
      await assert.rejects(readMaterial({
        material: {
          id: 'snap-1',
          name: '通知.txt',
          role: '当前通知',
          relativePath: 'materials/snap-1/通知.txt',
          absoluteSnapshotPath: file,
          hash,
        },
      }), /取消/);
      return { status: 'aborted', finalText: '', toolEvents: [] };
    },
  });
  await (await Promise.resolve(run(hostInput({
    snapshotDir,
    outputDir,
    signal: ac.signal,
    materials: [{
      id: 'snap-1',
      name: '通知.txt',
      role: '当前通知',
      relativePath: 'materials/snap-1/通知.txt',
      hash,
      snapshotPath: file,
    }],
    onEvent() {},
  })))).wait;
  assert.equal(typeof seen?.readMaterial, 'function');
  assert.equal(Object.keys(seen ?? {}).includes('readMaterial'), true);
});
