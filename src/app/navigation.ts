import { BadgeCheck, Clock3, Folder, ListTodo, Settings, type LucideIcon } from 'lucide-react';
import type { CaseTab } from '../components/CaseSpace.tsx';
import type { Module } from '../domain/library.ts';
import { FEATURE_MODULES, featureVisible, type FeatureContext } from './features.ts';

export type AppRoute = [page?: string, itemId?: string, tab?: string, roundId?: string];
export type NavigationItem = { id: string; label: string; icon: LucideIcon };

const CORE_NAV_ITEMS: NavigationItem[] = [
  { id: 'library', label: '案件库', icon: Folder },
  { id: 'official', label: '等待官方', icon: Clock3 },
  { id: 'tasks', label: '工作任务', icon: ListTodo },
  { id: 'status', label: '案件状态', icon: BadgeCheck },
];
export function navigationItems(context: FeatureContext): NavigationItem[] {
  return [
    ...CORE_NAV_ITEMS.slice(0, 3),
    ...FEATURE_MODULES
      .filter(feature => featureVisible(feature, context))
      .map(feature => ({ id: feature.id, label: feature.label, icon: feature.icon })),
    CORE_NAV_ITEMS[3],
  ];
}

export const SETTINGS_NAVIGATION = { label: '设置', icon: Settings } as const;
export const MODULE_LABELS: Record<Module, string> = Object.fromEntries(
  FEATURE_MODULES.map(feature => [feature.id, feature.label]),
) as Record<Module, string>;
export const PAGE_LABELS: Record<string, string> = { library: '案件库', official: '等待官方', tasks: '工作任务', status: '案件状态', settings: '设置' };

export function navigate(path: string) { location.hash = path; }

export function readRoute(): AppRoute {
  return location.hash.slice(1).split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  }) as AppRoute;
}

export function isCaseTab(value: string | undefined): value is CaseTab {
  return !!value && ['overview', 'materials', 'discussion', 'reply', 'write', 'review', 'history', 'outputs', 'flow', 'submit'].includes(value);
}

export function pageLabel(page: string, module?: Module) {
  return module ? MODULE_LABELS[module] : PAGE_LABELS[page] ?? '案件库';
}
