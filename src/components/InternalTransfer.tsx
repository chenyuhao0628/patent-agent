import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, RefreshCw, Upload } from 'lucide-react';
import { desktop } from '../desktop.ts';
import type { Case } from '../domain/workflow.ts';
import { currentWork, internalTransferAvailable } from '../domain/lifecycle.ts';
import { currentHandling } from '../domain/handling.ts';
import { FIVE_PARTS } from '../transfer-api.ts';
import type { TransferView, TransferReview, TransferFileRole, TransferForm } from '../transfer-api.ts';
import { Modal, Note } from './Primitives.tsx';

const declarations:Record<string,string>={IsApplySameDay:'同日申请',IsPublicAdvance:'请求提前公开',IsExhibition:'展览会公开声明',IsPublished:'学术或技术会议公开声明',IsPublicForCommonProfit:'公共利益目的公开声明',IsDisclosure:'他人未经同意泄露声明',IsGiveUpOn51Section:'放弃主动修改',IsRequestDelayReview1YearForUtility:'实用新型延迟审查一年'};

const transferCache = new Map<string, { view?: TransferView; review?: TransferReview; tab: number }>();

export function InternalTransfer({profileKey,item}:{profileKey:string;item:Case}){
  const processId=currentWork(item).processId;
  const cacheKey=`${profileKey}/${item.id}/${processId}`;
  const [view,setView]=useState<TransferView|undefined>(()=>transferCache.get(cacheKey)?.view);
  const [review,setReview]=useState<TransferReview|undefined>(()=>{const c=transferCache.get(cacheKey)?.review;return c?structuredClone(c):undefined;});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [tab,setTab]=useState<number>(()=>transferCache.get(cacheKey)?.tab??0);
  const [confirm,setConfirm]=useState<'save'|'submit'|'start'>();
  const scope=useRef('');scope.current=cacheKey;

  useEffect(()=>{
    const cached=transferCache.get(cacheKey);
    if(cached){
      setView(cached.view);
      setReview(cached.review?structuredClone(cached.review):undefined);
      setTab(cached.tab??0);
      setError('');
      setBusy(false);
      setConfirm(undefined);
    }else{
      setView(undefined);
      setReview(undefined);
      setTab(0);
      setError('');
      setBusy(false);
      setConfirm(undefined);
      if(desktop?.transfer?.inspect){
        void desktop.transfer.inspect(profileKey,item.id).then(found=>{
          if(scope.current===cacheKey&&found&&found.profileKey===profileKey&&found.caseId===item.id&&found.processId===processId){
            setView(found);
            setReview(structuredClone(found.review));
            const initialTab=found.phase==='saved'?2:0;
            setTab(initialTab);
            transferCache.set(cacheKey,{view:found,review:found.review,tab:initialTab});
          }
        }).catch(()=>{});
      }
    }
  },[cacheKey]);

  useEffect(()=>{
    if(view) transferCache.set(cacheKey,{view,review,tab});
  },[cacheKey,view,review,tab]);

  const available=internalTransferAvailable(item)&&!currentHandling(item).officialWaiting;
  if(!available)return null;
  const act=async(fn:()=>Promise<TransferView>)=>{const startedScope=scope.current;setBusy(true);setError('');try{const next=await fn();if(scope.current===startedScope&&next.profileKey===profileKey&&next.caseId===item.id&&next.processId===processId){setView(next);setReview(structuredClone(next.review));}}catch(e){if(scope.current===startedScope)setError((e as Error).message);}finally{if(scope.current===startedScope)setBusy(false);}};
  const patch=(v:Partial<TransferReview>)=>setReview(r=>r?{...r,...v}:r);
  const form=(v:Partial<TransferForm>)=>setReview(r=>r?{...r,form:{...r.form,...v}}:r);
  const locked=busy||view?.phase!=='draft'||view?.canEditRemote===false;
  const roles:TransferFileRole[]=view?.route==='application'?['application']:['baseline','application',...(view?.route==='reply'?['reply' as const]:[])];
  const roleName={baseline:'修改前申请文件（比对用，可选）',application:view?.route==='application'?'完整申请文件':'本次修改后的申请文件（有修改时）',reply:'意见陈述书 Word'};
  const step=view?.steps.find(s=>s.id===review?.stepId),user=step?.users.find(u=>u.id===review?.userId);
  return <section className="internal-transfer"><div className="section-heading"><div><h3>{view?.sourceMode==='local'?'本地文件提交':'提交到下一内部流程'}</h3><p className="section-copy">整理本次材料、核对业务表单，再转交下一办理人。</p></div>{view?<button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.refresh(profileKey,view.id))}><RefreshCw size={15}/>刷新回读</button>:<div className="button-row"><button className="primary" disabled={busy} onClick={()=>void act(()=>desktop!.transfer.prepare(profileKey,item.id,'workbench'))}>使用工作台稿件<ArrowRight size={15}/></button><button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.prepare(profileKey,item.id,'local'))}>本地文件提交</button></div>}</div>
    {!view&&<p className="note"><strong>推荐方案</strong>：使用工作台已完成起草与定稿的成果直接生成提交文件。如果你已在外部完成撰写、答复或补正，也可选择“本地文件提交”直接导入本地 DOCX 文件。</p>}{error&&<p className="inline-warning" role="alert">{error}</p>}
    {view&&review&&<>
      {view.phase==='draft'&&<div className="button-row"><button disabled={busy} onClick={()=>{transferCache.delete(cacheKey);setView(undefined);setReview(undefined);setTab(0);}}>更换文件来源</button>{view.sourceMode==='workbench'&&<button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.reprepare(profileKey,view.id))}>重新获取工作台稿件</button>}</div>}
      <p className="note">{view.sourceMode==='local'?'本地文件方案：仅使用你选择的本次文件，补正内容由你填写。':'工作台稿件方案：自动获取可用稿件并生成提交副本，请确认版本和文件；也可手动选择文件。'}</p><div className="transfer-context"><b>{view.caseNumber}</b><span>{view.processName}</span><span>当前：{view.currentNode||(view.phase==='uncertain'?'实例状态待核验':'未创建递交实例')}{view.currentUser&&` · ${view.currentUser}`}</span></div>
      {view.existingFileNames.length>0&&<div className={`transfer-existing-box${view.phase==='saved'?' is-saved':' is-draft'}`}>
        <div className="transfer-existing-header">
          <span>贝思兰德远端当前已有材料 · {view.existingFileNames.length} 件</span>
          <span className={`transfer-existing-badge${view.phase==='saved'?'':' is-draft'}`}>{view.phase==='saved'?'服务端已保存就绪':'实例已有文件'}</span>
        </div>
        <div className="transfer-file-chips">
          {view.existingFileNames.map((n,i)=><span className="transfer-file-chip" key={i}><FileText size={12}/>{n}</span>)}
        </div>
        {view.phase==='saved'&&<p className="muted">上述材料已在贝思兰德递交实例落盘保存，无需重复上传。核对表单与下一办理人后即可直接转交。</p>}
      </div>}
      {view.sourceDraft&&<div className="transfer-source-confirm"><p>自动获取：{view.sourceDraft.pending?'最新待采用稿':'当前采用稿'}{view.sourceDraft.at?` · ${new Date(view.sourceDraft.at).toLocaleString('zh-CN')}`:''} · 版本 {view.sourceDraft.id.slice(0,8)}</p><label className="checkbox"><input type="checkbox" disabled={locked} checked={review.confirmedDraftId===view.sourceDraft.id} onChange={e=>patch({confirmedDraftId:e.target.checked?view.sourceDraft!.id:undefined})}/>确认本次提交使用此版本（不会自动采用或覆盖工作稿）</label></div>}
      {view.error&&<p role="alert" className="inline-warning">{view.error}</p>}
      {view.results.length>0&&<ol className="transfer-results">{view.results.map((s,i)=><li key={i}>{s}</li>)}</ol>}
      {(view.phase==='uncertain'||view.phase==='saved')&&<button disabled={busy} onClick={()=>void act(()=>desktop!.transfer.reprepare(profileKey,view.id))}>读取最新状态，重新核对本次方案</button>}
      {!view.handId?<Note>{view.phase==='uncertain'?'启动结果尚未确认，请先刷新或读取最新状态核对。':'当前没有递交实例。核对案件后，可启动本次内部递交流程。'}<button disabled={busy||view.phase!=='draft'} onClick={()=>setConfirm('start')}>启动递交实例</button></Note>:<>
        {view.canEditRemote===false&&<Note>贝思兰德当前未授权本账号编辑此节点。可查看材料与流程，保存和转交暂不可用。</Note>}<nav className="surface-switch">{['本次材料','业务表单','下一办理人与结果'].map((name,i)=><button key={name} className={tab===i?'active':''} onClick={()=>setTab(i)}>{i+1} · {name}</button>)}</nav>
        {tab===0&&<>
          {view.existingFileNames.length>0&&<div className="note"><strong>远端材料已就绪</strong>：贝思兰德当前已存在上述 {view.existingFileNames.length} 个文件。下方本地文件仅在需要修改或补充时选择。</div>}
          <div className="transfer-files">{roles.map(role=><div key={role}><FileText size={20}/><span><b>{roleName[role]}</b><small>{view.files.find(f=>f.role===role)?.name||(role==='application'&&view.route!=='application'?'本次未修改申请文件时可不选':'尚未选择')}</small></span><button disabled={locked} onClick={()=>void act(()=>desktop!.transfer.pickFile(profileKey,view.id,role))}><Upload size={14}/>选择文件</button></div>)}</div>
          <p className="muted">修改前文件仅供比对，不上传；修改后文件仅在本次修改申请内容时需要，保存时提取勾选部分；意见陈述书是本次答复正文。文件复制到本案目录，原件和历史稿保留。</p>
          {view.parts.length>0&&<><h4>本次五书保留范围</h4><div className="transfer-parts">{view.parts.map(p=><div key={p.code}><label><input type="checkbox" disabled={locked||view.route==='application'||p.available===false} checked={review.keepCodes.includes(p.code)} onChange={e=>patch({keepCodes:e.target.checked?[...review.keepCodes,p.code]:review.keepCodes.filter(c=>c!==p.code)})}/><b>{p.name}</b><span className={p.changed===null?'text-warning':'muted'}>{view.route==='application'?'申请材料':p.changed===null?'待人工核对':p.changed?'发现变化':'未发现变化'}</span></label><p>{view.route==='application'?'本次完整申请保留此部分。':p.reason}</p>{view.route!=='application'&&(p.before||p.after)&&<details><summary>比较文字</summary><div className="transfer-comparison"><div><b>基线</b><pre>{p.before||'未识别正文'}</pre></div><div><b>本次</b><pre>{p.after||'未识别正文'}</pre></div></div></details>}</div>)}</div>{view.route!=='application'&&<Note>保存后，本次递交列表只保留勾选的五书部分；未勾选部分及完整混合申请文件会从当前递交实例移除。</Note>}</>}
          <button disabled={!!view.sourceDraft&&review.confirmedDraftId!==view.sourceDraft.id} onClick={()=>setTab(1)}>继续核对表单<ArrowRight size={15}/></button>
        </>}
        {tab===1&&<div className="transfer-form"><label className="field">指定摘要附图（默认图 1）<input disabled={locked} value={review.form.abstractFigure} onChange={e=>form({abstractFigure:e.target.value})}/></label><h4>{view.route==='reply'?'意见陈述书':view.route==='correction'?'补正内容':'提出申请请求书'}</h4>
          {view.route==='reply'&&<><label className="checkbox"><input type="radio" checked readOnly/>针对通知书陈述意见（已选择）</label><p className="muted">保存前自动核验意见陈述书表单已选中；以下字段来自本次通知书，请核对。</p><div className="form-grid"><label className="field">通知书发文日期<input type="date" disabled={locked} value={review.form.noticeDate} onChange={e=>form({noticeDate:e.target.value})}/></label><label className="field">通知书名称<input disabled={locked} value={review.form.noticeName} onChange={e=>form({noticeName:e.target.value})}/></label><label className="field">发文序号<input disabled={locked} value={review.form.noticeNo} onChange={e=>form({noticeNo:e.target.value})}/></label></div></>}
          {view.route==='reply'&&<><label className="checkbox"><input type="checkbox" disabled={locked} checked={review.form.otherProof} onChange={e=>form({otherProof:e.target.checked})}/>使用其他证明文件</label><label className="checkbox"><input type="checkbox" disabled={locked} checked={review.form.experimentData} onChange={e=>form({experimentData:e.target.checked})}/>本次补交实验数据</label></>}
          {view.route==='correction'&&<><p className="muted">请填写文件名称、具体位置、补正前和补正后，核对后保存到贝思兰德补正表。</p>{review.form.corrections.map((row,index)=><div className="correction-row" key={row.ChangeId}><div className="section-heading"><b>条目 {index+1}</b><button disabled={locked} onClick={()=>form({corrections:review.form.corrections.filter(r=>r.ChangeId!==row.ChangeId)})}>移除条目</button></div>{(['FileName','PositionInFile','CorrectionBefore','CorrectionAfter'] as const).map(key=><label className="field" key={key}>{{FileName:'文件名称',PositionInFile:'具体位置',CorrectionBefore:'补正前',CorrectionAfter:'补正后'}[key]}{key==='FileName'?<select disabled={locked} value={row[key]} onChange={e=>form({corrections:review.form.corrections.map(r=>r.ChangeId===row.ChangeId?{...r,[key]:e.target.value}:r)})}>{[...FIVE_PARTS.map(p=>p.name),'核苷酸或氨基酸序列表','其他',...(review.form.correctionReason===2?['请求书','授权委托书','主体资格证明']:[])].map(n=><option key={n}>{n}</option>)}</select>:<textarea disabled={locked} rows={key==='PositionInFile'?2:4} value={row[key]} onChange={e=>form({corrections:review.form.corrections.map(r=>r.ChangeId===row.ChangeId?{...r,[key]:e.target.value}:r)})}/>}</label>)}</div>)}<button disabled={locked} onClick={()=>form({corrections:[...review.form.corrections,{ChangeId:crypto.randomUUID(),Sort:review.form.corrections.length,FileName:'权利要求书',PositionInFile:'',CorrectionBefore:'',CorrectionAfter:''}]})}>增加补正条目</button></>}
          {view.route==='application'&&<>{Object.entries(declarations).map(([key,label])=><label className="checkbox" key={key}><input type="checkbox" disabled={locked} checked={review.form.declarations[key]||false} onChange={e=>form({declarations:{...review.form.declarations,[key]:e.target.checked}})}/>{label}</label>)}<Note>已有请求书的其他字段与记录编号会保留；请在贝思兰德核对申请人、发明人等案件基本信息。</Note></>}
          <button onClick={()=>setTab(2)}>继续选择下一办理人<ArrowRight size={15}/></button>
        </div>}
        {tab===2&&<><div className="form-grid"><label className="field">下一流程<select disabled={locked} value={review.stepId} onChange={e=>patch({stepId:e.target.value,userId:''})}><option value="">选择流程</option>{view.steps.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field">下一办理人<select disabled={locked} value={review.userId} onChange={e=>patch({userId:e.target.value})}><option value="">选择办理人</option>{step?.users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label></div><label className="field">转交备注<textarea disabled={locked} maxLength={1000} value={review.remark} onChange={e=>patch({remark:e.target.value})}/></label>
          {view.existingFileNames.length>0&&<details><summary>贝思兰德当前递交材料 · {view.existingFileNames.length}</summary><ul>{view.existingFileNames.map((n,i)=><li key={i}>{n}</li>)}</ul></details>}
          <div className="action-bar"><span>{view.phase==='submitted'?'内部转交已确认':view.phase==='saved'?'文件与表单保存已核验':view.phase==='uncertain'?'结果待核对，请先刷新':'请核对文件、表单和接收人'}</span>{view.phase==='draft'?<button className="primary" disabled={locked||!user||!!view.sourceDraft&&review.confirmedDraftId!==view.sourceDraft.id} onClick={()=>setConfirm('save')}>核对并保存材料</button>:view.phase==='saved'?<button className="primary" disabled={busy||view.canEditRemote===false} onClick={()=>setConfirm('submit')}>转交给 {user?.name}</button>:null}</div>
        </>}
      </>}
      {confirm&&<Modal title={confirm==='save'?'确认保存本次递交材料':confirm==='submit'?'确认内部转交':'确认启动递交实例'} onClose={()=>setConfirm(undefined)}><p><b>{view.caseNumber} · {view.caseTitle}</b></p><p>{view.processName} → {step?.name||'本次内部递交流程'}{user&&` · ${user.name}`}</p>{confirm==='save'&&<><p>保留：{review.keepCodes.map(c=>FIVE_PARTS.find(p=>p.code===c)?.name).join('、')||'本次未选择五书修改部分'}{view.route==='reply'?'；意见陈述书 Word':''}{view.route==='correction'?'；结构化补正书':''}</p>{view.parts.length>0&&view.route!=='application'&&<p>从本次递交列表移除：完整混合申请文件、{FIVE_PARTS.filter(p=>!review.keepCodes.includes(p.code)).map(p=>p.name).join('、')||'无其他部分'}。本地及历史文件保留。</p>}</>}<p>{confirm==='submit'?'将已核验材料转交上述内部办理人；后续官方递交由接收人办理。':'请确认上述案件、材料范围及表单内容准确。'}</p><div className="action-bar"><button onClick={()=>setConfirm(undefined)}>返回核对</button><button className="primary" disabled={busy} onClick={()=>{const action=confirm;setConfirm(undefined);setTab(2);void act(async()=>{if(action==='submit')transferCache.delete(cacheKey);return action==='save'?desktop!.transfer.save(profileKey,view.id,review):action==='submit'?desktop!.transfer.submit(profileKey,view.id):desktop!.transfer.startHand(profileKey,view.id);});}}>确认{confirm==='save'?'保存':confirm==='submit'?'内部转交':'启动'}</button></div></Modal>}
    </>}
  </section>;
}
