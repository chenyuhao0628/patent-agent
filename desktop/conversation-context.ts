export type ContextMessage = { role: 'user' | 'assistant' | 'system'; content: string; sourceId?: string };
export type FittedConversation = { messages: ContextMessage[]; compressed: boolean; deferredIds?: string[] };

/** Preserve every user statement before shortening assistant history. Originals stay on disk. */
export function fitConversation(messages: ContextMessage[], fits: (m: ContextMessage[]) => boolean, allowMemoryReferences = false): FittedConversation {
  if (fits(messages)) return {messages,compressed:false};
  const lastUser=messages.findLastIndex(m=>m.role==='user');
  for(const keep of [6,2,0]){
    const last=Math.max(0,messages.length-keep);
    const reduced=messages.flatMap((message,index)=>{
      if(message.role!=='assistant'||index>=last)return [message];
      if(keep===0)return [];
      return [{...message,content:message.content.slice(0,160)+' [助手早期回复节选；不是用户确认]'}];
    });
    if(fits(reduced))return {messages:reduced,compressed:true};
  }
  if(allowMemoryReferences){
    const deferredIds:string[]=[];
    const reduced=messages.flatMap((message,index)=>{
      if(message.role==='assistant')return [];
      if(message.role!=='user'||index===lastUser||!message.sourceId)return [message];
      deferredIds.push(message.sourceId);
      return [{...message,content:'[本任务记忆 '+message.sourceId+'：原用户消息 '+message.content.length+' 字，未删除。必须用 read_task_memory 按此 id 分段读取全文，不能仅依据此指针推测要求。]'}];
    });
    if(fits(reduced))return {messages:reduced,compressed:true,deferredIds};
  }
  return {messages,compressed:false};
}
