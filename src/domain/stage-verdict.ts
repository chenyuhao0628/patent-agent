import type { RemoteProcess, Submission } from './workflow.ts';

/** Single process-level verdict for 「当前阶段 / 等待官方」. */
export type StageVerdictKind =
  | 'waiting-official'
  | 'internal-ended-wait'
  | 'unverified-official'
  | 'unverified-internal'
  | 'none';

export type StageVerdictInput = {
  status?: number;
  submission?: Pick<Submission, 'state'> | null;
  needSendOfficial?: boolean;
};

export const WAITING_OFFICIAL_LABEL = '等待官方处理结果';
export const UNVERIFIED_OFFICIAL_LABEL = '内部流程已结束，官方递交待核验';
export const UNVERIFIED_INTERNAL_LABEL = '内部流程已结束，待核验';
export const INTERNAL_ENDED_WAIT_LABEL = '内部流程已结束，等待后续流程';
export const OFFICIAL_PARTY = '官方';

/**
 * Classify a remote process into one stage/waiting-official verdict.
 * Personal complete (_status/personalStatus=500) is never 「已交官方」:
 * only explicit send/hand evidence (sent|received) yields waiting-official.
 */
export function stageVerdict(input: StageVerdictInput): StageVerdictKind {
  const state = input.submission?.state;
  if (state === 'sent' || state === 'received') return 'waiting-official';
  if (input.status === 500) {
    if (input.needSendOfficial === false) return 'internal-ended-wait';
    if (input.needSendOfficial === true) return 'unverified-official';
    return 'unverified-internal';
  }
  return 'none';
}

export function stageVerdictOfProcess(
  p: Pick<RemoteProcess, 'status' | 'needSendOfficial'> & { submission?: Submission },
): StageVerdictKind {
  return stageVerdict({
    status: p.status,
    submission: p.submission,
    needSendOfficial: p.needSendOfficial,
  });
}

export function isWaitingOfficialVerdict(kind: StageVerdictKind): boolean {
  return kind === 'waiting-official';
}

export function isPersonalCompleteVerdict(kind: StageVerdictKind): boolean {
  return kind === 'internal-ended-wait' || kind === 'unverified-official' || kind === 'unverified-internal';
}

/** Fields to stamp onto Case.current for a terminal stage verdict. */
export type StageCurrentFields = {
  kind: 'waiting' | 'needs-confirmation';
  processId: string;
  label: string;
  remoteStatus: number;
  node: string;
  party: string;
  handler?: string;
};

export function stageCurrentFields(
  kind: StageVerdictKind,
  process: Pick<RemoteProcess, 'id' | 'name' | 'status'>,
  fallbackLabel?: string,
): StageCurrentFields | undefined {
  const label = process.name || fallbackLabel || process.id;
  switch (kind) {
    case 'waiting-official':
      return {
        kind: 'waiting',
        processId: process.id,
        label: WAITING_OFFICIAL_LABEL,
        remoteStatus: process.status,
        node: WAITING_OFFICIAL_LABEL,
        party: OFFICIAL_PARTY,
        handler: OFFICIAL_PARTY,
      };
    case 'internal-ended-wait':
      return {
        kind: 'waiting',
        processId: process.id,
        label,
        remoteStatus: process.status,
        node: INTERNAL_ENDED_WAIT_LABEL,
        party: '内部',
      };
    case 'unverified-official':
      return {
        kind: 'needs-confirmation',
        processId: process.id,
        label: UNVERIFIED_OFFICIAL_LABEL,
        remoteStatus: process.status,
        node: '待核验',
        party: '内部',
      };
    case 'unverified-internal':
      return {
        kind: 'needs-confirmation',
        processId: process.id,
        label,
        remoteStatus: process.status,
        node: '待核验',
        party: '内部',
      };
    default:
      return undefined;
  }
}

/** LocalWorkflow filter buckets — personal complete → unknown, not done. */
export type LocalWorkflowPhase = 'pending' | 'working' | 'done' | 'unknown';

export function localWorkflowPhase(input: {
  submission?: Pick<Submission, 'state'> | null;
  status?: number;
  handId?: string;
  needSendOfficial?: boolean;
}): LocalWorkflowPhase {
  const kind = stageVerdict({
    status: input.status,
    submission: input.submission,
    needSendOfficial: input.needSendOfficial,
  });
  if (kind === 'waiting-official') return 'done';
  if (kind !== 'none') return 'unknown';
  if (input.status === 0 && !input.handId) return 'pending';
  return 'working';
}
