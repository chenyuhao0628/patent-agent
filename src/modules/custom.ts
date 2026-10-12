import type { GlobalPanelDefinition, CasePanelDefinition } from '../app/panel-types.ts';
// module-generator:imports

/** Global and case entries share validation but declare independent scopes. */
export const CUSTOM_GLOBAL_PANELS: readonly GlobalPanelDefinition[] = [
  // module-generator:global
];
export const CUSTOM_CASE_PANELS: readonly CasePanelDefinition[] = [
  // module-generator:case
];
export const CUSTOM_PANELS = [...CUSTOM_GLOBAL_PANELS, ...CUSTOM_CASE_PANELS];
