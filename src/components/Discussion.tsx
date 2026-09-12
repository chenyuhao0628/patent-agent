import { useState } from 'react';
import { Plus, Send } from 'lucide-react';
import type { Action, Round } from '../domain/workflow.ts';

export function Discussion({ round, dispatch }: { round: Round; dispatch: (a: Action) => void }) {
  const [discussionId, setDiscussionId] = useState(round.discussions[0].id);
  const [text, setText] = useState('');
  const discussion = round.discussions.find(d => d.id === discussionId) ?? round.discussions.at(-1)!;
  return <section className="discussion" aria-label="本轮讨论">
    <div className="section-heading"><select aria-label="选择讨论" value={discussion.id} onChange={e => setDiscussionId(e.target.value)}>{round.discussions.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select>
      <button className="icon-button" aria-label="另开讨论" onClick={() => { dispatch({ type: 'new-discussion' }); setDiscussionId('new'); }}><Plus size={18}/></button></div>
    <div className="messages" aria-live="polite">{!discussion.messages.length && <p className="muted">讨论仅属于当前案件的当前轮次。可以记录取舍，也可以提出修改意见。</p>}
      {discussion.messages.map(m => <div key={m.id} className={`message ${m.role}`}><b>{m.role === 'user' ? '你' : '答复助手 · 演示'}</b><p>{m.text}</p></div>)}</div>
    <form className="composer" onSubmit={e => { e.preventDefault(); dispatch({ type: 'discuss', discussionId: discussion.id, text }); setText(''); }}>
      <textarea aria-label="讨论内容" placeholder="记录策略取舍或修改意见…" value={text} onChange={e => setText(e.target.value)} rows={3}/>
      <div><span className="muted">固定示例回应 · 未连接模型</span><button className="icon-button" aria-label="发送讨论" disabled={!text.trim() || !!round.job}><Send size={18}/></button></div>
    </form>
  </section>;
}
