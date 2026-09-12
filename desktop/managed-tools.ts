import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const DOCUMENT_TOOL_VERSION='26.2.6';
const BASE='libreoffice/stable/26.2.6';
export const DOWNLOADS={
  darwin:{suffix:`${BASE}/mac/aarch64/LibreOffice_26.2.6_MacOS_aarch64.dmg`,sha256:'94bb3248df074c225490a8a6d1d9dc87c7d6783dbb7a8e9f0d0c3d94348552af',bytes:297798926,entry:'LibreOffice.app/Contents/MacOS/soffice'},
  win32:{suffix:`${BASE}/win/x86_64/LibreOffice_26.2.6_Win_x86-64.msi`,sha256:'f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660',bytes:373252096,entry:'LibreOffice/program/soffice.exe'},
};
type State={phase:'idle'|'downloading'|'installing'|'ready'|'error';downloaded:number;total:number;message:string};
let root='',state:State={phase:'idle',downloaded:0,total:0,message:''},pending:Promise<string>|undefined;
let automatic=true;
export function configureAutomaticInstall(enabled:boolean){automatic=enabled;}
export function configureManagedTools(directory:string){root=directory;}
export function managedToolsRoot(){return root;}
export function managedToolsStatus(){return {...state,root,version:DOCUMENT_TOOL_VERSION};}
export function managedDocumentPath(platform=process.platform){const row=DOWNLOADS[platform as keyof typeof DOWNLOADS];return root&&row?path.join(root,'libreoffice',DOCUMENT_TOOL_VERSION,platform, row.entry):undefined;}
export async function installedDocumentTool(){const target=managedDocumentPath();if(!target)return;try{const record=JSON.parse(await fs.readFile(path.join(root,'libreoffice',DOCUMENT_TOOL_VERSION,process.platform,'installation.json'),'utf8'));const stat=await fs.stat(target);if(record.version===DOCUMENT_TOOL_VERSION&&stat.isFile())return target;}catch{/* not installed */}}
export async function removeDocumentTool(){if(pending)throw new Error('组件安装正在进行，完成后再移除。');if(!root)throw new Error('工具目录尚未初始化。');await fs.rm(path.join(root,'libreoffice',DOCUMENT_TOOL_VERSION,process.platform),{recursive:true,force:true});state={phase:'idle',downloaded:0,total:0,message:'已移除应用下载的组件，本机原有工具及案件文件保留'};}
function run(executable:string,args:string[],signal?:AbortSignal,timeout=180_000):Promise<void>{return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new Error('工具安装已取消。'));
  const child=spawn(executable,args,{stdio:'ignore',windowsHide:true,detached:process.platform!=='win32'});let done=false;
  const kill=()=>{try{if(process.platform==='win32'){if(child.pid)spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}else if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{/* exited */}};
  const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
  const abort=()=>{kill();finish(new Error('工具安装已取消。'));};const timer=setTimeout(()=>{kill();finish(new Error('工具安装超时，可在文档工具中重试。'));},timeout);signal?.addEventListener('abort',abort,{once:true});
  child.once('error',()=>finish(new Error('系统无法启动文档组件安装工具。')));child.once('exit',code=>finish(code===0?undefined:new Error('文档组件安装失败，请在文档工具中重试。')));
});}
export async function verifyToolArchive(file:string,sha256:string,bytes:number){
  const stat=await fs.stat(file);if(stat.size!==bytes)throw new Error('工具下载不完整。');
  const hash=createHash('sha256');const handle=await fs.open(file);try{for await(const chunk of handle.createReadStream())hash.update(chunk);}finally{await handle.close();}
  if(hash.digest('hex')!==sha256)throw new Error('工具校验失败，未执行安装。');
}
async function download(row:typeof DOWNLOADS.darwin,target:string,signal?:AbortSignal){
  const urls=[`https://mirrors.nju.edu.cn/tdf/${row.suffix}`,`https://download.documentfoundation.org/${row.suffix}`];
  let last:unknown;
  for(const url of urls){
    if(signal?.aborted)throw new Error('工具安装已取消。');
    try{
      state={phase:'downloading',downloaded:0,total:row.bytes,message:'正在连接并下载已登记的 LibreOffice 文档组件'};
      const res=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(300_000)]):AbortSignal.timeout(300_000)});
      if(!res.ok||!res.body){await res.body?.cancel();throw new Error('组件下载暂不可用。');}
      const handle=await fs.open(target,'w',0o600);const reader=res.body.getReader();state={phase:'downloading',downloaded:0,total:row.bytes,message:'正在下载已登记的 LibreOffice 文档组件'};
      try{while(true){const {value,done}=await reader.read();if(done)break;state.downloaded+=value.length;if(state.downloaded>row.bytes)throw new Error('工具下载大小不符。');await handle.write(value);}}finally{await reader.cancel().catch(()=>{});await handle.close();}
      await verifyToolArchive(target,row.sha256,row.bytes);return;
    }catch(e){last=e;await fs.rm(target,{force:true});}
  }
  throw last;
}
export async function ensureDocumentTool(signal?:AbortSignal,manual=false):Promise<string>{
  const installed=await installedDocumentTool();if(installed){state={phase:'ready',downloaded:0,total:0,message:'完整 DOC 转换组件已安装'};return installed;}
  if(pending)return pending;
  if(!automatic&&!manual)throw new Error('自动安装工具已关闭。可在文档工具中安装完整转换组件。');
  if(!root)throw new Error('工具目录尚未初始化。');
  const row=DOWNLOADS[process.platform as keyof typeof DOWNLOADS];
  if(!row||process.platform==='darwin'&&process.arch!=='arm64'||process.platform==='win32'&&process.arch!=='x64')throw new Error('当前平台尚未登记可自动安装的转换组件。');
  pending=(async()=>{
    await fs.mkdir(root,{recursive:true,mode:0o700});const staging=await fs.mkdtemp(path.join(root,'.install-doc-'));const archive=path.join(staging,process.platform==='darwin'?'source.dmg':'source.msi'),payload=path.join(staging,'payload');const mount=path.join(staging,'mount');let mounted=false;
    try{
      await download(row,archive,signal);state={phase:'installing',downloaded:row.bytes,total:row.bytes,message:'校验通过，正在安装到应用工具目录'};await fs.mkdir(payload);
      if(process.platform==='darwin'){
        await fs.mkdir(mount);await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,archive],signal);mounted=true;
        await fs.cp(path.join(mount,'LibreOffice.app'),path.join(payload,'LibreOffice.app'),{recursive:true});
      }else{
        const systemRoot=process.env.SystemRoot||'C:\\Windows';
        await run(path.join(systemRoot,'System32/msiexec.exe'),['/a',archive,'/qn',`TARGETDIR=${payload}`],signal);
        // Administrative extraction keeps all components local; runtime DLLs live beside soffice.
        const system=path.join(payload,'System64'),program=path.join(payload,'LibreOffice/program');
        for(const file of await fs.readdir(system).catch(()=>[] as string[]))if(file.toLowerCase().endsWith('.dll'))await fs.copyFile(path.join(system,file),path.join(program,file));
        await fs.rm(system,{recursive:true,force:true});
      }
      if(signal?.aborted)throw new Error('工具安装已取消。');
      if(!(await fs.stat(path.join(payload,row.entry))).isFile())throw new Error('组件解包结果不完整。');
      await fs.writeFile(path.join(payload,'installation.json'),JSON.stringify({version:DOCUMENT_TOOL_VERSION,archiveSHA256:row.sha256,installedAt:new Date().toISOString()}));
      // The platform directory is the atomic installation unit.
      const target=path.join(root,'libreoffice',DOCUMENT_TOOL_VERSION,process.platform);await fs.mkdir(path.dirname(target),{recursive:true});await fs.rm(target,{recursive:true,force:true});await fs.rename(payload,target);
      state={phase:'ready',downloaded:0,total:0,message:'完整 DOC 转换组件已安装'};return managedDocumentPath()!;
    }catch(e){state={phase:'error',downloaded:0,total:0,message:(e as Error).message||'组件安装失败'};throw e;}
    finally{if(mounted)await run('/usr/bin/hdiutil',['detach',mount,'-force']).catch(()=>{});await fs.rm(staging,{recursive:true,force:true});}
  })().finally(()=>{pending=undefined;});return pending;
}
