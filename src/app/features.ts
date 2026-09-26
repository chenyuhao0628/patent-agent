import type { Module } from '../domain/library.ts';

export type FeatureModule = {
  id: Module;
  label: string;
  route: `/${Module}`;
  capabilities: readonly string[];
  desktopOnly?: boolean;
};

export const FEATURE_MODULES: readonly FeatureModule[] = [
  {
    id: 'reply',
    label: '审查意见答复',
    route: '/reply',
    capabilities: ['case.read', 'materials.read', 'agent.reply', 'artifact.finalize'],
    desktopOnly: true,
  },
  {
    id: 'write',
    label: '专利撰写',
    route: '/write',
    capabilities: ['case.read', 'materials.read', 'professional.write', 'artifact.finalize'],
    desktopOnly: true,
  },
  {
    id: 'review',
    label: '内部审查',
    route: '/review',
    capabilities: ['case.read', 'artifact.read', 'professional.review'],
    desktopOnly: true,
  },
  {
    id: 'transfer',
    label: '内部流转',
    route: '/transfer',
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
