import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {finished} from 'node:stream/promises';
import {createCappedLogStream} from './agent-runner.ts';

test('child logs redact known and standard secrets across byte chunks and cap oversized lines',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'child-log-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'log'),secret='fixture-arbitrary-credential';
  const stream=createCappedLogStream(file,1024,[secret]);
  for(const byte of Buffer.from(`合成中文 ${secret}\nAuthorization: Bearer sk-private-credential123\nnormal\n`))stream.write(Buffer.from([byte]));
  stream.write('x'.repeat(70000));stream.write('secret-fragment\n');
  stream.end('complete');await finished(stream);
  const text=await fs.readFile(file,'utf8');
  assert.match(text,/合成中文/);assert.match(text,/redacted/);assert.match(text,/complete/);
  assert.doesNotMatch(text,/fixture-arbitrary|private-credential|secret-fragment/);
  assert.ok(Buffer.byteLength(text)<=1024);
});
