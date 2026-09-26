import type { Module } from '../domain/library.ts';
import type { Case } from '../domain/workflow.ts';
import type { DesktopAPI } from '../contracts/desktop-api.ts';
import type { LucideIcon } from 'lucide-react';
import { ArrowRightLeft, FileSearch, MessageSquare, PenLine } from 'lucide-react';
import { processBusinessKind } from '../domain/lifecycle.ts';
import { projectCaseView, type CaseWorkspaceView } from '../domain/case-view.ts';
import { professionalWorkEditableForView, professionalWritingEditableForView } from '../domain/professional-policy.ts';

export type FeatureModule = {
  id: Module;
  label: string;
  route: `/${Module}`;
  icon: LucideIcon;
  capabilities: readonly string[];
  desktopOnly?: boolean;
  canView?: (caseView: CaseWorkspaceView) => boolean;
  canStart?: (caseView: CaseWorkspaceView) => boolean;
  canEdit?: (caseView: CaseWorkspaceView) => boolean;
};

function hasReplyHistory(caseView: CaseWorkspaceView): boolean {
  const current = caseView.stage.kind;
  const processName = caseView.transfer.currentProcess?.name ?? caseView.stage.current.label ?? '';
  return current === 'reply'
    || current === 'correction'
    || current === 'waiting' && ['reply', 'correction'].includes(processBusinessKind(processName) ?? '')
    || caseView.manuscripts.replyRounds.some(round => /答复|审查意见|补正|复审/.test(round.name));
}

function hasWritingHistory(caseView: CaseWorkspaceView): boolean {
  return caseView.stage.kind === 'write'
    || !!caseView.manuscripts.design.writing.disclosure
    || caseView.manuscripts.replyRounds.some(round => round.name.includes('撰写'));
}

function activeCase(caseView: CaseWorkspaceView): boolean {
  return !caseView.identity.archived
    && !caseView.stage.handling.officialWaiting
    && caseView.stage.kind !== 'needs-confirmation';
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
    canStart: caseView => activeCase(caseView) && ['reply', 'correction'].includes(caseView.stage.kind),
    canEdit: caseView => caseView.stage.editable && ['reply', 'correction'].includes(caseView.stage.kind),
  },
  {
    id: 'write',
    label: '专利撰写',
    route: '/write',
    icon: PenLine,
    capabilities: ['case.read', 'materials.read', 'professional.write', 'artifact.finalize'],
    desktopOnly: true,
    canView: hasWritingHistory,
    canStart: caseView => activeCase(caseView) && caseView.stage.kind === 'write',
    canEdit: professionalWritingEditableForView,
  },
  {
    id: 'review',
    label: '内部审查',
    route: '/review',
    icon: FileSearch,
    capabilities: ['case.read', 'artifact.read', 'professional.review'],
    desktopOnly: true,
    canView: () => true,
    canStart: professionalWorkEditableForView,
    canEdit: professionalWorkEditableForView,
  },
  {
    id: 'transfer',
    label: '内部流转',
    route: '/transfer',
    icon: ArrowRightLeft,
    capabilities: ['case.read', 'artifact.read', 'transfer.prepare', 'transfer.save'],
    desktopOnly: true,
    canView: caseView => caseView.stage.transferAvailable && !caseView.stage.handling.officialWaiting,
    canStart: caseView => caseView.stage.transferAvailable && !caseView.stage.handling.officialWaiting,
    canEdit: caseView => caseView.stage.transferAvailable && !caseView.stage.handling.officialWaiting,
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

function toCaseView(caseItem: Case | CaseWorkspaceView): CaseWorkspaceView {
  return 'identity' in caseItem && 'stage' in caseItem && 'materials' in caseItem
    ? caseItem
    : projectCaseView(caseItem);
}

export function featureAccessForView(feature: FeatureModule, context: FeatureContext, caseView?: CaseWorkspaceView): FeatureAccess {
  const platformAvailable = capabilityAvailable(feature, context);
  const visible = platformAvailable && (!caseView || !feature.canView || feature.canView(caseView));
  const startable = visible && (!caseView || !feature.canStart || feature.canStart(caseView));
  const editable = startable && (!caseView || !feature.canEdit || feature.canEdit(caseView));
  return { visible, startable, editable };
}

export function featureAccess(feature: FeatureModule, context: FeatureContext, caseItem?: Case | CaseWorkspaceView): FeatureAccess {
  return featureAccessForView(feature, context, caseItem ? toCaseView(caseItem) : undefined);
}

export function featureAvailable(feature: FeatureModule, context: FeatureContext, caseItem?: Case | CaseWorkspaceView): boolean {
  return featureAccess(feature, context, caseItem).startable;
}

export function featureVisible(feature: FeatureModule, context: FeatureContext, caseItem?: Case | CaseWorkspaceView): boolean {
  return featureAccess(feature, context, caseItem).visible;
}

export function featureEditable(feature: FeatureModule, context: FeatureContext, caseItem?: Case | CaseWorkspaceView): boolean {
  return featureAccess(feature, context, caseItem).editable;
}
