import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnManagedProcess, killManagedProcess, quoteWindowsArgument } from './managed-process.ts';

test('Windows argv encoding preserves embedded quotes and trailing backslashes', () => {
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('C:\\path with spaces\\'), '"C:\\path with spaces\\\\"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
});

test('managed process cleanup kills descendants after their root has already exited', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'process-tree-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const heartbeat = path.join(root, 'heartbeat'), marker = path.join(root, 'child-pid');
  const childCode = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),25);`;
  const parentCode = `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();setInterval(()=>{if(fs.existsSync(${JSON.stringify(heartbeat)}))process.exit(17);},25);setTimeout(()=>process.exit(2),10000);`;
  const proc = spawnManagedProcess(process.execPath, ['-e', parentCode], { cwd: root, stdio: 'ignore' }, root);
  t.after(() => killManagedProcess(proc));
  await new Promise<void>((resolve, reject) => { proc.once('exit', () => resolve()); proc.once('error', reject); });
  const childPid = Number(await fs.readFile(marker, 'utf8'));
  t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(proc.exitCode, 17);
  await killManagedProcess(proc);
  await new Promise(r => setTimeout(r, 100));
  const first = (await fs.readFile(heartbeat, 'utf8')).length;
  await new Promise(r => setTimeout(r, 150));
  assert.equal((await fs.readFile(heartbeat, 'utf8')).length, first, 'descendant must stop writing after cleanup');
});
