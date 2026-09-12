import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { DesktopService } from './service.ts';
import { CaseFiles, digest } from './files.ts';
import {
  copyAccountNamespace, ioErrorMessage, namespaceHasEntries, scanAccountNamespace, stagingDirName,
  STAGING_PREFIX, validateMigrationDestination, verifyCopiedNamespace, waitForFilesystemIdle,
} from './migration.ts';
import type { Case } from '../src/domain/workflow.ts';

const pdf = Buffer.from('%PDF-1.7\nFictional patent fixture\n%%EOF');
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-migration-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const originals = path.join(root, '原始申请库'), work = path.join(root, '工作文件夹');
  await fs.mkdir(originals); await fs.mkdir(work);
  const key = randomBytes(32);
  const vault = {
    available: () => true,
    encrypt: (s: string) => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]); },
    decrypt: (b: Buffer) => { const c = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString(); },
  };
  const make = (device = '本机记录') => new DesktopService(path.join(root, device), vault, () => { throw new Error('network disabled in migration tests'); });
  return {root, originals, work, make};
}
async function listTree(root: string) {
  const out: {rel: string; sha: string; size: number; dir: boolean}[] = [];
  const walk = async (dir: string, rel: string) => {
    let entries;
    try { entries = await fs.readdir(dir, {withFileTypes: true}); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push({rel: childRel, sha: '', size: 0, dir: true});
        await walk(full, childRel);
      } else {
        const buf = await fs.readFile(full);
        out.push({rel: childRel, sha: createHash('sha256').update(buf).digest('hex'), size: buf.length, dir: false});
      }
    }
  };
  await walk(root, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
async function emptyDir(root: string, name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  return dir;
}

test('validateMigrationDestination rejects nonempty, same, nested, original-library and symlink targets', async t => {
  const f = await fixture(t);
  const workReal = await fs.realpath(f.work);
  const origReal = await fs.realpath(f.originals);
  const dest = await emptyDir(f.root, '空目标');
  const destReal = (await validateMigrationDestination({sourceRoot: workReal, destination: dest, originalLibrary: origReal})).resolved;
  assert.equal(destReal, await fs.realpath(dest));

  await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: workReal, originalLibrary: origReal}), /相同/);
  await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: origReal, originalLibrary: origReal}), /原始申请|同一个/);
  await fs.writeFile(path.join(dest, '已有.txt'), 'no');
  await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: dest, originalLibrary: origReal}), /空文件夹/);
  await fs.rm(path.join(dest, '已有.txt'));

  const nested = path.join(f.work, '内嵌目标'); await fs.mkdir(nested);
  await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: nested, originalLibrary: origReal}), /位于当前工作文件夹/);
  const parent = f.root;
  await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: parent, originalLibrary: origReal}), /上级|空文件夹/);
  const escapeSame = path.join(dest, '..', path.basename(f.work));
  await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: escapeSame, originalLibrary: origReal}), /相同|上级|位于/);

  const fileDest = path.join(f.root, 'not-a-dir'); await fs.writeFile(fileDest, 'x');
  await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: fileDest, originalLibrary: origReal}), /必须是文件夹/);

  const link = path.join(f.root, 'link-dest');
  try {
    await fs.symlink(dest, link);
    await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: link, originalLibrary: origReal}), /符号链接/);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
  }

  const origInside = await emptyDir(f.root, '会装下原始库的目标');
  await assert.rejects(validateMigrationDestination({sourceRoot: workReal, destination: origInside, originalLibrary: origInside}), /原始申请|同一个/);
});

test('waitForFilesystemIdle times out and cancel maps to a clear error', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(waitForFilesystemIdle({isBusy: () => true, signal, timeoutMs: 60}), /无法在迁移前安全结束/);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(waitForFilesystemIdle({isBusy: () => true, signal: ctl.signal, timeoutMs: 1000}), /取消/);
  assert.match(ioErrorMessage({code: 'ENOSPC', message: 'enospc'}), /磁盘空间不足/);
});

test('migrate nested files, drafts, manual files and empty dirs then reopen usable files; original library and old work remain', async t => {
  const f = await fixture(t), service = f.make();
  await service.init();
  await service.settings('local', {...service.workspace.settings, originalLibrary: f.originals, workRoot: f.work});
  await service.createCase({title: '夹持装置 测试', number: 'MIG-001', kind: 'write'});
  const c = service.workspace.cases[0];
  const edit = structuredClone(service.workspace);
  edit.cases[0].localDraft = '迁移前工作稿';
  edit.cases[0].localVersions = [{id: randomUUID(), text: '迁移前工作稿', at: new Date().toISOString(), processId: c.current?.processId}];
  await service.save('local', edit);
  const caseDir = path.join(f.work, c.directory!);
  await fs.mkdir(path.join(caseDir, '01_通知与材料', '用户 材料'), {recursive: true});
  await fs.writeFile(path.join(caseDir, '01_通知与材料', '用户 材料', '说明 文件.txt'), '手工材料 utf-8 中文');
  await fs.mkdir(path.join(caseDir, '04_内部说明', '空目录', '再空'), {recursive: true});
  await fs.writeFile(path.join(caseDir, '手工备忘.bin'), Buffer.from([1, 2, 3, 9]));
  await fs.mkdir(path.join(caseDir, '00_原始申请'), {recursive: true});
  await fs.writeFile(path.join(caseDir, '00_原始申请', '已复制原件.pdf'), pdf);
  await fs.writeFile(path.join(f.originals, '库内原件.pdf'), pdf);
  const unindexed = path.join(f.work, '案件', 'local', '未索引案件目录');
  await fs.mkdir(unindexed, {recursive: true});
  await fs.writeFile(path.join(unindexed, 'notes.txt'), 'unindexed');
  const other = path.join(f.work, '案件', 'other-account', 'case-x');
  await fs.mkdir(other, {recursive: true});
  await fs.writeFile(path.join(other, 'secret.txt'), 'other-account-only');

  const origLibBefore = await listTree(f.originals);
  const oldWorkBefore = await listTree(f.work);
  const dest = await emptyDir(f.root, '新的 工作 目录');
  const preview = await service.previewWorkMigration('local', dest);
  assert.equal(preview.profileKey, 'local');
  assert.equal(preview.emptyNamespace, false);
  assert.equal(preview.caseDirectoryCount, 1);
  assert.equal(preview.extraDirectoryCount, 1);
  assert.ok(preview.fileCount >= 4);
  assert.equal(preview.originalLibrary, await fs.realpath(f.originals));
  const saved = await service.startWorkMigration('local', preview.id);
  const destReal = await fs.realpath(dest);
  assert.equal(saved.workspace.settings.workRoot, destReal);
  assert.equal(saved.workspace.settings.originalLibrary, await fs.realpath(f.originals));
  assert.equal(saved.workspace.cases[0].id, c.id);
  assert.equal(saved.workspace.cases[0].directory, c.directory);
  assert.equal(saved.workspace.cases[0].localDraft, '迁移前工作稿');

  const destCase = path.join(destReal, c.directory!);
  assert.equal(await fs.readFile(path.join(destCase, '01_通知与材料', '用户 材料', '说明 文件.txt'), 'utf8'), '手工材料 utf-8 中文');
  assert.deepEqual(await fs.readFile(path.join(destCase, '手工备忘.bin')), Buffer.from([1, 2, 3, 9]));
  assert.deepEqual(await fs.readFile(path.join(destCase, '00_原始申请', '已复制原件.pdf')), pdf);
  assert.equal(await fs.readFile(path.join(destReal, '案件', 'local', '未索引案件目录', 'notes.txt'), 'utf8'), 'unindexed');
  await fs.stat(path.join(destCase, '04_内部说明', '空目录', '再空'));
  await assert.rejects(fs.stat(path.join(destReal, '案件', 'other-account')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(other, 'secret.txt'), 'utf8'), 'other-account-only');
  assert.deepEqual(await listTree(f.originals), origLibBefore);
  assert.deepEqual(await listTree(f.work), oldWorkBefore);
  const leftover = (await fs.readdir(destReal)).filter(name => name.startsWith(STAGING_PREFIX));
  assert.deepEqual(leftover, []);

  const files = new CaseFiles(service.workspace.settings, service.key);
  const nextDraft: Case = structuredClone(service.workspace.cases[0]);
  nextDraft.localDraft = '迁移后可保存';
  await files.saveDraft(nextDraft);
  assert.equal(JSON.parse(await fs.readFile(path.join(destCase, '02_工作稿', digest(c.current?.processId ?? c.current?.roundId ?? 'local').slice(0, 10), '工作稿.json'), 'utf8')).text, '迁移后可保存');

  const reopened = f.make();
  await reopened.init();
  assert.equal(reopened.workspace.settings.workRoot, destReal);
  assert.equal(reopened.workspace.cases[0].id, c.id);
  assert.equal(reopened.workspace.cases[0].directory, c.directory);
  assert.equal(reopened.workspace.cases[0].localDraft, '迁移后可保存');
  const more = structuredClone(reopened.workspace);
  more.cases[0].localDraft = '重开后再保存';
  await reopened.save('local', more);
  assert.equal(reopened.workspace.cases[0].localDraft, '重开后再保存');
  assert.deepEqual(await fs.readFile(path.join(f.originals, '库内原件.pdf')), pdf);
});

test('cancellation and nonempty destination at execute do not switch roots', async t => {
  const f = await fixture(t), service = f.make();
  await service.init();
  await service.settings('local', {...service.workspace.settings, originalLibrary: f.originals, workRoot: f.work});
  await service.createCase({title: '取消测试', number: 'MIG-002', kind: 'write'});
  const dest = await emptyDir(f.root, '取消目标');
  const preview = await service.previewWorkMigration('local', dest);
  const oldRoot = service.workspace.settings.workRoot;
  service.syncPreparing = true;
  const pending = service.startWorkMigration('local', preview.id);
  await service.cancelWorkMigration();
  await assert.rejects(pending, /取消/);
  service.syncPreparing = false;
  assert.equal(service.workspace.settings.workRoot, oldRoot);
  await assert.rejects(fs.stat(path.join(dest, '案件')), /ENOENT/);

  await fs.writeFile(path.join(dest, 'later.txt'), 'occupied');
  await assert.rejects(service.startWorkMigration('local', preview.id), /空文件夹|预览/);
  assert.equal(service.workspace.settings.workRoot, oldRoot);
  assert.equal(await namespaceHasEntries(oldRoot!, 'local'), true);
});

test('account namespace isolation and empty namespace settings switch', async t => {
  const f = await fixture(t), service = f.make();
  await service.init();
  await service.settings('local', {...service.workspace.settings, originalLibrary: f.originals, workRoot: f.work});
  const foreign = path.join(f.work, '案件', 'other-account', 'keep');
  await fs.mkdir(foreign, {recursive: true});
  await fs.writeFile(path.join(foreign, 'only-other.txt'), 'stay');
  const dest = await emptyDir(f.root, '空命名空间目标');
  const preview = await service.previewWorkMigration('local', dest);
  assert.equal(preview.emptyNamespace, true);
  assert.equal(preview.fileCount, 0);
  const saved = await service.startWorkMigration('local', preview.id);
  assert.equal(saved.workspace.settings.workRoot, await fs.realpath(dest));
  assert.equal(await fs.readFile(path.join(foreign, 'only-other.txt'), 'utf8'), 'stay');
  await assert.rejects(fs.stat(path.join(dest, '案件')), /ENOENT/);
});

test('settings write failure rolls back published namespace and keeps the original root', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const f = await fixture(t), service = f.make('chmod-profile');
  await service.init();
  await service.settings('local', {...service.workspace.settings, originalLibrary: f.originals, workRoot: f.work});
  await service.createCase({title: '回滚测试', number: 'MIG-003', kind: 'write'});
  const caseRel = service.workspace.cases[0].directory!;
  await fs.writeFile(path.join(f.work, caseRel, 'keep.txt'), 'source-bytes');
  const dest = await emptyDir(f.root, '回滚目标');
  const preview = await service.previewWorkMigration('local', dest);
  const profileDir = path.dirname(service.profileFile());
  const oldRoot = service.workspace.settings.workRoot;
  const before = await fs.readFile(service.profileFile());
  try {
    await fs.chmod(profileDir, 0o500);
    await assert.rejects(service.startWorkMigration('local', preview.id), /未能保存|EACCES|EPERM|权限/);
    assert.equal(service.workspace.settings.workRoot, oldRoot);
    assert.deepEqual(await fs.readFile(service.profileFile()), before);
    await assert.rejects(fs.stat(path.join(dest, '案件', 'local')), /ENOENT/);
    assert.equal(await fs.readFile(path.join(f.work, caseRel, 'keep.txt'), 'utf8'), 'source-bytes');
  } finally { await fs.chmod(profileDir, 0o700); }
  const reopened = f.make('chmod-profile');
  await reopened.init();
  assert.equal(reopened.workspace.settings.workRoot, oldRoot);
  assert.equal(await fs.readFile(path.join(f.work, caseRel, 'keep.txt'), 'utf8'), 'source-bytes');
});

test('migration lock blocks case writes, settings, account switch and sync, then releases after cancel', async t => {
  const f = await fixture(t), service = f.make();
  await service.init();
  await service.settings('local', {...service.workspace.settings, workRoot: f.work});
  await service.createCase({title: '锁定测试', number: 'MIG-004', kind: 'write'});
  const dest = await emptyDir(f.root, '锁定目标');
  const preview = await service.previewWorkMigration('local', dest);
  service.syncPreparing = true;
  const pending = service.startWorkMigration('local', preview.id);
  await assert.rejects(service.save('local', service.workspace), /迁移/);
  await assert.rejects(service.settings('local', service.workspace.settings), /迁移/);
  await assert.rejects(service.createCase({title: 'x', number: 'MIG-005', kind: 'write'}), /迁移/);
  await assert.rejects(service.sync(), /迁移/);
  await assert.rejects(service.logout(), /迁移/);
  await service.cancelWorkMigration();
  await assert.rejects(pending, /取消/);
  service.syncPreparing = false;
  const other = await emptyDir(f.root, '锁定后仍可改');
  await assert.rejects(service.settings('local', {...service.workspace.settings, workRoot: other}), /已有案件/);
});

test('verifyCopiedNamespace rescans source and rejects a file added after copy', async t => {
  const f = await fixture(t);
  const ns = path.join(f.work, '案件', 'local');
  await fs.mkdir(ns, {recursive: true});
  await fs.writeFile(path.join(ns, 'first.txt'), 'source');
  const signal = new AbortController().signal;
  const scan = await scanAccountNamespace(f.work, 'local', signal);
  const dest = path.join(f.root, 'copied-ns');
  await fs.mkdir(dest);
  const records = await copyAccountNamespace({sourceRoot: ns, destRoot: dest, scan, signal});
  await fs.writeFile(path.join(ns, 'added-during-migration.txt'), 'new content');
  await assert.rejects(verifyCopiedNamespace({sourceRoot: ns, destRoot: dest, scan, records, signal}), /变化/);
  assert.equal(await fs.readFile(path.join(ns, 'added-during-migration.txt'), 'utf8'), 'new content');
});

test('service rejects root switch when a source file is added during verification and keeps the new file', async t => {
  const f = await fixture(t), service = f.make();
  await service.init();
  await service.settings('local', {...service.workspace.settings, originalLibrary: f.originals, workRoot: f.work});
  await service.createCase({title: '注入测试', number: 'MIG-006', kind: 'write'});
  const dest = await emptyDir(f.root, '注入目标');
  const preview = await service.previewWorkMigration('local', dest);
  const oldRoot = service.workspace.settings.workRoot;
  const added = path.join(f.work, '案件', 'local', 'added-during-migration.txt');
  service.migrationTestHook = async phase => {
    if (phase === 'verifying') await fs.writeFile(added, 'new content');
  };
  await assert.rejects(service.startWorkMigration('local', preview.id), /变化/);
  service.migrationTestHook = undefined;
  assert.equal(service.workspace.settings.workRoot, oldRoot);
  assert.equal(await fs.readFile(added, 'utf8'), 'new content');
  await assert.rejects(fs.stat(path.join(dest, '案件', 'local')), /ENOENT/);
});

test('pre-existing staging is not deleted; external dest files abort publish and are preserved', async t => {
  const f = await fixture(t), service = f.make();
  await service.init();
  await service.settings('local', {...service.workspace.settings, originalLibrary: f.originals, workRoot: f.work});
  await service.createCase({title: '暂存冲突', number: 'MIG-007', kind: 'write'});
  const dest = await emptyDir(f.root, '暂存目标');
  const preview = await service.previewWorkMigration('local', dest);
  const destReal = await fs.realpath(dest);
  const staging = path.join(destReal, stagingDirName(preview.id));
  const oldRoot = service.workspace.settings.workRoot;
  service.migrationTestHook = async phase => {
    if (phase === 'beforeStaging') {
      await fs.mkdir(staging);
      await fs.writeFile(path.join(staging, 'preexisting.txt'), 'keep-me');
    }
  };
  await assert.rejects(service.startWorkMigration('local', preview.id), /暂存/);
  service.migrationTestHook = undefined;
  assert.equal(await fs.readFile(path.join(staging, 'preexisting.txt'), 'utf8'), 'keep-me');
  assert.equal(service.workspace.settings.workRoot, oldRoot);
  await fs.rm(staging, {recursive: true, force: true});
  const dest2 = await emptyDir(f.root, '外部写入目标');
  const preview2 = await service.previewWorkMigration('local', dest2);
  service.migrationTestHook = async phase => {
    if (phase === 'beforePublish') await fs.writeFile(path.join(dest2, 'external.txt'), 'outside');
  };
  await assert.rejects(service.startWorkMigration('local', preview2.id), /其他内容/);
  service.migrationTestHook = undefined;
  assert.equal(service.workspace.settings.workRoot, oldRoot);
  assert.equal(await fs.readFile(path.join(dest2, 'external.txt'), 'utf8'), 'outside');
  const leftover = (await fs.readdir(dest2)).filter(name => name.startsWith(STAGING_PREFIX));
  assert.deepEqual(leftover, []);
});

test('queued migration flag rejects new operations immediately without blocking pre-lock writes', async t => {
  const f = await fixture(t), service = f.make();
  await service.init();
  await service.settings('local', {...service.workspace.settings, workRoot: f.work});
  await service.createCase({title: '队列测试', number: 'MIG-008', kind: 'write'});
  service.markWorkMigrationQueued();
  assert.throws(() => service.assertMigrationNotAccepted(), /迁移/);
  await service.save('local', service.workspace);
  service.clearWorkMigrationQueued();
  service.assertMigrationNotAccepted();
});
