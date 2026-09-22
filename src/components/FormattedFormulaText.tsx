import React, { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

type Props = {
  text?: string;
  className?: string;
  style?: React.CSSProperties;
};

import { parseSegments } from '../domain/formula-parser.ts';
export { parseSegments };
export type { Segment } from '../domain/formula-parser.ts';

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
              if (seg.type === 'image') {
                return (
                  <figure key={segIndex} className="preview-image-figure">
                    <div className="preview-image-box">
                      <img
                        src={seg.src}
                        alt={seg.alt || '预览图片'}
                        className="preview-image-content"
                        loading="lazy"
                        title="点击在新窗口查看原图"
                        onClick={() => {
                          if (seg.src.startsWith('data:') || seg.src.startsWith('blob:') || seg.src.startsWith('http')) {
                            const w = window.open('', '_blank');
                            if (w) {
                              w.document.write(`<!DOCTYPE html><html><head><title>${seg.alt || '原图'}</title><style>body{margin:0;background:#0f172a;display:flex;justify-content:center;align-items:center;min-height:100vh;}img{max-width:98vw;max-height:98vh;object-fit:contain;box-shadow:0 4px 20px rgba(0,0,0,0.6);border-radius:4px;}</style></head><body><img src="${seg.src}" /></body></html>`);
                              w.document.close();
                            }
                          }
                        }}
                      />
                    </div>
                    {seg.alt && <figcaption className="preview-image-caption">{seg.alt}</figcaption>}
                  </figure>
                );
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
