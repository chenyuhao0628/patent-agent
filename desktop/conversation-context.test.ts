import test from 'node:test';import assert from 'node:assert/strict';
import {fitConversation} from './conversation-context.ts';
import {classifySessionError} from './agent-errors.ts';
test('context compacts model input without altering original or latest instruction',()=>{const m=[{role:'assistant' as const,content:'旧'.repeat(20000)},{role:'user' as const,content:'保持最后指令'}];const c=fitConversation(m,v=>JSON.stringify(v).length<2000);assert(c.compressed);assert.equal(c.messages.at(-1)?.content,'保持最后指令');assert.equal(m[0].content.length,20000);assert(c.messages.every(m=>m.role!=='assistant'||m.content.length<1000));});
test('single oversized current instruction is never silently truncated',()=>{const m=[{role:'user' as const,content:'长'.repeat(20000)}];assert.deepEqual(fitConversation(m,v=>JSON.stringify(v).length<2000),{messages:m,compressed:false});});
test('session errors retain useful categories without leaking upstream data',()=>{assert.equal(classifySessionError({message:'context_length_exceeded secret-key'}).code,'context_limit');assert.equal(classifySessionError({message:'401 Bearer private'}).code,'authentication');assert.equal(classifySessionError('429').code,'rate_limit');assert.doesNotMatch(classifySessionError('unknown secret-key').message,/secret-key/);});

test('early user constraints and questions survive a long discussion verbatim',()=>{
 const constraint='只能修改权利要求3，不得改变权利要求1';
 const question='是否应该改选策略？这只是提问。';
 const messages=[{role:'user' as const,content:constraint},...Array.from({length:28},()=>({role:'assistant' as const,content:'旧分析'.repeat(500)})),{role:'user' as const,content:question}];
 const fitted=fitConversation(messages,m=>JSON.stringify(m).length<2200);
 assert(fitted.compressed);assert(fitted.messages.some(m=>m.content===constraint));assert(fitted.messages.some(m=>m.content===question));
});
test('oversized history can use task-local references while current request stays intact',()=>{
 const messages=[{role:'user' as const,sourceId:'old',content:'旧交底原文'.repeat(5000)},{role:'user' as const,sourceId:'current',content:'保留本次限制'}];
 const fitted=fitConversation(messages,m=>JSON.stringify(m).length<2000,true);
 assert.deepEqual(fitted.deferredIds,['old']);assert.equal(fitted.messages.at(-1)?.content,'保留本次限制');assert.match(fitted.messages[0].content,/read_task_memory/);assert.equal(messages[0].content.length,25000);
});
