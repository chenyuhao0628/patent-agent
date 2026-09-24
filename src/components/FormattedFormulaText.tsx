import React, { useMemo, useState, useEffect } from 'react';
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

function isSafeImageSrc(src: string): boolean {
  return /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|bmp|svg\+xml);base64,|blob:)/i.test(src);
}

export function FormattedFormulaText({ text, className = 'text-preview', style }: Props) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightbox]);

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
                const safe = isSafeImageSrc(seg.src);
                return (
                  <figure key={segIndex} className="preview-image-figure">
                    <div className="preview-image-box">
                      <img
                        src={safe ? seg.src : ''}
                        alt={seg.alt || '预览图片'}
                        className="preview-image-content"
                        loading="lazy"
                        title={safe ? '点击全屏查看大图' : '不支持的图片来源'}
                        onClick={() => {
                          if (safe) {
                            setLightbox({ src: seg.src, alt: seg.alt || '原图' });
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
      {lightbox && (
        <div
          className="image-lightbox-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="图片全屏预览"
          onClick={() => setLightbox(null)}
        >
          <div className="image-lightbox-modal" onClick={e => e.stopPropagation()}>
            <div className="image-lightbox-header">
              <span className="image-lightbox-title">{lightbox.alt || '原图预览'}</span>
              <button
                type="button"
                className="icon-button image-lightbox-close"
                onClick={() => setLightbox(null)}
                aria-label="关闭预览"
              >
                ✕
              </button>
            </div>
            <div className="image-lightbox-body">
              <img src={lightbox.src} alt={lightbox.alt || '原图预览'} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
