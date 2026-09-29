import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import JSZip from 'jszip';
import { exportStageDocx, readStageDocx } from './stage-docx.ts';
const root=path.resolve('resources/document-templates');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('stage DOCX renders semantic headings bold lists tables editable equations and embedded images from exact file',async()=>{
 const text=['# 构思方向','**核心结构**采用限位件。','- 第一方案','1. 第二方案','| 部件 | 作用 |','| --- | --- |','| 限位件 | 防止偏移 |','$x^2+1$',`![合成图](data:image/png;base64,${png})`].join(String.fromCharCode(10));
 const bytes=await exportStageDocx(root,'合成装置 · 方向构思',text);assert.equal(bytes.subarray(0,2).toString(),'PK');
 const zip=await JSZip.loadAsync(bytes),xml=await zip.file('word/document.xml')!.async('string');
 assert.match(xml,/<w:tbl>/);assert.ok(xml.includes('<w:b/>'));assert.match(xml,/Heading1/);assert.match(xml,/oMath/);assert.match(xml,/drawing/);assert.ok(!xml.includes('**核心结构**'));assert.ok(!xml.includes('# 构思方向'));
 const blocks=await readStageDocx(bytes);assert.ok(blocks.some(b=>b.kind==='table'));
 const paragraphs=blocks.filter(b=>b.kind==='paragraph');assert.ok(paragraphs.some(b=>b.heading===1&&b.content.some(s=>s.text==='构思方向')));
 assert.ok(paragraphs.some(b=>b.content.some(s=>s.bold&&s.text==='核心结构')));assert.ok(paragraphs.some(b=>b.content.some(s=>s.math)));assert.ok(paragraphs.some(b=>b.content.some(s=>s.image?.startsWith('data:image/png'))));
 assert.ok(paragraphs.filter(b=>!b.content.some(s=>s.text==='构思方向')).every(b=>!b.heading));
});
test('stage document fails explicitly on unsupported external images and broken tables',async()=>{
 await assert.rejects(exportStageDocx(root,'test','![secret](file:///private/test.png)'),/内嵌/);
 await assert.rejects(exportStageDocx(root,'test',['| a | b |','| --- | --- |','| only |'].join(String.fromCharCode(10))),/列数/);
});

test('stage document rejects invalid equations and unterminated fences rather than reporting a completed Word',async()=>{
 await assert.rejects(exportStageDocx(root,'test','$'+String.fromCharCode(92)+'notARealLatexCommand{x}$'),/公式/);
 await assert.rejects(exportStageDocx(root,'test',['```','正文'].join(String.fromCharCode(10))),/结束标记/);
 await assert.rejects(exportStageDocx(root,'test',['$$','x+1'].join(String.fromCharCode(10))),/结束标记/);
});
