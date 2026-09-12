import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './files.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
type XmlElement = Element;
export type ParagraphRole = 'TITLE' | 'BODY' | 'HEADING';
export type ExportParagraph = { role: ParagraphRole; text: string };

export function replyParagraphs(text: string, round: number): ExportParagraph[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) throw new Error('稿件正文为空，不能生成 Word。');
  const result: ExportParagraph[] = [{ role: 'TITLE', text: '意见陈述书' }];
  if (lines[0] === '意见陈述书') lines.shift();
  if (!lines.some(s => /^第.+次意见陈述书$/.test(s))) result.push({ role: 'BODY', text: `第${round}次意见陈述书` });
  for (const line of lines) result.push({
    role: line === '意见陈述书' ? 'TITLE' : /^[一二三四五六七八九十]+、/.test(line) ? 'HEADING' : 'BODY',
    text: line,
  });
  return result;
}

async function loadTemplate(root: string, kind: 'reply' | 'application') {
  const bytes = await fs.readFile(path.join(root, kind + '.docx'));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest[kind]?.templateSha256 !== digest(bytes)) throw new Error('Word 模板校验失败，请重新安装应用。');
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('Word 模板缺少正文。');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return { zip, doc, body: doc.getElementsByTagNameNS(W, 'body')[0] };
}

function replaceParagraph(proto: XmlElement, text: string, heading = false) {
  const p = proto.cloneNode(true) as XmlElement;
  const doc = p.ownerDocument!;
  let prop = p.getElementsByTagNameNS(W, 'pPr')[0];
  if (!prop) { prop = doc.createElementNS(W, 'w:pPr'); p.insertBefore(prop, p.firstChild); }
  const prior = p.getElementsByTagNameNS(W, 'rPr')[0]?.cloneNode(true);
  for (const node of Array.from(p.childNodes)) if (node !== prop) p.removeChild(node);
  if (heading && !prop.getElementsByTagNameNS(W, 'keepNext').length) prop.appendChild(doc.createElementNS(W, 'w:keepNext'));
  const r = doc.createElementNS(W, 'w:r');
  if (prior) r.appendChild(prior);
  const t = doc.createElementNS(W, 'w:t'); t.setAttribute('xml:space', 'preserve'); t.appendChild(doc.createTextNode(text));
  r.appendChild(t); p.appendChild(r);
  return p;
}

export async function exportReplyDocx(templateRoot: string, text: string, round: number): Promise<Buffer> {
  const { zip, doc, body } = await loadTemplate(templateRoot, 'reply');
  const theme=new DOMParser().parseFromString(await zip.file('word/theme/theme1.xml')!.async('string'),'application/xml');
  const minor=theme.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main','minorFont')[0];
  const hans=Array.from(minor.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main','font')).find(n=>n.getAttribute('script')==='Hans')?.getAttribute('typeface');
  const paragraphs = Array.from(body.getElementsByTagNameNS(W, 'p'));
  const prototypes = Object.fromEntries(paragraphs.map(p => [(p.textContent ?? '').replace(/[{}]/g, ''), p]));
  const section = body.getElementsByTagNameNS(W, 'sectPr')[0];
  for (const p of paragraphs) body.removeChild(p);
  for (const item of replyParagraphs(text, round)) {
    const proto = prototypes[item.role];
    if (!proto) throw new Error('Word 模板缺少段落格式。');
    const paragraph=replaceParagraph(proto, item.text, item.role === 'HEADING' || item.text === '此致');
    // Resolve the retained template's Chinese theme face explicitly. Otherwise some
    // readers mix Latin fallback glyphs and overlap Chinese characters in a single run.
    if(hans){const run=paragraph.getElementsByTagNameNS(W,'r')[0];let pr=run.getElementsByTagNameNS(W,'rPr')[0];if(!pr){pr=doc.createElementNS(W,'w:rPr');run.insertBefore(pr,run.firstChild);}let fonts=pr.getElementsByTagNameNS(W,'rFonts')[0];if(!fonts){fonts=doc.createElementNS(W,'w:rFonts');pr.insertBefore(fonts,pr.firstChild);}if(!fonts.hasAttributeNS(W,'eastAsia'))fonts.setAttributeNS(W,'w:eastAsia',hans);fonts.removeAttributeNS(W,'eastAsiaTheme');const lang=doc.createElementNS(W,'w:lang');lang.setAttributeNS(W,'w:eastAsia','zh-CN');pr.appendChild(lang);}
    body.insertBefore(paragraph, section);
  }
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export type ApplicationPart = 'ABSTRACT' | 'ABSTRACT_IMAGE' | 'CLAIMS' | 'DESCRIPTION' | 'DRAWINGS';
export type ApplicationText = Record<ApplicationPart, string>;

/** Complete text-only application master. Figures must be supplied as verified OOXML blocks by the caller. */
export async function exportApplicationText(templateRoot: string, parts: ApplicationText): Promise<Buffer> {
  const { zip, doc, body } = await loadTemplate(templateRoot, 'application');
  const formats=await applicationFormats(templateRoot);
  for (const proto of Array.from(body.getElementsByTagNameNS(W, 'p'))) {
    const key = /^\{\{([A-Z_]+)\}\}$/.exec(proto.textContent ?? '')?.[1] as ApplicationPart | undefined;
    if (!key) continue;
    if (typeof parts[key] !== 'string') throw new Error('申请文件缺少完整部分：' + key);
    for (const [i,line] of parts[key].replace(/\r\n?/g, '\n').split('\n').entries()) body.insertBefore(applicationParagraph(proto,line,key,i,formats), proto);
    body.removeChild(proto);
  }
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Fill only selected sections of the retained five-book template, with their own page furniture. */
type ApplicationFormats=Record<string,{pPr:string;rPr:string}>;
async function applicationFormats(root:string):Promise<ApplicationFormats>{
 const bytes=await fs.readFile(path.join(root,'application-formats.json')),manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
 if(digest(bytes)!==manifest.application.formatsSha256)throw new Error('申请模板段落格式校验失败。');return JSON.parse(bytes.toString()).roles;
}
function applicationParagraph(proto:XmlElement,text:string,key:ApplicationPart,index:number,formats:ApplicationFormats){
 let role:string=key;
 if(key==='DESCRIPTION')role=/^(?:[一二三四五六七八九十]+、)?(?:技术领域|背景技术|发明内容|实用新型内容|附图说明|具体实施方式)$/.test(text.trim())?'DESCRIPTION_HEADING':index===0?'DESCRIPTION_TITLE':'DESCRIPTION_BODY';
 const format=formats[role];if(!format)return replaceParagraph(proto,text);
 const clone=proto.cloneNode(true)as XmlElement,doc=clone.ownerDocument!;for(const child of Array.from(clone.childNodes))clone.removeChild(child);
 const parse=(xml:string)=>doc.importNode(new DOMParser().parseFromString(xml,'application/xml').documentElement,true);
 if(format.pPr)clone.appendChild(parse(format.pPr));const run=doc.createElementNS(W,'w:r');if(format.rPr)run.appendChild(parse(format.rPr));clone.appendChild(run);
 return replaceParagraph(clone,text,role==='DESCRIPTION_TITLE'||role==='DESCRIPTION_HEADING');
}
export async function exportApplicationParts(templateRoot:string,parts:import('../src/domain/application-parts.ts').ApplicationParts):Promise<Buffer>{
  const {zip,doc,body}=await loadTemplate(templateRoot,'application');
  const formats=await applicationFormats(templateRoot);
  const sections:Array<{nodes:XmlElement[];section:XmlElement;key:ApplicationPart}>=[];
  let nodes:XmlElement[]=[],key:ApplicationPart|undefined;
  for(const child of Array.from(body.childNodes).filter(n=>n.nodeType===1) as XmlElement[]){
    if(child.localName==='sectPr'){if(key)sections.push({nodes,section:child,key});continue;}
    const marker=/^\{\{([A-Z_]+)\}\}$/.exec(child.textContent||'');if(marker)key=marker[1] as ApplicationPart;
    const section=child.getElementsByTagNameNS(W,'sectPr')[0];
    if(section){if(!key)throw new Error('模板分节缺少对应正文。');sections.push({nodes,section,key});nodes=[];key=undefined;}else nodes.push(child);
  }
  const inherited=new Map<string,XmlElement>();
  for(const s of sections){const own=new Set<string>();for(const n of Array.from(s.section.childNodes).filter(n=>n.nodeType===1)as XmlElement[])if(['headerReference','footerReference'].includes(n.localName)){const key=n.localName+':'+n.getAttributeNS(W,'type');inherited.set(key,n);own.add(key);}const copy=s.section.cloneNode(true)as XmlElement;for(const [key,n]of inherited)if(!own.has(key))copy.insertBefore(n.cloneNode(true),copy.firstChild);s.section=copy;}
  const chosen=sections.filter(s=>parts[s.key]!==undefined);
  if(!chosen.length)throw new Error('没有需要导出的修改文件。');
  for(const n of Array.from(body.childNodes))body.removeChild(n);
  for(const [index,s]of chosen.entries()){
    for(const proto of s.nodes){
      if(/^\{\{[A-Z_]+\}\}$/.test(proto.textContent||''))for(const [i,line]of parts[s.key]!.replace(/\r\n?/g,'\n').split('\n').entries())body.appendChild(applicationParagraph(proto,line,s.key,i,formats));
      else body.appendChild(proto.cloneNode(true));
    }
    const section=s.section.cloneNode(true) as XmlElement;
    if(index===chosen.length-1)body.appendChild(section);
    else{const p=doc.createElementNS(W,'w:p'),pr=doc.createElementNS(W,'w:pPr');pr.appendChild(section);p.appendChild(pr);body.appendChild(p);}
  }
  zip.file('word/document.xml',new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
export async function exportNoteDocx(templateRoot:string,title:string,text:string):Promise<Buffer>{
 const buffer=await exportReplyDocx(templateRoot,text,1),zip=await JSZip.loadAsync(buffer);
 const doc=new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'),'application/xml');
 const body=doc.getElementsByTagNameNS(W,'body')[0],paragraphs=Array.from(body.getElementsByTagNameNS(W,'p'));
 const titleText=paragraphs[0].getElementsByTagNameNS(W,'t')[0];if(titleText)titleText.textContent=title;
 for(const p of paragraphs.slice(1))if(/^第.+次意见陈述书$/.test(p.textContent||''))body.removeChild(p);
 zip.file('word/document.xml',new XMLSerializer().serializeToString(doc));return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
