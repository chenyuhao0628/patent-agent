import type { Case } from '../src/domain/workflow.ts';
import { projectReplyView, type CaseReplyView } from '../src/domain/case-view.ts';
import type { OpenClassification } from '../src/domain/agent.ts';
import { currentWork } from '../src/domain/lifecycle.ts';

export type ClassificationSuggestion = {
  classification: OpenClassification;
  evidence: string[];
  warnings: string[];
};

function numberOf(text: string): number | undefined {
  const compact = text.replace(/\s/g, '');
  const raw = /第([一二三四五六七八九十百\d]+)(?:次|轮|通)/.exec(compact)?.[1]
    ?? /(?:答复)?审查意见(?:通知书)?[（(]([一二三四五六七八九十百\d]+)[)）]/.exec(compact)?.[1];
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) > 0 && Number(raw) < 100 ? Number(raw) : undefined;
  const single: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (single[raw]) return single[raw];
  if (raw.includes('十')) { const [a, b] = raw.split('十'); return (single[a] || 1) * 10 + (single[b] || 0); }
}

export function classificationSuggestion(c: Case, notices: Array<{ name: string; text: string; read?: boolean }> = []): ClassificationSuggestion {
  return classificationSuggestionForView(projectReplyView(c), notices);
}

export function classificationSuggestionForView(c: CaseReplyView, notices: Array<{ name: string; text: string; read?: boolean }> = []): ClassificationSuggestion {
  const current = c.stage.current;
  const proc = c.processes.find(p => p.id === current.processId);
  const round = c.manuscripts.replyRounds.find(r => r.id === current.roundId || r.id === `proc-${current.processId}`);
  const sources = [
    ...(proc ? [{ name: '贝思兰德当前流程', text: proc.name }] : []),
    ...(round ? [{ name: '当前通知轮次', text: round.name }] : []),
    ...notices,
  ];
  const evidence: string[] = [], warnings: string[] = [];
  const classification: OpenClassification = { status: 'unclassified' };
  if (c.identity.type === '发明' || c.identity.type === '实用新型') {
    classification.patentType = c.identity.type;
    evidence.push(`案件专利类型：${c.identity.type}`);
  } else warnings.push('案件未提供明确专利类型，请核对。');
  const categories = new Set<string>();
  const rounds = new Set<number>();
  for (const source of sources) {
    // Only inspect the notice header for category/round; body references often mention older notices.
    const header = source.text.slice(0, 800).replace(/\s/g, '');
    const match = /(?:第[一二三四五六七八九十百\d]+次)?(?:审查意见(?:通知书)?|补正(?:通知书)?)/.exec(header);
    if (match) {
      const category = match[0].includes('补正') ? '补正通知书' : '审查意见通知书';
      categories.add(category);
      const n = numberOf(header.slice(Math.max(0, match.index - 8), match.index + match[0].length + 8));
      if (category === '审查意见通知书' && n) rounds.add(n);
      evidence.push(`${source.name}${source.read ? '（本机读取首页 / 前段）' : ''}：${match[0]}${n ? ` · 第 ${n} 次` : ''}`);
    }
  }
  if (categories.size === 1) classification.noticeCategory = [...categories][0] as OpenClassification['noticeCategory'];
  else if (categories.size > 1) warnings.push('流程与通知内容的类别不一致，已留空等待你核对。');
  else if (current.kind === 'reply' || current.kind === 'correction') {
    classification.noticeCategory = current.kind === 'reply' ? '审查意见通知书' : '补正通知书';
    evidence.push(`当前办理业务：${current.kind === 'reply' ? '审查意见答复' : '补正'}`);
  } else warnings.push('当前业务无法确定通知类别。');
  if (rounds.size === 1) classification.officeActionRound = [...rounds][0];
  else if (rounds.size > 1) warnings.push('流程与通知的审查次数不一致，已留空等待核对。');
  else if (classification.noticeCategory === '审查意见通知书') warnings.push('没有识别到明确的审查次数，请核对通知书。');
  if (classification.noticeCategory === '补正通知书') {
    classification.officeActionRound = 1;
    const history = c.manuscripts.replyRounds.filter(r => r !== round && /审查意见/.test(r.name));
    const completed = history.filter(r => r.final || r.finalHistory?.length || c.processes.find(p => r.id === `proc-${p.id}`)?.submission?.state === 'received');
    const candidates = completed.map(r => numberOf(r.name)).filter((n): n is number => !!n);
    classification.correctionBasis = candidates.length ? `round_${Math.max(...candidates)}` : 'original';
    evidence.push(candidates.length ? `补正基线建议：已有第 ${Math.max(...candidates)} 轮答复记录` : '补正基线建议：未见已完成答复记录，使用原始申请');
    warnings.push('请确认本次补正针对的实际提交版本，历史记录只作为基线建议。');
  } else classification.correctionBasis = 'original';
  return { classification, evidence, warnings };
}
