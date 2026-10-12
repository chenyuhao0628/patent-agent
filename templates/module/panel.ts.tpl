import type { __DEFINITION_TYPE__ } from '../../../app/panel-types.ts';

const panel: __DEFINITION_TYPE__ = {
  id: __ID__,
  location: __LOCATION__,
  route: __ROUTE__,
  label: __TITLE__,
  order: 100,
  navigation: __NAVIGATION__,
  // Read-only by default. Declare capabilities and controlled writes explicitly.
  load: () => import('./Panel.tsx'),
};
export default panel;
