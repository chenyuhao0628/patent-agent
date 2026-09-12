import { Worker } from 'node:worker_threads';
import path from 'node:path';
export type PageImage={bytes:Buffer;page:number;pages:number;width:number;height:number};
export async function renderPdfPage(bytes:Buffer,page:number,signal?:AbortSignal):Promise<PageImage>{
  if(signal?.aborted)throw new Error('读取已取消。');
  const workerPath=typeof __dirname==='string'?path.join(__dirname,'document-visual-worker.cjs').replace(`.asar${path.sep}`,`.asar.unpacked${path.sep}`):new URL('./document-visual-worker.ts',import.meta.url);
  const worker=new Worker(workerPath,{workerData:{bytes,page},execArgv:typeof __dirname==='string'?[]:['--experimental-strip-types'],resourceLimits:{maxOldGenerationSizeMb:192}});
  return new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(error?:Error,result?:PageImage)=>{if(finished)return;finished=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result!);};
    const abort=()=>finish(new Error('读取已取消。'));
    const timeout=setTimeout(()=>finish(new Error('页面渲染超时，请分批读取。')),25_000);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    worker.once('message',r=>r.ok?finish(undefined,{...r,bytes:Buffer.from(r.bytes)}):finish(new Error(r.error)));
    worker.once('error',e=>finish(new Error('页面渲染失败：'+e.message)));
    worker.once('exit',code=>{if(!finished)finish(new Error('页面渲染进程退出（'+code+'）。'));});
  });
}
