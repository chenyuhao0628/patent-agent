import katex from 'katex';

export type Segment =
  | { type: 'text'; content: string }
  | { type: 'inline-math'; content: string }
  | { type: 'display-math'; content: string }
  | { type: 'image'; alt: string; src: string };

export function parseSegments(text: string): Segment[] {
  if (!text) return [];
  const segments: Segment[] = [];
  const pattern = /(?:!\[([^\]]*)\]\(([^)]+)\))|\\\$|(?:\$\$([\s\S]+?)\$\$)|(?:\\\[([\s\S]+?)\\\])|(?:\$([^\$\n\r]+?)\$)|(?:\\\(([\s\S]+?)\\\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    const matchedStr = match[0];
    if (match[1] !== undefined && match[2] !== undefined) {
      segments.push({ type: 'image', alt: match[1], src: match[2] });
    } else if (matchedStr === '\\$') {
      segments.push({ type: 'text', content: '$' });
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const formula = (match[3] ?? match[4] ?? '').trim();
      if (formula) segments.push({ type: 'display-math', content: formula });
    } else if (match[5] !== undefined || match[6] !== undefined) {
      const formula = (match[5] ?? match[6] ?? '').trim();
      if (formula) segments.push({ type: 'inline-math', content: formula });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  // Fallback: If single text segment is a bare data URL or naked formula
  if (segments.length === 1 && segments[0].type === 'text') {
    const trimmed = segments[0].content.trim();
    if (trimmed.startsWith('data:image/')) {
      return [{ type: 'image', alt: '预览附图', src: trimmed }];
    }
    if (isLikelyNakedFormula(trimmed)) {
      return [{ type: 'display-math', content: trimmed }];
    }
  }

  return segments;
}

export function isLikelyNakedFormula(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 500) return false;
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return false;
  if (/^(?:const|let|var|function|def|import|export|class|public|private|return|if|for|while|type|interface)\b/i.test(trimmed)) return false;
  if (/^(?:where|wherein|step|note|case|let|assuming|then|because|since|if)\b/i.test(trimmed)) return false;
  const hasRelation = /[=≠≤≥]|\\le\b|\\ge\b|\\neq\b|\\approx\b|\\sim\b|\\propto\b/.test(trimmed);
  if (!hasRelation) return false;
  const hasMathSymbols = /[∑∏∫±×÷·≠≤≥√∞∂∇∈∉⊂⊆∪∩∧∨¬]/.test(trimmed);
  const hasLatexMacro = /\\[a-zA-Z]+/.test(trimmed);
  const hasMathFunc = /\b(?:exp|norm|log|ln|sin|cos|tan|det|dim|max|min|arg)\s*\(/i.test(trimmed);
  const hasIndexedVar = /\b[A-Za-z]+_[a-zA-Z0-9{}]+|\b[A-Za-z]+\^[a-zA-Z0-9{}]/.test(trimmed);
  if (!hasMathSymbols && !hasLatexMacro && !hasMathFunc && !hasIndexedVar) return false;
  try {
    const html = katex.renderToString(trimmed, { throwOnError: false });
    if (html.includes('katex-error')) return false;
  } catch {
    return false;
  }
  return true;
}
