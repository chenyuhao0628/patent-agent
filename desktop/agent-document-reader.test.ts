import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { digest } from './files.ts';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createReadMaterialCallback,
  inspectZipLimits,
  MAX_IMAGE_BYTES,
  MAX_MATERIAL_BYTES,
  MAX_PDF_PAGES_PER_READ,
  MAX_TEXT_CHARS,
  MAX_TEXT_LINES,
  readFrozenMaterial,
  takeCompleteLines,
} from './agent-document-reader.ts';
import { MCP_RESPONSE_MAX_BYTES } from './agent-broker.ts';
import type { FrozenMaterial, McpContent } from './agent-runner.ts';

function asText(contents: McpContent[]) {
  if (contents[0]?.type !== 'text') throw new Error('expected text');
  return contents[0];
}

function zipStore(files: Array<[string, string | Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of files) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    locals.push(Buffer.concat([local, data]));
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  return zipStore([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rels],
    ['word/document.xml', document],
  ]);
}

function makePdf(pageTexts: string[], width = 612): Buffer {
  const objects: string[] = [];
  const add = (s: string) => {
    objects.push(s);
    return objects.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pageTexts.map((_, i) => `${3 + i} 0 R`).join(' ');
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`);
  for (let i = 0; i < pageTexts.length; i++) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /Contents ${3 + pageTexts.length + i} 0 R /Resources << /Font << /F1 ${3 + pageTexts.length * 2} 0 R >> >> >>`);
  }
  for (const text of pageTexts) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += `${xref}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body);
}

function makeScanPdf(): Buffer {
  const objects: string[] = [];
  const add = (s: string) => {
    objects.push(s);
    return objects.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>');
  add('<< /Length 18 >>\nstream\nq 10 0 0 10 0 0 cm /Im1 Do Q\nendstream');
  add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream');
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += `${xref}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function frozen(dir: string, name: string, data: Buffer, id = 'm1'): Promise<FrozenMaterial> {
  const absoluteSnapshotPath = path.join(dir, name);
  await fs.writeFile(absoluteSnapshotPath, data);
  return {
    id,
    name,
    role: '当前通知',
    relativePath: name,
    absoluteSnapshotPath,
    hash: digest(data),
  };
}

test('TXT/MD/JSON 按行读取并报告未读范围', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-txt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const text = ['第一行中文', '第二行', '第三行'].join('\n');
  const material = await frozen(dir, 'note.txt', Buffer.from(text));
  const all = await readFrozenMaterial({ material });
  const allText = asText(all);
  assert.match(allText.text, /第一行中文/);
  assert.match(allText.text, /format: text/);
  assert.equal(allText.startLine, 1);
  assert.equal(allText.endLine, 3);
  const ranged = await readFrozenMaterial({ material, range: { startLine: 2, endLine: 2 } });
  const rangedText = asText(ranged);
  assert.match(rangedText.text, /第二行/);
  assert.equal(rangedText.text.includes('第一行中文'), false);
  assert.equal(rangedText.startLine, 2);
  assert.equal(rangedText.endLine, 2);
  assert.match(rangedText.text, /startLine=3/);
  const md = await readFrozenMaterial({ material: await frozen(dir, 'note.md', Buffer.from('# 标题\n第二段'), 'md') });
  if (md[0]?.type !== 'text') throw new Error('expected text');
  assert.match(md[0].text, /# 标题/);
  const json = await readFrozenMaterial({ material: await frozen(dir, 'meta.json', Buffer.from('{"意见":"中文"}'), 'js') });
  if (json[0]?.type !== 'text') throw new Error('expected text');
  assert.match(json[0].text, /"意见"/);
  await assert.rejects(readFrozenMaterial({ material, range: { startLine: 99 } }), /没有可读取文本/);
  await assert.rejects(readFrozenMaterial({ material: await frozen(dir, 'empty.txt', Buffer.from(' \n '), 'empty') }), /没有可读取文本/);
});

test('DOCX 提取中文段落，不把二进制当正文', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-docx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const data = makeDocx(['第一段：审查意见通知书', '第二段：权利要求1不具备创造性。']);
  const material = await frozen(dir, '意见.docx', data);
  const contents = await readFrozenMaterial({ material });
  const text = asText(contents);
  assert.match(text.text, /审查意见通知书/);
  assert.match(text.text, /权利要求1/);
  assert.match(text.text, /format: docx/);
  assert.match(text.text, /未还原版式/);
  assert.equal(text.startLine, 1);
  assert.ok((text.endLine ?? 0) >= 2);
  const utf8 = data.toString('utf8');
  assert.equal(utf8.includes('PK'), true);
  assert.equal(text.text.includes('PK\u0003\u0004') || text.text.includes('<w:p>'), false);
});

test('PDF 至少两页并保留页码，range 可继续读', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-pdf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const data = makePdf(['PAGE_ONE notice', 'PAGE_TWO claims']);
  const material = await frozen(dir, '通知.pdf', data);
  const all = await readFrozenMaterial({ material });
  const allText = asText(all);
  assert.match(allText.text, /pages: 2/);
  assert.match(allText.text, /rangeUnit: page/);
  assert.match(allText.text, /第1页/);
  assert.match(allText.text, /PAGE_ONE/);
  assert.match(allText.text, /第2页/);
  assert.match(allText.text, /PAGE_TWO/);
  assert.equal(allText.startLine, 1);
  assert.equal(allText.endLine, 2);
  const page1 = await readFrozenMaterial({ material, range: { startLine: 1, endLine: 1 } });
  const page1Text = asText(page1);
  assert.match(page1Text.text, /PAGE_ONE/);
  assert.equal(page1Text.text.includes('PAGE_TWO'), false);
  assert.equal(page1Text.startLine, 1);
  assert.equal(page1Text.endLine, 1);
  assert.match(page1Text.text, /startLine=2/);
  assert.match(page1Text.text, /页码/);
});

test('扫描 PDF 空文字层不得伪报已完整读', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-scan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const material = await frozen(dir, 'scan.pdf', makeScanPdf());
  const result=await readFrozenMaterial({material});
  assert.ok(result.some(c=>c.type==='image'));
  assert.ok(result.some(c=>c.type==='text'&&c.text.includes('pdf-page-image')));
});

test('旧 DOC/OLE 与非 DOCX ZIP 拒绝说明', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-ole-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 1)]);
  await assert.rejects(readFrozenMaterial({ material: await frozen(dir, 'old.doc', ole) }), /DOC.*转换|转换组件/);
  const zip = zipStore([['readme.txt', 'not a document']]);
  await assert.rejects(readFrozenMaterial({ material: await frozen(dir, 'x.zip', zip) }), /不是 DOCX/);
});

test('PNG/JPEG 小图返回 MCP image；超大文件拒绝', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-img-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54,
    0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01,
    0x00, 0x05, 0xfe, 0xd4, 0xef,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const img = await readFrozenMaterial({ material: await frozen(dir, 'a.png', png) });
  assert.equal(img.some(item => item.type === 'image' && item.mimeType === 'image/png'), true);
  assert.match(img[0]?.type === 'text' ? img[0].text : '', /未做文字识别/);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const jpg = await readFrozenMaterial({ material: await frozen(dir, 'b.jpg', jpeg) });
  assert.equal(jpg.some(item => item.type === 'image' && item.mimeType === 'image/jpeg'), true);
  const hugeImg = Buffer.concat([png.subarray(0, 8), Buffer.alloc(MAX_IMAGE_BYTES + 1, 1)]);
  await assert.rejects(readFrozenMaterial({ material: await frozen(dir, 'big.png', hugeImg) }), /图片超过/);
  const huge = await frozen(dir, 'big.txt', Buffer.alloc(MAX_MATERIAL_BYTES + 1, 0x61));
  await assert.rejects(readFrozenMaterial({ material: huge }), /上限/);
});

test('ZIP 解压上限与符号链接/哈希/中止', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-guard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bomb = zipStore([['word/document.xml', 'x']]);
  const patched = Buffer.from(bomb);
  const eocd = patched.length - 22;
  const cdOffset = patched.readUInt32LE(eocd + 16);
  patched.writeUInt32LE(0xffffffff, cdOffset + 24);
  assert.throws(() => inspectZipLimits(patched), /ZIP64|过大/);

  const data = Buffer.from('hello');
  const real = path.join(dir, 'real.txt');
  await fs.writeFile(real, data);
  const link = path.join(dir, 'link.txt');
  await fs.symlink(real, link);
  await assert.rejects(readFrozenMaterial({
    material: { id: 'l', name: 'link.txt', role: 'x', relativePath: 'link.txt', absoluteSnapshotPath: link, hash: digest(data) },
  }), /符号链接/);

  const material = await frozen(dir, 'hash.txt', data);
  material.hash = 'deadbeef';
  await assert.rejects(readFrozenMaterial({ material }), /哈希/);

  const ok = await frozen(dir, 'abort.txt', data, 'ab');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readFrozenMaterial({ material: ok, signal: controller.signal }), /取消/);

  const live = new AbortController();
  const pending = readFrozenMaterial({ material: await frozen(dir, 'slow.docx', makeDocx(['段落'])), signal: live.signal });
  live.abort();
  await assert.rejects(pending, /取消/);

  const closed = new AbortController();
  closed.abort();
  const callback = createReadMaterialCallback(closed.signal);
  await assert.rejects(callback({ material: await frozen(dir, 'cb.txt', Buffer.from('x'), 'cb') }), /取消/);
});

test('5000 行与 40k 字符按真正返回的完整行计 endLine，不跳过余部', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-clip-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const many = Array.from({ length: 5000 }, (_, i) => `行${String(i + 1).padStart(4, '0')}`);
  const manyMat = await frozen(dir, 'many.txt', Buffer.from(many.join('\n')));
  const first = asText(await readFrozenMaterial({ material: manyMat }));
  assert.equal(first.startLine, 1);
  assert.equal(first.endLine, MAX_TEXT_LINES);
  assert.match(first.text, /行1000/);
  assert.equal(first.text.includes('行1001'), false);
  assert.equal(first.text.includes('行5000'), false);
  assert.match(first.text, /startLine=1001/);
  const expected = takeCompleteLines(many, 1, 5000);
  assert.equal(expected.endLine, MAX_TEXT_LINES);
  const second = asText(await readFrozenMaterial({ material: manyMat, range: { startLine: (first.endLine ?? 0) + 1 } }));
  assert.equal(second.startLine, MAX_TEXT_LINES + 1);
  assert.equal(second.endLine, MAX_TEXT_LINES * 2);
  assert.match(second.text, /行1001/);
  assert.equal(second.text.includes('行1000'), false);

  const wide = Array.from({ length: 800 }, () => '字'.repeat(80));
  const helper = takeCompleteLines(wide, 1, 800);
  assert.ok(helper.endLine < 800);
  assert.ok(helper.text.length <= MAX_TEXT_CHARS);
  assert.equal(helper.text.split('\n').every(line => line.length === 80), true);
  const wideMat = await frozen(dir, 'wide.txt', Buffer.from(wide.join('\n')));
  const clipped = asText(await readFrozenMaterial({ material: wideMat }));
  assert.equal(clipped.startLine, 1);
  assert.equal(clipped.endLine, helper.endLine);
  assert.match(clipped.text, new RegExp(`startLine=${(helper.endLine ?? 0) + 1}`));
  const continued = asText(await readFrozenMaterial({ material: wideMat, range: { startLine: (clipped.endLine ?? 0) + 1 } }));
  assert.equal(continued.startLine, (clipped.endLine ?? 0) + 1);
  assert.notEqual(continued.startLine, clipped.startLine);

  const long = await frozen(dir, 'long.txt', Buffer.from('x'.repeat(MAX_TEXT_CHARS + 1)));
  await assert.rejects(readFrozenMaterial({ material: long }), /单行超过/);
  await assert.rejects(readFrozenMaterial({ material: long, range: { startLine: 1 } }), /单行超过/);
});

test('PDF 按页续读；空页转视觉；超长单页拒绝；abort 取消 loading', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-pdf-range-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manyPages = Array.from({ length: MAX_PDF_PAGES_PER_READ + 5 }, (_, i) => `PAGE_${String(i + 1).padStart(2, '0')}`);
  const manyMat = await frozen(dir, 'many.pdf', makePdf(manyPages));
  const windowed = asText(await readFrozenMaterial({ material: manyMat }));
  assert.equal(windowed.startLine, 1);
  assert.equal(windowed.endLine, MAX_PDF_PAGES_PER_READ);
  assert.match(windowed.text, /PAGE_20/);
  assert.equal(windowed.text.includes('PAGE_21'), false);
  assert.match(windowed.text, /rangeUnit: page/);
  assert.match(windowed.text, /startLine=21/);
  const rest = asText(await readFrozenMaterial({ material: manyMat, range: { startLine: MAX_PDF_PAGES_PER_READ + 1 } }));
  assert.equal(rest.startLine, MAX_PDF_PAGES_PER_READ + 1);
  assert.match(rest.text, /PAGE_21/);

  const mixed = await frozen(dir, 'mixed.pdf', makePdf(['PAGE_ONE notice', '']));
  const mixedView=await readFrozenMaterial({material:mixed});
  assert.ok(mixedView.some(c=>c.type==='image'));
  assert.match(asText(mixedView).text,/unread: true/);
  assert.equal(asText(mixedView).endLine,1);
  const blankPage=await readFrozenMaterial({material:mixed,range:{startLine:2,endLine:2}});
  assert.equal(asText(blankPage).startLine,2);
  assert.ok(blankPage.some(c=>c.type==='image'));
  const onlyText = asText(await readFrozenMaterial({ material: mixed, range: { startLine: 1, endLine: 1 } }));
  assert.match(onlyText.text, /PAGE_ONE/);
  assert.equal(onlyText.endLine, 1);

  const hugePage = await frozen(dir, 'huge.pdf', makePdf(['A'.repeat(MAX_TEXT_CHARS + 50)], 400000));
  await assert.rejects(readFrozenMaterial({ material: hugePage }), /第1页文字超过|无法作为一页完整返回/);

  const live = new AbortController();
  const pending = readFrozenMaterial({
    material: await frozen(dir, 'abort.pdf', makePdf(manyPages), 'abp'),
    signal: live.signal,
  });
  live.abort();
  await assert.rejects(pending, /取消/);
});

test('图片 cap 低于 MCP 1MB 响应，避免先成功再 413', async t => {
  assert.ok(MAX_IMAGE_BYTES * 4 / 3 + 32_768 < MCP_RESPONSE_MAX_BYTES);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-img-cap-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54,
    0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01,
    0x00, 0x05, 0xfe, 0xd4, 0xef,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const over = Buffer.concat([png.subarray(0, 8), Buffer.alloc(MAX_IMAGE_BYTES + 1, 1)]);
  await assert.rejects(readFrozenMaterial({ material: await frozen(dir, 'over.png', over) }), /图片超过|MCP 响应上限/);
});

test('CJS bundle 实际提取 DOCX 与文字 PDF', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-bundle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, 'reader.cjs');
  const { build } = await import('esbuild');
  await build({
    entryPoints: [fileURLToPath(new URL('./agent-document-reader.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['@napi-rs/canvas'],
    outfile,
  });
  const require = createRequire(import.meta.url);
  await fs.copyFile(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    path.join(dir, 'pdf.worker.mjs'),
  );
  const bundled = require(outfile) as { readFrozenMaterial: typeof readFrozenMaterial };
  const docx = asText(await bundled.readFrozenMaterial({
    material: await frozen(dir, 'bundle.docx', makeDocx(['捆绑提取中文段落'])),
  }));
  assert.match(docx.text, /捆绑提取中文段落/);
  assert.equal(docx.startLine, 1);
  const pdf = asText(await bundled.readFrozenMaterial({
    material: await frozen(dir, 'bundle.pdf', makePdf(['BUNDLE_PAGE_ONE', 'BUNDLE_PAGE_TWO'])),
  }));
  assert.match(pdf.text, /BUNDLE_PAGE_ONE/);
  assert.match(pdf.text, /BUNDLE_PAGE_TWO/);
  assert.equal(pdf.startLine, 1);
  assert.equal(pdf.endLine, 2);
  assert.match(pdf.text, /rangeUnit: page/);
});


test('DOCX tracked changes cannot silently choose an unspecified manuscript version',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'docx-revisions-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const data=zipStore([['[Content_Types].xml','<Types/>'],['word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:ins><w:r><w:t>新内容</w:t></w:r></w:ins></w:p></w:body></w:document>']]);
 await assert.rejects(readFrozenMaterial({material:await frozen(dir,'修订.docx',data)}),/未处理修订/);
});
