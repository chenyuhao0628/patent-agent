import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  acquirePackageLock,
  copyArtifact,
  FILE_HASH_ALGORITHM,
  macPublishedName,
  macInstallerName,
  MANIFEST_NAME,
  packagingCommands,
  runPackageRelease,
  TREE_HASH_ALGORITHM,
  winPublishedName,
} from './package-release.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const VERSION = '0.2.5';
const PRODUCT = '专利工作台';

function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${PRODUCT}</string>
  <key>CFBundleIdentifier</key>
  <string>com.patentworkbench.desktop</string>
  <key>CFBundleName</key>
  <string>${PRODUCT}</string>
  <key>CFBundleDisplayName</key>
  <string>${PRODUCT}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
</dict>
</plist>
`;
}

async function writeAsar(dest, version, {includeRules=true}={}) {
  const src = `${dest}.src`;
  await fs.mkdir(path.join(src, 'desktop-dist'), {recursive: true});
  await fs.mkdir(path.join(src, 'dist', 'assets'), {recursive: true});
  await fs.writeFile(path.join(src, 'package.json'), JSON.stringify({
    name: 'patent-agent',
    version,
    main: 'desktop-dist/main.cjs',
    build: {appId: 'com.patentworkbench.desktop', productName: PRODUCT},
  }));
  await fs.writeFile(path.join(src, 'desktop-dist', 'main.cjs'), 'exports.ok=1;\n');
  await fs.writeFile(path.join(src, 'desktop-dist', 'preload.cjs'), 'exports.preload=1;\n');
  await fs.writeFile(path.join(src, 'desktop-dist', 'pdf.worker.mjs'), 'export const WorkerMessageHandler = {};\n');
  await fs.writeFile(path.join(src,'desktop-dist','document-visual-worker.cjs'),'exports.ok=1;');
  await fs.writeFile(path.join(src,'desktop-dist','pdfium.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));
  await fs.cp(new URL('../resources/standard-skills',import.meta.url),path.join(src,'resources/standard-skills'),{recursive:true});
  await fs.mkdir(path.join(src,'resources/branding'),{recursive:true});await fs.writeFile(path.join(src,'resources/branding/icon.png'),'icon');
  const templateRoot=path.join(src,'resources','document-templates');await fs.mkdir(templateRoot,{recursive:true});
  const templateManifest={};
  for(const kind of ['reply','application']){const bytes=Buffer.from('template-'+kind);await fs.writeFile(path.join(templateRoot,kind+'.docx'),bytes);templateManifest[kind]={templateSha256:createHash('sha256').update(bytes).digest('hex')};}
  await fs.writeFile(path.join(templateRoot,'manifest.json'),JSON.stringify(templateManifest));
  await fs.writeFile(path.join(src, 'dist', 'index.html'), '<html><body>workbench</body></html>\n');
  await fs.writeFile(path.join(src, 'dist', 'assets', 'index.js'), 'console.log("ok");\n');
  if (includeRules) {
    const rules = path.join(src, 'resources', 'reply-rules');
    await fs.mkdir(rules, {recursive: true});
    for (const name of [
      'ai_reply_template_prompt.md',
      'ai_reply_first_office_action_prompt.md',
      'ai_reply_second_office_action_prompt.md',
      'ai_reply_third_office_action_prompt.md',
      'ai_reply_correction_prompt.md',
    ]) {
      await fs.writeFile(path.join(rules, name), `# ${name}\n`);
    }
  }
  await fs.mkdir(path.dirname(dest), {recursive: true});
  await asar.createPackage(src, dest);
  await fs.rm(src, {recursive: true, force: true});
}

async function writeRuntime(resourcesDir, platform) {
  const runtime = path.join(resourcesDir, 'agent-runtime');
  await fs.mkdir(runtime, {recursive: true});
  await fs.writeFile(path.join(runtime, 'OPENCODE-LICENSE.txt'), 'MIT\n');
  const files = [];
  if (platform === 'mac') {
    const rel = 'darwin-arm64/opencode';
    const abs = path.join(runtime, rel);
    await fs.mkdir(path.dirname(abs), {recursive: true});
    const buf = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from('mac')]);
    await fs.writeFile(abs, buf);
    files.push({
      platform: 'darwin-arm64',
      version: '1.18.30',
      file: rel,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      header: 'cffaedfe',
    });
  } else {
    const rel = 'win32-x64/opencode.exe';
    const abs = path.join(runtime, rel);
    await fs.mkdir(path.dirname(abs), {recursive: true});
    const buf = Buffer.from([0x4d, 0x5a, 0x78, 0x00, 0x01, 0x02]);
    await fs.writeFile(abs, buf);
    files.push({
      platform: 'win32-x64',
      version: '1.18.30',
      file: rel,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      header: '4d5a7800',
    });
  }
  await fs.writeFile(path.join(runtime, 'runtime-manifest.json'), `${JSON.stringify({runtime: 'OpenCode', version: '1.18.30', files})}\n`);
}

async function writeMacApp(appPath, version) {
  await fs.mkdir(path.join(appPath, 'Contents', 'MacOS'), {recursive: true});
  await fs.mkdir(path.join(appPath, 'Contents', 'Resources'), {recursive: true});
  await fs.writeFile(path.join(appPath, 'Contents', 'Info.plist'), infoPlist(version));
  const executable = path.join(appPath, 'Contents', 'MacOS', PRODUCT);
  await fs.writeFile(executable, '#!/bin/sh\n');
  await fs.chmod(executable, 0o755);
  await writeAsar(path.join(appPath, 'Contents', 'Resources', 'app.asar'), version);
  await writeRuntime(path.join(appPath, 'Contents', 'Resources'), 'mac');
  await fs.writeFile(path.join(path.dirname(path.dirname(appPath)),macInstallerName(version)),Buffer.from('xar!mock package'));
}

async function writeWindowsPortable(staging, version) {
  await fs.writeFile(path.join(staging, winPublishedName(version)), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(126, 1)]));
  await writeAsar(path.join(staging, 'win-unpacked', 'resources', 'app.asar'), version);
  await writeRuntime(path.join(staging, 'win-unpacked', 'resources'), 'win');
}

async function seedOldRelease(release) {
  for (const version of ['0.2.0', '0.2.1', '0.2.2', '0.2.3']) {
    await fs.writeFile(path.join(release, `PatentWorkbench-${version}-Windows.exe`), Buffer.from('MZ-old-'+version));
  }
  await fs.mkdir(path.join(release, 'mac', `${PRODUCT}.app`), {recursive: true});
  await fs.writeFile(path.join(release, 'mac', `${PRODUCT}.app`, 'old.txt'), 'old-mac');
  await fs.mkdir(path.join(release, 'mac-arm64', `${PRODUCT}.app`), {recursive: true});
  await fs.writeFile(path.join(release, 'mac-arm64', `${PRODUCT}.app`, 'old.txt'), 'old-arm64');
  await fs.mkdir(path.join(release, 'win-unpacked'), {recursive: true});
  await fs.writeFile(path.join(release, 'win-unpacked', 'dummy.txt'), 'unpacked');
  await fs.mkdir(path.join(release, 'win-arm64-unpacked'), {recursive: true});
  await fs.writeFile(path.join(release, 'win-arm64-unpacked', 'dummy.txt'), 'unpacked-arm64');
  await fs.writeFile(path.join(release, 'builder-debug.yml'), 'debug: true\n');
  await fs.writeFile(path.join(release, MANIFEST_NAME), `${JSON.stringify({version: '0.2.3'})}\n`);
  await fs.writeFile(path.join(release, '同事说明.txt'), '请保留这份说明');
  await fs.writeFile(path.join(release, 'PatentWorkbench-notes.txt'), 'not a build artifact');
}

async function harness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-release-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'patent-agent',
    version: VERSION,
    main: 'desktop-dist/main.cjs',
    build: {appId: 'com.patentworkbench.desktop', productName: PRODUCT},
  }, null, 2));
  const release = path.join(root, 'release');
  const staging = path.join(root, 'release-staging');
  await fs.mkdir(release);
  await fs.mkdir(staging);
  await seedOldRelease(release);
  return {root, release, staging};
}

const silent = () => {};
const snapshot = dir => fs.readdir(dir);

function assertBuilderFlags(args, platform) {
  const set = new Set(args);
  if (platform === 'mac') {
    assert.equal(set.has('--mac') && set.has('dir') && set.has('--arm64'), true);
    assert.equal(set.has('--win') || set.has('--x64') || set.has('nsis'), false);
    return;
  }
  if (platform === 'win') {
    assert.equal(set.has('--win') && set.has('nsis') && set.has('--x64'), true);
    assert.equal(set.has('--mac') || set.has('--arm64') || set.has('dir'), false);
    return;
  }
  assert.fail(`unexpected platform ${platform}`);
}

test('failed verification preserves previous outputs', async t => {
  const {root, release, staging} = await harness(t);
  const before = new Set(await snapshot(release));
  const oldManifest = await fs.readFile(path.join(release, MANIFEST_NAME), 'utf8');
  const oldNote = await fs.readFile(path.join(release, '同事说明.txt'), 'utf8');
  await writeMacApp(path.join(staging, 'mac-arm64', `${PRODUCT}.app`), '0.2.3');
  await writeWindowsPortable(staging, VERSION);
  await assert.rejects(
    () => runPackageRelease({projectRoot: root, skipPackaging: true, log: silent}),
    error => /校验未通过/.test(error.message),
  );
  assert.deepEqual(new Set(await snapshot(release)), before);
  assert.equal(await fs.readFile(path.join(release, MANIFEST_NAME), 'utf8'), oldManifest);
  assert.equal(await fs.readFile(path.join(release, '同事说明.txt'), 'utf8'), oldNote);
  assert.equal(await fs.readFile(path.join(release, 'PatentWorkbench-0.2.3-Windows.exe'), 'utf8'), 'MZ-old-0.2.3');
  await fs.stat(path.join(release, 'mac-arm64', `${PRODUCT}.app`));
  await fs.stat(staging);
});

test('successful publish removes recognized old artifacts only', async t => {
  const {root, release, staging} = await harness(t);
  await writeMacApp(path.join(staging, 'mac-arm64', `${PRODUCT}.app`), VERSION);
  await writeWindowsPortable(staging, VERSION);
  await runPackageRelease({projectRoot: root, skipPackaging: true, log: silent, builtAt: '2026-09-12T00:00:00.000Z'});
  const names = new Set(await snapshot(release));
  assert.deepEqual(names, new Set([
    macPublishedName(VERSION),
    macInstallerName(VERSION),
    winPublishedName(VERSION),
    MANIFEST_NAME,
    '同事说明.txt',
    'PatentWorkbench-notes.txt',
  ]));
  assert.equal(await fs.readFile(path.join(release, '同事说明.txt'), 'utf8'), '请保留这份说明');
  assert.equal(await fs.readFile(path.join(release, 'PatentWorkbench-notes.txt'), 'utf8'), 'not a build artifact');
  const plist = await fs.readFile(path.join(release, macPublishedName(VERSION), 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, /<string>专利工作台<\/string>/);
  assert.match(plist, new RegExp(`<string>${VERSION}</string>`));
  const exePath = path.join(release, winPublishedName(VERSION));
  const header = Buffer.alloc(2);
  const exe = await fs.open(exePath, 'r');
  await exe.read(header, 0, 2, 0);
  await exe.close();
  assert.equal(header.toString('ascii'), 'MZ');
  const manifest = JSON.parse(await fs.readFile(path.join(release, MANIFEST_NAME), 'utf8'));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.productName, PRODUCT);
  assert.equal(manifest.appId, 'com.patentworkbench.desktop');
  assert.equal(manifest.builtAt, '2026-09-12T00:00:00.000Z');
  assert.equal(manifest.files.length, 3);
  const winFile = manifest.files.find(file => file.platform === 'win-x64');
  const macFile = manifest.files.find(file => file.platform === 'mac-arm64');
  const exeBytes = await fs.readFile(exePath);
  assert.equal(winFile.hashAlgorithm, FILE_HASH_ALGORITHM);
  assert.equal(winFile.sha256, createHash('sha256').update(exeBytes).digest('hex'));
  assert.equal(macFile.hashAlgorithm, TREE_HASH_ALGORITHM);
  assert.notEqual(macFile.sha256, winFile.sha256);
  await assert.rejects(() => fs.stat(staging), {code: 'ENOENT'});
});

test('partial publish failure rolls back leftover copies and leaves previous outputs', async t => {
  const {root, release, staging} = await harness(t);
  const before = new Set(await snapshot(release));
  await writeMacApp(path.join(staging, 'mac-arm64', `${PRODUCT}.app`), VERSION);
  await writeWindowsPortable(staging, VERSION);
  let copies = 0;
  await assert.rejects(
    () => runPackageRelease({
      projectRoot: root,
      skipPackaging: true,
      log: silent,
      copyPath: async (src, dest) => {
        copies += 1;
        if (copies === 2) {
          await fs.writeFile(dest, 'partial-promoting');
          throw new Error('injected copy failure');
        }
        return copyArtifact(src, dest);
      },
    }),
    error => /已回滚/.test(error.message) && /injected copy failure/.test(error.message),
  );
  assert.ok(copies >= 2);
  assert.deepEqual(new Set(await snapshot(release)), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(release, MANIFEST_NAME), 'utf8')).version, '0.2.3');
  await assert.rejects(() => fs.stat(path.join(release, macPublishedName(VERSION))), {code: 'ENOENT'});
  await assert.rejects(() => fs.stat(path.join(release, winPublishedName(VERSION))), {code: 'ENOENT'});
  const leftover = (await snapshot(release)).filter(name => name.startsWith('.promoting-') || name.startsWith('.release-backup-'));
  assert.deepEqual(leftover, []);
});

test('full release runs npm build once then separate mac arm64 and win x64 builder commands', async t => {
  const {root, release, staging} = await harness(t);
  await fs.mkdir(path.join(root, 'node_modules', 'electron-builder'), {recursive: true});
  await fs.writeFile(path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '// stub\n');
  const planned = packagingCommands({
    platforms: ['mac', 'win'],
    projectRoot: root,
    stagingDir: staging,
    nodePath: process.execPath,
    npmCommand: 'npm',
  });
  assert.equal(planned.length, 3);
  assert.deepEqual(planned[0].args, ['run', 'build']);
  assert.equal(planned.filter(step => step.role === 'build').length, 1);
  assertBuilderFlags(planned[1].args, 'mac');
  assertBuilderFlags(planned[2].args, 'win');
  assert.equal(planned.some(step => step.args.includes('--mac') && step.args.includes('--win')), false);
  assert.equal(planned.some(step => step.args.includes('--arm64') && step.args.includes('--x64')), false);

  const calls = [];
  await runPackageRelease({
    projectRoot: root,
    log: silent,
    builtAt: '2026-09-12T00:00:00.000Z',
    runCommand: async (command, args) => {
      calls.push({command, args: [...args]});
      if (args.includes('--mac')) {
        assertBuilderFlags(args, 'mac');
        await writeMacApp(path.join(staging, 'mac-arm64', `${PRODUCT}.app`), VERSION);
        return;
      }
      if (args.includes('--win')) {
        assertBuilderFlags(args, 'win');
        await writeWindowsPortable(staging, VERSION);
      }
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ['run', 'build']);
  assert.equal(calls.filter(call => call.args[0] === 'run' && call.args[1] === 'build').length, 1);
  assertBuilderFlags(calls[1].args, 'mac');
  assertBuilderFlags(calls[2].args, 'win');
  assert.deepEqual(calls.map(call => call.args), planned.map(step => step.args));
  assert.ok((await snapshot(release)).includes(macPublishedName(VERSION)));
  assert.ok((await snapshot(release)).includes(winPublishedName(VERSION)));
});

function existingLockError(lock) {
  return error => error.message.includes(lock) && /过期锁/.test(error.message) && /手动删除/.test(error.message);
}

test('empty or malformed lock is fail-closed and not deleted', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-lock-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const contents of ['', '  ', '{', '{"pid":1}']) {
    const lock = path.join(root, `lock-${Buffer.from(contents).toString('hex') || 'empty'}`);
    await fs.writeFile(lock, contents);
    await assert.rejects(() => acquirePackageLock(lock), existingLockError(lock));
    assert.equal(await fs.readFile(lock, 'utf8'), contents);
  }
});

test('dead-owner lock is left byte-for-byte unchanged and is not acquired', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-lock-dead-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const lock = path.join(root, '.package-release.lock');
  const existing = `${JSON.stringify({pid: 1, startedAt: '2020-01-01T00:00:00.000Z', token: 'stale-token'})}\n`;
  await fs.writeFile(lock, existing);
  await assert.rejects(() => acquirePackageLock(lock), existingLockError(lock));
  assert.equal(await fs.readFile(lock, 'utf8'), existing);
});

test('live-owner lock contention does not steal the lock', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-lock-live-'));
  const lock = path.join(root, '.package-release.lock');
  const unlock = await acquirePackageLock(lock);
  t.after(async () => {
    await unlock();
    await fs.rm(root, {recursive: true, force: true});
  });
  const before = await fs.readFile(lock);
  assert.equal(JSON.parse(before.toString()).pid, process.pid);
  await assert.rejects(() => acquirePackageLock(lock), existingLockError(lock));
  assert.deepEqual(await fs.readFile(lock), before);
});

test('mac-only publish preserves windows builder dirs and old windows executables', async t => {
  const {root, release, staging} = await harness(t);
  await writeMacApp(path.join(staging, 'mac-arm64', `${PRODUCT}.app`), VERSION);
  await runPackageRelease({projectRoot: root, skipPackaging: true, platforms: ['mac'], log: silent});
  const names = new Set(await snapshot(release));
  assert.ok(names.has(macPublishedName(VERSION)));
  assert.ok(!names.has('mac-arm64'));
  assert.ok(!names.has('mac'));
  assert.ok(names.has('win-unpacked'));
  assert.ok(names.has('win-arm64-unpacked'));
  assert.ok(names.has('PatentWorkbench-0.2.3-Windows.exe'));
  assert.ok(!names.has(winPublishedName(VERSION)));
  await fs.stat(path.join(release, 'win-unpacked', 'dummy.txt'));
  assert.equal(await fs.readFile(path.join(release, '同事说明.txt'), 'utf8'), '请保留这份说明');
});

test('win-only publish preserves mac builder dirs including legacy app bundles', async t => {
  const {root, release, staging} = await harness(t);
  await writeWindowsPortable(staging, VERSION);
  await runPackageRelease({projectRoot: root, skipPackaging: true, platforms: ['win'], log: silent});
  const names = new Set(await snapshot(release));
  assert.ok(names.has(winPublishedName(VERSION)));
  assert.ok(!names.has('win-unpacked'));
  assert.ok(!names.has('win-arm64-unpacked'));
  assert.ok(!names.has('PatentWorkbench-0.2.3-Windows.exe'));
  assert.ok(names.has('mac-arm64'));
  assert.ok(names.has('mac'));
  assert.ok(!names.has(macPublishedName(VERSION)));
  assert.equal(await fs.readFile(path.join(release, 'mac-arm64', `${PRODUCT}.app`, 'old.txt'), 'utf8'), 'old-arm64');
  assert.equal(await fs.readFile(path.join(release, 'mac', `${PRODUCT}.app`, 'old.txt'), 'utf8'), 'old-mac');
  assert.equal(await fs.readFile(path.join(release, '同事说明.txt'), 'utf8'), '请保留这份说明');
});

test('missing bundled OpenCode runtime fails verification and keeps previous release', async t => {
  const {root, release, staging} = await harness(t);
  const before = new Set(await snapshot(release));
  await writeMacApp(path.join(staging, 'mac-arm64', `${PRODUCT}.app`), VERSION);
  await fs.rm(path.join(staging, 'mac-arm64', `${PRODUCT}.app`, 'Contents', 'Resources', 'agent-runtime'), {recursive: true, force: true});
  await assert.rejects(
    () => runPackageRelease({projectRoot: root, skipPackaging: true, platforms: ['mac'], log: silent}),
    error => /OpenCode|运行时/.test(error.message),
  );
  assert.deepEqual(new Set(await snapshot(release)), before);
});

test('missing reply-rules fails verification and keeps previous release', async t => {
  const {root, release, staging} = await harness(t);
  const before = new Set(await snapshot(release));
  const appPath = path.join(staging, 'mac-arm64', `${PRODUCT}.app`);
  await fs.mkdir(path.join(appPath, 'Contents', 'MacOS'), {recursive: true});
  await fs.mkdir(path.join(appPath, 'Contents', 'Resources'), {recursive: true});
  await fs.writeFile(path.join(appPath, 'Contents', 'Info.plist'), infoPlist(VERSION));
  await fs.writeFile(path.join(appPath, 'Contents', 'MacOS', PRODUCT), '#!/bin/sh\n');
  await fs.chmod(path.join(appPath, 'Contents', 'MacOS', PRODUCT), 0o755);
  await writeAsar(path.join(appPath, 'Contents', 'Resources', 'app.asar'), VERSION, {includeRules: false});
  await writeRuntime(path.join(appPath, 'Contents', 'Resources'), 'mac');
  await fs.writeFile(path.join(staging,macInstallerName(VERSION)),Buffer.from('xar!mock package'));
  await assert.rejects(
    () => runPackageRelease({projectRoot: root, skipPackaging: true, platforms: ['mac'], log: silent}),
    error => /reply-rules|缺少/.test(error.message),
  );
  assert.deepEqual(new Set(await snapshot(release)), before);
});

test('runtime hash mismatch fails before promote and keeps previous release', async t => {
  const {root, release, staging} = await harness(t);
  const before = new Set(await snapshot(release));
  const appPath = path.join(staging, 'mac-arm64', `${PRODUCT}.app`);
  await writeMacApp(appPath, VERSION);
  const manifestPath = path.join(appPath, 'Contents', 'Resources', 'agent-runtime', 'runtime-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files[0].sha256 = '0'.repeat(64);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    () => runPackageRelease({projectRoot: root, skipPackaging: true, platforms: ['mac'], log: silent}),
    error => /哈希/.test(error.message),
  );
  assert.deepEqual(new Set(await snapshot(release)), before);
});
