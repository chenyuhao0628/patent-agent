import {useState} from 'react';
import {desktop} from '../desktop.ts';

export function DiagnosticSettings(){
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [failed,setFailed]=useState(false);
  const exportLogs=async()=>{
    setBusy(true);setMessage('');setFailed(false);
    try{
      const result=await desktop!.diagnosticExport();
      if(!result.canceled)setMessage(`已导出最近 10 分钟日志（${result.count??0} 条）${result.droppedWrites?'；部分日志写入失败，请检查磁盘空间':''}。`);
    }catch{setFailed(true);setMessage('日志导出失败，请检查保存位置和磁盘空间。');}
    finally{setBusy(false);}
  };
  return <><h2>诊断日志</h2><p className="section-copy">日志自动滚动保存，最多占用 5 MB。遇到卡住或任务失败时，可导出最近 10 分钟的记录用于排查。</p><button disabled={!desktop||busy} onClick={()=>void exportLogs()}>{busy?'正在导出…':'导出最近 10 分钟日志'}</button>{message&&<p role={failed?'alert':'status'} className={failed?'inline-warning':'section-copy'}>{message}</p>}</>;
}
