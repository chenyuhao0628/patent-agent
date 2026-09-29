import test from 'node:test';
import assert from 'node:assert/strict';
import type { TransferReview, TransferView } from '../transfer-api.ts';
import { defaultTransferUser, cacheTransferDraft, persistTransferReview, remoteDeleteDisabledReason, remotePreviewAction, remotePreviewRef, remoteTransferFiles, reviewAfterTransferRefresh, runScopedTransferAction, selectedTransferFile } from './transfer-ui-state.ts';

const review=(remark=''):TransferReview=>({
  keepCodes:['100001'],
  form:{noticeDate:'',noticeName:'',noticeNo:'',correctionReason:1,addEntrust:false,corrections:[],otherProof:false,experimentData:false,abstractFigure:'',declarations:{}},
  stepId:'step-1',userId:'user-1',remark,
});
const view=(overrides:Partial<TransferView>={}):TransferView=>({
  id:'transfer-1',sourceMode:'workbench',profileKey:'profile-1',caseId:'case-1',caseNumber:'CN-1',caseTitle:'合成案件',
  processId:'process-1',processName:'第一次审查意见',route:'reply',files:[],parts:[],review:review(),steps:[],phase:'draft',
  results:[],existingFileNames:[],at:'2026-09-27T00:00:00.000Z',...overrides,
} as TransferView);

test('canceled file selection never replaces the current material',()=>{
  let assertions=0;
  assert.equal(selectedTransferFile({canceled:true,filePaths:['/tmp/ignored.docx']},()=>{assertions++;}),null);
  assert.equal(selectedTransferFile({canceled:false,filePaths:[]},()=>{assertions++;}),null);
  assert.equal(selectedTransferFile({canceled:false,filePaths:['/tmp/selected.docx']},()=>{assertions++;}),'/tmp/selected.docx');
  assert.equal(assertions,3);
});

test('source switching persists a changed draft before running the replacement action',async()=>{
  const current=view();
  const edited=review('用户尚未切换来源的草稿');
  const order:string[]=[];
  let completed='';
  await runScopedTransferAction({
    persist:()=>persistTransferReview('profile-1',current,edited,async(profileKey,id,saved)=>{
      order.push(`save:${profileKey}:${id}:${saved.remark}`);
      return view({review:structuredClone(saved),localReviewSaved:true});
    }),
    isCurrent:()=>true,
    run:async()=>{order.push('switch-source');return 'next-view';},
    onPersisted:saved=>{order.push(`persisted:${saved?.review.remark}`);},
    onComplete:result=>{completed=result;order.push(`complete:${result}`);},
  });
  assert.deepEqual(order,[
    'save:profile-1:transfer-1:用户尚未切换来源的草稿',
    'persisted:用户尚未切换来源的草稿',
    'switch-source',
    'complete:next-view',
  ]);
  assert.equal(completed,'next-view');
});

test('scope changes stop source replacement after the draft has been persisted',async()=>{
  let current=true;
  let ran=false;
  await runScopedTransferAction({
    persist:async()=>{current=false;return view({localReviewSaved:true});},
    isCurrent:()=>current,
    run:async()=>{ran=true;return 'unexpected';},
    onPersisted:()=>assert.fail('stale persisted view must not be applied'),
    onComplete:()=>assert.fail('stale replacement must not complete'),
  });
  assert.equal(ran,false);
});

test('failed local review save leaves source and edited form untouched',async()=>{
  const current=view();
  const edited=review('未落盘的用户输入');
  const before=structuredClone({current,edited});
  await assert.rejects(runScopedTransferAction({
    persist:()=>persistTransferReview('profile-1',current,edited,async()=>{throw new Error('synthetic disk failure');}),
    isCurrent:()=>true,
    run:async()=>assert.fail('source must not change after failed persistence'),
    onPersisted:()=>assert.fail('failed save must not be acknowledged'),
    onComplete:()=>assert.fail('cached input must not be cleared'),
  }),/synthetic disk failure/);
  assert.deepEqual({current,edited},before);
});

test('cached drafts are cloned and cannot be mutated through acknowledged view objects',()=>{
  const current=view();
  const edited=review('本地缓存');
  const cached=cacheTransferDraft(current,edited,2);
  current.review.remark='mutated view';
  edited.remark='mutated review';
  assert.equal(cached.view.review.remark,'');
  assert.equal(cached.review?.remark,'本地缓存');
  assert.equal(cached.tab,2);
});

test('remote preview uses immutable file numbers and legacy names remain display-only',()=>{
  const remote=view({
    existingFileNames:['旧名称.docx'],
    existingFiles:[{fileNo:'file-1',name:'远端意见陈述书.docx'},{fileNo:'file-2',name:'远端附件.docx'}],
  });
  assert.deepEqual(remoteTransferFiles(remote),[
    {fileNo:'file-1',name:'远端意见陈述书.docx'},
    {fileNo:'file-2',name:'远端附件.docx'},
  ]);
  assert.equal(remotePreviewAction(remote).kind,'choose');
  assert.deepEqual(remotePreviewRef({fileNo:'file-1',name:'远端意见陈述书.docx'}),{fileNo:'file-1',name:'远端意见陈述书.docx'});
  assert.equal(remotePreviewRef({name:'仅有名称.docx'}),null);

  const legacy=view({existingFileNames:['仅有名称.docx']});
  assert.deepEqual(remoteTransferFiles(legacy),[{name:'仅有名称.docx'}]);
  assert.equal(remotePreviewAction(legacy).kind,'choose');

  const correction=view({route:'correction',existingFileNames:[],existingFiles:[]});
  assert.equal(remotePreviewAction(correction).kind,'correction');
  const reply=view({route:'reply',existingFileNames:[],existingFiles:[]});
  assert.equal(remotePreviewAction(reply).kind,'unavailable');
});

test('a single verified remote file opens directly',()=>{
  const action=remotePreviewAction(view({existingFiles:[{fileNo:'file-1',name:'唯一远端文件.docx'}]}));
  assert.equal(action.kind,'file');
  if(action.kind==='file')assert.deepEqual(action.ref,{fileNo:'file-1',name:'唯一远端文件.docx'});
});

test('recipient defaults require a unique Yang Jia and preserve an explicit valid choice',()=>{
 const a={id:'a',name:'杨佳'},b={id:'b',name:'杨佳'},c={id:'c',name:'其他人'};
 assert.deepEqual(defaultTransferUser([a,c]),a);
 assert.deepEqual(defaultTransferUser([a,c],'c'),c);
 assert.equal(defaultTransferUser([a,b,c]),undefined);
 assert.deepEqual(defaultTransferUser([a,b,c],'b'),b);
 assert.equal(defaultTransferUser([a,{...a,name:'另一身份'}],'a'),undefined);
 assert.deepEqual(defaultTransferUser([c]),c);
 assert.equal(defaultTransferUser([],'a'),undefined);
});

test('single remote deletion is available in draft and saved but blocks uncertain identities and operations',()=>{
  const file={fileNo:'file-1',name:'同名材料.docx',deleteRef:{fileNo:'file-1',handId:'hand-1',fingerprint:'a'.repeat(64)}};
  const v=view({handId:'hand-1',canEditRemote:true});
  assert.equal(remoteDeleteDisabledReason(v,file),undefined);
  assert.equal(remoteDeleteDisabledReason({...v,phase:'saved'},file),undefined);
  assert.ok(remoteDeleteDisabledReason({...v,phase:'saved',submissionAttempted:true},file),'转交后的旧方案不能用于单份删除');
  for(const phase of ['uncertain','submitted','superseded'] as const)assert.ok(remoteDeleteDisabledReason({...v,phase},file));
  for(const overrides of [{canEditRemote:false},{canEditRemote:undefined},{handId:'other'},{cleanupPending:true},{submissionAttempted:true,phase:'uncertain' as const}])assert.ok(remoteDeleteDisabledReason({...v,...overrides},file));
  assert.ok(remoteDeleteDisabledReason(v,{name:file.name}));
  assert.ok(remoteDeleteDisabledReason(v,{...file,fileNo:'other'}));
  assert.ok(remoteDeleteDisabledReason(v,{...file,deleteRef:{...file.deleteRef,fingerprint:'invalid'}}));
  assert.equal(remoteDeleteDisabledReason(v,{...file,deleteDisabledReason:'关联不唯一'}),'关联不唯一');
});

test('refresh after uncertain deletion adopts verified file selection instead of stale cached checks',()=>{
  const previous=view({phase:'uncertain'}),edited=review('保留本地备注');
  const next=view({phase:'draft',review:{...edited,keepCodes:[]}});
  const restored=reviewAfterTransferRefresh(previous,edited,next);
  assert.deepEqual(restored,next.review);assert.deepEqual(restored.keepCodes,[]);
  restored.remark='独立编辑';assert.equal(next.review.remark,'保留本地备注');
});

test('ordinary refresh keeps live unsaved form and recipient edits, but adopts server review when clean',()=>{
  const previous=view(),edited={...review('尚未保存'),userId:'manual-recipient'};
  const next=view({review:review('已回读')});
  assert.deepEqual(reviewAfterTransferRefresh(previous,edited,next),edited);
  assert.deepEqual(reviewAfterTransferRefresh(previous,previous.review,next),next.review);
  assert.deepEqual(reviewAfterTransferRefresh(previous,edited,{...next,id:'new-transfer'}),next.review);
});
