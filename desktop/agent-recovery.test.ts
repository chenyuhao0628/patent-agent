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
