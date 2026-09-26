import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X, CircleCheck, ChevronRight, AlertTriangle, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';

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

export function LoadingState({ children = '正在读取…' }: { children?: ReactNode }) {
  return <div className="surface-state is-loading" role="status"><LoaderCircle className="spin" size={17}/><span>{children}</span></div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="surface-state is-error" role="alert"><AlertTriangle size={17}/><span>{message}</span>{onRetry && <button type="button" onClick={onRetry}><RefreshCw size={14}/>重试</button>}</div>;
}

export function ReadonlyState({ children = '当前内容仅可查看。' }: { children?: ReactNode }) {
  return <div className="surface-state is-readonly" role="status"><LockKeyhole size={17}/><span>{children}</span></div>;
}
