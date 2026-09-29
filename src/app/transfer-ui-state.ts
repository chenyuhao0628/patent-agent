import { DEFAULT_INTERNAL_TRANSFER_RECIPIENT } from '../domain/workflow-nodes.ts';
import type { TransferAPI, TransferReview, TransferView, RemoteTransferFile } from '../transfer-api.ts';

export function reviewChanged(a?:TransferReview,b?:TransferReview){
  return JSON.stringify(a)!==JSON.stringify(b);
}

// The acknowledged view and the editable draft must never share a save baseline.
export function cacheTransferDraft(view:TransferView,review:TransferReview|undefined,tab:number){
  return structuredClone({view,review,tab});
}

export function reviewAfterTransferRefresh(previous:TransferView|undefined,edited:TransferReview|undefined,next:TransferView):TransferReview{
  // Keep live edits on an unchanged editable phase, but adopt the verified selection after recovery.
  const preserve=previous?.id===next.id&&previous.phase===next.phase&&['draft','saved'].includes(next.phase)
    &&!previous.fileDeletion&&!previous.cleanupPending&&!next.fileDeletion&&!next.cleanupPending
    &&edited&&reviewChanged(previous.review,edited);
  return structuredClone(preserve?edited:next.review);
}

export async function persistTransferReview(profileKey:string,view:TransferView|undefined,review:TransferReview|undefined,save?:TransferAPI['saveLocalReview']){
  if(!view||view.phase!=='draft'||!review||!reviewChanged(view.review,review))return view;
  if(!save)throw new Error('本地草稿保存不可用，未切换文件来源。');
  return save(profileKey,view.id,review);
}

export async function runScopedTransferAction<T>({persist,isCurrent,run,onPersisted,onComplete}:{
  persist:()=>Promise<TransferView|undefined>;isCurrent:()=>boolean;run:()=>Promise<T>;
  onPersisted:(view:TransferView|undefined)=>void;onComplete:(result:T)=>void;
}){
  const saved=await persist();
  if(!isCurrent())return;
  onPersisted(saved);
  const result=await run();
  if(isCurrent())onComplete(result);
}

export function selectedTransferFile(selection:{canceled:boolean;filePaths:string[]},assertScope:()=>void){
  assertScope();
  return selection.canceled?null:selection.filePaths[0]||null;
}

export function remoteTransferFiles(view:Pick<TransferView,'existingFiles'|'existingFileNames'>):Array<Omit<RemoteTransferFile,'fileNo'>&{fileNo?:string}>{
  // Legacy names are display-only: never infer remote IDs from names or local roles.
  return view.existingFiles!==undefined?view.existingFiles.map(file=>({...file})):view.existingFileNames.map(name=>({name}));
}

export function remoteDeleteDisabledReason(view:Pick<TransferView,'phase'|'canEditRemote'|'handId'|'fileDeletion'|'cleanupPending'|'submissionAttempted'>,file:Omit<RemoteTransferFile,'fileNo'>&{fileNo?:string}){
  if(view.fileDeletion||view.cleanupPending||view.submissionAttempted)return '本次方案已有删除、清理或转交记录，请先刷新核对；不能重复发送删除。';
  if(!['draft','saved'].includes(view.phase))return '仅草稿或已保存、尚未转交的材料可以删除关联。';
  if(view.canEditRemote!==true)return '当前账号没有此节点的编辑权限。';
  if(file.deleteDisabledReason)return file.deleteDisabledReason;
  const ref=file.deleteRef;
  if(!ref||!file.fileNo||file.fileNo!==ref.fileNo||ref.handId!==view.handId||!/^[a-f0-9]{64}$/.test(ref.fingerprint))return '缺少已核验的文件编号或唯一表单关联，请刷新材料。';
  return undefined;
}

export function remotePreviewRef(file:{fileNo?:string;name:string}){
  return file.fileNo?.trim()&&file.name?{fileNo:file.fileNo,name:file.name}:null;
}

export function remotePreviewAction(view:Pick<TransferView,'existingFiles'|'existingFileNames'|'route'>){
  const files=remoteTransferFiles(view);
  if(files.length===0)return {kind:view.route==='correction'?'correction':'unavailable'} as const;
  const ref=files.length===1?remotePreviewRef(files[0]):null;
  return ref?{kind:'file',ref} as const:{kind:'choose',files} as const;
}

export function defaultTransferUser(users:Array<{id:string;name:string}>,selectedId=''){
  const selected=users.filter(u=>u.id===selectedId);
  if(selected.length===1)return selected[0];
  if(selected.length>1)return undefined;
  const preferred=users.filter(u=>u.name===DEFAULT_INTERNAL_TRANSFER_RECIPIENT);
  if(preferred.length===1&&users.filter(u=>u.id===preferred[0].id).length===1)return preferred[0];
  return users.length===1?users[0]:undefined;
}
