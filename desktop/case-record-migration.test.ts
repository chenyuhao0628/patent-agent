import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopService } from './service.ts';
import { atomicJSON, digest } from './files.ts';
import { caseRecordFromCase } from '../src/domain/case-record.ts';
import type { Case } from '../src/domain/workflow.ts';
import { makeRound } from '../src/domain/workflow.ts';
import { readSharedCases } from './shared.ts';

const fixture = (): Case => ({
  id: 'synthetic', title: 'Migration fixture', number: 'SYN-1', type: 'invention', deadline: '',
  archived: false, tags: [], rounds: [], source: 'local', current: { kind: 'write' },
  localDraft: '  preserve whitespace\n', localVersions: [{ id: 'v1', text: 'old', at: '2026-09-25' }],
});

async function setup(t: test.TestContext, canonical = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'case-record-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new DesktopService(root, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
  const cases = [fixture()], records = cases.map(caseRecordFromCase);
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  const stored = {
    schema: 1, profile: 'local', settings: { provider: '', baseUrl: '', model: '', workRoot: work }, cases,
    ...(canonical ? { caseRecords: records, caseRecordsSchema: 1, caseRecordsHash: digest(JSON.stringify(records)) } : {}),
  };
  return { root, service, stored, records };
}

test('legacy migration backs up exact bytes and retains drafts and unknown fields', async t => {
  const { service, stored } = await setup(t, false);
  Object.assign(stored, { futureWorkspace: { version: 9 } });
  Object.assign(stored.cases[0], { futureCase: { retained: true } });
  await atomicJSON(service.profileFile(), stored);
  const bytes = await fs.readFile(service.profileFile());
  await service.init(false);
  const names = await fs.readdir(path.dirname(service.profileFile()));
  const backup = names.find(name => name.startsWith('workspace.migration-backup.'));
  assert.ok(backup);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(service.profileFile()), backup)), bytes);
  const next = JSON.parse(await fs.readFile(service.profileFile(), 'utf8'));
  assert.equal(next.caseRecords[0].manuscripts.localDraft, stored.cases[0].localDraft);
  assert.equal(next.caseRecords[0].manuscripts.design, undefined);
  assert.equal(next.caseRecords[0].extensions.__caseSnapshot, undefined);
  assert.deepEqual(next.futureWorkspace, { version: 9 });
  assert.deepEqual(next.caseRecords[0].extensions.futureCase, { retained: true });
});

test('canonical hash is checked against raw bytes before normalization and unknown fields survive saves', async t => {
  const { service, stored, records } = await setup(t);
  Object.assign(records[0].stage, { futureStage: { text: 'keep' } });
  stored.caseRecordsHash = digest(JSON.stringify(records));
  await atomicJSON(service.profileFile(), stored);
  await service.init(false);
  await service.persist();
  const next = JSON.parse(await fs.readFile(service.profileFile(), 'utf8'));
  assert.deepEqual(next.caseRecords[0].stage.futureStage, { text: 'keep' });
  assert.equal(next.caseRecordsHash, digest(JSON.stringify(next.caseRecords)));
});

for (const kind of ['hash', 'partial', 'account', 'legacy','conflict'] as const) {
  test(`unsafe ${kind} workspace cannot write files, memory edits or replacement index`, async t => {
    const { service, stored } = await setup(t, kind !== 'legacy');
    if (kind === 'hash') stored.caseRecordsHash = 'bad';
    if (kind === 'partial') { stored.caseRecords = []; stored.caseRecordsHash = digest('[]'); }
    if (kind === 'account') stored.profile = 'other-account';
    if (kind === 'legacy') Object.assign(stored.cases[0], { rounds: null });
    if (kind === 'conflict') stored.cases[0].localDraft='A later edit by an older desktop';
    await atomicJSON(service.profileFile(), stored);
    const bytes = await fs.readFile(service.profileFile());
    await service.init(false);
    assert.match(service.state().storage.message, /安全读取/);
    if (kind === 'account') assert.deepEqual(service.workspace.cases, []);
    const before = structuredClone(service.workspace);
    await assert.rejects(service.createCase({ title: 'No write', number: 'NO', kind: 'write' }), /安全校验/);
    await assert.rejects(service.save(service.key, before), /安全校验/);
    assert.throws(() => service.files(), /安全校验/);
    assert.deepEqual(service.workspace, before);
    assert.deepEqual(await fs.readFile(service.profileFile()), bytes);
    assert.deepEqual(await fs.readdir(stored.settings.workRoot), []);
  });
}

test('canonical restart and account namespaces keep same-ID manuscripts separate',async t=>{
  const {service,stored}=await setup(t);
  await atomicJSON(service.profileFile(),stored);
  await service.init(false);
  await service.persist();
  const second=new DesktopService(service.root,service.vault);
  second.key='other';
  const otherCases=[{...fixture(),localDraft:'Other account draft'}],otherRecords=otherCases.map(caseRecordFromCase);
  await atomicJSON(second.profileFile(),{...stored,profile:'other',cases:otherCases,caseRecords:otherRecords,caseRecordsHash:digest(JSON.stringify(otherRecords))});
  await second.init(false);
  assert.equal(second.replyCase('synthetic').manuscripts.localDraft,'Other account draft');
  assert.equal(service.replyCase('synthetic').manuscripts.localDraft,fixture().localDraft);
  const before=await fs.readFile(service.profileFile());
  await second.persist();
  assert.deepEqual(await fs.readFile(service.profileFile()),before);
});

test('truncated workspace remains byte-identical and exposes a non-writable recovery state',async t=>{
  const {service,stored}=await setup(t);
  await atomicJSON(service.profileFile(),stored);
  await fs.writeFile(service.profileFile(),'{"schema":1,"cases":');
  const before=await fs.readFile(service.profileFile());
  await service.init(false);
  assert.match(service.state().storage.message,/安全读取/);
  await assert.rejects(service.persist(),/安全校验/);
  assert.deepEqual(await fs.readFile(service.profileFile()),before);
});

test('shared schema-3 reload preserves missing local history and drafts replaced by another device',async t=>{
  const {service,stored}=await setup(t);
  service.workspace.settings=stored.settings;
  const original=fixture();
  const round=makeRound('历史通知');round.draft='旧轮次正文';round.materials=[];
  original.rounds=[round];
  service.workspace.cases=[original];
  original.directory=await service.files().ensureCase(original);
  const remote=structuredClone(original);
  remote.rounds=[];remote.localDraft='另一设备保存的稿';remote.localVersions=[];
  await service.files().saveDraft(remote);
  const result=await readSharedCases(stored.settings.workRoot,'local',[original]);
  assert.deepEqual(result.warnings,[]);
  const loaded=result.cases[0];
  assert.equal(loaded.rounds[0].draft,'旧轮次正文');
  assert.equal(loaded.localDraft,'另一设备保存的稿');
  assert.ok(loaded.localVersions?.some(v=>v.text===original.localDraft));
  assert.ok(loaded.localVersions?.some(v=>v.id==='v1'&&v.text==='old'));
});

test('shared reload retains local material associations and rejects reused identities',async t=>{
  const {service,stored}=await setup(t);
  service.workspace.settings=stored.settings;
  const original=fixture(),round=makeRound('历史通知');
  const material={id:'manual',name:'Retained.txt',role:'历史材料',location:'本案',excerpt:'Parsed original',ready:false,relativePath:'01_通知与材料/Retained.txt'};
  round.materials=[material];original.rounds=[round];original.materials=[{...material,id:'reference'}];
  original.directory=await service.files().ensureCase(original);
  const incoming=structuredClone(original);
  incoming.materials=[];incoming.rounds[0].materials=[];
  await service.files().ensureCase(incoming);
  const result=await readSharedCases(stored.settings.workRoot,'local',[original]);
  assert.deepEqual(result.warnings,[]);
  assert.deepEqual(result.cases[0].materials,original.materials);
  assert.deepEqual(result.cases[0].rounds[0].materials,round.materials);
  incoming.rounds[0].materials=[{...material,relativePath:'01_通知与材料/Different.txt'}];
  await service.files().ensureCase(incoming);
  const conflict=await readSharedCases(stored.settings.workRoot,'local',[original]);
  assert.equal(conflict.warnings.length,1);
  assert.deepEqual(conflict.cases[0],original);
});

test('shared canonical and compatibility identity conflicts keep the local case unchanged',async t=>{
  const {service,stored}=await setup(t);
  service.workspace.settings=stored.settings;
  const original=fixture();
  original.directory=await service.files().ensureCase(original);
  service.workspace.cases=[original];
  const file=await service.casePath(original.id,'案件信息.json');
  const manifest=JSON.parse(await fs.readFile(file,'utf8'));
  manifest.domains.identity.id='foreign-case';
  await atomicJSON(file,manifest);
  const result=await readSharedCases(stored.settings.workRoot,'local',[original]);
  assert.equal(result.warnings.length,1);
  assert.deepEqual(result.cases,[original]);
});

test('shared refresh retains explicit permissions and only invalidates the scope on a real permission change',async t=>{
  const {service,stored}=await setup(t);
  service.workspace.settings=stored.settings;
  const c=fixture();
  c.source='baseland';c.current={kind:'write',processId:'p',remoteStatus:200};
  c.remote={caseId:'remote',syncedAt:'',processes:[{
    id:'p',name:'提出申请',status:200,personalStatus:200,canEdit:true,node:'办理中',undertaker:'synthetic',deadline:'',
  }]};
  service.workspace.cases=[c];
  await service.files().saveDraft(c);
  const scope=service.captureScope(service.key,c.id);
  await service.refreshShared(service.key);
  service.assertScope(scope);
  assert.equal(service.findCase(c.id).remote?.processes[0].canEdit,true);
  assert.equal(service.findCase(c.id).remote?.processes[0].personalStatus,200);
  const revoked=structuredClone(service.findCase(c.id));
  revoked.remote!.processes[0].canEdit=false;
  await service.files().ensureCase(revoked);
  await service.refreshShared(service.key);
  assert.equal(service.findCase(c.id).remote?.processes[0].canEdit,false);
  assert.throws(()=>service.assertScope(scope),/重新切换/);
});
