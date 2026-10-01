import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryFiles } from './recovery-files.ts';
test('recovery copies only scoped hash-matching regular files, preserves modified and missing originals',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-files-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const work=path.join(root,'old/command-work'),out=path.join(root,'old/outputs');await fs.mkdir(work,{recursive:true});
 await Promise.all(['good','changed','missing'].map(n=>fs.writeFile(path.join(work,n+'.txt'),n)));
 await fs.symlink('/etc/hosts',path.join(work,'symlink.txt'));
 const first=new RecoveryFiles(out,work,'scope');await first.capture();assert.equal(first.files.length,3);
 await fs.writeFile(path.join(work,'changed.txt'),'edited');await fs.rm(path.join(work,'missing.txt'));
 const second=new RecoveryFiles(path.join(root,'new/outputs'),path.join(root,'new/command-work'),'scope');await second.restore(out);
 assert.equal(await fs.readFile(path.join(second.work,'good.txt'),'utf8'),'good');assert.equal(second.files.find(f=>f.relativePath==='changed.txt')?.state,'changed');assert.equal(second.files.find(f=>f.relativePath==='missing.txt')?.state,'missing');assert.equal(await fs.readFile(path.join(work,'changed.txt'),'utf8'),'edited');
 const foreign=new RecoveryFiles(path.join(root,'other/outputs'),path.join(root,'other/command-work'),'other');await foreign.restore(out);assert.equal(foreign.files.length,0);
});
