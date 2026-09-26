import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ipcAgentCommand,
  ipcCaseId,
  ipcBoolean,
  ipcExtensionMethod,
  ipcMaterialId,
  ipcProcessId,
  ipcProfileKey,
  ipcProfessionalCommand,
  ipcPriorArtMethod,
  ipcRelativePath,
  ipcTransferReview,
  ipcTransferRole,
  ipcTransferSource,
} from './ipc-contracts.ts';

test('IPC contract guards accept scoped commands', () => {
  assert.equal(ipcProfileKey('account-1'), 'account-1');
  assert.equal(ipcCaseId('case-1'), 'case-1');
  assert.equal(ipcProcessId('process-1'), 'process-1');
  assert.equal(ipcMaterialId('material-1'), 'material-1');
  assert.equal(ipcBoolean(true, '启用状态'), true);
  assert.equal(ipcExtensionMethod('saveSkill'), 'saveSkill');
  assert.equal(ipcPriorArtMethod('prepare'), 'prepare');
  assert.equal(ipcRelativePath('04_内部说明/report.docx'), '04_内部说明/report.docx');
  assert.equal(ipcTransferRole('reply'), 'reply');
  assert.equal(ipcTransferSource('workbench'), 'workbench');
  assert.deepEqual(ipcAgentCommand({ type: 'opened' }), { type: 'opened' });
  assert.deepEqual(ipcAgentCommand({ type: 'run', action: 'discuss' }), { type: 'run', action: 'discuss' });
  assert.deepEqual(ipcProfessionalCommand({ type: 'write', message: '开始', materialIds: [] }), { type: 'write', message: '开始', materialIds: [] });
  assert.deepEqual(ipcProfessionalCommand({ type: 'stop' }), { type: 'stop' });
  assert.deepEqual(ipcTransferReview({
    keepCodes: [],
    form: {},
    stepId: 'step-1',
    userId: 'user-1',
    remark: '',
  }), {
    keepCodes: [],
    form: {},
    stepId: 'step-1',
    userId: 'user-1',
    remark: '',
  });
});

test('IPC contract guards reject malformed or unsupported commands', () => {
  assert.throws(() => ipcProfileKey('../other-account'), /账号标识格式无效/);
  assert.throws(() => ipcCaseId(''), /案件标识无效/);
  assert.throws(() => ipcRelativePath('/etc/passwd'), /文件路径无效/);
  assert.throws(() => ipcRelativePath('../secret'), /文件路径无效/);
  assert.throws(() => ipcTransferRole('secret'), /文件用途无效/);
  assert.throws(() => ipcTransferSource('remote'), /材料来源无效/);
  assert.throws(() => ipcAgentCommand({ type: 'unknown' }), /不支持的 Agent 操作/);
  assert.throws(() => ipcAgentCommand({ type: 'run' }), /Agent 动作无效/);
  assert.throws(() => ipcAgentCommand({ type: 'materials', selectedIds: 'not-array' }), /材料选择无效/);
  assert.throws(() => ipcProfessionalCommand({ type: 'unknown' }), /不支持的专业工作操作/);
  assert.throws(() => ipcProfessionalCommand({ type: 'write', materialIds: [] }), /撰写要求无效/);
  assert.throws(() => ipcBoolean('true', '启用状态'), /启用状态无效/);
  assert.throws(() => ipcExtensionMethod('unknown'), /不支持的扩展操作/);
  assert.throws(() => ipcPriorArtMethod('unknown'), /不支持的对比文件操作/);
  assert.throws(() => ipcTransferReview({ keepCodes: [] }), /核对内容不完整/);
});
