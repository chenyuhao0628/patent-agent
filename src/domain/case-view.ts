import type { Module } from './library.ts';
import { initialDesign, type CaseDesign } from './designFlows.ts';
import {
  designFromRecord,
  caseRecordFromCase,
  caseRecordProcess,
  caseRecordRound,
  type CaseRecord,
} from './case-record.ts';
import {
  editableCurrent,
  internalTransferAvailable,
  isInternallyActiveProcess,
  workModule,
  type CurrentWork,
  type CaseLifecycleFacts,
  type WorkKind,
} from './lifecycle.ts';
import { currentHandling, type CurrentHandling, type HandlingFlowHint } from './handling.ts';
import { deadlineView, type DeadlineView } from './deadlines.ts';
import { outcomeView, type OutcomeView } from './outcome.ts';
import type { Case, LocalVersion, Material, OfficialOutcome, RemoteProcess, Round, Submission } from './workflow.ts';

export type CaseIdentityView = {
  id: string;
  title: string;
  number: string;
  type: string;
  deadline: string;
  deadlineView: Readonly<DeadlineView>;
  applicationNumber?: string;
  companyName?: string;
  tags: string[];
  source?: Case['source'];
  archived: boolean;
  hasDirectory: boolean;
  association?: Case['association'];
  linkedTo?: string;
};

export type CaseStageView = {
  current: Readonly<CurrentWork>;
  kind: WorkKind;
  module?: Module;
  activeRound?: Readonly<Pick<Round, 'id' | 'name' | 'stage' | 'job'>>;
  handling: Readonly<CurrentHandling>;
  editable: boolean;
  transferAvailable: boolean;
  officialWaiting: boolean;
};

export type CaseMaterialView = Material & {
  roundId?: string;
  roundName?: string;
};

export type CaseMaterialsView = {
  all: ReadonlyArray<Readonly<CaseMaterialView>>;
  current: ReadonlyArray<Readonly<CaseMaterialView>>;
  byRound: ReadonlyArray<{
    roundId?: string;
    roundName: string;
    materials: ReadonlyArray<Readonly<CaseMaterialView>>;
  }>;
};

export type CaseManuscriptView = {
  replyRounds: ReadonlyArray<Readonly<Round>>;
  localDraft?: string;
  sharedDraftHash?: string;
  localVersions: ReadonlyArray<Readonly<LocalVersion>>;
  design: CaseDesign;
};

export type CaseOfficialOutcomeView = {
  applies: boolean;
  view: OutcomeView;
  concluded: boolean;
  result?: Readonly<OfficialOutcome>;
  closure?: Readonly<{ finished: boolean; checkedAt: string }>;
};

export type CaseTransferRecordView = {
  id: string;
  at: string;
  files: ReadonlyArray<string>;
  receiver: string;
  process: string;
  note: string;
};

export type CaseTransferView = {
  remoteCaseId?: string;
  remoteSyncedAt?: string;
  processes: ReadonlyArray<Readonly<RemoteProcess>>;
  activeProcesses: ReadonlyArray<Readonly<RemoteProcess>>;
  currentProcess?: Readonly<RemoteProcess>;
  currentSubmission?: Readonly<Submission>;
  localRecords: ReadonlyArray<Readonly<CaseTransferRecordView>>;
  available: boolean;
};

export type CaseWorkspaceView = {
  identity: CaseIdentityView;
  stage: CaseStageView;
  materials: CaseMaterialsView;
  manuscripts: CaseManuscriptView;
  officialOutcome: CaseOfficialOutcomeView;
  transfer: CaseTransferView;
};

export type CaseReplyView = {
  identity: CaseIdentityView;
  stage: CaseStageView;
  materials: CaseMaterialsView;
  manuscripts: Pick<CaseManuscriptView, 'replyRounds' | 'localDraft' | 'localVersions' | 'sharedDraftHash'>;
  officialOutcome: CaseOfficialOutcomeView;
  processes: ReadonlyArray<Readonly<Pick<RemoteProcess, 'id' | 'name' | 'submission'>>>;
};

export type CaseProfessionalView = {
  identity: CaseIdentityView;
  stage: CaseStageView;
  materials: Pick<CaseMaterialsView,'current'>;
  manuscripts: Pick<CaseManuscriptView, 'localDraft'>;
  officialOutcome: CaseOfficialOutcomeView;
};

export type CaseTransferModuleView = {
  identity: CaseIdentityView;
  stage: CaseStageView;
  materials: CaseMaterialsView;
  officialOutcome: CaseOfficialOutcomeView;
  transfer: CaseTransferView;
};

export type CaseHistoryView = {
  identity: CaseIdentityView;
  stage: CaseStageView;
  manuscripts: CaseManuscriptView;
  officialOutcome: CaseOfficialOutcomeView;
  transfer: CaseTransferView;
};

export type CaseDeadlineView = {
  label: string;
  value: string;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function projectCaseCore(record: CaseRecord):Pick<CaseWorkspaceView,'identity'|'stage'|'officialOutcome'> {
  const item = lifecycleFacts(record);
  const current = record.stage.current;
  const round = record.stage.rounds.find(r=>r.id===record.stage.activeRoundId);
  const outcomeApplies = record.identity.source === 'baseland' && !!record.transfer.remoteCaseId;
  const outcome = outcomeApplies ? outcomeView(item) : 'unknown';
  const moduleValue = workModule(item);
  const handling = currentHandling(item);
  return {
    identity: {
      id: record.identity.id, title: record.identity.title, number: record.identity.number,
      type: record.identity.type, deadline: record.identity.deadline, deadlineView: clone(deadlineView(item)),
      applicationNumber: record.identity.applicationNumber, companyName: record.identity.companyName,
      tags: [...record.identity.tags], source: record.identity.source, archived: record.identity.archived,
      hasDirectory: !!record.storage.directory,
      association: record.identity.association ? clone(record.identity.association) : undefined,linkedTo:record.identity.linkedTo,
    },
    stage: {
      current: clone(current), kind: current.kind,
      module: ['reply', 'write', 'review', 'transfer'].includes(moduleValue) ? moduleValue as Module : undefined,
      activeRound: round ? {id:round.id,name:round.name,stage:round.stage,job:clone(record.manuscripts.rounds.find(m=>m.roundId===round.id)?.job??null)} : undefined,
      editable: editableCurrent(item), transferAvailable: internalTransferAvailable(item),
      officialWaiting: handling.officialWaiting, handling: clone(handling),
    },
    officialOutcome: {
      applies: outcomeApplies, view: outcome, concluded: outcomeApplies && (outcome === 'granted' || outcome === 'rejected'),
      result: record.outcome.official ? clone(record.outcome.official) : undefined,
      closure: record.outcome.closure ? clone(record.outcome.closure) : undefined,
    },
  };
}

function projectMaterials(record:CaseRecord):CaseMaterialsView {
  const allMaterials: CaseMaterialView[] = [];
  const baseMaterials: CaseMaterialView[] = [];
  const currentMaterials: CaseMaterialView[] = [];
  const add = (target: CaseMaterialView[], material: Material, roundId?: string, roundName?: string) => {
    target.push({ ...clone(material), roundId, roundName });
  };
  for (const material of record.materials.common) {
    add(allMaterials, material);
    add(baseMaterials, material);
    add(currentMaterials, material);
  }
  const byRound: CaseMaterialsView['byRound'][number][] = [{
    roundName: '本案材料',
    materials: baseMaterials.map(clone),
  }];
  for (const candidate of record.stage.rounds) {
    const roundMaterials: CaseMaterialView[] = [];
    const materials = record.materials.rounds.find(entry => entry.roundId === candidate.id)?.materials ?? [];
    for (const material of materials) {
      add(allMaterials, material, candidate.id, candidate.name);
      if (candidate.id === record.stage.activeRoundId) add(currentMaterials, material, candidate.id, candidate.name);
      add(roundMaterials, material, candidate.id, candidate.name);
    }
    byRound.push({ roundId: candidate.id, roundName: candidate.name, materials: roundMaterials });
  }
  return {all:allMaterials,current:currentMaterials,byRound};
}

function projectTransfer(record:CaseRecord):CaseTransferView {
  const processes = clone(record.transfer.processes);
  const currentProcess = caseRecordProcess(record);
  return {
    remoteCaseId:record.transfer.remoteCaseId,remoteSyncedAt:record.transfer.syncedAt,
    processes,activeProcesses:processes.filter(isInternallyActiveProcess),currentProcess,
    currentSubmission:currentProcess?.submission?clone(currentProcess.submission):undefined,
    localRecords:clone(record.transfer.receipts),available:internalTransferAvailable(lifecycleFacts(record)),
  };
}

export function projectCaseRecordView(record: CaseRecord): CaseWorkspaceView {
  // Missing design is valid for a legacy/local case. The fallback exists only
  // in the read-only projection and is never written back to the record.
  const design = designFromRecord(record) ?? { ...initialDesign(), transfer: { selected: [], applicant: '', process: '', receiver: '', note: '', receipts: [] } };
  return {
    ...projectCaseCore(record),
    materials: projectMaterials(record),
    manuscripts: {
      replyRounds: record.stage.rounds.map(round => caseRecordRound(record, round.id)!),
      localDraft: record.manuscripts.localDraft,
      sharedDraftHash: record.manuscripts.sharedDraftHash,
      localVersions: clone(record.manuscripts.localVersions),
      design,
    },
    transfer: projectTransfer(record),
  };
}

function lifecycleFacts(record: CaseRecord): CaseLifecycleFacts & { deadline: string } {
  return {
    archived: record.identity.archived, source: record.identity.source, deadline: record.identity.deadline,
    current: record.stage.current, officialOutcome: record.outcome.official, remoteClosure: record.outcome.closure,
    remote: record.transfer.remoteCaseId ? { caseId: record.transfer.remoteCaseId, syncedAt: record.transfer.syncedAt ?? '', processes: record.transfer.processes } : undefined,
    rounds: record.stage.rounds.map(round => ({ id: round.id, name: round.name, stage: round.stage,
      job: record.manuscripts.rounds.find(m => m.roundId === round.id)?.job ?? null })),
  };
}

export function projectCaseView(item: Case | CaseRecord): CaseWorkspaceView {
  return projectCaseRecordView(isCaseRecord(item) ? item : caseRecordFromCase(item));
}

function isCaseRecord(value: Case | CaseRecord): value is CaseRecord {
  return 'identity' in value && 'manuscripts' in value && 'transfer' in value
    && typeof value.identity === 'object';
}

type CaseHandlingProjection = Pick<CaseWorkspaceView, 'identity' | 'stage' | 'transfer' | 'officialOutcome'>;

export function handlingForView(view: CaseHandlingProjection, hint?: HandlingFlowHint): CurrentHandling {
  const remote = view.transfer.remoteCaseId
    ? {
      caseId: view.transfer.remoteCaseId,
      processes: view.transfer.processes.map(clone),
      syncedAt: view.transfer.remoteSyncedAt ?? '',
    }
    : undefined;
  const compatibility: CaseLifecycleFacts = {
    archived: view.identity.archived,
    source: view.identity.source,
    rounds: view.stage.activeRound ? [clone(view.stage.activeRound)] : [],
    current: clone(view.stage.current),
    remote,
    officialOutcome: view.officialOutcome.result ? clone(view.officialOutcome.result) : undefined,
    remoteClosure: view.officialOutcome.closure ? clone(view.officialOutcome.closure) : undefined,
  };
  return currentHandling(compatibility, hint);
}

export function deadlineForView(view: Pick<CaseWorkspaceView, 'identity'>): CaseDeadlineView {
  return {
    label: view.identity.deadlineView.label,
    value: view.identity.deadlineView.ordinal === null ? '未提供' : view.identity.deadlineView.display,
  };
}

export function outcomeStatementForView(outcome: CaseOfficialOutcomeView): string | undefined {
  if (!outcome.concluded || !outcome.result) return undefined;
  const name = outcome.result.noticeName || (outcome.result.state === 'granted' ? '办理登记手续通知书' : '驳回决定');
  const code = outcome.result.noticeTypeCode ? `（${outcome.result.noticeTypeCode}）` : '';
  const date = outcome.result.postDate ? ` ${outcome.result.postDate}` : '';
  return `${outcome.result.state === 'granted' ? '已授权' : '已驳回'} · ${name}${code}${date}`;
}

export function projectReplyView(item: Case|CaseRecord): CaseReplyView {
  const record=isCaseRecord(item)?item:caseRecordFromCase(item);
  return {
    ...projectCaseCore(record),materials:projectMaterials(record),
    manuscripts:{replyRounds:record.stage.rounds.map(r=>caseRecordRound(record,r.id)!),
      localDraft:record.manuscripts.localDraft,localVersions:clone(record.manuscripts.localVersions),
      sharedDraftHash:record.manuscripts.sharedDraftHash},
    processes:record.transfer.processes.map(p=>({id:p.id,name:p.name,submission:p.submission?clone(p.submission):undefined})),
  };
}

export function replyViewFromWorkspace(view: CaseWorkspaceView): CaseReplyView {
  return {
    identity: view.identity,
    stage: view.stage,
    materials: view.materials,
    manuscripts: {
      replyRounds: view.manuscripts.replyRounds,
      localDraft: view.manuscripts.localDraft,
      localVersions: view.manuscripts.localVersions,
      sharedDraftHash: view.manuscripts.sharedDraftHash,
    },
    officialOutcome: view.officialOutcome,
    processes: view.transfer.processes.map(p=>({id:p.id,name:p.name,submission:p.submission?clone(p.submission):undefined})),
  };
}

export function projectProfessionalView(item: Case|CaseRecord): CaseProfessionalView {
  const record=isCaseRecord(item)?item:caseRecordFromCase(item);
  const round=record.stage.rounds.find(r=>r.id===record.stage.activeRoundId);
  const materials=record.materials.rounds.find(r=>r.roundId===record.stage.activeRoundId)?.materials??[];
  return {...projectCaseCore(record),
    materials:{current:[...new Map([...clone(record.materials.common),...materials.map(m=>({...clone(m),roundId:round?.id,roundName:round?.name}))].map(m=>[m.id,m])).values()]},
    manuscripts:{localDraft:record.manuscripts.localDraft}};
}

export function professionalViewFromWorkspace(view: CaseWorkspaceView): CaseProfessionalView {
  return {
    identity: view.identity,
    stage: view.stage,
    materials: {current:[...new Map(view.materials.current.map(m=>[m.id,m])).values()]},
    manuscripts: {
      localDraft: view.manuscripts.localDraft,
    },
    officialOutcome: view.officialOutcome,
  };
}

export function projectTransferView(item: Case|CaseRecord): CaseTransferModuleView {
  const record=isCaseRecord(item)?item:caseRecordFromCase(item);
  return {...projectCaseCore(record),materials:projectMaterials(record),transfer:projectTransfer(record)};
}

export function transferViewFromWorkspace(view: CaseWorkspaceView): CaseTransferModuleView {
  return {
    identity: view.identity,
    stage: view.stage,
    materials: view.materials,
    officialOutcome: view.officialOutcome,
    transfer: view.transfer,
  };
}

export function projectHistoryView(item: Case): CaseHistoryView {
  return historyViewFromWorkspace(projectCaseView(item));
}

export function historyViewFromWorkspace(view: CaseWorkspaceView): CaseHistoryView {
  return {
    identity: view.identity,
    stage: view.stage,
    manuscripts: view.manuscripts,
    officialOutcome: view.officialOutcome,
    transfer: view.transfer,
  };
}
