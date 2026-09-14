import test from 'node:test';import assert from 'node:assert/strict';
import {DeepseekEventAdapter,normalizeDeepseekEvent,restoreDeepseekReasoning,deepseekResponses} from './deepseek-responses.ts';
import {classifySessionError} from './agent-errors.ts';

test('DeepSeek reasoning stream converts split UTF8/CRLF frames without changing visible text or tools',()=>{
 const events=[{type:'response.content_part.added',item_id:'r',content_index:0,part:{type:'reasoning_text',text:''}},{type:'response.reasoning_text.delta',item_id:'r',content_index:0,delta:'核对图纸。'},{type:'response.content_part.done',item_id:'r',content_index:0,part:{type:'reasoning_text',text:'核对图纸。'}},{type:'response.output_text.delta',item_id:'answer',delta:'结论'},{type:'response.function_call_arguments.delta',item_id:'tool',delta:'{}'}];
 const bytes=Buffer.from(events.map(e=>'event: '+e.type+'\r\ndata: '+JSON.stringify(e)+'\r\n\r\n').join(''));const adapter=new DeepseekEventAdapter();const chunks:Buffer[]=[];
 for(let i=0;i<bytes.length;i+=7)chunks.push(adapter.push(bytes.subarray(i,i+7)));chunks.push(adapter.end());
 const parsed=Buffer.concat(chunks).toString().split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>JSON.parse(s.slice(5)));
 assert.equal(parsed[0].type,'response.reasoning_summary_part.added');assert.equal(parsed[1].type,'response.reasoning_summary_text.delta');assert.equal(parsed[1].delta,'核对图纸。');assert.equal(parsed[1].summary_index,0);assert.equal(parsed[2].type,'response.reasoning_summary_part.done');assert.deepEqual(parsed[3],events[3]);assert.deepEqual(parsed[4],events[4]);assert.equal(adapter.thinkingChars,5);
});
test('tool follow-up restores thinking as DeepSeek content and keeps tools unchanged',()=>{
 const body={input:[{type:'reasoning',id:'r',summary:[{type:'summary_text',text:'核对'}]},{type:'function_call',call_id:'c',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'c',output:'facts'}]};const next=restoreDeepseekReasoning(body) as {input:any[]};
 assert.deepEqual(next.input[0],{type:'reasoning',id:'r',content:[{type:'reasoning_text',text:'核对'}]});assert.deepEqual(next.input.slice(1),body.input.slice(1));assert('summary' in body.input[0]);
 assert(!deepseekResponses({modelId:'gpt-example',protocol:'openai-responses'}));assert(!deepseekResponses({modelId:'deepseek-v4.1-flash',protocol:'openai-chat-completions'}));
});
test('existing summaries and error events are preserved; oversized unfinished frames fail bounded',()=>{
 const native={type:'response.reasoning_summary_text.delta',delta:'x'};assert.equal(normalizeDeepseekEvent(native),native);
 const error={type:'error',error:{message:'x'}};assert.equal(normalizeDeepseekEvent(error),error);
 assert.throws(()=>new DeepseekEventAdapter().push(Buffer.alloc(1000001,97)),/limit/);
});
test('size and schema failures have actionable classifications',()=>{
 assert.equal(classifySessionError({name:'APIError',data:{statusCode:413}}).code,'request_size_limit');
 assert.equal(classifySessionError({message:'AI_TypeValidationError: Type validation failed'}).code,'response_schema');
 assert.equal(classifySessionError({message:'terminated'}).code,'connection');
});
