import { Settings, type LucideIcon } from 'lucide-react';
import { panels } from './panels.ts';
import type { CaseTab } from '../components/CaseSpace.tsx';
import type { Module } from '../domain/library.ts';
import { FEATURE_MODULES, type FeatureContext } from './features.ts';

export type CaseNavigationTarget = {
  readonly?: boolean;
  roundId?: string;
  processId?: string;
  discussionId?: string;
  sourceId?: string;
  runId?: string;
  historyId?: string;
};
export type AppRoute = [page?: string, itemId?: string, tab?: string, target?: CaseNavigationTarget];
export function isHistoryTarget(target?:CaseNavigationTarget):boolean {
  return !!(target?.readonly||target?.roundId||target?.processId||target?.runId||target?.historyId);
}
export type NavigationItem = { id: string; label: string; icon: LucideIcon };

export function navigationItems(context: FeatureContext): NavigationItem[] {
 return panels.navigation('global',{...context,historical:false}).filter(p=>p.navigation==='main').map(p=>({id:p.route,label:p.label,icon:p.icon??Settings}));
}

export function footerNavigationItems(context:FeatureContext):NavigationItem[]{return panels.navigation('global',{...context,historical:false}).filter(p=>p.navigation==='footer').map(p=>({id:p.route,label:p.label,icon:p.icon??Settings}));}
export const SETTINGS_NAVIGATION = { label: panels.resolve('global','settings')!.label, icon: Settings } as const;
export const MODULE_LABELS: Record<Module, string> = Object.fromEntries(
  FEATURE_MODULES.map(feature => [feature.id, feature.label]),
) as Record<Module, string>;
export const PAGE_LABELS: Record<string,string> = Object.fromEntries(panels.all.filter(p=>p.location==='global').map(p=>[p.route,p.label]));

export function navigate(path: string) { location.hash = path; }

export function readRoute(): AppRoute {
  return parseRoute(location.hash);
}

export function parseRoute(hash: string): AppRoute {
  const [rawPath, rawQuery=''] = hash.replace(/^#/, '').split('?');
  const parts = rawPath.split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const target: CaseNavigationTarget = {};
  // Old bookmarks used the fourth path segment for the round/source identity.
  if (parts[0] === 'case' && parts[3]) {
    target.readonly = true;
    if (parts[2] === 'write' || parts[2] === 'review') target.sourceId = parts[3];
    else if (parts[2] === 'discussion') target.discussionId = parts[3];
    else target.roundId = parts[3];
  }
  for (const [key, value] of new URLSearchParams(rawQuery)) {
    if(key==='readonly'&&value==='true'){target.readonly=true;continue;}
    if (!['roundId', 'processId', 'discussionId', 'sourceId', 'runId', 'historyId'].includes(key) || !value) continue;
    target[key as Exclude<keyof CaseNavigationTarget,'readonly'>] = value;
  }
  return [parts[0], parts[1], parts[2], Object.keys(target).length ? target : undefined];
}

export function isCaseTab(value: string | undefined): value is CaseTab {
  return !!value && !!panels.resolve('case',value);
}

export function pageLabel(page: string, module?: Module) {
  return module ? MODULE_LABELS[module] : PAGE_LABELS[page] ?? '案件库';
}

export function casePath(caseId: string, tab: CaseTab='overview', target?: CaseNavigationTarget): string {
  const query = new URLSearchParams();
  if(target?.readonly)query.set('readonly','true');
  for (const key of ['roundId', 'processId', 'discussionId', 'sourceId', 'runId', 'historyId'] as const) {
    const value = target?.[key];
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return `#/case/${encodeURIComponent(caseId)}/${encodeURIComponent(tab)}${suffix ? `?${suffix}` : ''}`;
}
