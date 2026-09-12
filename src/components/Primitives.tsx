import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X, CircleCheck, ChevronRight } from 'lucide-react';

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-head"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X /></button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h2>{title}</h2><p>{children}</p></div>;
}
export function Note({ children }: { children: ReactNode }) { return <p className="note">{children}</p>; }
export function Ready() { return <span className="ready"><CircleCheck size={16} /> 已就绪</span>; }
export function Trail({ children }: { children: ReactNode }) { return <span className="trail"><ChevronRight size={15}/>{children}</span>; }
