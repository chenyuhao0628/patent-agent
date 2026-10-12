import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, digest, managedPath } from './files.ts';

export type EngineSessionScope = {
  root: string;
  profileKey: string;
  caseId: string;
  processKey: string;
  conversationId: string;
  branchId: string;
  kind: string;
  contextHash: string;
};
type Binding = { schema: 1; scopeHash: string; sessionId?: string; status?: 'running' | 'completed' | 'aborted' | 'failed'; updatedAt: string };
const held = new Set<string>();

export function engineScopeHash(scope: EngineSessionScope, context: unknown): string {
  return digest(JSON.stringify([scope.profileKey, scope.caseId, scope.processKey, scope.conversationId, scope.branchId, scope.kind, scope.contextHash, context]));
}

async function readOptional<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('后台会话记录无法读取，原记录已保留。'); }
}

async function copyData(from: string, to: string) {
  await fs.mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(from, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (entry.isSymbolicLink()) throw new Error('后台会话目录含不受支持的符号链接。');
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyData(source, target);
    else if (entry.isFile()) { await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL); await fs.chmod(target, 0o600); }
    else throw new Error('后台会话目录含不受支持的文件。');
  }
}

/** Account/case/stage/branch/context isolation. Each runtime gets a copy of the
 * previous idle database, so rollback never opens a database migrated by a newer engine. */
export async function acquireEngineSession(scope: EngineSessionScope, context: unknown, runtimeIdentity: string) {
  if ([scope.profileKey, scope.caseId, scope.processKey, scope.conversationId, scope.branchId, scope.kind].some(s => !s?.trim())) throw new Error('后台会话缺少案件或分支身份。');
  await fs.mkdir(scope.root, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(scope.root)).isSymbolicLink()) throw new Error('后台会话根目录不能是符号链接。');
  const scopeHash = engineScopeHash(scope, context);
  const root = await managedPath(scope.root, scopeHash);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (held.has(root)) throw new Error('此案件上下文已有后台会话运行。');
  held.add(root);
  const lockPath = await managedPath(root, 'active.lock'), token = randomUUID();
  let locked = false;
  let released = false;
  const release = async () => {
    if (released) return; released = true;
    try {
      if (locked && (await readOptional<{ token: string }>(lockPath))?.token === token) await fs.unlink(lockPath);
    } finally { held.delete(root); }
  };
  try {
    try { await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const prior = await readOptional<{ pid?: number }>(lockPath);
      let alive = true;
      if (Number.isSafeInteger(prior?.pid) && prior!.pid! > 0) {
        try { process.kill(prior!.pid!, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error('此案件后台会话正在使用或锁记录无效，未修改原记录。');
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    }
    locked = true;
    const slot = digest(runtimeIdentity).slice(0, 32);
    const slotRoot = await managedPath(root, `runtimes/${slot}`);
    const indexPath = await managedPath(root, 'runtime.json');
    const index = await readOptional<{ slot: string }>(indexPath);
    try { await fs.access(slotRoot); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await fs.mkdir(path.dirname(slotRoot), { recursive: true, mode: 0o700 });
      const staging = await fs.mkdtemp(path.join(path.dirname(slotRoot), '.preparing-'));
      try {
        if (index?.slot && /^[a-f\d]{32}$/.test(index.slot)) {
          const previous = await managedPath(root, `runtimes/${index.slot}`);
          await copyData(path.join(previous, 'xdg-data'), path.join(staging, 'xdg-data'));
          const binding = await readOptional<Binding>(path.join(previous, 'binding.json'));
          if (binding) await atomicJSON(path.join(staging, 'binding.json'), binding);
        }
        await fs.rename(staging, slotRoot);
      } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
    }
    const bindingPath = await managedPath(slotRoot, 'binding.json');
    let binding = await readOptional<Binding>(bindingPath);
    if (binding && (binding.schema !== 1 || binding.scopeHash !== scopeHash || binding.sessionId && !/^[a-zA-Z0-9_-]+$/.test(binding.sessionId))) throw new Error('后台会话身份不匹配，未复用原记录。');
    await atomicJSON(indexPath, { slot });
    return {
      root: path.join(root, 'sandbox'), data: path.join(slotRoot, 'xdg-data'), scopeHash,
      previousId: binding?.status === 'completed' ? binding.sessionId : undefined,
      async save(sessionId: string, status: NonNullable<Binding['status']>) {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('后台会话标识格式无效。');
        binding = { schema: 1, scopeHash, sessionId, status, updatedAt: new Date().toISOString() };
        await atomicJSON(bindingPath, binding);
        await atomicJSON(await managedPath(slotRoot, `sessions/${sessionId}.json`, true), binding);
      },
      release,
    };
  } catch (error) { await release(); throw error; }
}
