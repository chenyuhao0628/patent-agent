import React, { useEffect, useRef, useState } from 'react';
import { APPLICATION_PART_LABELS, type ApplicationParts } from '../domain/application-parts.ts';
import { CORRECTION_FILES, type CorrectionContent } from '../domain/correction.ts';
import type { DraftVersion } from '../domain/agent.ts';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';
import { reidentifyFormulas, wrapSelectionAsFormula } from '../domain/formula-identifier.ts';
import { Check, Edit3, Eye, Plus, RefreshCw, RotateCcw, Save, Trash2, Zap } from 'lucide-react';

type DocumentTab = 'body' | 'CLAIMS' | 'DESCRIPTION' | 'ABSTRACT' | 'basis' | 'corrections';

export function FinalizationDraftEditor({
  draft,
  isCorrection,
  busy,
  externalArtifacts,
  onSave,
  onDirtyChange,
}: {
  draft: DraftVersion;
  isCorrection: boolean;
  busy: boolean;
  externalArtifacts?: Array<{ title: string; kind: string; text?: string; relativePath: string }>;
  onSave: (payload: {
    text?: string;
    amendmentText?: string;
    applicationParts?: ApplicationParts;
    correctionContents?: CorrectionContent[];
    amendmentBasis?: string;
    reviewNotes?: string;
  }) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<DocumentTab>(() => (isCorrection ? 'corrections' : 'body'));
  const [bodyText, setBodyText] = useState(draft.text || '');
  const [appParts, setAppParts] = useState<ApplicationParts>(() => ({ ...(draft.applicationParts || {}) }));
  const [basisText, setBasisText] = useState(draft.amendmentBasis || '');
  const [corrections, setCorrections] = useState<CorrectionContent[]>(() =>
    (draft.correctionContents || []).map(c => ({ ...c }))
  );
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => () => { onDirtyChange?.(false); }, []);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('split');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync with incoming draft when version id changes
  useEffect(() => {
    setBodyText(draft.text || '');
    setAppParts({ ...(draft.applicationParts || {}) });
    setBasisText(draft.amendmentBasis || '');
    setCorrections((draft.correctionContents || []).map(c => ({ ...c })));
    setDirty(false);
    setStatusMessage('');
  }, [draft.id]);

  const activeText =
    activeTab === 'body'
      ? bodyText
      : activeTab === 'basis'
      ? basisText
      : activeTab === 'CLAIMS' || activeTab === 'DESCRIPTION' || activeTab === 'ABSTRACT'
      ? appParts[activeTab] ?? ''
      : '';

  const updateActiveText = (val: string) => {
    setDirty(true);
    setStatusMessage('');
    if (activeTab === 'body') {
      setBodyText(val);
    } else if (activeTab === 'basis') {
      setBasisText(val);
    } else if (activeTab === 'CLAIMS' || activeTab === 'DESCRIPTION' || activeTab === 'ABSTRACT') {
      setAppParts(prev => ({ ...prev, [activeTab]: val }));
    }
  };

  const handleReidentify = () => {
    if (activeTab === 'corrections') {
      let totalConverted = 0;
      const nextCorrections = corrections.map(item => {
        const b = reidentifyFormulas(item.CorrectionBefore);
        const a = reidentifyFormulas(item.CorrectionAfter);
        totalConverted += b.count + a.count;
        return {
          ...item,
          CorrectionBefore: b.text,
          CorrectionAfter: a.text,
        };
      });
      setCorrections(nextCorrections);
      setDirty(true);
      setStatusMessage(
        totalConverted > 0
          ? `已成功在补正条目中识别并转换 ${totalConverted} 处专业公式为 LaTeX 格式！`
          : '当前补正内容中未发现需要转换的未识别公式。'
      );
      return;
    }

    const { text: newText, count } = reidentifyFormulas(activeText);
    if (count > 0) {
      updateActiveText(newText);
      setStatusMessage(`已成功识别并转换 ${count} 处专业公式为标准 LaTeX 格式（带定界符）！`);
    } else {
      setStatusMessage('当前文本中未发现需要转换的新公式，或公式已有标准定界符。');
    }
  };

  const handleWrapSelection = (display = false) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const { text: newText, newCursor } = wrapSelectionAsFormula(activeText, start, end, display);
    updateActiveText(newText);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    }, 0);
  };

  const handleReset = () => {
    setBodyText(draft.text || '');
    setAppParts({ ...(draft.applicationParts || {}) });
    setBasisText(draft.amendmentBasis || '');
    setCorrections((draft.correctionContents || []).map(c => ({ ...c })));
    setDirty(false);
    setStatusMessage('已还原为当前版本原始内容。');
  };

  const handleSave = async () => {
    setSaving(true);
    setStatusMessage('');
    try {
      await onSave({
        text: bodyText,
        applicationParts: appParts,
        amendmentBasis: basisText,
        correctionContents: isCorrection ? corrections : undefined,
      });
      setDirty(false);
      setStatusMessage('已成功保存微调版本，并更新为定稿待采用稿件！');
    } catch (err) {
      setStatusMessage(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const tabs: Array<{ id: DocumentTab; label: string; activeCount?: string }> = isCorrection
    ? [
        { id: 'corrections', label: '逐条补正字段', activeCount: `${corrections.length} 条` },
        { id: 'CLAIMS', label: '权利要求书', activeCount: appParts.CLAIMS !== undefined ? '有修改' : '未修改' },
        { id: 'DESCRIPTION', label: '说明书', activeCount: appParts.DESCRIPTION !== undefined ? '有修改' : '未修改' },
        { id: 'ABSTRACT', label: '说明书摘要', activeCount: appParts.ABSTRACT !== undefined ? '有修改' : '未修改' },
        { id: 'body', label: '补正办理说明' },
      ]
    : [
        { id: 'body', label: '意见陈述书正文' },
        { id: 'CLAIMS', label: '权利要求书', activeCount: appParts.CLAIMS !== undefined ? '有修改' : '未修改' },
        { id: 'DESCRIPTION', label: '说明书', activeCount: appParts.DESCRIPTION !== undefined ? '有修改' : '未修改' },
        { id: 'ABSTRACT', label: '说明书摘要', activeCount: appParts.ABSTRACT !== undefined ? '有修改' : '未修改' },
        { id: 'basis', label: '修改依据说明' },
      ];

  return (
    <div className="agent-card finalization-editor-card">
      <div className="section-heading">
        <div>
          <h4>定稿稿件微调编辑器</h4>
          <p className="section-copy">
            在定稿前直接选择并微调本次提交稿件。支持未识别公式一键智能识别转专业公式，实时双栏排版预览。
          </p>
        </div>
        <div className="button-row">
          {dirty && (
            <button type="button" disabled={busy || saving} onClick={handleReset} title="放弃未保存的微调内容">
              <RotateCcw size={14} />
              重置
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || saving || !dirty}
            onClick={() => void handleSave()}
          >
            <Save size={14} />
            {saving ? '正在保存…' : '保存微调版本'}
          </button>
        </div>
      </div>

      <nav className="surface-switch finalization-nav" aria-label="定稿稿件切换">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            className={activeTab === t.id ? 'active' : ''}
            onClick={() => {
              setActiveTab(t.id);
              setStatusMessage('');
            }}
          >
            {t.label}
            {t.activeCount && <small className="tab-badge">（{t.activeCount}）</small>}
          </button>
        ))}
      </nav>

      {(() => {
        const currentContent = activeTab === 'body'
          ? bodyText
          : activeTab === 'basis'
          ? basisText
          : activeTab === 'corrections'
          ? ''
          : (appParts[activeTab] || '');

        const matching = (externalArtifacts || []).find(a => {
          if (!a.text) return false;
          if (activeTab === 'body' && (a.kind === 'final-word' || a.kind === 'body')) return true;
          if (activeTab === 'CLAIMS' && (a.kind === 'final-application-CLAIMS' || a.kind === 'final-amendment')) return true;
          if (activeTab === 'DESCRIPTION' && a.kind === 'final-application-DESCRIPTION') return true;
          if (activeTab === 'ABSTRACT' && a.kind === 'final-application-ABSTRACT') return true;
          if (activeTab === 'basis' && a.kind === 'final-basis') return true;
          return false;
        });

        if (!matching || !matching.text || matching.text.trim() === currentContent.trim()) return null;

        return (
          <div className="inline-warning" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0', padding: '10px 14px', borderRadius: '6px' }}>
            <div>
              <b>⚠️ 检测到外部修改：</b>外部 Word 文件「{matching.title}」内容较新。
            </div>
            <button
              type="button"
              className="primary"
              disabled={busy || saving}
              onClick={() => {
                if (activeTab === 'body') setBodyText(matching.text!);
                else if (activeTab === 'basis') setBasisText(matching.text!);
                else if (activeTab !== 'corrections') setAppParts(prev => ({ ...prev, [activeTab]: matching.text! }));
                setDirty(true);
                setStatusMessage(`已载入「${matching.title}」的外部修改，可核对排版后保存为新版本。`);
              }}
            >
              📥 载入外部修改到编辑器
            </button>
          </div>
        );
      })()}

      {statusMessage && (
        <p className={`settings-notice ${statusMessage.includes('失败') ? 'is-error' : 'is-success'}`} role="status">
          {statusMessage}
        </p>
      )}

      <div className="finalization-toolbar">
        <div className="toolbar-left">
          <button
            type="button"
            className="btn-formula-reid"
            disabled={busy || saving}
            onClick={handleReidentify}
            title="自动扫描文本中的数学与化学表达式，转换为带定界符的标准专业公式"
          >
            <Zap size={14} />
            ⚡ 重新识别公式
          </button>
          {activeTab !== 'corrections' && (
            <>
              <button
                type="button"
                disabled={busy || saving}
                onClick={() => handleWrapSelection(false)}
                title="将选中文本标记为行内公式 $...$"
              >
                行内公式 $
              </button>
              <button
                type="button"
                disabled={busy || saving}
                onClick={() => handleWrapSelection(true)}
                title="将选中文本标记为块级展示公式 $$...$$"
              >
                块级公式 $$
              </button>
            </>
          )}
        </div>
        <div className="toolbar-right">
          <div className="view-mode-switch" role="group" aria-label="排版预览模式">
            <button
              type="button"
              className={viewMode === 'split' ? 'active' : ''}
              onClick={() => setViewMode('split')}
              title="双栏并排：左侧编辑，右侧 KaTeX 实时公式渲染"
            >
              双栏对比
            </button>
            <button
              type="button"
              className={viewMode === 'edit' ? 'active' : ''}
              onClick={() => setViewMode('edit')}
              title="纯编辑模式"
            >
              <Edit3 size={13} />
              纯编辑
            </button>
            <button
              type="button"
              className={viewMode === 'preview' ? 'active' : ''}
              onClick={() => setViewMode('preview')}
              title="排版与公式预览"
            >
              <Eye size={13} />
              排版预览
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'corrections' ? (
        <div className="finalization-corrections-editor">
          <p className="muted">
            逐条核对补正条目。补正前和补正后均支持公式智能识别。
          </p>
          {corrections.map((row, idx) => (
            <div key={idx} className="correction-row">
              <div className="section-heading">
                <b>条目 {idx + 1}</b>
                <button
                  type="button"
                  disabled={busy || saving}
                  onClick={() => {
                    setCorrections(corrections.filter((_, i) => i !== idx));
                    setDirty(true);
                  }}
                >
                  <Trash2 size={13} />
                  移除
                </button>
              </div>
              <div className="form-grid">
                <label className="field">
                  文件名称
                  <select
                    value={row.FileName}
                    disabled={busy || saving}
                    onChange={e => {
                      const next = [...corrections];
                      next[idx] = { ...next[idx], FileName: e.target.value };
                      setCorrections(next);
                      setDirty(true);
                    }}
                  >
                    {(CORRECTION_FILES.includes(row.FileName) ? CORRECTION_FILES : [row.FileName, ...CORRECTION_FILES]).map(n => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  具体位置
                  <input
                    value={row.PositionInFile}
                    disabled={busy || saving}
                    placeholder="如：权利要求 1 第 3 行"
                    onChange={e => {
                      const next = [...corrections];
                      next[idx] = { ...next[idx], PositionInFile: e.target.value };
                      setCorrections(next);
                      setDirty(true);
                    }}
                  />
                </label>
              </div>
              <div className="correction-diff-grid">
                <div className="correction-diff-box">
                  <label className="field">
                    补正前
                    <textarea
                      rows={3}
                      value={row.CorrectionBefore}
                      disabled={busy || saving}
                      onChange={e => {
                        const next = [...corrections];
                        next[idx] = { ...next[idx], CorrectionBefore: e.target.value };
                        setCorrections(next);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <div className="diff-live-preview">
                    <FormattedFormulaText text={row.CorrectionBefore} />
                  </div>
                </div>
                <div className="correction-diff-box">
                  <label className="field">
                    补正后
                    <textarea
                      rows={3}
                      value={row.CorrectionAfter}
                      disabled={busy || saving}
                      onChange={e => {
                        const next = [...corrections];
                        next[idx] = { ...next[idx], CorrectionAfter: e.target.value };
                        setCorrections(next);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <div className="diff-live-preview">
                    <FormattedFormulaText text={row.CorrectionAfter} />
                  </div>
                </div>
              </div>
            </div>
          ))}
          <button
            type="button"
            disabled={busy || saving}
            onClick={() => {
              setCorrections([
                ...corrections,
                {
                  FileName: '权利要求书',
                  PositionInFile: '',
                  CorrectionBefore: '',
                  CorrectionAfter: '',
                },
              ]);
              setDirty(true);
            }}
          >
            <Plus size={14} />
            增加补正条目
          </button>
        </div>
      ) : (
        <div className={`finalization-workspace is-${viewMode}`}>
          {viewMode !== 'preview' && (
            <div className="finalization-edit-pane">
              {(activeTab === 'CLAIMS' || activeTab === 'DESCRIPTION' || activeTab === 'ABSTRACT') && (
                <div className="part-toggle-bar">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={appParts[activeTab] !== undefined}
                      disabled={busy || saving}
                      onChange={e => {
                        const next = { ...appParts };
                        if (e.target.checked) next[activeTab] = '';
                        else delete next[activeTab];
                        setAppParts(next);
                        setDirty(true);
                      }}
                    />
                    <span>
                      本次修改包含<b>{APPLICATION_PART_LABELS[activeTab]}</b>（取消勾选表示本次不修改）
                    </span>
                  </label>
                </div>
              )}
              <textarea
                ref={textareaRef}
                className="finalization-textarea"
                value={activeText}
                disabled={busy || saving || (activeTab.startsWith('C') && appParts[activeTab as keyof ApplicationParts] === undefined)}
                placeholder={
                  activeTab === 'body'
                    ? '在此编辑意见陈述书全文，公式微调后可点击上方“⚡ 重新识别公式”自动转为专业数学公式…'
                    : `在此填写修改后的${APPLICATION_PART_LABELS[activeTab as keyof ApplicationParts] || ''}完整正文…`
                }
                onChange={e => updateActiveText(e.target.value)}
              />
            </div>
          )}

          {viewMode !== 'edit' && (
            <div className="finalization-preview-pane">
              <div className="preview-pane-header">
                <span>实时排版与 KaTeX 专业公式渲染</span>
                <small>{activeText.length} 字符</small>
              </div>
              <div className="preview-pane-content">
                {activeText.trim() ? (
                  <FormattedFormulaText text={activeText} className="agent-preview" />
                ) : (
                  <p className="muted">暂无内容。在左侧输入或粘贴正文后，在此实时预览排版与公式。</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
