import {validateCorrectionContents} from '../src/domain/correction.ts';
import { validateApplicationParts } from '../src/domain/application-parts.ts';
import type { AgentAction, AgentFailure, JobArtifact } from '../src/domain/agent.ts';
import { agentFail } from '../src/domain/agent.ts';

export type ParseArtifactExpect = {
  kind: AgentAction;
  strategyId?: string;
  draftVersionId?: string;
};

export type ParseArtifactResult = { ok: true; artifact: JobArtifact } | AgentFailure;

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function extractJsonText(raw: string): AgentFailure | string {
  if (typeof raw !== 'string') return agentFail('ARTIFACT_INVALID', '产物不是文本。');
  const trimmed = raw.trim();
  if (!trimmed) return agentFail('ARTIFACT_INVALID', '产物为空。');
  if (trimmed.startsWith('```')) {
    const firstNl = trimmed.search(/\r?\n/);
    if (firstNl === -1) return agentFail('ARTIFACT_INVALID', '产物 JSON 围栏未结束，不能从残缺文本猜测结束。');
    const rest = trimmed.slice(firstNl + (trimmed[firstNl] === '\r' ? 2 : 1));
    const closeRel = rest.indexOf('\n```');
    const closeAtEnd = rest.endsWith('```') ? rest.lastIndexOf('```') : -1;
    const close = closeRel >= 0 ? closeRel : closeAtEnd;
    if (close < 0) return agentFail('ARTIFACT_INVALID', '产物 JSON 围栏未结束，不能从残缺文本猜测结束。');
    const inner = rest.slice(0, closeRel >= 0 ? closeRel : closeAtEnd);
    const after = (closeRel >= 0 ? rest.slice(closeRel + 4) : '').trim();
    if (after) return agentFail('ARTIFACT_INVALID', 'JSON 围栏结束后仍有文本，不能猜测有效产物范围。');
    if (inner.includes('```')) return agentFail('ARTIFACT_INVALID', '产物包含多段 JSON 围栏，不能猜测哪一段有效。');
    return inner.trim();
  }
  return trimmed;
}

function asRecord(value: unknown): AgentFailure | Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return agentFail('ARTIFACT_INVALID', '产物 JSON 必须是对象。');
  }
  return value as Record<string, unknown>;
}

function parseAnalysis(record: Record<string, unknown>): ParseArtifactResult {
  return { ok: true, artifact: { kind: 'analysis', opinions: record.opinions as never, strategies: record.strategies as never, modelSelectedStrategyId: filled(record.modelSelectedStrategyId) ? record.modelSelectedStrategyId.trim() : undefined } };
}

export function parseAgentArtifact(raw: string, expect: ParseArtifactExpect): ParseArtifactResult {
  const extracted = extractJsonText(raw);
  if (typeof extracted !== 'string') return extracted;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return agentFail('ARTIFACT_INVALID', '产物不是合法 JSON，未执行表达式，已拒绝。');
  }
  const record = asRecord(parsed);
  if ('ok' in record && (record as AgentFailure).ok === false && 'error' in record) return record as AgentFailure;
  const obj = record as Record<string, unknown>;
  if (obj.kind !== expect.kind) return agentFail('ARTIFACT_INVALID', '产物类型与当前任务不一致。');

  if (expect.kind === 'analysis') {
    if (!Array.isArray(obj.opinions) || obj.opinions.length < 1) return agentFail('ARTIFACT_INVALID', '分析结果必须包含通知意见拆解。');
    if (!Array.isArray(obj.strategies) || obj.strategies.length < 2) return agentFail('ARTIFACT_INVALID', '分析结果必须包含至少两个可供选择的策略。');
    for (const item of obj.opinions) {
      if (!item || typeof item !== 'object') return agentFail('ARTIFACT_INVALID', '意见拆解格式无效。');
      const row = item as Record<string, unknown>;
      if (!filled(row.id) || !filled(row.title) || !filled(row.summary) || !filled(row.basis)) {
        return agentFail('ARTIFACT_INVALID', '意见拆解必须包含编号、标题、摘要和材料依据。');
      }
    }
    for (const item of obj.strategies) {
      if (!item || typeof item !== 'object') return agentFail('ARTIFACT_INVALID', '策略格式无效。');
      const row = item as Record<string, unknown>;
      if (!filled(row.id) || !filled(row.title) || !filled(row.summary) || !filled(row.benefits) || !filled(row.risks) || !filled(row.basis)) {
        return agentFail('ARTIFACT_INVALID', '策略必须包含编号、标题、摘要、收益、风险和材料依据。');
      }
    }
    return parseAnalysis(obj);
  }

  if (expect.kind === 'discuss') {
    if (!filled(obj.reply)) return agentFail('ARTIFACT_INVALID', '讨论产物缺少回复文本。');
    return { ok: true, artifact: { kind: 'discuss', reply: obj.reply.trim() } };
  }

  if (expect.kind === 'review') {
    if (!filled(obj.draftVersionId) || !filled(obj.summary) || !Array.isArray(obj.issues)) {
      return agentFail('ARTIFACT_INVALID', '复核结果必须包含稿件版本、摘要和 issues 列表。');
    }
    if (expect.draftVersionId && obj.draftVersionId.trim() !== expect.draftVersionId) {
      return agentFail('DRAFT_VERSION_MISMATCH');
    }
    for (const item of obj.issues) {
      if (!item || typeof item !== 'object') return agentFail('ARTIFACT_INVALID', '复核问题格式无效。');
      const row = item as Record<string, unknown>;
      if (!filled(row.id) || !filled(row.finding) || !filled(row.basis) || !filled(row.suggestion)) {
        return agentFail('ARTIFACT_INVALID', '复核问题必须包含编号、发现、依据和建议。');
      }
      if (row.severity !== 'error' && row.severity !== 'warning' && row.severity !== 'info') {
        return agentFail('ARTIFACT_INVALID', '复核问题严重程度无效。');
      }
    }
    return {
      ok: true,
      artifact: {
        kind: 'review',
        draftVersionId: obj.draftVersionId.trim(),
        summary: obj.summary.trim(),
        issues: (obj.issues as Array<Record<string, unknown>>).map(row => ({
          id: String(row.id).trim(),
          severity: row.severity as 'error' | 'warning' | 'info',
          finding: String(row.finding).trim(),
          basis: String(row.basis).trim(),
          suggestion: String(row.suggestion).trim(),
        })),
      },
    };
  }

  if (expect.kind === 'draft' || expect.kind === 'revise') {
    if(obj.correctionContents!==undefined)try{obj.correctionContents=validateCorrectionContents(obj.correctionContents);}catch(e){return agentFail('ARTIFACT_INVALID',(e as Error).message);}
    if(obj.applicationParts!==undefined)try{obj.applicationParts=validateApplicationParts(obj.applicationParts);}catch(e){return agentFail('ARTIFACT_INVALID',(e as Error).message);}
    if (!filled(obj.body) || !filled(obj.amendmentText) || !filled(obj.amendmentBasis) || !filled(obj.reviewNotes) || !filled(obj.strategyId)) {
      return agentFail('ARTIFACT_INVALID', '起草产物必须将正文、建议修改文本、修改依据与内部复核说明分开并写明。');
    }
    if (expect.strategyId && obj.strategyId.trim() !== expect.strategyId) {
      return agentFail('STRATEGY_INVALID', expect.kind === 'revise'
        ? '修改稿不能自动更换策略。如需更换，请用户重新选定。'
        : '起草结果中的策略与用户选定不一致，已拒绝该结果。');
    }
    return {
      ok: true,
      artifact: {
        kind: expect.kind,
        strategyId: obj.strategyId.trim(),
        body: obj.body.trim(),
        amendmentText: obj.amendmentText.trim(),
        correctionContents:obj.correctionContents as import('../src/domain/correction.ts').CorrectionContent[]|undefined,
        applicationParts:obj.applicationParts as import('../src/domain/application-parts.ts').ApplicationParts|undefined,
        amendmentBasis: obj.amendmentBasis.trim(),
        reviewNotes: obj.reviewNotes.trim(),
      },
    };
  }

  return agentFail('ARTIFACT_INVALID', '产物类型与当前任务不一致。');
}
