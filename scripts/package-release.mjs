import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LICENSE_NAME, PINNED_RUNTIME_FILES, PINNED_RUNTIME_VERSION, RUNTIME_MANIFEST_NAME } from './prepare-agent-runtime.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const execFileAsync = promisify(execFile);

export const PRODUCT_NAME = '专利工作台';
export const APP_ID = 'com.patentworkbench.desktop';
export const MANIFEST_NAME = 'release-manifest.json';
export const EXPECTED_MAIN = 'desktop-dist/main.cjs';
export const FILE_HASH_ALGORITHM = 'sha256';
export const TREE_HASH_ALGORITHM = 'sha256-tree';

const STAGING_NAME = 'release-staging';
const RELEASE_NAME = 'release';
const LOCK_NAME = '.package-release.lock';
const PROMOTING_PREFIX = '.promoting-';
const BACKUP_PREFIX = '.release-backup-';

const MAC_BUILDER_DIRS = new Set(['mac', 'mac-arm64', 'mac-x64', 'mac-universal']);
const WIN_BUILDER_DIRS = new Set(['win-unpacked', 'win-x64-unpacked', 'win-arm64-unpacked', 'win-ia32-unpacked']);
const LINUX_BUILDER_DIRS = new Set(['linux-unpacked', 'linux-x64-unpacked', 'linux-arm64-unpacked']);
const BUILDER_DIR_NAMES = new Set([...MAC_BUILDER_DIRS, ...WIN_BUILDER_DIRS, ...LINUX_BUILDER_DIRS]);
const BUILDER_FILE_NAMES = new Set([
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
  '.DS_Store',
]);

const USAGE = `用法：
  npm run package:release          # 一次构建，再分别打包 macOS arm64 .app 与 Windows x64 安装器
  npm run package:mac              # 仅 macOS arm64，语义同上（校验、发布、清理）
  npm run package:win              # 仅 Windows x64 安装器
产物写入 release/，构建在同级 release-staging/ 中完成。`;

export function macPublishedName(version) {
  return `${PRODUCT_NAME}-${version}-macOS-arm64.app`;
}
export function winPublishedName(version) {
  return `PatentWorkbench-${version}-Windows-x64-Setup.exe`;
}

export function macInstallerName(version){return `PatentWorkbench-${version}-macOS-arm64.pkg`;}
export function isMacInstaller(name){return /^PatentWorkbench-\d+\.\d+\.\d+-macOS-arm64\.pkg$/.test(name);}
export function isWindowsDistributable(name) {
  return /^PatentWorkbench-\d+\.\d+\.\d+-Windows(?:-x64)?(?:-Setup)?\.exe$/.test(name);
}
export function isMacDistributable(name) {
  return name === `${PRODUCT_NAME}.app` || /^专利工作台-\d+\.\d+\.\d+-macOS-arm64\.app$/.test(name);
}

export function isRecognizedReleaseEntry(name) {
  if (name === MANIFEST_NAME) return true;
  if (BUILDER_FILE_NAMES.has(name) || BUILDER_DIR_NAMES.has(name)) return true;
  if (name.startsWith(PROMOTING_PREFIX) || name.startsWith(BACKUP_PREFIX)) return true;
  if (isWindowsDistributable(name) || isMacDistributable(name) || isMacInstaller(name)) return true;
  if (/^(PatentWorkbench|专利工作台)-.+\.blockmap$/.test(name)) return true;
  return false;
}

function isMacOwnedEntry(name) {
  return isMacDistributable(name) || isMacInstaller(name) || MAC_BUILDER_DIRS.has(name) || name === 'latest-mac.yml' || /^专利工作台-.+\.blockmap$/.test(name);
}
function isWinOwnedEntry(name) {
  return isWindowsDistributable(name) || WIN_BUILDER_DIRS.has(name) || name === 'latest.yml' || /^PatentWorkbench-.+\.blockmap$/.test(name);
}
function isLinuxOwnedEntry(name) {
  return LINUX_BUILDER_DIRS.has(name) || name === 'latest-linux.yml';
}

export function preserveOppositePlatformEntry(name, {fullRelease, platforms}) {
  if (fullRelease) return false;
  if (name.startsWith(PROMOTING_PREFIX) || name.startsWith(BACKUP_PREFIX)) return false;
  if (!platforms.includes('mac') && isMacOwnedEntry(name)) return true;
  if (!platforms.includes('win') && isWinOwnedEntry(name)) return true;
  if (isLinuxOwnedEntry(name)) return true;
  return false;
}

export function layoutFor(projectRoot) {
  const root = path.resolve(projectRoot);
  return {
    projectRoot: root,
    releaseDir: path.join(root, RELEASE_NAME),
    stagingDir: path.join(root, STAGING_NAME),
    lockFile: path.join(root, LOCK_NAME),
    packageJson: path.join(root, 'package.json'),
  };
}

function assertInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`路径越界：${target}`);
  }
}

function assertManagedChild(dir, expectedName, projectRoot) {
  const resolved = path.resolve(dir);
  if (path.basename(resolved) !== expectedName) throw new Error(`拒绝操作非 ${expectedName} 目录。`);
  if (path.dirname(resolved) !== path.resolve(projectRoot)) throw new Error(`${expectedName} 必须是项目根的直接子目录。`);
}

export async function assertSafeLayout(layout) {
  const rootStat = await fs.stat(layout.projectRoot);
  if (!rootStat.isDirectory()) throw new Error('项目根必须是文件夹。');
  assertManagedChild(layout.releaseDir, RELEASE_NAME, layout.projectRoot);
  assertManagedChild(layout.stagingDir, STAGING_NAME, layout.projectRoot);
  if (path.resolve(layout.releaseDir) === path.resolve(layout.stagingDir)) {
    throw new Error('发布目录与暂存目录不能相同。');
  }
  for (const [label, dir] of [['发布目录', layout.releaseDir], ['暂存目录', layout.stagingDir]]) {
    try {
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink()) throw new Error(`${label}不能是符号链接。`);
      if (!st.isDirectory()) throw new Error(`${label}必须是文件夹。`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

async function tryCreateLock(lockFile) {
  const record = {pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID()};
  const handle = await fs.open(lockFile, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } catch (e) {
    await handle.close().catch(() => {});
    await fs.rm(lockFile, {force: true});
    throw e;
  }
  return async () => {
    await handle.close().catch(() => {});
    await fs.rm(lockFile, {force: true});
  };
}

export async function acquirePackageLock(lockFile) {
  try {
    return await tryCreateLock(lockFile);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Error(`打包锁已存在：${lockFile}。若确认是过期锁，请先检查再手动删除；未自动清除，以免打断其他打包进程。`);
  }
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function hashPath(root) {
  const hash = createHash('sha256');
  async function walk(rel) {
    const full = rel ? path.join(root, rel) : root;
    const st = await fs.lstat(full);
    const key = rel.split(path.sep).join('/');
    if (st.isSymbolicLink()) {
      hash.update(`l:${key}->${await fs.readlink(full)}\n`);
      return;
    }
    if (st.isDirectory()) {
      hash.update(`d:${key}\n`);
      const names = (await fs.readdir(full)).sort();
      for (const name of names) await walk(rel ? path.join(rel, name) : name);
      return;
    }
    if (st.isFile()) {
      hash.update(`f:${key}:${st.size}:${await sha256File(full)}\n`);
      return;
    }
    hash.update(`o:${key}:${st.mode}\n`);
  }
  await walk('');
  return hash.digest('hex');
}

async function checksumForArtifact(kind, dest) {
  if (kind === 'mac') return {sha256: await hashPath(dest), hashAlgorithm: TREE_HASH_ALGORITHM};
  return {sha256: await sha256File(dest), hashAlgorithm: FILE_HASH_ALGORITHM};
}

export async function copyArtifact(src, dest) {
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) throw new Error(`拒绝复制符号链接产物：${src}`);
  if (st.isDirectory()) {
    await fs.cp(src, dest, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    return;
  }
  if (st.isFile()) {
    await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL);
    return;
  }
  throw new Error(`不支持的产物类型：${src}`);
}

function asarList(archive) {
  return asar.listPackage(archive, {isPack: false}).map(entry =>
    String(entry).replaceAll('\\', '/').replace(/^\//, ''));
}

function readAsarFile(archive, filename) {
  return asar.extractFile(archive, filename.replace(/^\/+/, ''));
}

function verifyAsarPayload(archive, version) {
  let files;
  try {
    files = asarList(archive);
  } catch (e) {
    throw new Error(`校验未通过：无法列出 app.asar（${e.message}）。`);
  }
  const needed = [
    'package.json',
    EXPECTED_MAIN,
    'desktop-dist/preload.cjs',
    'desktop-dist/pdf.worker.mjs',
    'desktop-dist/document-visual-worker.cjs',
    'desktop-dist/pdfium.wasm',
    'resources/document-templates/reply.docx',
    'resources/document-templates/application.docx',
    'resources/document-templates/manifest.json',
    'resources/branding/icon.png',
    'resources/standard-skills/manifest.json',
    'resources/standard-skills/draft/SKILL.md',
    'resources/standard-skills/review/SKILL.md',
    'dist/index.html',
    'resources/reply-rules/ai_reply_template_prompt.md',
    'resources/reply-rules/ai_reply_first_office_action_prompt.md',
    'resources/reply-rules/ai_reply_second_office_action_prompt.md',
    'resources/reply-rules/ai_reply_third_office_action_prompt.md',
    'resources/reply-rules/ai_reply_correction_prompt.md',
  ];
  for (const name of needed) {
    if (!files.includes(name)) throw new Error(`校验未通过：app.asar 缺少 ${name}。`);
  }
  if (!files.some(name => name.startsWith('dist/assets/') && name !== 'dist/assets/')) {
    throw new Error('校验未通过：app.asar 缺少界面资源 dist/assets。');
  }
  let pkg;
  try {
    pkg = JSON.parse(readAsarFile(archive, 'package.json').toString('utf8'));
  } catch (e) {
    throw new Error(`校验未通过：无法读取 app.asar 内 package.json（${e.message}）。`);
  }
  if (pkg.version !== version) throw new Error(`校验未通过：app.asar 版本为 ${pkg.version}，期望 ${version}。`);
  const templates=JSON.parse(readAsarFile(archive,'resources/document-templates/manifest.json').toString('utf8'));
  for(const kind of ['reply','application']){
    const bytes=readAsarFile(archive,`resources/document-templates/${kind}.docx`);
    if(createHash('sha256').update(bytes).digest('hex')!==templates[kind]?.templateSha256)throw new Error(`校验未通过：${kind} 模板摘要不匹配。`);
  }
  const skills=JSON.parse(readAsarFile(archive,'resources/standard-skills/manifest.json').toString('utf8'));
  for(const kind of ['draft','review'])for(const [file,hash] of Object.entries(skills[kind]?.files||{})){
    if(createHash('sha256').update(readAsarFile(archive,`resources/standard-skills/${kind}/${file}`)).digest('hex')!==hash)throw new Error(`校验未通过：${kind} 技能资源摘要不匹配。`);
  }
  if (pkg.main !== EXPECTED_MAIN) throw new Error(`校验未通过：app.asar main 不是 ${EXPECTED_MAIN}。`);
  if (pkg.name && pkg.name !== 'patent-agent') throw new Error('校验未通过：app.asar 应用名已改变。');
  if (pkg.productName && pkg.productName !== PRODUCT_NAME) {
    throw new Error('校验未通过：app.asar productName 已改变，会破坏 userData / safeStorage。');
  }
  if (pkg.build?.productName && pkg.build.productName !== PRODUCT_NAME) {
    throw new Error('校验未通过：app.asar productName 已改变，会破坏 userData / safeStorage。');
  }
  if (pkg.build?.appId && pkg.build.appId !== APP_ID) {
    throw new Error('校验未通过：app.asar appId 已改变，会破坏 userData / safeStorage。');
  }
  const main = readAsarFile(archive, EXPECTED_MAIN);
  if (!main.length || main.subarray(0, 1).toString() === '<') throw new Error('校验未通过：桌面入口不可用。');
  const preload = readAsarFile(archive, 'desktop-dist/preload.cjs');
  if (!preload.length) throw new Error('校验未通过：preload 不可用。');
  const html = readAsarFile(archive, 'dist/index.html').toString('utf8');
  if (!html.includes('<')) throw new Error('校验未通过：界面入口不可用。');
}

function pinnedPlatform(platform) {
  return platform === 'win' ? 'win32-x64' : 'darwin-arm64';
}

async function verifyBundledRuntime(resourcesDir, platform) {
  if(await fs.access(path.join(resourcesDir,'document-runtime')).then(()=>true,()=>false))throw new Error('轻量安装包不能包含完整 DOC 转换引擎。');
  const runtimeRoot = path.join(resourcesDir, 'agent-runtime');
  try {
    await assertNotSymlink(runtimeRoot, 'OpenCode 运行时目录');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('校验未通过：缺少 OpenCode 运行时。');
    throw e;
  }
  const manifestPath = path.join(runtimeRoot, RUNTIME_MANIFEST_NAME);
  try {
    await assertNotSymlink(manifestPath, RUNTIME_MANIFEST_NAME);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('校验未通过：缺少 OpenCode runtime-manifest.json。');
    throw e;
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('校验未通过：缺少 OpenCode runtime-manifest.json。');
  }
  if (manifest.version !== PINNED_RUNTIME_VERSION) {
    throw new Error(`校验未通过：OpenCode 运行时版本为 ${manifest.version || '未知'}，期望 ${PINNED_RUNTIME_VERSION}。`);
  }
  const licensePath = path.join(runtimeRoot, LICENSE_NAME);
  try {
    await assertNotSymlink(licensePath, LICENSE_NAME);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('校验未通过：缺少 OpenCode 许可证。');
    throw e;
  }
  const want = pinnedPlatform(platform);
  const pinned = PINNED_RUNTIME_FILES.find(item => item.platform === want);
  if (!pinned) throw new Error(`校验未通过：没有 ${want} 的运行时定义。`);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const row = files.find(item => item && item.platform === want);
  if (!row) throw new Error(`校验未通过：清单缺少 ${want}。`);
  const relative = String(row.file || pinned.file);
  const absolute = path.resolve(runtimeRoot, relative);
  const rel = path.relative(runtimeRoot, absolute);
  if (!relative || rel.startsWith('..') || rel === '..' || path.isAbsolute(rel) || path.isAbsolute(relative)) {
    throw new Error(`校验未通过：${want} 路径越界。`);
  }
  let st;
  try {
    st = await fs.lstat(absolute);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`校验未通过：缺少 OpenCode 可执行文件（${want}）。`);
    throw e;
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`校验未通过：${want} 必须是普通文件。`);
  const expectedBytes = Number(row.bytes);
  if (Number.isFinite(expectedBytes) && expectedBytes > 0 && st.size !== expectedBytes) {
    throw new Error(`校验未通过：${want} 大小与清单不符。`);
  }
  const header = Buffer.alloc(4);
  const handle = await fs.open(absolute, 'r');
  try {
    await handle.read(header, 0, 4, 0);
  } finally {
    await handle.close();
  }
  const hex = header.toString('hex');
  const expectedHeader = String(row.header || pinned.header).toLowerCase();
  if (hex !== expectedHeader) throw new Error(`校验未通过：${want} 文件头不匹配。`);
  const expectedHash = String(row.sha256 || '').toLowerCase();
  if (!expectedHash) throw new Error(`校验未通过：清单缺少 ${want} 的 sha256。`);
  const actualHash = await sha256File(absolute);
  if (actualHash !== expectedHash) throw new Error(`校验未通过：${want} 哈希与清单不符。`);
}

async function readPlistXml(file) {
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8).toString('ascii') === 'bplist00') {
    if (process.platform !== 'darwin') throw new Error('校验未通过：Info.plist 为二进制，当前环境无法解析。');
    const {stdout} = await execFileAsync('plutil', ['-convert', 'xml1', '-o', '-', file], {timeout: 30000});
    return stdout;
  }
  return buf.toString('utf8');
}

function plistString(xml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return xml.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

async function assertNotSymlink(target, label) {
  const st = await fs.lstat(target);
  if (st.isSymbolicLink()) throw new Error(`${label}不能是符号链接。`);
  return st;
}

export async function verifyMz(exePath) {
  const st = await assertNotSymlink(exePath, 'Windows 可执行文件');
  if (!st.isFile()) throw new Error('校验未通过：Windows 产物不是文件。');
  const handle = await fs.open(exePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    const {bytesRead} = await handle.read(buf, 0, 2, 0);
    if (bytesRead < 2 || buf.toString('ascii') !== 'MZ') throw new Error('校验未通过：Windows 产物不是 MZ 可执行文件。');
  } finally {
    await handle.close();
  }
}

export async function verifyMacApp(appPath, version) {
  const st = await assertNotSymlink(appPath, 'macOS 应用包');
  if (!st.isDirectory()) throw new Error('校验未通过：macOS 产物不是 .app 目录。');
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  await assertNotSymlink(infoPath, 'Info.plist');
  await assertNotSymlink(asarPath, 'app.asar');
  const xml = await readPlistXml(infoPath);
  if (plistString(xml, 'CFBundleName') !== PRODUCT_NAME) {
    throw new Error('校验未通过：CFBundleName 必须保持为专利工作台。');
  }
  const identifier = plistString(xml, 'CFBundleIdentifier');
  if (identifier && identifier !== APP_ID) throw new Error('校验未通过：CFBundleIdentifier 与 appId 不一致。');
  const shortVersion = plistString(xml, 'CFBundleShortVersionString');
  if (shortVersion !== version) throw new Error(`校验未通过：Info.plist 版本为 ${shortVersion}，期望 ${version}。`);
  const bundleVersion = plistString(xml, 'CFBundleVersion');
  if (bundleVersion && bundleVersion !== version && !bundleVersion.startsWith(`${version}.`)) {
    throw new Error(`校验未通过：CFBundleVersion 为 ${bundleVersion}，与 ${version} 不一致。`);
  }
  const executable = plistString(xml, 'CFBundleExecutable') || PRODUCT_NAME;
  const execPath = path.join(appPath, 'Contents', 'MacOS', executable);
  const execStat = await assertNotSymlink(execPath, 'macOS 可执行文件');
  if (!execStat.isFile()) throw new Error('校验未通过：缺少 macOS 可执行文件。');
  try {
    verifyAsarPayload(asarPath, version);
  } finally {
    asar.uncache(asarPath);
  }
  await verifyBundledRuntime(path.join(appPath, 'Contents', 'Resources'), 'mac');
}

async function pickExisting(candidates, label) {
  const found = [];
  for (const candidate of candidates) {
    try {
      const st = await fs.lstat(candidate);
      if (st.isSymbolicLink()) throw new Error(`校验未通过：${label} 是符号链接（${candidate}）。`);
      found.push(candidate);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  if (!found.length) throw new Error(`校验未通过：未找到${label}。`);
  return found[0];
}

export async function verifyStaging(stagingDir, {version, platforms}) {
  assertManagedChild(stagingDir, STAGING_NAME, path.dirname(stagingDir));
  const stagingStat = await assertNotSymlink(stagingDir, '暂存目录');
  if (!stagingStat.isDirectory()) throw new Error('暂存目录必须是文件夹。');
  const artifacts = [];
  if (platforms.includes('mac')) {
    const source = await pickExisting([
      path.join(stagingDir, 'mac-arm64', `${PRODUCT_NAME}.app`),
      path.join(stagingDir, 'mac', `${PRODUCT_NAME}.app`),
    ], 'macOS arm64 .app');
    await verifyMacApp(source, version);
    artifacts.push({kind: 'mac', platform: 'mac-arm64', source, finalName: macPublishedName(version)});
    const installer=path.join(stagingDir,macInstallerName(version));
    const head=await fs.readFile(installer);if(head.subarray(0,4).toString()!=='xar!')throw new Error('macOS 安装包不是有效 XAR 文件。');
    artifacts.push({kind:'pkg',platform:'mac-arm64-installer',source:installer,finalName:macInstallerName(version)});
  }
  if (platforms.includes('win')) {
    const source = await pickExisting([
      path.join(stagingDir, winPublishedName(version)),
      path.join(stagingDir, `PatentWorkbench-${version}-Windows.exe`),
    ], 'Windows x64 安装器');
    const asarPath = await pickExisting([
      path.join(stagingDir, 'win-unpacked', 'resources', 'app.asar'),
      path.join(stagingDir, 'win-x64-unpacked', 'resources', 'app.asar'),
    ], 'Windows app.asar');
    await verifyMz(source);
    try {
      verifyAsarPayload(asarPath, version);
    } finally {
      asar.uncache(asarPath);
    }
    await verifyBundledRuntime(path.dirname(asarPath), 'win');
    artifacts.push({kind: 'win', platform: 'win-x64', source, finalName: winPublishedName(version)});
  }
  return artifacts;
}

async function rollbackJournal(journal) {
  const errors = [];
  for (const step of [...journal].reverse()) {
    try {
      if (step.op === 'add') {
        await fs.rm(step.path, {recursive: true, force: true});
      } else if (step.op === 'replace') {
        await fs.rm(step.path, {recursive: true, force: true});
        await fs.rename(step.backup, step.path);
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) throw new Error(errors.join('；'));
}

async function placeArtifact(src, dest, copyPath, journal, root) {
  if (dest.includes('\0')) throw new Error('发布文件名无效。');
  assertInside(root, dest);
  const temp = path.join(path.dirname(dest), `${PROMOTING_PREFIX}${path.basename(dest)}`);
  const backup = path.join(path.dirname(dest), `${BACKUP_PREFIX}${path.basename(dest)}`);
  assertInside(root, temp);
  assertInside(root, backup);
  await fs.rm(temp, {recursive: true, force: true});
  journal.push({op: 'add', path: temp});
  await copyPath(src, temp);
  let replaced = false;
  try {
    const st = await fs.lstat(dest);
    if (st.isSymbolicLink()) throw new Error(`发布目标是符号链接：${path.basename(dest)}`);
    await fs.rm(backup, {recursive: true, force: true});
    await fs.rename(dest, backup);
    replaced = true;
    journal.push({op: 'replace', path: dest, backup});
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fs.rename(temp, dest);
  const tempIndex = journal.findIndex(step => step.op === 'add' && step.path === temp);
  if (tempIndex >= 0) journal.splice(tempIndex, 1);
  if (!replaced) journal.push({op: 'add', path: dest});
}

async function listReleaseNames(releaseDir) {
  try {
    return await fs.readdir(releaseDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function assertNoStrayBackups(releaseDir) {
  const leftover = (await listReleaseNames(releaseDir)).filter(name => name.startsWith(BACKUP_PREFIX));
  if (leftover.length) {
    throw new Error(`发布目录有未完成的备份（${leftover.join('、')}），请先检查后再打包，以免覆盖未恢复的文件。`);
  }
}

async function removeStrayPromoting(releaseDir) {
  for (const name of await listReleaseNames(releaseDir)) {
    if (!name.startsWith(PROMOTING_PREFIX)) continue;
    const target = path.join(releaseDir, name);
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) throw new Error(`拒绝删除符号链接 ${name}`);
    await fs.rm(target, {recursive: true, force: true});
  }
}

async function ensureDirectory(dir, label) {
  await fs.mkdir(dir, {recursive: true});
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink()) throw new Error(`${label}不能是符号链接。`);
  if (!st.isDirectory()) throw new Error(`${label}必须是文件夹。`);
}

async function cleanupRecognized(releaseDir, keepNames, {fullRelease, platforms}) {
  const errors = [];
  for (const name of await listReleaseNames(releaseDir)) {
    if (keepNames.has(name) || !isRecognizedReleaseEntry(name)) continue;
    if (preserveOppositePlatformEntry(name, {fullRelease, platforms})) continue;
    const target = path.join(releaseDir, name);
    try {
      assertInside(releaseDir, target);
      const st = await fs.lstat(target);
      if (st.isSymbolicLink()) {
        errors.push(`${name} 是符号链接，未删除`);
        continue;
      }
      await fs.rm(target, {recursive: true, force: true});
    } catch (e) {
      errors.push(`${name}：${e.message}`);
    }
  }
  return errors;
}

export async function publishArtifacts({
  releaseDir,
  artifacts,
  version,
  platforms,
  fullRelease,
  copyPath = copyArtifact,
  builtAt = new Date().toISOString(),
}) {
  assertManagedChild(releaseDir, RELEASE_NAME, path.dirname(releaseDir));
  await ensureDirectory(releaseDir, '发布目录');
  await assertNoStrayBackups(releaseDir);
  await removeStrayPromoting(releaseDir);
  const journal = [];
  const keepNames = new Set([MANIFEST_NAME]);
  try {
    const files = [];
    for (const artifact of artifacts) {
      if (path.basename(artifact.finalName) !== artifact.finalName) throw new Error('发布文件名不能包含路径。');
      const dest = path.join(releaseDir, artifact.finalName);
      await placeArtifact(artifact.source, dest, copyPath, journal, releaseDir);
      if (artifact.kind === 'mac') await verifyMacApp(dest, version);
      if (artifact.kind === 'win') await verifyMz(dest);
      keepNames.add(artifact.finalName);
      files.push({
        file: artifact.finalName,
        platform: artifact.platform,
        version,
        ...await checksumForArtifact(artifact.kind, dest),
      });
    }
    if (!fullRelease) {
      for (const name of await listReleaseNames(releaseDir)) {
        if (!platforms.includes('win') && isWindowsDistributable(name)) {
          files.push({
            file: name,
            platform: 'win-x64',
            retained: true,
            ...await checksumForArtifact('win', path.join(releaseDir, name)),
          });
        }
        if (!platforms.includes('mac') && isMacDistributable(name) && name !== `${PRODUCT_NAME}.app`) {
          files.push({
            file: name,
            platform: 'mac-arm64',
            retained: true,
            ...await checksumForArtifact('mac', path.join(releaseDir, name)),
          });
        }
      }
    }
    const manifest = {
      version,
      builtAt,
      appId: APP_ID,
      productName: PRODUCT_NAME,
      files,
    };
    const manifestTemp = path.join(os.tmpdir(), `patent-release-manifest-${process.pid}-${randomUUID()}.json`);
    await fs.writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
    try {
      await placeArtifact(manifestTemp, path.join(releaseDir, MANIFEST_NAME), copyPath, journal, releaseDir);
    } finally {
      await fs.rm(manifestTemp, {force: true});
    }
  } catch (e) {
    try {
      await rollbackJournal(journal);
    } catch (rollbackError) {
      throw new Error(`发布失败：${e.message}；回滚也未能完成：${rollbackError.message}`);
    }
    throw new Error(`发布失败，已回滚：${e.message}`);
  }
  const cleanupErrors = [];
  for (const step of journal) {
    if (step.op !== 'replace') continue;
    try {
      await fs.rm(step.backup, {recursive: true, force: true});
    } catch (e) {
      cleanupErrors.push(`备份 ${path.basename(step.backup)}：${e.message}`);
    }
  }
  cleanupErrors.push(...await cleanupRecognized(releaseDir, keepNames, {fullRelease, platforms}));
  return {keepNames, cleanupErrors};
}

async function prepareStaging(layout) {
  assertManagedChild(layout.stagingDir, STAGING_NAME, layout.projectRoot);
  try {
    const st = await fs.lstat(layout.stagingDir);
    if (st.isSymbolicLink()) throw new Error('暂存目录不能是符号链接。');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fs.rm(layout.stagingDir, {recursive: true, force: true});
  await fs.mkdir(layout.stagingDir, {recursive: true});
  const st = await fs.lstat(layout.stagingDir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('暂存目录创建后不是普通文件夹。');
}

function runCommand(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: 'inherit', env, shell: false});
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 失败（${signal || code}）。`));
    });
  });
}

export function electronBuilderArgs(platform, builderCli, stagingDir) {
  const dest = `--config.directories.output=${stagingDir}`;
  if (platform === 'mac') return [builderCli, '--mac', 'dir', 'pkg', '--arm64', '--publish', 'never', dest];
  if (platform === 'win') return [builderCli, '--win', 'nsis', '--x64', '--publish', 'never', dest];
  throw new Error(`未知打包平台：${platform}`);
}

export function packagingCommands({
  platforms,
  projectRoot,
  stagingDir,
  nodePath = process.execPath,
  npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm',
}) {
  const builderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
  const steps = [{command: npmCommand, args: ['run', 'build'], cwd: projectRoot, role: 'build'}];
  for (const platform of platforms) {
    steps.push({
      command: nodePath,
      args: electronBuilderArgs(platform, builderCli, stagingDir),
      cwd: projectRoot,
      env: {CSC_IDENTITY_AUTO_DISCOVERY: 'false'},
      role: `builder:${platform}`,
    });
  }
  return steps;
}

function identityError(pkg) {
  if (pkg.name !== 'patent-agent') return 'package.json name 不是 patent-agent。';
  if (pkg.build?.productName && pkg.build.productName !== PRODUCT_NAME) {
    return 'productName 已改变，会破坏 userData / safeStorage。';
  }
  if (pkg.build?.appId && pkg.build.appId !== APP_ID) return 'appId 已改变，会破坏 userData / safeStorage。';
  const executableName = pkg.build?.executableName || pkg.build?.mac?.executableName || pkg.build?.win?.executableName;
  if (executableName && executableName !== PRODUCT_NAME) return 'executableName 已改变，会破坏应用标识。';
  if (!pkg.version) return 'package.json 缺少 version。';
  return null;
}

export function parsePlatformArgs(argv) {
  let platform = 'release';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return {help: true};
    if (arg === '--platform') {
      platform = argv[++i];
      continue;
    }
    if (arg.startsWith('--platform=')) {
      platform = arg.slice('--platform='.length);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!['release', 'mac', 'win'].includes(platform)) throw new Error('platform 只能是 release、mac 或 win。');
  return {
    platforms: platform === 'release' ? ['mac', 'win'] : [platform],
    fullRelease: platform === 'release',
  };
}

export async function runPackageRelease(options = {}) {
  const log = options.log ?? console.log;
  const execute = options.runCommand ?? runCommand;
  const layout = layoutFor(options.projectRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const platforms = options.platforms ?? ['mac', 'win'];
  const fullRelease = options.fullRelease ?? (platforms.includes('mac') && platforms.includes('win'));
  await assertSafeLayout(layout);
  const unlock = await acquirePackageLock(layout.lockFile);
  const cleanupErrors = [];
  try {
    await assertNoStrayBackups(layout.releaseDir);
    const pkg = JSON.parse(await fs.readFile(layout.packageJson, 'utf8'));
    const identity = identityError(pkg);
    if (identity) throw new Error(identity);
    const version = pkg.version;
    log(`打包 ${version}（${platforms.join(' + ')}）`);
    if (!options.skipPackaging) {
      await prepareStaging(layout);
      const steps = packagingCommands({
        platforms,
        projectRoot: layout.projectRoot,
        stagingDir: layout.stagingDir,
      });
      const builderCli = path.join(layout.projectRoot, 'node_modules', 'electron-builder', 'cli.js');
      await fs.access(builderCli);
      for (const step of steps) {
        if (step.role === 'build') log('构建前端与桌面入口…');
        else log(`electron-builder ${step.role} 输出到 ${STAGING_NAME}/…`);
        const env = step.env ? {...process.env, ...step.env} : process.env;
        await execute(step.command, step.args, step.cwd, env);
      }
    }
    log('校验暂存产物…');
    const artifacts = await verifyStaging(layout.stagingDir, {version, platforms});
    log('发布到 release/…');
    const published = await publishArtifacts({
      releaseDir: layout.releaseDir,
      artifacts,
      version,
      platforms,
      fullRelease,
      copyPath: options.copyPath ?? copyArtifact,
      builtAt: options.builtAt ?? new Date().toISOString(),
    });
    cleanupErrors.push(...published.cleanupErrors);
    try {
      assertManagedChild(layout.stagingDir, STAGING_NAME, layout.projectRoot);
      const stagingStat = await fs.lstat(layout.stagingDir);
      if (stagingStat.isSymbolicLink()) cleanupErrors.push('暂存目录是符号链接，未删除');
      else await fs.rm(layout.stagingDir, {recursive: true, force: true});
    } catch (e) {
      if (e.code !== 'ENOENT') cleanupErrors.push(`暂存目录：${e.message}`);
    }
    if (cleanupErrors.length) {
      throw new Error(`已发布新版本，但清理失败：${cleanupErrors.join('；')}`);
    }
    log(`完成：${[...published.keepNames].filter(name => name !== MANIFEST_NAME).join('、')} 与 ${MANIFEST_NAME}`);
    return {version, artifacts, layout};
  } finally {
    await unlock();
  }
}

function isCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

async function main() {
  try {
    const args = parsePlatformArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      return;
    }
    await runPackageRelease(args);
  } catch (e) {
    console.error(e.message || e);
    process.exitCode = 1;
  }
}

if (isCli()) await main();
