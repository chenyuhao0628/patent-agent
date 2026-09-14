// DeepSeek Responses emits reasoning_text/content, while the pinned OpenAI SDK
// consumes reasoning_summary_text/summary. Adapt only this semantic difference.
function object(value:unknown):Record<string,any>|undefined{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:undefined;}
export function deepseekResponses(runtime:{protocol:string;modelId:string}){return runtime.protocol==='openai-responses'&&/^deepseek[-/]/i.test(runtime.modelId);}
export function restoreDeepseekReasoning(body:Record<string,unknown>){
 if(!Array.isArray(body.input))return body;
 return {...body,input:body.input.map(raw=>{const item=object(raw);if(item?.type!=='reasoning'||Array.isArray(item.content)||!Array.isArray(item.summary))return raw;
 const {summary,...rest}=item;return {...rest,content:summary.filter((p:unknown)=>object(p)?.type==='summary_text').map((p:any)=>({type:'reasoning_text',text:p.text}))};})};
}
function reasoningItem(raw:unknown){const item=object(raw);if(item?.type!=='reasoning'||!Array.isArray(item.content)||item.summary?.length)return raw;
 return {...item,summary:item.content.filter((p:unknown)=>object(p)?.type==='reasoning_text').map((p:any)=>({type:'summary_text',text:p.text}))};}
export function normalizeDeepseekEvent(raw:unknown):unknown{
 const e=object(raw);if(!e)return raw;
 if(e.type==='response.reasoning_text.delta')return {...e,type:'response.reasoning_summary_text.delta',summary_index:e.content_index??0};
 if((e.type==='response.content_part.added'||e.type==='response.content_part.done')&&object(e.part)?.type==='reasoning_text')return {...e,type:e.type.endsWith('.added')?'response.reasoning_summary_part.added':'response.reasoning_summary_part.done',summary_index:e.content_index??0,part:{...e.part,type:'summary_text'}};
 if(e.type==='response.output_item.added'||e.type==='response.output_item.done')return {...e,item:reasoningItem(e.item)};
 if(e.response&&Array.isArray(e.response.output))return {...e,response:{...e.response,output:e.response.output.map(reasoningItem)}};
 return raw;
}
export class DeepseekEventAdapter{
 private decoder=new TextDecoder();private buffer='';thinkingChars=0;
 push(chunk:Uint8Array){this.buffer+=this.decoder.decode(chunk,{stream:true});return this.drain();}
 private drain(){let output='';let separator:RegExpExecArray|null;
 while((separator=/\r?\n\r?\n/.exec(this.buffer))){const frame=this.buffer.slice(0,separator.index);this.buffer=this.buffer.slice(separator.index+separator[0].length);
 const data=frame.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');
 try{const value=JSON.parse(data);if(value.type==='response.reasoning_text.delta'&&typeof value.delta==='string')this.thinkingChars+=value.delta.length;
 const next=normalizeDeepseekEvent(value);output+=next!==value?'event: '+(next as any).type+'\ndata: '+JSON.stringify(next)+'\n\n':frame+separator[0];}
 catch{output+=frame+separator[0];}}
 if(this.buffer.length>1_000_000)throw Object.assign(new Error('SSE frame exceeds limit'),{code:'event_frame_limit'});
 return Buffer.from(output);
 }
 end(){this.buffer+=this.decoder.decode();const complete=this.drain();const tail=Buffer.from(this.buffer);this.buffer='';return Buffer.concat([complete,tail]);}
}
