import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftAutosave, DRAFT_AUTOSAVE_MS } from '../src/components/draft-autosave.ts';

type Handle = { id: number; fn: () => void; ms: number };

function fakeTimers() {
  let nextId = 1;
  const handles = new Map<number, Handle>();
  let now = 0;
  return {
    now: () => now,
    setTimeout: ((fn: () => void, ms: number) => {
      const id = nextId++;
      handles.set(id, { id, fn, ms: now + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
      handles.delete(id as unknown as number);
    }) as typeof clearTimeout,
    async advance(ms: number) {
      now += ms;
      const due = [...handles.values()].filter(h => h.ms <= now).sort((a, b) => a.ms - b.ms);
      for (const h of due) {
        if (!handles.has(h.id)) continue;
        handles.delete(h.id);
        h.fn();
      }
      await Promise.resolve();
    },
    pendingCount: () => handles.size,
  };
}

test('many keystrokes coalesce to one save after debounce (not per keystroke)', async () => {
  const timers = fakeTimers();
  const saved: string[] = [];
  const autosave = createDraftAutosave({
    save: (text) => { saved.push(text); },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  for (const ch of ['一', '一稿', '一稿件', '一稿件正', '一稿件正文']) {
    autosave.onChange(ch);
  }
  assert.equal(saved.length, 0, 'no persist while keystrokes are still within debounce window');
  assert.equal(autosave.hasPending(), true);
  assert.equal(timers.pendingCount(), 1);

  await timers.advance(DRAFT_AUTOSAVE_MS - 1);
  assert.equal(saved.length, 0, 'still waiting before full debounce elapses');

  await timers.advance(1);
  assert.deepEqual(saved, ['一稿件正文']);
  assert.equal(autosave.hasPending(), false);
  assert.equal(timers.pendingCount(), 0);
});

test('blur/unmount flush persists pending text immediately without waiting for debounce', async () => {
  const timers = fakeTimers();
  const saved: string[] = [];
  const autosave = createDraftAutosave({
    save: async (text) => { saved.push(text); },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  autosave.onChange('待刷新');
  autosave.onChange('待刷新稿');
  assert.equal(saved.length, 0);

  await autosave.flush();
  assert.deepEqual(saved, ['待刷新稿']);
  assert.equal(autosave.hasPending(), false);
  assert.equal(timers.pendingCount(), 0, 'flush clears the debounce timer');

  await timers.advance(DRAFT_AUTOSAVE_MS + 50);
  assert.deepEqual(saved, ['待刷新稿'], 'no second save after flush');
});

test('cancel drops pending keystrokes so explicit save path is not raced by debounce', async () => {
  const timers = fakeTimers();
  const saved: string[] = [];
  const autosave = createDraftAutosave({
    save: (text) => { saved.push(text); },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  autosave.onChange('将被取消');
  autosave.cancel();
  assert.equal(autosave.hasPending(), false);
  await timers.advance(DRAFT_AUTOSAVE_MS + 10);
  assert.deepEqual(saved, []);
});
