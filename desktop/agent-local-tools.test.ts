import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureManagedTools } from './managed-tools.ts';
import { configureLocalTools, executeLocalCommand, downloadToolFile, commandEnvironment } from './agent-local-tools.ts';
import { randomRunToken, startAgentBroker } from './agent-broker.ts';
import { createReadMaterialCallback } from './agent-document-reader.ts';
import { digest } from './files.ts';
import { mapRunnerToolEvent } from './agent-integration.ts';

async function rpc(b: Awaited<ReturnType<typeof startAgentBroker>>, method: string, params?: unknown) {
  const response = await fetch(b.url, { method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await response.json()).result;
}
const call = (b: Awaited<ReturnType<typeof startAgentBroker>>, name: string, args = {}) => rpc(b, 'tools/call', { name, arguments: args });

test('optional local permissions default closed, captured per run and enforced behind MCP', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-rights-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  configureManagedTools(path.join(root, 'tools')); configureLocalTools({ commandsEnabled: false, downloadsEnabled: false });
  const b = await startAgentBroker({ token: randomRunToken(), snapshotRoot: path.join(root, 'snap'), outputsRoot: path.join(root, 'out'), materials: [] }); t.after(() => b.close());
  const names = (await rpc(b, 'tools/list')).tools.map((v: any) => v.name);
  assert.ok(names.includes('discover_tools')); assert.ok(!names.includes('execute_command')); assert.ok(!names.includes('download_file'));
  configureLocalTools({ commandsEnabled: true, downloadsEnabled: true });
  for (const name of ['execute_command', 'download_file', 'prepare_material', 'read_work_file']) assert.equal((await call(b, name, { command: 'echo NEVER' })).isError, true);
  const b2 = await startAgentBroker({ token: randomRunToken(), snapshotRoot: path.join(root, 'two/snap'), outputsRoot: path.join(root, 'two/out'), materials: [] }); t.after(() => b2.close());
  const enabled = (await rpc(b2, 'tools/list')).tools.map((v: any) => v.name); assert.ok(enabled.includes('execute_command')); assert.ok(enabled.includes('download_file'));
  configureLocalTools({ commandsEnabled: false, downloadsEnabled: false });
});

test('selected copy -> general command -> document reader; original, path guards and audit preserved', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-work-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  configureManagedTools(path.join(root, 'tools')); configureLocalTools({ commandsEnabled: true, downloadsEnabled: false });
  const snap = path.join(root, 'snap'); await fs.mkdir(snap); const original = path.join(snap, 'source.txt'); await fs.writeFile(original, '合成案件 ALPHA'); const hash = digest(await fs.readFile(original));
  const events: any[] = [], work = path.join(root, 'command-work');
  const b = await startAgentBroker({ token: randomRunToken(), snapshotRoot: snap, outputsRoot: path.join(root, 'out'), workRoot: work, materials: [{ id: 'm1', name: '原件.txt', role: 'fixture', relativePath: 'source.txt', absoluteSnapshotPath: original, hash }], readMaterial: createReadMaterialCallback(), onToolEvent: e => events.push(e) }); t.after(() => b.close());
  assert.equal((await call(b, 'prepare_material', { materialId: 'other-case' })).isError, true);
  const copy = (await call(b, 'prepare_material', { materialId: 'm1' })).structuredContent;
  assert.notEqual(copy.path, original); assert.equal(digest(await fs.readFile(copy.path)), hash);
  const result = await call(b, 'execute_command', { command: 'cat inputs/*.txt > converted.txt; printf "\\n追加读取验证" >> converted.txt; printf "command works"' });
  assert.equal(result.isError, false); assert.equal(result.structuredContent.stdout, 'command works');
  const read = await call(b, 'read_work_file', { path: 'converted.txt', sourceMaterialId: 'm1' }); assert.match(JSON.stringify(read), /合成案件 ALPHA/); assert.match(JSON.stringify(read), /追加读取验证/);
  assert.equal((await call(b, 'read_work_file', { path: '../snap/source.txt' })).isError, true);
  await fs.symlink(original, path.join(work, 'redirect.txt')); assert.equal((await call(b, 'read_work_file', { path: 'redirect.txt' })).isError, true);
  assert.equal(digest(await fs.readFile(original)), hash);
  assert.ok(events.some(e => e.name === 'execute_command' && e.success));
  assert.ok(events.some(e => e.name === 'read_work_file' && e.success && e.materialId === 'm1'));
  assert.equal((await call(b, 'read_work_file', {path:'converted.txt',sourceMaterialId:'other-case'})).isError,true);
  const records = await Promise.all((await fs.readdir(path.join(root, 'tool-audit'))).map(f => fs.readFile(path.join(root, 'tool-audit', f), 'utf8')));
  assert.ok(records.some(r => r.includes('command works') && r.includes('stdout')));
  assert.equal(mapRunnerToolEvent({ name: 'execute_command', materialName: '/usr/bin/textutil /tmp/synthetic.doc', status: 'success', success: true })?.detail, '/usr/bin/textutil /tmp/synthetic.doc');
  configureLocalTools({ commandsEnabled: false, downloadsEnabled: false });
});

test('commands can use scripts and reusable local installs without inherited provider credentials', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-env-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workRoot = path.join(root, 'work'), toolsRoot = path.join(root, 'tools'); await fs.mkdir(workRoot); await fs.mkdir(toolsRoot);
  const old = process.env.PATENT_TEST_SECRET; process.env.PATENT_TEST_SECRET = 'do-not-pass'; t.after(() => { if (old === undefined) delete process.env.PATENT_TEST_SECRET; else process.env.PATENT_TEST_SECRET = old; });
  const env = await commandEnvironment(workRoot, toolsRoot); assert.equal(env.PATENT_TEST_SECRET, undefined); assert.ok(env.HOME?.startsWith(workRoot));
  const result = await executeLocalCommand({ workRoot, toolsRoot, directory: 'tools', command: 'mkdir -p bin; printf "#!/bin/sh\\nprintf lightweight-tool" > bin/probe; chmod +x bin/probe; probe' });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'lightweight-tool');
  const work2 = path.join(root, 'second-case'); await fs.mkdir(work2);
  assert.equal((await executeLocalCommand({ workRoot: work2, toolsRoot, command: 'probe' })).stdout, 'lightweight-tool');
  const output = await executeLocalCommand({ workRoot, toolsRoot, command: 'printf "apiKey=sk-fixturesecret123"; exit 7' }); assert.equal(output.exitCode, 7); assert.doesNotMatch(output.stdout, /fixturesecret/);
  const capped = await executeLocalCommand({ workRoot, toolsRoot, command: 'head -c 100000 /dev/zero' }); assert.equal(capped.truncated, true); assert.ok(capped.stdout.length <= 48000);
});

test('command abort and broker close stop descendant writes; timeout is explicit', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-stop-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workRoot = path.join(root, 'work'), toolsRoot = path.join(root, 'tools'); await fs.mkdir(workRoot); await fs.mkdir(toolsRoot);
  const controller = new AbortController();
  const running = executeLocalCommand({ workRoot, toolsRoot, command: 'echo start > started; (sleep 1; echo LATE > late) & wait', signal: controller.signal });
  while (!await fs.access(path.join(workRoot, 'started')).then(() => true, () => false)) await new Promise(r => setTimeout(r, 10));
  controller.abort(); const stopped = await running; assert.equal(stopped.stopped, true);
  await new Promise(r => setTimeout(r, 1100)); await assert.rejects(fs.access(path.join(workRoot, 'late')));
  const timed = await executeLocalCommand({ workRoot, toolsRoot, command: 'sleep 20', timeoutSeconds: 1 }); assert.equal(timed.timedOut, true);
  configureManagedTools(toolsRoot); configureLocalTools({ commandsEnabled: true, downloadsEnabled: false });
  const b = await startAgentBroker({ token: randomRunToken(), snapshotRoot: path.join(root, 'snap'), outputsRoot: path.join(root, 'out'), workRoot, materials: [] });
  const rpcPromise = call(b, 'execute_command', { command: 'echo start > broker-start; (sleep 1; echo LATE > broker-late) & wait' }).catch(() => {});
  while (!await fs.access(path.join(workRoot, 'broker-start')).then(() => true, () => false)) await new Promise(r => setTimeout(r, 10));
  await b.close(); await rpcPromise; await new Promise(r => setTimeout(r, 1100)); await assert.rejects(fs.access(path.join(workRoot, 'broker-late')));
  configureLocalTools({ commandsEnabled: false, downloadsEnabled: false });
});

test('generic download accepts non-Office sources, verifies hash, rejects redirect/private and clears failed files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-download-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = Buffer.from('lightweight software fixture');
  const fetcher: typeof fetch = async (_url, opts) => { assert.equal(opts?.redirect, 'manual'); assert.equal(new Headers(opts?.headers).has('authorization'), false); return new Response(payload, { headers: { 'content-length': String(payload.length) } }); };
  const input = { url: 'https://1.1.1.1/tool.txt', filename: 'mini-tool.txt', root, sha256: digest(payload) };
  const good = await downloadToolFile(input, fetcher); assert.equal(good.verified, true); assert.equal(await fs.readFile(good.file, 'utf8'), payload.toString());
  const before = await fs.readdir(root); await assert.rejects(downloadToolFile({ ...input, sha256: '0'.repeat(64) }, fetcher), /校验失败/); assert.deepEqual(await fs.readdir(root), before);
  await assert.rejects(downloadToolFile(input, async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })), /内网/);
  for (const filename of ['../bad', 'download.json', '.partial', 'CON.exe']) await assert.rejects(downloadToolFile({ ...input, filename }, fetcher), /文件名/);
  await assert.rejects(downloadToolFile(input, async () => new Response('short', { headers: { 'content-length': '100' } })), /不完整/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(downloadToolFile({ ...input, signal: controller.signal }, fetcher));
  assert.deepEqual(await fs.readdir(root), before);
});
