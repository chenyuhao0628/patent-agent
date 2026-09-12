import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { digest, managedPath, portable, validateRoots } from './files.ts';
import type { MigrationPreview, MigrationProgress } from '../src/desktop.ts';

export const STAGING_PREFIX = 'patent-workbench-migration-staging-';
export const MIGRATION_LIMITS = {maxDepth: 20, maxEntries: 100_000, maxFileBytes: 4 * 1024 * 1024 * 1024};
const IDLE_WAIT_MS = 30_000;

export type NamespaceEntry = {
  rel: string;
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: string;
  dev: number;
};
export type NamespaceScan = {
  namespaceRoot: string;
  entries: NamespaceEntry[];
  fileCount: number;
  directoryCount: number;
  caseDirectoryCount: number;
  extraDirectoryCount: number;
  byteCount: number;
  empty: boolean;
  fingerprint: string;
  contentFingerprint: string;
  identityFingerprint: string;
};
export type PreparedMigration = {
  preview: MigrationPreview;
  fingerprint: string;
  chosenPath: string;
  destResolved: string;
  sourceRoot: string;
  profileKey: string;
};
export type CopyRecords = Map<string, {size: number; sha256: string}>;

export function isInside(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

export function cancelledError() {
  return new Error('迁移已取消，未切换工作文件夹。');
}

export function ioErrorMessage(e: unknown) {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'ENOSPC') return '磁盘空间不足，迁移失败，未切换工作文件夹。原文件未改动。';
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return '没有权限完成工作目录迁移，未切换工作文件夹。';
  if (err?.code === 'EEXIST') return '目标位置已有同名文件，未覆盖，未切换工作文件夹。';
  const msg = (err?.message || '工作目录迁移失败').trim();
  return /未切换/.test(msg) ? msg : msg.replace(/。$/, '') + '。未切换工作文件夹。';
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw cancelledError();
}

function assertSafeRelative(rel: string) {
  const norm = portable(rel);
  if (!norm || path.isAbsolute(rel) || path.isAbsolute(norm) || norm.includes('\0')) throw new Error('工作文件路径无效，未切换工作文件夹。');
  const parts = norm.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Error('工作文件路径无效，未切换工作文件夹。');
  if (norm.length > 4000) throw new Error('工作文件路径过长，未切换工作文件夹。');
}

export function resolveUnder(root: string, rel: string) {
  assertSafeRelative(rel);
  const abs = path.resolve(root, ...portable(rel).split('/'));
  if (!isInside(root, abs)) throw new Error('工作文件路径无效，未切换工作文件夹。');
  return abs;
}

function metaFromStat(st: {mtimeMs: number; ctimeMs: number; ino: number | bigint; dev: number}) {
  return {mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: String(st.ino), dev: st.dev};
}
export function contentFingerprintOf(entries: NamespaceEntry[]) {
  return digest(entries.map(e => `${e.kind}\t${e.size}\t${e.rel}`).sort().join('\n'));
}
export function identityFingerprintOf(entries: NamespaceEntry[]) {
  return digest(entries.map(e => `${e.kind}\t${e.size}\t${e.rel}\t${e.mtimeMs}\t${e.ctimeMs}\t${e.dev}\t${e.ino}`).sort().join('\n'));
}
function fingerprints(entries: NamespaceEntry[]) {
  const contentFingerprint = contentFingerprintOf(entries);
  const identityFingerprint = identityFingerprintOf(entries);
  return {contentFingerprint, identityFingerprint, fingerprint: identityFingerprint};
}

export async function assertNoSymlinkAncestry(root: string, target: string) {
  const givenRoot = path.resolve(root), givenTarget = path.resolve(target);
  const rootStat = await fs.lstat(givenRoot);
  if (rootStat.isSymbolicLink()) throw new Error('复制或校验过程中发现符号链接，未切换工作文件夹。');
  let walkRoot = givenRoot, walkTarget = givenTarget;
  if (!isInside(givenRoot, givenTarget)) {
    walkRoot = await fs.realpath(givenRoot);
    try { walkTarget = await fs.realpath(givenTarget); } catch { walkTarget = givenTarget; }
    if (!isInside(walkRoot, walkTarget)) throw new Error('工作文件路径无效，未切换工作文件夹。');
  }
  let cursor = walkRoot;
  const rel = path.relative(walkRoot, walkTarget);
  if (rel === '') return;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const st = await fs.lstat(cursor);
    if (st.isSymbolicLink()) throw new Error('复制或校验过程中发现符号链接，未切换工作文件夹。');
  }
}

async function isIndexedCaseDirectory(namespaceRoot: string, name: string, profileKey: string) {
  const manifest = path.join(namespaceRoot, name, '案件信息.json');
  try {
    const st = await fs.lstat(manifest);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 8 * 1024 * 1024) return false;
    const raw = JSON.parse(await fs.readFile(manifest, 'utf8')) as {schema?: unknown; profile?: unknown; id?: unknown; title?: unknown};
    return [1, 2].includes(Number(raw.schema)) && raw.profile === profileKey && typeof raw.id === 'string' && !!raw.id && typeof raw.title === 'string' && !!raw.title;
  } catch { return false; }
}

export async function namespaceHasEntries(workRoot: string, profileKey: string) {
  try {
    const ns = await managedPath(workRoot, path.join('案件', profileKey));
    return (await fs.readdir(ns)).length > 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

export async function validateMigrationDestination(input: {sourceRoot: string; destination: string; originalLibrary?: string}) {
  if (typeof input.destination !== 'string' || !input.destination.trim() || input.destination.includes('\0') || input.destination.length > 4096) {
    throw new Error('请使用系统文件夹选择器选择新的总工作文件夹。');
  }
  if (typeof input.sourceRoot !== 'string' || !input.sourceRoot) throw new Error('请先选择当前的总工作文件夹。');
  const destInput = path.resolve(input.destination);
  let destStat;
  try { destStat = await fs.lstat(destInput); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error('新的总工作文件夹不存在，请重新选择。');
    if (code === 'EACCES' || code === 'EPERM') throw new Error('无法访问新的总工作文件夹，请检查文件夹权限。');
    throw e;
  }
  if (destStat.isSymbolicLink()) throw new Error('新的总工作文件夹不能是符号链接。');
  if (!destStat.isDirectory()) throw new Error('新的总工作文件夹必须是文件夹。');
  let sourceStat;
  try { sourceStat = await fs.lstat(input.sourceRoot); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('当前总工作文件夹不存在，请重新选择。');
    throw e;
  }
  if (sourceStat.isSymbolicLink()) throw new Error('当前总工作文件夹不能是符号链接。');
  if (!sourceStat.isDirectory()) throw new Error('当前总工作文件夹必须是文件夹。');
  const sourceReal = await fs.realpath(input.sourceRoot);
  const destReal = await fs.realpath(destInput);
  if (sourceReal === destReal) throw new Error('新的总工作文件夹不能与当前总工作文件夹相同。');
  if (isInside(sourceReal, destReal)) throw new Error('新的总工作文件夹不能位于当前工作文件夹内。');
  if (isInside(destReal, sourceReal)) throw new Error('新的总工作文件夹不能是当前工作文件夹的上级目录。');
  const roots = await validateRoots({provider: '', baseUrl: '', model: '', originalLibrary: input.originalLibrary || '', workRoot: destReal});
  if (!roots.workRoot) throw new Error('请选择新的总工作文件夹。');
  if (roots.originalLibrary && roots.originalLibrary === roots.workRoot) throw new Error('新的总工作文件夹不能与原始申请文件库相同。');
  if (roots.workRoot === sourceReal) throw new Error('新的总工作文件夹不能与当前总工作文件夹相同。');
  if (isInside(sourceReal, roots.workRoot)) throw new Error('新的总工作文件夹不能位于当前工作文件夹内。');
  if (isInside(roots.workRoot, sourceReal)) throw new Error('新的总工作文件夹不能是当前工作文件夹的上级目录。');
  const listing = await fs.readdir(roots.workRoot);
  if (listing.length > 0) throw new Error('请选择或新建一个空文件夹作为新的总工作文件夹。不会合并或覆盖目标中的现有内容。');
  return {resolved: roots.workRoot, originalLibrary: roots.originalLibrary};
}

export async function scanAccountNamespace(workRoot: string, profileKey: string, signal: AbortSignal): Promise<NamespaceScan> {
  throwIfAborted(signal);
  const relativeNs = path.join('案件', profileKey);
  const namespaceRoot = await managedPath(workRoot, relativeNs);
  let exists = true;
  try {
    const st = await fs.lstat(namespaceRoot);
    if (st.isSymbolicLink()) throw new Error('当前账号工作目录含有符号链接，未开始切换。');
    if (!st.isDirectory()) throw new Error('当前账号工作目录不是文件夹，未开始切换。');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    exists = false;
  }
  if (!exists) {
    const fp = fingerprints([]);
    return {namespaceRoot, entries: [], fileCount: 0, directoryCount: 0, caseDirectoryCount: 0, extraDirectoryCount: 0, byteCount: 0, empty: true, ...fp};
  }
  const walked = await walkNamespaceTree(namespaceRoot, workRoot, signal, '当前账号工作目录');
  let caseDirectoryCount = 0, extraDirectoryCount = 0;
  for (const entry of walked.entries) {
    if (entry.kind !== 'dir' || entry.rel.includes('/')) continue;
    if (await isIndexedCaseDirectory(namespaceRoot, entry.rel, profileKey)) caseDirectoryCount++;
    else extraDirectoryCount++;
  }
  return {
    namespaceRoot,
    entries: walked.entries,
    fileCount: walked.fileCount,
    directoryCount: walked.directoryCount,
    caseDirectoryCount,
    extraDirectoryCount,
    byteCount: walked.byteCount,
    empty: walked.entries.length === 0,
    ...fingerprints(walked.entries),
  };
}

async function walkNamespaceTree(root: string, guardRoot: string, signal: AbortSignal, label: string) {
  const entries: NamespaceEntry[] = [];
  let fileCount = 0, directoryCount = 0, byteCount = 0, scanned = 0;
  const walk = async (dir: string, rel: string, depth: number) => {
    throwIfAborted(signal);
    await assertNoSymlinkAncestry(guardRoot, dir);
    if (depth > MIGRATION_LIMITS.maxDepth) throw new Error(`${label}层级超过限制，未切换工作文件夹。`);
    let listing;
    try { listing = await fs.readdir(dir, {withFileTypes: true}); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM') throw new Error(`没有权限读取${label}，未切换工作文件夹。`);
      throw e;
    }
    for (const entry of listing) {
      throwIfAborted(signal);
      if (++scanned > MIGRATION_LIMITS.maxEntries) throw new Error(`${label}数量超过限制，未切换工作文件夹。`);
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      assertSafeRelative(childRel);
      const full = path.join(dir, entry.name);
      if (!isInside(root, full) || !isInside(guardRoot, full)) throw new Error('工作文件路径无效，未切换工作文件夹。');
      const st = await fs.lstat(full);
      if (st.isSymbolicLink() || entry.isSymbolicLink()) throw new Error(`${label}含有符号链接，未切换工作文件夹。`);
      const meta = metaFromStat(st);
      if (st.isDirectory()) {
        directoryCount++;
        entries.push({rel: childRel, kind: 'dir', size: 0, ...meta});
        await walk(full, childRel, depth + 1);
      } else if (st.isFile()) {
        if (st.size > MIGRATION_LIMITS.maxFileBytes) throw new Error('存在超过大小限制的工作文件，未切换工作文件夹。');
        fileCount++;
        byteCount += st.size;
        entries.push({rel: childRel, kind: 'file', size: st.size, ...meta});
      } else throw new Error(`${label}含有不支持的文件类型，未切换工作文件夹。`);
    }
  };
  await walk(root, '', 0);
  entries.sort((a, b) => a.rel.localeCompare(b.rel) || a.kind.localeCompare(b.kind));
  return {entries, fileCount, directoryCount, byteCount};
}

export function buildPreview(input: {
  profileKey: string;
  sourceRoot: string;
  destinationRoot: string;
  originalLibrary: string;
  scan: NamespaceScan;
}): MigrationPreview {
  const id = digest([input.profileKey, input.sourceRoot, input.destinationRoot, input.scan.fingerprint, String(input.scan.fileCount), String(input.scan.byteCount)].join('\n')).slice(0, 32);
  return {
    id,
    profileKey: input.profileKey,
    sourceRoot: input.sourceRoot,
    destinationRoot: input.destinationRoot,
    originalLibrary: input.originalLibrary,
    caseDirectoryCount: input.scan.caseDirectoryCount,
    extraDirectoryCount: input.scan.extraDirectoryCount,
    fileCount: input.scan.fileCount,
    directoryCount: input.scan.directoryCount,
    byteCount: input.scan.byteCount,
    emptyNamespace: input.scan.empty,
  };
}

async function hashFile(file: string, signal: AbortSignal) {
  throwIfAborted(signal);
  const hash = createHash('sha256');
  const reader = createReadStream(file, {highWaterMark: 1024 * 1024});
  const abort = () => reader.destroy(cancelledError());
  signal.addEventListener('abort', abort, {once: true});
  try {
    for await (const chunk of reader) {
      throwIfAborted(signal);
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch (e) {
    if (signal.aborted) throw cancelledError();
    throw e;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function copyFileHashed(source: string, dest: string, expectedSize: number, signal: AbortSignal, onChunk?: (copiedInFile: number) => void) {
  throwIfAborted(signal);
  await fs.mkdir(path.dirname(dest), {recursive: true, mode: 0o700});
  const hash = createHash('sha256');
  let bytes = 0;
  const reader = createReadStream(source, {highWaterMark: 1024 * 1024});
  const writer = createWriteStream(dest, {flags: 'wx', mode: 0o600});
  const abort = () => { reader.destroy(); writer.destroy(); };
  signal.addEventListener('abort', abort, {once: true});
  try {
    await pipeline(reader, new Transform({
      transform(chunk, _enc, cb) {
        if (signal.aborted) return cb(cancelledError());
        bytes += (chunk as Buffer).length;
        hash.update(chunk as Buffer);
        onChunk?.(bytes);
        cb(null, chunk);
      },
    }), writer);
  } catch (e) {
    if (signal.aborted) throw cancelledError();
    throw e;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  throwIfAborted(signal);
  if (bytes !== expectedSize) throw new Error('源文件在复制过程中大小发生变化，未切换工作文件夹。');
  const sha256 = hash.digest('hex');
  const destHash = await hashFile(dest, signal);
  if (destHash !== sha256) throw new Error('复制内容校验不一致，未切换工作文件夹。');
  const st = await fs.lstat(dest);
  if (st.isSymbolicLink() || !st.isFile() || st.size !== bytes) throw new Error('目标文件大小校验失败，未切换工作文件夹。');
  return sha256;
}

export async function copyAccountNamespace(input: {
  sourceRoot: string;
  destRoot: string;
  scan: NamespaceScan;
  signal: AbortSignal;
  sourceGuardRoot?: string;
  destGuardRoot?: string;
  onProgress?: (progress: Pick<MigrationProgress, 'copiedFiles' | 'copiedBytes' | 'currentPath'>) => void;
}): Promise<CopyRecords> {
  throwIfAborted(input.signal);
  const sourceGuard = input.sourceGuardRoot ?? input.sourceRoot;
  const destGuard = input.destGuardRoot ?? input.destRoot;
  await assertNoSymlinkAncestry(sourceGuard, input.sourceRoot);
  await fs.mkdir(input.destRoot, {recursive: true, mode: 0o700});
  await assertNoSymlinkAncestry(destGuard, input.destRoot);
  const destReal = await fs.realpath(input.destRoot);
  const records: CopyRecords = new Map();
  let copiedFiles = 0, copiedBytes = 0;
  for (const entry of input.scan.entries.filter(e => e.kind === 'dir')) {
    throwIfAborted(input.signal);
    const dir = resolveUnder(destReal, entry.rel);
    await fs.mkdir(dir, {recursive: true, mode: 0o700});
    await assertNoSymlinkAncestry(sourceGuard, resolveUnder(input.sourceRoot, entry.rel));
    await assertNoSymlinkAncestry(destGuard, dir);
  }
  for (const entry of input.scan.entries.filter(e => e.kind === 'file')) {
    throwIfAborted(input.signal);
    input.onProgress?.({copiedFiles, copiedBytes, currentPath: entry.rel});
    const src = resolveUnder(input.sourceRoot, entry.rel);
    const dst = resolveUnder(destReal, entry.rel);
    await assertNoSymlinkAncestry(sourceGuard, src);
    await assertNoSymlinkAncestry(destGuard, path.dirname(dst));
    const srcStat = await fs.lstat(src);
    if (srcStat.isSymbolicLink() || !srcStat.isFile()) throw new Error('源文件在复制前发生变化，未切换工作文件夹。');
    if (srcStat.size !== entry.size) throw new Error('源文件在复制前大小发生变化，未切换工作文件夹。');
    const sha256 = await copyFileHashed(src, dst, entry.size, input.signal, inFile => {
      input.onProgress?.({copiedFiles, copiedBytes: copiedBytes + inFile, currentPath: entry.rel});
    });
    await assertNoSymlinkAncestry(destGuard, dst);
    records.set(entry.rel, {size: entry.size, sha256});
    copiedFiles++;
    copiedBytes += entry.size;
    input.onProgress?.({copiedFiles, copiedBytes, currentPath: entry.rel});
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return records;
}

export async function assertSourceUnchanged(input: {sourceRoot: string; scan: NamespaceScan; signal: AbortSignal; sourceGuardRoot?: string}) {
  throwIfAborted(input.signal);
  const guard = input.sourceGuardRoot ?? input.sourceRoot;
  await assertNoSymlinkAncestry(guard, input.sourceRoot);
  const live = await walkNamespaceTree(input.sourceRoot, guard, input.signal, '当前账号工作目录');
  if (contentFingerprintOf(live.entries) !== input.scan.contentFingerprint) {
    throw new Error('工作文件在复制或校验过程中发生了变化，未切换工作文件夹。');
  }
  if (identityFingerprintOf(live.entries) !== input.scan.identityFingerprint) {
    throw new Error('工作文件在复制或校验过程中发生了变化，未切换工作文件夹。');
  }
}

export async function verifyCopiedNamespace(input: {
  sourceRoot: string;
  destRoot: string;
  scan: NamespaceScan;
  records: CopyRecords;
  signal: AbortSignal;
  sourceGuardRoot?: string;
  destGuardRoot?: string;
  onProgress?: (progress: {verifiedFiles: number; currentPath: string}) => void;
}) {
  throwIfAborted(input.signal);
  const sourceGuard = input.sourceGuardRoot ?? input.sourceRoot;
  const destGuard = input.destGuardRoot ?? input.destRoot;
  await assertSourceUnchanged({sourceRoot: input.sourceRoot, scan: input.scan, signal: input.signal, sourceGuardRoot: sourceGuard});
  const destWalk = await walkNamespaceTree(input.destRoot, destGuard, input.signal, '目标目录');
  if (contentFingerprintOf(destWalk.entries) !== input.scan.contentFingerprint) throw new Error('复制结果与源目录不一致，未切换工作文件夹。');
  let verifiedFiles = 0;
  for (const entry of input.scan.entries) {
    throwIfAborted(input.signal);
    if (entry.kind === 'dir') {
      const dir = resolveUnder(input.destRoot, entry.rel);
      await assertNoSymlinkAncestry(destGuard, dir);
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('目标目录校验失败，未切换工作文件夹。');
      continue;
    }
    input.onProgress?.({verifiedFiles, currentPath: entry.rel});
    const rec = input.records.get(entry.rel);
    if (!rec || rec.size !== entry.size) throw new Error('文件复制记录不完整，未切换工作文件夹。');
    const src = resolveUnder(input.sourceRoot, entry.rel);
    const dst = resolveUnder(input.destRoot, entry.rel);
    await assertNoSymlinkAncestry(sourceGuard, src);
    await assertNoSymlinkAncestry(destGuard, dst);
    const srcHash = await hashFile(src, input.signal);
    if (srcHash !== rec.sha256) throw new Error('源文件在复制过程中发生了变化，未切换工作文件夹。');
    const dstHash = await hashFile(dst, input.signal);
    if (dstHash !== rec.sha256) throw new Error('目标文件校验不一致，未切换工作文件夹。');
    const srcSt = await fs.lstat(src);
    const dstSt = await fs.lstat(dst);
    if (srcSt.size !== rec.size || dstSt.size !== rec.size) throw new Error('文件大小校验失败，未切换工作文件夹。');
    verifiedFiles++;
    input.onProgress?.({verifiedFiles, currentPath: entry.rel});
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  await assertSourceUnchanged({sourceRoot: input.sourceRoot, scan: input.scan, signal: input.signal, sourceGuardRoot: sourceGuard});
}

export async function assertDestinationOnlyOwnStaging(destRoot: string, stagingName: string) {
  const listing = await fs.readdir(destRoot);
  if (listing.length !== 1 || listing[0] !== stagingName) {
    throw new Error('目标文件夹在迁移过程中出现了其他内容，未覆盖现有文件，未切换工作文件夹。');
  }
  const staging = path.join(destRoot, stagingName);
  await assertNoSymlinkAncestry(destRoot, staging);
  const st = await fs.lstat(staging);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('暂存目录无效，未切换工作文件夹。');
}

export function stagingDirName(previewId: string) {
  const id = previewId.replace(/[^a-f0-9]/gi, '').slice(0, 16) || 'pending';
  return STAGING_PREFIX + id;
}

export async function publishAccountNamespace(destRoot: string, stagingRoot: string, profileKey: string) {
  const staged = path.join(stagingRoot, '案件', profileKey);
  const casesDir = path.join(destRoot, '案件');
  const finalDir = path.join(casesDir, profileKey);
  const stagedStat = await fs.lstat(staged);
  if (stagedStat.isSymbolicLink() || !stagedStat.isDirectory()) throw new Error('暂存目录无效，未切换工作文件夹。');
  await fs.mkdir(casesDir, {recursive: true, mode: 0o700});
  const casesStat = await fs.lstat(casesDir);
  if (casesStat.isSymbolicLink() || !casesStat.isDirectory()) throw new Error('目标案件目录无效，未切换工作文件夹。');
  try {
    await fs.lstat(finalDir);
    throw new Error('目标位置已有当前账号工作目录，未覆盖，未切换工作文件夹。');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await fs.rename(staged, finalDir);
}

export async function rollbackAccountNamespace(destRoot: string, stagingRoot: string, profileKey: string) {
  const stagedParent = path.join(stagingRoot, '案件');
  const staged = path.join(stagedParent, profileKey);
  const casesDir = path.join(destRoot, '案件');
  const finalDir = path.join(casesDir, profileKey);
  await fs.mkdir(stagedParent, {recursive: true, mode: 0o700});
  try { await fs.lstat(finalDir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  try { await fs.lstat(staged); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.rename(finalDir, staged);
    } else throw e;
    try { await fs.rmdir(casesDir); } catch { /* Leave dest/案件 if it is not empty. */ }
    return;
  }
  throw new Error('无法撤回已发布的工作目录：暂存位置已被占用。设置未切换。');
}

export async function waitForFilesystemIdle(input: {
  isBusy: () => boolean;
  signal: AbortSignal;
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? IDLE_WAIT_MS;
  const started = Date.now();
  while (input.isBusy()) {
    throwIfAborted(input.signal);
    if (Date.now() - started > timeoutMs) throw new Error('无法在迁移前安全结束正在进行的目录读取或同步，本次未切换工作文件夹。');
    await new Promise(r => setTimeout(r, 25));
  }
  throwIfAborted(input.signal);
}

export async function removeOwnStaging(stagingRoot: string) {
  const name = path.basename(stagingRoot);
  if (!name.startsWith(STAGING_PREFIX)) return;
  await fs.rm(stagingRoot, {recursive: true, force: true});
}
