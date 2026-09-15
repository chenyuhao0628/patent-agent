import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PINNED_RUNTIME_VERSION,
  PrepareRuntimeError,
  copyAgentRuntime,
  parsePrepareArgs,
  sha256File,
  verifyAgentRuntime,
} from './prepare-agent-runtime.mjs';

async function fixtureRuntime() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-runtime-'));
  const darwin = path.join(root, 'darwin-arm64', 'opencode');
  const win = path.join(root, 'win32-x64', 'opencode.exe');
  await fs.mkdir(path.dirname(darwin), { recursive: true });
  await fs.mkdir(path.dirname(win), { recursive: true });
  const macBytes = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from('mac-bin')]);
  const winBytes = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x78, 0x00]), Buffer.from('win-bin')]);
  await fs.writeFile(darwin, macBytes, { mode: 0o755 });
  await fs.writeFile(win, winBytes, { mode: 0o644 });
  await fs.writeFile(path.join(root, 'OPENCODE-LICENSE.txt'), 'MIT\n');
  const manifest = {
    runtime: 'OpenCode',
    version: PINNED_RUNTIME_VERSION,
    files: [
      {
        platform: 'darwin-arm64',
        version: PINNED_RUNTIME_VERSION,
        file: 'darwin-arm64/opencode',
        bytes: macBytes.length,
        sha256: createHash('sha256').update(macBytes).digest('hex'),
        header: 'cffaedfe',
      },
      {
        platform: 'win32-x64',
        version: PINNED_RUNTIME_VERSION,
        file: 'win32-x64/opencode.exe',
        bytes: winBytes.length,
        sha256: createHash('sha256').update(winBytes).digest('hex'),
        header: '4d5a7800',
      },
    ],
  };
  await fs.writeFile(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2));
  return root;
}

test('parsePrepareArgs requires injected paths and never reads HOME', () => {
  const parsed = parsePrepareArgs(['--source', '/src/runtime', '--output', '/out/runtime']);
  assert.equal(parsed.sourceDir, '/src/runtime');
  assert.equal(parsed.outputDir, '/out/runtime');
  assert.throws(() => parsePrepareArgs(['--home', '/tmp']), PrepareRuntimeError);
});

test('runtime license errors distinguish missing from invalid file types',async()=>{
 const root=await fixtureRuntime(),license=path.join(root,'OPENCODE-LICENSE.txt');
 try{
  await fs.unlink(license);
  await assert.rejects(verifyAgentRuntime(root),e=>e.code==='missing_license');
  await fs.mkdir(license);
  await assert.rejects(verifyAgentRuntime(root),e=>e.code==='invalid_license');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('copyAgentRuntime verifies pinned 1.18.30, copies, and does not mutate process.env', async () => {
  const source = await fixtureRuntime();
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-out-'));
  const beforeHome = process.env.HOME;
  const beforeUser = process.env.USERPROFILE;
  const result = await copyAgentRuntime({ sourceDir: source, outputDir: output });
  assert.equal(process.env.HOME, beforeHome);
  assert.equal(process.env.USERPROFILE, beforeUser);
  assert.equal(result.version, '1.18.30');
  const copied = path.join(output, 'darwin-arm64', 'opencode');
  assert.equal(await sha256File(copied), result.files[0].sha256);
  await verifyAgentRuntime(output);
});

test('wrong version or hash is rejected and does not download', async () => {
  const source = await fixtureRuntime();
  const manifestPath = path.join(source, 'runtime-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.version = '9.9.9';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => verifyAgentRuntime(source), err => err instanceof PrepareRuntimeError && err.code === 'version');
  manifest.version = PINNED_RUNTIME_VERSION;
  manifest.files[0].sha256 = '0'.repeat(64);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => verifyAgentRuntime(source), err => err instanceof PrepareRuntimeError && err.code === 'hash');
});

test('lab runtime if present is 1.18.30 and is only verified read-only', async t => {
  const source = process.env.PATENT_AGENT_RUNTIME_SOURCE || '/Users/cyh/Documents/ChatGPT/patent-agent/.lab/agent-runtime';
  try {
    await fs.access(path.join(source, 'runtime-manifest.json'));
  } catch {
    t.skip('lab runtime not present');
    return;
  }
  const before = JSON.stringify(await fs.readFile(path.join(source, 'runtime-manifest.json'), 'utf8'));
  const report = await verifyAgentRuntime(source);
  assert.equal(report.version, '1.18.30');
  const after = JSON.stringify(await fs.readFile(path.join(source, 'runtime-manifest.json'), 'utf8'));
  assert.equal(after, before);
});
