import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {downloadRuntime,extractRuntimeArchive,latestRuntimeRelease,nativeRuntimePackage,newerVersion} from './runtime-download.ts';

function tarEntry(name:string,body:Buffer,type='0',size=body.length) {
  const header=Buffer.alloc(512);header.write(name,0,100);header.write(size.toString(8).padStart(11,'0')+'\0',124,12);header.write(type,156);
  return Buffer.concat([header,body,Buffer.alloc((512-body.length%512)%512)]);
}

test('official metadata requires the matching platform package, HTTPS tarball and SHA512',async()=>{
  assert.equal(nativeRuntimePackage('win32','x64'),'@opencode/cli-windows-x64-baseline');assert.equal(newerVersion('3.0.0','2.99.9'),true);
  const name=nativeRuntimePackage();
  const meta={name,version:'2.73.1',dist:{tarball:`https://registry.npmjs.org/${name}/-/native.tgz`,integrity:'sha512-'+Buffer.alloc(64).toString('base64')}};
  const get=(value:unknown)=>(async()=>new Response(JSON.stringify(value))) as typeof fetch;
  assert.equal((await latestRuntimeRelease(new AbortController().signal,get(meta))).version,'2.73.1');
  for(const bad of [{...meta,name:'unrelated'},{...meta,version:'2.1.0-beta'},{...meta,dist:{...meta.dist,tarball:'https://unrelated.example/runtime.tgz'}},{...meta,dist:{...meta.dist,integrity:'sha1-invalid'}}])await assert.rejects(latestRuntimeRelease(new AbortController().signal,get(bad)));
});

test('archive extraction writes only the platform executable and rejects links, duplicates and oversized members',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-archive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const name=`package/bin/${process.platform==='win32'?'opencode.exe':'opencode'}`,body=Buffer.from('synthetic-binary');
  const archive=path.join(root,'file.tgz');
  await fs.writeFile(archive,gzipSync(Buffer.concat([tarEntry('../outside',Buffer.from('bad')),tarEntry(name,body),Buffer.alloc(1024)])));
  await extractRuntimeArchive(archive,path.join(root,'ok'),new AbortController().signal);assert.deepEqual(await fs.readFile(path.join(root,'ok')),body);await assert.rejects(fs.access(path.join(root,'outside')));
  for(const [label,contents] of [['link',tarEntry(name,Buffer.alloc(0),'2')],['duplicate',Buffer.concat([tarEntry(name,body),tarEntry(name,body)])],['huge',tarEntry(name,Buffer.alloc(0),'0',2**30)]] as const){await fs.writeFile(archive,gzipSync(contents));await assert.rejects(extractRuntimeArchive(archive,path.join(root,label),new AbortController().signal));}
});

test('download integrity is verified before any executable is extracted',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-integrity-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const name=`package/bin/${process.platform==='win32'?'opencode.exe':'opencode'}`,payload=gzipSync(tarEntry(name,Buffer.from('unsafe')));
  await assert.rejects(downloadRuntime({version:'2.1.0',packageName:nativeRuntimePackage(),tarball:'https://registry.npmjs.org/synthetic',integrity:'sha512-'+createHash('sha512').update('different').digest('base64')},root,new AbortController().signal,async()=>new Response(payload)),/完整性/);
  const files=await fs.readdir(root);assert.deepEqual(files,['package.tgz']);
});
