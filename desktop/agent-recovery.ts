import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, digest } from './files.ts';

type Receipt = { state: 'started' | 'finished'; result?: unknown };
type Journal = Record<string, Receipt>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

// Persist intent before execution. A lost acknowledgement must never become an automatic replay.
export async function recoveryJournal(file: string, previous?: string) {
  let journal: Journal = {};
  if (previous) {
    try { journal = JSON.parse(await fs.readFile(previous, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法核对上次工具执行记录，未自动重试。'); }
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicJSON(file, journal);
  let writes = Promise.resolve();
  const persist = () => { const snapshot = structuredClone(journal); const next = writes.then(() => atomicJSON(file, snapshot)); writes = next.catch(() => undefined); return next; };
  return async <T>(name: string, args: unknown, execute: () => Promise<T>): Promise<T> => {
    const key = digest(Buffer.from(canonical({ name, args })));
    const old = journal[key];
    if (old) throw new Error(old.state === 'started'
      ? '上次相同操作的结果尚未确认。请先核对文件或外部状态，不能自动重复执行。'
      : '相同操作已有执行记录，已阻止重复执行。请先核对已有文件或结果。');
    journal[key] = { state: 'started' };
    await persist();
    const result = await execute();
    journal[key] = { state: 'finished' };
    await persist();
    return result;
  };
}
