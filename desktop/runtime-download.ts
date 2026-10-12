import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream';

export type RuntimeRelease = { version: string; packageName: string; tarball: string; integrity: string };
export type InstalledRuntime = { version: string; sha256: string; binaryPath: string; source: 'bundled' | 'update' };
const MAX_ARCHIVE = 350 * 1024 * 1024, MAX_BINARY = 600 * 1024 * 1024;

export function nativeRuntimePackage(platform = process.platform, arch = process.arch): string {
  if (platform === 'darwin' && arch === 'arm64') return '@opencode/cli-darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return '@opencode/cli-windows-x64-baseline';
  throw new Error('当前系统没有配套的 OpenCode 自动更新构件。');
}
export function stableRuntimeVersion(value: unknown): value is string { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) && Number(value.split('.')[0]) >= 2; }
export function newerVersion(candidate: string, active: string) {
  const a = candidate.split('.').map(Number), b = active.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export async function runtimeFileHash(file: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}

export async function latestRuntimeRelease(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RuntimeRelease> {
  const packageName = nativeRuntimePackage();
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), redirect: 'error', credentials: 'omit' });
  if (!response.ok || Number(response.headers.get('content-length')) > 1024 * 1024) { await response.body?.cancel(); throw new Error('官方运行时版本查询失败。'); }
  const text = await response.text(); if (text.length > 1024 * 1024) throw new Error('官方运行时元数据过大。');
  const meta = JSON.parse(text);
  if (meta.name !== packageName || !stableRuntimeVersion(meta.version) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(meta.dist?.integrity ?? '')) throw new Error('官方运行时元数据格式无效。');
  const tarball = new URL(meta.dist.tarball);
  if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org' || tarball.username || tarball.password || !decodeURIComponent(tarball.pathname).startsWith(`${packageName}/-`.replace(/^/, '/'))) throw new Error('运行时下载来源不在官方包范围内。');
  return { version: meta.version, packageName, tarball: tarball.href, integrity: meta.dist.integrity };
}

// Extract only the known regular executable entry; never evaluate package scripts
// or extract archive-controlled paths, symlinks, hardlinks or ancillary files.
export async function extractRuntimeArchive(archive: string, target: string, signal: AbortSignal, platform: NodeJS.Platform = process.platform) {
  const source = createReadStream(archive), unzip = createGunzip();
  pipeline(source, unzip, () => {});
  const abort = () => { source.destroy(); unzip.destroy(new Error('运行时下载已取消。')); };
  signal.addEventListener('abort', abort, { once: true });
  let buffer = Buffer.alloc(0), remaining = 0, padding = 0, extracting = false, found = false, total = 0, expanded = 0;
  const file = await fs.open(target, 'wx', 0o700);
  try {
    for await (const raw of unzip) {
      signal.throwIfAborted();
      expanded += raw.length;
      if (expanded > MAX_BINARY + 20 * 1024 * 1024) throw new Error('运行时压缩包解压后超出大小限制。');
      buffer = Buffer.concat([buffer, Buffer.from(raw)]);
      for (;;) {
        if (remaining) {
          const length = Math.min(buffer.length, remaining); if (!length) break;
          if (extracting) { total += length; if (total > MAX_BINARY) throw new Error('运行时二进制超出大小限制。'); await file.writeFile(buffer.subarray(0, length)); }
          remaining -= length; buffer = buffer.subarray(length); if (remaining) break;
        }
        if (padding) { const length = Math.min(buffer.length, padding); padding -= length; buffer = buffer.subarray(length); if (padding) break; }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every(b => b === 0)) { buffer = Buffer.alloc(0); break; }
        const name = header.subarray(0, 100).toString().replace(/\0.*$/, ''), prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
        const size = header.subarray(124, 136).toString().replace(/\0.*$/, '').trim();
        if (!/^[0-7]+$/.test(size)) throw new Error('运行时压缩包大小字段无效。');
        remaining = parseInt(size, 8); if (!Number.isSafeInteger(remaining) || remaining > MAX_BINARY) throw new Error('运行时压缩包成员过大。');
        padding = (512 - remaining % 512) % 512;
        const executable = platform === 'win32' ? 'opencode.exe' : 'opencode';
        extracting = !prefix && name === `package/bin/${executable}`;
        if (extracting) { if (found || ![0, 48].includes(header[156])) throw new Error('运行时压缩包可执行文件不是唯一普通文件。'); found = true; }
      }
    }
    if (!found || !total || remaining || padding) throw new Error('运行时压缩包缺少完整可执行文件。');
  } finally { signal.removeEventListener('abort', abort); source.destroy(); unzip.destroy(); await file.close(); }
}

export async function downloadRuntime(release: RuntimeRelease, directory: string, signal: AbortSignal, fetcher: typeof fetch = fetch, platform: NodeJS.Platform = process.platform): Promise<InstalledRuntime> {
  const archive = path.join(directory, 'package.tgz'), binaryPath = path.join(directory, platform === 'win32' ? 'opencode.exe' : 'opencode');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const response = await fetcher(release.tarball, { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]), redirect: 'error', credentials: 'omit' });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_ARCHIVE) { await response.body?.cancel(); throw new Error('运行时下载失败或文件过大。'); }
  const reader = response.body.getReader(), hash = createHash('sha512'), handle = await fs.open(archive, 'wx', 0o600); let total = 0;
  try {
    while (true) { signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > MAX_ARCHIVE) throw new Error('运行时下载超出大小限制。'); hash.update(value); await handle.writeFile(value); }
  } finally { await reader.cancel().catch(() => {}); await handle.close(); }
  if (`sha512-${hash.digest('base64')}` !== release.integrity) throw new Error('运行时下载完整性校验失败。');
  await extractRuntimeArchive(archive, binaryPath, signal, platform);
  await fs.unlink(archive);
  const header = Buffer.alloc(4), binary = await fs.open(binaryPath, 'r'); try { await binary.read(header, 0, 4, 0); } finally { await binary.close(); }
  if (platform === 'win32' ? header.subarray(0, 2).toString('hex') !== '4d5a' : header.toString('hex') !== 'cffaedfe') throw new Error('运行时构件平台不匹配。');
  return { version: release.version, sha256: await runtimeFileHash(binaryPath), binaryPath, source: 'update' };
}
