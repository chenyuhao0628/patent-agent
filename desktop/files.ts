import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Case, Material, Settings } from '../src/domain/workflow.ts';

export const digest=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export const portable=(s:string)=>s.replaceAll('\\','/');
const sharedMaterial=(m:Material)=>({id:m.id,name:m.name,role:m.role,location:m.location,fileNo:m.fileNo,relativePath:m.relativePath?portable(m.relativePath):undefined});
export function safeName(value:string,max=36) {
  let s=Array.from(value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/\s+/g,' ').trim().replace(/[. ]+$/,'')).slice(0,max).join('')||'未命名';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))s='_'+s;
  return s;
}
export async function readJSON<T>(file:string,fallback:T):Promise<T> {
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw new Error('本地记录无法读取，原文件已保留。');}
}
export async function atomicJSON(file:string,data:unknown) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
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
  constructor(settings:Settings,profile:string){this.settings=settings;this.profile=profile;}
  async ensureCase(c:Case,publish=true) {
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
    if(publish)await atomicJSON(manifestPath,{schema:2,id:c.id,profile:this.profile,number:c.number,title:c.title,type:c.type,deadline:c.deadline,applicationNumber:c.applicationNumber,companyName:c.companyName,caseRemark:c.caseRemark,caseInfoAt:c.caseInfoAt,remoteClosure:c.remoteClosure,remoteCaseId:c.remote?.caseId,current:c.current,source:c.source,remote:c.remote,materials:(c.materials??[]).map(sharedMaterial),rounds:c.rounds.map(r=>({id:r.id,name:r.name,priorArt:r.priorArt,materials:r.materials.map(sharedMaterial)}))});
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
    await atomicJSON(file,payload);c.sharedDraftHash=digest(JSON.stringify(payload,null,2));
    for(const v of c.localVersions??[]){
      const target=await managedPath(root,`02_工作稿/${digest(v.processId??'local').slice(0,10)}/版本_${safeName(v.id)}.txt`,true);
      try{await fs.writeFile(target,v.text,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(await fs.readFile(target,'utf8')!==v.text)throw new Error('已有稿件版本不能覆盖。');}
    }
    await this.ensureCase(c);
    return directory;
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
