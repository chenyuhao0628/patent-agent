import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { exportReplyDocx, replyParagraphs } from './document-export.ts';
const root = path.resolve('resources/document-templates');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
test('reply uses chosen template, preserves opaque parts and only exact finalized text', async () => {
  const text = '尊敬的审查员：\n本次为隔离版式测试。\n一、关于清楚性问题\n测试正文。\n二、综上\n测试总结。\n三、结语\n测试结束语。\n此致\n敬礼';
  const result = await JSZip.loadAsync(await exportReplyDocx(root, text, 2));
  const source = await JSZip.loadAsync(await fs.readFile(path.join(root, 'reply.docx')));
  for (const name of Object.keys(source.files).filter(n => n !== 'word/document.xml' && !source.files[n].dir)) assert.deepEqual(await result.file(name)!.async('nodebuffer'), await source.file(name)!.async('nodebuffer'), name);
  const xml = await result.file('word/document.xml')!.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const lines = Array.from(doc.getElementsByTagNameNS(W, 'p')).map(p => p.textContent);
  assert.deepEqual(lines, replyParagraphs(text, 2).map(p => p.text));
  assert.doesNotMatch(xml, /裁切|202521903356|重庆秋泽|\{\{/);
  assert.equal(doc.getElementsByTagNameNS(W, 'sectPr').length, 1);
  assert.ok(lines.includes('一、关于清楚性问题'));
  assert.ok(!lines.some(p => p?.includes('权利要求修改说明')));
});

test('standalone claim and description keep selected headers, inherited page footer and paragraph roles',async()=>{
 const {exportApplicationParts,exportNoteDocx}=await import('./document-export.ts');
 const {applicationSections}=await import('./application-diff.ts');
 const parts={CLAIMS:'1. 一种定位装置。\n2. 根据权利要求1所述的定位装置。',DESCRIPTION:'一种定位装置\n技术领域\n本申请涉及定位装置。'};
 const bytes=await exportApplicationParts(root,parts),z=await JSZip.loadAsync(bytes),xml=await z.file('word/document.xml')!.async('string');
 const d=new DOMParser().parseFromString(xml,'application/xml'),ps=Array.from(d.getElementsByTagNameNS(W,'p'));
 const title=ps.find(p=>p.textContent==='一种定位装置')!,body=ps.find(p=>p.textContent==='本申请涉及定位装置。')!;
 assert.equal(title.getElementsByTagNameNS(W,'jc')[0].getAttributeNS(W,'val'),'center');
 assert.equal(body.getElementsByTagNameNS(W,'jc').length,0);assert.equal(body.getElementsByTagNameNS(W,'b').length,0);
 assert.ok(d.getElementsByTagNameNS(W,'footerReference').length);assert.equal(d.getElementsByTagNameNS(W,'sectPr').length,2);
 assert.doesNotMatch(xml,/\{\{|可伸缩|喷淋头/);
 const sections=await applicationSections(bytes);assert.equal(sections.size,2);assert.deepEqual([...sections.values()].map(v=>v.text),Object.values(parts));
 const source=await JSZip.loadAsync(await fs.readFile(path.join(root,'application.docx')));for(const name of Object.keys(source.files).filter(n=>n!=='word/document.xml'&&!source.files[n].dir))assert.deepEqual(await z.file(name)!.async('nodebuffer'),await source.file(name)!.async('nodebuffer'));
 const correction=await JSZip.loadAsync(await exportNoteDocx(root,'补正说明','针对通知补正如下。'));const cx=await correction.file('word/document.xml')!.async('string');assert.match(cx,/补正说明/);assert.doesNotMatch(cx,/第1次意见陈述书/);
});

test('application exports discard whitespace-only source lines while preserving content and section breaks',async()=>{
 const {exportApplicationParts,exportApplicationText}=await import('./document-export.ts');
 const parts={CLAIMS:'\n\n1. 装置。\n \n\t\n2. 根据权利要求1所述的装置。\n',DESCRIPTION:'\n一种装置\n\n技术领域\n\n涉及装置。\n'};
 for(const bytes of [await exportApplicationParts(root,parts),await exportApplicationText(root,{...parts,ABSTRACT:'\n合成摘要。\n\n',ABSTRACT_IMAGE:'合成图1',DRAWINGS:'合成图1'})]){
  const z=await JSZip.loadAsync(bytes),xml=await z.file('word/document.xml')!.async('string');
  const d=new DOMParser().parseFromString(xml,'application/xml');
  const paragraphs=Array.from(d.getElementsByTagNameNS(W,'p'));
  assert(paragraphs.some(p=>p.textContent==='涉及装置。'));
  assert(paragraphs.every(p=>p.textContent?.trim()||p.getElementsByTagNameNS(W,'sectPr').length));
 }
});

test('document export converts LaTeX formulas into Word native m:oMath nodes', async () => {
  const { exportReplyDocx } = await import('./document-export.ts');
  const text = '意见陈述书\n针对通知书陈述意见如下：\n根据压力计算公式 $P = \\frac{F}{S}$，可知压强与受力面积成反比。\n独立特征表达式如下：\n$$x^2 + y^2 = r^2$$\n综上所述，具备创造性。\n此致';
  const bytes = await exportReplyDocx(root, text, 1);
  const z = await JSZip.loadAsync(bytes);
  const xml = await z.file('word/document.xml')!.async('string');
  assert.match(xml, /<m:oMath/);
  assert.match(xml, /<m:f>/);
  assert.match(xml, /<m:num>/);
  assert.match(xml, /<m:den>/);
  assert.match(xml, /<m:sSup>/);
});
