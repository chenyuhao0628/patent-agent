/** Semantic OfficeMath -> the LaTeX delimiters used by the editor/exporter.
 * Deliberately not a layout converter. Unknown semantic nodes/properties fail closed. */
export const OFFICE_MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const elements = (el: Element): Element[] => Array.from(el.childNodes).filter(n => n.nodeType === 1) as Element[];
const unsupported = (el: Element): never => {
  throw new Error(`无法无损读取 Word 公式/对象（${el.nodeName}），已阻止文本载入；请保留原文件并在 Word 中核对。`);
};

function children(el: Element, allowed: string[]): Element[] {
  const nodes = elements(el);
  for (const node of nodes) {
    if (node.namespaceURI !== OFFICE_MATH_NS || !allowed.includes(node.localName)) unsupported(node);
  }
  return nodes;
}
function value(el: Element): string { return el.getAttributeNS(OFFICE_MATH_NS, 'val') || ''; }
function properties(el: Element, allowed: Record<string, string[]> = {}): void {
  for (const child of children(el, ['ctrlPr', ...Object.keys(allowed)])) {
    if (child.localName === 'ctrlPr') {
      // Word run formatting is presentation only, never formula operands.
      for (const node of elements(child)) if (node.namespaceURI !== W || node.localName !== 'rPr') unsupported(node);
    } else if (!allowed[child.localName].includes(value(child)) || elements(child).length) unsupported(child);
  }
}
function literal(text: string, normal = false): string {
  // Escape literal OfficeMath characters, never execute them as LaTeX.
  // Text-only commands must stay inside text{}, including in math runs.
  const textEscapes: Record<string, string> = {"\\": "\\textbackslash{}", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}", "{": "\\{", "}": "\\}", "_": "\\_", "%": "\\%", "&": "\\&", "#": "\\#", "$": "\\$"};
  const mathEscapes: Record<string, string> = {"\\": "\\text{\\textbackslash{}}", "^": "\\text{\\textasciicircum{}}", "~": "\\text{\\textasciitilde{}}", "{": "\\{", "}": "\\}", "_": "\\text{\\_}", "%": "\\text{\\%}", "&": "\\text{\\&}", "#": "\\text{\\#}", "$": "\\text{\\$}", " ": "\\ ", " ": "\\ "};
  return Array.from(text).map(c => (normal ? textEscapes : mathEscapes)[c] ?? c).join('');
}
function render(el: Element): string {
  if (el.namespaceURI !== OFFICE_MATH_NS) return unsupported(el);
  const tag = el.localName;
  if (['oMath', 'e', 'num', 'den', 'sub', 'sup', 'deg'].includes(tag)) {
    return children(el, ['r', 'sSup', 'sSub', 'sSubSup', 'f', 'rad']).map(render).join('');
  }
  if (tag === 'r') {
    let style = '', normal = false;
    for (const node of elements(el)) {
      if (node.namespaceURI === W && node.localName === 'rPr') continue;
      if (node.namespaceURI !== OFFICE_MATH_NS) unsupported(node);
      if (node.localName === 'rPr') {
        properties(node, { sty: ['p', 'i', 'b', 'bi'], nor: ['', '1', '0', 'true', 'false', 'on', 'off'] });
        for (const prop of elements(node)) {
          if (prop.localName === 'sty') style = value(prop);
          if (prop.localName === 'nor') normal = !['0', 'false', 'off'].includes(value(prop));
        }
      } else if (node.localName !== 't' || elements(node).length) unsupported(node);
    }
    const text = elements(el).filter(n => n.namespaceURI === OFFICE_MATH_NS && n.localName === 't').map(n => literal(n.textContent ?? '', normal)).join('');
    if (normal) { if (style && style !== 'p') unsupported(el); return `\\text{${text}}`; }
    if (style === 'p') return `\\mathrm{${text}}`;
    if (style === 'b') return `\\mathbf{${text}}`;
    if (style === 'bi') return `\\boldsymbol{${text}}`;
    return text;
  }
  const slots: Record<string, string[]> = { sSup: ['e', 'sup'], sSub: ['e', 'sub'], sSubSup: ['e', 'sub', 'sup'], f: ['num', 'den'], rad: ['deg', 'e'] };
  const expected = slots[tag];
  if (!expected) return unsupported(el);
  const nodes = children(el, [`${tag}Pr`, ...expected]);
  const props = nodes.filter(n => n.localName === `${tag}Pr`);
  if (props.length > 1) unsupported(el);
  for (const prop of props) properties(prop, tag === 'f' ? {type: ['bar']} : tag === 'rad' ? {degHide: ['', '1', '0', 'true', 'false', 'on', 'off']} : {});
  const operands: Record<string, string> = {};
  for (const name of expected) {
    const matches = nodes.filter(n => n.localName === name);
    if (matches.length !== 1) unsupported(el);
    operands[name] = render(matches[0]);
    if (name !== 'deg' && !operands[name]) unsupported(el);
  }
  if (tag === 'f') return `\\frac{${operands.num}}{${operands.den}}`;
  if (tag === 'rad') {
    const hide = props.flatMap(elements).find(n => n.localName === 'degHide');
    const hidden = hide && !['0', 'false', 'off'].includes(value(hide));
    if (hidden && operands.deg) unsupported(el);
    if (!hidden && !operands.deg) unsupported(el);
    return operands.deg ? `\\sqrt[${operands.deg}]{${operands.e}}` : `\\sqrt{${operands.e}}`;
  }
  return `{${operands.e}}${operands.sub !== undefined ? `_{${operands.sub}}` : ''}${operands.sup !== undefined ? `^{${operands.sup}}` : ''}`;
}

export function readOfficeMath(el: Element): string {
  let math = el;
  const display = el.localName === 'oMathPara';
  if (display) {
    const nodes = children(el, ['oMathParaPr', 'oMath']);
    for (const prop of nodes.filter(n => n.localName === 'oMathParaPr')) properties(prop, {jc: ['center', 'centerGroup', 'left', 'right']});
    const formulas = nodes.filter(n => n.localName === 'oMath');
    if (formulas.length !== 1) unsupported(el);
    math = formulas[0];
  } else if (el.localName !== 'oMath') unsupported(el);
  const latex = render(math);
  if (!latex.trim()) unsupported(el);
  if (latex.includes('$')) return display ? "\\[" + latex + "\\]" : "\\(" + latex + "\\)";
  return display ? `$$${latex}$$` : `$${latex}$`;
}
