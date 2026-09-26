import test from 'node:test';
import assert from 'node:assert/strict';
import { sameDesktopScope } from './scope.ts';

test('desktop scope rejects late writes after account or generation changes', () => {
  const alice = { profileKey: 'alice', scopeVersion: 7 };
  assert.equal(sameDesktopScope(alice, alice), true);
  assert.equal(sameDesktopScope({ profileKey: 'bob', scopeVersion: 8 }, alice), false);
  assert.equal(sameDesktopScope({ profileKey: 'alice', scopeVersion: 8 }, alice), false);
  assert.equal(sameDesktopScope({ profileKey: 'alice', scopeVersion: 7 }, undefined), true);
  assert.equal(sameDesktopScope({ profileKey: 'alice', scopeVersion: 7 }, { profileKey: 'alice', scopeVersion: 7 }), true);
  assert.equal(sameDesktopScope({ profileKey: 'alice', scopeVersion: 7 }, { profileKey: 'alice', scopeVersion: 8 }), false);
});

test('case scope rejects a late write after the current process changes', () => {
  const expected = { profileKey: 'alice', scopeVersion: 7, caseId: 'case-1', processKey: 'process-a' };
  assert.equal(sameDesktopScope(expected, expected), true);
  assert.equal(sameDesktopScope({ ...expected, processKey: 'process-b' }, expected), false);
  assert.equal(sameDesktopScope({ ...expected, caseId: 'case-2' }, expected), false);
  assert.equal(sameDesktopScope({ profileKey: 'alice', scopeVersion: 7 }, expected), false);
});
