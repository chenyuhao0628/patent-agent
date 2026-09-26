import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ipcAgentCommand,
  ipcApplicationPreferences,
  ipcArgs,
  ipcCaseId,
  ipcBoolean,
  ipcCreateCaseInput,
  ipcDesktopScope,
  ipcExtensionMethod,
  ipcExtensionsArgs,
  ipcLoginInput,
  ipcMaterialId,
  ipcProcessId,
  ipcProfileKey,
  ipcProfessionalCommand,
  ipcPriorArtMethod,
  ipcPriorArtArgs,
  ipcRelativePath,
  ipcSettings,
  ipcNoArgs,
  ipcOptional,
  ipcTransferFilePreviewRef,
  ipcTransferReview,
  ipcTransferRole,
  ipcTransferSource,
  ipcSyncSource,
  ipcDocumentToolsConfig,
  ipcWorkspace,
} from './ipc-contracts.ts';
import { PROFESSIONAL_DECISION_MAX, PROFESSIONAL_WRITE_MESSAGE_MAX } from '../src/professional-api.ts';

test('IPC contract guards accept scoped commands', () => {
  assert.equal(ipcProfileKey('account-1'), 'account-1');
  assert.equal(ipcCaseId('case-1'), 'case-1');
  assert.equal(ipcProcessId('process-1'), 'process-1');
  assert.equal(ipcMaterialId('material-1'), 'material-1');
  assert.equal(ipcBoolean(true, '启用状态'), true);
  assert.equal(ipcExtensionMethod('saveSkill'), 'saveSkill');
  assert.equal(ipcPriorArtMethod('prepare'), 'prepare');
  assert.deepEqual(ipcLoginInput({ origin: 'https://example.test', username: 'u', password: 'p', remember: false }), {
    origin: 'https://example.test', username: 'u', password: 'p', remember: false,
  });
  assert.deepEqual(ipcCreateCaseInput({ title: '案件', number: 'CN-1', kind: 'write' }), { title: '案件', number: 'CN-1', kind: 'write' });
  assert.deepEqual(ipcSettings({ provider: 'p', baseUrl: '', model: '', lastTransferRecipient: { userId: 'u', userName: '', stepId: '' } }), { provider: 'p', baseUrl: '', model: '', lastTransferRecipient: { userId: 'u', userName: '', stepId: '' } });
  assert.deepEqual(ipcTransferFilePreviewRef({ role: 'reply', name: 'reply.docx' }), { role: 'reply', name: 'reply.docx' });
  assert.deepEqual(ipcAgentCommand({ type: 'applicationParts', parts: { CLAIMS: '1. 一种装置。' } }), { type: 'applicationParts', parts: { CLAIMS: '1. 一种装置。' } });
  assert.equal(ipcRelativePath('04_内部说明/report.docx'), '04_内部说明/report.docx');
  assert.equal(ipcTransferRole('reply'), 'reply');
  assert.equal(ipcTransferSource('workbench'), 'workbench');
  assert.equal(ipcSyncSource(undefined), undefined);
  assert.deepEqual(ipcDesktopScope({ profileKey: 'account-1', scopeVersion: 3, caseId: 'case-1', processKey: 'process-1' }), {
    profileKey: 'account-1', scopeVersion: 3, caseId: 'case-1', processKey: 'process-1',
  });
  assert.deepEqual(ipcNoArgs([]), []);
  assert.deepEqual(ipcArgs(ipcProfileKey, ipcCaseId)(['account-1', 'case-1']), ['account-1', 'case-1']);
  assert.deepEqual(ipcArgs(ipcProfileKey, ipcOptional(ipcCaseId))(['account-1']), ['account-1', undefined]);
  assert.deepEqual(ipcArgs(ipcOptional(ipcCaseId), ipcProfileKey)([undefined, 'account-1']), [undefined, 'account-1']);
  assert.deepEqual(ipcExtensionsArgs(['saveMcp', 'account-1', '{}']), ['saveMcp', 'account-1', '{}', undefined]);
  assert.deepEqual(ipcPriorArtArgs(['save', 'account-1', 'token']), ['save', 'account-1', 'token']);
  assert.deepEqual(ipcApplicationPreferences({ openAtLogin: false, startHidden: false, closeBehavior: 'quit', minimizeToTray: true }), {
    openAtLogin: false, startHidden: false, closeBehavior: 'quit', minimizeToTray: true,
  });
  assert.deepEqual(ipcDocumentToolsConfig({ webEnabled: true, autoInstall: false, commandsEnabled: false, downloadsEnabled: true }), {
    webEnabled: true, autoInstall: false, commandsEnabled: false, downloadsEnabled: true,
  });
  assert.deepEqual(ipcAgentCommand({ type: 'opened' }), { type: 'opened' });
  assert.deepEqual(ipcAgentCommand({ type: 'run', action: 'discuss' }), { type: 'run', action: 'discuss' });
  assert.deepEqual(ipcAgentCommand({ type: 'queue', discussionId: 'd-1', operation: 'add', text: '待发送', purpose: 'discuss' }), { type: 'queue', discussionId: 'd-1', operation: 'add', text: '待发送', purpose: 'discuss' });
  assert.deepEqual(ipcAgentCommand({ type: 'conversation', discussionId: 'd-1', operation: 'retry', runId: 'run-1' }), { type: 'conversation', discussionId: 'd-1', operation: 'retry', runId: 'run-1' });
  assert.deepEqual(ipcAgentCommand({ type: 'classify', classification: { patentType: '发明' } }), { type: 'classify', classification: { patentType: '发明' } });
  assert.deepEqual(ipcProfessionalCommand({ type: 'write', message: '开始', materialIds: [] }), { type: 'write', message: '开始', materialIds: [] });
  assert.deepEqual(ipcProfessionalCommand({ type: 'write', message: '', materialIds: [] }), { type: 'write', message: '', materialIds: [] });
  assert.deepEqual(ipcProfessionalCommand({ type: 'confirm', jobId: 'job-1', decision: '' }), { type: 'confirm', jobId: 'job-1', decision: '' });
  assert.deepEqual(ipcProfessionalCommand({ type: 'stop' }), { type: 'stop' });
  assert.deepEqual(ipcTransferReview({
    keepCodes: [],
    form: {
      noticeDate: '',
      noticeName: '',
      noticeNo: '',
      correctionReason: 1,
      addEntrust: false,
      corrections: [],
      otherProof: false,
      experimentData: false,
      abstractFigure: '1',
      declarations: {},
    },
    stepId: 'step-1',
    userId: 'user-1',
    remark: '',
  }), {
    keepCodes: [],
    form: {
      noticeDate: '',
      noticeName: '',
      noticeNo: '',
      correctionReason: 1,
      addEntrust: false,
      corrections: [],
      otherProof: false,
      experimentData: false,
      abstractFigure: '1',
      declarations: {},
    },
    stepId: 'step-1',
    userId: 'user-1',
    remark: '',
  });
  assert.doesNotThrow(() => ipcTransferReview({
    keepCodes: [],
    form: {
      noticeDate: '',
      noticeName: '',
      noticeNo: '',
      correctionReason: 1,
      addEntrust: false,
      corrections: [{
        ChangeId: 'draft-row-1',
        Sort: 0,
        FileName: '权利要求书',
        PositionInFile: '',
        CorrectionBefore: '',
        CorrectionAfter: '',
      }],
      otherProof: false,
      experimentData: false,
      abstractFigure: '',
      declarations: {},
    },
    stepId: '',
    userId: '',
    remark: '',
  }));
});

test('IPC contract guards reject malformed or unsupported commands', () => {
  assert.throws(() => ipcProfileKey('../other-account'), /账号标识格式无效/);
  assert.throws(() => ipcCaseId(''), /案件标识无效/);
  assert.throws(() => ipcRelativePath('/etc/passwd'), /文件路径无效/);
  assert.throws(() => ipcRelativePath('../secret'), /文件路径无效/);
  assert.throws(() => ipcRelativePath('C:relative.txt'), /文件路径无效/);
  assert.throws(() => ipcRelativePath('safe/\0name.txt'), /文件路径无效/);
  assert.throws(() => ipcTransferRole('secret'), /文件用途无效/);
  assert.throws(() => ipcTransferSource('remote'), /材料来源无效/);
  assert.throws(() => ipcAgentCommand({ type: 'unknown' }), /不支持的 Agent 操作/);
  assert.throws(() => ipcAgentCommand({ type: 'run' }), /Agent 动作无效/);
  assert.throws(() => ipcAgentCommand({ type: 'materials', selectedIds: 'not-array' }), /材料选择无效/);
  assert.throws(() => ipcAgentCommand({ type: 'queue', discussionId: 'd-1', operation: 'add', text: '内容', purpose: 'other' }), /发送用途无效/);
  assert.throws(() => ipcAgentCommand({ type: 'queue', discussionId: 'd-1', operation: 'remove' }), /队列消息标识无效/);
  assert.throws(() => ipcAgentCommand({ type: 'conversation', discussionId: 'd-1', operation: 'edit', messageId: 'm-1' }), /对话内容无效/);
  assert.throws(() => ipcAgentCommand({ type: 'conversation', discussionId: 'd-1', operation: 'retry' }), /任务标识无效/);
  assert.throws(() => ipcProfessionalCommand({ type: 'unknown' }), /不支持的专业工作操作/);
  assert.throws(() => ipcProfessionalCommand({ type: 'write' }), /撰写要求无效/);
  assert.throws(() => ipcProfessionalCommand({ type: 'write', materialIds: [] }), /撰写要求无效/);
  assert.throws(() => ipcProfessionalCommand({ type: 'confirm', jobId: 'job-1' }), /确认意见无效/);
  assert.throws(() => ipcBoolean('true', '启用状态'), /启用状态无效/);
  assert.throws(() => ipcExtensionMethod('unknown'), /不支持的扩展操作/);
  assert.throws(() => ipcPriorArtMethod('unknown'), /不支持的对比文件操作/);
  assert.throws(() => ipcLoginInput({ origin: 'x', username: 'u', password: 'p', remember: 'no' }), /记住登录无效/);
  assert.throws(() => ipcCreateCaseInput({ title: '案件', number: 'CN-1', kind: 'other' }), /当前业务无效/);
  assert.throws(() => ipcSettings({ provider: 'p' }), /设置内容无效/);
  assert.throws(() => ipcSettings({ provider: 'p', baseUrl: '', model: '', lastTransferRecipient: { userId: '' } }), /设置内容无效/);
  assert.throws(() => ipcTransferFilePreviewRef({ name: 1 }), /文件预览请求无效/);
  assert.throws(() => ipcWorkspace({ schema: 2, cases: [], settings: {} }), /案件记录格式不正确/);
  assert.throws(() => ipcAgentCommand({ type: 'applicationParts', parts: [] }), /申请文件部分/);
  assert.throws(() => ipcAgentCommand({ type: 'materials', selectedIds: [''] }), /材料选择无效/);
  assert.throws(() => ipcAgentCommand({ type: 'run', action: 'invalid' }), /Agent 动作无效/);
  assert.throws(() => ipcProfessionalCommand({ type: 'write', materialIds: ['ok'], message: 1 }), /撰写要求无效/);
  assert.throws(() => ipcProfessionalCommand({ type: 'write', materialIds: [], message: 'x'.repeat(PROFESSIONAL_WRITE_MESSAGE_MAX + 1) }), /撰写要求无效/);
  assert.throws(() => ipcProfessionalCommand({ type: 'confirm', jobId: 'job-1', decision: 'x'.repeat(PROFESSIONAL_DECISION_MAX + 1) }), /确认意见无效/);
  assert.throws(() => ipcTransferReview({ keepCodes: [] }), /核对内容不完整/);
  assert.throws(() => ipcTransferReview({
    keepCodes: [],
    form: { noticeDate: '', noticeName: '', noticeNo: '', correctionReason: 1, addEntrust: false, corrections: [], otherProof: false, experimentData: false, abstractFigure: '1', declarations: { IsPublicAdvance: 'yes' } },
    stepId: 'step-1',
    userId: 'user-1',
    remark: '',
  }), /声明内容无效/);
  assert.throws(() => ipcTransferReview({
    keepCodes: [],
    form: {
      noticeDate: '',
      noticeName: '',
      noticeNo: '',
      correctionReason: 1,
      addEntrust: false,
      corrections: [{ ChangeId: '', Sort: 0, FileName: '', PositionInFile: '', CorrectionBefore: '', CorrectionAfter: '' }],
      otherProof: false,
      experimentData: false,
      abstractFigure: '',
      declarations: {},
    },
    stepId: '',
    userId: '',
    remark: '',
  }), /补正条目标识无效/);
  assert.throws(() => ipcNoArgs(['unexpected']), /不接受参数/);
  assert.throws(() => ipcArgs(ipcProfileKey)(['account-1', 'extra']), /参数数量无效/);
  assert.throws(() => ipcArgs(ipcOptional(ipcCaseId), ipcProfileKey)([]), /参数数量无效/);
  assert.throws(() => ipcExtensionsArgs(['list', 'account-1', 'extra']), /参数数量无效/);
  assert.throws(() => ipcPriorArtArgs(['save', 'account-1']), /参数数量无效/);
  assert.throws(() => ipcApplicationPreferences({ openAtLogin: 'yes' }), /应用设置格式无效/);
  assert.throws(() => ipcDocumentToolsConfig({ webEnabled: true }), /工具权限设置无效/);
  assert.throws(() => ipcDesktopScope({ profileKey: 'account-1', scopeVersion: -1 }), /桌面作用域无效/);
  assert.throws(() => ipcDesktopScope({ profileKey: 'account-1', scopeVersion: 1, caseId: '' }), /桌面作用域无效/);
  assert.throws(() => ipcDesktopScope({ profileKey: 'account-1', scopeVersion: 1, caseId: 'case-1' }), /桌面作用域无效/);
  assert.throws(() => ipcDesktopScope({ profileKey: 'account-1', scopeVersion: 1, processKey: 'process-1' }), /桌面作用域无效/);
});
