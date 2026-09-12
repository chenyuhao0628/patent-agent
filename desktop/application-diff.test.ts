import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exportApplicationText } from './document-export.ts';
import { applicationSections, compareApplication } from './application-diff.ts';
const root=path.resolve('resources/document-templates');
const parts={ABSTRACT:'合成摘要',ABSTRACT_IMAGE:'图 1',CLAIMS:'1. 合成权利要求。',DESCRIPTION:'合成说明书正文。',DRAWINGS:'图 1\n图 2'};
test('five-section comparison detects changed content and leaves missing baselines unresolved',async()=>{
  const before=await exportApplicationText(root,parts),after=await exportApplicationText(root,{...parts,CLAIMS:'1. 修改后的合成权利要求。'});
  assert.equal((await applicationSections(before)).size,5);
  const comparison=await compareApplication(before,after);
  assert.deepEqual(comparison.filter(p=>p.changed).map(p=>p.code),['100001']);
  assert.equal(comparison.filter(p=>p.changed===false).length,4);
  assert.equal((await compareApplication(undefined,after)).filter(p=>p.changed===null).length,5);
});
