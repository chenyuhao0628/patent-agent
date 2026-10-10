import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Cloud, Edit3, Eye, RefreshCw, Save, Trash2, Upload, X } from 'lucide-react';
import { desktop } from '../desktop.ts';
import { DEFAULT_INTERNAL_TRANSFER_RECIPIENT } from '../domain/workflow-nodes.ts';
import type { CaseTransferModuleView } from '../domain/case-view.ts';
import { FIVE_PARTS } from '../transfer-api.ts';
import type { TransferView, TransferReview, TransferFileRole, TransferForm, NameDiscrepancyRequest, RemoteFileDeleteRef } from '../transfer-api.ts';
import { Modal, Note } from './Primitives.tsx';
import { transferRouteDefinition } from '../app/transfer-routes.ts';
import { defaultTransferUser, cacheTransferDraft, persistTransferReview, remoteDeleteDisabledReason, remotePreviewAction, remotePreviewRef, remoteTransferFiles, reviewAfterTransferRefresh, reviewChanged, runScopedTransferAction } from '../app/transfer-ui-state.ts';
import { TransferFileRow } from './TransferFileRow.tsx';
import '../transfer.css';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';
import type { CaseTab } from './CaseSpace.tsx';

const declarations:Record<string,string>={IsApplySameDay:'同日申请',IsPublicAdvance:'请求提前公开',IsExhibition:'展览会公开声明',IsPublished:'学术或技术会议公开声明',IsPublicForCommonProfit:'公共利益目的公开声明',IsDisclosure:'他人未经同意泄露声明',IsGiveUpOn51Section:'放弃主动修改',IsRequestDelayReview1YearForUtility:'实用新型延迟审查一年'};
const correctionLabels={FileName:'文件名称',PositionInFile:'具体位置',CorrectionBefore:'补正前',CorrectionAfter:'补正后'} as const;
function correctionFileOptions(reason:number){
  return [...FIVE_PARTS.map(p=>p.name),'核苷酸或氨基酸序列表','其他',...(reason===2?['请求书','授权委托书','主体资格证明']:[])];
}
function CorrectionEntriesEditor({corrections,correctionReason,locked,onChange}:{corrections:TransferForm['corrections'];correctionReason:number;locked:boolean;onChange:(rows:TransferForm['corrections'])=>void}){
  const files=correctionFileOptions(correctionReason);
  return <>
    {corrections.map((row,index)=><div className="correction-row" key={row.ChangeId}>
      <div className="section-heading"><b>条目 {index+1}</b><button type="button" disabled={locked} onClick={()=>onChange(corrections.filter(r=>r.ChangeId!==row.ChangeId))}>移除条目</button></div>
      {(Object.keys(correctionLabels) as Array<keyof typeof correctionLabels>).map(key=><label className="field" key={key}>{correctionLabels[key]}{key==='FileName'
        ?<select disabled={locked} value={row[key]} onChange={e=>onChange(corrections.map(r=>r.ChangeId===row.ChangeId?{...r,[key]:e.target.value}:r))}>{files.map(n=><option key={n}>{n}</option>)}</select>
        :<textarea disabled={locked} rows={key==='PositionInFile'?2:4} value={row[key]} onChange={e=>onChange(corrections.map(r=>r.ChangeId===row.ChangeId?{...r,[key]:e.target.value}:r))}/>}</label>)}
    </div>)}
    <button type="button" disabled={locked} onClick={()=>onChange([...corrections,{ChangeId:crypto.randomUUID(),Sort:corrections.length,FileName:'权利要求书',PositionInFile:'',CorrectionBefore:'',CorrectionAfter:''}])}>增加补正条目</button>
  </>;
}

const transferCache = new Map<string, { view?: TransferView; review?: TransferReview; tab: number }>();

export function InternalTransfer({profileKey,profileView,refreshSeq,scopeVersion,caseRevision,navigate}:{profileKey:string;profileView:CaseTransferModuleView;refreshSeq?:number;scopeVersion?:number;caseRevision?:number;navigate?:(tab:CaseTab)=>void}){
  const caseId=profileView.identity.id;
  const processId=profileView.stage.current.processId;
  const processKey=(processId||profileView.stage.current.roundId||`local-${profileView.stage.kind}`).trim();
  const cacheKey=`${profileKey}/${scopeVersion??0}/${caseRevision??0}/${caseId}/${processKey}`;
  const [view,setView]=useState<TransferView|undefined>(()=>transferCache.get(cacheKey)?.view);
  const [review,setReview]=useState<TransferReview|undefined>(()=>{const c=transferCache.get(cacheKey)?.review;return c?structuredClone(c):undefined;});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [tab,setTab]=useState<number>(()=>transferCache.get(cacheKey)?.tab??0);
  const [confirm,setConfirm]=useState<'save'|'submit'|'start'|'revoke'|'clearRemote'>();
  const [inspecting,setInspecting]=useState<boolean>(()=>!transferCache.has(cacheKey));
  const [inspectionFailed,setInspectionFailed]=useState(false),[inspectAttempt,setInspectAttempt]=useState(0);
  const [remotePicker,setRemotePicker]=useState(false);
  const [deleteTarget,setDeleteTarget]=useState<{name:string;ref:RemoteFileDeleteRef}>();
  const [previewDoc, setPreviewDoc]=useState<{title:string;text:string}|null>(null);
  const [nameConfirmReq, setNameConfirmReq]=useState<NameDiscrepancyRequest|null>(null);
  const scope=useRef('');scope.current=cacheKey;
  useEffect(()=>{scope.current=cacheKey;return()=>{scope.current='';};},[cacheKey]);
  useEffect(()=>{
    if(!desktop?.transfer?.onConfirmNameRequest)return;
    return desktop.transfer.onConfirmNameRequest(req=>setNameConfirmReq(req));
  },[]);
  const handleNameConfirm=(confirmed:boolean)=>{
    if(nameConfirmReq){
      desktop?.transfer?.respondConfirmName?.(nameConfirmReq.reqId,confirmed);
      setNameConfirmReq(null);
    }
  };
  const lastRefreshSeq=useRef(refreshSeq);
  useEffect(()=>{
    if(refreshSeq!==undefined&&refreshSeq!==lastRefreshSeq.current){
      lastRefreshSeq.current=refreshSeq;
      const cached=transferCache.get(cacheKey);
      if(cached?.view?.id&&desktop?.transfer?.refresh){
        void desktop.transfer.refresh(profileKey,cached.view.id).then(v=>{
          if(scope.current===cacheKey&&v.profileKey===profileKey&&v.caseId===caseId&&v.processId===processId){
            const current=latest.current;
            const refreshedReview=reviewAfterTransferRefresh(current.view,current.review,v);
            transferCache.set(cacheKey,cacheTransferDraft(v,refreshedReview,current.tab));
            setView(v);setReview(refreshedReview);
          }
        }).catch(e=>{if(scope.current===cacheKey)setError(e.message);});
      }
    }
  },[refreshSeq,cacheKey,profileKey]);

  useEffect(()=>{
    setInspectionFailed(false);setPreviewDoc(null);setRemotePicker(false);setNameConfirmReq(null);setDeleteTarget(undefined);
    const cached=transferCache.get(cacheKey);
    if(cached){
      setView(cached.view);
      setReview(cached.review?structuredClone(cached.review):undefined);
      setTab(cached.tab??0);
      setError('');
      setBusy(false);
      setConfirm(undefined);
      setInspecting(false);
    }else{
      setView(undefined);
      setReview(undefined);
      setTab(0);
      setError('');
      setBusy(false);
      setConfirm(undefined);
      if(desktop?.transfer?.inspect){
        setInspecting(true);
        void desktop.transfer.inspect(profileKey,caseId).then(found=>{
          if(scope.current===cacheKey){
            if(found&&found.profileKey===profileKey&&found.caseId===caseId&&found.processId===processId){
              setView(found);
              setReview(structuredClone(found.review));
              const initialTab=(found.phase==='saved'||found.phase==='submitted')?2:0;
              setTab(initialTab);
              transferCache.set(cacheKey,{view:found,review:found.review,tab:initialTab});
            }else{
              setView(undefined);
            }
          }
        }).catch(e=>{
          if(scope.current===cacheKey){setView(undefined);setInspectionFailed(true);setError(e.message);}
        }).finally(()=>{
          if(scope.current===cacheKey)setInspecting(false);
        });
      }else{
        setInspecting(false);
      }
    }
  },[cacheKey,inspectAttempt]);

  useEffect(()=>{
    if(view&&view.profileKey===profileKey&&view.caseId===caseId&&view.processId===processId) transferCache.set(cacheKey,cacheTransferDraft(view,review,tab));
  },[cacheKey,view,review,tab]);

  useEffect(()=>{
    if(!view?.steps?.length||!review)return;
    let nextStepId=review.stepId;
    let nextUserId=review.userId;
    let changed=false;

    const validStep=view.steps.find(s=>s.id===nextStepId);
    if(!validStep){
      const officialStep=view.steps.find(s=>s.name.includes('递交官方')||s.name.includes('提交官方'));
      if(officialStep){
        nextStepId=officialStep.id;
        changed=true;
      }else if(view.steps.length===1){
        nextStepId=view.steps[0].id;
        changed=true;
      }
    }

    const activeStep=view.steps.find(s=>s.id===nextStepId);
    const nextUser=defaultTransferUser(activeStep?.users??[],nextUserId);
    if(nextUserId!==(nextUser?.id||'')){nextUserId=nextUser?.id||'';changed=true;}

    if(changed){
      setReview(r=>r?{...r,stepId:nextStepId,userId:nextUserId}:r);
    }
  },[view?.steps,review?.stepId,review?.userId]);
  const latest=useRef({view,review,profileKey,tab});
  latest.current={view,review,profileKey,tab};
  useEffect(()=>()=>{
    const {view:v,review:r,profileKey:key}=latest.current;
    if(v?.phase==='draft'&&r&&desktop?.transfer?.saveLocalReview&&reviewChanged(v.review,r)){
      void desktop.transfer.saveLocalReview(key,v.id,r).catch(()=>{/* The in-memory draft stays in the scope-keyed cache for recovery. */});
    }
  },[]);

  const available=profileView.transfer.available&&!profileView.stage.officialWaiting;
  if(!available)return null;
  const persistLocalReview=(currentView=view,currentReview=review)=>
    persistTransferReview(profileKey,currentView,currentReview,desktop?.transfer.saveLocalReview);
  const accepts=(next:TransferView)=>next.profileKey===profileKey&&next.caseId===caseId&&next.processId===processId;
  const act=async(fn:()=>Promise<TransferView|null>,flush=true)=>{
    if(busy||inspecting||inspectionFailed&&!view)return;
    const startedScope=scope.current;setBusy(true);setError('');
    try{
      await runScopedTransferAction({
        persist:()=>flush?persistLocalReview():Promise.resolve(view),
        isCurrent:()=>scope.current===startedScope,
        onPersisted:saved=>{if(saved&&accepts(saved)){setView(saved);transferCache.set(cacheKey,cacheTransferDraft(saved,review,tab));}},
        run:fn,
        onComplete:next=>{
          if(next&&accepts(next)){
            setView(next);setReview(structuredClone(next.review));
            if((next.phase==='saved'||next.phase==='submitted')&&tab===0)setTab(2);
          }
        },
      });
    }catch(e){if(scope.current===startedScope)setError((e as Error).message);}
    finally{if(scope.current===startedScope)setBusy(false);}
  };
  const changeSource=()=>void act(async()=>{
    transferCache.delete(cacheKey);setView(undefined);setReview(undefined);setTab(0);
    return null;
  });
  const goTab=async(n:number)=>{
    if(busy)return;
    const startedScope=scope.current;
    if(view?.phase==='draft'&&review&&reviewChanged(view.review,review)&&desktop?.transfer.saveLocalReview){
      setBusy(true);setError('');
      try{
        const next=await desktop.transfer.saveLocalReview(profileKey,view.id,review);
        if(scope.current===startedScope&&accepts(next)){setView(next);setReview(structuredClone(next.review));}
      }catch(e){if(scope.current===startedScope){setError((e as Error).message);setBusy(false);}return;}
      if(scope.current!==startedScope)return;
      setBusy(false);
    }
    setTab(n);
  };
  const patch=(v:Partial<TransferReview>)=>setReview(r=>r?{...r,...v}:r);
  const form=(v:Partial<TransferForm>)=>setReview(r=>r?{...r,form:{...r.form,...v}}:r);
  const correctionsDirty=!!view&&!!review&&JSON.stringify(view.review.form.corrections)!==JSON.stringify(review.form.corrections);
  const locked=busy||view?.phase!=='draft'||view?.canEditRemote===false;
  const lockedRecipient=busy||(view?.phase!=='draft'&&view?.phase!=='saved')||view?.canEditRemote===false;
  const roles: readonly TransferFileRole[] = view ? transferRouteDefinition(view.route).fileRoles : [];
  const roleName:Record<TransferFileRole,string>={baseline:'修改前申请文件（比对用，可选）',application:view?.route==='application'?'完整申请文件':'修改后合并稿（与独立分件二选一）',reply:'意见陈述书 Word',claims:'修改后权利要求书',description:'修改后说明书',drawings:'修改后说明书附图',abstract:'修改后说明书摘要',abstractImage:'修改后摘要附图'};
  const step=view?.steps.find(s=>s.id===review?.stepId),user=step?.users.find(u=>u.id===review?.userId);
  const phaseLabel:Record<TransferView['phase'],string>={draft:'草稿，待核对并保存',saved:'已保存，等待内部转交',submitted:'内部转交已确认',uncertain:'结果待核验，不能重复操作',superseded:'已被新方案替代'};
  const phaseDescription:Record<TransferView['phase'],string>={draft:'请依次核对材料、业务表单和下一办理人。',saved:'保存、回读和材料核验已完成，官方递交仍由后续办理人负责。',submitted:'服务端已回读下一流程和办理人，当前方案不能再次转交。',uncertain:'上一次操作结果尚未确认，请先刷新核对；确认前不能重复写入。',superseded:'本方案仅保留历史记录，不能继续执行。'};

  const handlePreviewDoc=async(fileRef:{role?:TransferFileRole;partCode?:string;fileNo?:string;name?:string})=>{
    if(!desktop?.transfer?.previewFile||!view)return;
    const startedScope=scope.current;
    setBusy(true);
    try{
      const res=await desktop.transfer.previewFile(profileKey,view.id,fileRef);
      if(scope.current!==startedScope)return;
      if(res){
        let text=res.content||'';
        if(res.parts&&res.parts.length>0){
          text=res.parts.map(p=>`### ${p.name}\n\n${p.content}`).join('\n\n');
        }
        setPreviewDoc({title:res.name||'正文与公式预览',text:text||'（该材料无文本正文）'});
      }
    }catch(err){
      if(scope.current===startedScope)setError('预览失败：'+(err as Error).message);
    }finally{
      if(scope.current===startedScope)setBusy(false);
    }
  };
  const remoteFiles=view?remoteTransferFiles(view):[];
  const previewRemote=()=>{
    if(!view||busy)return;
    const action=remotePreviewAction(view);
    if(action.kind==='file')void handlePreviewDoc(action.ref);
    else if(action.kind==='choose')setRemotePicker(true);
    else if(action.kind==='correction')void goTab(1);
    else setError('当前没有可确认身份的远端文件，请刷新核对；未使用本地副本替代。');
  };
  const remoteFileRow=(file:ReturnType<typeof remoteTransferFiles>[number],index:number,allowDelete=false)=>{
    const ref=remotePreviewRef(file);
    const reason=view?remoteDeleteDisabledReason(view,file):'请先读取递交方案。';
    return <TransferFileRow key={`${file.fileNo??'legacy'}:${index}`} name={file.name} source="remote"
      detail={<><span>贝思兰德 · 当前递交实例</span><span className="transfer-file-id" title={file.fileNo}>编号：{file.fileNo||'待核验'}</span></>}
      hint={allowDelete&&reason?reason:undefined}
      actions={<><button type="button" disabled={busy||!ref} aria-label={`预览远端文件：${file.name}`} onClick={()=>{if(ref){setRemotePicker(false);void handlePreviewDoc(ref);}}} title={ref?'按远端文件编号读取，不使用本地副本':'缺少远端文件编号，请刷新核对后再预览'}><Eye size={14}/>预览</button>
        {allowDelete&&<span className="transfer-action-hint" title={reason||'仅删除此文件在当前递交实例中的关联；保留其他材料、业务表单和本地原件'}><button type="button" className="danger-quiet" disabled={busy||!!reason} aria-label={`删除远端关联：${file.name}`} onClick={()=>{if(file.deleteRef)setDeleteTarget({name:file.name,ref:structuredClone(file.deleteRef)});}}><Trash2 size={14}/>删除关联</button></span>}</>}/>;
  };
  const mustVerify=!!view&&(!!view.fileDeletion||!!view.cleanupPending||!!view.submissionAttempted);
  const recoveryAction=view?.phase==='uncertain'?(mustVerify
    ?<button type="button" disabled={busy} onClick={()=>void act(()=>desktop!.transfer.refresh(profileKey,view.id))}><RefreshCw size={14}/>刷新核对结果</button>
    :<button type="button" disabled={busy} onClick={()=>setConfirm('revoke')}>返回草稿重新整理</button>):null;
  const currentDeleteFile=deleteTarget?remoteFiles.find(file=>file.fileNo===deleteTarget.ref.fileNo):undefined;
  const deleteReason=deleteTarget&&view&&currentDeleteFile?remoteDeleteDisabledReason(view,currentDeleteFile):'文件已不在当前列表，请刷新材料后重新确认。';
  const deleteChanged=!!deleteTarget&&currentDeleteFile?.deleteRef?.fingerprint!==deleteTarget.ref.fingerprint;
  if(inspectionFailed&&!view)return <section className="internal-transfer"><p role="alert">{error||'未能读取原流转方案，尚未创建新方案。'}</p><button onClick={()=>setInspectAttempt(n=>n+1)}>重新读取流转方案</button></section>;
  return <section className="internal-transfer"><div className="section-heading"><div><h3>{view?.sourceMode==='local'?'本地文件提交':'提交到下一内部流程'}</h3><p className="section-copy">整理本次材料、核对业务表单，再转交下一办理人。</p></div>
    {inspecting ? (
      <div className="transfer-inspecting"><RefreshCw size={14} className="spin"/><span>正在检查递交方案…</span></div>
    ) : (
      <div className="button-row">
        {view ? (
          view.phase === 'draft' && (
            <button
              disabled={busy}
              onClick={() => {
                const targetMode = view.sourceMode === 'local' ? 'workbench' : 'local';
                void act(() => desktop!.transfer.prepare(profileKey, caseId, targetMode));
              }}
            >
              {view.sourceMode === 'local' ? '切换为工作台方案' : '切换为本地文件人工提交'}
            </button>
          )
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={()=>void act(()=>desktop!.transfer.prepare(profileKey,caseId,'workbench'))}>使用工作台稿件<ArrowRight size={15}/></button>
            <button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.prepare(profileKey,caseId,'local'))}>本地文件人工提交</button>
          </>
        )}
      </div>
    )}
  </div>
    {!inspecting&&!view&&<p className="note"><strong>推荐方案</strong>：使用工作台已完成起草与定稿的成果直接生成提交文件。如果你已在外部完成撰写、答复或补正，也可选择“本地文件人工提交”直接导入本地 DOCX 文件。</p>}
    {view&&!inspecting&&<div className={`transfer-status-summary is-${view.phase}`} role="status"><div className="transfer-status-main"><span>本次提交状态</span><strong>{phaseLabel[view.phase]}</strong><p>{phaseDescription[view.phase]}</p></div><dl><div><dt>本地文件</dt><dd>{view.files.length} 份</dd></div><div><dt>远端材料</dt><dd>{remoteFiles.length} 份</dd></div><div><dt>下一办理人</dt><dd>{user?.name||'未选择'}</dd></div></dl></div>}
    {error&&<div className="inline-warning" role="alert"><p>{error}</p>{recoveryAction&&<div className="button-row transfer-recovery">{recoveryAction}</div>}</div>}
    {view&&review&&<>
      {view.phase==='draft'&&<div className="button-row"><button disabled={busy} onClick={changeSource}>更换文件来源</button>{view.sourceMode==='workbench'&&<button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.reprepare(profileKey,view.id))}>重新获取工作台稿件</button>}</div>}
      {view.phase==='draft'&&<p className="note">{view.sourceMode==='local'?'本地文件人工方案：仅使用你选择的本次文件。补正内容在「本次材料」填写并保存到本地草稿。若需随时更换文件，可点击下方【选择文件】。':'工作台稿件方案：自动获取可用稿件并生成提交副本，请确认版本和文件；也可随时点击【选择文件】手动替换。补正内容在「本次材料」核对并保存。'}</p>}
      <div className="transfer-context"><b>{view.caseNumber}</b><span>{view.processName}</span><span>当前：{view.currentNode||(view.phase==='uncertain'?'实例状态待核验':'未创建递交实例')}{view.currentUser&&` · ${view.currentUser}`}</span></div>
      {view.phase==='saved'&&<div className="transfer-saved-banner">
        <div>
          <h4>材料与表单已在服务端保存就绪</h4>
          <p>本次材料与表单已成功核验落盘，无需重复上传。可直接预览递交材料，或转交下一办理人。</p>
        </div>
        <div className="button-row">
          <button type="button" disabled={busy} onClick={previewRemote} title="仅预览贝思兰德远端文件，不使用本地副本"><Eye size={14}/> {view.route==='correction'&&!remoteFiles.length?'查看结构化补正表单':'预览远端递交材料（含公式）'}</button>
          <button disabled={busy} onClick={()=>setConfirm('revoke')}>撤销本次保存</button>
          <button className="primary" disabled={busy||view.canEditRemote===false} onClick={()=>{setTab(2);if(user)setConfirm('submit');}}>
            {user?`直接转交给 ${user.name}`:'前往选择办理人并转交'}<ArrowRight size={14}/>
          </button>
        </div>
      </div>}
      {remoteFiles.length>0&&<section className="transfer-material-section" aria-label="远端材料">
        <div className="transfer-material-heading">
          <div><h4><Cloud size={17}/>远端材料 <span className="transfer-count">{remoteFiles.length}</span></h4><p>来自贝思兰德当前递交实例；可按文件单独预览或删除关联。</p></div>
          <span className={`transfer-existing-badge${view.phase==='saved'?'':' is-draft'}`}>{view.phase==='saved'?'已保存并核验':'当前实例文件'}</span>
        </div>
        <ul className="transfer-file-list">{remoteFiles.map((file,index)=>remoteFileRow(file,index,true))}</ul>
        <div className="transfer-material-footer">
          <p>删除关联仅影响所选文件在当前实例中的关联，保留其他材料、业务表单、本地原件及历史。删除后需重新核对并保存。</p>
          {view.phase==='draft'&&view.canEditRemote===true&&<button type="button" className="danger-quiet" disabled={busy||mustVerify} onClick={()=>setConfirm('clearRemote')} title="整组清理：移除当前实例的申请文件、五书、意见陈述书关联，并清空补正条目；保留本地原件与草稿"><Trash2 size={14}/>清理整组材料与表单</button>}
        </div>
      </section>}
      {view.sourceDraft&&<div className="transfer-source-confirm"><p>自动获取：{view.sourceDraft.pending?'最新待采用稿':'当前采用稿'}{view.sourceDraft.at?` · ${new Date(view.sourceDraft.at).toLocaleString('zh-CN')}`:''} · 版本 {view.sourceDraft.id.slice(0,8)}</p><label className="checkbox"><input type="checkbox" disabled={locked} checked={review.confirmedDraftId===view.sourceDraft.id} onChange={e=>patch({confirmedDraftId:e.target.checked?view.sourceDraft!.id:undefined})}/>确认本次提交使用此版本（不会自动采用或覆盖工作稿）</label></div>}
      {view.error&&<div role="alert" className="inline-warning"><p>{view.error}</p>{recoveryAction&&<div className="button-row transfer-recovery">{recoveryAction}</div>}</div>}
      {view.results.length>0&&<ol className="transfer-results">{view.results.map((s,i)=><li key={i}>{s}</li>)}</ol>}
      {!view.handId?<Note>{view.phase==='uncertain'?'启动结果尚未确认，请先点击【刷新本案】核对；若确认尚未创建递交实例，可返回草稿重新开始。':'当前没有递交实例。核对案件后，可启动本次内部递交流程。'}<button disabled={busy||view.phase!=='draft'} onClick={()=>setConfirm('start')}>启动递交实例</button>{view.phase==='uncertain'&&<button disabled={busy} onClick={()=>setConfirm('revoke')}>返回草稿重新开始</button>}</Note>:<>
        {view.canEditRemote===false&&<Note>当前账号不能编辑此节点。可查看材料与流程，保存和转交暂不可用。</Note>}<nav className="surface-switch">{['本次材料','业务表单','下一办理人与结果'].map((name,i)=><button key={name} className={tab===i?'active':''} onClick={()=>void goTab(i)}>{i+1} · {name}</button>)}</nav>
        {tab===0&&<>
          <section className="transfer-material-section" aria-label="本次本地文件">
            <div className="transfer-material-heading"><div><h4><Upload size={17}/>本次本地文件 <span className="transfer-count">{view.files.length}</span></h4><p>{remoteFiles.length?'需要修改或补充远端材料时，再选择本地文件。':'选择本次需要使用的 Word 文件。'}取消选择仅从本次方案移除，原件和已复制文件保留。</p></div></div>
          <ul className="transfer-file-list">{roles.map(role=>{
            const file=view.files.find(f=>f.role===role);
            return <TransferFileRow key={role} name={roleName[role]} source="local"
              detail={file?.name||(role==='application'&&view.route!=='application'?'可选 · 本次无修改时无需选择':'尚未选择文件')}
              hint={role==='baseline'?'仅用于比对，不会上传到贝思兰德。':undefined}
              actions={<>
                <button type="button" disabled={busy||!file} onClick={()=>void handlePreviewDoc({role})} title="仅预览本地待提交副本" aria-label={`预览本地副本：${roleName[role]}`}><Eye size={14}/>预览</button>
                {navigate&&view.sourceMode==='workbench'&&<button type="button" disabled={busy} onClick={()=>navigate('discussion')} title="前往定稿微调编辑器"><Edit3 size={14}/>微调</button>}
                <button type="button" disabled={locked} onClick={()=>void act(()=>desktop!.transfer.pickFile(profileKey,view.id,role))} aria-label={`${file?'更换':'选择'}文件：${roleName[role]}`}><Upload size={14}/>{file?'更换文件':'选择文件'}</button>
                {file&&view.phase==='draft'?<button type="button" disabled={locked} onClick={()=>void act(()=>desktop!.transfer.removeFile(profileKey,view.id,role))} title="仅取消本次方案的选用；保留本地原件、已复制文件及远端材料" aria-label={`取消选择：${file.name}`}><X size={14}/>取消选择</button>:<span className="transfer-empty-action" aria-hidden="true"/>}
              </>}/>;
          })}</ul>
          <div className="transfer-material-footer"><p>{view.route==='application'?'完整申请 Word 用于生成本次五书。':'说明书、权利要求书等可在对应行分别选择，同时保存多份修改文件；也可选择一份合并稿。两种申请文件方式不混用。'}文件复制到本案目录，原件和历史稿保留。</p></div>
          </section>
          {view.files.some(f=>f.role==='claims')&&<label className="field">本次权利要求项数（请核对）<input disabled={locked} inputMode="numeric" maxLength={8} value={review.form.claimsCount??''} onChange={e=>form({claimsCount:e.target.value})}/><span className="muted">按独立文件连续编号识别，未能识别时请填写实际项数。</span></label>}
          {view.parts.length>0&&<><h4>本次五书保留范围</h4><div className="transfer-parts">{view.parts.map(p=><div key={p.code}><label><input type="checkbox" disabled={locked||view.route==='application'||p.available===false} checked={review.keepCodes.includes(p.code)} onChange={e=>patch({keepCodes:e.target.checked?[...review.keepCodes,p.code]:review.keepCodes.filter(c=>c!==p.code)})}/><b>{p.name}</b><span className={p.changed===null?'text-warning':'muted'}>{view.route==='application'?'申请材料':p.changed===null?'待人工核对':p.changed?'发现变化':'未发现变化'}</span></label><p>{view.route==='application'?'本次完整申请保留此部分。':p.reason}</p>{(p.before||p.after)&&<div style={{display:'flex',gap:'8px',marginTop:'4px'}}><button type="button" className="small-button" onClick={()=>void handlePreviewDoc({partCode:p.code,name:p.name})}><Eye size={12}/> 预览此分件</button></div>}{view.route!=='application'&&(p.before||p.after)&&<details><summary>比较文字</summary><div className="transfer-comparison"><div><b>基线</b><pre>{p.before||'未识别正文'}</pre></div><div><b>本次</b><pre>{p.after||'未识别正文'}</pre></div></div></details>}</div>)}</div>{view.route!=='application'&&<Note>保存后，本次递交列表只保留勾选的五书部分；未勾选部分及完整混合申请文件会从当前递交实例移除。</Note>}</>}
          {view.route==='correction'&&<div className="transfer-form">
            <h4>补正内容</h4>
            <p className="muted">请填写文件名称、具体位置、补正前和补正后，并点「保存补正内容」写入本机提交草稿。切到其他页面后仍保留；第三步「核对并保存材料」才会写入贝思兰德补正表。</p>
            <CorrectionEntriesEditor corrections={review.form.corrections} correctionReason={review.form.correctionReason} locked={locked} onChange={rows=>form({corrections:rows})}/>
            <div className="action-bar">
              <span>{correctionsDirty?'有未保存到本地草稿的改动':review.form.corrections.length?`已写入本地提交草稿 · ${review.form.corrections.length} 条`:'尚未填写补正条目'}</span>
              <button className="primary" type="button" disabled={locked||busy||!correctionsDirty} onClick={()=>void act(()=>desktop!.transfer.saveLocalReview(profileKey,view.id,review),false)}>
                <Save size={14}/>{busy?'保存中…':'保存补正内容'}
              </button>
            </div>
          </div>}
          <div className="button-row">
            <button disabled={!!view.sourceDraft&&review.confirmedDraftId!==view.sourceDraft.id} onClick={()=>void goTab(1)}>继续核对表单<ArrowRight size={15}/></button>
            {view.phase==='saved'&&<button className="primary" disabled={busy||view.canEditRemote===false} onClick={()=>{setTab(2);if(user)setConfirm('submit');}}>已保存就绪，直接转交{user?`给 ${user.name}`:''}<ArrowRight size={14}/></button>}
          </div>
        </>}
        {tab===1&&<div className="transfer-form"><label className="field">指定摘要附图（默认图 1）<input disabled={locked} value={review.form.abstractFigure} onChange={e=>form({abstractFigure:e.target.value})}/></label><h4>{view.route==='reply'?'意见陈述书':view.route==='correction'?'补正内容核对':'提出申请请求书'}</h4>
          {view.route==='reply'&&<><label className="checkbox"><input type="radio" checked readOnly/>针对通知书陈述意见（已选择）</label><p className="muted">保存前自动核验意见陈述书表单已选中；以下字段来自本次通知书，请核对。</p><div className="form-grid"><label className="field">通知书发文日期<input type="date" disabled={locked} value={review.form.noticeDate} onChange={e=>form({noticeDate:e.target.value})}/></label><label className="field">通知书名称<input disabled={locked} value={review.form.noticeName} onChange={e=>form({noticeName:e.target.value})}/></label><label className="field">发文序号<input disabled={locked} value={review.form.noticeNo} onChange={e=>form({noticeNo:e.target.value})}/></label></div></>}
          {view.route==='reply'&&<><label className="checkbox"><input type="checkbox" disabled={locked} checked={review.form.otherProof} onChange={e=>form({otherProof:e.target.checked})}/>使用其他证明文件</label><label className="checkbox"><input type="checkbox" disabled={locked} checked={review.form.experimentData} onChange={e=>form({experimentData:e.target.checked})}/>本次补交实验数据</label></>}
          {view.route==='correction'&&<><p className="muted">逐条补正在「本次材料」填写并保存到本地草稿。本页只核对应写入贝思兰德的摘要附图等表单信息。</p>
            {correctionsDirty&&<p role="alert">有未保存到本地草稿的改动，请先回到本次材料保存。</p>}
            {!review.form.corrections.length&&<div className="inline-warning"><p>尚未填写补正条目。请回到本次材料增加并保存。</p></div>}
            {review.form.corrections.map((row,index)=><div className="correction-row" key={row.ChangeId}><b>条目 {index+1} · {row.FileName||'未选文件'}</b><p className="muted">位置：{row.PositionInFile||'未填'}{row.CorrectionBefore||row.CorrectionAfter?` · ${row.CorrectionBefore?'已填补正前':''}${row.CorrectionBefore&&row.CorrectionAfter?' / ':''}${row.CorrectionAfter?'已填补正后':''}`:''}</p></div>)}
            <button type="button" onClick={()=>void goTab(0)}>返回修改补正内容</button></>}
          {view.route==='application'&&<>{Object.entries(declarations).map(([key,label])=><label className="checkbox" key={key}><input type="checkbox" disabled={locked} checked={review.form.declarations[key]||false} onChange={e=>form({declarations:{...review.form.declarations,[key]:e.target.checked}})}/>{label}</label>)}<Note>已有请求书的其他字段与记录编号会保留；请在贝思兰德核对申请人、发明人等案件基本信息。</Note></>}
          <div className="button-row">
            <button onClick={()=>void goTab(2)}>继续选择下一办理人<ArrowRight size={15}/></button>
            {view.phase==='saved'&&<button className="primary" disabled={busy||view.canEditRemote===false} onClick={()=>{setTab(2);if(user)setConfirm('submit');}}>已保存就绪，直接转交{user?`给 ${user.name}`:''}<ArrowRight size={14}/></button>}
          </div>
        </div>}
        {tab===2&&<><div className="form-grid"><label className="field">下一流程<select disabled={lockedRecipient} value={review.stepId} onChange={e=>{
          const nextStepId=e.target.value;
          const st=view.steps.find(s=>s.id===nextStepId);
          const defaultUser=defaultTransferUser(st?.users??[]);
          patch({stepId:nextStepId,userId:defaultUser?.id||''});
        }}><option value="">选择流程</option>{view.steps.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field">下一办理人<select disabled={lockedRecipient} value={review.userId} onChange={e=>patch({userId:e.target.value})}><option value="">选择办理人</option>{step?.users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label></div><label className="field">转交备注<textarea disabled={lockedRecipient} maxLength={1000} value={review.remark} onChange={e=>patch({remark:e.target.value})}/></label>
          {view.phase==='saved'&&!user&&<div className="inline-warning" style={{margin:'8px 0'}}><p>请在上方选择下一流程与办理人（默认：{DEFAULT_INTERNAL_TRANSFER_RECIPIENT}）以完成转交。</p></div>}
          {remoteFiles.length>0&&<section className="transfer-material-section" aria-label="转交材料核对清单">
            <div className="transfer-material-heading">
              <h4>递交材料核对清单 <span className="transfer-count">{remoteFiles.length}</span></h4>
              <button type="button" disabled={busy} onClick={previewRemote} title="按远端文件编号预览，不使用本地副本"><Eye size={14}/> 预览远端正文与公式</button>
            </div>
            <ul className="transfer-file-list">
              {remoteFiles.map((file,index)=>remoteFileRow(file,index))}
            </ul>
          </section>}
          <div className="action-bar"><span>{view.phase==='submitted'?'内部转交已确认':view.phase==='saved'?'文件与表单保存已核验':view.phase==='uncertain'?'操作结果待核验：请先刷新核对，确认前不能重复写入':'请核对文件、表单和接收人'}</span>
            <div className="button-row">
              {view.phase==='saved'&&<button disabled={busy} onClick={()=>setConfirm('revoke')}>撤销保存 / 重新编辑</button>}
              {view.phase==='uncertain'&&!mustVerify&&<button disabled={busy} onClick={()=>setConfirm('revoke')}>返回草稿重新整理</button>}
              {view.phase==='uncertain'&&mustVerify&&<button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.refresh(profileKey,view.id))}>刷新核对结果</button>}
              {view.phase==='draft'?<button className="primary" disabled={locked||!user||!!view.sourceDraft&&review.confirmedDraftId!==view.sourceDraft.id} onClick={()=>setConfirm('save')}>核对并保存材料</button>:view.phase==='saved'?<button className="primary" disabled={busy||view.canEditRemote===false||!user} onClick={()=>setConfirm('submit')}>转交给 {user?.name||'下一办理人'}</button>:null}
            </div>
          </div>
        </>}
      </>}
      {confirm&&<Modal title={confirm==='save'?'确认保存本次递交材料':confirm==='submit'?'确认内部转交':confirm==='revoke'?'确认撤销本次保存':confirm==='clearRemote'?'确认清理整组材料与表单':'确认启动递交实例'} onClose={()=>setConfirm(undefined)}>
        <p><b>{view.caseNumber} · {view.caseTitle}</b></p>
        <p>{view.processName} → {step?.name||'本次内部递交流程'}{user&&` · ${user.name}`}</p>
        {confirm==='save'&&<><p>保留：{review.keepCodes.map(c=>FIVE_PARTS.find(p=>p.code===c)?.name).join('、')||'本次未选择五书修改部分'}{view.route==='reply'?'；意见陈述书 Word':''}{view.route==='correction'?'；结构化补正书':''}</p>{view.parts.length>0&&view.route!=='application'&&<p>从本次递交列表移除：完整混合申请文件、{FIVE_PARTS.filter(p=>!review.keepCodes.includes(p.code)).map(p=>p.name).join('、')||'无其他部分'}。本地及历史文件保留。</p>}</>}
        {confirm==='revoke'&&<p>{view.phase==='uncertain'?'本次保存未全部核验完成。撤销后将回到草稿状态，并回读贝思兰德当前材料重新比对；本地文件与已填表单保留，可重新选择文件后再次保存。':'撤销后将回到草稿状态，允许重新选择文件、调整五书勾选或修改表单。原已填写的表单字段、补正内容与接收人将完整保留，修改后可随时再次核对并保存。'}</p>}
        {confirm==='clearRemote'&&<div className="inline-warning" style={{marginTop:'8px'}}><p><strong>整组清理范围</strong>：确定清理当前递交实例的材料关联与表单吗？</p><p>这将清理当前递交实例的五书、混合申请文件、意见陈述书关联及补正条目，并回读核验。部分失败时保持待核验状态；本地工作台材料和已填草稿仍保留，不代表服务器底层文件已物理删除。</p></div>}
        <p>{confirm==='submit'?'将已核验材料转交上述内部办理人；后续官方递交由接收人办理。':confirm==='save'?'请确认上述案件、材料范围及表单内容准确。':''}</p>
        <div className="action-bar">
          <button onClick={()=>setConfirm(undefined)}>返回</button>
          <button className={confirm==='clearRemote'?'danger':confirm==='revoke'?'':'primary'} disabled={busy} onClick={()=>{
            const action=confirm;setConfirm(undefined);
            if(action==='revoke'){
              void act(async()=>desktop!.transfer.revoke(profileKey,view.id));
            }else if(action==='clearRemote'){
              void act(async()=>desktop!.transfer.clearRemote(profileKey,view.id));
            }else{
              setTab(2);
              void act(async()=>action==='save'?desktop!.transfer.save(profileKey,view.id,review):action==='submit'?desktop!.transfer.submit(profileKey,view.id,review):desktop!.transfer.startHand(profileKey,view.id));
            }
          }}>
            确认{confirm==='save'?'保存':confirm==='submit'?'内部转交':confirm==='revoke'?'撤销保存':confirm==='clearRemote'?'清理整组材料与表单':'启动'}
          </button>
        </div>
      </Modal>}
      {deleteTarget&&<Modal title="删除单个远端文件关联" onClose={()=>setDeleteTarget(undefined)}>
        <div className="transfer-delete-context"><span>{view.caseNumber} · {view.processName}</span><strong>{deleteTarget.name}</strong><small>文件编号：{deleteTarget.ref.fileNo}</small></div>
        <div className="transfer-delete-scope"><p><b>删除范围</b>仅解除此文件与当前递交实例的关联，不是服务器底层文件的物理删除。</p><p><b>保留内容</b>其他远端材料、业务表单、本地原件、草稿和历史版本均保留。</p><p><b>后续操作</b>核验成功后返回草稿，需重新核对并保存才能转交。本地副本仍被选用时，再次保存可能重新上传此文件。</p></div>
        {(deleteReason||deleteChanged)&&<p className="inline-warning" role="alert">{deleteReason||'文件或表单已变化，请关闭后重新确认。'}</p>}
        <div className="action-bar"><button type="button" onClick={()=>setDeleteTarget(undefined)}>取消</button><button type="button" className="danger" disabled={busy||!!deleteReason||deleteChanged} onClick={()=>{const target=deleteTarget.ref;setDeleteTarget(undefined);void act(()=>desktop!.transfer.deleteRemoteFile(profileKey,view.id,target));}}><Trash2 size={14}/>确认删除此文件关联</button></div>
      </Modal>}
      {remotePicker&&<Modal title="选择远端递交材料" onClose={()=>setRemotePicker(false)}>
        <p>以下预览按贝思兰德文件编号读取；同名本地副本不会替代远端文件。</p>
        <ul className="transfer-file-list transfer-picker-list">{remoteFiles.map((file,index)=>remoteFileRow(file,index))}</ul>
        {remoteFiles.some(file=>!remotePreviewRef(file))&&<p role="alert">旧记录缺少文件编号，请刷新核对后预览。</p>}
      </Modal>}
      {previewDoc && (
        <Modal title={previewDoc.title} onClose={() => setPreviewDoc(null)}>
          <FormattedFormulaText text={previewDoc.text} className="agent-preview doc-preview-modal-body" />
        </Modal>
      )}
      {nameConfirmReq && (
        <Modal title="确认申请文件名称差异" onClose={() => handleNameConfirm(false)}>
          <p>贝思兰德要求确认申请文件名称与系统案件名称不一致。</p>
          <div className="note" style={{ margin: '12px 0' }}>
            <p><b>申请文件名称：</b>{nameConfirmReq.applicationName}</p>
            <p><b>当前案件显示名称：</b>{nameConfirmReq.caseName}</p>
          </div>
          <p className="muted" style={{ fontSize: '13px' }}>
            确认后仅重试本次设置；此前上传文件保留。请核对服务端案件名称后决定。
          </p>
          <div className="action-bar">
            <button type="button" onClick={() => handleNameConfirm(false)}>暂不确认</button>
            <button type="button" className="primary" onClick={() => handleNameConfirm(true)}>确认名称差异并保存设置</button>
          </div>
        </Modal>
      )}
    </>}
  </section>;
}
