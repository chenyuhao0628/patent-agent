import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { loadTemplate, replaceParagraph } from './document-export.ts';
import { readOfficeMath, OFFICE_MATH_NS } from './office-math-reader.ts';
import { inspectZipLimits } from './agent-document-reader.ts';
import type { WordBlock, WordInline } from '../src/professional-api.ts';
import jpeg from 'jpeg-js';
import katex from 'katex';
import { splitTextAndFormulas, latexToOmml } from './math-omml.ts';
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const elements=(node:Element)=>Array.from(node.childNodes).filter(n=>n.nodeType===1) as Element[];
const xml=(text:string)=>text.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!));

export async function exportStageDocx(root:string,title:string,text:string):Promise<Buffer>{
 if(!text.trim())throw new Error('阶段正文为空，不能生成 Word。');
 const {zip,doc,body}=await loadTemplate(root,'reply');
 const ps=Array.from(body.getElementsByTagNameNS(W,'p'));
 const prototypes=Object.fromEntries(ps.map(p=>[(p.textContent??'').replace(/[{}]/g,''),p]));
 if(!prototypes.TITLE||!prototypes.BODY||!prototypes.HEADING)throw new Error('阶段文档模板格式不完整。');
 const section=body.getElementsByTagNameNS(W,'sectPr')[0];
 for(const p of ps)body.removeChild(p);
 const relPath='word/_rels/document.xml.rels';
 const relDoc=new DOMParser().parseFromString(await zip.file(relPath)!.async('string'),'application/xml');
 const types=new DOMParser().parseFromString(await zip.file('[Content_Types].xml')!.async('string'),'application/xml');
 let imageId=1000;
 function paragraph(value:string,kind='BODY',level?:number){
  for(const segment of splitTextAndFormulas(value))if(segment.type!=='text'){
    try{katex.renderToString(segment.content,{output:'mathml',throwOnError:true,trust:false});if(!latexToOmml(segment.content,segment.type==='display-math'))throw new Error();}
    catch{throw new Error('阶段公式无法安全转换为 Word 公式，原结果已保留。');}
  }
  const p=replaceParagraph(prototypes[kind],value,kind!=='BODY');
  const pr=p.getElementsByTagNameNS(W,'pPr')[0];
  if(level){const style=doc.createElementNS(W,'w:pStyle');style.setAttributeNS(W,'w:val',`Heading${level}`);pr.insertBefore(style,pr.firstChild);const outline=doc.createElementNS(W,'w:outlineLvl');outline.setAttributeNS(W,'w:val',String(level-1));pr.appendChild(outline);}
  for(const run of Array.from(p.getElementsByTagNameNS(W,'r'))){
   const t=run.getElementsByTagNameNS(W,'t')[0];if(!t)continue;
   const value=t.textContent||'';const pattern=/(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|`([^`]+)`)/g;let start=0;
   const append=(content:string,bold=false,italic=false)=>{if(!content)return;const copy=run.cloneNode(true) as Element;copy.getElementsByTagNameNS(W,'t')[0].textContent=content;let rp=copy.getElementsByTagNameNS(W,'rPr')[0];if(!rp){rp=doc.createElementNS(W,'w:rPr');copy.insertBefore(rp,copy.firstChild);}if(bold)rp.appendChild(doc.createElementNS(W,'w:b'));if(italic)rp.appendChild(doc.createElementNS(W,'w:i'));run.parentNode!.insertBefore(copy,run);};
   for(const match of value.matchAll(pattern)){append(value.slice(start,match.index));append(match[2]??match[3]??match[4]??match[5],!!(match[2]||match[3]),!!match[4]);start=match.index!+match[0].length;}
   append(value.slice(start));run.parentNode!.removeChild(run);
  }
  return p;
 }
 function add(p:Element){body.insertBefore(p,section);}
 add(paragraph(title,'TITLE'));
 const lines=text.replace(/\r\n?/g,'\n').split('\n');
 for(let i=0;i<lines.length;i++){
  let line=lines[i].trim();if(!line)continue;
  if(line.startsWith('```')){while(++i<lines.length&&!lines[i].trim().startsWith('```'))add(paragraph(lines[i]));if(i===lines.length)throw new Error('阶段代码块缺少结束标记。');continue;}
  if(line.startsWith('$$')&&!line.slice(2).includes('$$')){while(++i<lines.length){line+='\n'+lines[i];if(lines[i].includes('$$'))break;}if(!line.slice(2).includes('$$'))throw new Error('阶段公式缺少结束标记。');}
  const heading=/^(#{1,6})\s+(.+)$/.exec(line);if(heading){add(paragraph(heading[2],'HEADING',heading[1].length));continue;}
  if(/^\|?.+\|.+\|?$/.test(line)&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1])){
   const cells=(row:string)=>row.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
   const rows=[cells(line)];i++;while(i+1<lines.length&&lines[i+1].includes('|'))rows.push(cells(lines[++i]));
   const count=rows[0].length;if(rows.some(r=>r.length!==count))throw new Error('阶段表格列数不一致，未生成不完整 Word。');
   const table=doc.createElementNS(W,'w:tbl');const props=doc.createElementNS(W,'w:tblPr');
   props.appendChild(doc.importNode(new DOMParser().parseFromString(`<w:tblBorders xmlns:w="${W}">${['top','left','bottom','right','insideH','insideV'].map(side=>`<w:${side} w:val="single" w:sz="4" w:color="999999"/>`).join('')}</w:tblBorders>`,'application/xml').documentElement,true));
   props.appendChild(doc.importNode(new DOMParser().parseFromString(`<w:tblCellMar xmlns:w="${W}"><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>`,'application/xml').documentElement,true));table.appendChild(props);
   const grid=doc.createElementNS(W,'w:tblGrid');for(let c=0;c<count;c++){const col=doc.createElementNS(W,'w:gridCol');col.setAttributeNS(W,'w:w',String(Math.floor(8640/count)));grid.appendChild(col);}table.appendChild(grid);
   rows.forEach((row,index)=>{const tr=doc.createElementNS(W,'w:tr'),pr=doc.createElementNS(W,'w:trPr');pr.appendChild(doc.createElementNS(W,'w:cantSplit'));if(!index)pr.appendChild(doc.createElementNS(W,'w:tblHeader'));tr.appendChild(pr);row.forEach(value=>{const tc=doc.createElementNS(W,'w:tc');tc.appendChild(paragraph(index?value:`**${value}**`));tr.appendChild(tc);});table.appendChild(tr);});add(table);continue;
  }
  const image=/^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
  if(image){
   const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(image[2]);if(!match)throw new Error('阶段图片必须是已验证的内嵌 PNG/JPEG；未自动读取外部地址。');
   const bytes=Buffer.from(match[2],'base64');if(bytes.length>5*1024*1024)throw new Error('阶段图片超过 5 MB。');
   let width:number,height:number;
   if(match[1]==='png'){if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('阶段 PNG 图片损坏。');width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);}
   else{const decoded=jpeg.decode(bytes,{maxResolutionInMP:25,maxMemoryUsageInMB:128});width=decoded.width;height=decoded.height;}
   if(!width||!height||width*height>25000000)throw new Error('阶段图片尺寸无效。');
   const factor=Math.min(1,540/width,680/height),cx=Math.round(width*factor*9525),cy=Math.round(height*factor*9525);
   const name=`stage-${++imageId}.${match[1]}`,rid=`stageImage${imageId}`;zip.file(`word/media/${name}`,bytes);
   const rel=relDoc.createElementNS(relDoc.documentElement.namespaceURI,'Relationship');rel.setAttribute('Id',rid);rel.setAttribute('Type',R+'/image');rel.setAttribute('Target','media/'+name);relDoc.documentElement.appendChild(rel);
   if(!Array.from(types.getElementsByTagName('Default')).some(t=>t.getAttribute('Extension')===match[1])){const type=types.createElementNS(types.documentElement.namespaceURI,'Default');type.setAttribute('Extension',match[1]);type.setAttribute('ContentType','image/'+match[1]);types.documentElement.appendChild(type);}
   const drawing=`<w:p xmlns:w="${W}" xmlns:r="${R}"><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${imageId}" name="${xml(image[1]||name)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${imageId}" name="${xml(image[1]||name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;add(doc.importNode(new DOMParser().parseFromString(drawing,'application/xml').documentElement,true) as Element);continue;
  }
  if(/!\[[^\]]*\]\(/.test(line))throw new Error('请将阶段图片置于独立段落后重新生成，未忽略图片。');
  line=line.replace(/^[-*+]\s+/,'• ').replace(/^>\s?/, '');
  add(paragraph(line));
 }
 zip.file('word/document.xml',new XMLSerializer().serializeToString(doc));zip.file(relPath,new XMLSerializer().serializeToString(relDoc));zip.file('[Content_Types].xml',new XMLSerializer().serializeToString(types));
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});await readStageDocx(bytes);return bytes;
}

export async function readStageDocx(bytes:Buffer):Promise<WordBlock[]>{
 inspectZipLimits(bytes);const zip=await JSZip.loadAsync(bytes);
 const content=await zip.file('word/document.xml')?.async('string');if(!content)throw new Error('阶段 Word 缺少正文。');
 const doc=new DOMParser().parseFromString(content,'application/xml');
 const rels=new DOMParser().parseFromString(await zip.file('word/_rels/document.xml.rels')!.async('string'),'application/xml');
 async function inline(el:Element):Promise<WordInline[]>{
  if(el.namespaceURI===OFFICE_MATH_NS&&['oMath','oMathPara'].includes(el.localName))return [{text:readOfficeMath(el),math:true}];
  if(el.namespaceURI===W&&el.localName==='t')return [{text:el.textContent||''}];
  if(el.namespaceURI===W&&el.localName==='br')return [{text:'\n'}];
  if(el.localName==='blip'){
   const rid=el.getAttributeNS(R,'embed'),rel=Array.from(rels.getElementsByTagName('Relationship')).find(r=>r.getAttribute('Id')===rid);
   const target=rel?.getAttribute('Target')||'';if(rel?.getAttribute('TargetMode')==='External'||!/^media\/[\w.-]+\.(png|jpeg|jpg)$/.test(target))throw new Error('Word 图片不是受支持的内嵌文件。');
   const image=await zip.file('word/'+target)?.async('nodebuffer');if(!image||image.length>5*1024*1024)throw new Error('Word 内嵌图片缺失或过大。');return [{text:'',image:`data:image/${target.endsWith('.png')?'png':'jpeg'};base64,${image.toString('base64')}`}];
  }
  const result=(await Promise.all(elements(el).filter(c=>!['pPr','rPr'].includes(c.localName)).map(inline))).flat();
  if(el.namespaceURI===W&&el.localName==='r'){const pr=elements(el).find(c=>c.localName==='rPr');for(const item of result){item.bold=!!pr?.getElementsByTagNameNS(W,'b').length;item.italic=!!pr?.getElementsByTagNameNS(W,'i').length;}}return result;
 }
 async function block(el:Element):Promise<WordBlock|undefined>{
  if(el.namespaceURI!==W)return;
  if(el.localName==='p'){const outline=el.getElementsByTagNameNS(W,'outlineLvl')[0];const level=outline?Number(outline.getAttributeNS(W,'val')):NaN;const heading=Number.isFinite(level)?level+1:undefined;return {kind:'paragraph',heading,content:await inline(el)};}
  if(el.localName==='tbl'){const rows=[];for(const row of elements(el).filter(c=>c.localName==='tr')){const cells=[];for(const cell of elements(row).filter(c=>c.localName==='tc'))cells.push((await Promise.all(elements(cell).map(block))).filter((b):b is WordBlock=>!!b));rows.push(cells);}return {kind:'table',rows};}
 }
 const body=doc.getElementsByTagNameNS(W,'body')[0];if(!body)throw new Error('Word 正文结构无效。');return (await Promise.all(elements(body).map(block))).filter((b):b is WordBlock=>!!b);
}
