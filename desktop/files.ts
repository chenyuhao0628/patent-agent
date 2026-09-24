import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import type { Case, Material, Settings } from '../src/domain/workflow.ts';

export const digest=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export const portable=(s:string)=>s.replaceAll('\\','/');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export const FIVE_PARTS_SPEC: Array<{ code: string; name: string }> = [
  { code: '100001', name: '权利要求书' },
  { code: '100002', name: '说明书' },
  { code: '100003', name: '说明书附图' },
  { code: '100004', name: '说明书摘要' },
  { code: '100005', name: '摘要附图' },
];

export function getImageMime(filename: string, buffer?: Buffer): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';

  if (buffer && buffer.length >= 8) {
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
    if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) return 'image/bmp';
  }
  return 'image/png';
}

export function bufferToDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

export function resolveWordTarget(target: string): string {
  let cleaned = target.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.startsWith('word/')) return cleaned;
  if (cleaned.startsWith('../')) cleaned = cleaned.replace(/^\.\.\//, '');
  if (cleaned.startsWith('./')) cleaned = cleaned.replace(/^\.\//, '');
  return cleaned.startsWith('word/') ? cleaned : `word/${cleaned}`;
}

export type DocxExtractedContent = {
  text: string;
  parts?: Array<{ code: string; name: string; content: string }>;
  imagesCount: number;
};

export async function extractDocxContent(
  bytes: Buffer,
  options?: { maxImages?: number; maxImageBytes?: number; includeImages?: boolean }
): Promise<DocxExtractedContent> {
  const maxImages = options?.maxImages ?? 40;
  const maxImageBytes = options?.maxImageBytes ?? 5 * 1024 * 1024;
  const includeImages = options?.includeImages ?? true;

  try {
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')?.async('string');
    if (!xml) return { text: '', imagesCount: 0 };

    const relxml = await zip.file('word/_rels/document.xml.rels')?.async('string');
    const parser = new DOMParser();
    const rels = new Map<string, string>();
    if (relxml) {
      const relDoc = parser.parseFromString(relxml, 'application/xml');
      for (const rel of Array.from(relDoc.getElementsByTagName('Relationship'))) {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        if (id && target) rels.set(id, target);
      }
    }

    const imageCache = new Map<string, string>();
    let imagesCount = 0;

    if (includeImages) {
      for (const [id, target] of rels.entries()) {
        const lower = target.toLowerCase();
        const isImageRel = lower.match(/\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/) || lower.includes('media/');
        if (!isImageRel) continue;

        const resolved = resolveWordTarget(target);
        const file = zip.file(resolved) || zip.file(target) || zip.file(target.replace(/^\.\.\//, ''));
        if (file) {
          if (imagesCount >= maxImages) {
            imageCache.set(id, 'LIMIT_REACHED');
            continue;
          }
          try {
            const imgBuffer = await file.async('nodebuffer');
            if (imgBuffer.length > maxImageBytes) {
              imageCache.set(id, 'TOO_LARGE');
            } else {
              const mime = getImageMime(target, imgBuffer);
              const dataUrl = bufferToDataUrl(imgBuffer, mime);
              imageCache.set(id, dataUrl);
              imagesCount++;
            }
          } catch {
            imageCache.set(id, 'ERROR');
          }
        }
      }
    }

    const doc = parser.parseFromString(xml, 'application/xml');
    const body = doc.getElementsByTagNameNS(W, 'body')[0];
    if (!body) return { text: '', imagesCount };

    let imageCounter = 0;
    function renderParagraph(p: Element): string {
      const segments: string[] = [];

      function walk(node: Node) {
        if (node.nodeType === 1) {
          const el = node as Element;
          if (el.localName === 'del') return;

          if (el.localName === 't') {
            const t = el.textContent ?? '';
            if (t) segments.push(t);
            return;
          }

          if (includeImages && (el.localName === 'drawing' || el.localName === 'pict')) {
            const docPr = el.getElementsByTagNameNS('*', 'docPr')[0];
            const docName = docPr?.getAttribute('name') || docPr?.getAttribute('descr') || '';

            const allDescendants = Array.from(el.getElementsByTagName('*'));
            for (const child of allDescendants) {
              const relId = child.getAttributeNS(R, 'embed')
                || child.getAttributeNS(R, 'id')
                || child.getAttribute('r:embed')
                || child.getAttribute('r:id')
                || child.getAttributeNS(R, 'link')
                || child.getAttribute('r:link');

              if (relId && imageCache.has(relId)) {
                const val = imageCache.get(relId)!;
                if (val === 'TOO_LARGE') {
                  segments.push(`\n[附图过大，已略过预览]\n`);
                } else if (val === 'LIMIT_REACHED') {
                  segments.push(`\n[附图数量已达上限]\n`);
                } else if (val === 'ERROR') {
                  segments.push(`\n[附图解析失败]\n`);
                } else {
                  imageCounter++;
                  const label = docName || `附图 ${imageCounter}`;
                  segments.push(`\n\n![${label}](${val})\n\n`);
                }
              }
            }
            return;
          }

          for (const child of Array.from(el.childNodes)) {
            walk(child);
          }
        }
      }

      for (const child of Array.from(p.childNodes)) {
        walk(child);
      }
      return segments.join('').trim();
    }

    let currentSectionNodes: Element[] = [];
    const sections: Array<{ title: string; paragraphs: string[] }> = [];

    const finishSection = async (sectPr: Element) => {
      const refs = Array.from(sectPr.getElementsByTagNameNS(W, 'headerReference'));
      const headerId = (refs.find(r => r.getAttributeNS(W, 'type') === 'default') ?? refs[0])?.getAttributeNS(R, 'id')
        || refs[0]?.getAttribute('r:id');
      const headerPath = headerId && rels.get(headerId);
      let title = '';
      if (headerPath) {
        const resolvedHeader = resolveWordTarget(headerPath);
        const headerXml = await (zip.file(resolvedHeader) || zip.file('word/' + headerPath.replace(/^\.\//, '')) || zip.file(headerPath))?.async('string');
        if (headerXml) {
          title = (parser.parseFromString(headerXml, 'application/xml').documentElement.textContent ?? '').replace(/\s/g, '');
        }
      }

      const paras: string[] = [];
      for (const node of currentSectionNodes) {
        if (node.localName === 'p') {
          const pText = renderParagraph(node);
          if (pText) paras.push(pText);
        } else {
          const ps = Array.from(node.getElementsByTagNameNS(W, 'p'));
          for (const p of ps) {
            const pText = renderParagraph(p);
            if (pText) paras.push(pText);
          }
        }
      }

      sections.push({ title, paragraphs: paras });
      currentSectionNodes = [];
    };

    for (const node of Array.from(body.childNodes).filter(n => n.nodeType === 1) as Element[]) {
      if (node.localName === 'sectPr') {
        await finishSection(node);
      } else {
        currentSectionNodes.push(node);
        const innerSect = node.getElementsByTagNameNS(W, 'sectPr')[0];
        if (innerSect) await finishSection(innerSect);
      }
    }
    if (currentSectionNodes.length > 0) {
      const paras: string[] = [];
      for (const node of currentSectionNodes) {
        if (node.localName === 'p') {
          const pText = renderParagraph(node);
          if (pText) paras.push(pText);
        } else {
          const ps = Array.from(node.getElementsByTagNameNS(W, 'p'));
          for (const p of ps) {
            const pText = renderParagraph(p);
            if (pText) paras.push(pText);
          }
        }
      }
      sections.push({ title: '', paragraphs: paras });
    }

    const allParas = sections.flatMap(s => s.paragraphs);
    const fullText = allParas.join('\n\n').trim();

    let parts: Array<{ code: string; name: string; content: string }> | undefined;
    const hasFivePartTitle = sections.some(s => FIVE_PARTS_SPEC.some(p => s.title.includes(p.name) || p.name.includes(s.title)));
    if (hasFivePartTitle) {
      parts = FIVE_PARTS_SPEC.map(p => {
        const matched = sections.find(s => s.title.includes(p.name) || p.name.includes(s.title));
        return {
          code: p.code,
          name: p.name,
          content: matched?.paragraphs.join('\n\n') || '（本部分无正文）',
        };
      });
    }

    return { text: fullText, parts, imagesCount };
  } catch {
    return { text: '', imagesCount: 0 };
  }
}

export async function extractDocxParagraphs(bytes: Buffer): Promise<string | undefined> {
  const res = await extractDocxContent(bytes);
  return res.text || undefined;
}
const sharedMaterial=(m:Material)=>({id:m.id,name:m.name,role:m.role,location:m.location,fileNo:m.fileNo,relativePath:m.relativePath?portable(m.relativePath):undefined});
export function safeName(value:string,max=36) {
  let s=Array.from(value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/\s+/g,' ').trim().replace(/[. ]+$/,'')).slice(0,max).join('')||'未命名';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))s='_'+s;
  return s;
}
// Keep generated process folders readable; the case identity is stored in 案件信息.json.
export function processFolder(c:Case,processId:string):string {
  const name=c.remote?.processes.find(p=>p.id===processId)?.name
    ??c.rounds.find(r=>r.id===processId)?.name
    ??({reply:'答复审查意见',correction:'补正',write:'专利撰写'} as Record<string,string>)[c.current?.kind??'']??'案件办理';
  const kind=/补正/.test(name)?'答复补正':/答复|审查意见|复审/.test(name)?'答复审查意见':/撰写|申请/.test(name)?'撰写':safeName(name,24);
  return `${kind}+${safeName(c.title,48)}`;
}
export function datedFolder(label:string,id:string,at=new Date().toISOString()):string {
  void at;
  return `${safeName(label,42)}__${safeName(id,8)}`;
}
export async function readJSON<T>(file:string,fallback:T):Promise<T> {
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw new Error('本地记录无法读取，原文件已保留。');}
}
export async function atomicWrite(file:string,data:string|Buffer) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,data,{mode:0o600,flag:'wx'});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
}
export async function atomicJSON(file:string,data:unknown) {
  await atomicWrite(file,JSON.stringify(data,null,2));
}
// Keep allocation bounded even if a selected file grows or is replaced after lstat.
export async function readBoundedFile(file:string,maxBytes:number,signal?:AbortSignal):Promise<Buffer>{
  const check=()=>{if(signal?.aborted)throw Object.assign(new Error('读取已取消。'),{name:'AbortError',code:'ABORT_ERR'});};
  check();
  const before=await fs.lstat(file);
  if(!before.isFile()||before.isSymbolicLink())throw new Error('材料必须是普通文件，不能是符号链接。');
  if(before.size>maxBytes)throw new Error(`材料超过 ${maxBytes/1024/1024}MB 上限，未读取。`);
  const handle=await fs.open(file,'r');
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw new Error('读取期间材料文件已变化。');
    const buffer=Buffer.alloc(Math.min(maxBytes,opened.size)+1);
    let size=0;
    while(size<buffer.length){
      check();
      const result=await handle.read(buffer,size,buffer.length-size,size);
      if(!result.bytesRead)break;
      size+=result.bytesRead;
    }
    check();
    if(size>maxBytes)throw new Error(`材料超过 ${maxBytes/1024/1024}MB 上限，未读取。`);
    const after=await handle.stat(),named=await fs.lstat(file);
    if(size!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||named.isSymbolicLink()||named.dev!==opened.dev||named.ino!==opened.ino)throw new Error('读取期间材料文件已变化。');
    return buffer.subarray(0,size);
  }finally{await handle.close();}
}
const inside=(root:string,target:string)=>{const rel=path.relative(root,target);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
export async function validateRoots(settings:Settings) {
  const roots=await Promise.all([settings.originalLibrary,settings.workRoot].map(async(p,i)=>{
    if(!p)return '';
    const label=i===0?'原始申请文件库':'总工作文件夹';
    try{const resolved=await fs.realpath(p);if(!(await fs.stat(resolved)).isDirectory())throw new Error(label+'必须选择文件夹。');return resolved;}
    catch(e){const code=(e as NodeJS.ErrnoException).code;if(code==='ENOENT')throw new Error(label+'不存在，请重新选择。');if(code==='EACCES'||code==='EPERM')throw new Error('无法访问'+label+'，请检查文件夹权限。');throw e;}
  }));
  if(roots[0]&&roots[1]&&roots[0]===roots[1])throw new Error('原始申请文件库与总工作文件夹不能选择同一个目录。');
  if(roots[0]&&roots[1]&&inside(roots[1],roots[0]))throw new Error('原始申请文件库不能位于总工作文件夹内，请另选工作文件夹。');
  return {originalLibrary:roots[0],workRoot:roots[1]};
}
// Every descendant is checked: a user-created symlink must not redirect managed writes.
export async function managedPath(root:string,relative:string,makeParents=false) {
  const absolute=path.resolve(root,relative);
  if(!inside(root,absolute)||path.isAbsolute(relative))throw new Error('文件不属于当前案件目录。');
  const parts=path.relative(root,absolute).split(path.sep).filter(Boolean);
  let cursor=root;
  for(let i=0;i<parts.length;i++){
    cursor=path.join(cursor,parts[i]);
    try{const s=await fs.lstat(cursor);if(s.isSymbolicLink())throw new Error('案件目录内不支持符号链接。');if(i<parts.length-1&&!s.isDirectory())throw new Error('目录位置被文件占用。');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(makeParents&&i<parts.length-1)await fs.mkdir(cursor,{mode:0o700});}
  }
  return absolute;
}
export class CaseFiles {
  settings:Settings; profile:string;
  private publishIndexes:boolean;
  private guard:()=>void;
  constructor(settings:Settings,profile:string,publishIndexes=true,guard=()=>{}){this.settings=settings;this.profile=profile;this.publishIndexes=publishIndexes;this.guard=guard;}
  async ensureCase(c:Case,publish=this.publishIndexes) {
    this.guard();
    const {workRoot}=await validateRoots(this.settings);
    if(!workRoot)throw new Error('请先在设置中选择总工作文件夹。');
    const relative=portable(c.directory??path.join('案件',this.profile,`${safeName(c.number,28)}_${safeName(c.title,36)}__${digest(c.id).slice(0,10)}`));
    const dir=await managedPath(workRoot,relative,true);
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const manifestPath=await managedPath(workRoot,path.join(relative,'案件信息.json'));
    const old=await readJSON<{id?:string;profile?:string}>(manifestPath,{});
    if(old.id&&(old.id!==c.id||old.profile!==this.profile))throw new Error('案件目录已归属其他案件或账号。');
    for(const name of ['00_原始申请','01_通知与材料','02_工作稿','03_定稿','04_内部说明']){
      const target=await managedPath(workRoot,path.join(relative,name));await fs.mkdir(target,{recursive:true,mode:0o700});
    }
    // Shared business index only. Conversations, jobs, model configuration and credentials stay local.
    this.guard();
    if(publish)await atomicJSON(manifestPath,{schema:2,id:c.id,profile:this.profile,number:c.number,title:c.title,type:c.type,deadline:c.deadline,applicationNumber:c.applicationNumber,companyName:c.companyName,caseRemark:c.caseRemark,caseInfoAt:c.caseInfoAt,remoteClosure:c.remoteClosure,officialOutcome:c.officialOutcome,remoteCaseId:c.remote?.caseId,current:c.current,source:c.source,remote:c.remote,materials:(c.materials??[]).map(sharedMaterial),rounds:c.rounds.map(r=>({id:r.id,name:r.name,priorArt:r.priorArt,materials:r.materials.map(sharedMaterial)}))});
    return relative;
  }
  async writeMaterial(c:Case,folder:string,fileNo:string,name:string,content:Buffer) {
    const directory=await this.ensureCase(c);
    const ext=path.extname(name).toLowerCase();
    if(!['.pdf','.docx','.doc','.png','.jpg','.jpeg','.tif','.tiff','.txt','.zip'].includes(ext))throw new Error('该附件类型暂不支持自动保存。');
    const prefix=content.subarray(0,8);
    if(!content.length||ext==='.pdf'&&!prefix.toString().startsWith('%PDF-')||['.docx','.zip'].includes(ext)&&!prefix.toString().startsWith('PK')||ext==='.doc'&&!prefix.equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])))throw new Error('附件内容与文件格式不符，未标为下载成功。');
    const file=`${safeName(path.basename(name,ext),48)}__${digest(fileNo).slice(0,8)}_${digest(content).slice(0,12)}${ext}`;
    const relative=path.join(folder,file),target=await managedPath(path.resolve(this.settings.workRoot!,directory),relative,true);
    this.guard();
    try{await fs.writeFile(target,content,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(digest(await fs.readFile(target))!==digest(content))throw new Error('已有同名文件不同，已保留原件。');}
    return {directory,relativePath:portable(relative),sha256:digest(content)};
  }
  async saveDraft(c:Case) {
    const directory=await this.ensureCase(c,false),root=path.resolve(this.settings.workRoot!,directory);
    const key=digest(c.current?.processId??c.current?.roundId??'local').slice(0,10);
    const text=c.localDraft??'';
    const file=await managedPath(root,`02_工作稿/${key}/工作稿.json`,true);
    let previous:Buffer|undefined;try{previous=await fs.readFile(file);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(previous&&digest(previous)!==c.sharedDraftHash)throw new Error('工作目录中的稿件已在其他位置更新。请先刷新读取工作目录，再编辑保存；本次未覆盖该稿件。');
    const payload={caseId:c.id,processId:c.current?.processId,text,versions:c.localVersions??[]};
    this.guard();
    await atomicJSON(file,payload);c.sharedDraftHash=digest(JSON.stringify(payload,null,2));
    for(const v of c.localVersions??[]){
      const target=await managedPath(root,`02_工作稿/${processFolder(c,v.processId??'local')}/${datedFolder('手工稿版本',v.id,v.at)}.txt`,true);
      try{await fs.writeFile(target,v.text,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(await fs.readFile(target,'utf8')!==v.text)throw new Error('已有稿件版本不能覆盖。');}
    }
    await this.ensureCase(c);
    return directory;
  }
  async writeFileGuide(c:Case) {
    const directory=await this.ensureCase(c,false),root=path.resolve(this.settings.workRoot!,directory);
    const escape=(value:string)=>value.replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]!));
    const rows:Array<{name:string;relative:string;at:number}>=[];
    const walk=async(relative:string,depth=0):Promise<void>=>{
      if(depth>7||rows.length>=3000)return;
      for(const entry of await fs.readdir(await managedPath(root,relative),{withFileTypes:true})){
        if(entry.isSymbolicLink())continue;
        const file=portable(path.join(relative,entry.name));
        if(entry.isDirectory())await walk(file,depth+1);
        else if(entry.isFile()&&/\.(docx?|pdf|txt|png|jpe?g)$/i.test(entry.name)){
          const stat=await fs.stat(await managedPath(root,file));rows.push({name:entry.name,relative:file,at:stat.mtimeMs});
        }
        if(rows.length>=3000)break;
      }
    };
    for(const folder of ['00_原始申请','01_通知与材料','02_工作稿','03_定稿'])await walk(folder);
    rows.sort((a,b)=>b.at-a.at);
    const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>案件工作文件目录</title><style>body{max-width:1100px;margin:32px auto;padding:0 24px;font:16px/1.8 system-ui;color:#222}li{margin:16px 0}small{display:block;color:#666;overflow-wrap:anywhere}</style><h1>'+escape(c.number+' '+c.title)+'</h1><p>工作文件按最近修改时间排列。文件夹按客户、专利名称、专利类型和办理业务整理；04_内部说明内的索引由程序维护。</p><ul>'+rows.map(row=>'<li><a href="'+row.relative.split('/').map(encodeURIComponent).join('/')+'">'+escape(row.name)+'</a><small>'+escape(row.relative)+'</small></li>').join('')+'</ul></html>';
    await fs.writeFile(await managedPath(root,'工作文件目录.html'),html,{mode:0o600});
  }
  async findOriginals(c:Case) {
    const {originalLibrary,workRoot}=await validateRoots(this.settings);if(!originalLibrary)return [];
    const norm=(s:string)=>s.normalize('NFKC').replace(/[\s._+－—-]/g,'').toLowerCase();
    const number=norm(c.applicationNumber||c.number),title=norm(c.title);const found:{id:string;name:string}[]=[];let scanned=0;
    async function walk(dir:string,depth:number){
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        if(++scanned>15000)throw new Error('原始库文件较多，请选择更具体的文件库目录。');
        if(entry.isSymbolicLink())continue;
        const full=path.join(dir,entry.name);
        if(workRoot&&inside(workRoot,full))continue;
        if(entry.isDirectory()&&depth<5)await walk(full,depth+1);
        if(entry.isFile()&&/\.(pdf|docx|doc)$/i.test(entry.name)&&!/(审查意见|通知书|答复|模板)/.test(entry.name)){
          const rel=path.relative(originalLibrary,full),stem=path.basename(entry.name,path.extname(entry.name)),n=norm(stem);
          const at=n.indexOf(number),numberMatches=number.length>=6&&at>=0&&!/\d/.test(n[at-1]??'')&&!/\d/.test(n[at+number.length]??'');
          // Existing application libraries commonly use client + exact invention title + type + author.
          const titleMatches=title.length>=5&&stem.normalize('NFKC').split('+').some(part=>norm(part)===title);
          if(numberMatches||titleMatches)found.push({id:rel,name:rel});
        }
      }
    }
    await walk(originalLibrary,0);return found;
  }
  async copyOriginal(c:Case,id:string) {
    const candidates=await this.findOriginals(c);
    if(!candidates.some(x=>x.id===id))throw new Error('该文件不属于本案匹配结果。');
    const source=await managedPath((await validateRoots(this.settings)).originalLibrary,id);
    return this.writeMaterial(c,'00_原始申请',id,path.basename(id),await fs.readFile(source));
  }
}
