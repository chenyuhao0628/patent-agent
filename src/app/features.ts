import type { Module } from '../domain/library.ts';
import type { Case } from '../domain/workflow.ts';
import type { DesktopAPI } from '../contracts/desktop-api.ts';
import type { LucideIcon } from 'lucide-react';
import { ArrowRightLeft, FileSearch, MessageSquare, PenLine } from 'lucide-react';
import { currentWork, editableCurrent, internalTransferAvailable, processBusinessKind } from '../domain/lifecycle.ts';
import { currentHandling } from '../domain/handling.ts';
import { professionalWorkEditable, professionalWritingEditable } from '../domain/professional-policy.ts';

export type FeatureModule = {
  id: Module;
  label: string;
  route: `/${Module}`;
  icon: LucideIcon;
  capabilities: readonly string[];
  desktopOnly?: boolean;
  canView?: (caseItem: Case) => boolean;
  canStart?: (caseItem: Case) => boolean;
  canEdit?: (caseItem: Case) => boolean;
};

function hasReplyHistory(caseItem: Case): boolean {
  const current = currentWork(caseItem).kind;
  return current === 'reply'
    || current === 'correction'
    || current === 'waiting' && processBusinessKind(caseItem.remote?.processes.find(process => process.id === currentWork(caseItem).processId)?.name ?? '') === 'reply'
    || caseItem.rounds.some(round => /答复|审查意见|补正|复审/.test(round.name));
}

function hasWritingHistory(caseItem: Case): boolean {
  return currentWork(caseItem).kind === 'write'
    || !!caseItem.design?.writing.disclosure
    || caseItem.rounds.some(round => round.name.includes('撰写'));
}

function activeCase(caseItem: Case): boolean {
  return !caseItem.archived && !currentHandling(caseItem).officialWaiting && currentWork(caseItem).kind !== 'needs-confirmation';
}

export const FEATURE_MODULES: readonly FeatureModule[] = [
  {
    id: 'reply',
    label: '审查意见答复',
    route: '/reply',
    icon: MessageSquare,
    capabilities: ['case.read', 'materials.read', 'agent.reply', 'artifact.finalize'],
    desktopOnly: true,
    canView: hasReplyHistory,
    canStart: caseItem => activeCase(caseItem) && ['reply', 'correction'].includes(currentWork(caseItem).kind),
    canEdit: caseItem => editableCurrent(caseItem) && ['reply', 'correction'].includes(currentWork(caseItem).kind),
  },
  {
    id: 'write',
    label: '专利撰写',
    route: '/write',
    icon: PenLine,
    capabilities: ['case.read', 'materials.read', 'professional.write', 'artifact.finalize'],
    desktopOnly: true,
    canView: hasWritingHistory,
    canStart: caseItem => activeCase(caseItem) && currentWork(caseItem).kind === 'write',
    canEdit: professionalWritingEditable,
  },
  {
    id: 'review',
    label: '内部审查',
    route: '/review',
    icon: FileSearch,
    capabilities: ['case.read', 'artifact.read', 'professional.review'],
    desktopOnly: true,
    canView: () => true,
    canStart: professionalWorkEditable,
    canEdit: professionalWorkEditable,
  },
  {
    id: 'transfer',
    label: '内部流转',
    route: '/transfer',
    icon: ArrowRightLeft,
    capabilities: ['case.read', 'artifact.read', 'transfer.prepare', 'transfer.save'],
    desktopOnly: true,
    canView: caseItem => internalTransferAvailable(caseItem) && !currentHandling(caseItem).officialWaiting,
    canStart: caseItem => internalTransferAvailable(caseItem) && !currentHandling(caseItem).officialWaiting,
    canEdit: caseItem => internalTransferAvailable(caseItem) && !currentHandling(caseItem).officialWaiting,
  },
];

export const FEATURE_MODULE_BY_ID: Readonly<Record<Module, FeatureModule>> = Object.fromEntries(
  FEATURE_MODULES.map(feature => [feature.id, feature]),
) as Record<Module, FeatureModule>;

export function featureModule(id: Module): FeatureModule {
  return FEATURE_MODULE_BY_ID[id];
}

export type FeatureContext = {
  desktop: boolean;
  capabilities: ReadonlySet<string>;
};

export type FeatureAccess = {
  visible: boolean;
  startable: boolean;
  editable: boolean;
};

export const FEATURE_CAPABILITIES: ReadonlySet<string> = new Set(
  FEATURE_MODULES.flatMap(feature => feature.capabilities),
);

export function featureContext(desktop: boolean, capabilities?: Iterable<string>): FeatureContext {
  return { desktop, capabilities: new Set(capabilities ?? (desktop ? FEATURE_CAPABILITIES : [])) };
}

export function featureContextForDesktop(api: DesktopAPI | undefined): FeatureContext {
  if (!api) return featureContext(false, []);
  const surface = api as unknown as {
    agent?: { getCase?: unknown; command?: unknown };
    professional?: { getCase?: unknown; command?: unknown };
    transfer?: { prepare?: unknown; save?: unknown };
  };
  const capabilities = new Set<string>(['case.read', 'materials.read', 'artifact.read']);
  if (typeof surface.agent?.getCase === 'function' && typeof surface.agent.command === 'function') {
    capabilities.add('agent.reply');
    capabilities.add('artifact.finalize');
  }
  if (typeof surface.professional?.getCase === 'function' && typeof surface.professional.command === 'function') {
    capabilities.add('professional.write');
    capabilities.add('professional.review');
    capabilities.add('artifact.finalize');
  }
  if (typeof surface.transfer?.prepare === 'function' && typeof surface.transfer.save === 'function') {
    capabilities.add('transfer.prepare');
    capabilities.add('transfer.save');
  }
  return featureContext(true, capabilities);
}

function capabilityAvailable(feature: FeatureModule, context: FeatureContext): boolean {
  return (!feature.desktopOnly || context.desktop)
    && feature.capabilities.every(capability => context.capabilities.has(capability));
}

export function featureAccess(feature: FeatureModule, context: FeatureContext, caseItem?: Case): FeatureAccess {
  const platformAvailable = capabilityAvailable(feature, context);
  const visible = platformAvailable && (!caseItem || !feature.canView || feature.canView(caseItem));
  const startable = visible && (!caseItem || !feature.canStart || feature.canStart(caseItem));
  const editable = startable && (!caseItem || !feature.canEdit || feature.canEdit(caseItem));
  return { visible, startable, editable };
}

export function featureAvailable(feature: FeatureModule, context: FeatureContext, caseItem?: Case): boolean {
  return featureAccess(feature, context, caseItem).startable;
}

export function featureVisible(feature: FeatureModule, context: FeatureContext, caseItem?: Case): boolean {
  return featureAccess(feature, context, caseItem).visible;
}

export function featureEditable(feature: FeatureModule, context: FeatureContext, caseItem?: Case): boolean {
  return featureAccess(feature, context, caseItem).editable;
}
