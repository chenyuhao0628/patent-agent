export type ContextMessage = { role: 'user' | 'assistant' | 'system'; content: string };
// Lossy excerpts for model input only. Original conversations remain on disk.
export function fitConversation(messages: ContextMessage[], fits: (m: ContextMessage[]) => boolean): { messages: ContextMessage[]; compressed: boolean } {
 if (fits(messages)) return {messages,compressed:false};
 const system=messages.filter(m=>m.role==='system'),chat=messages.filter(m=>m.role!=='system');
 for(let keep=Math.min(6,chat.length-1);keep>=1;keep--){
  const old=chat.slice(0,-keep),recent=chat.slice(-keep);
  const excerpts=old.slice(-20).map(m=>`${m.role}: ${m.content.slice(0,160)}${m.content.length>160?' [节选]':''}`).join('\n');
  const summary:ContextMessage={role:'user',content:'[自动整理的早期对话节选；可能省略细节，不能据此推定策略已确认。以本轮任务和已确认业务状态为准；重要信息缺失时询问用户。原对话保留在本机。]\n'+excerpts};
  if(fits([...system,summary,...recent]))return {messages:[...system,summary,...recent],compressed:true};
 }
 return {messages,compressed:false};
}
