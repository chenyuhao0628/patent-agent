import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { extractDocxContent, extractDocxParagraphs } from './files.ts';
import { exportApplicationParts } from './document-export.ts';
import { exportStageDocx, readStageDocx } from './stage-docx.ts';
import { readOfficeMath } from './office-math-reader.ts';
import { latexToOmml, splitTextAndFormulas } from './math-omml.ts';
import { DOMParser } from '@xmldom/xmldom';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const run = (s: string) => `<m:r><m:t>${esc(s)}</m:t></m:r>`;
const word = (s: string) => `<w:r><w:t>${esc(s)}</w:t></w:r>`;
const para = (s: string) => `<w:p>${s}</w:p>`;
const math = (s: string) => `<m:oMath>${s}</m:oMath>`;
const sup = `<m:sSup><m:e>${run('x')}</m:e><m:sup>${run('2')}</m:sup></m:sSup>`;
const sub = `<m:sSub><m:e>${run('x')}</m:e><m:sub>${run('i')}</m:sub></m:sSub>`;
const both = `<m:sSubSup><m:e>${run('x')}</m:e><m:sub>${run('i')}</m:sub><m:sup>${run('2')}</m:sup></m:sSubSup>`;
const fraction = `<m:f><m:num>${run('a')}</m:num><m:den>${run('b')}</m:den></m:f>`;
const root = `<m:rad><m:radPr><m:degHide m:val="on"/></m:radPr><m:deg/><m:e>${run('x')}</m:e></m:rad>`;
const cube = `<m:rad><m:deg>${run('3')}</m:deg><m:e>${run('x')}</m:e></m:rad>`;

async function docx(body: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const z = new JSZip();
  z.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:m="${M}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`);
  z.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.keys(headers).map(id => `<Relationship Id="${id}" Target="${id}.xml" Type="${R}/header"/>`).join('')}</Relationships>`);
  for (const [id, text] of Object.entries(headers)) z.file(`word/${id}.xml`, `<w:hdr xmlns:w="${W}">${para(word(text))}</w:hdr>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
const section = (text: string, header?: string) => para(`<w:pPr><w:sectPr>${header ? `<w:headerReference w:type="default" r:id="${header}"/>` : ''}</w:sectPr></w:pPr>${word(text)}`);

test('plain paragraphs retain text and blank/absent headers never duplicate five parts', async () => {
  for (const headers of [{}, { empty: '' }] as Record<string, string>[]) {
    const result = await extractDocxContent(await docx(section('普通正文', 'empty' in headers ? 'empty' : undefined), headers));
    assert.equal(result.text, '普通正文');
    assert.equal(result.parts?.length, 1);
    assert.equal(result.parts?.[0].code, 'unclassified-1');
    assert.equal(result.parts?.[0].content, result.text);
  }
  assert.equal(await extractDocxParagraphs(await docx(para(word('第一段')) + para(word('第二段')))), '第一段\n\n第二段');
  assert.equal(await extractDocxParagraphs(await docx('')), '');
});

test('mixed and formula-only inline/display OfficeMath preserve semantic structure', async () => {
  const bytes = await docx(para(word('公式为') + math(fraction) + word('。')) + para(`<m:oMathPara>${math(sup)}</m:oMathPara>`));
  assert.equal(await extractDocxParagraphs(bytes), "公式为$\\frac{a}{b}$。\n\n$${x}^{2}$$");
  assert.equal(await extractDocxParagraphs(await docx(para(math(run('x'))))), '$x$');
  assert.equal(await extractDocxParagraphs(await docx(`<m:oMathPara>${math(root)}</m:oMathPara>`)), '$$\\sqrt{x}$$');
});

for (const [name, xml, latex] of [
  ['superscript', sup, '{x}^{2}'],
  ['subscript', sub, '{x}_{i}'],
  ['combined scripts', both, '{x}_{i}^{2}'],
  ['fraction', fraction, '\\frac{a}{b}'],
  ['square root', root, '\\sqrt{x}'],
  ['indexed root', cube, '\\sqrt[3]{x}'],
] as const) {
  test(`actual parser preserves ${name}`, async () => {
    assert.equal(await extractDocxParagraphs(await docx(para(math(xml)))), `$${latex}$`);
  });
}

test('nested fraction/root/script and literal math characters are not flattened or executed', async () => {
  const nested = `<m:f><m:num>${sup}</m:num><m:den>${root}</m:den></m:f>`;
  assert.equal(await extractDocxParagraphs(await docx(para(math(nested)))), '$\\frac{{x}^{2}}{\\sqrt{x}}$');
  const literal = await extractDocxParagraphs(await docx(para(math(run('x_i')))));
  assert.equal(literal, '$x\\text{\\_}i$');
  const converted = latexToOmml(splitTextAndFormulas(literal)[0].content)!;
  assert.ok(converted);
  assert.doesNotMatch(converted, /<m:sSub>/);
  assert.equal(await extractDocxParagraphs(await docx(para(converted))), literal);
});

for (const [name, xml] of [
  ['matrix with semantic column separators', math(`<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="1"/><m:sepChr m:val="|"/></m:mcPr></m:mc></m:mcs></m:mPr><m:mr><m:e>${run('x')}</m:e></m:mr></m:m>`)],
  ['nary operator with hidden nonempty limit', math(`<m:nary><m:naryPr><m:subHide m:val="on"/></m:naryPr><m:sub>${run('i')}</m:sub><m:e>${run('x')}</m:e></m:nary>`)],
  ['unknown fraction style', math(fraction.replace('<m:f>', '<m:f><m:fPr><m:type m:val="skw"/></m:fPr>'))],
  ['missing denominator', math(`<m:f><m:num>${run('x')}</m:num></m:f>`)],
  ['empty formula', math('')],
  ['stray math text', run('lost')],
  ['tracked insertion', `<w:ins>${word('new text')}</w:ins>`],
  ['legacy field formula', '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> EQ \\F(a,b)</w:instrText></w:r>'],
  ['embedded OLE object', '<w:r><w:object/></w:r>'],
  ['unresolved drawing', '<w:r><w:drawing/></w:r>'],
  ['alternate object fallback', '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"/>'],
  ['unmapped symbol', '<w:r><w:sym w:char="F061"/></w:r>'],
] as const) {
  test(`unsupported ${name} rejects rather than returning empty/old draft`, async () => {
    const bytes = await docx(para(word('must not return a partial prefix') + xml));
    await assert.rejects(extractDocxContent(bytes), /Word 读取失败/);
    await assert.rejects(extractDocxParagraphs(bytes), /Word 读取失败/);
  });
}

test('invalid ZIP, absent body and malformed XML reject explicitly', async () => {
  await assert.rejects(extractDocxParagraphs(Buffer.from('invalid')), /Word 读取失败/);
  const z = new JSZip();
  await assert.rejects(extractDocxParagraphs(await z.generateAsync({ type: 'nodebuffer' })), /缺少 document/);
  for (const xml of ['<document/>', `<w:document xmlns:w="${W}"><w:body><w:p></w:body></w:document>`]) {
    z.file('word/document.xml', xml);
    await assert.rejects(extractDocxParagraphs(await z.generateAsync({ type: 'nodebuffer' })), /Word 读取失败/);
  }
});

test('decompression bombs are rejected before any entry is inflated', async () => {
  const bomb = new JSZip();
  bomb.file('word/document.xml', 'a'.repeat(84 * 1024 * 1024));
  const bytes = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.ok(bytes.length < 20 * 1024 * 1024, '炸弹压缩后应小于材料上限');
  await assert.rejects(extractDocxContent(bytes), /解压后体积过大/);
  await assert.rejects(extractDocxParagraphs(bytes), /解压后体积过大/);
  const many = new JSZip();
  for (let i = 0; i < 4_097; i++) many.file(`word/m${i}.xml`, '<w:p/>');
  await assert.rejects(extractDocxContent(await many.generateAsync({ type: 'nodebuffer' })), /条目过多/);
});

test('generated OMML for operator runs survives lossless reading and stage Word export', async () => {
  for (const [latex, display] of [['P=F/S', false], ['v=s/t', false], ['R=U/I', false], ['\\Delta x', false], ['P = \\frac{F}{S}', true]] as const) {
    const omml = latexToOmml(latex, display);
    assert.ok(omml && omml.includes('<m:oMath'));
    assert.equal(omml!.includes('m:val="undefined"'), false, latex);
    const doc = new DOMParser().parseFromString(omml!, 'application/xml');
    const round = readOfficeMath(doc.documentElement);
    assert.match(round, /^\$|^\$\$/);
  }
  const templates = fileURLToPath(new URL('../resources/document-templates', import.meta.url));
  const bytes = await exportStageDocx(templates, '公式导出验收', '行内公式 $P=F/S$ 与行间公式：\n\n$$P = \\frac{F}{S}$$\n\n求和 $\\sum_{i=1}^{n} x_i$，向量 $\\vec{F}$，上划线 $\\overline{AB}$。');
  const blocks = await readStageDocx(bytes);
  const texts = blocks.map(b => b.kind === 'paragraph' ? b.content.map(c => c.text).join('') : '[table]').join('\n');
  assert.match(texts, /行内公式/);
  assert.match(texts, /\\frac\{F\}\{S\}|\\text\{\/\}/);
  assert.match(texts, /\\sum/);
  assert.match(texts, /\\vec\{F\}/);
  // n-ary / accent / matrix 读回为语义 LaTeX，矩阵不退回空稿
  const matrixOmml = latexToOmml('\\begin{cases} 1 & x>0 \\\\ 0 & x\\le 0 \\end{cases}', true)!;
  const matrixText = await extractDocxParagraphs(await docx(para(matrixOmml)));
  assert.match(matrixText, /\\begin\{matrix\}/);
  assert.match(matrixText, /x>0/);
});

test('exact canonical headings distinguish abstract, description and unknown partial headings', async () => {
  const result = await extractDocxContent(await docx(
    section('摘要内容', 'a') + section('说明内容', 'd') + section('不能当说明书', 'u'),
    { a: '说 明 书 摘 要', d: '说明书', u: '说明' }));
  assert.deepEqual(result.parts?.map(p => [p.code, p.content]), [['100004', '摘要内容'], ['100002', '说明内容'], ['unclassified-1', '不能当说明书']]);
});

test('duplicate, normalized alias and explicit/inherited continuation sections merge without loss', async () => {
  const result = await extractDocxContent(await docx(
    section('一', 'a') + section('二', 'b') + section('三') + section('四', 'a') + section('五', 'c'),
    { a: '说明书摘要', b: '说明书摘要（续页）', c: '摘要' }));
  assert.deepEqual(result.parts, [{ code: '100004', name: '说明书摘要', content: '一\n\n二\n\n三\n\n四\n\n五' }]);
});

test('recognized parts retain all unclassified bodies including a later explicit empty header', async () => {
  const result = await extractDocxContent(await docx(
    section('未分类开头') + section('权利要求', 'c') + section('附加材料', 'other') + section('无标题尾部', 'empty'),
    { c: '权利要求书', other: '附录A', empty: '' }));
  assert.equal(result.parts?.length, 4);
  assert.equal(result.parts?.map(p => p.content).join('\n\n'), result.text);
  assert.deepEqual(result.parts?.map(p => p.code), ['unclassified-1', '100001', 'unclassified-2', 'unclassified-3']);
});

test('missing explicit section header rejects instead of inheriting the wrong part', async () => {
  await assert.rejects(extractDocxContent(await docx(section('未知', 'missing'))), /页眉关系缺失/);
});

test('real application exporter and parser round-trip all supported formula structures twice', async () => {
  const templates = fileURLToPath(new URL('../resources/document-templates/', import.meta.url));
  const original = '文字 $x^2$、$x_i$、$x_i^2$、$\\frac{a}{b}$、$\\sqrt{x}$、$\\sqrt[3]{x}$。\n$$\\frac{x^2}{\\sqrt{x}}$$';
  const once = await extractDocxContent(await exportApplicationParts(templates, { CLAIMS: original, DESCRIPTION: '说明正文', ABSTRACT: '摘要正文' }));
  const claims = once.parts!.find(p => p.code === '100001')!.content;
  assert.match(claims, /\\frac/);
  assert.match(claims, /\\sqrt/);
  assert.match(claims, /\$\$/);
  assert.equal(once.parts!.find(p => p.code === '100002')!.content, '说明正文');
  assert.equal(once.parts!.find(p => p.code === '100004')!.content, '摘要正文');
  const twice = await extractDocxContent(await exportApplicationParts(templates, { CLAIMS: claims }));
  assert.equal(twice.parts!.find(p => p.code === '100001')!.content, claims);
});
