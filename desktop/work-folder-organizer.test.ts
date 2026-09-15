import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { organizeWorkFolders } from './work-folder-organizer.ts';
import type { Case } from '../src/domain/workflow.ts';

test('整理系统生成的案件目录、业务目录和文件名，并可重复执行', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patent-organizer-'));
  const profile = 'alice';
  const old = '案件/alice/OLD_CASE__1234567890';
  const caseRoot = path.join(root, old);
  const c: Case = {
    id: 'case-1', companyName: '甲公司', title: '一种夹持装置', type: '发明',
    number: 'CN-1', deadline: '', archived: false, tags: [], source: 'baseland',
    directory: old,
    current: { kind: 'reply', processId: 'p-reply' },
    remote: { caseId: 'remote-1', syncedAt: '', processes: [
      { id: 'p-write', name: '提出申请', status: 500, node: '', undertaker: '', deadline: '' },
      { id: 'p-reply', name: '第一次审查意见', status: 200, node: '', undertaker: '', deadline: '' },
      { id: 'p-correction', name: '补正通知', status: 500, node: '', undertaker: '', deadline: '' },
    ] },
    rounds: [],
  };
  await fs.mkdir(path.join(caseRoot, '02_工作稿', '提出申请__aaaaaaaa', '2026-09-14_22-00-00_起草稿件__11111111'), { recursive: true });
  await fs.mkdir(path.join(caseRoot, '02_工作稿', '第一次审查意见__bbbbbbbb', '2026-09-14_22-00-00_起草稿件__22222222'), { recursive: true });
  await fs.mkdir(path.join(caseRoot, '03_定稿', '补正通知__cccccccc', '2026-09-14_22-00-00_用户定稿__33333333'), { recursive: true });
  await fs.mkdir(path.join(caseRoot, '04_内部说明', '撰写与审查'), { recursive: true });
  await fs.mkdir(path.join(caseRoot, '01_通知与材料', '未知目录'), { recursive: true });
  await fs.writeFile(path.join(caseRoot, '02_工作稿', '提出申请__aaaaaaaa', '申请文件__deadbeef.docx'), 'a');
  await fs.writeFile(path.join(caseRoot, '02_工作稿', '第一次审查意见__bbbbbbbb', '答复稿__deadbeef.txt'), 'b');
  await fs.writeFile(path.join(caseRoot, '04_内部说明', '撰写与审查', 'agent-run-abc.json'), '{}');
  await fs.writeFile(path.join(caseRoot, '案件信息.json'), JSON.stringify({ schema: 2, id: c.id, profile, title: c.title, number: c.number, type: c.type, materials: [], rounds: [] }));

  const first = await organizeWorkFolders({ provider: '', baseUrl: '', model: '', workRoot: root }, profile, [c]);
  assert.equal(first.report.cases, 1);
  assert.equal(first.report.renamedFolders, 7);
  assert.equal(first.report.renamedFiles, 2);
  assert.match(first.report.unknownPaths.join('\n'), /未知目录/);
  const newRoot = path.join(root, '案件', profile, '甲公司+一种夹持装置+发明');
  assert.equal(await fs.readFile(path.join(newRoot, '02_工作稿', '撰写+一种夹持装置', '申请文件.docx'), 'utf8'), 'a');
  assert.equal(await fs.readFile(path.join(newRoot, '02_工作稿', '答复审查意见+一种夹持装置', '答复稿.txt'), 'utf8'), 'b');
  assert.equal(await fs.access(path.join(newRoot, '04_内部说明', '撰写与审查', 'agent-run-abc.json')), undefined);
  const manifest = JSON.parse(await fs.readFile(path.join(newRoot, '案件信息.json'), 'utf8'));
  assert.equal(manifest.readableFolderName, '甲公司+一种夹持装置+发明');

  const second = await organizeWorkFolders({ provider: '', baseUrl: '', model: '', workRoot: root }, profile, [{ ...c, directory: '案件/alice/甲公司+一种夹持装置+发明' }]);
  assert.equal(second.report.renamedFolders, 0);
  assert.equal(second.report.renamedFiles, 0);
  await fs.rm(root, { recursive: true, force: true });
});
