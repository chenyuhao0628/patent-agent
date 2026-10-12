import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { ModelProtocol } from '../src/domain/models.ts';
import { OPENCODE_SESSION_HEADER } from '../src/domain/models.ts';

function event(name: string, data: unknown) { return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`; }
function chunk(data: unknown) { return `data: ${JSON.stringify(data)}\n\n`; }
type Call = { name: string; args: Record<string, unknown> };

/** Loopback-only provider used to verify downloaded engines without credentials
 * or case data. No model network request is made by this acceptance fixture. */
export async function startSyntheticProvider(options: { nativeCommand?: string } = {}) {
  const counts = new Map<string, number>();
  const requests: Array<{ protocol: ModelProtocol; context: string; body: Record<string, any>; names: string[] }> = [];
  const server = http.createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const data of req) buffers.push(Buffer.from(data));
    const body = JSON.parse(Buffer.concat(buffers).toString() || '{}');
    const url = req.url ?? '';
    const protocol: ModelProtocol = url.includes('/responses') ? 'openai-responses' : url.includes('/chat/completions') ? 'openai-chat-completions' : url.includes('/messages') ? 'anthropic-messages' : 'gemini-generate-content';
    const text = JSON.stringify(body), marker = [...text.matchAll(/<!--workbench-turn:([^>]+)-->/g)].at(-1)?.[1] ?? 'unmarked';
    const context = String(req.headers[OPENCODE_SESSION_HEADER] || '');
    const names = (body.tools || []).flatMap((tool: any) => tool.functionDeclarations?.map((f: any) => f.name) ?? [tool.name ?? tool.function?.name]).filter(Boolean);
    requests.push({ protocol, context, body, names });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    if (marker.startsWith('hang-')) { res.write(': synthetic waiting\n\n'); return; }
    const key = `${context}:${marker}`, index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    const calls: Call[] = [
      { name: 'case_tools_read_material', args: { materialId: 'synthetic-material' } },
      { name: 'case_tools_read_material', args: { materialId: 'forbidden-other-case' } },
      { name: 'shell', args: { command: options.nativeCommand ?? 'exit 73', description: 'Synthetic permission probe' } },
      { name: 'case_tools_write_artifact', args: { name: 'result.json', content: { kind: 'discuss', reply: `SYNTHETIC-${marker}` } } },
    ];
    const call = calls[index], id = `call_${index}`, finalText = `SYNTHETIC-${marker}`;
    if (protocol === 'openai-responses') {
      res.end(encodeResponsesSse(body.model, call ? [{ type: 'function_call', id: `fc_${index}`, call_id: id, name: call.name, arguments: JSON.stringify(call.args) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }] }]));
    } else if (protocol === 'openai-chat-completions') {
      const base = { id: `chat_${index}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: finalText };
      res.end(chunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 24, completion_tokens: 16, total_tokens: 40, prompt_tokens_details: { cached_tokens: 12 } } }) + 'data: [DONE]\n\n');
    } else if (protocol === 'anthropic-messages') {
      res.end(event('message_start', { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 24, output_tokens: 0, cache_read_input_tokens: 12, cache_creation_input_tokens: 0 } } })
        + event('content_block_start', { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id, name: call.name, input: {} } : { type: 'text', text: '' } })
        + event('content_block_delta', { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } : { type: 'text_delta', text: finalText } })
        + event('content_block_stop', { type: 'content_block_stop', index: 0 })
        + event('message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } })
        + event('message_stop', { type: 'message_stop' }));
    } else {
      res.end(chunk({ candidates: [{ index: 0, content: { role: 'model', parts: call ? [{ functionCall: { id, name: call.name, args: call.args } }] : [{ text: finalText }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 16, totalTokenCount: 40, cachedContentTokenCount: 12 } }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${(server.address() as {port:number}).port}`, requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
export function encodeResponsesSse(model: unknown, output: Record<string, unknown>[]) {
  const id = 'resp_' + randomBytes(3).toString('hex');
  const usage = { input_tokens: 24, output_tokens: 16, total_tokens: 40, input_tokens_details: { cached_tokens: 12 } };
  const events: Record<string, unknown>[] = [];
  let seq = 0;
  const push = (event: Record<string, unknown>) => {
    events.push({ ...event, sequence_number: seq++ });
  };
  const created = {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress',
    model, output: [] as unknown[], usage: null, error: null,
  };
  push({ type: 'response.created', response: created });
  const completedItems: Record<string, unknown>[] = [];
  output.forEach((item, index) => {
    if (item.type === 'function_call') {
      const callId = String(item.call_id || `call_${index}`);
      const itemId = String(item.id || `fc_${index}`);
      const args = String(item.arguments || '{}');
      const added = { type: 'function_call', id: itemId, call_id: callId, name: item.name, arguments: '', status: 'in_progress' };
      push({ type: 'response.output_item.added', output_index: index, item: added });
      push({ type: 'response.function_call_arguments.delta', item_id: itemId, output_index: index, delta: args });
      push({ type: 'response.function_call_arguments.done', item_id: itemId, output_index: index, arguments: args });
      const done = { ...added, arguments: args, status: 'completed' };
      push({ type: 'response.output_item.done', output_index: index, item: done });
      completedItems.push(done);
    } else {
      const itemId = String(item.id || `msg_${index}`);
      const text = Array.isArray(item.content)
        ? (item.content as { text?: string }[]).map(part => part.text || '').join('')
        : String(item.text || '');
      const added = {
        type: 'message', id: itemId, role: 'assistant', status: 'in_progress',
        content: [{ type: 'output_text', text: '' }],
      };
      push({ type: 'response.output_item.added', output_index: index, item: added });
      push({ type: 'response.output_text.delta', item_id: itemId, output_index: index, content_index: 0, delta: text });
      push({ type: 'response.output_text.done', item_id: itemId, output_index: index, content_index: 0, text });
      const done = {
        type: 'message', id: itemId, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text }],
      };
      push({ type: 'response.output_item.done', output_index: index, item: done });
      completedItems.push(done);
    }
  });
  push({
    type: 'response.completed',
    response: {
      id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
      model, output: completedItems, usage, error: null,
    },
  });
  const frames = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).concat(['event: done\ndata: [DONE]']).join('\n\n') + '\n\n';
  return Buffer.from(frames);
}

