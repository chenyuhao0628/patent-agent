import test from 'node:test';
import assert from 'node:assert/strict';
import { sameDesktopScope } from './scope.ts';

test('desktop scope rejects late writes after account or generation changes', () => {
  const alice = { profileKey: 'alice', scopeVersion: 7 };
  assert.equal(sameDesktopScope(alice, alice), true);
  assert.equal(sameDesktopScope({ profileKey: 'bob', scopeVersion: 8 }, alice), false);
  assert.equal(sameDesktopScope({ profileKey: 'alice', scopeVersion: 8 }, alice), false);
  assert.equal(sameDesktopScope({ profileKey: 'alice', scopeVersion: 7 }, undefined), true);
});
