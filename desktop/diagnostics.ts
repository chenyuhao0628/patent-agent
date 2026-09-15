import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifySessionError } from './agent-errors.ts';

const MAX_BYTES = 1024 * 1024;
const FILES = 5;
const WINDOW_MS = 10 * 60 * 1000;
// Only explicitly selected operational metadata is persisted. No messages, payloads or paths.
const numberKeys = new Set(['durationMs','bytes','statusCode','exitCode','promptChars','contextWindow','textChars','thinkingChars','line','column','count','eventLoopDelayMs','rssBytes']);
const tokenKeys = new Set(['operation','state','type','code','protocol','tool','step','signal','version','platform','model','errorType','errorCode','source']);
export function safeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (numberKeys.has(key) && typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (tokenKeys.has(key) && typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) && !/sk-|bearer|token|password|secret/i.test(value)) out[key] = value;
    else if (['runId','requestId','upstreamRequestId','discussionId','syncId','caseId','processId'].includes(key) && typeof value === 'string') out[key] = createHash('sha256').update(value).digest('hex').slice(0,16);
  }
  return out;
}
export function diagnosticError(error: unknown): Record<string, unknown> {
  const e = error as {name?:unknown;code?:unknown;message?:unknown;stack?:string;cause?:{code?:unknown}} | undefined;
  const location=typeof e?.stack==='string'?e.stack.match(/(?:main\.cjs|[a-z-]+\.ts):(\d+):(\d+)/):null;
  return safeMetadata({...(location?{line:Number(location[1]),column:Number(location[2])}:{}),type:e?.name,code: typeof e?.cause?.code === 'string' ? e.cause.code : typeof e?.code === 'string' ? e.code : classifySessionError({name:e?.name,message:e?.message}).code});
}
export class DiagnosticLog {
  private dropped = 0;
  private segmentStartedAt?:number;
  readonly directory: string;
  private maxBytes: number;
  private now: ()=>number;
  constructor(directory: string, maxBytes = MAX_BYTES, now = Date.now) {this.directory=directory;this.maxBytes=maxBytes;this.now=now;}
  private file(i: number) { return path.join(this.directory, `diagnostic-${i}.jsonl`); }
  write(component: string, event: string, metadata: Record<string,unknown> = {}) {
    try {
      fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
      const now = this.now();
      for(let i=0;i<FILES;i++) if(fs.existsSync(this.file(i)) && now-fs.statSync(this.file(i)).mtimeMs>30*60*1000) fs.unlinkSync(this.file(i));
      const line = JSON.stringify({at:new Date(now).toISOString(),component:component.replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,60),event:event.replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,80),...safeMetadata(metadata)})+'\n';
      if(Buffer.byteLength(line)>this.maxBytes){this.dropped++;return;}
      const exists=fs.existsSync(this.file(0));
      if(!exists)this.segmentStartedAt=now;
      else if(this.segmentStartedAt===undefined){
        // NTFS may preserve creation time after rename/recreate (file tunneling).
        // Recover our own timestamp, never use filesystem birthtime for rotation.
        const fd=fs.openSync(this.file(0),'r');try{const first=Buffer.alloc(4096);const n=fs.readSync(fd,first,0,first.length,0);this.segmentStartedAt=Date.parse(JSON.parse(first.subarray(0,n).toString('utf8').split('\n')[0]).at);}catch{this.segmentStartedAt=now;}finally{fs.closeSync(fd);}
        if(!Number.isFinite(this.segmentStartedAt))this.segmentStartedAt=now;
      }
      if(exists && (fs.statSync(this.file(0)).size+Buffer.byteLength(line)>this.maxBytes || now-this.segmentStartedAt!>5*60*1000)) {
        fs.rmSync(this.file(FILES-1),{force:true});
        for(let i=FILES-2;i>=0;i--) if(fs.existsSync(this.file(i))) fs.renameSync(this.file(i),this.file(i+1));
        this.segmentStartedAt=now;
      }
      fs.appendFileSync(this.file(0),line,{mode:0o600});
    } catch { this.dropped++; } // A disk failure must not fail a business operation.
  }
  snapshot(version: string) {
    const end=this.now(), records: Record<string,unknown>[]=[];
    for(let i=FILES-1;i>=0;i--) {
      let text: string;
      try{text=fs.readFileSync(this.file(i),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw new Error('诊断日志读取失败，请检查本机目录权限或磁盘空间。');}
      for(const line of text.split('\n')) {try {const record=JSON.parse(line);const at=Date.parse(record.at);if(at>=end-WINDOW_MS&&at<=end)records.push(record);}catch{/* ignore interrupted final line */}}
    }
    return {schemaVersion:1,appVersion:version,platform:process.platform,from:new Date(end-WINDOW_MS).toISOString(),to:new Date(end).toISOString(),maxStoredBytes:MAX_BYTES*FILES,droppedWrites:this.dropped,notice:'仅含已保留的最近十分钟运行元数据。高频日志可能提前覆盖；不含案件正文、密钥或完整模型输出。',records};
  }
}
const context=new AsyncLocalStorage<Record<string,unknown>>();
export function withDiagnostics<T>(metadata:Record<string,unknown>,fn:()=>T):T{return context.run(metadata,fn);}
let active: DiagnosticLog | undefined;
export function initializeDiagnostics(directory: string) { active = new DiagnosticLog(directory); return active; }
export function stopDiagnostics(){active=undefined;}
export function sampleRuntime(intervalMs=30000){
  let expected=Date.now()+intervalMs;
  const timer=setInterval(()=>{
    const now=Date.now();
    diagnostic('main','runtime_sample',{eventLoopDelayMs:Math.max(0,now-expected),rssBytes:process.memoryUsage().rss});
    expected=now+intervalMs;
  },intervalMs);
  timer.unref();
  return()=>clearInterval(timer);
}
export function diagnostic(component: string,event: string,metadata: Record<string,unknown> = {}) { active?.write(component,event,{...context.getStore(),...metadata}); }

export async function diagnosticStage<T>(component:string,step:string,metadata:Record<string,unknown>,run:()=>Promise<T>):Promise<T>{
  return withDiagnostics(metadata,async()=>{
    const started=Date.now();
    diagnostic(component,'stage_started',{step});
    try{const result=await run();diagnostic(component,'stage_finished',{step,state:'completed',durationMs:Date.now()-started});return result;}
    catch(error){diagnostic(component,'stage_finished',{step,state:'failed',durationMs:Date.now()-started,...diagnosticError(error)});throw error;}
  });
}

export function sessionErrorMetadata(value:unknown):Record<string,unknown>{
 const e=value&&typeof value==='object'?value as Record<string,any>:{};const data=e.data&&typeof e.data==='object'?e.data:{};
 return safeMetadata({code:classifySessionError(value).code,errorType:e.name??e.type,errorCode:e.code??data.code,statusCode:e.statusCode??data.statusCode});
}
