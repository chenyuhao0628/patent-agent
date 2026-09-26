import type { Module } from './library.ts';
import {
  activeRound,
  currentWork,
  editableCurrent,
  internalTransferAvailable,
  isInternallyActiveProcess,
  workModule,
  type CurrentWork,
  type WorkKind,
} from './lifecycle.ts';
import { currentHandling } from './handling.ts';
import { hasOfficialOutcome, outcomeView, type OutcomeView } from './outcome.ts';
import type { Case, Material, RemoteProcess, Round } from './workflow.ts';

export type CaseIdentityView = {
  id: string;
  title: string;
  number: string;
  type: string;
  companyName?: string;
  tags: string[];
  source?: Case['source'];
  archived: boolean;
};

export type CaseStageView = {
  current: Readonly<CurrentWork>;
  kind: WorkKind;
  module?: Module;
  activeRound?: Readonly<Round>;
  editable: boolean;
  transferAvailable: boolean;
  officialWaiting: boolean;
};

export type CaseMaterialView = Material & {
  roundId?: string;
  roundName?: string;
};

export type CaseWorkspaceView = {
  identity: CaseIdentityView;
  stage: CaseStageView;
  materials: ReadonlyArray<Readonly<CaseMaterialView>>;
  activeProcesses: ReadonlyArray<Readonly<RemoteProcess>>;
  officialOutcome: {
    applies: boolean;
    view: OutcomeView;
    concluded: boolean;
  };
  remoteCaseId?: string;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function projectCaseView(item: Case): CaseWorkspaceView {
  const current = currentWork(item);
  const round = activeRound(item);
  const materials: CaseMaterialView[] = [];
  const add = (material: Material, roundId?: string, roundName?: string) => {
    materials.push({ ...clone(material), roundId, roundName });
  };
  for (const material of item.materials ?? []) add(material);
  for (const candidate of item.rounds) {
    for (const material of candidate.materials) add(material, candidate.id, candidate.name);
  }
  const activeProcesses = (item.remote?.processes ?? [])
    .filter(isInternallyActiveProcess)
    .map(process => clone(process));
  const outcomeApplies = item.source === 'baseland' && !!item.remote;
  const view = outcomeApplies ? outcomeView(item) : 'unknown';
  const moduleValue = workModule(item);
  const handling = currentHandling(item);
  return {
    identity: {
      id: item.id,
      title: item.title,
      number: item.number,
      type: item.type,
      companyName: item.companyName,
      tags: [...item.tags],
      source: item.source,
      archived: item.archived,
    },
    stage: {
      current: clone(current),
      kind: current.kind,
      module: ['reply', 'write', 'review', 'transfer'].includes(moduleValue) ? moduleValue as Module : undefined,
      activeRound: round ? clone(round) : undefined,
      editable: editableCurrent(item),
      transferAvailable: internalTransferAvailable(item),
      officialWaiting: handling.officialWaiting,
    },
    materials,
    activeProcesses,
    officialOutcome: {
      applies: outcomeApplies,
      view,
      concluded: outcomeApplies && (view === 'granted' || view === 'rejected'),
    },
    remoteCaseId: item.remote?.caseId,
  };
}
