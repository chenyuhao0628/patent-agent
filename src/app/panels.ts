import { BUILTIN_PANELS } from '../modules/builtin.ts';
import { CUSTOM_PANELS } from '../modules/custom.ts';
import { createPanelRegistry } from './panel-registry.ts';
export const panels=createPanelRegistry([...BUILTIN_PANELS,...CUSTOM_PANELS]);
export const casePanelLabels:Readonly<Record<string,string>>=Object.fromEntries(panels.all.filter(p=>p.location==='case').map(p=>[p.route,p.label]));
