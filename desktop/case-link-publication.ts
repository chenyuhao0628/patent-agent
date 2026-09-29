import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicCreate, atomicWrite, digest, managedPath, readBoundedFile } from './files.ts';

export const caseLinkMarker='.case-link-pending.json';
export type CaseLinkPublication={
  schema:1;published?:true;profile:string;root:string;id:string;localId:string;remoteId:string;linkedAt:string;
  entries:Array<{relative:string;beforeHash:string|null;content:string}>;
};
export async function fileHash(file:string):Promise<string|null>{
  try{return digest(await readBoundedFile(file,20*1024*1024));}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
export async function publicationMarker(p:CaseLinkPublication){
  return managedPath(p.root,path.join('案件',p.profile,caseLinkMarker),true);
}
export async function claimPublication(p:CaseLinkPublication,guard:()=>void){
  const marker=await publicationMarker(p),bytes=Buffer.from(JSON.stringify({id:p.id,profile:p.profile}));
  guard();
  try{await atomicCreate(marker,bytes,guard);}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||await fileHash(marker)!==digest(bytes))throw new Error('工作目录存在尚未完成的案件关联，请在发起关联的电脑上恢复后重试。');}
}
export async function releasePublication(p:CaseLinkPublication,guard:()=>void){
  const marker=await publicationMarker(p),hash=await fileHash(marker);guard();
  if(hash===null)return;
  if(hash!==digest(JSON.stringify({id:p.id,profile:p.profile})))throw new Error('案件关联发布标识已变化，未删除其他关联记录。');
  await fs.unlink(marker);
}
export async function publishCaseLink(p:CaseLinkPublication,guard:()=>void,afterEntry?:(index:number)=>Promise<void>){
  await claimPublication(p,guard);
  // Validate every destination before publishing any of them; retries accept only original or exact intended bytes.
  const files=[];
  for(const entry of p.entries){
    const file=await managedPath(p.root,entry.relative,true),hash=await fileHash(file);guard();
    if(hash!==entry.beforeHash&&hash!==digest(entry.content))throw new Error('关联目标文件已在其他位置修改；原文件和关联恢复记录均已保留。');
    files.push(file);
  }
  for(let i=0;i<p.entries.length;i++){
    const entry=p.entries[i],file=files[i],hash=await fileHash(file);guard();
    if(hash!==digest(entry.content)){
      if(hash!==entry.beforeHash)throw new Error('关联目标文件已变化，未覆盖。');
      if(hash===null)await atomicCreate(file,Buffer.from(entry.content),guard);
      else await atomicWrite(file,Buffer.from(entry.content),guard);
    }
    await afterEntry?.(i);
  }
}
export function parsePublication(value:unknown,profile:string,root:string):CaseLinkPublication{
  const p=value as CaseLinkPublication;
  if(!p||(p.published!==undefined&&p.published!==true)||p.schema!==1||p.profile!==profile||p.root!==root||!p.id||!p.localId||!p.remoteId||p.localId===p.remoteId||!Number.isFinite(Date.parse(p.linkedAt))||!Array.isArray(p.entries)||p.entries.length<3)throw new Error('案件关联恢复记录不完整或账号目录不匹配。');
  if(p.entries.some(e=>!e||typeof e.relative!=='string'||typeof e.content!=='string'||(e.beforeHash!==null&&(typeof e.beforeHash!=='string'||!/^[a-f0-9]{64}$/.test(e.beforeHash)))||!e.relative.startsWith('案件/'+profile+'/')||path.isAbsolute(e.relative)||e.relative.split(/[\\/]/).includes('..')))throw new Error('案件关联恢复记录包含无效文件路径或摘要。');
  if(new Set(p.entries.map(e=>e.relative)).size!==p.entries.length)throw new Error('案件关联恢复记录包含重复文件。');
  return p;
}
