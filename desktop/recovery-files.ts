import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, managedPath, digest, readBoundedFile } from './files.ts';
import type { RecoveryFile } from '../src/domain/task-progress.ts';
const MAX_FILE=20*1024*1024,MAX_TOTAL=80*1024*1024,MAX_FILES=100;

/** Only this run's managed work files; never scan shared tools, downloads or case directories. */
export class RecoveryFiles {
  files:RecoveryFile[]=[]; notes:string[]=[];
  readonly outputs:string;readonly work:string;readonly identity:string;
  constructor(outputs:string,work:string,identity:string){this.outputs=outputs;this.work=work;this.identity=identity;}
  async restore(previous:string){
    try{
      await fs.mkdir(this.work,{recursive:true,mode:0o700});
      if((await fs.lstat(this.work)).isSymbolicLink())throw new Error('工作目录不能是符号链接');
      if((await fs.lstat(previous)).isSymbolicLink())throw new Error('清单目录不能是符号链接');
      const sourceWork=path.join(path.dirname(previous),'command-work');
      if((await fs.lstat(sourceWork)).isSymbolicLink())throw new Error('旧工作目录不能是符号链接');
      const bytes=await readBoundedFile(await managedPath(previous,'recovery-files.json'),200000);
      const manifest=JSON.parse(bytes.toString('utf8'));
      if(manifest.schema!==1||manifest.identity!==this.identity)return;
      if(!Array.isArray(manifest.files)||manifest.files.length>MAX_FILES||digest(JSON.stringify(manifest.files))!==manifest.hash)throw new Error('manifest mismatch');
      let total=0;
      for(const item of manifest.files){
        if(!item||typeof item.relativePath!=='string'||typeof item.hash!=='string'||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>MAX_FILE)throw new Error('invalid file');
        total+=item.bytes;if(total>MAX_TOTAL)throw new Error('too large');
        const entry:RecoveryFile={relativePath:item.relativePath,hash:item.hash,bytes:item.bytes,state:'missing'};
        try{
          const source=await managedPath(sourceWork,item.relativePath);
          const content=await readBoundedFile(source,MAX_FILE);
          if(content.length!==item.bytes||digest(content)!==item.hash){entry.state='changed';}
          else{const target=await managedPath(this.work,item.relativePath,true);await fs.writeFile(target,content,{flag:'wx',mode:0o600});entry.state='reused';}
        }catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')entry.state='changed';}
        this.files.push(entry);
      }
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.notes.push('旧工作文件清单无法完整核验；仅复用已逐项核对的文件，其他文件保留原位。');}
  }
  async capture(){
    const saved:RecoveryFile[]=[];let total=0,visited=0,omitted=false;
    const walk=async(relative:string,depth:number):Promise<void>=>{
      if(depth>12||visited>500||saved.length>=MAX_FILES){omitted=true;return;}
      let dir:string;try{dir=relative?await managedPath(this.work,relative):this.work;const stat=await fs.lstat(dir);if(stat.isSymbolicLink()||!stat.isDirectory())return;}catch{return;}
      for(const item of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        if(++visited>500||saved.length>=MAX_FILES){omitted=true;break;}
        if(item.name==='.home'||item.name==='.tmp'||item.name.startsWith('.office-command-'))continue;
        const rel=relative?relative+'/'+item.name:item.name;
        if(item.isSymbolicLink()){omitted=true;continue;}
        if(item.isDirectory()){await walk(rel,depth+1);continue;}
        if(!item.isFile())continue;
        try{
          const file=await managedPath(this.work,rel),stat=await fs.lstat(file);
          if(stat.size>MAX_FILE||total+stat.size>MAX_TOTAL){omitted=true;continue;}
          const bytes=await readBoundedFile(file,MAX_FILE);total+=bytes.length;
          const hash=digest(bytes),old=this.files.find(f=>f.relativePath===rel&&f.hash===hash);
          saved.push({relativePath:rel,hash,bytes:bytes.length,state:old?.state==='reused'?'reused':'saved'});
        }catch{/* A changing file is not a verified reusable output. */}
      }
    };
    await walk('',0);
    const retained=this.files.filter(f=>['changed','missing'].includes(f.state)&&!saved.some(s=>s.relativePath===f.relativePath));
    this.files=[...saved,...retained];
    const note='部分工作文件因链接、范围或大小限制未纳入复用清单，原文件保留。';
    if(omitted&&!this.notes.includes(note))this.notes.push(note);
    await atomicJSON(await managedPath(this.outputs,'recovery-files.json',true),{schema:1,identity:this.identity,hash:digest(JSON.stringify(saved)),files:saved});
  }
}
