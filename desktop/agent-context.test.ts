import test from 'node:test';
import assert from 'node:assert/strict';
import { createWireTaskScope, scopedWireContext } from './agent-proxy.ts';
import { turnMarker } from './opencode-v2.ts';

for (const protocol of ['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'gemini-generate-content'] as const) {
  const field = protocol === 'openai-responses' ? 'input' : protocol === 'gemini-generate-content' ? 'contents' : 'messages';
  const marker = turnMarker('current');
  const user = (text: string) => protocol === 'gemini-generate-content'
    ? { role: 'user', parts: [{ text }] }
    : { role: 'user', content: [{ type: protocol === 'openai-responses' ? 'input_text' : 'text', text }] };
  const body = (rows: unknown[]) => ({ [field]: rows, previous_response_id: 'stale-server-state' });
  const control = user('Update the existing checkpoint in the conversation above into one consolidated summary.');

  test(`${protocol}: compaction of older history uses only the current task and retains current progress`, () => {
    const scope = createWireTaskScope(protocol, marker, `${marker}\nPUBLIC-CONTEXT`);
    scope(body([user('OLD-PRIVATE-THOUGHT'), user(`${marker}\nPUBLIC-CONTEXT`), user('CURRENT-TOOL-PROGRESS')]));
    const request = scope(body([user('<conversation-checkpoint>OLD-PRIVATE-SUMMARY</conversation-checkpoint>'), control]));
    assert.doesNotMatch(JSON.stringify(request), /OLD-PRIVATE|stale-server-state/);
    assert.match(JSON.stringify(request), /PUBLIC-CONTEXT/);
    assert.match(JSON.stringify(request), /CURRENT-TOOL-PROGRESS/);
    const continued = scope(body([user('OLD-PRIVATE-TRANSCRIPT'), user('<conversation-checkpoint>CURRENT-SUMMARY</conversation-checkpoint>'), user('CURRENT-RESULT')]));
    assert.doesNotMatch(JSON.stringify(continued), /OLD-PRIVATE|stale-server-state/);
    assert.match(JSON.stringify(continued), /CURRENT-SUMMARY.*CURRENT-RESULT/);
    const nextTask = createWireTaskScope(protocol, turnMarker('next'));
    assert.throws(() => nextTask(continued), /任务标识/);
  });

  test(`${protocol}: compaction before the first normal request uses the public seed; unknown unmarked history fails closed`, () => {
    const scope = createWireTaskScope(protocol, marker, `${marker}\nPUBLIC-CONTEXT`);
    const request = scope(body([user('OLD-PRIVATE-DETAIL'), control]));
    assert.doesNotMatch(JSON.stringify(request), /OLD-PRIVATE|stale-server-state/);
    assert.match(JSON.stringify(request), /PUBLIC-CONTEXT/);
    assert.throws(() => createWireTaskScope(protocol, marker)(body([user('OLD'), control])), /公开上下文/);
    const uncompressed = createWireTaskScope(protocol, marker);
    uncompressed(body([user(marker)]));
    assert.throws(() => uncompressed(body([user('<conversation-checkpoint>OLD-SUMMARY</conversation-checkpoint>')])), /任务标识/);
    // A quoted control in a prior message does not authorize a new checkpoint.
    assert.throws(() => uncompressed(body([control, user('<conversation-checkpoint>OLD-SUMMARY</conversation-checkpoint>')])), /任务标识/);
  });

  test(`${protocol}: a checkpoint containing the current marker drops older serialized text, including earlier content parts`, () => {
    const prefix = '<conversation-checkpoint>\n<summary>OLD-PRIVATE-SUMMARY</summary>\n<recent-context>OLD-TOOL-RESULT\n';
    const recent = `${marker}\nPUBLIC-CONTEXT\nCURRENT-TOOL-PROGRESS\n</recent-context>\n</conversation-checkpoint>`;
    const checkpoint = user(prefix + recent);
    const result = scopedWireContext(protocol, body([checkpoint]), marker, false);
    assert.doesNotMatch(JSON.stringify(result.body), /OLD-|stale-server-state|<\/recent-context>|<\/conversation-checkpoint>/);
    assert.match(JSON.stringify(result.body), /PUBLIC-CONTEXT.*CURRENT-TOOL-PROGRESS/);
    const multipart = protocol === 'gemini-generate-content'
      ? { role: 'user', parts: [{ text: prefix }, { text: recent }] }
      : { role: 'user', content: [{ type: 'text', text: prefix }, { type: 'text', text: recent }] };
    assert.doesNotMatch(JSON.stringify(scopedWireContext(protocol, body([multipart]), marker, false).body), /OLD-/);
    if (protocol !== 'gemini-generate-content') {
      assert.doesNotMatch(JSON.stringify(scopedWireContext(protocol, body([{ role: 'user', content: prefix + recent }]), marker, false).body), /OLD-/);
    }
  });
}
