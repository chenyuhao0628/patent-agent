import { useState } from 'react';
import { FolderSync, ShieldCheck } from 'lucide-react';
import { desktop } from '../desktop.ts';
import type { DesktopState, FolderOrganizationReport } from '../desktop.ts';

export function FolderOrganization({ state }: { state: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<FolderOrganizationReport>();
  const [error, setError] = useState('');
  const run = async () => {
    if (!desktop || busy) return;
    setBusy(true); setError(''); setReport(undefined);
    try { setReport(await desktop.organizeWorkFolders(state.profileKey)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="agent-card">
    <h3>整理历史工作文件夹</h3>
    <p>按客户、专利名称和专利类型整理案件目录，并将撰写、审查意见答复、补正及历史文件统一改为可读名称。案件数据和文件内容不变。</p>
    <div className="button-row"><button className="primary" disabled={busy || state.sync.running || state.storage.running || state.migration.running} onClick={() => void run()}><FolderSync size={15}/>{busy ? '正在整理…' : '一键整理全部工作文件夹'}</button></div>
    <p className="muted">系统内部索引文件保留必要的机器前缀；无法确认归属的目录不修改，只列入结果。整理前请暂停其他电脑对同一工作目录的修改。</p>
    {report && <div className="setting-explanation" role="status"><ShieldCheck size={20}/><div><b>{report.message}</b>{report.skippedFiles > 0 && <p>保留 {report.skippedFiles} 个内部索引文件名，以确保任务恢复和历史读取正常。</p>}{report.unknownPaths.length > 0 && <p className="inline-warning">以下 {report.unknownPaths.length} 个路径未修改：{report.unknownPaths.slice(0, 5).join('；')}{report.unknownPaths.length > 5 ? '；…' : ''}</p>}</div></div>}
    {error && <p className="inline-warning" role="alert">{error}</p>}
  </div>;
}
