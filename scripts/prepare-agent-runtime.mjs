import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_RUNTIME_VERSION = '1.18.30';
export const RUNTIME_MANIFEST_NAME = 'runtime-manifest.json';
export const LICENSE_NAME = 'OPENCODE-LICENSE.txt';

export const PINNED_RUNTIME_FILES = [
  {
    platform: 'darwin-arm64',
    file: 'darwin-arm64/opencode',
    header: 'cffaedfe',
  },
  {
    platform: 'win32-x64',
    file: 'win32-x64/opencode.exe',
    header: '4d5a7800',
  },
];

export class PrepareRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

export function parsePrepareArgs(argv = process.argv.slice(2)) {
  const out = { sourceDir: '', outputDir: '', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source' || arg === '--from') out.sourceDir = argv[++i] || '';
    else if (arg === '--output' || arg === '--to') out.outputDir = argv[++i] || '';
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new PrepareRuntimeError('bad_args', `未知参数：${arg}`);
  }
  return out;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export async function fileHeaderHex(file, bytes = 4) {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('hex');
  } finally {
    await handle.close();
  }
}

async function readManifest(sourceDir) {
  const file = path.join(sourceDir, RUNTIME_MANIFEST_NAME);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new PrepareRuntimeError('missing_manifest', '缺少 runtime-manifest.json。');
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PrepareRuntimeError('bad_manifest', 'runtime-manifest.json 无法解析。');
  }
  const rec = asRecord(parsed);
  if (!rec) throw new PrepareRuntimeError('bad_manifest', 'runtime-manifest.json 格式无效。');
  return rec;
}

export async function verifyAgentRuntime(sourceDir) {
  const resolved = path.resolve(sourceDir);
  const manifest = await readManifest(resolved);
  const version = String(manifest.version || '');
  if (version !== PINNED_RUNTIME_VERSION) {
    throw new PrepareRuntimeError('version', `运行时版本必须为 ${PINNED_RUNTIME_VERSION}，当前为 ${version || '未知'}。`);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const reports = [];
  for (const pinned of PINNED_RUNTIME_FILES) {
    const row = files.find(item => asRecord(item)?.platform === pinned.platform);
    const rec = asRecord(row);
    if (!rec) throw new PrepareRuntimeError('missing_file', `清单缺少 ${pinned.platform}。`);
    if (String(rec.version || version) !== PINNED_RUNTIME_VERSION) {
      throw new PrepareRuntimeError('version', `${pinned.platform} 版本不是 ${PINNED_RUNTIME_VERSION}。`);
    }
    const relative = String(rec.file || pinned.file);
    const absolute = path.resolve(resolved, relative);
    const rel = path.relative(resolved, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PrepareRuntimeError('path', `${pinned.platform} 路径越界。`);
    }
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch {
      throw new PrepareRuntimeError('missing_file', `缺少 ${relative}。`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new PrepareRuntimeError('not_file', `${relative} 必须是普通文件。`);
    }
    const header = await fileHeaderHex(absolute, 4);
    const expectedHeader = String(rec.header || pinned.header).toLowerCase();
    if (header !== expectedHeader) {
      throw new PrepareRuntimeError('header', `${relative} 文件头不匹配。`);
    }
    const sha256 = await sha256File(absolute);
    const expectedHash = String(rec.sha256 || '').toLowerCase();
    if (expectedHash && sha256 !== expectedHash) {
      throw new PrepareRuntimeError('hash', `${relative} 哈希不匹配。`);
    }
    reports.push({
      platform: pinned.platform,
      file: relative,
      bytes: stat.size,
      sha256,
      header,
    });
  }
  const license = path.join(resolved, LICENSE_NAME);
  try {
    const stat = await fs.lstat(license);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('bad');
  } catch {
    throw new PrepareRuntimeError('missing_license', '缺少 OPENCODE-LICENSE.txt。');
  }
  return {
    runtime: 'OpenCode',
    version: PINNED_RUNTIME_VERSION,
    sourceDir: resolved,
    files: reports,
  };
}

async function copyFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o755 });
  await fs.copyFile(from, to);
  const stat = await fs.stat(from);
  await fs.chmod(to, stat.mode);
}

export async function copyAgentRuntime({ sourceDir, outputDir }) {
  if (!sourceDir) throw new PrepareRuntimeError('bad_args', '必须注入 --source 源目录。');
  if (!outputDir) throw new PrepareRuntimeError('bad_args', '必须注入 --output 目标目录。');
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  if (source === output) throw new PrepareRuntimeError('bad_args', '源目录与目标目录不能相同。');
  const report = await verifyAgentRuntime(source);
  await fs.mkdir(output, { recursive: true, mode: 0o755 });
  await copyFile(path.join(source, RUNTIME_MANIFEST_NAME), path.join(output, RUNTIME_MANIFEST_NAME));
  await copyFile(path.join(source, LICENSE_NAME), path.join(output, LICENSE_NAME));
  for (const file of report.files) {
    await copyFile(path.join(source, file.file), path.join(output, file.file));
  }
  const verified = await verifyAgentRuntime(output);
  return { ...verified, outputDir: output };
}

function usage() {
  return `用法：
  node scripts/prepare-agent-runtime.mjs --source <已准备的运行时目录> --output <目标目录>

仅复制并校验固定版本 ${PINNED_RUNTIME_VERSION} 的官方 OpenCode macOS arm64 与 Windows x64 构件。
不联网下载，不调用 git/npm/python，不修改进程环境变量。
源目录须已由构建准备，并包含 runtime-manifest.json 与 OPENCODE-LICENSE.txt。`;
}

async function main(argv = process.argv.slice(2)) {
  const args = parsePrepareArgs(argv);
  if (args.help) {
    console.log(usage());
    return { ok: true, help: true };
  }
  const result = await copyAgentRuntime({ sourceDir: args.sourceDir, outputDir: args.outputDir });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`OpenCode ${result.version}`);
    for (const file of result.files) console.log(`${file.platform} ${file.file} ${file.bytes}`);
  }
  return result;
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch(error => {
    const code = error && error.code ? String(error.code) : 'failed';
    console.error(error && error.message ? error.message : 'prepare-agent-runtime failed');
    process.exit(code === 'bad_args' ? 2 : 1);
  });
}

export { main };
