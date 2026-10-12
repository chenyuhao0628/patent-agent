import mammoth from 'mammoth';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DesktopService } from './service.ts';
import {initializeDiagnostics,stopDiagnostics} from './diagnostics.ts';
import { AgentHost, type AgentHostRun, type AgentHostRunInput } from './agent-host.ts';
import type { AgentModelService } from './agent-host.ts';
import type { Case } from '../src/domain/workflow.ts';
import type { RuntimeModelConfig } from './model-service.ts';
import type { ModelConfigPublic } from '../src/domain/models.ts';
import { currentDraft } from '../src/domain/agent.ts';

const rulesRoot = fileURLToPath(new URL('../resources/reply-rules', import.meta.url));

function serial() {
  let gate = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = gate.then(fn, fn);
    gate = run.then(() => undefined, () => undefined);
    return run;
  };
}

function vault() {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: (s: string) => {
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]);
    },
    decrypt: (b: Buffer) => {
      const c = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      c.setAuthTag(b.subarray(-16));
      return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString();
    },
  };
}

function modelStub(box?: { modelId: string; providerName: string }): AgentModelService {
  const current = box ?? { modelId: 'deepseek-v4.1-flash', providerName: 'OpenCode Go' };
  const listed = (): ModelConfigPublic => ({
    profileKey: 'local',
    defaultProviderId: 'p',
    defaultModelId: 'm',
    providers: [{
      id: 'p', name: current.providerName, baseURL: 'https://example.invalid', protocol: 'openai-responses', hasKey: true,
      models: [{
        id: 'm', modelId: current.modelId, displayName: 'Flash', protocol: 'openai-responses',
        contextWindowSource: 'missing', maxOutputSource: 'missing',
        reasoning: { capability: { supported: true, kind: 'openai-effort', levels: [], allowBudget: false, allowAdaptive: false, allowOff: false, allowIncludeThoughts: false, allowOutputEffort: false, outputEfforts: [], source: 'preset', unverified: false }, selection: { levelId: 'vendor-default', overridden: false } },
      }],
    }],
  });
  return {
    async list(profileKey) { return { ...listed(), profileKey }; },
    async resolveRuntimeConfig(profileKey, conversationId): Promise<RuntimeModelConfig> {
      return {
        profileKey, providerId: 'p', providerName: current.providerName, baseURL: 'https://example.invalid',
        protocol: 'openai-responses', modelId: current.modelId, displayName: 'Flash',
        key: 'memory-only-key', headers: { 'x-opencode-session': conversationId },
        reasoning: { levelId: 'vendor-default', protocol: 'openai-responses', request: {}, omitted: false, unverified: false, source: 'preset' },
      };
    },
  };
}

function analysisJson() {
  return JSON.stringify({
    kind: 'analysis',
    opinions: [{ id: 'o1', title: '创造性', summary: '意见1', basis: '通知.txt' }],
    strategies: [
      { id: 's1', title: '争辩', summary: '维持', benefits: '范围大', risks: '风险', basis: '申请.txt' },
      { id: 's2', title: '修改', summary: '补特征', benefits: '稳妥', risks: '收窄', basis: '申请.txt' },
    ],
  });
}

function draftJson(strategyId = 's2') {
  return JSON.stringify({
    kind: 'draft', strategyId,
    body: '尊敬的审查员：\n意见陈述。',
    amendmentText: '1. 一种装置。',
    applicationParts:{CLAIMS:'1. 一种装置。',DESCRIPTION:'一种装置\n技术领域\n本方案涉及检测装置。'},
    amendmentBasis: '说明书记载限位件。',
    reviewNotes: '未见必须处理事项。',
  });
}

type RunnerCtl = {
  quality?: import('../src/domain/agent-evidence.ts').ArtifactQuality;
  starts: number;
  last?: AgentHostRunInput;
  gate?: Promise<void>;
  aborts?: number;
  skipReads?: boolean;
  lateCompleteAfterAbort?: boolean;
  latePartialAfterAbort?: boolean;
};

function mockRunner(ctl: RunnerCtl): AgentHostRun {
  return input => {
    ctl.starts += 1;
    ctl.last = input;
    const wait = (async () => {
      const aborted = new Promise<void>(resolve => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (ctl.gate) await Promise.race([ctl.gate, aborted]);
      if (input.signal.aborted) {
        await input.onEvent({ type: 'stopped' });
        if (ctl.latePartialAfterAbort) {
          await input.onEvent({ type: 'partial', text: '迟到部分-不应出现' });
        }
        if (ctl.lateCompleteAfterAbort) {
          const text = analysisJson();
          await fs.writeFile(path.join(input.outputDir, 'result.json'), text);
          await input.onEvent({ type: 'completed', outputText: text });
        }
        return;
      }
      await input.onEvent({ type: 'partial', text: '思考中' });
      if (!ctl.skipReads) {
        for (const material of input.materials) {
          await fs.readFile(material.snapshotPath);
          await input.onEvent({ type: 'tool', filename: material.name, readRange: '1-2', status: 'ok', materialId: material.id, toolKind: 'read_material' });
        }
        if (input.action === 'review' && input.draft) {
          await input.onEvent({ type: 'tool', filename: '当前稿', readRange: '全文', status: 'ok', toolKind: 'read_draft' });
        }
      }
      const text = input.action === 'analysis' ? analysisJson()
        : input.action === 'draft' ? draftJson()
          : input.action === 'review' ? JSON.stringify({ kind: 'review', draftVersionId: input.draft?.id, summary: '未见必须处理的问题。', issues: [] })
            : JSON.stringify({ kind: 'discuss', reply: '可以讨论期限。' });
      await fs.writeFile(path.join(input.outputDir, 'result.json'), text);
      if(ctl.quality)await input.onEvent({type:'quality',quality:ctl.quality});
      await input.onEvent({ type: 'completed', outputText: text });
    })();
    return {
      wait,
      abort() { ctl.aborts = (ctl.aborts ?? 0) + 1; },
    };
  };
}

async function prepareCase(service: DesktopService, number: string, extra?: { symlink?: boolean }) {
  await service.settings('local', { provider: '', baseUrl: '', model: '', originalLibrary: service.workspace.settings.originalLibrary, workRoot: service.workspace.settings.workRoot });
  await service.createCase({ title: '夹持装置' + number, number, kind: 'write' });
  const c = service.workspace.cases.find(item => item.number === number)!;
  const notice = await service.files().writeMaterial(c, '01_通知与材料', 'notice-' + number, '通知.txt', Buffer.from('通知正文' + number));
  const app = await service.files().writeMaterial(c, '00_原始申请', 'app-' + number, '申请.txt', Buffer.from('申请正文' + number));
  const materials = [
    { id: 'n-' + number, name: '通知.txt', role: '当前通知', location: '', excerpt: '', ready: true, relativePath: notice.relativePath },
    { id: 'a-' + number, name: '申请.txt', role: '原始申请', location: '', excerpt: '', ready: true, relativePath: app.relativePath },
  ];
  if (extra?.symlink) {
    const root = await service.casePath(c.id);
    await fs.symlink(path.join(root, app.relativePath), path.join(root, '01_通知与材料', 'escape.txt'));
    materials.push({ id: 'link-' + number, name: 'escape.txt', role: '其他', location: '', excerpt: '', ready: true, relativePath: '01_通知与材料/escape.txt' });
  }
  c.materials = materials;
  c.rounds = [{
    id: 'r-' + number, name: '第一次审查意见', stage: 'materials', confirmed: false, materials, strategy: null, draft: '',
    versions: [], discussions: [{ id: 'd-' + number, title: '主', messages: [] }], review: null, job: null, final: null, finalHistory: [],
  }];
  c.current = { kind: 'reply', roundId: 'r-' + number };
  c.localDraft = c.localDraft ?? '';
  await service.persist();
  return c;
}

function holdableSerial() {
  const base = serial();
  let gate: Promise<void> | null = null;
  let unlock = () => {};
  return {
    hold() { gate = new Promise<void>(resolve => { unlock = resolve; }); },
    release() { unlock(); gate = null; },
    serialize<T>(fn: () => Promise<T>) {
      return base(async () => {
        if (gate) await gate;
        return fn();
      });
    },
  };
}

async function setup(t: test.TestContext, runnerCtl?: RunnerCtl, over?: {
  run?: AgentHostRun;
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
  model?: AgentModelService;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originals = path.join(root, 'lib'), work = path.join(root, 'work');
  await fs.mkdir(originals); await fs.mkdir(work);
  const service = new DesktopService(root, vault());
  await service.init();
  await service.settings('local', { provider: '', baseUrl: '', model: '', originalLibrary: originals, workRoot: work });
  const ctl = runnerCtl ?? { starts: 0, aborts: 0 };
  const host = new AgentHost({
    desktopService: service,
    modelService: over?.model ?? modelStub(),
    serialize: over?.serialize ?? serial(),
    rulesRoot,
    run: over?.run ?? mockRunner(ctl),
  });
  return { root, service, host, work, ctl };
}

const classify = { patentType: '发明' as const, noticeCategory: '审查意见通知书' as const, officeActionRound: 1, correctionBasis: 'original' as const };

test('task memory and quality persist while late quality cannot overwrite a settled reply job', async t => {
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  t.after(()=>release());
  const {root,service,host,ctl}=await setup(t,{starts:0,gate});
  const c=await prepareCase(service,'MEMORY');
  await readyAnalysis(host,c.id,['n-MEMORY','a-MEMORY']);
  await host.command('local',c.id,{type:'run',action:'analysis',userMessage:'只能修改权利要求3，不得改变权利要求1'});
  const input=ctl.last!;
  const frozen=JSON.parse(await fs.readFile(path.join(input.snapshotDir,'task-memory.json'),'utf8'));
  assert.deepEqual(frozen,JSON.parse(JSON.stringify(input.taskMemory)));
  assert(frozen.entries.some((e:{text:string})=>e.text==='只能修改权利要求3，不得改变权利要求1'));
  const quality={schema:1 as const,materials:[],citations:[],issues:[{code:'CITATIONS_NOT_STRUCTURED',severity:'warning' as const,message:'合成核对提示'}]};
  await input.onEvent({type:'quality',quality});
  release();await host.waitIdle();
  let view=await host.getCase('local',c.id);
  const saved=view.process.jobs.find(j=>j.runId===input.runId)!;
  assert.equal(saved.state,'completed');assert.deepEqual(saved.quality,quality);
  assert(saved.memory?.entries.some(e=>e.preview.includes('不得改变权利要求1')));
  const disk=JSON.parse(await fs.readFile(path.join(root,'profiles/local/agent/state.json'),'utf8'));
  assert(JSON.stringify(disk).includes('合成核对提示'));
  await input.onEvent({type:'quality',quality:{...quality,issues:[]}});await host.waitIdle();
  view=await host.getCase('local',c.id);
  assert.deepEqual(view.process.jobs.find(j=>j.runId===input.runId)?.quality,quality);
});

async function readyAnalysis(host: AgentHost, caseId: string, ids: string[]) {
  await host.command('local', caseId, { type: 'classify', classification: classify });
  await host.command('local', caseId, { type: 'materials', selectedIds: ids });
}

test('材料快照核验 hash 并拒绝符号链接；跨案材料不会进入另一案 run', async t => {
  const { service, host, ctl } = await setup(t);
  const a = await prepareCase(service, 'A1', { symlink: true });
  const b = await prepareCase(service, 'B1');
  await host.command('local', a.id, { type: 'classify', classification: { patentType: '发明', noticeCategory: '审查意见通知书', officeActionRound: 1, correctionBasis: 'original' } });
  await host.command('local', a.id, { type: 'materials', selectedIds: ['n-A1', 'a-A1'] });
  await host.command('local', a.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  assert.equal(ctl.starts, 1);
  assert.equal(ctl.last?.materials.some(item => item.id.startsWith('n-B') || item.relativePath?.includes('B1') || item.id.includes('..')), false);
  assert.equal(ctl.last?.runtime.key, 'memory-only-key');
  const manifest = JSON.parse(await fs.readFile(path.join(ctl.last!.snapshotDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.key, undefined);
  assert.equal(JSON.stringify(manifest).includes('memory-only-key'), false);
  for (const item of ctl.last!.materials) {
    assert.match(item.id, /^mat_[0-9a-f]{32}$/i);
    assert.equal(item.relativePath.includes('..'), false);
    assert.equal(item.snapshotPath.includes(`materials/${item.id}/`), true);
    assert.ok(manifest.ids[item.id] === 'n-A1' || manifest.ids[item.id] === 'a-A1');
    assert.equal(item.id === 'n-A1' || item.id === 'a-A1', false);
  }
  assert.ok(Object.values(manifest.ids).includes('n-A1'));
  assert.ok(Object.values(manifest.ids).includes('a-A1'));
  assert.equal(manifest.model.modelId, 'deepseek-v4.1-flash');
  assert.equal(manifest.model.providerName, 'OpenCode Go');
  await host.command('local', a.id, { type: 'materials', selectedIds: ['link-A1'] });
  await assert.rejects(host.command('local', a.id, { type: 'run', action: 'analysis' }), /符号链接|材料/);
});

test('同案 busy、两案并行、停止后迟到结果不推进', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctl: RunnerCtl = { starts: 0, gate, aborts: 0 };
  const { service, host } = await setup(t, ctl);
  const a = await prepareCase(service, 'P1');
  const b = await prepareCase(service, 'P2');
  const classify = { patentType: '发明' as const, noticeCategory: '审查意见通知书' as const, officeActionRound: 1, correctionBasis: 'original' as const };
  await host.command('local', a.id, { type: 'classify', classification: classify });
  await host.command('local', b.id, { type: 'classify', classification: classify });
  await host.command('local', a.id, { type: 'materials', selectedIds: ['n-P1', 'a-P1'] });
  await host.command('local', b.id, { type: 'materials', selectedIds: ['n-P2', 'a-P2'] });
  const first = await host.command('local', a.id, { type: 'run', action: 'analysis' });
  assert.equal(first.busy, true);
  await assert.rejects(host.command('local', a.id, { type: 'run', action: 'discuss', userMessage: '插话' }), /进行中/);
  const second = await host.command('local', b.id, { type: 'run', action: 'analysis' });
  assert.equal(second.busy, true);
  assert.equal(ctl.starts, 2);
  const stopping = await host.command('local', a.id, { type: 'stop' });
  assert.equal(ctl.aborts, 1);
  assert.equal(stopping.busy, true);
  const busySeen: boolean[] = [];
  const off = host.onState(view => { if (view.caseId === a.id) busySeen.push(view.busy); });
  release();
  await host.waitIdle();
  off();
  const after = await host.getCase('local', a.id);
  assert.equal(after.process.jobs.at(-1)?.state, 'stopped');
  assert.equal(after.busy, false);
  assert.equal(after.process.analysis, null);
  assert.equal(after.partialText, undefined);
  assert.equal(busySeen.at(-1), false);
  const bView = await host.getCase('local', b.id);
  assert.equal(bView.process.analysis?.strategies.length, 2);
});

test('A-B-A 世代变化拒绝迟到结果；运行中人工稿可保存', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctl = { starts: 0, gate };
  const { service, host } = await setup(t, ctl);
  const a = await prepareCase(service, 'G1');
  await host.command('local', a.id, { type: 'classify', classification: { patentType: '发明', noticeCategory: '审查意见通知书', officeActionRound: 1, correctionBasis: 'original' } });
  await host.command('local', a.id, { type: 'materials', selectedIds: ['n-G1', 'a-G1'] });
  await host.command('local', a.id, { type: 'run', action: 'analysis' });
  const ws = structuredClone(service.workspace);
  const row = ws.cases.find(item => item.id === a.id)!;
  row.localDraft = '运行中人工修改';
  await service.save('local', ws);
  service.generation += 1;
  release();
  await host.waitIdle();
  const view = await host.getCase('local', a.id);
  assert.equal(view.process.jobs.at(-1)?.state, 'failed');
  assert.match(view.process.jobs.at(-1)?.error ?? '', /世代|过期/);
  assert.equal(view.process.analysis, null);
  assert.ok(view.process.drafts.some(item => item.text === '运行中人工修改') || service.findCase(a.id).localDraft === '运行中人工修改');
});

test('案件级 Agent history returns prior process states without account-wide tasks', async t => {
  const { service, host } = await setup(t);
  const c = await prepareCase(service, 'HISTORY-1');
  const first = await host.getCase('local', c.id);
  service.findCase(c.id).current = { kind: 'reply', roundId: 'reply-history' };
  await host.getCase('local', c.id);
  const history = await host.history('local', c.id);
  assert.deepEqual(new Set(history.map(state => state.scope.processKey)), new Set([first.processKey, 'reply-history']));
  assert.equal(history.every(state => state.scope.caseId === c.id), true);
});

test('案件级 Agent history is read-only and does not create the current process', async t => {
  const { service, host, root } = await setup(t);
  const c = await prepareCase(service, 'HISTORY-READ');
  assert.deepEqual(await host.history('local', c.id), []);
  await assert.rejects(fs.access(path.join(root, 'profiles', 'local', 'agent', 'state.json')), /ENOENT/);
});

test('current round materials take precedence over same-ID common copies in views and frozen task inputs',async t=>{
  const {service,host,ctl}=await setup(t);
  const c=await prepareCase(service,'ROUND-MATERIAL');
  const material=c.materials![0];
  const copy=await service.files().writeMaterial(c,'01_通知与材料','updated-notice','current.txt',Buffer.from('Current round notice'));
  c.rounds[0].materials=c.rounds[0].materials.map(m=>m.id===material.id?{...m,name:'current.txt',relativePath:copy.relativePath}:m);
  const view=await host.getCase('local',c.id);
  assert.equal(view.process.materials.filter(m=>m.id===material.id).length,1);
  assert.equal(view.process.materials.find(m=>m.id===material.id)?.relativePath,copy.relativePath);
  await readyAnalysis(host,c.id,[material.id]);
  await host.command('local',c.id,{type:'run',action:'discuss',userMessage:'Check the current notice'});
  await host.waitIdle();
  const frozen=ctl.last!.materials.find(m=>m.name==='current.txt');
  assert.ok(frozen);
  assert.equal(await fs.readFile(frozen.snapshotPath,'utf8'),'Current round notice');
});

test('initial task persistence failure never reserves a live slot or prevents retry', async t => {
  const { service, host, ctl } = await setup(t);
  const c = await prepareCase(service, 'START-PERSIST');
  await readyAnalysis(host, c.id, ['n-START-PERSIST', 'a-START-PERSIST']);
  const internal = host as unknown as {
    persistStore: (...args: unknown[]) => Promise<void>;
    live: Map<string, unknown>;
  };
  const failing = t.mock.method(internal, 'persistStore', async () => {
    throw new Error('Synthetic disk failure before dispatch');
  });
  await assert.rejects(host.command('local', c.id, { type: 'run', action: 'analysis' }), /Synthetic disk failure/);
  assert.equal(ctl.starts, 0);
  assert.equal(internal.live.size, 0);
  failing.mock.restore();
  const failed = await host.getCase('local', c.id);
  assert.equal(failed.busy, false);
  assert.equal(failed.process.jobs.at(-1)?.state, 'failed');
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  assert.equal(ctl.starts, 1);
  assert.equal((await host.getCase('local', c.id)).process.jobs.at(-1)?.state, 'completed');
});

test('策略门、独立复核、定稿 Word、采用冲突与成果索引隔离', async t => {
  const { service, host, root, ctl } = await setup(t);
  const c = await prepareCase(service, 'F1');
  await host.command('local', c.id, { type: 'classify', classification: { patentType: '发明', noticeCategory: '审查意见通知书', officeActionRound: 1, correctionBasis: 'original' } });
  await host.command('local', c.id, { type: 'materials', selectedIds: ['n-F1', 'a-F1'] });
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  await assert.rejects(host.command('local', c.id, { type: 'run', action: 'draft' }), /策略/);
  await host.command('local', c.id, { type: 'strategy', strategyId: 's2' });
  await host.command('local', c.id, { type: 'run', action: 'draft' });
  await host.waitIdle();
  let view = await host.getCase('local', c.id);
  const pending = view.process.drafts.find(item => item.adoptStatus === 'pending')!;
  const conflictWs = structuredClone(service.workspace);
  const conflictRow = conflictWs.cases.find(item => item.id === c.id)!;
  conflictRow.localDraft = '采用前又改了人工稿';
  await service.save('local', conflictWs);
  await assert.rejects(host.command('local', c.id, { type: 'adopt', versionId: pending.id }), /哈希|材料|未覆盖/);
  assert.equal(service.findCase(c.id).localDraft, '采用前又改了人工稿');
  const c2 = await prepareCase(service, 'F2');
  await host.command('local', c2.id, { type: 'classify', classification: { patentType: '发明', noticeCategory: '审查意见通知书', officeActionRound: 1, correctionBasis: 'original' } });
  await host.command('local', c2.id, { type: 'materials', selectedIds: ['n-F2', 'a-F2'] });
  await host.command('local', c2.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  await host.command('local', c2.id, { type: 'strategy', strategyId: 's2' });
  await host.command('local', c2.id, { type: 'run', action: 'draft' });
  await host.waitIdle();
  view = await host.getCase('local', c2.id);
  const okPending = view.process.drafts.find(item => item.adoptStatus === 'pending')!;
  await host.command('local', c2.id, { type: 'adopt', versionId: okPending.id });
  const reviewSource=(await host.reviewSources('local')).find(s=>s.caseId===c2.id)!;assert.equal(reviewSource.files.length,2);assert(reviewSource.files.every(f=>f.hash));assert.equal(reviewSource.supersededAt,undefined);
  const scopedSources=await host.reviewSources('local',c2.id);assert.equal(scopedSources.length,1);assert.equal(scopedSources[0].caseId,c2.id);
  ctl.quality={schema:1,materials:[],citations:[],issues:[{code:'CITATIONS_NOT_STRUCTURED',severity:'warning',message:'复核来源提示'}]};
  view = await host.getCase('local', c2.id);
  await host.command('local', c2.id, { type: 'run', action: 'review' });
  await host.waitIdle();
  view = await host.getCase('local', c2.id);
  assert.ok(view.process.discussions.some(item => item.kind === 'review'));
  const report=(await host.reviewSources('local',c2.id))[0].reports![0];
  assert.deepEqual(report.quality,ctl.quality);
  assert.deepEqual(report.memory,view.process.jobs.find(j=>j.action==='review')!.memory);
  assert(report.memory?.entries.some(e=>e.kind==='version'));
  await host.command('local', c2.id, { type: 'finalize' });
  view = await host.getCase('local', c2.id);
  assert.equal(view.process.stage, 'final');
  const caseRoot = await service.casePath(c2.id);
  async function findNamed(dir: string, name: string): Promise<string> {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === name) {
        const parent = 'parentPath' in entry ? String(entry.parentPath) : dir;
        return path.join(parent, entry.name);
      }
    }
    throw new Error('missing ' + name);
  }
  const bodyFile = await findNamed(path.join(caseRoot, '03_定稿'), '意见陈述书.docx');
  assert.match((await mammoth.extractRawText({buffer:await fs.readFile(bodyFile)})).value,/尊敬的审查员/);
  const adopted=view.process.drafts.find(item=>item.id===view.process.currentDraftVersionId)!;
  const claims=await findNamed(path.join(caseRoot,'03_定稿'),'权利要求书.docx');
  assert.equal((await mammoth.extractRawText({buffer:await fs.readFile(claims)})).value.trim(),adopted.applicationParts!.CLAIMS);
  assert.equal(view.process.finalized?.word.generated,true);
  assert.ok(view.artifacts.some(item=>item.relativePath.endsWith('修改依据.docx')));
  assert.ok(view.artifacts.filter(item=>item.kind.startsWith('final-')).every(item=>item.relativePath.endsWith('.docx')));
  for (const name of await fs.readdir(path.join(caseRoot, '04_内部说明'))) {
    if (!name.startsWith('agent-run-')) continue;
    const index = JSON.parse(await fs.readFile(path.join(caseRoot, '04_内部说明', name), 'utf8'));
    assert.equal(index.profileKey, 'local');
    assert.equal(JSON.stringify(index).includes('memory-only-key'), false);
    assert.equal(JSON.stringify(index).includes('messages'), false);
  }
  const foreign = path.join(caseRoot, '04_内部说明', 'agent-run-foreign.json');
  await fs.writeFile(foreign, JSON.stringify({ schema: 1, caseId: c2.id, profileKey: 'other', processKey: view.processKey, runId: 'foreign', at: new Date().toISOString(), files: [] }));
  view = await host.getCase('local', c2.id);
  assert.equal(view.artifacts.some(item => item.id.includes('foreign')), false);
  await assert.rejects(host.getCase('other', c2.id), /账号已切换/);
  void root;
});

test('重开把 running 标为 stopped 且不自动请求', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctl = { starts: 0, gate };
  const { service, host, root } = await setup(t, ctl);
  const c = await prepareCase(service, 'R1');
  await host.command('local', c.id, { type: 'classify', classification: { patentType: '发明', noticeCategory: '审查意见通知书', officeActionRound: 1, correctionBasis: 'original' } });
  await host.command('local', c.id, { type: 'materials', selectedIds: ['n-R1', 'a-R1'] });
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.command('local', c.id, { type: 'stop' });
  release();
  await host.waitIdle();
  const restarted = new AgentHost({
    desktopService: service,
    modelService: modelStub(),
    serialize: serial(),
    rulesRoot,
    run: mockRunner({ starts: 0 }),
  });
  const view = await restarted.getCase('local', c.id);
  assert.equal(view.process.jobs.every(item => item.state !== 'running'), true);
  assert.equal(ctl.starts, 1);
  void root;
});

test('并发 get/command 都走同一队列，不会用共享 depth 抢写', async t => {
  let depth = 0;
  let overlapping = 0;
  let serializeCalls = 0;
  const base = serial();
  const serialize = <T>(fn: () => Promise<T>) => {
    serializeCalls += 1;
    return base(async () => {
      depth += 1;
      if (depth > 1) overlapping += 1;
      try { return await fn(); }
      finally { depth -= 1; }
    });
  };
  const { service, host } = await setup(t, undefined, { serialize });
  const c = await prepareCase(service, 'Q1');
  await Promise.all([
    host.getCase('local', c.id),
    host.command('local', c.id, { type: 'classify', classification: classify }),
    host.getCase('local', c.id),
    host.command('local', c.id, { type: 'discussion', title: '并行讨论' }),
  ]);
  assert.equal(serializeCalls, 4);
  assert.equal(overlapping, 0);
  const view = await host.getCase('local', c.id);
  assert.equal(view.process.classification.status, 'classified');
  assert.ok(view.process.discussions.some(item => item.title === '并行讨论'));
});

test('getCase 排队后 A-B-A 切回仍拒绝旧 generation，不泄漏旧 profile', async t => {
  const held = holdableSerial();
  const { service, host } = await setup(t, undefined, { serialize: held.serialize });
  const c = await prepareCase(service, 'ABA');
  await host.getCase('local', c.id);
  const leaked: string[] = [];
  host.onState(view => leaked.push(view.profileKey));
  held.hold();
  const queued = host.getCase('local', c.id);
  service.key = 'other';
  service.generation += 1;
  service.key = 'local';
  service.generation += 1;
  held.release();
  await assert.rejects(queued, /账号已切换/);
  assert.equal(leaked.includes('other'), false);
  const view = await host.getCase('local', c.id);
  assert.equal(view.profileKey, 'local');
});

test('Agent toView rejects account ABA across model metadata await without emitting the stale view', async t=>{
  const model=modelStub();
  let entered!:()=>void,release!:()=>void;
  const begun=new Promise<void>(resolve=>{entered=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  const list=model.list;
  model.list=async key=>{entered();await held;return list(key);};
  const {service,host}=await setup(t,undefined,{model});
  const c=await prepareCase(service,'VIEW-ABA');
  let emitted=0;host.onState(()=>emitted++);
  const pending=host.getCase('local',c.id);
  const rejected=assert.rejects(pending,/账号已切换/);
  await begun;
  service.key='other';service.generation++;service.key='local';service.generation++;
  release();await rejected;
  assert.equal(emitted,0);
});

test('Agent history reports damaged storage instead of an empty history or replacing the file',async t=>{
  const {service,host}=await setup(t),c=await prepareCase(service,'BROKEN');
  const folder=path.join(service.root,'profiles/local/agent');await fs.mkdir(folder,{recursive:true});
  const file=path.join(folder,'state.json');
  await fs.writeFile(file,'{"schema":1,"processes":');
  const bytes=await fs.readFile(file);
  await assert.rejects(host.history('local',c.id),/原记录已保留/);
  await assert.rejects(host.getCase('local',c.id),/原记录已保留/);
  await assert.rejects(host.reviewSources('local',c.id),/原记录已保留/);
  assert.deepEqual(await fs.readFile(file),bytes);
});

test('同账号同流程普通 save 不中断 Agent；profile/generation 变化才按账号 abort', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctl: RunnerCtl = { starts: 0, gate, aborts: 0 };
  const { service, host } = await setup(t, ctl);
  service.changed = () => host.noteAccountChange();
  const c = await prepareCase(service, 'NC1');
  await readyAnalysis(host, c.id, ['n-NC1', 'a-NC1']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  const ws = structuredClone(service.workspace);
  ws.cases.find(item => item.id === c.id)!.localDraft = '运行中普通保存';
  await service.save('local', ws);
  service.changed();
  host.noteAccountChange();
  assert.equal(host.hasRunningJobs(), true);
  assert.equal(ctl.aborts, 0);
  service.generation += 1;
  host.noteAccountChange();
  assert.equal(ctl.aborts, 1);
  release();
  await host.waitIdle();
  const view = await host.getCase('local', c.id);
  assert.equal(view.busy, false);
  assert.equal(view.process.jobs.at(-1)?.state, 'failed');
  assert.match(view.process.jobs.at(-1)?.error ?? '', /世代|过期|账号/);
});

test('startRun 抛错或 wait reject 必须清 busy 且允许重试，无未处理 rejection', async t => {
  const leaks: unknown[] = [];
  const onUnhandled = (reason: unknown) => { leaks.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  let impl: AgentHostRun = async () => { throw new Error('runner exploded'); };
  const { service, host } = await setup(t, undefined, { run: input => impl(input) });
  const c = await prepareCase(service, 'EX1');
  await readyAnalysis(host, c.id, ['n-EX1', 'a-EX1']);
  await assert.rejects(host.command('local', c.id, { type: 'run', action: 'analysis' }), /runner exploded/);
  let view = await host.getCase('local', c.id);
  assert.equal(view.busy, false);
  assert.equal(host.hasRunningJobs(), false);
  assert.equal(view.process.jobs.at(-1)?.state, 'failed');
  impl = () => ({
    wait: new Promise((_, reject) => setImmediate(() => reject(new Error('wait boom')))),
    abort() {},
  });
  const started = await host.command('local', c.id, { type: 'run', action: 'analysis' });
  assert.equal(started.busy, true);
  await host.waitIdle();
  view = await host.getCase('local', c.id);
  assert.equal(view.busy, false);
  assert.equal(view.process.jobs.at(-1)?.state, 'failed');
  const ctl: RunnerCtl = { starts: 0, aborts: 0 };
  impl = mockRunner(ctl);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  view = await host.getCase('local', c.id);
  assert.equal(view.busy, false);
  assert.equal(view.process.analysis?.strategies.length, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(leaks.length, 0);
});

test('stop 后晚到 completed 不覆盖产物；abort 句柄被调用；shutdown 可退出', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctl: RunnerCtl = { starts: 0, gate, aborts: 0, lateCompleteAfterAbort: true };
  const { service, host } = await setup(t, ctl);
  const c = await prepareCase(service, 'ST1');
  await readyAnalysis(host, c.id, ['n-ST1', 'a-ST1']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  const stopping = await host.command('local', c.id, { type: 'stop' });
  assert.equal(ctl.aborts, 1);
  assert.equal(stopping.busy, true);
  release();
  await host.waitIdle();
  const view = await host.getCase('local', c.id);
  assert.equal(view.busy, false);
  assert.equal(view.process.jobs.at(-1)?.state, 'stopped');
  assert.equal(view.process.analysis, null);
  await host.shutdown();
});

test('活动 run 的 model 冻结为启动时快照，manifest 同一份；下次任务才用新设置', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctl: RunnerCtl = { starts: 0, gate };
  const box = { modelId: 'deepseek-v4.1-flash', providerName: 'OpenCode Go' };
  const { service, host } = await setup(t, ctl, { model: modelStub(box) });
  const c = await prepareCase(service, 'MD1');
  await readyAnalysis(host, c.id, ['n-MD1', 'a-MD1']);
  const started = await host.command('local', c.id, { type: 'run', action: 'analysis' });
  assert.equal(started.model?.modelId, 'deepseek-v4.1-flash');
  box.modelId = 'other-model';
  box.providerName = 'Other Vendor';
  const during = await host.getCase('local', c.id);
  assert.equal(during.busy, true);
  assert.equal(during.model?.modelId, 'deepseek-v4.1-flash');
  assert.equal(during.model?.providerName, 'OpenCode Go');
  const manifest = JSON.parse(await fs.readFile(path.join(ctl.last!.snapshotDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.model.modelId, 'deepseek-v4.1-flash');
  assert.equal(manifest.model.providerName, 'OpenCode Go');
  release();
  await host.waitIdle();
  const after = await host.getCase('local', c.id);
  assert.equal(after.busy, false);
  assert.equal(after.model?.modelId, 'other-model');
  assert.equal(after.model?.providerName, 'Other Vendor');
});

test('材料 id 含穿越时快照落在 run 目录内，manifest 保存映射', async t => {
  const ctl: RunnerCtl = { starts: 0 };
  const { service, host, root } = await setup(t, ctl);
  const c = await prepareCase(service, 'ESC');
  c.materials = [
    ...(c.materials ?? []),
    { id: '../../../tmp/escape', name: '通知.txt', role: '其他', location: '', excerpt: '', ready: true, relativePath: c.materials![0].relativePath },
  ];
  await service.persist();
  await readyAnalysis(host, c.id, ['n-ESC', '../../../tmp/escape']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  assert.ok(ctl.last);
  for (const item of ctl.last!.materials) {
    assert.equal(item.id.includes('..'), false);
    assert.equal(path.resolve(item.snapshotPath).startsWith(path.resolve(ctl.last!.snapshotDir)), true);
    assert.equal(path.resolve(item.snapshotPath).includes(`${path.sep}..${path.sep}`), false);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(ctl.last!.snapshotDir, 'manifest.json'), 'utf8'));
  assert.ok(Object.values(manifest.ids).includes('../../../tmp/escape'));
  const escaped = path.join(ctl.last!.snapshotDir, '..', '..', '..', 'tmp', 'escape');
  await assert.rejects(fs.stat(escaped), /ENOENT/);
  void root;
});

test('定稿写入版本目录，不覆盖用户已编辑成果，索引可查看 Word', async t => {
  const { service, host } = await setup(t);
  const c = await prepareCase(service, 'FIN');
  await readyAnalysis(host, c.id, ['n-FIN', 'a-FIN']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  await host.command('local', c.id, { type: 'strategy', strategyId: 's2' });
  await host.command('local', c.id, { type: 'run', action: 'draft' });
  await host.waitIdle();
  let view = await host.getCase('local', c.id);
  const pending = view.process.drafts.find(item => item.adoptStatus === 'pending')!;
  await host.command('local', c.id, { type: 'adopt', versionId: pending.id });
  await host.command('local', c.id, { type: 'run', action: 'review' });
  await host.waitIdle();
  const caseRoot = await service.casePath(c.id);
  const userFinal = path.join(caseRoot, '03_定稿', view.processKey, '定稿正文.txt');
  await fs.mkdir(path.dirname(userFinal), { recursive: true });
  await fs.writeFile(userFinal, '用户已编辑的定稿，不能覆盖', { mode: 0o600 });
  await host.command('local', c.id, { type: 'finalize' });
  view = await host.getCase('local', c.id);
  assert.equal(await fs.readFile(userFinal, 'utf8'), '用户已编辑的定稿，不能覆盖');
  const generated=view.artifacts.find(item=>item.kind==='final-word'&&item.relativePath.endsWith('.docx'))!;
  assert.ok(generated);
  assert.match(generated.relativePath,/03_定稿[/\\].*[/\\].*用户定稿/);
  assert.notEqual(path.resolve(caseRoot,generated.relativePath),path.resolve(userFinal));
  assert.match((await mammoth.extractRawText({buffer:await fs.readFile(path.join(caseRoot,generated.relativePath))})).value,/尊敬的审查员/);
});

test('补正四字段编辑使复核失效，独立审查读取完整新版本；定稿只存表单记录与实际修改 Word',async t=>{
 const {service,host,ctl}=await setup(t);const c=await prepareCase(service,'COR');c.current!.kind='correction';await service.persist();
 await host.command('local',c.id,{type:'classify',classification:{...classify,noticeCategory:'补正通知书'}});
 await host.command('local',c.id,{type:'materials',selectedIds:['n-COR','a-COR']});
 await host.command('local',c.id,{type:'run',action:'analysis'});await host.waitIdle();
 await host.command('local',c.id,{type:'strategy',strategyId:'s2'});
 await host.command('local',c.id,{type:'run',action:'draft'});await host.waitIdle();
 let view=await host.getCase('local',c.id);const pending=view.process.drafts.find(d=>d.adoptStatus==='pending')!;
 await host.command('local',c.id,{type:'adopt',versionId:pending.id});
 await host.command('local',c.id,{type:'run',action:'review'});await host.waitIdle();
 await assert.rejects(host.command('local',c.id,{type:'finalize'}),/补正字段/);
 const items=[{FileName:'权利要求书',PositionInFile:'权利要求 1',CorrectionBefore:'一种装罝',CorrectionAfter:'一种装置'}];
 view=await host.command('local',c.id,{type:'correctionContents',items});
 assert.notEqual(view.process.currentDraftVersionId,pending.id);assert(view.process.reviews.every(r=>r.invalidated));
 assert.equal(view.process.drafts.find(d=>d.id===pending.id)!.correctionContents,undefined);
 const current=view.process.drafts.find(d=>d.id===view.process.currentDraftVersionId)!;
 assert.deepEqual(current.correctionContents,items);assert.deepEqual(current.applicationParts,pending.applicationParts);
 const source=(await host.reviewSources('local')).find(s=>s.caseId===c.id&&!s.supersededAt)!;assert.deepEqual(source.correctionContents,items);assert.equal(source.files.length,2);assert(source.files.every(f=>f.hash));
 await host.command('local',c.id,{type:'run',action:'review'});await host.waitIdle();assert.deepEqual(ctl.last!.draft!.correctionContents,items);assert(ctl.last!.prompt.combined.includes('一种装罝'));
 view=await host.command('local',c.id,{type:'finalize'});assert.equal(view.process.stage,'final');
 const finals=view.artifacts.filter(a=>a.kind.startsWith('final-'));
 assert(!finals.some(a=>a.kind==='final-word'||/补正说明\.docx$/.test(a.relativePath)));
 const form=finals.find(a=>a.kind==='final-correction-form')!;
 const saved=JSON.parse(await fs.readFile(await service.casePath(c.id,form.relativePath),'utf8'));
 assert.equal(saved.FormCode,100006);assert.equal(saved.CorrectionContentList[0].CorrectionBefore,items[0].CorrectionBefore);
 assert(saved.CorrectionContentList[0].ChangeId);assert.equal(saved.CorrectionContentList[0].Sort,0);
 const claims=finals.find(a=>a.kind==='final-application-CLAIMS')!;
 assert.equal((await mammoth.extractRawText({buffer:await fs.readFile(await service.casePath(c.id,claims.relativePath))})).value.trim(),current.applicationParts!.CLAIMS);
 assert.equal(view.process.finalized!.word.status,'not-required');
});

test('updateDraft 命令支持微调更新正文与申请文件，并保留未修改部分为新采用稿', async t => {
  const { service, host } = await setup(t);
  const c = await prepareCase(service, 'UPD1');
  await host.command('local', c.id, { type: 'classify', classification: classify });
  await host.command('local', c.id, { type: 'materials', selectedIds: ['n-UPD1', 'a-UPD1'] });
  await host.command('local', c.id, { type: 'run', action: 'analysis' }); await host.waitIdle();
  await host.command('local', c.id, { type: 'strategy', strategyId: 's2' });
  await host.command('local', c.id, { type: 'run', action: 'draft' }); await host.waitIdle();
  let view = await host.getCase('local', c.id);
  const pending = view.process.drafts.find(d => d.adoptStatus === 'pending')!;
  await host.command('local', c.id, { type: 'adopt', versionId: pending.id });

  // Update text and CLAIMS via updateDraft
  view = await host.command('local', c.id, {
    type: 'updateDraft',
    text: '尊敬的审查员：\n这是经过微调的意见陈述书正文。\n此致',
    applicationParts: { CLAIMS: '1. 一种经微调的检测装置，其特征在于包含公式 $E = mc^2$。' },
    amendmentBasis: '说明书第 [0020] 段',
  });

  const updated = view.process.drafts.find(d => d.id === view.process.currentDraftVersionId)!;
  assert.equal(updated.text, '尊敬的审查员：\n这是经过微调的意见陈述书正文。\n此致');
  assert.equal(updated.applicationParts?.CLAIMS, '1. 一种经微调的检测装置，其特征在于包含公式 $E = mc^2$。');
  assert.equal(updated.amendmentBasis, '说明书第 [0020] 段');
  assert.equal(updated.adoptStatus, 'adopted');

  // Finalize directly with this updated draft
  view = await host.command('local', c.id, { type: 'finalize' });
  assert.equal(view.process.stage, 'final');
  assert.ok(view.artifacts.some(a => a.kind === 'final-application-CLAIMS'));

  // Test unfinalize
  view = await host.command('local', c.id, { type: 'unfinalize' });
  assert.equal(view.process.finalized, null);
  assert.equal(view.process.stage, 'draft');
  const restoredDraft = view.process.drafts.find(d => d.id === view.process.currentDraftVersionId)!;
  assert.equal(restoredDraft.text, '尊敬的审查员：\n这是经过微调的意见陈述书正文。\n此致');
  assert.equal(restoredDraft.applicationParts?.CLAIMS, '1. 一种经微调的检测装置，其特征在于包含公式 $E = mc^2$。');

  // Test setStage backwards and forwards
  view = await host.command('local', c.id, { type: 'setStage', stage: 'strategy' });
  assert.equal(view.process.stage, 'strategy');
  view = await host.command('local', c.id, { type: 'setStage', stage: 'draft' });
  assert.equal(view.process.stage, 'draft');

  // Re-finalize
  view = await host.command('local', c.id, { type: 'finalize' });
  assert.equal(view.process.stage, 'final');
  assert.ok(view.process.finalized);
  assert.equal(view.process.finalizeHistory.length, 2);
});

test('讨论消息可以引用网址和路径，不把整条聊天当配置封锁', async t => {
  const { service, host } = await setup(t);
  const c = await prepareCase(service, 'URL1');
  await host.command('local', c.id, { type: 'run', action: 'discuss', userMessage: 'https://example.invalid/期限怎么算，材料在 01_通知与材料/通知.txt' });
  await host.waitIdle();
  const view = await host.getCase('local', c.id);
  assert.equal(view.process.jobs.at(-1)?.state, 'completed');
});

test('正式分析无实际 read 不能完成；讨论可以无材料完成', async t => {
  const ctl: RunnerCtl = { starts: 0, skipReads: true };
  const { service, host } = await setup(t, ctl);
  const c = await prepareCase(service, 'RD1');
  await readyAnalysis(host, c.id, ['n-RD1', 'a-RD1']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  let view = await host.getCase('local', c.id);
  assert.equal(view.process.jobs.at(-1)?.state, 'failed');
  assert.match(view.process.jobs.at(-1)?.error ?? '', /实际读取|MATERIALS_UNREAD|必须实际读取/);
  assert.equal(view.process.analysis, null);
  await host.command('local', c.id, { type: 'run', action: 'discuss', userMessage: '期限怎么算' });
  await host.waitIdle();
  view = await host.getCase('local', c.id);
  assert.equal(view.process.jobs.at(-1)?.state, 'completed');
  assert.equal(view.process.stage, 'materials');
});

test('startRun 工厂内 await onEvent 不会与队列死锁', { timeout: 8000 }, async t => {
  const ctl: RunnerCtl = { starts: 0 };
  const inner = mockRunner(ctl);
  const { service, host } = await setup(t, ctl, {
    run: async input => {
      await input.onEvent({ type: 'partial', text: 'factory' });
      return inner(input);
    },
  });
  const c = await prepareCase(service, 'DL1');
  await readyAnalysis(host, c.id, ['n-DL1', 'a-DL1']);
  const started = await host.command('local', c.id, { type: 'run', action: 'analysis' });
  assert.equal(started.busy, true);
  await host.waitIdle();
  const view = await host.getCase('local', c.id);
  assert.equal(view.busy, false);
  assert.equal(view.process.analysis?.strategies.length, 2);
});

function switchProcess(c: Case, processKey: string, draft: string) {
  c.current = { kind: 'reply', roundId: processKey };
  if (!c.rounds.some(item => item.id === processKey)) {
    c.rounds.push({
      id: processKey, name: '下一轮审查意见', stage: 'materials', confirmed: false,
      materials: c.materials ?? [], strategy: null, draft: '',
      versions: [], discussions: [{ id: 'd-' + processKey, title: '主', messages: [] }],
      review: null, job: null, final: null, finalHistory: [],
    });
  }
  c.localDraft = draft;
}

async function readAgentStore(service: DesktopService) {
  const file = path.join(service.root, 'profiles', service.key, 'agent', 'state.json');
  return JSON.parse(await fs.readFile(file, 'utf8')) as {
    processes: Array<{
      scope: { caseId: string; processKey: string };
      drafts: Array<{ text: string; source: string }>;
      jobs: Array<{ state: string; error?: string }>;
      analysis: unknown;
    }>;
  };
}

test('运行中切到流程 B 且 B 手稿独特：旧 run 取消，新手稿不进旧 history，无迟到 partial', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctl: RunnerCtl = { starts: 0, gate, aborts: 0, latePartialAfterAbort: true, lateCompleteAfterAbort: true };
  const { service, host } = await setup(t, ctl);
  service.changed = () => host.noteAccountChange();
  const c = await prepareCase(service, 'SW1');
  const processA = 'r-SW1';
  const processB = 'r-SW1-b';
  const uniqueB = 'UNIQUE-FLOW-B-DRAFT-XYZ';
  await readyAnalysis(host, c.id, ['n-SW1', 'a-SW1']);
  const started = await host.command('local', c.id, { type: 'run', action: 'analysis' });
  assert.equal(started.processKey, processA);
  assert.equal(started.busy, true);
  const leaked: Array<{ processKey: string; partialText?: string; busy: boolean; analysis: boolean }> = [];
  const off = host.onState(view => {
    leaked.push({
      processKey: view.processKey,
      partialText: view.partialText,
      busy: view.busy,
      analysis: !!view.process.analysis,
    });
  });
  const row = service.workspace.cases.find(item => item.id === c.id)!;
  switchProcess(row, processB, uniqueB);
  await service.persist();
  host.noteAccountChange();
  assert.equal(ctl.aborts, 1);
  release();
  await host.waitIdle();
  off();
  assert.equal(host.hasRunningJobs(), false);
  assert.equal(leaked.some(item => item.partialText === '迟到部分-不应出现'), false);
  assert.equal(leaked.some(item => item.processKey === processA && item.analysis), false);

  const bView = await host.getCase('local', c.id);
  assert.equal(bView.processKey, processB);
  assert.equal(bView.busy, false);
  assert.equal(bView.process.analysis, null);
  assert.equal(bView.partialText, undefined);
  assert.ok(bView.process.drafts.some(item => item.text === uniqueB) || service.findCase(c.id).localDraft === uniqueB);

  const stored = await readAgentStore(service);
  const old = stored.processes.find(item => item.scope.caseId === c.id && item.scope.processKey === processA);
  assert.ok(old);
  assert.equal(old.drafts.some(item => item.text.includes(uniqueB)), false);
  assert.ok(old.jobs.every(item => item.state !== 'running'));
  assert.ok(old.jobs.some(item => item.state === 'failed' || item.state === 'stopped'));
  assert.equal(old.analysis, null);

  switchProcess(service.workspace.cases.find(item => item.id === c.id)!, processA, '');
  await service.persist();
  const aView = await host.getCase('local', c.id);
  assert.equal(aView.processKey, processA);
  assert.equal(aView.busy, false);
  assert.equal(aView.process.analysis, null);
  assert.equal(aView.partialText, undefined);
  assert.equal(aView.process.drafts.some(item => item.text.includes(uniqueB)), false);
  assert.ok(['stopped', 'failed'].includes(aView.process.jobs.at(-1)?.state ?? ''));
});

test('同流程普通手工稿保存不断；变 workRoot 或案件消失则 abort 且不污染新流程', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctl: RunnerCtl = { starts: 0, gate, aborts: 0 };
  const { service, host, root } = await setup(t, ctl);
  service.changed = () => host.noteAccountChange();
  const c = await prepareCase(service, 'SV1');
  const c2 = await prepareCase(service, 'SV2');
  const processA = 'r-SV1';
  await readyAnalysis(host, c.id, ['n-SV1', 'a-SV1']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  const ws = structuredClone(service.workspace);
  ws.cases.find(item => item.id === c.id)!.localDraft = '同流程手工保存-KEEP';
  await service.save('local', ws);
  service.changed();
  host.noteAccountChange();
  assert.equal(host.hasRunningJobs(), true);
  assert.equal(ctl.aborts, 0);

  const originalRoot = service.workspace.settings.workRoot;
  service.workspace.settings.workRoot = path.join(root, 'moved-work');
  host.noteAccountChange();
  assert.equal(ctl.aborts, 1);
  release();
  await host.waitIdle();
  assert.equal(host.hasRunningJobs(), false);
  const stored = await readAgentStore(service);
  const old = stored.processes.find(item => item.scope.caseId === c.id && item.scope.processKey === processA);
  assert.ok(old);
  assert.ok(old.jobs.every(item => item.state !== 'running'));
  assert.equal(old.analysis, null);
  assert.ok(old.drafts.every(item => item.text !== 'UNIQUE-SHOULD-NOT-APPEAR'));

  let release2!: () => void;
  const gate2 = new Promise<void>(resolve => { release2 = resolve; });
  ctl.gate = gate2;
  ctl.aborts = 0;
  service.workspace.settings.workRoot = originalRoot;
  await readyAnalysis(host, c2.id, ['n-SV2', 'a-SV2']);
  await host.command('local', c2.id, { type: 'run', action: 'analysis' });
  assert.equal(host.hasRunningJobs(), true);
  service.workspace.cases = service.workspace.cases.filter(item => item.id !== c2.id);
  host.noteAccountChange();
  assert.equal(ctl.aborts, 1);
  release2();
  await host.waitIdle();
  assert.equal(host.hasRunningJobs(), false);
  const stored2 = await readAgentStore(service);
  const gone = stored2.processes.find(item => item.scope.caseId === c2.id);
  assert.ok(gone);
  assert.ok(gone.jobs.every(item => item.state !== 'running'));
  assert.match(gone.jobs.at(-1)?.error ?? gone.jobs.at(-1)?.state ?? '', /不存在|范围|failed|stopped/);
});

test('0.4: stopped partial and thoughts persist; continue excludes thoughts; editing forks without old replies', async t => {
  const inputs: AgentHostRunInput[] = [];
  const { service, host } = await setup(t, undefined, { run: input => {
    inputs.push(input);
    const wait = new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { wait, abort() {} };
  } });
  const c = await prepareCase(service, 'V040');
  const initial = await host.command('local', c.id, { type: 'run', action: 'discuss', userMessage: '原问题' });
  const discussionId = initial.process.mainDiscussionId;
  const first = inputs[0];
  await first.onEvent({ type: 'partial', text: '未完成旧回复' });
  await first.onEvent({ type: 'thinking', text: '供应商返回的分析摘要' });
  await host.command('local', c.id, { type: 'stop', runId: first.runId });
  await host.waitIdle();
  let view = await host.getCase('local', c.id);
  assert.equal(view.process.jobs[0].thinkingText, '供应商返回的分析摘要');
  assert.ok(view.process.discussions[0].messages.some(m => m.incomplete && m.text === '未完成旧回复'));
  const saved = JSON.parse(await fs.readFile(path.join(service.root, 'profiles/local/agent/state.json'), 'utf8'));
  assert.ok(saved.processes[0].jobs[0].partialText);
  await host.command('local', c.id, { type: 'conversation', discussionId, operation: 'continue', runId: first.runId });
  assert.equal(inputs[1].resumeFromRunId,first.runId);
  assert.equal(inputs[1].artifactScope,first.artifactScope);
  assert.ok(inputs[1].messages.some(m => m.text.includes('未完成旧回复')));
  assert.equal(JSON.stringify(inputs[1].messages).includes('供应商返回的分析摘要'), false);
  await inputs[1].onEvent({ type: 'partial', text: '第二次尚未完成' });
  const user = view.process.discussions[0].messages.find(m => m.role === 'user')!;
  await host.command('local', c.id, { type: 'conversation', discussionId, operation: 'edit', messageId: user.id, text: '修改后的问题' });
  assert.equal(inputs[1].signal.aborted, true);
  assert.equal(inputs.length, 3);
  assert.equal(inputs[2].resumeFromRunId,undefined);
  assert.notEqual(inputs[2].artifactScope,first.artifactScope);
  assert.deepEqual(inputs[2].messages.map(m => m.text), ['修改后的问题']);
  await inputs[1].onEvent({ type: 'partial', text: '迟到污染' });
  await host.command('local', c.id, { type: 'stop', runId: inputs[2].runId });
  await host.waitIdle();
  view = await host.getCase('local', c.id);
  assert.equal(view.process.discussions[0].messages.some(m => m.text === '迟到污染'), false);
  const branches = view.process.discussions[0].branches!;
  assert.equal(branches.length, 2);
  view = await host.command('local', c.id, { type: 'branch', discussionId, branchId: 'original' });
  assert.ok(view.process.discussions[0].messages.some(m => m.text === '原问题'));
  assert.ok(view.process.discussions[0].messages.some(m => m.text === '第二次尚未完成'));
  await host.shutdown();
});

test('0.4: formal failure followed by a user message completes analysis and unlocks explicit strategy selection', async t => {
  const { workflowMessageCommand } = await import('../src/domain/conversation.ts');
  const ctl: RunnerCtl = { starts: 0, gate: new Promise(() => {}) };
  const { service, host } = await setup(t, ctl);
  const c = await prepareCase(service, 'FLOW040');
  await readyAnalysis(host, c.id, ['n-FLOW040', 'a-FLOW040']);
  let view = await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.command('local', c.id, { type: 'stop', runId: view.process.activeRunId! });
  await host.waitIdle();
  ctl.gate = undefined;
  // An intervening discussion must not hide the interrupted formal action.
  await host.command('local', c.id, { type: 'run', action: 'discuss', userMessage: '分析失败后补充方向' });
  await host.waitIdle();
  view = await host.getCase('local', c.id);
  const command = workflowMessageCommand(view.process, view.process.mainDiscussionId, '继续分析，给出可选方向');
  assert.equal(command.type, 'conversation');
  await host.command('local', c.id, command);
  await host.waitIdle();
  view = await host.getCase('local', c.id);
  assert.equal(ctl.last?.action, 'analysis');
  assert.ok(ctl.last?.prompt.combined.includes('至少两个'));
  assert.equal(view.process.stage, 'strategy');
  assert.equal(view.process.analysis?.strategies.length, 2);
  assert.throws(() => workflowMessageCommand(view.process, view.process.mainDiscussionId, '直接开始'), /选定策略/);
  view = await host.command('local', c.id, { type: 'strategy', strategyId: view.process.analysis!.strategies[0].id });
  assert.equal(view.process.stage, 'draft');
  assert.equal(workflowMessageCommand(view.process, view.process.mainDiscussionId, '按已选方向起草').type, 'run');
  await host.shutdown();
});

test('0.4: progress listing is local and does not mark cases opened; explicit opening persists', async t => {
  const { service, host } = await setup(t);
  const c = await prepareCase(service, 'LOCAL040');
  await host.getCase('local', c.id);
  let rows = await host.listProgress('local');
  assert.equal(rows[0].steps[0].done, false);
  await host.command('local', c.id, { type: 'opened' });
  await readyAnalysis(host, c.id, ['n-LOCAL040', 'a-LOCAL040']);
  rows = await host.listProgress('local');
  assert.equal(rows[0].steps[0].done, true);
  assert.equal(rows[0].steps[1].done, true);
  assert.equal(rows[0].steps[3].done, false);
  await host.shutdown();
  const reopened = new AgentHost({ desktopService: service, modelService: modelStub(), serialize: serial(), rulesRoot, run: mockRunner({ starts: 0 }) });
  assert.equal((await reopened.listProgress('local'))[0].openedAt, rows[0].openedAt);
  await reopened.shutdown();
});


test('0.5 queue: completed run delivers in order; stopped run preserves editable queue across reopen',async t=>{
  let release!:()=>void;const ctl:RunnerCtl={starts:0,gate:new Promise(resolve=>{release=resolve;})};
  const {service,host}=await setup(t,ctl);const c=await prepareCase(service,'QUEUE050');
  let v=await host.command('local',c.id,{type:'run',action:'discuss',userMessage:'first'});const discussionId=v.process.mainDiscussionId;
  v=await host.command('local',c.id,{type:'queue',operation:'add',discussionId,text:'second',purpose:'discuss',expectedRunId:v.process.activeRunId!});
  assert.equal(ctl.starts,1);assert.equal(v.process.discussions[0].queuedMessages!.length,1);
  ctl.gate=undefined;release();await host.waitIdle();v=await host.getCase('local',c.id);
  assert.equal(ctl.starts,2);assert.equal(v.process.discussions[0].queuedMessages!.length,0);assert.equal(ctl.last?.messages.at(-1)?.text,'second');
  ctl.gate=new Promise(()=>{});v=await host.command('local',c.id,{type:'run',action:'discuss',userMessage:'third'});
  v=await host.command('local',c.id,{type:'queue',operation:'add',discussionId,text:'retained'});const id=v.process.discussions[0].queuedMessages![0].id;
  await host.command('local',c.id,{type:'stop',runId:v.process.activeRunId!});await host.waitIdle();await host.shutdown();
  const reopened=new AgentHost({desktopService:service,modelService:modelStub(),serialize:serial(),rulesRoot,run:mockRunner({starts:0})});
  v=await reopened.getCase('local',c.id);assert.equal(v.process.discussions[0].queuedMessages![0].text,'retained');
  v=await reopened.command('local',c.id,{type:'queue',operation:'edit',discussionId,id,text:'edited'});assert.equal(v.process.discussions[0].queuedMessages![0].text,'edited');
  v=await reopened.command('local',c.id,{type:'queue',operation:'remove',discussionId,id});assert.equal(v.process.discussions[0].queuedMessages!.length,0);await reopened.shutdown();
});

test('0.5 queue: formal continuation waits for human strategy; selected strategy starts drafting in one action',async t=>{
  let release!:()=>void;const ctl:RunnerCtl={starts:0,gate:new Promise(resolve=>{release=resolve;})};
  const {service,host}=await setup(t,ctl);const c=await prepareCase(service,'STRATEGY050');await readyAnalysis(host,c.id,['n-STRATEGY050','a-STRATEGY050']);
  let v=await host.command('local',c.id,{type:'run',action:'analysis'});const discussionId=v.process.mainDiscussionId;
  await host.command('local',c.id,{type:'queue',operation:'add',discussionId,text:'start drafting',purpose:'workflow'});
  ctl.gate=undefined;release();await host.waitIdle();v=await host.getCase('local',c.id);
  assert.equal(ctl.starts,1);assert.match(v.process.discussions[0].queuedMessages![0].error!,/选定策略/);assert.equal(v.process.userSelectedStrategyId,null);
  await host.command('local',c.id,{type:'strategy',strategyId:'s2',startDraft:true});await host.waitIdle();v=await host.getCase('local',c.id);
  assert.equal(ctl.starts,2);assert.equal(v.process.drafts.length,1);assert.equal(v.process.currentDraftVersionId,null);await host.shutdown();
});

test('0.5 queue: skip failed items and deliver later unfailed messages',async t=>{
  let release!:()=>void;const ctl:RunnerCtl={starts:0,gate:new Promise(resolve=>{release=resolve;})};
  const {service,host}=await setup(t,ctl);const c=await prepareCase(service,'QUEUEFAIL');
  let v=await host.command('local',c.id,{type:'run',action:'discuss',userMessage:'first'});const discussionId=v.process.mainDiscussionId;
  await host.command('local',c.id,{type:'queue',operation:'add',discussionId,text:'bad workflow',purpose:'workflow'});
  await host.command('local',c.id,{type:'queue',operation:'add',discussionId,text:'later discuss',purpose:'discuss'});
  ctl.gate=undefined;release();await host.waitIdle();v=await host.getCase('local',c.id);
  let queued=v.process.discussions[0].queuedMessages??[];
  assert.ok(queued[0].error);
  assert.equal(queued[1].text,'later discuss');assert.equal(queued[1].error,undefined);assert.equal(ctl.starts,1);
  await host.command('local',c.id,{type:'run',action:'discuss',userMessage:'second',discussionId});await host.waitIdle();
  v=await host.getCase('local',c.id);
  queued=v.process.discussions[0].queuedMessages??[];
  assert.equal(queued.length,1);assert.ok(queued[0].error);
  assert.equal(v.process.discussions[0].messages.some(m=>m.text==='later discuss'),true);
  assert.equal(ctl.starts,3);
  await host.shutdown();
});

test('0.5 restore: explicit restoration creates a new version and preserves current manual text',async t=>{
  const {service,host}=await setup(t);const c=await prepareCase(service,'RESTORE050');await readyAnalysis(host,c.id,['n-RESTORE050','a-RESTORE050']);
  await host.command('local',c.id,{type:'run',action:'analysis'});await host.waitIdle();
  await host.command('local',c.id,{type:'strategy',strategyId:'s2',startDraft:true});await host.waitIdle();
  let v=await host.getCase('local',c.id);const old=v.process.drafts[0];await host.command('local',c.id,{type:'adopt',versionId:old.id});
  const workspace=structuredClone(service.workspace);workspace.cases.find(x=>x.id===c.id)!.localDraft='用户最新手工修改，恢复前必须保留';await service.save('local',workspace);
  v=await host.getCase('local',c.id);const previousId=v.process.currentDraftVersionId;
  v=await host.command('local',c.id,{type:'restoreDraft',versionId:old.id});
  assert.notEqual(v.process.currentDraftVersionId,old.id);assert.notEqual(v.process.currentDraftVersionId,previousId);
  assert.equal(v.process.drafts.find(d=>d.id===v.process.currentDraftVersionId)!.basedOnVersionId,old.id);
  assert.equal(service.findCase(c.id).localDraft,old.text);
  assert(v.process.drafts.some(d=>d.text==='用户最新手工修改，恢复前必须保留'));
  assert(service.findCase(c.id).localVersions!.some(d=>d.text==='用户最新手工修改，恢复前必须保留'));
  await host.shutdown();
});

test('0.5 queue and natural strategy: branches isolate pending instructions; ambiguous choices never select a strategy',async t=>{
  const ctl:RunnerCtl={starts:0};const {service,host}=await setup(t,ctl);const c=await prepareCase(service,'BRANCH050');
  await host.command('local',c.id,{type:'run',action:'discuss',userMessage:'original'});await host.waitIdle();
  let v=await host.getCase('local',c.id);const discussionId=v.process.mainDiscussionId;const message=v.process.discussions[0].messages.find(m=>m.role==='user')!;
  v=await host.command('local',c.id,{type:'queue',operation:'add',discussionId,text:'original branch only'});const id=v.process.discussions[0].queuedMessages![0].id;
  await host.command('local',c.id,{type:'conversation',operation:'edit',discussionId,messageId:message.id,text:'edited'});await host.waitIdle();assert.equal(ctl.starts,2);
  await assert.rejects(host.command('local',c.id,{type:'queue',operation:'send',discussionId,id}),/当前分支/);
  await host.command('local',c.id,{type:'branch',discussionId,branchId:'original'});await host.command('local',c.id,{type:'queue',operation:'send',discussionId,id});await host.waitIdle();assert.equal(ctl.starts,3);
  await readyAnalysis(host,c.id,['n-BRANCH050','a-BRANCH050']);await host.command('local',c.id,{type:'run',action:'analysis'});await host.waitIdle();v=await host.getCase('local',c.id);
  const {workflowMessageCommand}=await import('../src/domain/conversation.ts');
  assert.deepEqual(workflowMessageCommand(v.process,discussionId,'按方案一开始'),{type:'strategy',strategyId:'s1',startDraft:true,userMessage:'按方案一开始'});
  assert.deepEqual(workflowMessageCommand(v.process,discussionId,'选择策略二'),{type:'strategy',strategyId:'s2',startDraft:false,userMessage:'选择策略二'});
  assert.throws(()=>workflowMessageCommand(v.process,discussionId,'不要按方案一开始'),/选定策略/);
  assert.throws(()=>workflowMessageCommand(v.process,discussionId,'方案一是不是不好'),/选定策略/);
  await host.shutdown();
});


test('formal analysis waits for business startup; failed startup never calls model; discussion bypasses startup',async t=>{
 const {service,host,ctl}=await setup(t);const c=await prepareCase(service,'START');await readyAnalysis(host,c.id,['n-START','a-START']);let calls=0;
 host.beforeFormalRun=async()=>{calls++;assert.equal(ctl.starts,0);throw Error('启动结果待核对');};
 await assert.rejects(host.command('local',c.id,{type:'run',action:'analysis'}),/启动结果待核对/);assert.equal(ctl.starts,0);assert.equal(calls,1);
 host.beforeFormalRun=async()=>{calls++;assert.equal(ctl.starts,0);};
 await host.command('local',c.id,{type:'run',action:'analysis'});await host.waitIdle();assert.equal(ctl.starts,1);assert.equal(calls,2);
 await host.command('local',c.id,{type:'run',action:'discuss',userMessage:'仅讨论'});await host.waitIdle();assert.equal(calls,2);await host.shutdown();
});

test('pre-run diagnostics and UI phases distinguish material preparation from permission failure',async t=>{
 const {root,service,host,ctl}=await setup(t),c=await prepareCase(service,'TRACE');
 await readyAnalysis(host,c.id,['n-TRACE','a-TRACE']);
 const log=initializeDiagnostics(path.join(root,'diagnostics')),phases:string[]=[];
 host.preparationChanged=event=>{assert.equal(event.caseId,c.id);phases.push(event.step);};
 host.beforeFormalRun=async()=>{await Promise.resolve();throw Object.assign(new Error('PRIVATE_AUTH_BODY'),{code:'ECONNRESET'});};
 try{
  await assert.rejects(host.command('local',c.id,{type:'run',action:'analysis'}));
  assert.equal(ctl.starts,0);
  assert.deepEqual(phases,['queued','preparing','materials','permission','done']);
  const records=log.snapshot('test').records;
  const stages=records.filter(r=>r.event==='stage_finished');
  assert.ok(stages.some(r=>r.step==='materials'&&r.state==='completed'));
  assert.ok(stages.some(r=>r.step==='permission'&&r.state==='failed'&&r.code==='ECONNRESET'));
  assert.ok(records.some(r=>r.event==='command_dequeued'&&typeof r.durationMs==='number'));
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE_AUTH_BODY|memory-only-key/);
 }finally{stopDiagnostics();await host.shutdown();}
});

test('completion preflight returns missing reads and duplicate ids to agent without committing state', {timeout:8000},async t=>{
 let captured: Parameters<AgentHostRun>[0]|undefined;
 let finish!:()=>void;
 const {service,host}=await setup(t,undefined,{run:input=>{captured=input;return {wait:new Promise<void>(resolve=>{finish=resolve;}),abort(){finish();}};}});
 const c=await prepareCase(service,'PREFLIGHT');
 await readyAnalysis(host,c.id,['n-PREFLIGHT','a-PREFLIGHT']);
 await host.command('local',c.id,{type:'run',action:'analysis'});
 const input=captured!;
 assert.match(await input.validateArtifact!(analysisJson())??'',/读取/);
 for(const m of input.materials) await input.onEvent({type:'tool',filename:m.name,readRange:'全文',status:'ok',materialId:m.id,toolKind:'read_material'});
 const duplicate=JSON.parse(analysisJson());duplicate.strategies[1].id=duplicate.strategies[0].id;
 assert.match(await input.validateArtifact!(JSON.stringify(duplicate))??'',/重复/);
 assert.equal(await input.validateArtifact!(analysisJson()),undefined);
 assert.equal((await host.getCase('local',c.id)).process.analysis,null);
 await input.onEvent({type:'completed',outputText:analysisJson()});finish();await host.waitIdle();
 assert.equal((await host.getCase('local',c.id)).process.stage,'strategy');
});

test('C#3: emitTerminal persist failure retries, keeps live, marks 状态未落盘', async t => {
  let release!: () => void;
  const ctl: RunnerCtl = { starts: 0, gate: new Promise<void>(resolve => { release = resolve; }) };
  const { service, host } = await setup(t, ctl);
  const c = await prepareCase(service, 'PERSIST3');
  await readyAnalysis(host, c.id, ['n-PERSIST3', 'a-PERSIST3']);
  let emitted: Awaited<ReturnType<AgentHost['getCase']>> | undefined;
  host.onChanged(view => { if (view.caseId === c.id && view.persistAlert) emitted = view; });
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  assert.equal(host.hasRunningJobs(), true);

  const hostAny = host as unknown as {
    persistStore: (profileKey: string, store: unknown) => Promise<void>;
    live: Map<string, { persistAlert?: string; settled: boolean; failed?: string }>;
  };
  const original = hostAny.persistStore.bind(host);
  let terminalPersistAttempts = 0;
  hostAny.persistStore = async (profileKey, store) => {
    const processes = (store as { processes?: Array<{ scope: { caseId: string }; activeRunId: string | null; jobs: Array<{ state: string }> }> }).processes ?? [];
    const process = processes.find(p => p.scope.caseId === c.id);
    const terminal = !!process && process.activeRunId === null && process.jobs.some(j => j.state !== 'running');
    if (terminal) {
      terminalPersistAttempts += 1;
      throw new Error('simulated disk full');
    }
    return original(profileKey, store);
  };

  const statePath = path.join(service.root, 'profiles/local/agent/state.json');
  const before = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
    processes: Array<{ scope: { caseId: string }; activeRunId: string | null }>;
  };
  assert.ok(before.processes.some(p => p.scope.caseId === c.id && p.activeRunId));

  ctl.gate = undefined;
  release();
  await host.waitIdle();

  assert.equal(host.hasRunningJobs(), true, 'live must stay uncleared when terminal persist fails');
  assert.ok(emitted, 'UI signal must be emitted with 状态未落盘');
  assert.equal(emitted!.persistAlert, '状态未落盘');
  assert.equal(emitted!.busy, true);
  const job = emitted!.process.jobs[emitted!.process.jobs.length - 1];
  assert.ok(job.error?.includes('状态未落盘'), job.error);
  assert.equal(job.activity, '状态未落盘');
  assert.equal(hostAny.live.get(JSON.stringify(['local',c.id]))?.persistAlert, '状态未落盘');
  const after = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
    processes: Array<{ scope: { caseId: string }; activeRunId: string | null; jobs: Array<{ state: string }> }>;
  };
  const disk = after.processes.find(p => p.scope.caseId === c.id)!;
  assert.ok(disk.activeRunId, 'disk must retain pre-terminal running snapshot');
  assert.ok(terminalPersistAttempts >= 3, `expected retries, got ${terminalPersistAttempts}`);
  await host.shutdown();
});

test('C#3: emitTerminal persist succeeds after retry and clears live without 状态未落盘', async t => {
  let release!: () => void;
  const ctl: RunnerCtl = { starts: 0, gate: new Promise<void>(resolve => { release = resolve; }) };
  const { service, host } = await setup(t, ctl);
  const c = await prepareCase(service, 'PERSIST3R');
  await readyAnalysis(host, c.id, ['n-PERSIST3R', 'a-PERSIST3R']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });

  const hostAny = host as unknown as {
    persistStore: (profileKey: string, store: unknown) => Promise<void>;
  };
  const original = hostAny.persistStore.bind(host);
  let terminalFailsLeft = 2;
  hostAny.persistStore = async (profileKey, store) => {
    const processes = (store as { processes?: Array<{ scope: { caseId: string }; activeRunId: string | null; jobs: Array<{ state: string }> }> }).processes ?? [];
    const process = processes.find(p => p.scope.caseId === c.id);
    const terminal = process && process.activeRunId === null && process.jobs.some(j => j.state !== 'running');
    if (terminal && terminalFailsLeft > 0) {
      terminalFailsLeft -= 1;
      throw new Error('transient persist error');
    }
    return original(profileKey, store);
  };

  ctl.gate = undefined;
  release();
  await host.waitIdle();

  assert.equal(host.hasRunningJobs(), false);
  assert.equal(terminalFailsLeft, 0, 'should have consumed both transient failures via retry');
  const view = await host.getCase('local', c.id);
  assert.equal(view.persistAlert, undefined);
  assert.equal(view.process.stage, 'strategy');
  assert.equal(view.busy, false);
  const statePath = path.join(service.root, 'profiles/local/agent/state.json');
  const saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
    processes: Array<{ scope: { caseId: string }; activeRunId: string | null; stage?: string }>;
  };
  const disk = saved.processes.find(p => p.scope.caseId === c.id)!;
  assert.equal(disk.activeRunId, null);
  await host.shutdown();
});

test('C#4: partial/thinking ticks stay in memory; persist on boundary/terminal', async t => {
  let release!: () => void;
  let input!: AgentHostRunInput;
  const { service, host } = await setup(t, undefined, {
    run: runInput => {
      input = runInput;
      const wait = new Promise<void>(resolve => { release = resolve; });
      return {
        wait,
        abort() { release(); },
      };
    },
  });
  const c = await prepareCase(service, 'PERSIST4');
  await host.command('local', c.id, { type: 'run', action: 'discuss', userMessage: '流式落盘' });
  assert.ok(input);

  const hostAny = host as unknown as {
    persistStore: (profileKey: string, store: unknown) => Promise<void>;
  };
  const original = hostAny.persistStore.bind(host);
  let persistCount = 0;
  hostAny.persistStore = async (profileKey, store) => {
    persistCount += 1;
    return original(profileKey, store);
  };

  const waitView = (pred: (view: Awaited<ReturnType<AgentHost['getCase']>>) => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('view wait timeout')); }, 5000);
    const off = host.onChanged(view => {
      if (view.caseId !== c.id) return;
      if (!pred(view)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });

  const ticks = 40;
  const beforeStream = persistCount;
  let saw = waitView(v => v.process.jobs.at(-1)?.thinkingText === `思考-${ticks - 1}` && v.partialText === `部分-${ticks - 1}`);
  for (let i = 0; i < ticks; i++) {
    void input.onEvent({ type: 'partial', text: `部分-${i}` });
    void input.onEvent({ type: 'thinking', text: `思考-${i}` });
  }
  await saw;
  assert.equal(persistCount, beforeStream, `streaming ticks must not call persistStore; delta=${persistCount - beforeStream}`);

  saw = waitView(v => v.partialText === '部分-最终内存');
  void input.onEvent({ type: 'partial', text: '部分-最终内存' });
  await saw;
  assert.equal(persistCount, beforeStream, 'final memory partial must still skip persist');

  const statePath = path.join(service.root, 'profiles/local/agent/state.json');
  const midDisk = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
    processes: Array<{ scope: { caseId: string }; jobs: Array<{ partialText?: string; thinkingText?: string }> }>;
  };
  const midJob = midDisk.processes.find(p => p.scope.caseId === c.id)?.jobs.at(-1);
  assert.notEqual(midJob?.partialText, '部分-最终内存');
  assert.notEqual(midJob?.thinkingText, `思考-${ticks - 1}`);

  const beforeBoundary = persistCount;
  saw = waitView(v => v.process.jobs.at(-1)?.activity === '调用工具');
  void input.onEvent({ type: 'activity', label: '调用工具', stepId: 's1', status: 'running' });
  await saw;
  assert.ok(persistCount > beforeBoundary, 'activity boundary must persist');

  const afterBoundary = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
    processes: Array<{ scope: { caseId: string }; jobs: Array<{ partialText?: string; thinkingText?: string; activity?: string }> }>;
  };
  const flushed = afterBoundary.processes.find(p => p.scope.caseId === c.id)?.jobs.at(-1);
  assert.equal(flushed?.partialText, '部分-最终内存');
  assert.equal(flushed?.thinkingText, `思考-${ticks - 1}`);
  assert.equal(flushed?.activity, '调用工具');

  const beforeMore = persistCount;
  saw = waitView(v => v.partialText === '续-11');
  for (let i = 0; i < 12; i++) {
    void input.onEvent({ type: 'partial', text: `续-${i}` });
  }
  await saw;
  assert.equal(persistCount, beforeMore, 'post-boundary streaming ticks must not persist');

  const beforeTerminal = persistCount;
  await host.command('local', c.id, { type: 'stop', runId: input.runId });
  await host.waitIdle();
  assert.ok(persistCount > beforeTerminal, 'stop/terminal must persist');

  const view = await host.getCase('local', c.id);
  assert.ok(view.process.discussions.some(d => d.messages.some(m => m.incomplete && m.text === '续-11')));
  await host.shutdown();
});

test('unfinalize 仅在已定稿时允许撤销，未定稿时拒绝并抛出 NOT_FINALIZED', async t => {
  const { service, host } = await setup(t);
  const c = await prepareCase(service, 'UNFIN1');
  await readyAnalysis(host, c.id, ['n-UNFIN1', 'a-UNFIN1']);
  // 未定稿时调用 unfinalize
  await assert.rejects(
    () => host.command('local', c.id, { type: 'unfinalize' }),
    /NOT_FINALIZED|当前轮次尚未定稿/
  );
  await host.shutdown();
});

test('定稿后手工草稿变动或刷新不会抛出 ALREADY_FINALIZED 崩溃，撤销定稿后平滑同步', async t => {
  const { service, host } = await setup(t);
  const c = await prepareCase(service, 'FIN_SYNC');
  await readyAnalysis(host, c.id, ['n-FIN_SYNC', 'a-FIN_SYNC']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  await host.command('local', c.id, { type: 'strategy', strategyId: 's2' });
  await host.command('local', c.id, { type: 'run', action: 'draft' });
  await host.waitIdle();
  let view = await host.getCase('local', c.id);
  const pending = view.process.drafts.find(item => item.adoptStatus === 'pending')!;
  await host.command('local', c.id, { type: 'adopt', versionId: pending.id });
  await host.command('local', c.id, {
    type: 'applicationParts',
    parts: { CLAIMS: '1. 一种测试装置，其特征在于……' }
  });
  // 定稿
  const finalizedView = await host.command('local', c.id, { type: 'finalize' });
  assert.ok(finalizedView.process.finalized);

  // 模拟用户在外部或手工工作稿中修改了正文并触发刷新
  const ws = structuredClone(service.workspace);
  const foundCase = ws.cases.find(item => item.id === c.id)!;
  foundCase.localDraft = '用户在定稿后手动修改的权利要求书正文';
  foundCase.sharedDraftHash = 'new-fake-hash-123';
  await service.save('local', ws);
  service.changed();

  // 此时 getCase 绝不能抛出 ALREADY_FINALIZED 崩溃，必须安全返回
  const refreshedView = await host.getCase('local', c.id);
  assert.ok(refreshedView.process.finalized);

  // 撤回定稿
  const unfinalizedView = await host.command('local', c.id, { type: 'unfinalize' });
  assert.equal(unfinalizedView.process.finalized, null);
  // 撤回定稿后，手工稿变动安全同步为新草稿
  const current = currentDraft(unfinalizedView.process);
  assert.equal(current?.text, '用户在定稿后手动修改的权利要求书正文');

  await host.shutdown();
});

test('定稿 Word 文件在外部被修改后，artifactsOf 仍保留该产物且标记 externallyModified 并提取 text', async t => {
  const { service, host } = await setup(t);
  const c = await prepareCase(service, 'FIN_EXT');
  await readyAnalysis(host, c.id, ['n-FIN_EXT', 'a-FIN_EXT']);
  await host.command('local', c.id, { type: 'run', action: 'analysis' });
  await host.waitIdle();
  await host.command('local', c.id, { type: 'strategy', strategyId: 's2' });
  await host.command('local', c.id, { type: 'run', action: 'draft' });
  await host.waitIdle();
  let view = await host.getCase('local', c.id);
  const pending = view.process.drafts.find(item => item.adoptStatus === 'pending')!;
  await host.command('local', c.id, { type: 'adopt', versionId: pending.id });
  await host.command('local', c.id, {
    type: 'applicationParts',
    parts: { CLAIMS: '1. 原始定稿权利要求。' }
  });
  // 定稿
  view = await host.command('local', c.id, { type: 'finalize' });
  const wordArtifact = view.artifacts.find(item => item.kind === 'final-application-CLAIMS')!;
  assert.ok(wordArtifact);
  assert.equal(wordArtifact.externallyModified, false);

  // 模拟用户在外部使用 Word 修改该文件
  const caseRoot = await service.casePath(c.id);
  const absPath = path.join(caseRoot, wordArtifact.relativePath);
  const { exportApplicationParts } = await import('./document-export.ts');
  const modifiedBytes = await exportApplicationParts(path.join(rulesRoot, '..', 'document-templates'), {
    CLAIMS: '1. 用户在外部用 Word 调整后的新权利要求。'
  });
  await fs.writeFile(absPath, modifiedBytes);

  // 刷新读取
  const afterEditView = await host.getCase('local', c.id);
  const targetArtifact = afterEditView.artifacts.find(item => item.id === wordArtifact.id);
  assert.ok(targetArtifact, '外部修改后，该 artifact 不应被静默丢弃');
  assert.equal(targetArtifact.externallyModified, true, '应标记为外部已修改');
  assert.match(targetArtifact.title, /外部已修改/);
  assert.match(targetArtifact.text ?? '', /用户在外部用 Word 调整后的新权利要求/);

  await host.shutdown();
});
