import katex from 'katex';
import { mml2omml } from 'mathml2omml';

export type TextSegment =
  | { type: 'text'; content: string }
  | { type: 'inline-math'; content: string }
  | { type: 'display-math'; content: string };

/**
 * Split text into regular text and LaTeX formula segments.
 * Supports:
 * - Block/Display math: $$...$$ or \[...\]
 * - Inline math: $...$ or \(...\)
 * - Escaped dollar: \$ -> literal $
 */
export function splitTextAndFormulas(text: string): TextSegment[] {
  if (!text) return [];
  const segments: TextSegment[] = [];

  const pattern = /\\\$|(?:\$\$([\s\S]+?)\$\$)|(?:\\\[([\s\S]+?)\\\])|(?:\$([^\$\n\r]+?)\$)|(?:\\\(([\s\S]+?)\\\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    const matchedStr = match[0];
    if (matchedStr === '\\$') {
      // Escaped dollar
      segments.push({ type: 'text', content: '$' });
    } else if (match[1] !== undefined || match[2] !== undefined) {
      // Display math
      const formula = (match[1] ?? match[2] ?? '').trim();
      if (formula) {
        segments.push({ type: 'display-math', content: formula });
      }
    } else if (match[3] !== undefined || match[4] !== undefined) {
      // Inline math
      const formula = (match[3] ?? match[4] ?? '').trim();
      if (formula) {
        segments.push({ type: 'inline-math', content: formula });
      }
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  // Merge adjacent text segments if any
  const merged: TextSegment[] = [];
  for (const seg of segments) {
    const prev = merged.at(-1);
    if (prev && prev.type === 'text' && seg.type === 'text') {
      prev.content += seg.content;
    } else {
      merged.push({ ...seg });
    }
  }

  // Fallback: If no delimiters were found and the single line is a naked formula, promote it to display-math
  if (merged.length === 1 && merged[0].type === 'text' && isLikelyNakedFormula(merged[0].content)) {
    return [{ type: 'display-math', content: merged[0].content.trim() }];
  }

  return merged;
}

/**
 * Detect whether a standalone line looks like an un-delimited mathematical formula.
 * Fallback mechanism for when models or users omit $$ or $ delimiters.
 */
export function isLikelyNakedFormula(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 500) return false;
  // Must NOT contain Chinese characters
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return false;
  // Must NOT start with programming language keywords
  if (/^(?:const|let|var|function|def|import|export|class|public|private|return|if|for|while|type|interface)\b/i.test(trimmed)) return false;
  // Must NOT start with English prose keywords
  if (/^(?:where|wherein|step|note|case|let|assuming|then|because|since|if)\b/i.test(trimmed)) return false;
  // Must contain an equality, inequality or relation operator
  const hasRelation = /[=≠≤≥]|\\le\b|\\ge\b|\\neq\b|\\approx\b|\\sim\b|\\propto\b/.test(trimmed);
  if (!hasRelation) return false;
  // Must have distinctive mathematical markers
  const hasMathSymbols = /[∑∏∫±×÷·≠≤≥√∞∂∇∈∉⊂⊆∪∩∧∨¬]/.test(trimmed);
  const hasLatexMacro = /\\[a-zA-Z]+/.test(trimmed);
  const hasMathFunc = /\b(?:exp|norm|log|ln|sin|cos|tan|det|dim|max|min|arg)\s*\(/i.test(trimmed);
  const hasIndexedVar = /\b[A-Za-z]+_[a-zA-Z0-9{}]+|\b[A-Za-z]+\^[a-zA-Z0-9{}]/.test(trimmed);
  if (!hasMathSymbols && !hasLatexMacro && !hasMathFunc && !hasIndexedVar) return false;
  // Verify that KaTeX can parse without syntax error
  try {
    const html = katex.renderToString(trimmed, { throwOnError: false });
    if (html.includes('katex-error')) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Convert a LaTeX formula to Microsoft Word OMML (Office Math) XML.
 * Returns null if conversion fails or input is invalid.
 */
export function latexToOmml(latex: string, display = false): string | null {
  const cleanLatex = latex.trim();
  if (!cleanLatex) return null;

  try {
    let mathml = katex.renderToString(cleanLatex, {
      output: 'mathml',
      throwOnError: false,
      displayMode: display,
    });

    const match = mathml.match(/<math[\s\S]*?<\/math>/);
    if (!match) return null;

    // Remove katex annotations which are not needed for OMML
    const cleanMathml = match[0].replace(/<annotation[\s\S]*?<\/annotation>/g, '');
    const omml = mml2omml(cleanMathml);
    if (!omml || !omml.includes('<m:oMath')) return null;

    if (display) {
      return `<m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${omml}</m:oMathPara>`;
    }
    return omml;
  } catch {
    return null;
  }
}
