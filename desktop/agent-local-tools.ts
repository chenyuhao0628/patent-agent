import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { managedPath, atomicJSON } from './files.ts';
import { managedToolsRoot } from './managed-tools.ts';
import { publicWebUrl } from './agent-web.ts';

export type LocalToolPermissions = { commandsEnabled: boolean; downloadsEnabled: boolean };
let permissions: LocalToolPermissions = { commandsEnabled: false, downloadsEnabled: false };
export function configureLocalTools(value: LocalToolPermissions) { permissions = { commandsEnabled: value.commandsEnabled === true, downloadsEnabled: value.downloadsEnabled === true }; }
export function localToolPermissions(): LocalToolPermissions { return { ...permissions }; }
export const LOCAL_TOOL_NAMES = ['discover_tools', 'execute_command', 'download_file', 'prepare_material', 'read_work_file'] as const;
export const LOCAL_TOOL_SCHEMAS = [
  { name: 'discover_tools', description: '检测本机 WPS、Word、系统转换、Python、Node 等已有工具，返回当前权限及工具存放位置。检测到安装不等于该版本支持无人值守转换；先探测接口再调用。', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'execute_command', description: '用户可选的任意本机命令与软件安装。macOS/Linux 使用 sh，Windows 使用 PowerShell。以当前用户权限运行，不是文件或网络沙箱；禁止越过本任务授权、读取凭证或改动原件。先 discover_tools，材料先 prepare_material；优先使用已有工具、轻量库及 toolsRoot 安装位置。结果限长，超时/停止终止命令进程树。', inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string', minLength: 1, maxLength: 24000 }, directory: { type: 'string', enum: ['work', 'tools'], description: '默认工作目录，非安全边界。tools 用于安装可复用工具。' }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300 } } } },
  { name: 'download_file', description: '下载任意公开 HTTP(S) 软件或工具文件到集中下载目录，不自动运行。来源不限制为 Office。可传官方 SHA256 校验，返回实际摘要；无预期摘要只表示完成下载，不表示可信。不得把案件材料或凭证放进 URL。', inputSchema: { type: 'object', additionalProperties: false, required: ['url', 'filename'], properties: { url: { type: 'string', maxLength: 2000 }, filename: { type: 'string', maxLength: 140 }, sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } } } },
  { name: 'prepare_material', description: '把选定材料的副本放进当前命令工作目录，返回副本路径和摘要，用于自选转换/OCR工具。保留原件与冻结快照；必须另存输出。', inputSchema: { type: 'object', additionalProperties: false, required: ['materialId'], properties: { materialId: { type: 'string' } } } },
  { name: 'read_work_file', description: '读取当前命令工作目录中的 TXT/JSON/DOCX/PDF/图片转换结果；PDF visual=true 返回页图。path 是相对工作目录的路径，不是原始材料路径。转换选定材料时传 sourceMaterialId 标明已 prepare_material 的来源；最终结构化成果仍用 write_artifact。', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { sourceMaterialId: { type: 'string', description: '本次已经 prepare_material 的材料 ID，用于关联阅读记录。' }, path: { type: 'string' }, visual: { type: 'boolean' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } } } },
];
export function localToolAllowed(name: string, rights: LocalToolPermissions): boolean {
  return name === 'discover_tools' || (name === 'download_file' ? rights.downloadsEnabled : rights.commandsEnabled);
}
export type DetectedTool = { name: string; path: string; kind: 'application' | 'command'; note: string };
async function exists(file: string) { try { await fs.access(file); return true; } catch { return false; } }
export async function detectLocalTools(): Promise<DetectedTool[]> {
  const candidates: DetectedTool[] = [];
  const add = (name: string, file: string, kind: DetectedTool['kind'], note: string) => candidates.push({ name, path: file, kind, note });
  if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const app of ['WPS Office', 'wpsoffice', 'Microsoft Word', 'LibreOffice']) add(app, path.join(base, app + '.app'), 'application', '已安装；自动化能力需按版本实际探测。');
    }
    add('系统 DOC 转换', '/usr/bin/textutil', 'command', '可转换普通文字；复杂版式需另行核验。');
  } else if (process.platform === 'win32') {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const base of bases) {
      const wps = path.join(base, 'Kingsoft', 'WPS Office');
      add('WPS', path.join(wps, 'office6', 'wps.exe'), 'application', '需探测本版本是否提供本地自动化接口。');
      const versions = await fs.readdir(wps).catch(() => [] as string[]);
      for (const version of versions.filter(v => /^\d[\d.]+$/.test(v)).slice(-12)) add('WPS', path.join(wps, version, 'office6', 'wps.exe'), 'application', '需探测本版本是否提供本地自动化接口。');
      add('LibreOffice', path.join(base, 'LibreOffice', 'program', 'soffice.exe'), 'command', '已有转换组件。');
      add('Microsoft Word', path.join(base, 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'), 'application', '需探测本地自动化接口。');
    }
  }
  const names = process.platform === 'win32' ? ['python.exe', 'py.exe', 'node.exe', 'npm.cmd', 'tesseract.exe', 'pandoc.exe', 'soffice.exe', 'wps.exe'] : ['python3', 'node', 'npm', 'tesseract', 'pandoc', 'antiword', 'soffice', 'wps'];
  const custom = path.join(managedToolsRoot(), 'custom');
  const dirs = [path.join(custom, 'bin'), path.join(custom, 'node_modules', '.bin'), ...process.env.PATH?.split(path.delimiter) ?? [], ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] : [])];
  for (const name of names) for (const dir of [...new Set(dirs)].filter(Boolean)) if (await exists(path.join(dir, name))) { add(name, path.join(dir, name), 'command', '已有命令，使用前检查实际版本与格式支持。'); break; }
  const available = await Promise.all(candidates.map(async c => await exists(c.path) ? c : undefined));
  return available.filter((c): c is DetectedTool => !!c);
}

// Deliberately NOT a sandbox. The opt-in permits arbitrary current-user commands.
// Only selected copies, non-secret environment variables and run-local HOME are passed automatically.
export async function commandEnvironment(workRoot: string, toolsRoot: string): Promise<NodeJS.ProcessEnv> {
  const home = await managedPath(workRoot, '.home', true), temp = await managedPath(workRoot, '.tmp', true);
  await fs.mkdir(home, { recursive: true, mode: 0o700 }); await fs.mkdir(temp, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key];
  env.PATH = [path.join(toolsRoot, 'bin'), path.join(toolsRoot, 'node_modules', '.bin'), path.join(toolsRoot, 'Scripts'), ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []), process.env.PATH ?? ''].join(path.delimiter);
  Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'), PATENT_WORK_DIR: workRoot, PATENT_TOOLS_DIR: toolsRoot, npm_config_prefix: toolsRoot, npm_config_cache: path.join(toolsRoot, '.npm-cache'), PYTHONUSERBASE: toolsRoot, PIP_CACHE_DIR: path.join(toolsRoot, '.pip-cache'), PIP_DISABLE_PIP_VERSION_CHECK: '1' });
  if (process.platform === 'win32') Object.assign(env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
  return env;
}

export function redactToolText(text: string): string {
  return text.replace(/(?:bearer\s+\S+|sk-[a-zA-Z0-9_-]{8,}|(?:api[_-]?key|authorization|password|access[_-]?token)["']?\s*[:=]\s*["']?[^\s"']+)/gi, '<redacted>');
}
export type CommandResult = { exitCode: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; stopped: boolean; timedOut: boolean; durationMs: number };
export async function executeLocalCommand(input: { command: string; workRoot: string; toolsRoot: string; directory?: string; timeoutSeconds?: number; signal?: AbortSignal; onStart?: () => Promise<void> }): Promise<CommandResult> {
  if (!input.command.trim() || input.command.length > 24000 || input.command.includes('\0')) throw new Error('命令必须为 1–24000 个字符。');
  if (input.directory && !['work', 'tools'].includes(input.directory)) throw new Error('默认执行目录无效。');
  const timeout = input.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new Error('命令超时应为 1–300 秒。');
  input.signal?.throwIfAborted();
  const env = await commandEnvironment(input.workRoot, input.toolsRoot);
  // 模型可能用 execute_command 手动跑 soffice；默认 profile 若上次被强杀会残留
  // OfficeRestartInProgress，导致配置层 ReadWriteAccess::create 失败而 abort。
  // 检测到 LibreOffice 调用时清理其默认 profile，让 soffice 用全新干净 profile 启动。
  if (/\b(soffice|libreoffice)\b/i.test(input.command) && env.XDG_CONFIG_HOME) {
    await fs.rm(path.join(env.XDG_CONFIG_HOME, 'libreoffice'), { recursive: true, force: true }).catch(() => {});
  }
  await input.onStart?.(); input.signal?.throwIfAborted();
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const executable = win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
    const args = win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(input.command, 'utf16le').toString('base64')] : ['-c', input.command];
    const child = spawn(executable, args, { cwd: input.directory === 'tools' ? input.toolsRoot : input.workRoot, env, detached: !win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, truncated = false, stopped = false, timedOut = false, settled = false;
    const capture = (key: 'stdout' | 'stderr', data: Buffer) => {
      const remaining = Math.max(0, 48000 - bytes); bytes += data.length;
      if (data.length > remaining) truncated = true;
      const value = data.subarray(0, remaining).toString('utf8');
      if (key === 'stdout') stdout += value; else stderr += value;
    };
    child.stdout.on('data', b => capture('stdout', b)); child.stderr.on('data', b => capture('stderr', b));
    const killTree = () => {
      if (!child.pid) return;
      if (win) execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => {});
      else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    };
    const abort = () => { stopped = true; killTree(); };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeout * 1000);
    input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
    const clean = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); };
    child.once('error', e => { if (settled) return; settled = true; clean(); reject(e); });
    // Also kill descendants after an ordinary exit: a command cannot silently outlive a task.
    child.once('exit', () => { if (!win) killTree(); });
    child.once('close', (exitCode, signal) => {
      if (settled) return; settled = true; clean();
      resolve({ exitCode, signal, stdout: redactToolText(stdout), stderr: redactToolText(stderr), truncated, stopped, timedOut, durationMs: Date.now() - start });
    });
  });
}

const MAX_DOWNLOAD = 2 * 1024 * 1024 * 1024;
export async function downloadToolFile(input: { url: string; filename: string; sha256?: string; root: string; signal?: AbortSignal }, fetcher: typeof fetch = fetch) {
  if (!input.filename || ['download.json', '.partial'].includes(input.filename.toLowerCase()) || input.filename.length > 140 || input.filename !== path.basename(input.filename) || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(input.filename) || /^\.+$/.test(input.filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input.filename)) throw new Error('下载文件名无效。');
  if (input.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(input.sha256)) throw new Error('SHA256 应为 64 位十六进制摘要。');
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
  signal.throwIfAborted();
  let url = await publicWebUrl(input.url), response: Response | undefined;
  for (let hop = 0; hop < 6; hop++) {
    response = await fetcher(url, { redirect: 'manual', signal, credentials: 'omit', headers: { 'User-Agent': 'PatentWorkbench-ToolDownload' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('下载重定向缺少地址。');
      url = await publicWebUrl(new URL(location, url).href); response = undefined; continue;
    }
    break;
  }
  if (!response) throw new Error('下载重定向次数过多。');
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_DOWNLOAD) { await response.body?.cancel(); throw new Error('下载失败或超过单文件 2 GiB 上限。'); }
  if (!response.body) throw new Error('下载没有返回文件。');
  const dir = await managedPath(input.root, randomUUID(), true); await fs.mkdir(dir, { mode: 0o700 });
  const file = path.join(dir, input.filename), partial = path.join(dir, '.partial');
  let size = 0; const hash = createHash('sha256'), reader = response.body.getReader();
  try {
    const handle = await fs.open(partial, 'wx', 0o600);
    try { while (true) { signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_DOWNLOAD) throw new Error('下载超过单文件 2 GiB 上限。'); hash.update(value); await handle.writeFile(value); } } finally { await handle.close(); }
    signal.throwIfAborted(); const sha256 = hash.digest('hex');
    const declared = response.headers.get('content-length');
    if (!size || declared && !response.headers.get('content-encoding') && Number(declared) !== size) throw new Error('下载文件不完整。');
    if (input.sha256 && input.sha256.toLowerCase() !== sha256) throw new Error('下载摘要校验失败，文件已丢弃。');
    await fs.rename(partial, file);
    const result = { file, filename: input.filename, bytes: size, sha256, verified: !!input.sha256, source: url, downloadedAt: new Date().toISOString() };
    await atomicJSON(path.join(dir, 'download.json'), result); return result;
  } catch (e) { await fs.rm(dir, { recursive: true, force: true }); throw e; }
  finally { await reader.cancel().catch(() => {}); }
}

export async function localToolDirectories(workRoot: string) {
  const root = managedToolsRoot();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('工具根目录不能是符号链接。');
  const toolsRoot = await managedPath(root, 'custom'), downloadsRoot = await managedPath(root, 'downloads');
  for (const dir of [workRoot, toolsRoot, downloadsRoot]) { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error('工具工作目录不能是符号链接。'); }
  return { workRoot, toolsRoot, downloadsRoot };
}
