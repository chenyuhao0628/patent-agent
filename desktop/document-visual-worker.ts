import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import jpeg from 'jpeg-js';

async function main(){
try {
  const wasmPath=typeof __dirname==='string'?path.join(__dirname,'pdfium.wasm'):createRequire(import.meta.url).resolve('@hyzyla/pdfium/pdfium.wasm');
  const wasm=fs.readFileSync(wasmPath);
  const library=await PDFiumLibrary.init({wasmBinary:Uint8Array.from(wasm).buffer});
  try{
    const doc=await library.loadDocument(Uint8Array.from(workerData.bytes));
    try{
      const count=doc.getPageCount(),pageNo=workerData.page;
      if(count>2000||!Number.isInteger(pageNo)||pageNo<1||pageNo>count)throw new Error('PDF 页码超出范围。');
      const page=doc.getPage(pageNo-1),size=page.getOriginalSize();
      if(!(size.originalWidth>0&&size.originalHeight>0)||size.originalWidth>20000||size.originalHeight>20000)throw new Error('PDF 页面尺寸异常。');
      const bitmap=await page.render({scale:Math.min(2.8,1800/Math.max(size.originalWidth,size.originalHeight)),render:'bitmap',renderFormFields:true});
      if(bitmap.width*bitmap.height>4_000_000)throw new Error('PDF 页图过大。');
      const rgba=Buffer.from(bitmap.data);
      // This wrapper sets FPDF_REVERSE_BYTE_ORDER, so its returned bitmap is already RGBA.
      let encoded:Buffer|undefined;
      for(const quality of [88,72,55,40]){const out=jpeg.encode({data:rgba,width:bitmap.width,height:bitmap.height},quality).data;if(out.length<=600*1024){encoded=Buffer.from(out);break;}}
      if(!encoded)throw new Error('该页图像超过返回容量，请拆分页面后再读取。');
      parentPort!.postMessage({ok:true,bytes:encoded,page:pageNo,pages:count,width:bitmap.width,height:bitmap.height});
    }finally{doc.destroy();}
  }finally{library.destroy();}
}catch(e){parentPort!.postMessage({ok:false,error:(e as Error).message||'页面视觉渲染失败。'});}

}
void main();
