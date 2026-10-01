import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoveryJournal } from './agent-recovery.ts';

test('recovery blocks completed and uncertain side effects after reopening, allows distinct operations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-receipts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await recoveryJournal(path.join(root, 'a.json'));
  let writes = 0;
  await first('execute_command', { b: 2, a: 1 }, async () => ++writes);
  await assert.rejects(first('download_file', { url: 'x' }, async () => { throw new Error('lost acknowledgement'); }));
  const second = await recoveryJournal(path.join(root, 'b.json'), path.join(root, 'a.json'));
  await assert.rejects(second('execute_command', { a: 1, b: 2 }, async () => ++writes), /已有执行记录/);
  await assert.rejects(second('download_file', { url: 'x' }, async () => ++writes), /尚未确认/);
  await second('execute_command', { a: 3 }, async () => ++writes);
  assert.equal(writes, 2);
});

test('recovery exposes redacted reported results, preserves uncertain timeout and handles corrupt journal locally',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-receipts-detail-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const journal=await recoveryJournal(path.join(root,'a.json'));
 await journal('execute_command',{command:'synthetic'},async()=>({isError:false,structuredContent:{exitCode:0},content:[{type:'text',text:'saved synthetic result'}]}));
 const receipt=journal.receipts()[0];assert.equal(receipt.name,'execute_command');assert.equal(receipt.state,'finished');assert.match(journal.result(receipt.id)!,/synthetic result/);
 await journal('execute_command',{command:'slow'},async()=>({isError:true,structuredContent:{timedOut:true}}));assert(journal.receipts().some(r=>r.state==='started'));
 await fs.writeFile(path.join(root,'bad.json'),'not JSON');const next=await recoveryJournal(path.join(root,'new.json'),path.join(root,'bad.json'));
 assert.equal(next.receipts()[0].state,'started');await assert.rejects(next('execute_command',{},async()=>1),/旧执行记录无法核验/);assert.equal(await fs.readFile(path.join(root,'bad.json'),'utf8'),'not JSON');
});
