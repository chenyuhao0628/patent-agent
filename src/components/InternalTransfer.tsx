import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Edit3, Eye, FileText, RefreshCw, Save, Upload } from 'lucide-react';
import { desktop } from '../desktop.ts';
import type { Case } from '../domain/workflow.ts';
import { currentWork, internalTransferAvailable } from '../domain/lifecycle.ts';
import { currentHandling } from '../domain/handling.ts';
import { FIVE_PARTS } from '../transfer-api.ts';
import type { TransferView, TransferReview, TransferFileRole, TransferForm } from '../transfer-api.ts';
import { Modal, Note } from './Primitives.tsx';
import { FormattedFormulaText } from './FormattedFormulaText.tsx';

const declarations:Record<string,string>={IsApplySameDay:'同日申请',IsPublicAdvance:'请求提前公开',IsExhibition:'展览会公开声明',IsPublished:'学术或技术会议公开声明',IsPublicForCommonProfit:'公共利益目的公开声明',IsDisclosure:'他人未经同意泄露声明',IsGiveUpOn51Section:'放弃主动修改',IsRequestDelayReview1YearForUtility:'实用新型延迟审查一年'};
const correctionLabels={FileName:'文件名称',PositionInFile:'具体位置',CorrectionBefore:'补正前',CorrectionAfter:'补正后'} as const;
function correctionFileOptions(reason:number){
  return [...FIVE_PARTS.map(p=>p.name),'核苷酸或氨基酸序列表','其他',...(reason===2?['请求书','授权委托书','主体资格证明']:[])];
}
function reviewChanged(a?:TransferReview,b?:TransferReview){
  return JSON.stringify(a)!==JSON.stringify(b);
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

export function InternalTransfer({profileKey,item,refreshSeq,navigate}:{profileKey:string;item:Case;refreshSeq?:number;navigate?:(tab:any)=>void}){
  const processId=currentWork(item).processId;
  const cacheKey=`${profileKey}/${item.id}/${processId}`;
  const [view,setView]=useState<TransferView|undefined>(()=>transferCache.get(cacheKey)?.view);
  const [review,setReview]=useState<TransferReview|undefined>(()=>{const c=transferCache.get(cacheKey)?.review;return c?structuredClone(c):undefined;});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [tab,setTab]=useState<number>(()=>transferCache.get(cacheKey)?.tab??0);
  const [confirm,setConfirm]=useState<'save'|'submit'|'start'|'revoke'|'clearRemote'>();
  const [inspecting,setInspecting]=useState<boolean>(()=>!transferCache.has(cacheKey));
  const [previewDoc, setPreviewDoc]=useState<{title:string;text:string}|null>(null);
  const scope=useRef('');scope.current=cacheKey;
  const lastRefreshSeq=useRef(refreshSeq);
  useEffect(()=>{
    if(refreshSeq!==undefined&&refreshSeq!==lastRefreshSeq.current){
      lastRefreshSeq.current=refreshSeq;
      const cached=transferCache.get(cacheKey);
      if(cached?.view?.id&&desktop?.transfer?.refresh){
        void desktop.transfer.refresh(profileKey,cached.view.id).then(v=>{
          if(scope.current===cacheKey){
            transferCache.set(cacheKey,{view:v,review:transferCache.get(cacheKey)?.review,tab:tab});
            setView(v);
          }
        }).catch(()=>{});
      }
    }
  },[refreshSeq,cacheKey,profileKey]);

  useEffect(()=>{
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
        void desktop.transfer.inspect(profileKey,item.id).then(found=>{
          if(scope.current===cacheKey){
            if(found&&found.profileKey===profileKey&&found.caseId===item.id&&found.processId===processId){
              setView(found);
              setReview(structuredClone(found.review));
              const initialTab=(found.phase==='saved'||found.phase==='submitted')?2:0;
              setTab(initialTab);
              transferCache.set(cacheKey,{view:found,review:found.review,tab:initialTab});
            }else{
              setView(undefined);
            }
          }
        }).catch(()=>{
          if(scope.current===cacheKey)setView(undefined);
        }).finally(()=>{
          if(scope.current===cacheKey)setInspecting(false);
        });
      }else{
        setInspecting(false);
      }
    }
  },[cacheKey]);

  useEffect(()=>{
    if(view) transferCache.set(cacheKey,{view:review?{...view,review}:view,review,tab});
  },[cacheKey,view,review,tab]);
  const latest=useRef({view,review,profileKey});
  latest.current={view,review,profileKey};
  useEffect(()=>()=>{
    const {view:v,review:r,profileKey:key}=latest.current;
    if(v?.phase==='draft'&&r&&desktop?.transfer?.saveLocalReview&&reviewChanged(v.review,r)){
      void desktop.transfer.saveLocalReview(key,v.id,r);
    }
  },[]);

  const available=internalTransferAvailable(item)&&!currentHandling(item).officialWaiting;
  if(!available)return null;
  const persistLocalReview=async(currentView=view,currentReview=review)=>{
    if(!currentView||currentView.phase!=='draft'||!currentReview||!desktop?.transfer.saveLocalReview)return currentView;
    if(!reviewChanged(currentView.review,currentReview))return currentView;
    return desktop.transfer.saveLocalReview(profileKey,currentView.id,currentReview);
  };
  const act=async(fn:()=>Promise<TransferView>,flush=true)=>{
    const startedScope=scope.current;setBusy(true);setError('');
    try{
      if(flush)await persistLocalReview();
      const next=await fn();
      if(scope.current===startedScope&&next.profileKey===profileKey&&next.caseId===item.id&&next.processId===processId){
        setView(next);setReview(structuredClone(next.review));
        if((next.phase==='saved'||next.phase==='submitted')&&tab===0)setTab(2);
      }
    }catch(e){if(scope.current===startedScope)setError((e as Error).message);}
    finally{if(scope.current===startedScope)setBusy(false);}
  };
  const goTab=async(n:number)=>{
    if(view?.phase==='draft'&&review&&reviewChanged(view.review,review)&&desktop?.transfer.saveLocalReview){
      setBusy(true);setError('');
      try{
        const next=await desktop.transfer.saveLocalReview(profileKey,view.id,review);
        if(scope.current===cacheKey){setView(next);setReview(structuredClone(next.review));}
      }catch(e){setError((e as Error).message);setBusy(false);return;}
      setBusy(false);
    }
    setTab(n);
  };
  const patch=(v:Partial<TransferReview>)=>setReview(r=>r?{...r,...v}:r);
  const form=(v:Partial<TransferForm>)=>setReview(r=>r?{...r,form:{...r.form,...v}}:r);
  const correctionsDirty=!!view&&!!review&&JSON.stringify(view.review.form.corrections)!==JSON.stringify(review.form.corrections);
  const locked=busy||view?.phase!=='draft'||view?.canEditRemote===false;
  const lockedRecipient=busy||(view?.phase!=='draft'&&view?.phase!=='saved')||view?.canEditRemote===false;
  const roles:TransferFileRole[]=view?.route==='application'?['application']:['baseline','application',...(view?.route==='reply'?['reply' as const]:[])];
  const roleName={baseline:'修改前申请文件（比对用，可选）',application:view?.route==='application'?'完整申请文件':'本次修改后的申请文件（有修改时）',reply:'意见陈述书 Word'};
  const step=view?.steps.find(s=>s.id===review?.stepId),user=step?.users.find(u=>u.id===review?.userId);

  const handlePreviewDoc=async(fileRef:{role?:TransferFileRole;partCode?:string;fileNo?:string;name?:string})=>{
    if(!desktop?.transfer?.previewFile||!view)return;
    setBusy(true);
    try{
      const res=await desktop.transfer.previewFile(profileKey,view.id,fileRef);
      if(res){
        let text=res.content||'';
        if(res.parts&&res.parts.length>0){
          text=res.parts.map(p=>`### ${p.name}\n\n${p.content}`).join('\n\n');
        }
        setPreviewDoc({title:res.name||'正文与公式预览',text:text||'（该材料无文本正文）'});
      }
    }catch(err){
      setError('预览失败：'+(err as Error).message);
    }finally{
      setBusy(false);
    }
  };
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
                transferCache.delete(cacheKey);
                void act(() => desktop!.transfer.prepare(profileKey, item.id, targetMode));
              }}
            >
              {view.sourceMode === 'local' ? '切换为工作台方案' : '🔄 切换为本地文件人工提交'}
            </button>
          )
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={()=>void act(()=>desktop!.transfer.prepare(profileKey,item.id,'workbench'))}>使用工作台稿件<ArrowRight size={15}/></button>
            <button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.prepare(profileKey,item.id,'local'))}>本地文件人工提交</button>
          </>
        )}
      </div>
    )}
  </div>
    {!inspecting&&!view&&<p className="note"><strong>推荐方案</strong>：使用工作台已完成起草与定稿的成果直接生成提交文件。如果你已在外部完成撰写、答复或补正，也可选择“本地文件人工提交”直接导入本地 DOCX 文件。</p>}
    {error&&<div className="inline-warning" role="alert"><p>{error}</p><div className="button-row" style={{marginTop:'8px'}}><button className="primary" disabled={busy} onClick={()=>{transferCache.delete(cacheKey);void act(()=>desktop!.transfer.prepare(profileKey,item.id,'local'));}}>进入本地文件人工提交（跳过工作台）</button></div></div>}
    {view&&review&&<>
      {view.phase==='draft'&&<div className="button-row"><button disabled={busy} onClick={()=>{transferCache.delete(cacheKey);setView(undefined);setReview(undefined);setTab(0);}}>更换文件来源</button>{view.sourceMode==='workbench'&&<button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.reprepare(profileKey,view.id))}>重新获取工作台稿件</button>}</div>}
      {view.phase==='draft'&&<p className="note">{view.sourceMode==='local'?'本地文件人工方案：仅使用你选择的本次文件。补正内容在「本次材料」填写并保存到本地草稿。若需随时更换文件，可点击下方【选择文件】。':'工作台稿件方案：自动获取可用稿件并生成提交副本，请确认版本和文件；也可随时点击【选择文件】手动替换。补正内容在「本次材料」核对并保存。'}</p>}
      <div className="transfer-context"><b>{view.caseNumber}</b><span>{view.processName}</span><span>当前：{view.currentNode||(view.phase==='uncertain'?'实例状态待核验':'未创建递交实例')}{view.currentUser&&` · ${view.currentUser}`}</span></div>
      {view.phase==='saved'&&<div className="transfer-saved-banner">
        <div>
          <h4>材料与表单已在服务端保存就绪</h4>
          <p>本次材料与表单已成功核验落盘，无需重复上传。可直接预览递交材料，或转交下一办理人。</p>
        </div>
        <div className="button-row">
          <button type="button" disabled={busy} onClick={()=>void handlePreviewDoc({role:view.route==='reply'?'reply':'application'})} title="预览保存至系统的正文与公式"><Eye size={14}/> 预览递交材料（含公式）</button>
          <button disabled={busy} onClick={()=>setConfirm('revoke')}>撤销本次保存</button>
          <button className="primary" disabled={busy||view.canEditRemote===false||!user} onClick={()=>{setTab(2);setConfirm('submit');}}>
            直接转交给 {user?.name||'下一办理人'}<ArrowRight size={14}/>
          </button>
        </div>
      </div>}
      {view.existingFileNames.length>0&&<div className={`transfer-existing-box${view.phase==='saved'?' is-saved':' is-draft'}`}>
        <div className="transfer-existing-header">
          <span>贝思兰德远端当前已有材料 · {view.existingFileNames.length} 件（点击可直接预览）</span>
          <div className="button-row" style={{margin:0}}>
            <span className={`transfer-existing-badge${view.phase==='saved'?'':' is-draft'}`}>{view.phase==='saved'?'服务端已保存就绪':'实例已有文件'}</span>
            {view.phase==='draft'&&view.canEditRemote!==false&&<button type="button" className="small-button" disabled={busy} onClick={()=>setConfirm('clearRemote')} title="物理删除贝思兰德系统内的远端上传材料并重置表单" style={{color:'#c53030',borderColor:'#feb2b2',background:'#fff5f5'}}>🗑️ 清空系统内远端材料</button>}
          </div>
        </div>
        <div className="transfer-file-chips">
          {view.existingFileNames.map((n,i)=><button type="button" className="transfer-file-chip clickable" key={i} onClick={()=>void handlePreviewDoc({name:n})} title={`点击预览：${n}`} style={{cursor:'pointer',border:'1px solid var(--line)',background:'var(--surface,#fff)',borderRadius:'4px',padding:'2px 8px',display:'inline-flex',alignItems:'center',gap:'4px',fontSize:'12px'}}><Eye size={12}/>{n}</button>)}
        </div>
        {view.phase==='saved'&&<p className="muted">上述材料已在贝思兰德递交实例落盘保存，无需重复上传。核对表单与下一办理人后即可直接转交。</p>}
      </div>}
      {view.sourceDraft&&<div className="transfer-source-confirm"><p>自动获取：{view.sourceDraft.pending?'最新待采用稿':'当前采用稿'}{view.sourceDraft.at?` · ${new Date(view.sourceDraft.at).toLocaleString('zh-CN')}`:''} · 版本 {view.sourceDraft.id.slice(0,8)}</p><label className="checkbox"><input type="checkbox" disabled={locked} checked={review.confirmedDraftId===view.sourceDraft.id} onChange={e=>patch({confirmedDraftId:e.target.checked?view.sourceDraft!.id:undefined})}/>确认本次提交使用此版本（不会自动采用或覆盖工作稿）</label></div>}
      {view.error&&<p role="alert" className="inline-warning">{view.error}</p>}
      {view.results.length>0&&<ol className="transfer-results">{view.results.map((s,i)=><li key={i}>{s}</li>)}</ol>}
      {!view.handId?<Note>{view.phase==='uncertain'?'启动结果尚未确认，请点击顶栏【刷新本案】核对。':'当前没有递交实例。核对案件后，可启动本次内部递交流程。'}<button disabled={busy||view.phase!=='draft'} onClick={()=>setConfirm('start')}>启动递交实例</button></Note>:<>
        {view.canEditRemote===false&&<Note>贝思兰德当前未授权本账号编辑此节点。可查看材料与流程，保存和转交暂不可用。</Note>}<nav className="surface-switch">{['本次材料','业务表单','下一办理人与结果'].map((name,i)=><button key={name} className={tab===i?'active':''} onClick={()=>void goTab(i)}>{i+1} · {name}</button>)}</nav>
        {tab===0&&<>
          {view.existingFileNames.length>0&&<div className="note"><strong>远端材料已就绪</strong>：贝思兰德当前已存在上述 {view.existingFileNames.length} 个文件。下方本地文件仅在需要修改或补充时选择。</div>}
          <div className="transfer-files">{roles.map(role=>{
            const file=view.files.find(f=>f.role===role);
            const handlePreview=async()=>{
              if(desktop?.transfer?.previewFile){
                try{
                  const res=await desktop.transfer.previewFile(profileKey,view.id,{role});
                  if(res&&(res.content||(res.parts&&res.parts.length>0))){
                    let text=res.content||'';
                    if(res.parts&&res.parts.length>0){
                      text=res.parts.map(p=>`### ${p.name}\n\n${p.content}`).join('\n\n');
                    }
                    setPreviewDoc({title:res.name||roleName[role],text});
                    return;
                  }
                }catch{}
              }
              if(role==='application'){
                const partsText=view.parts
                  .filter(p=>view.route==='application'||review.keepCodes.includes(p.code)||(p.after||p.before))
                  .map(p=>`### ${p.name}\n${p.after||p.before||'（未识别正文）'}`)
                  .join('\n\n');
                if(partsText){
                  setPreviewDoc({title:roleName[role],text:partsText});
                  return;
                }
              }
              if(desktop?.agent?.getCase){
                try{
                  const agentCase=await desktop.agent.getCase(profileKey,item.id);
                  const matchingArt = agentCase.artifacts.find(a => 
                    (role === 'reply' && a.kind === 'final-word') ||
                    (role === 'application' && (a.kind === 'final-application-CLAIMS' || a.kind === 'final-amendment'))
                  );
                  if (matchingArt?.text) {
                    setPreviewDoc({ title: `${roleName[role]}${matchingArt.externallyModified ? '（外部已修改）' : ''}`, text: matchingArt.text });
                    return;
                  }
                  const draft=agentCase.process.drafts.find(d=>d.id===view.sourceDraft?.id)
                    ?? agentCase.process.drafts.find(d=>d.adoptStatus==='adopted')
                    ?? agentCase.process.drafts.at(-1);
                  if(role==='reply'&&draft?.text){
                    setPreviewDoc({title:'意见陈述书正文与公式预览',text:draft.text});
                    return;
                  }
                  if(role==='application'&&draft?.applicationParts){
                    const partsText=Object.entries(draft.applicationParts)
                      .map(([part,content])=>`### ${part==='CLAIMS'?'权利要求书':part==='DESCRIPTION'?'说明书':part}\n${content}`)
                      .join('\n\n');
                    if(partsText){
                      setPreviewDoc({title:'修改后申请文件正文与公式预览',text:partsText});
                      return;
                    }
                  }
                }catch{}
              }
              if(file&&desktop?.openMaterial){
                void desktop.openMaterial(item.id,file.relativePath);
              }
            };
            return <div key={role} style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:'12px',padding:'12px',border:'1px solid var(--line)',borderRadius:'8px',background:'#fff'}}>
              <div style={{display:'flex',alignItems:'center',gap:'10px',minWidth:0,flex:1}}>
                <FileText size={20}/>
                <span style={{minWidth:0}}><b>{roleName[role]}</b><small style={{display:'block',color:'#6a7080'}}>{file?.name||(role==='application'&&view.route!=='application'?'本次未修改申请文件时可不选':'尚未选择')}</small></span>
              </div>
              <div className="button-row">
                <button type="button" onClick={()=>void handlePreview()} title="预览正文与专业公式排版"><Eye size={14}/>预览正文</button>
                {navigate&&view.sourceMode==='workbench'&&<button type="button" onClick={()=>navigate('discussion')} title="前往定稿微调编辑器直接编辑稿件或识别公式"><Edit3 size={14}/>打开微调</button>}
                <button disabled={locked} onClick={()=>void act(()=>desktop!.transfer.pickFile(profileKey,view.id,role))}><Upload size={14}/>选择文件</button>
                {file&&view.phase==='draft'&&<button type="button" disabled={locked} onClick={()=>void act(()=>desktop!.transfer.removeFile(profileKey,view.id,role))} title="移除此本地文件" style={{color:'#c53030'}}>移除</button>}
              </div>
            </div>;
          })}</div>
          <p className="muted">{view.route==='correction'?'修改前文件仅供比对，不上传；修改后文件仅在本次修改申请内容时需要。补正没有意见陈述书 Word，逐条补正内容在本页填写并保存到本地提交草稿。':'修改前文件仅供比对，不上传；修改后文件仅在本次修改申请内容时需要，保存时提取勾选部分；意见陈述书是本次答复正文。'}文件复制到本案目录，原件和历史稿保留。</p>
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
            {view.phase==='saved'&&<button className="primary" disabled={busy||view.canEditRemote===false||!user} onClick={()=>{setTab(2);setConfirm('submit');}}>已保存就绪，直接转交<ArrowRight size={14}/></button>}
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
            {view.phase==='saved'&&<button className="primary" disabled={busy||view.canEditRemote===false||!user} onClick={()=>{setTab(2);setConfirm('submit');}}>已保存就绪，直接转交<ArrowRight size={14}/></button>}
          </div>
        </div>}
        {tab===2&&<><div className="form-grid"><label className="field">下一流程<select disabled={lockedRecipient} value={review.stepId} onChange={e=>patch({stepId:e.target.value,userId:''})}><option value="">选择流程</option>{view.steps.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field">下一办理人<select disabled={lockedRecipient} value={review.userId} onChange={e=>patch({userId:e.target.value})}><option value="">选择办理人</option>{step?.users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label></div><label className="field">转交备注<textarea disabled={lockedRecipient} maxLength={1000} value={review.remark} onChange={e=>patch({remark:e.target.value})}/></label>
          {view.existingFileNames.length>0&&<div style={{margin:'12px 0',padding:'12px',borderRadius:'8px',border:'1px solid var(--line)',background:'var(--surface,#f8fafc)'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px'}}>
              <b>贝思兰德递交材料清单 · {view.existingFileNames.length} 件</b>
              <button type="button" disabled={busy} onClick={()=>void handlePreviewDoc({role:view.route==='reply'?'reply':'application'})} title="完整预览本次递交材料正文与公式"><Eye size={14}/> 预览递交正文与公式</button>
            </div>
            <ul style={{margin:0,paddingLeft:'18px'}}>
              {view.existingFileNames.map((n,i)=><li key={i} style={{marginBottom:'4px',display:'flex',alignItems:'center',gap:'8px'}}>
                <span>{n}</span>
                <button type="button" style={{border:'none',background:'transparent',color:'var(--primary,#2563eb)',cursor:'pointer',fontSize:'12px',textDecoration:'underline',display:'inline-flex',alignItems:'center',gap:'2px'}} onClick={()=>void handlePreviewDoc({name:n})}>
                  <Eye size={12}/> 预览
                </button>
              </li>)}
            </ul>
          </div>}
          <div className="action-bar"><span>{view.phase==='submitted'?'内部转交已确认':view.phase==='saved'?'文件与表单保存已核验':view.phase==='uncertain'?'结果待核对，请点击顶栏【刷新本案】':'请核对文件、表单和接收人'}</span>
            <div className="button-row">
              {view.phase==='saved'&&<button disabled={busy} onClick={()=>setConfirm('revoke')}>撤销保存 / 重新编辑</button>}
              {view.phase==='draft'?<button className="primary" disabled={locked||!user||!!view.sourceDraft&&review.confirmedDraftId!==view.sourceDraft.id} onClick={()=>setConfirm('save')}>核对并保存材料</button>:view.phase==='saved'?<button className="primary" disabled={busy||view.canEditRemote===false||!user} onClick={()=>setConfirm('submit')}>转交给 {user?.name||'下一办理人'}</button>:null}
            </div>
          </div>
        </>}
      </>}
      {confirm&&<Modal title={confirm==='save'?'确认保存本次递交材料':confirm==='submit'?'确认内部转交':confirm==='revoke'?'确认撤销本次保存':confirm==='clearRemote'?'确认清空贝思兰德系统内的远端材料':'确认启动递交实例'} onClose={()=>setConfirm(undefined)}>
        <p><b>{view.caseNumber} · {view.caseTitle}</b></p>
        <p>{view.processName} → {step?.name||'本次内部递交流程'}{user&&` · ${user.name}`}</p>
        {confirm==='save'&&<><p>保留：{review.keepCodes.map(c=>FIVE_PARTS.find(p=>p.code===c)?.name).join('、')||'本次未选择五书修改部分'}{view.route==='reply'?'；意见陈述书 Word':''}{view.route==='correction'?'；结构化补正书':''}</p>{view.parts.length>0&&view.route!=='application'&&<p>从本次递交列表移除：完整混合申请文件、{FIVE_PARTS.filter(p=>!review.keepCodes.includes(p.code)).map(p=>p.name).join('、')||'无其他部分'}。本地及历史文件保留。</p>}</>}
        {confirm==='revoke'&&<p>撤销后将回到草稿状态，允许重新选择文件、调整五书勾选或修改表单。原已填写的表单字段、补正内容与接收人将完整保留，修改后可随时再次核对并保存。</p>}
        {confirm==='clearRemote'&&<div className="inline-warning" style={{marginTop:'8px'}}><p><strong>⚠️ 高风险操作</strong>：确定清空贝思兰德系统内已上传的文件与表单吗？</p><p>这将调用系统接口物理删除当前流程节点已上传的五书、修改文件或意见陈述书，并重置表单为草稿状态。操作成功后无法撤回，但本地工作台材料仍保留。</p></div>}
        <p>{confirm==='submit'?'将已核验材料转交上述内部办理人；后续官方递交由接收人办理。':confirm==='save'?'请确认上述案件、材料范围及表单内容准确。':''}</p>
        <div className="action-bar">
          <button onClick={()=>setConfirm(undefined)}>返回</button>
          <button className={confirm==='revoke'||confirm==='clearRemote'?'':'primary'} disabled={busy} style={confirm==='clearRemote'?{color:'#fff',background:'#e53e3e',borderColor:'#c53030'}:{}} onClick={()=>{
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
            确认{confirm==='save'?'保存':confirm==='submit'?'内部转交':confirm==='revoke'?'撤销保存':confirm==='clearRemote'?'清空远端材料':'启动'}
          </button>
        </div>
      </Modal>}
      {previewDoc && (
        <Modal title={previewDoc.title} onClose={() => setPreviewDoc(null)}>
          <FormattedFormulaText text={previewDoc.text} className="agent-preview" />
        </Modal>
      )}
    </>}
  </section>;
}
