export type AdapterDefinition<Options, Adapter> = {
  id: string;
  contractVersion: number;
  capabilities: readonly string[];
  create: (options: Options) => Adapter;
};
/** Compiled adapters are selected by identity and a behavior contract. A
 * registry does not load external code or switch dependencies inside a task. */
export function createAdapterRegistry<Options, Adapter>(definitions: readonly AdapterDefinition<Options,Adapter>[], required: readonly string[], contractVersion=1) {
  const needed=[...required];
  const adapters=new Map<string,AdapterDefinition<Options,Adapter>>();
  for(const raw of definitions){
    if(!/^[a-z][a-z0-9-]*$/.test(raw.id)||adapters.has(raw.id)||typeof raw.create!=='function'||!Number.isSafeInteger(raw.contractVersion)||raw.contractVersion<1||!Array.isArray(raw.capabilities)||raw.capabilities.some(c=>typeof c!=='string'||!c.trim()))throw new Error('适配器描述无效或标识重复。');
    adapters.set(raw.id,Object.freeze({...raw,capabilities:Object.freeze([...raw.capabilities])}));
  }
  return {
    list:()=>[...adapters.values()].map(({id,contractVersion,capabilities})=>({id,contractVersion,capabilities})),
    create:(id:string,options:Options):Adapter=>{
      const adapter=adapters.get(id);
      if(!adapter)throw new Error(`适配器未注册：${id}`);
      if(adapter.contractVersion!==contractVersion)throw new Error(`适配器接口版本不兼容：${id}`);
      if(needed.some(capability=>!adapter.capabilities.includes(capability)))throw new Error(`适配器缺少必要能力：${id}`);
      return adapter.create(options);
    },
  };
}
