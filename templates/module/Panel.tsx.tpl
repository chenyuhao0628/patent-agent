import { useSyncExternalStore } from 'react';
import type { PanelProps } from '../../../app/panel-types.ts';

export default function Panel({ context, data }: PanelProps) {
  if (context.kind !== __LOCATION__) throw new Error('面板位置与注册不匹配。');
  const cases = useSyncExternalStore(data.subscribe, data.listCases, data.listCases);
  return <section className="page-pad" data-panel-id=__ID__>
    <h2>__TITLE_TEXT__</h2>
    <p>__SCOPE_TEXT__</p>
    {cases.length ? <ul>{cases.map(item => <li key={item.id}>{item.number} · {item.title}</li>)}</ul> : <p>暂无案件。</p>}
  </section>;
}
