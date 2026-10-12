import test from 'node:test';
import assert from 'node:assert/strict';
import { currentV2Messages, normalizedV2Messages, requireV2Info, turnMarker, v2Outcome } from './opencode-v2.ts';
import { createAssistantEventFilter, createPartTextAccumulator } from './agent-runner.ts';
import { scopedWireContext } from './agent-proxy.ts';

test('native pagination stops at this run and never returns an earlier idle outcome',async()=>{
  const pages=[{data:[{id:'idle',type:'idle',outcome:'succeeded'},{id:'a',type:'assistant',finish:'stop',time:{completed:1},content:[{type:'text',text:'current'}]}],cursor:{next:'older'}},{data:[{id:'u',type:'user',text:turnMarker('run')},{id:'old',type:'assistant',content:[{type:'text',text:'old'}]}],cursor:{next:'oldest'}}];
  const routes:string[]=[];
  const rows=await currentV2Messages(async(_m,r)=>{routes.push(r);return pages.shift();},'s','run');
  assert.equal(rows.length,2);assert.equal(v2Outcome(rows),'succeeded');assert.match(routes[1],/cursor=older/);assert.doesNotMatch(routes[1],/order=/);
  assert.equal(normalizedV2Messages(rows)[0].parts[0].id,'0');
  assert.deepEqual(await currentV2Messages(async()=>({data:[{id:'old',type:'idle',outcome:'succeeded'}],cursor:{next:null}}),'s','new'),[]);
});

test('unknown additive fields and future versions are accepted; malformed required contracts fail',()=>{
  assert.equal(requireV2Info({version:'3.4.5',pid:100,newCapability:true}),'3.4.5');
  assert.throws(()=>requireV2Info({version:'1.99.0',pid:100}));assert.throws(()=>requireV2Info({version:'2.9.0'}));
});

test('v2 deltas, cumulative polling, reasoning and foreign sessions stay separate',()=>{
  let text='',thinking='';const accumulator=createPartTextAccumulator(s=>text+=s,s=>thinking=s),accept=createAssistantEventFilter('s',accumulator);
  const event=(type:string,data:Record<string,unknown>)=>accept({type,data:{sessionID:'s',assistantMessageID:'a',ordinal:0,...data}});
  event('session.text.started',{});event('session.text.delta',{delta:'甲'});
  accumulator.ingest({messageId:'a',partId:'0',type:'text',text:'甲乙'});
  event('session.text.delta',{delta:'乙'});event('session.text.ended',{text:'甲乙'});
  event('session.text.delta',{sessionID:'other',delta:'其他案件'});
  event('session.reasoning.started',{ordinal:1});event('session.reasoning.delta',{ordinal:1,delta:'思考展示'});
  assert.equal(text,'甲乙');assert.equal(thinking,'思考展示');assert.equal(accumulator.snapshot(),'甲乙');
});

for(const protocol of ['openai-responses','openai-chat-completions','anthropic-messages','gemini-generate-content'] as const)test(`${protocol} keeps current task tools but does not replay hidden thought or stale tools from a prior task`,()=>{
  const key=protocol==='openai-responses'?'input':protocol==='gemini-generate-content'?'contents':'messages';
  const marker=turnMarker('current'),old=[{role:'system',content:'rules'},{role:'user',content:turnMarker('old')},{role:'assistant',content:'hidden-old-reasoning'},{role:'tool',content:'stale-tool-output'}];
  const active=[{role:'user',content:'authoritative-public-context '+marker},{role:'assistant',content:'current-tool-call'},{role:'tool',content:'current-tool-output'}];
  const value=scopedWireContext(protocol,{[key]:[...old,...active],previous_response_id:'old-native-link'},marker,false);
  assert.deepEqual(value.body[key],[old[0],...active]);assert.equal(value.body.previous_response_id,undefined);assert.equal(value.established,true);
  assert.throws(()=>scopedWireContext(protocol,{[key]:old},marker,false),/任务标识/);
});
