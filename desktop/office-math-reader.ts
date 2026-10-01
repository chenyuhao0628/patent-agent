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
  const mathEscapes: Record<string, string> = {"\\": "\\text{\\textbackslash{}}", "^": "\\text{\\textasciicircum{}}", "~": "\\text{\\textasciitilde{}}", "{": "\\{", "}": "\\}", "_": "\\text{\\_}", "%": "\\text{\\%}", "&": "\\text{\\&}", "#": "\\text{\\#}", "$": "\\text{\\$}", "\u0020": "\\ ", "\u00a0": "\\ "};
  return Array.from(text).map(c => (normal ? textEscapes : mathEscapes)[c] ?? c).join('');
}
const CONTENT = ['r', 'sSup', 'sSub', 'sSubSup', 'f', 'rad', 'nary', 'acc', 'limLow', 'limUpp', 'm'];
const PROP_NODES = new Set(['rPr', 'ctrlPr', 'argPr']);
/** Math content container: operands and (from some writers) bare literal text between runs. */
function sequence(el: Element, allowed = CONTENT): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) { out += literal(node.textContent ?? '', false); continue; }
    if (node.nodeType !== 1) return unsupported(node as Element);
    const child = node as Element;
    if (child.namespaceURI !== OFFICE_MATH_NS) return unsupported(child);
    if (child.localName === 'argPr') { properties(child, { scrLvl: ['0', '1', '2', '3', '4'] }); continue; }
    if (PROP_NODES.has(child.localName)) { properties(child, {}); continue; }
    if (!allowed.includes(child.localName)) return unsupported(child);
    out += render(child);
  }
  return out;
}
// N-ary operator glyphs OfficeMath uses for sum/product/integral families.
const NARY_COMMANDS: Record<string, string> = {"∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∮": "\\oint", "∬": "\\iint", "∭": "\\iiint", "⋃": "\\bigcup", "⋂": "\\bigcap", "⋁": "\\bigvee", "⋀": "\\bigwedge", "⨁": "\\bigoplus", "⨂": "\\bigotimes", "⨀": "\\bigodot"};
const ACCENT_COMMANDS: Record<string, string> = {"‾": "\\overline", "―": "\\overline", "⃗": "\\vec", "̂": "\\hat", "^": "\\hat", "̃": "\\tilde", "~": "\\tilde", "̇": "\\dot", "̈": "\\ddot", "̌": "\\check", "́": "\\acute", "̆": "\\breve", "̊": "\\mathring", "⃛": "\\dddot"};
const MATRIX_PROPS = new Set(['mPr', 'mcs', 'mc', 'mcPr', 'count', 'mcJc', 'baseJc', 'plcHide', 'rSp', 'rSpRule', 'cGp', 'cSp']);
function matrixProperties(el: Element): void {
  for (const node of elements(el)) {
    if (node.namespaceURI !== OFFICE_MATH_NS || !MATRIX_PROPS.has(node.localName) || node.localName === 'begChr' || node.localName === 'sepChr' || node.localName === 'endChr') unsupported(node);
    matrixProperties(node);
  }
}
function render(el: Element): string {
  if (el.namespaceURI !== OFFICE_MATH_NS) return unsupported(el);
  const tag = el.localName;
  if (['oMath', 'e', 'num', 'den', 'sub', 'sup', 'deg'].includes(tag)) {
    return sequence(el);
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
  if (tag === 'nary') {
    const nodes = children(el, ['naryPr', 'sub', 'sup', 'e']);
    const props = nodes.filter(n => n.localName === 'naryPr');
    if (props.length > 1) unsupported(el);
    let chr = '', subHidden = false, supHidden = false;
    for (const prop of props) {
      for (const node of elements(prop)) {
        const v = value(node);
        if (elements(node).length) unsupported(node);
        if (node.localName === 'chr') chr = v;
        else if (node.localName === 'limLoc') { if (!['undOvr', 'subSup'].includes(v)) unsupported(node); }
        else if (node.localName === 'grow') { if (!['', '0', '1', 'true', 'false', 'on', 'off'].includes(v)) unsupported(node); }
        else if (node.localName === 'subHide') subHidden = !['0', 'false', 'off'].includes(v);
        else if (node.localName === 'supHide') supHidden = !['0', 'false', 'off'].includes(v);
        else unsupported(node);
      }
    }
    // OMML 的 nary 默认运算符是 ∫；其余字符必须在已知映射内。
    const command = chr ? NARY_COMMANDS[chr] : '\\int';
    if (!command) unsupported(el);
    const one = (name: string) => nodes.filter(n => n.localName === name);
    const subs = one('sub'), sups = one('sup'), bodies = one('e');
    if (subs.length > 1 || sups.length > 1 || bodies.length !== 1) unsupported(el);
    const operand = (nodes: Element[], hidden: boolean, wrap: string): string => {
      if (!nodes.length) return '';
      const text = sequence(nodes[0]);
      // 被隐藏却仍有内容的上下限无法无损表达，失败关闭。
      if (hidden && text.trim()) unsupported(el);
      return text.trim() ? wrap.replace('{}', `{${text}}`) : '';
    };
    return command + operand(subs, subHidden, '_{}') + operand(sups, supHidden, '^{}') + sequence(bodies[0]);
  }
  if (tag === 'acc') {
    const nodes = children(el, ['accPr', 'e']);
    const props = nodes.filter(n => n.localName === 'accPr');
    if (props.length > 1) unsupported(el);
    let chr = '';
    for (const prop of props) {
      for (const node of elements(prop)) {
        if (node.localName === 'chr' && !elements(node).length) chr = value(node);
        else if (node.localName !== 'ctrlPr') unsupported(node);
        else for (const inner of elements(node)) if (inner.namespaceURI !== W || inner.localName !== 'rPr') unsupported(inner);
      }
    }
    const command = ACCENT_COMMANDS[chr];
    if (!command) unsupported(el);
    const bodies = nodes.filter(n => n.localName === 'e');
    if (bodies.length !== 1) unsupported(el);
    const body = sequence(bodies[0]);
    if (!body.trim()) unsupported(el);
    return `${command}{${body}}`;
  }
  if (tag === 'limLow' || tag === 'limUpp') {
    const nodes = children(el, [`${tag}Pr`, 'e', 'lim']);
    for (const prop of nodes.filter(n => n.localName === `${tag}Pr`)) properties(prop, {});
    const bases = nodes.filter(n => n.localName === 'e'), limits = nodes.filter(n => n.localName === 'lim');
    if (bases.length !== 1 || limits.length !== 1) unsupported(el);
    const base = sequence(bases[0]), limit = sequence(limits[0]);
    if (!base.trim() || !limit.trim()) unsupported(el);
    return `${base}${tag === 'limLow' ? '_' : '^'}{${limit}}`;
  }
  if (tag === 'm') {
    const nodes = children(el, ['mPr', 'mr']);
    for (const prop of nodes.filter(n => n.localName === 'mPr')) matrixProperties(prop);
    const rows = nodes.filter(n => n.localName === 'mr');
    if (!rows.length) unsupported(el);
    const rendered = rows.map(row => {
      const cells = children(row, ['e']);
      return cells.map(cell => sequence(cell).trim()).join(' & ');
    });
    return `\\begin{matrix}${rendered.join(' \\\\ ')}\\end{matrix}`;
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
