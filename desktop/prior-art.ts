import * as fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import type { Case } from '../src/domain/workflow.ts';
import type { PriorArtState } from '../src/domain/prior-art.ts';
import { CaseFiles, digest, managedPath } from './files.ts';
import { extractPdfPageRange } from './agent-document-reader.ts';
import { normalizedPublication, PatsnapService, publicationNumbers } from './patsnap.ts';

export type { PriorArtState } from '../src/domain/prior-art.ts';
export async function preparePriorArt(c:Case,files:CaseFiles,provider:PatsnapService,key:string,signal?:AbortSignal,manual?:string){
  const r=c.rounds.find(r=>r.id===c.current?.roundId||r.id==='proc-'+c.current?.processId);
  if(!r||!['reply','correction'].includes(c.current?.kind??''))return;
  const notices=r.materials.filter(m=>m.ready&&m.relativePath&&/通知|审查意见|补正/.test(m.name)&&!m.name.includes('意见陈述'));
  const signature=digest(JSON.stringify(['notice-pdf-v2',notices.map(m=>[m.id,m.relativePath])]));
  const previous=r.priorArt;
  let numbers=previous?.noticeSignature===signature?previous.items.map(i=>i.number):[];
  let warning=previous?.noticeSignature===signature?previous.warning:'';
  const directory=await files.ensureCase(c),root=path.join(files.settings.workRoot!,directory);
  if(previous?.noticeSignature!==signature){
    for(const m of notices){if(/\.zip$/i.test(m.name)){const base=m.name.replace(/\.zip$/i,'');if(!notices.some(other=>other!==m&&other.name.replace(/\.(pdf|docx|txt|md)$/i,'')===base))warning='通知包含尚未展开的压缩包，请核对并提供其中的 PDF 或公开号。';continue;}try{
      const bytes=await fs.readFile(await managedPath(root,m.relativePath!));if(bytes.length>20*1024*1024)throw new Error();
      let text='';if(m.name.toLowerCase().endsWith('.pdf')){const result=await extractPdfPageRange(bytes,{startLine:1,endLine:20},signal,true);text=[...result.pages.values()].join('\n');if(result.emptyPages.length)warning='第 '+result.emptyPages.join('、')+' 页未提取到文字，请核对扫描页中的对比文件。';if(result.pageCount>20)warning='通知超过 20 页，请核对后续页中的对比文件编号。';}
      else if(m.name.toLowerCase().endsWith('.docx'))text=(await mammoth.extractRawText({buffer:bytes})).value;
      else if(/\.(txt|md)$/i.test(m.name))text=bytes.toString();
      else throw new Error();
      numbers.push(...publicationNumbers(text));
    }catch{if(signal?.aborted)return;warning='部分通知为扫描件或未能提取文字，请查看通知并补充公开号。';}}
    if(!notices.length)warning='尚无可识别的通知书，取得通知后会自动检查。';
  }
  if(manual?.trim())numbers.push(...manual.split(/[\n,，;；]+/).map(n=>normalizedPublication(n.trim())));
  numbers=[...new Set(numbers)].filter(n=>n!==c.applicationNumber?.replace(/[\s.]/g,''));
  if(numbers.length>40)throw new Error('单轮对比文件超过 40 份，请核对编号。');
  const items:PriorArtState['items']=[];
  const configured=(await provider.status(key)).configured;
  for(const number of numbers){
    if(signal?.aborted)return;
    const id='prior-'+digest(r.id+':'+number).slice(0,24),existing=r.materials.find(m=>m.id===id);
    const item:PriorArtState['items'][number]={number,status:'pending',message:'智慧芽尚未配置，请在设置中保存凭证。'};
    if(existing?.ready&&existing.relativePath){try{const b=await fs.readFile(await managedPath(root,existing.relativePath));if(b.subarray(0,5).toString()==='%PDF-'){items.push({number,status:'downloaded',message:'已下载，保留原文件。',relativePath:existing.relativePath});continue;}}catch{/* Retry only missing/corrupt file; old bytes are preserved. */}}
    if(configured)try{
      const bytes=await provider.download(key,number,signal);if(signal?.aborted)return;
      const saved=await files.writeMaterial(c,path.join('01_通知与材料','对比文件__'+digest(r.id).slice(0,8)),id,number+'.pdf',bytes);
      Object.assign(item,{status:'downloaded',message:'已从智慧芽下载。',relativePath:saved.relativePath});
    }catch(e){if(signal?.aborted)return;Object.assign(item,{status:'failed',message:(e as Error).message});}
    const material={id,name:number+'.pdf',role:'对比文件',location:r.name,excerpt:item.message,ready:item.status==='downloaded',relativePath:item.relativePath};
    r.materials=[...r.materials.filter(m=>m.id!==id),material];items.push(item);
  }
  r.priorArt={checkedAt:new Date().toISOString(),noticeSignature:signature,warning:warning||(!numbers.length?'未识别到公开号；如通知含非专利文献或扫描页，请人工核对。':''),items};
}
