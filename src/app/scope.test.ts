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

test('scope comparison rejects partial case scopes instead of treating missing fields as wildcards', () => {
  const account = { profileKey: 'alice', scopeVersion: 7 };
  const caseScope = { ...account, caseId: 'case-1', processKey: 'process-a' };
  assert.equal(sameDesktopScope({ ...account, caseId: 'case-1' }, caseScope), false);
  assert.equal(sameDesktopScope({ ...account, processKey: 'process-a' }, caseScope), false);
  assert.equal(sameDesktopScope(caseScope, account), false);
});

test('scope comparison rejects an older case stage generation', () => {
  const current = { profileKey: 'alice', scopeVersion: 7, caseId: 'case-1', processKey: 'process-a', caseRevision: 2 };
  assert.equal(sameDesktopScope(current, { ...current, caseRevision: 1 }), false);
  assert.equal(sameDesktopScope(current, current), true);
});
import { acceptDesktopState } from './scope.ts';
import type { DesktopState } from '../contracts/desktop-state.ts';

test('late bootstrap and settings responses cannot restore an older account generation',()=>{
  const current={profileKey:'b',scopeVersion:4} as DesktopState;
  for(const stale of [{profileKey:'a',scopeVersion:2},{profileKey:'a',scopeVersion:4},{profileKey:'b',scopeVersion:3}]){
    assert.equal(acceptDesktopState(current,stale as DesktopState),current);
  }
  const next={profileKey:'a',scopeVersion:5} as DesktopState;
  assert.equal(acceptDesktopState(current,next),next);
});

test('desktop snapshots cannot go backwards within an unchanged stage',()=>{
  const current={profileKey:'a',scopeVersion:4,snapshotVersion:8,caseRevisions:{c:2}} as unknown as DesktopState;
  assert.equal(acceptDesktopState(current,{...current,snapshotVersion:7}),current);
  const newer={...current,snapshotVersion:9};
  assert.equal(acceptDesktopState(current,newer),newer);
  const nextAccount={...current,profileKey:'b',scopeVersion:5,snapshotVersion:1};
  assert.equal(acceptDesktopState(current,nextAccount),nextAccount);
});
