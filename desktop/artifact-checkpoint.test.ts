import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ArtifactCheckpoint} from './artifact-checkpoint.ts';
async function fixture(t:test.TestContext){const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-checkpoint-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('checkpoint hash and scope isolate restored results; corruption leaves original intact',async t=>{
 const root=await fixture(t),first=new ArtifactCheckpoint(path.join(root,'first'),'scope');
 await first.merge({kind:'writing',text:'原正文'});const file=path.join(first.root,'artifact-checkpoint.json');
 const good=new ArtifactCheckpoint(path.join(root,'next'),'scope');await good.restore(first.root);assert.equal(good.snapshot().text,'原正文');assert.equal(good.recovery.status,'restored');
 const other=new ArtifactCheckpoint(path.join(root,'other'),'other');await other.restore(first.root);assert.deepEqual(other.snapshot(),{});assert.equal(other.recovery.status,'unavailable');
 const raw=JSON.parse(await fs.readFile(file,'utf8'));raw.value.text='外部修改';await fs.writeFile(file,JSON.stringify(raw));
 const bad=new ArtifactCheckpoint(path.join(root,'bad'),'scope');await bad.restore(first.root);assert.deepEqual(bad.snapshot(),{});assert.equal(bad.recovery.status,'unavailable');assert.match(await fs.readFile(file,'utf8'),/外部修改/);
});
test('professional document merges preserve previously saved siblings and legacy checkpoint is identified',async t=>{
 const root=await fixture(t),cp=new ArtifactCheckpoint(root,'scope');await cp.merge({kind:'writing',documents:{ABSTRACT:'摘要',CLAIMS:'权利要求'}});await cp.merge({documents:{DESCRIPTION:'说明书'}});
 assert.deepEqual(cp.snapshot().documents,{ABSTRACT:'摘要',CLAIMS:'权利要求',DESCRIPTION:'说明书'});
 await fs.writeFile(path.join(root,'artifact-checkpoint.json'),JSON.stringify({schema:1,identity:'scope',value:{kind:'review',text:'旧稿'}}));
 const legacy=new ArtifactCheckpoint(path.join(root,'new'),'scope');await legacy.restore(root);assert.equal(legacy.recovery.status,'legacy');assert.equal(legacy.snapshot().text,'旧稿');
});
