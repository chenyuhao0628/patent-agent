import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactsFor, canFinalizeWriting, initialDesign, makeReview, replaceReview, sampleDocuments, saveWriting } from './designFlows.ts';
import { seedWorkspace } from './workflow.ts';

test('independent review holds an immutable snapshot and cannot approve a later working draft',()=>{
  let d=initialDesign();
  d.writing=saveWriting({...d.writing,stage:'draft',documents:sampleDocuments('示例装置')});
  const v=d.writing.versions[0];
  d.review=makeReview('writing',v.id,'v1',v.documents);
  d.review.issues=d.review.issues.map(i=>({...i,disposition:'accepted',comment:'已核对'}));
  assert.equal(canFinalizeWriting(d),false);
  d.review.completed=true;
  assert.equal(canFinalizeWriting(d),true);
  const original=d.review.documents[0].text;
  d.writing.documents[0].text+='\n人工修改';
  assert.equal(d.review.documents[0].text,original);
  assert.equal(v.documents[0].text,original);
  assert.equal(canFinalizeWriting(d),false);
  d.writing=saveWriting(d.writing);
  assert.equal(canFinalizeWriting(d),false);
});

test('restarting a review preserves prior findings and dispositions',()=>{
  let d=initialDesign();
  const docs=sampleDocuments('示例装置');
  d=replaceReview(d,makeReview('external','outside-v1','外部示例',docs));
  d.review!.issues[0].comment='保留旧审查意见';
  const oldId=d.review!.id;
  d=replaceReview(d,makeReview('case','case-v1','本案示例',docs));
  assert.equal(d.reviewHistory[0].id,oldId);
  assert.equal(d.reviewHistory[0].issues[0].comment,'保留旧审查意见');
  assert.notEqual(d.review!.id,oldId);
});

test('continuing a finalized writing keeps its previous artifacts available',()=>{
  const c=seedWorkspace().cases[0];
  const d=initialDesign();
  d.writing=saveWriting({...d.writing,documents:sampleDocuments(c.title)});
  const old=d.writing.versions[0];
  d.writing.finalHistory.push(old.id);
  d.writing.documents[0].text+='\n后续工作稿';
  d.writing=saveWriting(d.writing);
  const artifacts=artifactsFor(c,d);
  assert.equal(artifacts.length,4);
  assert.equal(artifacts[0].text,old.documents[0].text);
  assert.ok(!artifacts[0].text.includes('后续工作稿'));
});
