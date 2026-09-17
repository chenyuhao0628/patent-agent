import React, { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

type Props = {
  text?: string;
  className?: string;
  style?: React.CSSProperties;
};

type Segment =
  | { type: 'text'; content: string }
  | { type: 'inline-math'; content: string }
  | { type: 'display-math'; content: string };

function parseSegments(text: string): Segment[] {
  if (!text) return [];
  const segments: Segment[] = [];
  const pattern = /\\\$|(?:\$\$([\s\S]+?)\$\$)|(?:\\\[([\s\S]+?)\\\])|(?:\$([^\$\n\r]+?)\$)|(?:\\\(([\s\S]+?)\\\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    const matchedStr = match[0];
    if (matchedStr === '\\$') {
      segments.push({ type: 'text', content: '$' });
    } else if (match[1] !== undefined || match[2] !== undefined) {
      const formula = (match[1] ?? match[2] ?? '').trim();
      if (formula) segments.push({ type: 'display-math', content: formula });
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const formula = (match[3] ?? match[4] ?? '').trim();
      if (formula) segments.push({ type: 'inline-math', content: formula });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  // Fallback: If no delimiters were found and the single line is a naked formula, promote it to display-math
  if (segments.length === 1 && segments[0].type === 'text' && isLikelyNakedFormula(segments[0].content)) {
    return [{ type: 'display-math', content: segments[0].content.trim() }];
  }

  return segments;
}

function isLikelyNakedFormula(text: string): boolean {
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

function renderMathHtml(formula: string, display: boolean): string {
  try {
    return katex.renderToString(formula, {
      displayMode: display,
      throwOnError: false,
    });
  } catch {
    return `<span class="formula-fallback">${display ? `$$${formula}$$` : `$${formula}$`}</span>`;
  }
}

export function FormattedFormulaText({ text, className = 'text-preview', style }: Props) {
  const elements = useMemo(() => {
    if (!text) return null;
    const lines = text.split('\n');

    return lines.map((line, lineIndex) => {
      const segments = parseSegments(line);

      return (
        <div key={lineIndex} className="formula-text-line">
          {segments.length === 0 ? (
            <br />
          ) : (
            segments.map((seg, segIndex) => {
              if (seg.type === 'text') {
                return <span key={segIndex}>{seg.content}</span>;
              }
              const isDisplay = seg.type === 'display-math';
              const html = renderMathHtml(seg.content, isDisplay);

              return (
                <span
                  key={segIndex}
                  className={isDisplay ? 'formula-block-wrap' : 'formula-inline-wrap'}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              );
            })
          )}
        </div>
      );
    });
  }, [text]);

  return (
    <div className={`formatted-formula-text ${className}`} style={style}>
      {elements}
    </div>
  );
}
