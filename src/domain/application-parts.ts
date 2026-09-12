export const APPLICATION_PART_LABELS={ABSTRACT:'说明书摘要',ABSTRACT_IMAGE:'摘要附图',CLAIMS:'权利要求书',DESCRIPTION:'说明书',DRAWINGS:'说明书附图'} as const;
export type ApplicationPart=keyof typeof APPLICATION_PART_LABELS;
export type ApplicationParts=Partial<Record<ApplicationPart,string>>;
export function validateApplicationParts(value:unknown):ApplicationParts{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请明确本次修改的申请文件部分；未修改时保存为空对象。');
 const out:ApplicationParts={};for(const [k,v]of Object.entries(value)){if(!(k in APPLICATION_PART_LABELS)||typeof v!=='string'||!v.trim()||v.length>300000)throw new Error('修改文件须包含完整正文，不能留空或使用未知类别。');out[k as ApplicationPart]=v.trim();}return out;
}
