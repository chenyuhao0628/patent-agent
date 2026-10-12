import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireEngineSession, engineScopeHash, type EngineSessionScope } from './engine-sessions.ts';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-session-'));
  const scope: EngineSessionScope = { root, profileKey: 'profile', caseId: 'case', processKey: 'phase', conversationId: 'discussion', branchId: 'branch', kind: 'discuss', contextHash: 'materials' };
  return { root, scope };
}

test('scope identity separates accounts, cases, phases, branches, reviews and material/model changes', async t => {
  const { root, scope } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initial = engineScopeHash(scope, { model: 'model-a' });
  for (const key of ['profileKey', 'caseId', 'processKey', 'conversationId', 'branchId', 'kind', 'contextHash'] as const) assert.notEqual(engineScopeHash({ ...scope, [key]: 'different' }, { model: 'model-a' }), initial, key);
  assert.notEqual(engineScopeHash(scope, { model: 'model-b' }), initial);
  assert.equal(engineScopeHash(scope, { model: 'model-a' }), initial);
});

test('completed session reopens, running/aborted sessions stay retained without resuming hidden execution', async t => {
  const { root, scope } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const one = await acquireEngineSession(scope, 'context', 'engine-a');
  await one.save('ses_first', 'completed');
  await assert.rejects(acquireEngineSession(scope, 'context', 'engine-a'), /已有后台会话/);
  await one.release();
  const two = await acquireEngineSession(scope, 'context', 'engine-a');
  assert.equal(two.previousId, 'ses_first');
  await two.save('ses_first', 'running'); await two.release();
  const three = await acquireEngineSession(scope, 'context', 'engine-a');
  assert.equal(three.previousId, undefined);
  await three.save('ses_second', 'aborted'); await three.release();
  const four = await acquireEngineSession(scope, 'context', 'engine-a');
  assert.equal(four.previousId, undefined); await four.release();
});

test('runtime upgrade copies the idle database and rollback retains its own unmodified schema', async t => {
  const { root, scope } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = await acquireEngineSession(scope, 'context', 'engine-old');
  await fs.mkdir(old.data, { recursive: true }); await fs.writeFile(path.join(old.data, 'db'), 'old-schema');
  await old.save('ses_retained', 'completed'); await old.release();
  const next = await acquireEngineSession(scope, 'context', 'engine-next');
  assert.equal(next.previousId, 'ses_retained'); assert.equal(await fs.readFile(path.join(next.data, 'db'), 'utf8'), 'old-schema');
  await fs.writeFile(path.join(next.data, 'db'), 'new-schema'); await next.release();
  const rolled = await acquireEngineSession(scope, 'context', 'engine-old');
  assert.equal(await fs.readFile(path.join(rolled.data, 'db'), 'utf8'), 'old-schema'); assert.equal(rolled.previousId, 'ses_retained');
  await rolled.release();
});

test('invalid bindings and symlinked database descendants are retained and rejected', async t => {
  const { root, scope } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = await acquireEngineSession(scope, 'context', 'engine-old');
  await fs.mkdir(old.data, { recursive: true });
  await fs.symlink(path.join(root, 'elsewhere'), path.join(old.data, 'link'));
  await old.release();
  await assert.rejects(acquireEngineSession(scope, 'context', 'engine-next'), /符号链接/);
  await fs.unlink(path.join(old.data, 'link'));
  const binding = path.join(path.dirname(old.data), 'binding.json'); await fs.writeFile(binding, JSON.stringify({ schema: 1, scopeHash: 'another-case', sessionId: 'ses_other' }));
  await assert.rejects(acquireEngineSession(scope, 'context', 'engine-old'), /身份不匹配/);
  assert.match(await fs.readFile(binding, 'utf8'), /another-case/);
});
