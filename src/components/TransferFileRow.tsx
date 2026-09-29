import type { ReactNode } from 'react';
import { Cloud, FileText } from 'lucide-react';

/** A single layout for local selections, remote files and the preview picker. */
export function TransferFileRow({name,source,detail,hint,actions}:{
  name:string;source:'local'|'remote';detail?:ReactNode;hint?:string;actions:ReactNode;
}){
  const Icon=source==='remote'?Cloud:FileText;
  return <li className={`transfer-file-row is-${source}`}>
    <span className="transfer-file-icon" aria-hidden="true"><Icon size={19}/></span>
    <div className="transfer-file-info">
      <b className="transfer-file-name">{name}</b>
      {detail&&<div className="transfer-file-detail">{detail}</div>}
      {hint&&<p className="transfer-file-hint">{hint}</p>}
    </div>
    <div className="transfer-file-actions">{actions}</div>
  </li>;
}
