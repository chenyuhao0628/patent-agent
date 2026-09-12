import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { digest } from './files.ts';
import { inspectZipLimits } from './agent-document-reader.ts';
import { FIVE_PARTS } from '../src/transfer-api.ts';
import type { PartComparison } from '../src/transfer-api.ts';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const tidy = (s: string) => s.replace(/\s/g, '');
type Part = { text: string; hash: string };

export async function applicationSections(bytes: Buffer): Promise<Map<string, Part>> {
  inspectZipLimits(bytes);
  const z = await JSZip.loadAsync(bytes);
  const xml = await z.file('word/document.xml')?.async('string');
  const relxml = await z.file('word/_rels/document.xml.rels')?.async('string');
  if (!xml || !relxml) return new Map();
  const parser = new DOMParser(), d = parser.parseFromString(xml, 'application/xml');
  const rels = new Map(Array.from(parser.parseFromString(relxml, 'application/xml').getElementsByTagName('Relationship')).map(r => [r.getAttribute('Id'), r.getAttribute('Target')]));
  const result = new Map<string, Part>();
  let nodes: Element[] = [];
  const finish = async (section: Element) => {
    const refs = Array.from(section.getElementsByTagNameNS(W, 'headerReference'));
    const headerId = (refs.find(r => r.getAttributeNS(W, 'type') === 'default') ?? refs[0])?.getAttributeNS(R, 'id');
    const headerPath = headerId && rels.get(headerId);
    const header = headerPath ? await z.file('word/' + headerPath.replace(/^\.\//, ''))?.async('string') : '';
    const title = header ? tidy(parser.parseFromString(header, 'application/xml').documentElement.textContent ?? '') : '';
    const part = FIVE_PARTS.find(p => title === p.name);
    if (part) {
      const text = nodes.map(n => Array.from(n.getElementsByTagNameNS(W, 't')).map(x => x.textContent ?? '').join('')).filter(Boolean).join('\n');
      const images: string[] = [];
      const graphics = nodes.flatMap(n => ['drawing','pict','object'].flatMap(tag => Array.from(n.getElementsByTagNameNS(W,tag)))).map(n => new XMLSerializer().serializeToString(n));
      for (const node of nodes) for (const el of Array.from(node.getElementsByTagName('*'))) {
        const id = el.getAttributeNS(R, 'embed') || el.getAttributeNS(R, 'id');
        const target = id && rels.get(id);
        if (target?.startsWith('media/')) { const image = await z.file('word/' + target)?.async('nodebuffer'); if (image) images.push(digest(image)); }
      }
      // Equations/drawings which cannot be represented as text require conservative review.
      const complex = nodes.some(n => n.getElementsByTagNameNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'oMath').length > 0);
      if (!result.has(part.code) && !complex) result.set(part.code, { text, hash: digest(tidy(text) + '\n' + images.join('\n')+'\n'+graphics.join('\n')) });
      else result.delete(part.code);
    }
    nodes = [];
  };
  const body = d.getElementsByTagNameNS(W, 'body')[0];
  for (const node of Array.from(body.childNodes).filter(n => n.nodeType === 1) as Element[]) {
    if (node.localName === 'sectPr') await finish(node);
    else { nodes.push(node); const section = node.getElementsByTagNameNS(W, 'sectPr')[0]; if (section) await finish(section); }
  }
  return result;
}

export async function compareApplication(before?: Buffer, after?: Buffer): Promise<PartComparison[]> {
  const a = before ? await applicationSections(before) : new Map<string, Part>();
  const b = after ? await applicationSections(after) : new Map<string, Part>();
  return FIVE_PARTS.map(p => {
    const old = a.get(p.code), next = b.get(p.code);
    const changed = old && next ? old.hash !== next.hash : null;
    return { ...p, changed, reason: changed === null ? '缺少可确认的基线或五书分节，请人工核对。' : changed ? '正文、附图或图形设置与所选基线不同。' : '正文、附图和图形设置未发现变化，仍需核对实际页面。', before: old?.text, after: next?.text };
  });
}
