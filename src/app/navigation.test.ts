import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationItems } from './navigation.ts';
import { featureContext } from './features.ts';

test('navigation hides desktop business modules when the host cannot provide them', () => {
  assert.deepEqual(navigationItems(featureContext(false)).map(item => item.id), [
    'library', 'official', 'tasks', 'status',
  ]);
});

test('navigation derives business modules from the registered capability surface', () => {
  const ids = navigationItems(featureContext(true)).map(item => item.id);
  assert.deepEqual(ids, ['library', 'official', 'tasks', 'reply', 'write', 'review', 'transfer', 'status']);
});
