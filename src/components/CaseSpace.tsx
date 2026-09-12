import { ProfessionalWork } from './ProfessionalWork.tsx';
import { useState } from 'react';
import { InternalTransfer } from './InternalTransfer.tsx';
import { CaseMetadata } from './CaseMetadata.tsx';
import { ChevronRight, Clock3, FileText, MoreHorizontal } from 'lucide-react';
import type { Action, Case } from '../domain/workflow.ts';
import { activeRound, currentWork, editableCurrent, workNames } from '../domain/lifecycle.ts';
import { currentHandling } from '../domain/handling.ts';
import { deadlineFieldLabel, deadlineFieldValue, deadlineView } from '../domain/deadlines.ts';
import { WritingWorkbench } from './WritingWorkbench.tsx';
import { ReviewWorkbench } from './ReviewWorkbench.tsx';
import { TransferWorkbench } from './TransferWorkbench.tsx';
import { artifactsFor, initialDesign, reviewMatchesWriting } from '../domain/designFlows.ts';
import { MaterialsView } from './MaterialsView.tsx';
import { Workspace } from './Workspace.tsx';
import { Modal, Note } from './Primitives.tsx';
import { CaseHistory, CurrentCase, RemoteFlow } from './CurrentCase.tsx';
import { agentProcessKey, desktop } from '../desktop.ts';

export const caseTabs={overview:'概览',materials:'材料',discussion:'本案对话',reply:'答复',write:'撰写',review:'审查',history:'办理历史',outputs:'成果',flow:'贝思兰德流程',submit:'提交'};
export type CaseTab=keyof typeof caseTabs;
export function CaseSpace({requestedRoundId,item,tab,navigate,dispatch,updateCase,profileKey}:{requestedRoundId?:string;item:Case;tab:CaseTab;navigate:(t:CaseTab)=>void;dispatch:(roundId:string,a:Action)=>void;updateCase:(patch:Partial<Case>)=>void|Promise<void>;profileKey?:string}){
  const current=currentWork(item),r=activeRound(item),design=item.design??initialDesign(),editable=editableCurrent(item),handling=currentHandling(item);
  const primary:CaseTab=current.kind==='correction'?'reply':['write','reply','review'].includes(current.kind)?current.kind as CaseTab:'overview';
  const childReview=current.kind==='write'&&design.review?.source==='writing';
  const allowed=tab===primary||tab==='review'&&childReview;
  const tabs:CaseTab[]=['overview','materials',...(desktop?['discussion' as CaseTab]:[]),...(primary!=='overview'&&!(desktop&&primary==='reply')?[primary]:[]),...(desktop&&primary!=='review'?['review' as CaseTab]:tab==='review'&&childReview?['review' as CaseTab]:[]),'history','outputs','flow','submit'];
  const [showInfo,setShowInfo]=useState(false),[preview,setPreview]=useState<string|null>(null);
  const updateDesign=(next:typeof design)=>{if(editable&&allowed)void updateCase({design:next});};
  const recentFiles=artifactsFor(item,design).slice(-3).reverse();
  return <div className={`case-space ${['reply','write','review','discussion'].includes(tab)?'focused-space':''}`}>
    <header className="case-intro"><span className="case-emblem"><FileText/></span><div><h1>{item.title}</h1><p>{item.number}<span>·</span>{item.type}{item.tags.map(t=><span className="tag" key={t}>{t}</span>)}</p></div><div className="case-header-actions"><button className="icon-button more" aria-label="案件管理操作" onClick={()=>setShowInfo(true)}><MoreHorizontal/></button></div></header>
    <nav className="case-tabs" aria-label="本案业务">{tabs.map(id=><button key={id} className={tab===id||desktop&&id==='discussion'&&tab==='reply'?'active':''} onClick={()=>navigate(id)}>{id==='discussion'?'本案对话':id==='reply'&&current.kind==='correction'?'补正':caseTabs[id]}</button>)}</nav>
    {tab==='overview'&&<div className="overview-grid"><div><h2>当前办理</h2><div className="current-work"><p>{handling.processName}</p><h3>{handling.node}</h3><p>{handling.status}</p><p>办理主体：{handling.party}{handling.handlerKind==='pending-undertaker'&&handling.handler?` · 待办承办人 ${handling.handler}`:handling.handlerKind==='flow-user'&&handling.handler?` · 当前办理人 ${handling.handler}`:handling.unverified?' · 待核验':''}</p><p>本案当前办理以实际流程节点为准；已结束的阶段在办理历史中查看。</p><div><span className="current-status"><Clock3 size={15}/>{item.source==='baseland'?'已关联贝思兰德':desktop?'本地案件':'设计示例'}</span>{primary!=='overview'&&<button className="primary" onClick={()=>navigate(primary)}>进入当前工作<ChevronRight size={17}/></button>}</div></div>
      {current.kind==='needs-confirmation'&&!desktop&&<div className="inline-warning"><h3>旧原型存在并行业务记录</h3><p>记录已保留，请按实际业务确认一个当前阶段；其余内容进入历史查看。</p><div className="button-row">{item.rounds.slice(0,1).map(round=><button key={round.id} onClick={()=>void updateCase({current:{kind:round.name.includes('补正')?'correction':'reply',roundId:round.id}})}>以{round.name}为当前</button>)}{design.writing.disclosure&&<button onClick={()=>void updateCase({current:{kind:'write'}})}>以撰写为当前</button>}</div></div>}
      <h2 className="business-heading">案件记录</h2><div className="business-links"><button onClick={()=>navigate('history')}><FileText/><span><b>办理历史与稿件版本</b><small>查看以往撰写、通知和答复记录</small></span><ChevronRight size={18}/></button><button onClick={()=>navigate('flow')}><Clock3/><span><b>贝思兰德流程</b><small>查看节点、办理人和流转情况</small></span><ChevronRight size={18}/></button></div></div><aside className="case-aside"><h2>案件信息</h2><dl><div><dt>公司名称</dt><dd>{item.companyName || '未提供'}</dd></div><div><dt>当前业务</dt><dd>{handling.processName}</dd></div><div><dt>当前办理节点</dt><dd>{handling.node}</dd></div><div><dt>{deadlineFieldLabel(item)}</dt><dd>{deadlineFieldValue(item)}</dd></div><div><dt>文件归属</dt><dd>本案独立目录</dd></div></dl><CaseMetadata item={item} profileKey={profileKey}/><h2>本案成果</h2>{desktop?<button className="recent-file" onClick={()=>navigate('outputs')}><FileText/><span>查看生成文件与定稿<small>按版本查看正文、修改文本和复核记录</small></span><ChevronRight size={16}/></button>:recentFiles.length?recentFiles.map(file=><button className="recent-file" key={file.id} onClick={()=>setPreview(`${file.title}\n${file.text}`)}><FileText/><span>{file.title}<small>{file.detail}</small></span></button>):<Note>确认的定稿成果将在这里显示。</Note>}</aside></div>}
    {tab==='materials'&&(desktop?<CurrentCase item={item} update={updateCase} materialsOnly profileKey={profileKey}/>:r?<MaterialsView key={r.id} item={{...item,rounds:[r]}} round={r} selectRound={()=>{}} change={next=>{if(editable)void updateCase({rounds:item.rounds.map(x=>x.id===r.id?next:x)});}}/>:<Note>当前阶段尚无通知书材料，可在办理历史中查看旧轮次。</Note>)}
    {(tab==='discussion'||tab==='reply')&&desktop&&profileKey&&<CurrentCase key={`${item.id}-discussion-${agentProcessKey(item)}`} item={item} update={updateCase} profileKey={profileKey} discussionOnly={primary!=='reply'}/>}
    {desktop&&profileKey&&(tab==='write'||tab==='review')&&<ProfessionalWork key={`${item.id}-${agentProcessKey(item)}-${tab}`} profileKey={profileKey} item={item} mode={tab==='write'?'writing':'review'} sourceId={requestedRoundId} navigate={navigate}/>}
    {['reply','write','review'].includes(tab)&&!desktop&&(allowed?(tab==='reply'&&r?<Workspace key={r.id} item={item} round={r} dispatch={a=>{if(editable)dispatch(r.id,a);}}/>:tab==='write'?<WritingWorkbench item={item} design={design} update={updateDesign} openReview={()=>navigate('review')} openMaterials={()=>navigate('materials')} openOutputs={()=>navigate('outputs')}/>:<ReviewWorkbench item={item} design={design} update={updateDesign} openWriting={()=>{if(current.kind==='write'){updateDesign({...design,writing:{...design.writing,stage:design.review?.completed&&reviewMatchesWriting(design)?'final':'draft'}});navigate('write');}}} openMaterials={()=>navigate('materials')}/>):<section className="business-workspace"><h2>本案当前为{current.label??workNames[current.kind]}</h2><Note>本案不能同时开启其他主业务。历史工作内容仍保留。</Note><button onClick={()=>navigate(primary)}>返回当前阶段</button></section>)}
    {tab==='history'&&<CaseHistory item={item}/>}
    {tab==='flow'&&<RemoteFlow item={item}/>}
    {tab==='submit'&&(desktop&&profileKey?<section className="business-workspace"><h2>提交</h2><p className="section-copy">核对本次材料、表单和下一办理人，保存后转交内部流程。个人 AI 审查为可选项。</p><InternalTransfer profileKey={profileKey} item={item}/></section>:<Note>请在桌面程序中使用贝思兰德内部提交。</Note>)}
    {tab==='outputs'&&(desktop&&profileKey?<CurrentCase item={item} update={updateCase} profileKey={profileKey} outputsOnly/>:<TransferWorkbench item={item} design={design} update={next=>{if(current.kind!=='needs-confirmation')void updateCase({design:next});}} openWriting={()=>navigate(primary)} openReply={()=>navigate(primary)}/>)}
    {showInfo&&<Modal title="案件管理" onClose={()=>setShowInfo(false)}><CaseForm item={item} save={patch=>{void updateCase(patch);setShowInfo(false);}}/></Modal>}
    {preview&&<Modal title="成果预览" onClose={()=>setPreview(null)}><pre className="text-preview">{preview}</pre></Modal>}
  </div>;
}
function CaseForm({ item, save }: { item: Case; save: (p: Partial<Case>) => void }) {
  const due=deadlineView(item);
  const [title, setTitle] = useState(item.title); const [tags, setTags] = useState(item.tags.join('，')); const [deadline, setDeadline] = useState(item.source==='baseland'?(due.raw??''):item.deadline);
  const fieldLabel=deadlineFieldLabel(item);
  return <form onSubmit={e => { e.preventDefault(); save({ title: title.trim(), deadline, tags: [...new Set(tags.split(/[,，]/).map(t => t.trim()).filter(Boolean))] }); }}><label className="field">案件名称<input required readOnly={!!desktop&&item.source==='baseland'} value={title} onChange={e => setTitle(e.target.value)}/></label><label className="field">{fieldLabel}{item.source==='baseland'&&!due.raw?<input readOnly value={deadlineFieldValue(item)}/>:<input readOnly={!!desktop&&item.source==='baseland'} type="date" value={deadline} onChange={e => setDeadline(e.target.value)}/>}</label>{!!desktop&&item.source==='baseland'&&<Note>案件名称与办理期限以同步结果为准；提出申请采用内部期限；其他业务官方期限优先于贝思兰德期限。</Note>}{!!desktop&&item.source==='local'&&<Note>本地案件使用自设日期，与官方期限和贝思兰德期限分开标记。</Note>}<label className="field">标签<input value={tags} onChange={e => setTags(e.target.value)} placeholder="以逗号分隔"/></label><div className="action-bar"><button type="button" onClick={() => save({ archived: !item.archived })}>{item.archived ? '取消归档' : '归档案件'}</button><button className="primary" disabled={!title.trim()}>保存修改</button></div></form>;
}
