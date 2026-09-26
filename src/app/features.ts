import type { Module } from '../domain/library.ts';
import type { Case } from '../domain/workflow.ts';
import type { DesktopAPI } from '../contracts/desktop-api.ts';
import type { LucideIcon } from 'lucide-react';
import { ArrowRightLeft, FileSearch, MessageSquare, PenLine } from 'lucide-react';
import { currentWork, editableCurrent, internalTransferAvailable } from '../domain/lifecycle.ts';
import { currentHandling } from '../domain/handling.ts';

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
    canView: caseItem => !caseItem.archived && ['reply', 'correction', 'waiting'].includes(currentWork(caseItem).kind),
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
    canView: caseItem => !caseItem.archived && ['write', 'waiting'].includes(currentWork(caseItem).kind),
    canStart: caseItem => activeCase(caseItem) && currentWork(caseItem).kind === 'write',
    canEdit: caseItem => editableCurrent(caseItem) && currentWork(caseItem).kind === 'write',
  },
  {
    id: 'review',
    label: '内部审查',
    route: '/review',
    icon: FileSearch,
    capabilities: ['case.read', 'artifact.read', 'professional.review'],
    desktopOnly: true,
    canView: caseItem => !caseItem.archived,
    canStart: caseItem => activeCase(caseItem) && ['write', 'reply', 'correction', 'review'].includes(currentWork(caseItem).kind),
    canEdit: caseItem => !caseItem.archived,
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

export function featureAvailable(feature: FeatureModule, context: FeatureContext, caseItem?: Case): boolean {
  if (feature.desktopOnly && !context.desktop) return false;
  if (feature.capabilities.some(capability => !context.capabilities.has(capability))) return false;
  return !caseItem || !feature.canStart || feature.canStart(caseItem);
}

export function featureVisible(feature: FeatureModule, context: FeatureContext, caseItem?: Case): boolean {
  if (feature.desktopOnly && !context.desktop) return false;
  if (feature.capabilities.some(capability => !context.capabilities.has(capability))) return false;
  return !caseItem || !feature.canView || feature.canView(caseItem);
}

export function featureEditable(feature: FeatureModule, context: FeatureContext, caseItem?: Case): boolean {
  if (!featureVisible(feature, context, caseItem)) return false;
  return !caseItem || !feature.canEdit || feature.canEdit(caseItem);
}
