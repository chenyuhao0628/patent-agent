import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { OperationReceipt } from '../src/domain/task-progress.ts';
import { redactToolText } from './agent-local-tools.ts';
import { atomicJSON, digest, readBoundedFile } from './files.ts';

type Receipt = { state: 'started' | 'finished'; name?:string; success?:boolean; result?: string };
type Journal = Record<string, Receipt>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

// Persist intent before execution. A lost acknowledgement must never become an automatic replay.
export async function recoveryJournal(file: string, previous?: string, onChange?:()=>Promise<void>) {
  let journal: Journal = {};
  if (previous) {
    try {
      journal = JSON.parse((await readBoundedFile(previous,4_000_000)).toString('utf8'));
      if(!journal||typeof journal!=='object'||Array.isArray(journal)||Object.values(journal).some(r=>!r||!['started','finished'].includes(r.state)))throw new Error('invalid journal');
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT')journal={unavailable:{state:'started',name:'旧执行记录无法核验'}}; }
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicJSON(file, journal);
  let writes = Promise.resolve();
  const persist = () => { const snapshot = structuredClone(journal); const next = writes.then(() => atomicJSON(file, snapshot)); writes = next.catch(() => undefined); return next; };
  const protect = async <T>(name: string, args: unknown, execute: () => Promise<T>): Promise<T> => {
    if(journal.unavailable)throw new Error('旧执行记录无法核验，暂不自动执行命令、下载或安装；已保存正文仍可检查和补齐。');
    const key = digest(Buffer.from(canonical({ name, args })));
    const old = journal[key];
    if (old) throw new Error(old.state === 'started'
      ? '上次相同操作的结果尚未确认。请先核对文件或外部状态，不能自动重复执行。'
      : '相同操作已有执行记录，已阻止重复执行。请先核对已有文件或结果。');
    journal[key] = { state: 'started',name };
    await persist();
    await onChange?.();
    const result = await execute();
    const returned=result as {structuredContent?:{stopped?:boolean;timedOut?:boolean}};
    const uncertain=returned?.structuredContent?.stopped||returned?.structuredContent?.timedOut;
    journal[key] = { state: uncertain?'started':'finished',name,success:typeof result==='object'&&result!==null&&'isError' in result ? !(result as {isError?:boolean}).isError : undefined,result:redactToolText(JSON.stringify(result)??'null').slice(0,80000) };
    await persist();
    await onChange?.();
    return result;
  };
  return Object.assign(protect,{
    receipts:():OperationReceipt[]=>Object.entries(journal).map(([id,r])=>({id,name:r.name??'旧版操作',state:r.state,success:r.success})),
    result:(id:string)=>journal[id]?.result,
  });
}
