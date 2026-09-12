import test from 'node:test';
import assert from 'node:assert/strict';
import { canFinalize, makeRound, pauseRunning, seedWorkspace, transition, updateRound } from './workflow.ts';
import type { Round } from './workflow.ts';

function drafted(): Round {
  let r = makeRound('第二次审查意见');
  r = transition(r, { type: 'confirm', value: true });
  r = transition(r, { type: 'start', kind: 'analysis' });
  r = transition(r, { type: 'complete', jobId: r.job!.id });
  r = transition(r, { type: 'start', kind: 'drafting', strategy: '解释差异' });
  return transition(r, { type: 'complete', jobId: r.job!.id });
}
test('manual confirmation and strategy are separate gates; missing materials block start', () => {
  let r = makeRound('补正通知');
  assert.equal(transition(r, { type: 'start', kind: 'analysis' }).job, null);
  r = transition(r, { type: 'confirm', value: true });
  r.materials[0].ready = false;
  assert.equal(transition(r, { type: 'start', kind: 'analysis' }).job, null);
  r.materials[0].ready = true;
  r = transition(r, { type: 'start', kind: 'analysis' });
  r = transition(r, { type: 'complete', jobId: r.job!.id });
  assert.equal(r.draft, '');
  assert.equal(transition(r, { type: 'start', kind: 'drafting' }).job, null);
});
test('late completion after stop is ignored, and recovery requires an explicit resume', () => {
  let r = makeRound('第一次审查意见'); r.confirmed = true;
  r = transition(r, { type: 'start', kind: 'analysis' }); const id = r.job!.id;
  r = transition(r, { type: 'pause' });
  assert.equal(transition(r, { type: 'complete', jobId: id }).stage, 'materials');
  r = transition(r, { type: 'resume' });
  assert.equal(transition(r, { type: 'complete', jobId: 'stale-job' }).stage, 'materials');
  assert.equal(transition(r, { type: 'complete', jobId: id }).stage, 'strategy');
});
test('unsaved edits invalidate review; finalizing freezes only the reviewed version', () => {
  let r = drafted(); const original = r.versions[0].text;
  r = transition(r, { type: 'start', kind: 'reviewing' });
  r = transition(r, { type: 'complete', jobId: r.job!.id });
  assert.equal(canFinalize(r), false);
  r = transition(r, { type: 'resolve' }); assert.equal(canFinalize(r), true);
  r = transition(r, { type: 'edit', text: original + '\n人工修改' });
  assert.equal(r.review, null); assert.equal(canFinalize(r), false);
  assert.equal(transition(r, { type: 'start', kind: 'reviewing' }).job, null);
  r = transition(r, { type: 'save' }); assert.equal(r.versions.length, 2);
  assert.equal(r.versions[0].text, original);
  r = transition(r, { type: 'start', kind: 'reviewing' }); r = transition(r, { type: 'complete', jobId: r.job!.id });
  r = transition(r, { type: 'resolve' }); r = transition(r, { type: 'finalize' });
  const final = structuredClone(r.final);
  assert.equal(transition(r, { type: 'edit', text: 'overwrite' }).draft, r.draft);
  r = transition(r, { type: 'revise' });
  assert.deepEqual(r.finalHistory[0], final);
});
test('updates never cross a case or round and restart preserves all content', () => {
  const w = seedWorkspace(); const first = w.cases[0]; const r = first.rounds[0];
  const changed = updateRound(w, first.id, r.id, { type: 'confirm', value: true });
  assert.deepEqual(changed.cases.slice(1), w.cases.slice(1));
  assert.deepEqual(changed.cases[0].rounds[1], w.cases[0].rounds[1]);
  const running = updateRound(changed, first.id, r.id, { type: 'start', kind: 'analysis' });
  const recovered = pauseRunning(running);
  assert.equal(recovered.cases[0].rounds[0].job?.status, 'paused');
  assert.deepEqual(recovered.cases[0].rounds[0].materials, r.materials);
});
