import * as fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import CSSMatrix from '@thednp/dommatrix';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { MCP_RESPONSE_MAX_BYTES } from './agent-broker.ts';
import type { FrozenMaterial, McpContent, ReadMaterialCallback, ToolRange } from './agent-runner.ts';
import { digest, readBoundedFile } from './files.ts';
import { renderPdfPage } from './document-visual.ts';
import { convertOldDoc } from './document-converter.ts';

export const MAX_MATERIAL_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 600 * 1024;
export const MAX_TEXT_CHARS = 40_000;
export const MAX_TEXT_LINES = 1_000;
export const MAX_ZIP_UNCOMPRESSED = 80 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 4_096;
export const MAX_PDF_PAGES = 2_000;
export const MAX_PDF_PAGES_PER_READ = 20;
const IMAGE_JSON_OVERHEAD = 16_384;

type PdfDocument = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getTextContent: (params?: object) => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
  }>;
  destroy: () => Promise<void>;
};

type PdfLoadingTask = {
  promise: Promise<PdfDocument>;
  destroy: () => Promise<void>;
};

type PdfjsModule = {
  getDocument: (src: object) => PdfLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
};

class NoNativeCanvasFactory {
  create(): never {
    throw new Error('PDF 文本提取不使用 canvas。');
  }
  reset(): void {}
  destroy(): void {}
}

let pdfjsModule: PdfjsModule | undefined;

function ensureDomMatrix(): void {
  if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
    Object.defineProperty(globalThis, 'DOMMatrix', { value: CSSMatrix, configurable: true, writable: true });
  }
}

function moduleDirectory(): string | undefined {
  if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname;
  try {
    if (typeof import.meta.url === 'string' && import.meta.url) {
      return path.dirname(fileURLToPath(import.meta.url));
    }
  } catch { /* CJS bundle has empty import.meta */ }
  return undefined;
}

function pdfWorkerSrc(): string {
  const here = moduleDirectory();
  const candidates: string[] = [];
  try {
    if (typeof import.meta.url === 'string' && import.meta.url) {
      candidates.push(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'));
    }
  } catch { /* packaged build has no node_modules resolve */ }
  if (here) {
    candidates.push(path.join(here, 'pdf.worker.mjs'));
    candidates.push(path.join(here, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'));
  }
  for (const candidate of candidates) {
    try {
      const stat = fsSync.lstatSync(candidate);
      if (!stat.isSymbolicLink() && stat.isFile()) return pathToFileURL(candidate).href;
    } catch { /* next */ }
  }
  throw new Error('缺少 PDF.js worker，无法提取 PDF 文字。');
}

async function loadPdfjs(): Promise<PdfjsModule> {
  ensureDomMatrix();
  if (!pdfjsModule) {
    const [mod, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfjsModule>,
      import('pdfjs-dist/legacy/build/pdf.worker.mjs').catch(() => undefined),
    ]);
    const g = globalThis as typeof globalThis & { pdfjsWorker?: unknown };
    if (worker && !g.pdfjsWorker) g.pdfjsWorker = worker;
    try {
      mod.GlobalWorkerOptions.workerSrc = pdfWorkerSrc();
    } catch {
      mod.GlobalWorkerOptions.workerSrc = 'pdf.worker.mjs';
    }
    pdfjsModule = mod;
  }
  return pdfjsModule;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('读取已取消。');
}

async function assertNotSymlink(target: string): Promise<fsSync.Stats> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error('材料快照不能是符号链接。');
  return stat;
}

function magic(buffer: Buffer): string {
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) return 'pdf';
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  return 'text';
}

export function inspectZipLimits(buffer: Buffer): { entries: number; uncompressed: number } {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('DOCX 压缩包损坏，无法安全解压。');
  const entries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries > MAX_ZIP_ENTRIES) throw new Error('DOCX 条目过多，已拒绝解压。');
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error('不支持 ZIP64 的过大 DOCX。');
  if (cdOffset + cdSize > buffer.length) throw new Error('DOCX 压缩包损坏，无法安全解压。');
  let cursor = cdOffset;
  let uncompressed = 0;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > buffer.length) throw new Error('DOCX 压缩包损坏，无法安全解压。');
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('DOCX 压缩包损坏，无法安全解压。');
    const size = buffer.readUInt32LE(cursor + 24);
    if (size === 0xffffffff) throw new Error('不支持 ZIP64 的过大 DOCX。');
    uncompressed += size;
    if (uncompressed > MAX_ZIP_UNCOMPRESSED) throw new Error('DOCX 解压后体积过大，已拒绝。');
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, uncompressed };
}

function looksLikeDocx(buffer: Buffer): boolean {
  const names: string[] = [];
  let eocd = -1;
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = buffer.readUInt16LE(eocd + 10);
  for (let i = 0; i < entries && cursor + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) return false;
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8').replaceAll('\\', '/'));
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return names.includes('word/document.xml') && names.includes('[Content_Types].xml');
}

function looksBinaryText(buffer: Buffer): boolean {
  if (!buffer.length) return false;
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let odd = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) odd += 1;
  }
  return odd / sample.length > 0.15;
}

function decodeUtf8(buffer: Buffer): string | undefined {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return undefined;
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return undefined;
  const start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  const slice = start ? buffer.subarray(start) : buffer;
  if (looksBinaryText(slice)) return undefined;
  const text = slice.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(slice)) return undefined;
  return text;
}

function selectLineWindow(text: string, range?: ToolRange): { lines: string[]; startLine: number; totalLines: number } {
  const lines = text.split('\n');
  const totalLines = text.length === 0 ? 0 : lines.length;
  if (!totalLines) return { lines: [], startLine: 0, totalLines: 0 };
  if (!range) return { lines, startLine: 1, totalLines };
  if (range.offset !== undefined || range.limit !== undefined) {
    const start = Math.max(1, (range.offset ?? 0) + 1);
    const count = range.limit !== undefined ? Math.max(0, range.limit) : totalLines - start + 1;
    const end = Math.min(totalLines, start + count - 1);
    if (start > totalLines || end < start) return { lines: [], startLine: start, totalLines };
    return { lines: lines.slice(start - 1, end), startLine: start, totalLines };
  }
  const start = Math.max(1, range.startLine ?? 1);
  const end = Math.min(totalLines, Math.max(start, range.endLine ?? totalLines));
  if (start > totalLines) return { lines: [], startLine: start, totalLines };
  return { lines: lines.slice(start - 1, end), startLine: start, totalLines };
}

export function takeCompleteLines(
  windowLines: string[],
  startLine: number,
  totalLines: number,
): { text: string; startLine: number; endLine: number; totalLines: number; truncated: boolean } {
  if (!windowLines.length) {
    return { text: '', startLine: 0, endLine: 0, totalLines, truncated: false };
  }
  const taken: string[] = [];
  let chars = 0;
  for (const line of windowLines) {
    if (line.length > MAX_TEXT_CHARS) {
      if (!taken.length) {
        throw new Error(`单行超过 ${MAX_TEXT_CHARS} 字符，无法按完整行返回。请拆分后再读。`);
      }
      break;
    }
    if (taken.length >= MAX_TEXT_LINES) break;
    const extra = line.length + (taken.length > 0 ? 1 : 0);
    if (chars + extra > MAX_TEXT_CHARS) break;
    taken.push(line);
    chars += extra;
  }
  if (!taken.length) {
    throw new Error(`单行超过 ${MAX_TEXT_CHARS} 字符，无法按完整行返回。请拆分后再读。`);
  }
  const endLine = startLine + taken.length - 1;
  return {
    text: taken.join('\n'),
    startLine,
    endLine,
    totalLines,
    truncated: taken.length < windowLines.length,
  };
}

function headerBlock(fields: Record<string, string | number | boolean>): string {
  return Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n');
}

function textResult(
  fields: Record<string, string | number | boolean>,
  body: string,
  startLine: number,
  endLine: number,
  suppliedChunks?: Array<{start:number;end:number;text:string}>,
): McpContent[] {
  const visual=fields.ocr===false;
  const chunks=visual?[]:suppliedChunks??[{start:startLine,end:endLine,text:body}];
  return [{
    type: 'text',
    text: `${headerBlock(fields)}\n\n${body}`,
    startLine,
    endLine,
    observation:{materialId:String(fields.materialId),hash:String(fields.hash),unit:fields.rangeUnit==='page'?'page':'line',start:startLine,end:endLine,
      total:Number(fields.totalLines??fields.pages)||undefined,mode:visual?'visual':'text',completeUnits:true,chunks},
  }];
}

function awaitLoadingTask(task: PdfLoadingTask, signal?: AbortSignal): Promise<PdfDocument> {
  if (signal?.aborted) {
    void task.destroy();
    return Promise.reject(new Error('读取已取消。'));
  }
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => {
      void task.destroy();
      finish(() => reject(new Error('读取已取消。')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task.promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(signal.aborted ? new Error('读取已取消。') : error)),
    );
  });
}

function pageTextFromContent(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item.str === 'string' && item.str) parts.push(item.str);
    if (item.hasEOL) parts.push('\n');
    else parts.push(' ');
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function selectPdfPageRange(pageCount: number, range?: ToolRange): { start: number; end: number } {
  if (pageCount <= 0) return { start: 0, end: 0 };
  let start = 1;
  let end = pageCount;
  if (range?.offset !== undefined || range?.limit !== undefined) {
    start = Math.max(1, (range.offset ?? 0) + 1);
    const count = range.limit !== undefined ? Math.max(0, range.limit) : pageCount - start + 1;
    end = Math.min(pageCount, start + count - 1);
  } else if (range) {
    start = Math.max(1, range.startLine ?? 1);
    end = Math.min(pageCount, Math.max(start, range.endLine ?? pageCount));
  }
  if (end - start + 1 > MAX_PDF_PAGES_PER_READ) end = start + MAX_PDF_PAGES_PER_READ - 1;
  return { start, end };
}

export async function extractPdfPageRange(
  buffer: Buffer,
  range: ToolRange | undefined,
  signal?: AbortSignal,
  allowEmpty=false,
): Promise<{ pages: Map<number, string>; pageCount: number; start: number; end: number; emptyPages:number[] }> {
  const pdfjs = await loadPdfjs();
  assertNotAborted(signal);
  const copy = Uint8Array.from(buffer);
  const task = pdfjs.getDocument({
    data: copy,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    useWorkerFetch: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
    maxImageSize: 0,
    canvasMaxAreaInBytes: 0,
    CanvasFactory: NoNativeCanvasFactory,
  });
  let doc: PdfDocument | undefined;
  try {
    doc = await awaitLoadingTask(task, signal);
    assertNotAborted(signal);
    const pageCount = doc.numPages;
    if (pageCount > MAX_PDF_PAGES) {
      throw new Error(`PDF 超过 ${MAX_PDF_PAGES} 页上限，未读取。`);
    }
    const { start, end } = selectPdfPageRange(pageCount, range);
    if (start < 1 || start > pageCount || end < start) {
      throw new Error(`请求页超出范围（共 ${pageCount} 页）。`);
    }
    const pages = new Map<number, string>();
    const empty: number[] = [];
    for (let n = start; n <= end; n++) {
      assertNotAborted(signal);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = pageTextFromContent(content.items);
      if (!text) {
        empty.push(n);
        continue;
      }
      if (text.length > MAX_TEXT_CHARS || text.split('\n').length > MAX_TEXT_LINES) {
        throw new Error(`第${n}页文字超过 ${MAX_TEXT_CHARS} 字符或 ${MAX_TEXT_LINES} 行上限，无法作为一页完整返回。请转换或拆分后再读。`);
      }
      pages.set(n, text);
    }
    if (empty.length && !allowEmpty) {
      if (empty.length === pageCount) {
        throw new Error('该 PDF 没有可提取文字层（可能为扫描件），不能当作已完整阅读。请提供文字版 PDF 或先转换。');
      }
      throw new Error(`所选页没有可提取文字（第${empty.join('、')}页），不能当作已完整阅读。请提供文字版或先转换。`);
    }
    return { pages, pageCount, start, end, emptyPages:empty };
  } catch (error) {
    if (signal?.aborted) throw new Error('读取已取消。');
    throw error;
  } finally {
    if (doc) await doc.destroy().catch(() => undefined);
    else void task.destroy();
  }
}

export async function readFrozenMaterial(input: {
  material: FrozenMaterial;
  range?: ToolRange;
  signal?: AbortSignal;
}): Promise<McpContent[]> {
  assertNotAborted(input.signal);
  const snapshotPath = input.material.absoluteSnapshotPath;
  if (!snapshotPath || path.isAbsolute(snapshotPath) === false) throw new Error('材料缺少冻结快照路径。');
  const stat = await assertNotSymlink(snapshotPath);
  if (!stat.isFile()) throw new Error('材料快照不是普通文件。');
  if (stat.size > MAX_MATERIAL_BYTES) throw new Error(`材料超过 ${MAX_MATERIAL_BYTES / (1024 * 1024)}MB 上限，未读取。`);
  const buffer = await readBoundedFile(snapshotPath,MAX_MATERIAL_BYTES,input.signal);
  assertNotAborted(input.signal);
  const hash = digest(buffer);
  if (hash !== input.material.hash) throw new Error('材料快照哈希不一致，未读取。');
  const kind = magic(buffer);
  let contents: McpContent[];
  if (kind === 'pdf') contents = await readPdf(input.material, buffer, input.range, input.signal);
  else if (kind === 'zip') contents = await readDocx(input.material, buffer, input.range, input.signal);
  else if (kind === 'ole') {
    const converted=await convertOldDoc(buffer,input.signal);
    contents=await readDocx(input.material,converted.bytes,input.range,input.signal);
    contents.unshift({type:'text',text:`旧 DOC 已通过${converted.engine==='system'?'macOS 系统工具':'LibreOffice'}在本机转换为 DOCX 阅读副本，原件未修改。转换副本 SHA256：${converted.hash}。${converted.engine==='system'?'系统转换用于文字阅读，复杂公式、附图和版式不保证完整；可在权限允许时选择本机其他工具或轻量转换/OCR 后核对，也可按需使用完整组件。':''}文字提取不包含版式与附图，请另行核对图像内容。`});
  }
  else if (kind === 'png' || kind === 'jpeg') contents = readImage(input.material, buffer, kind);
  else contents = readPlain(input.material, buffer, input.range);
  assertNotAborted(input.signal);
  const againStat = await assertNotSymlink(snapshotPath);
  if (!againStat.isFile()) throw new Error('材料快照不是普通文件。');
  if (againStat.size > MAX_MATERIAL_BYTES) throw new Error(`材料超过 ${MAX_MATERIAL_BYTES / (1024 * 1024)}MB 上限，未读取。`);
  const again = await readBoundedFile(snapshotPath,MAX_MATERIAL_BYTES,input.signal);
  if (digest(again) !== hash) throw new Error('读取期间材料快照已变化，结果已丢弃。');
  assertNotAborted(input.signal);
  return contents;
}

export function createReadMaterialCallback(signal?: AbortSignal): ReadMaterialCallback {
  return ({ material, range }) => readFrozenMaterial({ material, range, signal });
}

function lineReadResult(
  material: FrozenMaterial,
  format: 'text' | 'docx',
  taken: { text: string; startLine: number; endLine: number; totalLines: number; truncated: boolean },
  extra: Record<string, string | number | boolean> = {},
): McpContent[] {
  if (!taken.text.trim() || taken.startLine < 1 || taken.endLine < taken.startLine) {
    throw new Error('所选范围没有可读取文本，请核对文件和行号。');
  }
  const unread = taken.endLine < taken.totalLines;
  const next = taken.endLine + 1;
  const hint = unread
    ? `未读行 ${next}–${taken.totalLines}，可用 startLine=${next} 继续。`
    : format === 'docx'
      ? '已返回所选范围的段落文本（无版式）。'
      : '已返回所选范围全部文本。';
  return textResult({
    materialId: material.id,
    name: material.name,
    format,
    hash: material.hash,
    rangeUnit: 'line',
    startLine: taken.startLine,
    endLine: taken.endLine,
    totalLines: taken.totalLines,
    returnedLines: taken.startLine && taken.endLine ? `${taken.startLine}-${taken.endLine}` : '无',
    truncated: taken.truncated,
    unread,
    hint,
    ...extra,
  }, taken.text, taken.startLine, taken.endLine);
}

function readPlain(material: FrozenMaterial, buffer: Buffer, range?: ToolRange): McpContent[] {
  const decoded = decodeUtf8(buffer);
  if (decoded === undefined) {
    throw new Error(`不支持的材料格式（${material.name}）。请提供 TXT/MD/JSON、DOCX 或文字版 PDF。`);
  }
  const window = selectLineWindow(decoded, range);
  const taken = takeCompleteLines(window.lines, window.startLine, window.totalLines);
  return lineReadResult(material, 'text', taken);
}

async function readDocx(material: FrozenMaterial, buffer: Buffer, range?: ToolRange, signal?: AbortSignal): Promise<McpContent[]> {
  inspectZipLimits(buffer);
  if (!looksLikeDocx(buffer)) throw new Error('该 ZIP 不是 DOCX（缺少 word/document.xml），已拒绝。');
  assertNotAborted(signal);
  const zip=await JSZip.loadAsync(buffer);
  for(const name of Object.keys(zip.files).filter(n=>/^word\/.*\.xml$/.test(n))){
    const xml=await zip.file(name)!.async('string');
    if(/<(?:[\w]+:)?(?:ins|del|moveFrom|moveTo|pPrChange|rPrChange|tblPrChange)\b/.test(xml))throw new Error('DOCX 含未处理修订。请在 Word/WPS 中明确接受或拒绝修订，另存完成稿副本后再选择；原件保留，当前未按未知版本继续审查。');
  }
  const extracted = await mammoth.extractRawText({ buffer });
  assertNotAborted(signal);
  const raw = (extracted.value || '').replace(/\n{3,}/g, '\n\n').trimEnd();
  if (!raw.trim()) throw new Error('DOCX 未提取到段落文本，不能当作已完整阅读。');
  const window = selectLineWindow(raw, range);
  const taken = takeCompleteLines(window.lines, window.startLine, window.totalLines);
  return lineReadResult(material, 'docx', taken, { layout: '未还原版式，仅保留段落文本' });
}

async function readPdf(material: FrozenMaterial, buffer: Buffer, range?: ToolRange, signal?: AbortSignal): Promise<McpContent[]> {
  const visual=async()=>{
    const requested=range?.offset!==undefined?range.offset+1:range?.startLine??1;
    const page=await renderPdfPage(buffer,requested,signal);
    return [...textResult({materialId:material.id,name:material.name,hash:material.hash,format:'pdf-page-image',rangeUnit:'page',startLine:page.page,endLine:page.page,pages:page.pages,ocr:false,unread:page.page<page.pages,hint:`这是第 ${page.page} / ${page.pages} 页原始页图，请用视觉识读并核对。只返回这一页，未读取其余页面；下一页使用 startLine=${page.page+1}。看不清的文字必须说明，不能猜测。`},'页图见下一图像内容。',page.page,page.page),{type:'image' as const,mimeType:'image/jpeg',data:page.bytes.toString('base64')}];
  };
  if(range?.visual)return visual();
  let extracted:Awaited<ReturnType<typeof extractPdfPageRange>>;
  try{extracted=await extractPdfPageRange(buffer,range,signal);}catch(e){if(/没有可提取文字/.test((e as Error).message))return visual();throw e;}
  const { pages, pageCount, start, end } = extracted;
  const chunks: string[] = [];
  let returnedEnd = start - 1;
  for (let n = start; n <= end; n++) {
    const block = `## 第${n}页\n${pages.get(n) || ''}`;
    const next = chunks.length ? `${chunks.join('\n\n')}\n\n${block}` : block;
    if (next.length > MAX_TEXT_CHARS || next.split('\n').length > MAX_TEXT_LINES) {
      if (!chunks.length) {
        throw new Error(`第${n}页文字超过 ${MAX_TEXT_CHARS} 字符或 ${MAX_TEXT_LINES} 行上限，无法作为一页完整返回。请转换或拆分后再读。`);
      }
      break;
    }
    chunks.push(block);
    returnedEnd = n;
  }
  if (!chunks.length) {
    throw new Error('所选页没有可返回的完整文字，不能当作已完整阅读。');
  }
  const unreadFrom = returnedEnd < pageCount ? returnedEnd + 1 : 0;
  const hint = unreadFrom
    ? `工具参数 startLine/endLine 对 PDF 表示页码（rangeUnit=page），不是文本行号。未读第${unreadFrom}–${pageCount}页，可设 startLine=${unreadFrom} 继续读取。`
    : '工具参数 startLine/endLine 对 PDF 表示页码（rangeUnit=page），不是文本行号。已返回所选页的文字。';
  return textResult({
    materialId: material.id,
    name: material.name,
    format: 'pdf',
    hash: material.hash,
    rangeUnit: 'page',
    startLine: start,
    endLine: returnedEnd,
    pages: pageCount,
    returnedPages: `${start}-${returnedEnd}`,
    truncated: returnedEnd < end,
    unread: Boolean(unreadFrom),
    hint,
  }, chunks.join('\n\n'), start, returnedEnd, [...pages].filter(([page])=>page>=start&&page<=returnedEnd).map(([page,text])=>({start:page,end:page,text})));
}

function readImage(material: FrozenMaterial, buffer: Buffer, kind: 'png' | 'jpeg'): McpContent[] {
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024)}KB 小文件上限，未作为图像返回。`);
  }
  const mimeType = kind === 'png' ? 'image/png' : 'image/jpeg';
  const header = headerBlock({
    materialId: material.id,
    name: material.name,
    format: kind,
    hash: material.hash,
    bytes: buffer.length,
    ocr: false,
    hint: '已返回图像本身，未做文字识别，不能当作已阅读其中文字。',
  });
  const data = buffer.toString('base64');
  const envelope = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: header }, { type: 'image', data, mimeType }] },
  });
  if (Buffer.byteLength(envelope) + IMAGE_JSON_OVERHEAD > MCP_RESPONSE_MAX_BYTES) {
    throw new Error('图片编码后超过 MCP 响应上限，未作为图像返回。');
  }
  return [
    { type: 'text', text: header, observation:{materialId:material.id,hash:material.hash,unit:'image',start:1,end:1,total:1,mode:'visual',completeUnits:true,chunks:[]} },
    { type: 'image', data, mimeType },
  ];
}
