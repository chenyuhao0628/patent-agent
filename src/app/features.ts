import type { Module } from '../domain/library.ts';
import type { Case } from '../domain/workflow.ts';
import type { LucideIcon } from 'lucide-react';
import { ArrowRightLeft, FileSearch, MessageSquare, PenLine } from 'lucide-react';

export type FeatureModule = {
  id: Module;
  label: string;
  route: `/${Module}`;
  icon: LucideIcon;
  capabilities: readonly string[];
  desktopOnly?: boolean;
  canOpen?: (caseItem: Case) => boolean;
};

export const FEATURE_MODULES: readonly FeatureModule[] = [
  {
    id: 'reply',
    label: '审查意见答复',
    route: '/reply',
    icon: MessageSquare,
    capabilities: ['case.read', 'materials.read', 'agent.reply', 'artifact.finalize'],
    desktopOnly: true,
  },
  {
    id: 'write',
    label: '专利撰写',
    route: '/write',
    icon: PenLine,
    capabilities: ['case.read', 'materials.read', 'professional.write', 'artifact.finalize'],
    desktopOnly: true,
  },
  {
    id: 'review',
    label: '内部审查',
    route: '/review',
    icon: FileSearch,
    capabilities: ['case.read', 'artifact.read', 'professional.review'],
    desktopOnly: true,
  },
  {
    id: 'transfer',
    label: '内部流转',
    route: '/transfer',
    icon: ArrowRightLeft,
    capabilities: ['case.read', 'artifact.read', 'transfer.prepare', 'transfer.save'],
    desktopOnly: true,
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

export function featureAvailable(feature: FeatureModule, context: FeatureContext, caseItem?: Case): boolean {
  if (feature.desktopOnly && !context.desktop) return false;
  if (feature.capabilities.some(capability => !context.capabilities.has(capability))) return false;
  return !caseItem || !feature.canOpen || feature.canOpen(caseItem);
}
