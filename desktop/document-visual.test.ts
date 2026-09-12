import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { renderPdfPage } from './document-visual.ts';

function colorPdf(){
  const stream='0 0 1 rg 0 0 100 100 re f';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(out);out+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(out);
}
test('page image preserves RGB channels and reports actual page; cancel aborts isolated renderer',async()=>{
  const page=await renderPdfPage(colorPdf(),1);const im=jpeg.decode(page.bytes,{useTArray:true});
  const pixel=(Math.floor(im.height/2)*im.width+Math.floor(im.width/2))*4;
  assert.ok(im.data[pixel+2]>220);assert.ok(im.data[pixel]<30);
  assert.equal(page.page,1);assert.equal(page.pages,1);
  await assert.rejects(renderPdfPage(colorPdf(),2),/页码/);
  const abort=new AbortController();const pending=renderPdfPage(colorPdf(),1,abort.signal);abort.abort();await assert.rejects(pending,/取消/);
});
