import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {readBoundedFile} from './files.ts';

test('bounded reads reject oversized files, symlinks and cancellation; originals stay unchanged',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bounded-read-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'source');await fs.writeFile(file,'abcd');
  assert.equal((await readBoundedFile(file,4)).toString(),'abcd');
  await assert.rejects(readBoundedFile(file,3),/上限/);
  await fs.symlink(file,path.join(root,'link'));await assert.rejects(readBoundedFile(path.join(root,'link'),4),/普通文件/);
  const abort=new AbortController();abort.abort();await assert.rejects(readBoundedFile(file,4,abort.signal));
  assert.equal(await fs.readFile(file,'utf8'),'abcd');
});

test('growth after open cannot cause a read allocation over the configured bound',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bounded-grow-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'source');await fs.writeFile(file,'abcd');
  const original=fs.open;let capacity=0,closed=false;
  fs.open=async(...args:Parameters<typeof fs.open>)=>{
    const handle=await original(...args),read=handle.read.bind(handle),close=handle.close.bind(handle);
    handle.read=(async(buffer:Buffer,offset:number,length:number,position:number)=>{
      capacity=buffer.length;await fs.appendFile(file,'x'.repeat(100000));
      return read(buffer,offset,length,position);
    }) as typeof handle.read;
    handle.close=async()=>{closed=true;await close();};
    return handle;
  };
  syncBuiltinESMExports();
  try{await assert.rejects(readBoundedFile(file,8),/变化|上限/);assert.ok(capacity<=9);assert.equal(closed,true);}
  finally{fs.open=original;syncBuiltinESMExports();}
});
