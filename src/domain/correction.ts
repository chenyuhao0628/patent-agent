export type CorrectionContent={FileName:string;PositionInFile:string;CorrectionBefore:string;CorrectionAfter:string};
export const CORRECTION_FILES=['权利要求书','说明书','说明书附图','说明书摘要','摘要附图','核苷酸或氨基酸序列表','其他','请求书','授权委托书','主体资格证明'];
export function validateCorrectionContents(value:unknown):CorrectionContent[]{
 if(!Array.isArray(value)||value.length>100)throw new Error('补正内容必须是逐条字段列表。');
 return value.map(row=>{if(!row||typeof row!=='object')throw new Error('补正条目格式无效。');const out={}as CorrectionContent;for(const key of ['FileName','PositionInFile','CorrectionBefore','CorrectionAfter']as const){const v=row[key];if(typeof v!=='string'||!v.trim()||v.length>100000)throw new Error('补正条目必须填写文件名称、具体位置、补正前和补正后。');out[key]=v.trim();}if(!CORRECTION_FILES.includes(out.FileName))throw new Error('补正文件名称不在贝思兰德允许范围。');return out;});
}
