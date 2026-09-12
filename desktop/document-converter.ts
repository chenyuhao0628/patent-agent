import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { digest } from './files.ts';
import { installedDocumentTool, ensureDocumentTool } from './managed-tools.ts';
import { localToolPermissions } from './agent-local-tools.ts';
let configuredPath:string|undefined;
let outputRoot:string|undefined;
let bundledRoot:string|undefined;
export function configureDocumentConverter(executable?:string,cacheRoot?:string,runtimeRoot?:string){configuredPath=executable;outputRoot=cacheRoot;bundledRoot=runtimeRoot;}
export function bundledDocumentConverter(root:string,platform=process.platform){return platform==='darwin'?path.join(root,'darwin-arm64/LibreOffice.app/Contents/MacOS/soffice'):platform==='win32'?path.join(root,'win32-x64/LibreOffice/program/soffice.exe'):undefined;}
export async function findDocumentConverter():Promise<string|undefined>{
  const candidates=[configuredPath,await installedDocumentTool(),bundledRoot?bundledDocumentConverter(bundledRoot):undefined,...(process.platform==='darwin'?['/Applications/LibreOffice.app/Contents/MacOS/soffice','/Applications/LibreOfficeDev.app/Contents/MacOS/soffice','/usr/bin/textutil']:process.platform==='win32'?[path.join(process.env.ProgramFiles||'C:\\Program Files','LibreOffice','program','soffice.exe'),path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','LibreOffice','program','soffice.exe')]:['/usr/bin/libreoffice','/usr/bin/soffice'])];
  for(const p of candidates){if(!p)continue;try{if((await fs.stat(p)).isFile())return p;}catch{/* next installed location */}}
}
export async function convertOldDoc(bytes:Buffer,signal?:AbortSignal):Promise<{bytes:Buffer;hash:string;file:string;engine:'system'|'libreoffice'}>{
  const conversionRoot=outputRoot||path.join(os.tmpdir(),'patent-document-conversions');
  const existing=await findDocumentConverter();
  if(!existing&&localToolPermissions().commandsEnabled)throw new Error('未发现默认 DOC 转换器。已开放任意命令，请先 discover_tools 检测 WPS 或轻量工具，用 prepare_material 取得副本后自行转换，再 read_work_file 带 sourceMaterialId 读取。不自动下载完整 Office；确需 LibreOffice 时仍可 ensure_tool。');
  const executable=existing||await ensureDocumentTool(signal);
  const native=executable==='/usr/bin/textutil';
  if(signal?.aborted)throw new Error('读取已取消。');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'patent-doc-'));
  const input=path.join(temp,'source.doc'),out=path.join(temp,'output'),profile=path.join(temp,'profile');
  try{
    await fs.mkdir(out);await fs.mkdir(path.join(profile,'user'),{recursive:true});await fs.writeFile(input,bytes,{mode:0o600});
    await fs.writeFile(path.join(profile,'user','registrymodifications.xcu'),'<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
    await new Promise<void>((resolve,reject)=>{
      const args=native?['-convert','docx','-noload','-output',path.join(out,'source.docx'),input]:[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--nologo','--nodefault','--norestore','--convert-to','docx:Office Open XML Text','--outdir',out,input];
      const child=spawn(executable,args,{stdio:'ignore',windowsHide:true,detached:process.platform!=='win32',env:Object.fromEntries(['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','LANG','FONTCONFIG_FILE','SAL_FONTPATH'].flatMap(k=>process.env[k]?[[k,process.env[k]!]]:[]))});
      let finished=false;
      const stop=()=>{try{if(process.platform==='win32'){if(child.pid)spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}else if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{/* process already gone */}};
      const done=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
      const abort=()=>{stop();done(new Error('读取已取消。'));};
      const timer=setTimeout(()=>{stop();done(new Error('旧 DOC 转换超时，请在设置中检查组件。'));},25_000);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      child.once('error',()=>done(new Error('文档转换组件无法启动。')));
      child.once('exit',code=>done(code===0?undefined:new Error('旧 DOC 转换未完成，请检查文件和组件。')));
    });
    if(signal?.aborted)throw new Error('读取已取消。');
    const converted=await fs.readFile(path.join(out,'source.docx')).catch(()=>{throw new Error('旧 DOC 转换未生成可读取的 DOCX，请检查原文件，或在文档工具中安装完整组件后重试。');});
    if(converted.length>20*1024*1024||converted.subarray(0,2).toString()!=='PK')throw new Error('转换结果不是可读取的 DOCX。');
    const sourceHash=digest(bytes),hash=digest(converted);
    const targetRoot=conversionRoot;
    await fs.mkdir(targetRoot,{recursive:true,mode:0o700});
    const file=path.join(targetRoot,`${sourceHash}-${hash.slice(0,12)}.docx`);
    try{await fs.writeFile(file,converted,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||digest(await fs.readFile(file))!==hash)throw e;}
    return {bytes:converted,hash,file,engine:native?'system':'libreoffice'};
  }finally{await fs.rm(temp,{recursive:true,force:true});}
}
