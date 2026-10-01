/** Task-local, host-observed evidence. Never inferred from model assertions. */
export type EvidenceUnit = 'line' | 'page' | 'image' | 'unknown';
export type EvidenceRange = { start: number; end: number };
export type ReadEvidence = EvidenceRange & {
  materialId: string; hash: string; unit: EvidenceUnit; total?: number;
  mode: 'text' | 'visual' | 'derived' | 'unknown';
  completeUnits: boolean;
};
export type MaterialCoverage = {
  materialId: string; name: string; hash: string; unit: EvidenceUnit; total?: number;
  ranges: EvidenceRange[]; missing: EvidenceRange[];
  status: 'unread' | 'partial' | 'complete' | 'unknown';
  visual: boolean; derived: boolean; required: boolean;
};
export type EvidenceCitation = {
  id: string; materialId: string; hash: string; unit: EvidenceUnit;
  start: number; end: number; quote?: string; target?: string;
};
export type CitationCheck = {
  id: string; materialId: string; name?: string; unit?: EvidenceUnit; start?: number; end?: number;
  target?: string; quote?: string; status: 'verified' | 'visual' | 'unverified' | 'invalid'; detail: string;
};
export type QualityIssue = { code: string; severity: 'error' | 'warning'; message: string; materialId?: string; citationId?: string };
export type ArtifactQuality = {
  schema: 1; materials: MaterialCoverage[]; citations: CitationCheck[]; issues: QualityIssue[];
};
export type EvidencePolicy = { formal: boolean; noticeCoverage?: boolean; opinionIds?: string[] };

export function mergeEvidenceRanges(ranges: EvidenceRange[]): EvidenceRange[] {
  const result: EvidenceRange[] = [];
  for (const range of ranges.filter(r => Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) && r.start > 0 && r.end >= r.start).sort((a,b) => a.start-b.start)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end+1) previous.end = Math.max(previous.end,range.end);
    else result.push({...range});
  }
  return result;
}
export function missingEvidenceRanges(ranges: EvidenceRange[], total: number): EvidenceRange[] {
  const result: EvidenceRange[] = []; let cursor = 1;
  for (const range of mergeEvidenceRanges(ranges)) {
    if (range.start > cursor) result.push({start:cursor,end:Math.min(total,range.start-1)});
    cursor = Math.max(cursor,range.end+1);
    if (cursor > total) break;
  }
  if (cursor <= total) result.push({start:cursor,end:total});
  return result;
}
export function isNoticeMaterial(role: string): boolean {
  return /当前通知|审查意见通知|补正通知/.test(role);
}
export function qualityProblem(quality: ArtifactQuality): string | undefined {
  const errors = quality.issues.filter(i => i.severity === 'error');
  return errors.length ? errors.slice(0,6).map(i => i.message).join('；') : undefined;
}
