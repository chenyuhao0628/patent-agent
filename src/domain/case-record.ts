import type { CaseDesign, Transfer } from './designFlows.ts';
import { currentWork, type CurrentWork } from './lifecycle.ts';
import type {
  Case,
  LocalVersion,
  Material,
  OfficialOutcome,
  RemoteProcess,
  RemoteProcess as Process,
  Round,
  Settings,
} from './workflow.ts';

export const CASE_RECORD_SCHEMA = 1 as const;
export const SHARED_CASE_MANIFEST_SCHEMA = 3 as const;

/**
 * CaseRecord is the domain boundary used by the case modules.
 *
 * `Case` remains the sync/file/IPC compatibility shape. Private persistence
 * uses CaseRecord as its canonical representation. The conversion here
 * instead of letting every feature reach through unrelated case fields.
 */
export type CaseIdentityRecord = {
  id: string;
  title: string;
  number: string;
  type: string;
  deadline: string;
  applicationNumber?: string;
  companyName?: string;
  caseRemark?: string;
  caseInfoAt?: string;
  tags: string[];
  source?: 'baseland' | 'local';
  archived: boolean;
};

export type CaseStageRecord = {
  current: CurrentWork;
  rounds: Array<{
    id: string;
    name: string;
    stage: Round['stage'];
    confirmed: boolean;
    strategy: string | null;
    extensions?: Record<string, unknown>;
  }>;
  activeRoundId?: string;
};

export type CaseMaterialsRecord = {
  common: Material[];
  rounds: Array<{
    roundId: string;
    roundName: string;
    materials: Material[];
    priorArt?: Round['priorArt'];
  }>;
};

export type CaseRoundManuscriptRecord = {
  roundId: string;
  draft: string;
  versions: Round['versions'];
  discussions: Round['discussions'];
  review: Round['review'];
  job: Round['job'];
  final: Round['final'];
  finalHistory: Round['finalHistory'];
  extensions?: Record<string, unknown>;
};

export type CaseManuscriptsRecord = {
  localDraft?: string;
  localVersions: LocalVersion[];
  sharedDraftHash?: string;
  rounds: CaseRoundManuscriptRecord[];
  /**
   * A missing design is meaningful for legacy/local cases. Do not materialize
   * the prototype's example applicant just because a case was migrated.
   */
  design?: Omit<CaseDesign, 'transfer'>;
};

export type CaseOutcomeRecord = {
  official?: OfficialOutcome;
  closure?: { finished: boolean; checkedAt: string };
};

export type CaseTransferRecord = {
  remoteCaseId?: string;
  syncedAt?: string;
  processes: RemoteProcess[];
  form?: Omit<Transfer, 'receipts'>;
  extensions?: Record<string, unknown>;
  receipts: Array<{
    id: string;
    at: string;
    files: string[];
    receiver: string;
    process: string;
    note: string;
  }>;
};

export type CaseStorageRecord = {
  directory?: string;
};

export type CaseRecord = {
  identity: CaseIdentityRecord;
  stage: CaseStageRecord;
  materials: CaseMaterialsRecord;
  manuscripts: CaseManuscriptsRecord;
  outcome: CaseOutcomeRecord;
  transfer: CaseTransferRecord;
  storage: CaseStorageRecord;
  /**
   * Forward-compatible fields from older/newer Case snapshots. They stay in
   * the private account record and are copied back without interpretation.
   */
  extensions?: Record<string, unknown>;
};

export type CaseRecordEnvelope = {
  schema: typeof CASE_RECORD_SCHEMA;
  profile: string;
  records: CaseRecord[];
};

/** Private profile storage. `cases` is a derived compatibility projection. */
export type StoredCaseWorkspace = {
  schema: 1;
  /** Binds a private workspace file to the account namespace that owns it. */
  profile: string;
  settings: Settings;
  caseRecords: CaseRecord[];
  cases?: Case[];
  caseRecordsSchema: typeof CASE_RECORD_SCHEMA;
  caseRecordsHash: string;
};

export function storedCaseWorkspace(
  profile: string,
  settings: Settings,
  cases: Case[],
  hash: string,
): StoredCaseWorkspace {
  const records = cases.map(caseRecordFromCase);
  return {
    schema: 1,
    profile,
    settings: clone(settings),
    caseRecords: records,
    caseRecordsSchema: CASE_RECORD_SCHEMA,
    caseRecordsHash: hash,
    // Kept for older desktop builds. It is never read when caseRecords is
    // valid, so it cannot become a second source of truth.
    cases: records.map(record => caseFromRecord(record)),
  };
}

export type CaseRecordPatch = {
  identity?: Partial<CaseIdentityRecord>;
  stage?: Partial<CaseStageRecord>;
  materials?: Partial<CaseMaterialsRecord>;
  manuscripts?: Partial<CaseManuscriptsRecord>;
  outcome?: Partial<CaseOutcomeRecord>;
  transfer?: Partial<CaseTransferRecord>;
  storage?: Partial<CaseStorageRecord>;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

type SharedMaterial = {
  id: string;
  name: string;
  role: string;
  location: string;
  fileNo?: string;
  relativePath?: string;
};

function sharedMaterial(material: Material): SharedMaterial {
  return {
    id: material.id,
    name: material.name,
    role: material.role,
    location: material.location,
    fileNo: material.fileNo,
    relativePath: material.relativePath?.replaceAll('\\', '/'),
  };
}

const CASE_KEYS = new Set([
  'officialOutcome', 'remoteClosure', 'companyName', 'caseRemark', 'caseInfoAt',
  'id', 'title', 'number', 'type', 'deadline', 'archived', 'tags', 'rounds',
  'design', 'current', 'source', 'materials', 'applicationNumber', 'directory',
  'remote', 'localDraft', 'sharedDraftHash', 'localVersions',
]);

function extensionsOf(item: Case): Record<string, unknown> | undefined {
  const extensions: Record<string, unknown> = Object.fromEntries(
    Object.entries(item).filter(([key]) => !CASE_KEYS.has(key)),
  );
  return Object.keys(extensions).length ? clone(extensions) : undefined;
}

function except(value: object, keys: string[]): Record<string, unknown> {
  return clone(Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))));
}

const ROUND_KEYS = ['id', 'name', 'stage', 'confirmed', 'strategy', 'materials', 'priorArt',
  'draft', 'versions', 'discussions', 'review', 'job', 'final', 'finalHistory'];

function roundMaterials(item: Case): CaseMaterialsRecord['rounds'] {
  return item.rounds.map(round => ({
    roundId: round.id,
    roundName: round.name,
    materials: clone(round.materials),
    priorArt: round.priorArt ? clone(round.priorArt) : undefined,
  }));
}

function roundStage(round: Round): CaseStageRecord['rounds'][number] {
  return {
    id: round.id,
    name: round.name,
    stage: round.stage,
    confirmed: round.confirmed,
    strategy: round.strategy,
    extensions: except(round, ROUND_KEYS),
  };
}

function roundManuscript(round: Round): CaseRoundManuscriptRecord {
  return {
    roundId: round.id,
    draft: round.draft,
    versions: clone(round.versions),
    discussions: clone(round.discussions),
    review: clone(round.review),
    job: clone(round.job),
    final: clone(round.final),
    finalHistory: clone(round.finalHistory),
  };
}

export function caseRecordFromCase(item: Case): CaseRecord {
  const current = currentWork(item);
  const design = item.design ? clone(item.design) : undefined;
  const form = design?.transfer;
  const processes = clone(item.remote?.processes ?? []);
  return {
    identity: {
      id: item.id,
      title: item.title,
      number: item.number,
      type: item.type,
      deadline: item.deadline,
      applicationNumber: item.applicationNumber,
      companyName: item.companyName,
      caseRemark: item.caseRemark,
      caseInfoAt: item.caseInfoAt,
      tags: [...item.tags],
      source: item.source,
      archived: item.archived,
    },
    stage: {
      current: clone(current),
      rounds: item.rounds.map(roundStage),
      activeRoundId: current.roundId,
    },
    materials: {
      common: clone(item.materials ?? []),
      rounds: roundMaterials(item),
    },
    manuscripts: {
      localDraft: item.localDraft,
      localVersions: clone(item.localVersions ?? []),
      sharedDraftHash: item.sharedDraftHash,
      rounds: item.rounds.map(roundManuscript),
      design: design ? except(design, ['transfer']) as Omit<CaseDesign, 'transfer'> : undefined,
    },
    outcome: {
      official: item.officialOutcome ? clone(item.officialOutcome) : undefined,
      closure: item.remoteClosure ? clone(item.remoteClosure) : undefined,
    },
    transfer: {
      remoteCaseId: item.remote?.caseId,
      syncedAt: item.remote?.syncedAt,
      processes,
      form: form ? except(form, ['receipts']) as Omit<Transfer, 'receipts'> : undefined,
      receipts: clone(form?.receipts ?? []),
      extensions: item.remote ? except(item.remote, ['caseId', 'syncedAt', 'processes']) : undefined,
    },
    storage: {
      directory: item.directory,
    },
    ...(extensionsOf(item) ? { extensions: extensionsOf(item) } : {}),
  };
}

function remoteOf(record: CaseRecord): Case['remote'] {
  if (!record.transfer.remoteCaseId) return undefined;
  return {
    ...clone(record.transfer.extensions ?? {}),
    caseId: record.transfer.remoteCaseId,
    syncedAt: record.transfer.syncedAt ?? '',
    processes: clone(record.transfer.processes),
  };
}

export function caseFromRecord(record: CaseRecord, base?: Case): Case {
  const design = designFromRecord(record);
  const materialRoundById = new Map(record.materials.rounds.map(round => [round.roundId, round]));
  const manuscriptByRound = new Map(record.manuscripts.rounds.map(round => [round.roundId, round]));
  const rounds = record.stage.rounds.map(round => roundFromRecord(
    round,
    materialRoundById.get(round.id),
    manuscriptByRound.get(round.id),
  ));
  const current = clone(record.stage.current);
  const extensionFields = record.extensions
    ? Object.fromEntries(Object.entries(record.extensions).filter(([key]) => key !== '__caseSnapshot'))
    : {};
  return {
    ...(base ? extensionsOf(base) : {}),
    ...extensionFields,
    id: record.identity.id,
    title: record.identity.title,
    number: record.identity.number,
    type: record.identity.type,
    deadline: record.identity.deadline,
    applicationNumber: record.identity.applicationNumber,
    companyName: record.identity.companyName,
    caseRemark: record.identity.caseRemark,
    caseInfoAt: record.identity.caseInfoAt,
    tags: [...record.identity.tags],
    source: record.identity.source,
    archived: record.identity.archived,
    rounds,
    current,
    materials: clone(record.materials.common),
    design,
    localDraft: record.manuscripts.localDraft,
    localVersions: clone(record.manuscripts.localVersions),
    sharedDraftHash: record.manuscripts.sharedDraftHash,
    officialOutcome: record.outcome.official ? clone(record.outcome.official) : undefined,
    remoteClosure: record.outcome.closure ? clone(record.outcome.closure) : undefined,
    remote: remoteOf(record),
    directory: record.storage.directory,
  };
}

export function designFromRecord(record: CaseRecord): CaseDesign | undefined {
  if (!record.manuscripts.design) return undefined;
  return {
    ...clone(record.manuscripts.design),
    transfer: {
      selected: [], applicant: '', process: '', receiver: '', note: '',
      ...clone(record.transfer.form ?? {}),
      receipts: clone(record.transfer.receipts),
    },
  };
}

function roundFromRecord(
  round: CaseStageRecord['rounds'][number],
  materialRound?: CaseMaterialsRecord['rounds'][number],
  manuscript?: CaseRoundManuscriptRecord,
): Round {
  if (!materialRound || !manuscript) throw new Error('轮次材料或稿件记录缺失，未生成空稿替代。');
  const { extensions: _extensions, ...stage } = round;
  return {
    ...clone(round.extensions ?? {}),
    ...clone(manuscript?.extensions ?? {}),
    ...clone(stage),
    ...(materialRound?.priorArt ? { priorArt: clone(materialRound.priorArt) } : {}),
    materials: clone(materialRound?.materials ?? []),
    draft: manuscript?.draft ?? '',
    versions: clone(manuscript?.versions ?? []),
    discussions: clone(manuscript?.discussions ?? []),
    review: clone(manuscript?.review ?? null),
    job: clone(manuscript?.job ?? null),
    final: clone(manuscript?.final ?? null),
    finalHistory: clone(manuscript?.finalHistory ?? []),
  };
}

export function updateCaseRecord(record: CaseRecord, patch: CaseRecordPatch): CaseRecord {
  const next = clone(record);
  if (patch.identity) next.identity = { ...next.identity, ...clone(patch.identity) };
  if (patch.stage) next.stage = { ...next.stage, ...clone(patch.stage) };
  if (patch.materials) next.materials = { ...next.materials, ...clone(patch.materials) };
  if (patch.manuscripts) next.manuscripts = { ...next.manuscripts, ...clone(patch.manuscripts) };
  if (patch.outcome) next.outcome = { ...next.outcome, ...clone(patch.outcome) };
  if (patch.transfer) next.transfer = { ...next.transfer, ...clone(patch.transfer) };
  if (patch.storage) next.storage = { ...next.storage, ...clone(patch.storage) };
  return next;
}

export function caseRecordProcess(record: CaseRecord, processId?: string): Process | undefined {
  const id = processId ?? record.stage.current.processId;
  return id ? clone(record.transfer.processes.find(process => process.id === id)) : undefined;
}

export function caseRecordRound(record: CaseRecord, roundId?: string): Round | undefined {
  const id = roundId ?? record.stage.activeRoundId;
  if (!id) return undefined;
  const round = record.stage.rounds.find(candidate => candidate.id === id);
  if (!round) return undefined;
  const materialRound = record.materials.rounds.find(candidate => candidate.roundId === id);
  const manuscript = record.manuscripts.rounds.find(candidate => candidate.roundId === id);
  return roundFromRecord(round, materialRound, manuscript);
}

export function caseRecordMaterials(record: CaseRecord): Material[] {
  return [
    ...record.materials.common,
    ...record.materials.rounds.flatMap(round => round.materials),
  ].map(clone);
}

/**
 * The shared case manifest is intentionally a public case index, not a copy
 * of the account-private workspace. It contains the domain groups needed to
 * rebuild a case and keeps the old flat fields for older readers.
 */
export function sharedCaseManifestFromCase(item: Case, profile: string): Record<string, unknown> {
  const record = caseRecordFromCase(item);
  const legacy = caseFromRecord(record);
  const commonMaterials = record.materials.common.map(sharedMaterial);
  const roundMaterials = record.materials.rounds.map(round => ({
    roundId: round.roundId,
    roundName: round.roundName,
    materials: round.materials.map(sharedMaterial),
  }));
  return {
    schema: SHARED_CASE_MANIFEST_SCHEMA,
    profile,
    id: record.identity.id,
    title: record.identity.title,
    number: record.identity.number,
    type: record.identity.type,
    deadline: record.identity.deadline,
    applicationNumber: record.identity.applicationNumber,
    companyName: record.identity.companyName,
    caseRemark: record.identity.caseRemark,
    caseInfoAt: record.identity.caseInfoAt,
    remoteClosure: record.outcome.closure,
    officialOutcome: record.outcome.official,
    current: legacy.current,
    source: record.identity.source,
    remoteCaseId: record.transfer.remoteCaseId,
    remote: legacy.remote,
    materials: commonMaterials,
    rounds: legacy.rounds.map(round => ({
      id: round.id,
      name: round.name,
      priorArt: round.priorArt,
      materials: round.materials.map(sharedMaterial),
    })),
    domains: {
      identity: clone(record.identity),
      stage: {
        current: clone(record.stage.current),
        activeRoundId: record.stage.activeRoundId,
        rounds: record.stage.rounds.map(round => ({
          id: round.id,
          name: round.name,
          stage: round.stage,
          confirmed: round.confirmed,
          priorArt: record.materials.rounds.find(entry => entry.roundId === round.id)?.priorArt
            ? clone(record.materials.rounds.find(entry => entry.roundId === round.id)!.priorArt)
            : undefined,
        })),
      },
      materials: {
        common: commonMaterials,
        rounds: roundMaterials,
      },
      outcome: clone(record.outcome),
      transfer: {
        remoteCaseId: record.transfer.remoteCaseId,
        syncedAt: record.transfer.syncedAt,
        processes: clone(record.transfer.processes),
      },
    },
  };
}

export function caseRecordEnvelope(profile: string, cases: Case[]): CaseRecordEnvelope {
  return {
    schema: CASE_RECORD_SCHEMA,
    profile,
    records: cases.map(caseRecordFromCase),
  };
}

export function caseRecordsFromEnvelope(value: unknown, profile: string): CaseRecord[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as Partial<CaseRecordEnvelope>;
  if (envelope.schema !== CASE_RECORD_SCHEMA || envelope.profile !== profile || !Array.isArray(envelope.records)) return undefined;
  return normalizeRecords(envelope.records);
}

export function caseRecordsFromStoredWorkspace(value: unknown): CaseRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return normalizeRecords(value);
}

function normalizeRecords(values: unknown[]): CaseRecord[] | undefined {
  const records = values.map(normalizeCaseRecord);
  if (!records.every((record): record is CaseRecord => !!record)) return undefined;
  return new Set(records.map(record => record.identity.id)).size === records.length ? records : undefined;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): value is string {
  return typeof value === 'string';
}

function validMaterial(value: unknown): value is Material {
  const material = objectOf(value);
  return !!material
    && stringOf(material.id)
    && !!material.id
    && stringOf(material.name)
    && stringOf(material.role)
    && stringOf(material.location)
    && stringOf(material.excerpt)
    && typeof material.ready === 'boolean';
}

function validRecordRound(value: unknown): value is Round {
  const round = objectOf(value);
  return !!round
    && stringOf(round.id)
    && !!round.id
    && stringOf(round.name)
    && ['materials', 'strategy', 'draft', 'review', 'final'].includes(String(round.stage))
    && typeof round.confirmed === 'boolean'
    && (typeof round.strategy === 'string' || round.strategy === null)
    && stringOf(round.draft)
    && validManuscript(round)
    && Array.isArray(round.materials)
    && round.materials.every(validMaterial);
}

function textFields(value: unknown, fields: string[]): boolean {
  const row = objectOf(value);
  return !!row && fields.every(key => typeof row[key] === 'string');
}

function validManuscript(value: unknown): boolean {
  const row = objectOf(value);
  if (!row) return false;
  const nullable = (value: unknown, fields: string[]) => value === null || textFields(value, fields);
  return typeof row.draft === 'string'
    && Array.isArray(row.versions) && row.versions.every(v => textFields(v, ['id', 'text', 'at', 'label']))
    && Array.isArray(row.discussions) && row.discussions.every(d => {
      const discussion = objectOf(d);
      return textFields(d, ['id', 'title']) && Array.isArray(discussion?.messages)
        && discussion.messages.every(m => textFields(m, ['id', 'role', 'text']));
    })
    && nullable(row.review, ['versionId', 'finding'])
    && (row.review === null || typeof objectOf(row.review)?.resolved === 'boolean')
    && nullable(row.job, ['id', 'kind', 'status'])
    && (row.job === null || (['analysis', 'drafting', 'reviewing'].includes(String(objectOf(row.job)?.kind))
      && ['running', 'paused'].includes(String(objectOf(row.job)?.status)) && typeof objectOf(row.job)?.due === 'number'))
    && nullable(row.final, ['versionId', 'text', 'at'])
    && Array.isArray(row.finalHistory) && row.finalHistory.every(f => textFields(f, ['versionId', 'text', 'at']));
}

const WORK_KINDS = ['write', 'reply', 'correction', 'review', 'waiting', 'external', 'needs-confirmation'];
function validCurrent(value: unknown): boolean {
  const row = objectOf(value);
  return !!row && WORK_KINDS.includes(String(row.kind))
    && ['roundId', 'processId', 'label', 'node', 'party', 'handler'].every(key => row[key] === undefined || typeof row[key] === 'string')
    && (row.remoteStatus === undefined || typeof row.remoteStatus === 'number');
}

function validDesign(value: unknown): boolean {
  const design = objectOf(value), writing = objectOf(design?.writing);
  return !!writing && textFields(writing, ['stage', 'disclosure', 'researchQuery', 'strategy'])
    && Array.isArray(writing.documents) && writing.documents.every(d => textFields(d, ['id', 'title', 'text']))
    && Array.isArray(writing.versions) && writing.versions.every(v => {
      const row = objectOf(v);
      return textFields(v, ['id', 'at']) && Array.isArray(row?.documents) && row.documents.every(d => textFields(d, ['id', 'title', 'text']));
    })
    && Array.isArray(writing.finalHistory)
    && (design?.review === null || !!objectOf(design?.review))
    && Array.isArray(design?.reviewHistory);
}

export function validLegacyCases(value: unknown): value is Case[] {
  return Array.isArray(value) && new Set(value.map(v => objectOf(v)?.id)).size === value.length
    && value.every(v => {
      const c = objectOf(v);
      return !!c && textFields(c, ['id', 'title', 'number', 'type', 'deadline']) && !!c.id
        && typeof c.archived === 'boolean' && Array.isArray(c.tags) && c.tags.every(stringOf)
        && Array.isArray(c.rounds) && c.rounds.every(validRecordRound)
        && (c.materials === undefined || Array.isArray(c.materials) && c.materials.every(validMaterial))
        && (c.current === undefined || validCurrent(c.current))
        && (c.localDraft === undefined || typeof c.localDraft === 'string')
        && (c.localVersions === undefined || Array.isArray(c.localVersions) && c.localVersions.every(v => textFields(v, ['id', 'text', 'at'])))
        && (c.design === undefined || validDesign(c.design));
    });
}

function normalizeCaseRecord(value: unknown): CaseRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<CaseRecord>;
  const identity = objectOf(raw.identity);
  const stage = objectOf(raw.stage);
  const materials = objectOf(raw.materials);
  const manuscripts = objectOf(raw.manuscripts);
  const outcome = objectOf(raw.outcome);
  const transfer = objectOf(raw.transfer);
  const storage = objectOf(raw.storage);
  if (!identity || !stage || !materials || !manuscripts || !outcome || !transfer || !storage) return undefined;
  if (!stringOf(identity.id) || !identity.id || !stringOf(identity.title) || !stringOf(identity.number)
    || !stringOf(identity.type) || !stringOf(identity.deadline)
    || !Array.isArray(identity.tags) || !identity.tags.every(stringOf)
    || typeof identity.archived !== 'boolean' || !validCurrent(stage.current) || !Array.isArray(stage.rounds)
    || !Array.isArray(materials.common)
    || !materials.common.every(validMaterial) || !Array.isArray(materials.rounds)
    || !Array.isArray(manuscripts.localVersions) || !manuscripts.localVersions.every(v => textFields(v, ['id', 'text', 'at']))
    || (manuscripts.localDraft !== undefined && typeof manuscripts.localDraft !== 'string')
    || (manuscripts.design !== undefined && !validDesign(manuscripts.design))
    || !Array.isArray(transfer.processes) || !transfer.processes.every(p => textFields(p, ['id', 'name', 'node', 'undertaker', 'deadline']) && typeof objectOf(p)?.status === 'number')
    || !Array.isArray(transfer.receipts) || !transfer.receipts.every(r => textFields(r, ['id', 'at', 'receiver', 'process', 'note']) && Array.isArray(objectOf(r)?.files))
    || (outcome.official !== undefined && (!textFields(outcome.official, ['state', 'checkedAt']) || !['granted', 'rejected', 'none'].includes(String(objectOf(outcome.official)?.state))))
    || (outcome.closure !== undefined && (!textFields(outcome.closure, ['checkedAt']) || typeof objectOf(outcome.closure)?.finished !== 'boolean'))
    || (storage.directory !== undefined && typeof storage.directory !== 'string')) return undefined;

  const oldRounds = Array.isArray(stage.rounds) ? stage.rounds : [];
  const stageRounds = oldRounds.map(round => {
    const item = objectOf(round);
    if (!item || !stringOf(item.id) || !stringOf(item.name) || !['materials', 'strategy', 'draft', 'review', 'final'].includes(String(item.stage))
      || typeof item.confirmed !== 'boolean' || (typeof item.strategy !== 'string' && item.strategy !== null)) return undefined;
    return {
      id: item.id,
      name: item.name,
      stage: item.stage as Round['stage'],
      confirmed: item.confirmed,
      strategy: item.strategy as string | null,
      extensions: { ...except(item, ROUND_KEYS.concat('extensions')), ...clone(objectOf(item.extensions) ?? {}) },
    };
  });
  if (stageRounds.some(round => !round)) return undefined;

  const rawMaterials = Array.isArray(materials.rounds) ? materials.rounds : [];
  const materialRounds = rawMaterials.map(round => {
    const item = objectOf(round);
    if (!item || !stringOf(item.roundId) || !stringOf(item.roundName) || !Array.isArray(item.materials)
      || !item.materials.every(validMaterial)) return undefined;
    return {
      ...clone(item),
      roundId: item.roundId,
      roundName: item.roundName,
      materials: clone(item.materials),
      ...(item.priorArt && typeof item.priorArt === 'object' ? { priorArt: clone(item.priorArt as Round['priorArt']) } : {}),
    };
  });
  if (materialRounds.some(round => !round)) return undefined;

  const oldManuscripts = oldRounds.map(round => {
    const item = objectOf(round);
    if (!item || !stringOf(item.id) || !stringOf(item.draft) || !Array.isArray(item.versions)
      || !Array.isArray(item.discussions) || !Array.isArray(item.finalHistory)
      || (item.review !== null && typeof item.review !== 'object')
      || (item.job !== null && typeof item.job !== 'object')
      || (item.final !== null && typeof item.final !== 'object')) return undefined;
    return {
      roundId: item.id,
      draft: item.draft,
      versions: clone(item.versions as Round['versions']),
      discussions: clone(item.discussions as Round['discussions']),
      review: clone(item.review as Round['review']),
      job: clone(item.job as Round['job']),
      final: clone(item.final as Round['final']),
      finalHistory: clone(item.finalHistory as Round['finalHistory']),
    };
  });
  const explicitManuscripts = Array.isArray(manuscripts.rounds) ? manuscripts.rounds : undefined;
  const manuscriptRounds = explicitManuscripts
    ? explicitManuscripts.map(round => {
      const item = objectOf(round);
      if (!item || !stringOf(item.roundId) || !validManuscript(item)) return undefined;
      return {
        ...clone(item),
        roundId: item.roundId,
        draft: item.draft,
        versions: clone(item.versions as Round['versions']),
        discussions: clone(item.discussions as Round['discussions']),
        review: clone(item.review as Round['review']),
        job: clone(item.job as Round['job']),
        final: clone(item.final as Round['final']),
        finalHistory: clone(item.finalHistory as Round['finalHistory']),
        ...(item.extensions && objectOf(item.extensions) ? { extensions: clone(item.extensions) } : {}),
      };
    })
    : oldManuscripts;
  if (!manuscriptRounds || manuscriptRounds.some(round => !round)) return undefined;
  const ids = stageRounds.map(round => round!.id);
  if (new Set(ids).size !== ids.length) return undefined;
  for (const linked of [materialRounds, manuscriptRounds]) {
    const linkedIds = linked.map(round => round!.roundId);
    if (linkedIds.length !== ids.length || new Set(linkedIds).size !== ids.length || linkedIds.some(id => !ids.includes(id))) return undefined;
  }
  if (stage.activeRoundId !== undefined && (!stringOf(stage.activeRoundId) || !ids.includes(stage.activeRoundId))) return undefined;
  if (objectOf(stage.current)?.roundId && !ids.includes(String(objectOf(stage.current)!.roundId))) return undefined;

  const normalized: CaseRecord = {
    ...clone(raw as CaseRecord),
    identity: clone(raw.identity as CaseIdentityRecord),
    stage: {
      ...clone(stage),
      current: clone(stage.current as CurrentWork),
      rounds: clone(stageRounds as CaseStageRecord['rounds']),
      activeRoundId: stringOf(stage.activeRoundId) ? stage.activeRoundId : undefined,
    },
    materials: {
      ...clone(materials),
      common: clone(materials.common as Material[]),
      rounds: clone(materialRounds as CaseMaterialsRecord['rounds']),
    },
    manuscripts: {
      ...clone(manuscripts),
      localDraft: stringOf(manuscripts.localDraft) ? manuscripts.localDraft : undefined,
      localVersions: clone(manuscripts.localVersions as LocalVersion[]),
      sharedDraftHash: stringOf(manuscripts.sharedDraftHash) ? manuscripts.sharedDraftHash : undefined,
      rounds: clone(manuscriptRounds as CaseRoundManuscriptRecord[]),
      design: manuscripts.design ? except(manuscripts.design as object, ['transfer']) as Omit<CaseDesign, 'transfer'> : undefined,
    },
    outcome: {
      ...clone(outcome),
      official: outcome.official && typeof outcome.official === 'object' ? clone(outcome.official as OfficialOutcome) : undefined,
      closure: outcome.closure && typeof outcome.closure === 'object' ? clone(outcome.closure as CaseOutcomeRecord['closure']) : undefined,
    },
    transfer: {
      ...clone(transfer),
      form: transfer.form ? clone(transfer.form as Omit<Transfer, 'receipts'>)
        : objectOf(manuscripts.design)?.transfer ? except(objectOf(manuscripts.design)!.transfer as object, ['receipts']) as Omit<Transfer, 'receipts'> : undefined,
      remoteCaseId: stringOf(transfer.remoteCaseId) ? transfer.remoteCaseId : undefined,
      syncedAt: stringOf(transfer.syncedAt) ? transfer.syncedAt : undefined,
      processes: clone(transfer.processes as RemoteProcess[]),
      receipts: clone(transfer.receipts as CaseTransferRecord['receipts']),
    },
    storage: {
      ...clone(storage),
      directory: stringOf(storage.directory) ? storage.directory : undefined,
    },
    ...(raw.extensions && objectOf(raw.extensions) ? { extensions: clone(raw.extensions) } : {}),
  };
  // Older development builds kept a redundant snapshot. Preserve its unknown
  // fields, but never let it override the canonical manuscript or stage.
  const snapshot = objectOf(normalized.extensions?.__caseSnapshot);
  if (snapshot) {
    normalized.extensions = { ...except(snapshot, [...CASE_KEYS]), ...normalized.extensions };
    delete normalized.extensions.__caseSnapshot;
    for (const round of normalized.stage.rounds) {
      const previous = Array.isArray(snapshot.rounds) ? snapshot.rounds.find(r => objectOf(r)?.id === round.id) : undefined;
      if (previous) round.extensions = { ...except(previous, ROUND_KEYS), ...round.extensions };
    }
  }
  return normalized;
}

/** Retain forward-compatible fields while the compatibility renderer edits known fields. */
export function preserveRecordFields(previous: CaseRecord | undefined, next: CaseRecord): CaseRecord {
  function merge(old: unknown, value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(entry => {
        const row = objectOf(entry), key = row && ('id' in row ? 'id' : 'roundId' in row ? 'roundId' : undefined);
        const before = key && Array.isArray(old) ? old.find(v => objectOf(v)?.[key] === row![key]) : undefined;
        return merge(before, entry);
      });
    }
    const row = objectOf(value);
    if (!row) return clone(value);
    const before = objectOf(old) ?? {};
    return { ...clone(before), ...Object.fromEntries(Object.entries(row).map(([key, child]) => [key, merge(before[key], child)])) };
  }
  return merge(previous, next) as CaseRecord;
}
