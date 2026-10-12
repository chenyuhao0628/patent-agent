import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeManager } from './runtime-manager.ts';
import { runtimeFileHash, type InstalledRuntime, type RuntimeRelease } from './runtime-download.ts';
import type { AgentRunInput } from './agent-runner.ts';

async function setup(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'runtime-manager-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const binaryPath=path.join(root,'bundled');await fs.writeFile(binaryPath,'synthetic bundled');
  const bundled:InstalledRuntime={version:'2.0.1',sha256:await runtimeFileHash(binaryPath),binaryPath,source:'bundled'};
  let downloads=0,verifications=0,fail=false,version='2.42.0';
  const latest=async():Promise<RuntimeRelease>=>({version,packageName:'synthetic',tarball:'synthetic',integrity:'synthetic-'+version});
  const download=async(release:RuntimeRelease,directory:string)=>{downloads++;const binaryPath=path.join(directory,'opencode');await fs.writeFile(binaryPath,release.version);return {version:release.version,binaryPath,sha256:await runtimeFileHash(binaryPath),source:'update' as const};};
  const verify=async(binary:string)=>{verifications++;if(fail)throw new Error('OpenCode 兼容性检查未通过：合成失败');return {version:await fs.readFile(binary,'utf8')};};
  const options={root:path.join(root,'updates'),bundled,latest,download,verify,startAutomaticChecks:false};
  const manager=new RuntimeManager(options);await manager.init();t.after(()=>manager.shutdown());
  return {root,manager,options,counts:()=>({downloads,verifications}),fail:()=>{fail=true;},version:(v:string)=>{version=v;}};
}

test('compatible update is verified once and switches only after every held task exits',async t=>{
  const f=await setup(t),a=await f.manager.acquire(),b=await f.manager.acquire();
  const check=f.manager.check();assert.equal(check,f.manager.check());await check;
  assert.equal(f.manager.status().activeVersion,'2.0.1');assert.equal(f.manager.status().candidateVersion,'2.42.0');
  await a.release();assert.equal(f.manager.status().activeVersion,'2.0.1');
  await b.release();assert.equal(f.manager.status().activeVersion,'2.42.0');assert.equal(f.manager.status().previousVersion,'2.0.1');
  assert.deepEqual(f.counts(),{downloads:1,verifications:1});
  await f.manager.check();assert.equal(f.counts().downloads,1);
});

test('failed candidate never activates and is not downloaded repeatedly for the same official release',async t=>{
  const f=await setup(t);f.fail();await f.manager.check();await f.manager.check();
  assert.equal(f.manager.status().activeVersion,'2.0.1');assert.match(f.manager.status().error!,/兼容性检查/);assert.equal(f.counts().downloads,1);
  f.version('3.1.0');await f.manager.check();assert.equal(f.counts().downloads,2,'later stable versions are checked by capability, not patch pinning');
});

test('rollback waits for active tasks and rejected build does not immediately reinstall',async t=>{
  const f=await setup(t);await f.manager.check();const lease=await f.manager.acquire();
  await f.manager.rollback();assert.equal(f.manager.status().activeVersion,'2.42.0');assert.equal(f.manager.status().state,'pending');
  await lease.release();assert.equal(f.manager.status().activeVersion,'2.0.1');
  await f.manager.check();assert.equal(f.manager.status().activeVersion,'2.0.1');
  const count=f.counts().downloads;await f.manager.check();assert.equal(f.counts().downloads,count);
});

test('actual runtime failure rolls back subsequent tasks without replaying the failed task',async t=>{
  const f=await setup(t);await f.manager.check();await f.manager.shutdown();let runs=0;
  const next=new RuntimeManager({...f.options,createRunner:()=>({run:async()=>{runs++;return {status:'failed',finalText:'',toolEvents:[],error:{code:'server_exited',message:'synthetic'}};}})});
  t.after(()=>next.shutdown());await next.init();
  const result=await next.run({} as AgentRunInput);
  assert.equal(result.status,'failed');assert.equal(runs,1);assert.equal(next.status().activeVersion,'2.0.1');assert.match(next.status().error!,/回退/);
});

test('tampered downloaded binary on restart falls back to the bundled engine and retains files',async t=>{
  const f=await setup(t);await f.manager.check();const lease=await f.manager.acquire();await lease.release();await f.manager.automatic(false);await f.manager.shutdown();
  await fs.writeFile(lease.binaryPath,'tampered');
  const next=new RuntimeManager(f.options);t.after(()=>next.shutdown());await next.init();
  assert.equal(next.status().activeVersion,'2.0.1');assert.equal(next.status().automatic,false);assert.match(next.status().error!,/摘要/);
  assert.equal(await fs.readFile(lease.binaryPath,'utf8'),'tampered');
});

test('shutdown cancels an in-flight check and cannot activate the candidate',async t=>{
  const f=await setup(t);await f.manager.shutdown();
  const manager=new RuntimeManager({...f.options,latest:signal=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})});
  await manager.init();const pending=manager.check();await manager.shutdown();await pending;assert.equal(manager.status().activeVersion,'2.0.1');
});
