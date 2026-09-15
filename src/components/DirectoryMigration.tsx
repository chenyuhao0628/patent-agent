import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Settings } from '../domain/workflow.ts';
import { desktop } from '../desktop.ts';
import type { DesktopState, MigrationPreview } from '../desktop.ts';
import { Modal, Note } from './Primitives.tsx';
import '../migration.css';
import { FolderOrganization } from './FolderOrganization.tsx';

function formatBytes(n: number) {
  if (n < 1024) return n.toLocaleString('zh-CN') + ' 字节';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function accountLabel(state: DesktopState) {
  const name = state.account?.displayName?.trim() || state.account?.username?.trim();
  return name || '本机工作空间';
}
function otherSettingsDirty(form: Settings, saved: Settings) {
  return form.provider !== saved.provider || form.baseUrl !== saved.baseUrl || form.model !== saved.model
    || (form.templatePath ?? '') !== (saved.templatePath ?? '')
    || JSON.stringify(form.extensions ?? []) !== JSON.stringify(saved.extensions ?? [])
    || (form.originalLibrary ?? '') !== (saved.originalLibrary ?? '');
}

export function DirectoryMigration({
  nativeState, formSettings, saving, onMigrated,
}: {
  nativeState: DesktopState;
  formSettings: Settings;
  saving: boolean;
  onMigrated: (state: DesktopState) => void;
}) {
  const [error, setError] = useState('');
  const [destination, setDestination] = useState('');
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [locking, setLocking] = useState(false);
  const starting = useRef(false);
  const migration = nativeState.migration;
  const running = migration.running;
  const saved = nativeState.workspace.settings;
  const dirty = otherSettingsDirty(formSettings, saved);
  const busy = saving || running || locking;

  const choose = async () => {
    if (!desktop || busy) return;
    setError('');
    try {
      const selected = await desktop.selectDirectory('workRoot');
      if (!selected) return;
      const next = await desktop.previewWorkMigration(nativeState.profileKey, selected);
      setDestination(selected);
      setPreview(next);
      setReviewOpen(true);
    } catch (e) { setError((e as Error).message); }
  };

  const begin = async () => {
    if (!desktop || !preview || starting.current || running || locking) return;
    if (dirty) { setError('请先保存其他设置，再开始迁移。'); return; }
    starting.current = true;
    setLocking(true);
    setError('');
    try {
      onMigrated(await desktop.startWorkMigration(nativeState.profileKey, preview.id));
      setReviewOpen(false);
      setPreview(null);
      setDestination('');
    } catch (e) { setError((e as Error).message); }
    finally { starting.current = false; setLocking(false); }
  };

  const cancel = async () => {
    if (!desktop || !migration.canCancel) return;
    try { onMigrated(await desktop.cancelWorkMigration()); }
    catch (e) { setError((e as Error).message); }
  };

  const closeReview = () => {
    if (running) { if (migration.canCancel) void cancel(); return; }
    setReviewOpen(false);
  };

  return <div className="dir-migration">
    <FolderOrganization state={nativeState}/>
    <h3>迁移当前账号工作目录</h3>
    <p className="lead">仅复制当前账号在「案件 / 当前账号标识」下的全部工作文件到新的总工作文件夹。原始申请文件库保持不动；本机对话、任务和凭证不随工作目录移动。其他账号的案件目录不会复制。</p>
    <dl className="dir-migration-facts">
      <div><dt>当前总工作文件夹</dt><dd>{saved.workRoot || '尚未选择'}</dd></div>
      <div><dt>原始申请文件库</dt><dd>{saved.originalLibrary || '未选择'} · 迁移时保持不动</dd></div>
      <div><dt>当前账号</dt><dd>{accountLabel(nativeState)}</dd></div>
    </dl>
    <label className="field">新的总工作文件夹
      <div className="native-directory">
        <input readOnly value={destination} placeholder="请选择或新建一个空文件夹"/>
        <button type="button" disabled={!desktop || busy} onClick={() => void choose()}><FolderOpen size={15}/>选择空文件夹</button>
      </div>
    </label>
    <p className="dir-migration-note">请选择或在系统选择器中新建空文件夹。不会合并或覆盖目标中的现有内容。原位置文件在成功后保留作为备份。</p>
    {dirty && <p className="dir-migration-note">当前设置页还有未保存的其他修改。请先保存设置，再开始迁移。</p>}
    {error && <p className="inline-warning" role="alert">{error}</p>}
    {migration.phase === 'failed' && migration.error && !error && <p className="inline-warning" role="alert">{migration.error}</p>}
    {migration.phase === 'done' && migration.message && <p className="dir-migration-note" role="status">{migration.message}</p>}
    <Note>关闭应用会中止尚未提交的复制，不会把未完成的新目录当成当前工作文件夹。</Note>
    {reviewOpen && preview && <Modal title={running ? '正在迁移当前账号工作目录' : '确认迁移当前账号工作目录'} onClose={closeReview}>
      <dl className="dir-migration-preview">
        <div><dt>当前总工作文件夹</dt><dd>{preview.sourceRoot}</dd></div>
        <div><dt>新的总工作文件夹</dt><dd>{preview.destinationRoot}</dd></div>
        <div><dt>原始申请文件库</dt><dd>{preview.originalLibrary || '未选择'} · 保持不动</dd></div>
        <div><dt>已编入索引的案件</dt><dd>{preview.caseDirectoryCount.toLocaleString('zh-CN')} 个</dd></div>
        <div><dt>其他工作子文件夹</dt><dd>{preview.extraDirectoryCount.toLocaleString('zh-CN')} 个（一并复制，不计入案件）</dd></div>
        <div><dt>当前账号文件</dt><dd>{preview.fileCount.toLocaleString('zh-CN')} 个文件，{preview.directoryCount.toLocaleString('zh-CN')} 个文件夹，{formatBytes(preview.byteCount)}</dd></div>
      </dl>
      <ul className="dir-migration-guarantees">
        <li>只迁移当前账号命名空间，其他账号目录留在原位置。</li>
        <li>包含未编入索引的案件目录和手工材料；案件编号与相对路径保持不变。</li>
        <li>已复制到案件「00_原始申请」中的文件随工作数据一起复制，不会再读取原始申请文件库。</li>
        <li>原工作文件成功后保留作为备份；目标必须是空文件夹。</li>
        {preview.emptyNamespace && <li>当前账号下没有工作文件，确认后只切换总工作文件夹设置。</li>}
      </ul>
      {running && <div className="dir-migration-progress" role="status" aria-live="polite">
        <strong>{migration.message || '正在迁移…'}</strong>
        {migration.progress && <span className="muted">
          {migration.phase === 'verifying'
            ? `已校验 ${migration.progress.verifiedFiles.toLocaleString('zh-CN')} / ${migration.progress.totalFiles.toLocaleString('zh-CN')} 个文件`
            : `已复制 ${migration.progress.copiedFiles.toLocaleString('zh-CN')} / ${migration.progress.totalFiles.toLocaleString('zh-CN')} 个文件，${formatBytes(migration.progress.copiedBytes)} / ${formatBytes(migration.progress.totalBytes)}`}
          {migration.progress.currentPath ? ` · ${migration.progress.currentPath}` : ''}
        </span>}
      </div>}
      {error && <p className="inline-warning" role="alert">{error}</p>}
      <div className="action-bar">
        {running
          ? <button type="button" disabled={!migration.canCancel} onClick={() => void cancel()}>取消迁移</button>
          : <><button type="button" onClick={() => setReviewOpen(false)}>返回</button>
            <button className="primary" type="button" disabled={busy || dirty} onClick={() => void begin()}>开始迁移</button></>}
      </div>
    </Modal>}
  </div>;
}
