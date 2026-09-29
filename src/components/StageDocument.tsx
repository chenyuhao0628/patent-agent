import { useEffect, useState } from 'react';
import { desktop } from '../desktop.ts';
import type { ProfessionalJob, StageDocumentPreview, WordBlock } from '../professional-api.ts';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';

function Blocks({blocks}:{blocks:WordBlock[]}){return <>{blocks.map((block,i)=>block.kind==='table'?<table key={i}><tbody>{block.rows.map((row,r)=><tr key={r}>{row.map((cell,c)=><td key={c}><Blocks blocks={cell}/></td>)}</tr>)}</tbody></table>:<div key={i} className={block.heading?'stage-word-heading':'stage-word-paragraph'} role={block.heading?'heading':undefined} aria-level={block.heading}>{block.content.map((part,n)=>part.image?<img key={n} src={part.image} alt="文档内嵌图片"/>:part.math?<FormattedFormulaText key={n} text={part.text} className="stage-word-math"/>:<span key={n} style={{fontWeight:part.bold?'bold':undefined,fontStyle:part.italic?'italic':undefined}}>{part.text}</span>)}</div>)}</>;}
export function StageDocument({profileKey,caseId,job}:{profileKey:string;caseId:string;job:ProfessionalJob}){
 const [preview,setPreview]=useState<StageDocumentPreview|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{let active=true;setPreview(null);setError('');void desktop!.professional.previewDocument(profileKey,caseId,job.processKey,job.id).then(result=>{if(active)setPreview(result);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[profileKey,caseId,job.processKey,job.id,retry]);
 return <div className="stage-word-preview">{error?<div role="alert"><p>Word 文档预览未完成：{error}</p><button onClick={()=>setRetry(x=>x+1)}>重试读取</button></div>:preview?<><div className="section-heading"><span>DOCX 内容预览 · 当前成果版本</span><button onClick={()=>void desktop!.professional.openFile(profileKey,caseId,preview.relativePath).catch(e=>setError(e.message))}>打开对应 Word 文件</button></div><p className="muted">来自已保存 DOCX 的标题、表格、公式和图片；分页与字体以 Word 打开后的实际版式为准。</p><article className="stage-word-page"><Blocks blocks={preview.blocks}/></article></>:<p role="status">正在读取此版本的 Word 文档…</p>}</div>;
}
