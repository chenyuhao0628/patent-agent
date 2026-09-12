import type { Case } from './workflow.ts';

export type ApplicationDocument = { id: string; title: string; text: string };
export type ApplicationVersion = { id: string; at: string; documents: ApplicationDocument[] };
export type WritingStage = 'disclosure' | 'research' | 'strategy' | 'draft' | 'review' | 'final';
export type Writing = {
  stage: WritingStage; disclosure: string; researchQuery: string; researched: boolean;
  strategy: string; documents: ApplicationDocument[]; versions: ApplicationVersion[]; finalVersionId: string | null; finalHistory: string[];
};
export type ReviewIssue = {
  id: string; title: string; category: string; documentId: string; quote: string; suggestion: string;
  disposition: 'open' | 'accepted' | 'deferred'; comment: string;
};
export type ApplicationReview = {
  id: string; source: 'writing' | 'case' | 'external'; versionId: string; versionLabel: string;
  documents: ApplicationDocument[]; issues: ReviewIssue[]; at: string; completed: boolean;
};
export type Transfer = {
  selected: string[]; applicant: string; process: string; receiver: string; note: string;
  receipts: { id: string; at: string; files: string[]; receiver: string; process: string; note: string }[];
};
export type CaseDesign = { writing: Writing; review: ApplicationReview | null; reviewHistory: ApplicationReview[]; transfer: Transfer };

export const writingStages: {id: WritingStage; label: string}[] = [
  {id:'disclosure',label:'技术交底'},{id:'research',label:'必要检索'},{id:'strategy',label:'方案讨论'},
  {id:'draft',label:'申请文件'},{id:'review',label:'独立审查'},{id:'final',label:'修改定稿'},
];
export function initialDesign(): CaseDesign {
  return {writing:{stage:'disclosure',disclosure:'',researchQuery:'',researched:false,strategy:'',documents:[],versions:[],finalVersionId:null,finalHistory:[]},review:null,reviewHistory:[],
    transfer:{selected:[],applicant:'示例申请人',process:'答复文件内部核稿',receiver:'',note:'',receipts:[]}};
}
export function sampleDocuments(title: string): ApplicationDocument[] {
  return [
    {id:'claims',title:'权利要求书',text:`1. ${title}，包括检测单元、控制模块和执行机构；所述控制模块根据检测结果调整执行机构的工作状态。\n\n2. 根据权利要求1所述的装置，其特征在于，所述检测单元与控制模块通信连接。\n\n3. 根据权利要求1所述的装置，其特征在于，所述执行机构接收控制模块输出的控制信号。\n\n【虚构示例】本稿仅供界面交互，不用于真实申请。`},
    {id:'description',title:'说明书',text:`${title}\n\n技术领域\n本示例涉及检测与控制装置。\n\n背景技术\n现有装置的检测结果与执行过程之间需要建立明确的配合关系。\n\n技术方案\n装置包括检测单元、控制模块和执行机构。控制器根据检测结果调整执行机构的工作状态。具体参数由原始技术交底确认。\n\n具体实施方式\n检测单元取得检测结果，并将其发送至控制模块；控制模块输出控制信号。\n\n【虚构示例】未进行真实检索或技术评价。`},
    {id:'abstract',title:'说明书摘要',text:`本示例涉及${title}。装置包括检测单元、控制模块和执行机构，通过检测结果与控制过程的配合调整工作状态。\n\n【虚构示例】摘要应随实际确认的申请文件共同修订。`},
    {id:'figures',title:'附图与标记',text:'图1：装置结构示意图（示例目录，未生成真实附图）。\n\n10 检测单元\n20 控制模块\n30 执行机构\n\n需在正式交付前核对实际附图、标记及说明书中的引用。'},
  ];
}
export function isWritingSaved(w: Writing) {
  const latest=w.versions.at(-1);
  return !!latest && JSON.stringify(latest.documents)===JSON.stringify(w.documents);
}
export function saveWriting(w: Writing): Writing {
  if (!w.documents.length || isWritingSaved(w)) return w;
  return {...w,versions:[...w.versions,{id:crypto.randomUUID(),at:new Date().toISOString(),documents:structuredClone(w.documents)}]};
}
export function makeReview(source: ApplicationReview['source'], versionId: string, versionLabel: string, documents: ApplicationDocument[]): ApplicationReview {
  const first=documents[0];
  const description=documents.find(d=>d.id==='description')??first;
  const figures=documents.find(d=>d.id==='figures')??first;
  const quote=(doc:ApplicationDocument)=>doc.text.split('\n').find(p=>p.trim())??doc.title;
  return {id:crypto.randomUUID(),source,versionId,versionLabel,documents:structuredClone(documents),at:new Date().toISOString(),completed:false,issues:[
    {id:'scope',title:'必要技术特征需结合交底核对',category:'保护范围',documentId:first.id,quote:quote(first),suggestion:'核对检测、控制和执行之间的配合关系，记录拟保留的必要特征及交底出处。本条为预设演示问题。',disposition:'open',comment:''},
    {id:'term',title:'控制模块与控制器的称谓需统一',category:'文本一致性',documentId:description.id,quote:description.text.includes('控制器')?'控制器根据检测结果调整执行机构的工作状态。':quote(description),suggestion:'如两者指向同一部件，统一术语；如含义不同，应分别说明。请回到原始技术交底确认。',disposition:'open',comment:''},
    {id:'figure',title:'附图标记与正文引用需核对',category:'文件完整性',documentId:figures.id,quote:quote(figures),suggestion:'核对实际附图是否齐全，并逐一检查标记与说明书引用。本原型没有生成真实附图。',disposition:'open',comment:''},
  ]};
}
export function reviewMatchesWriting(d: CaseDesign) {
  return !!d.review && d.review.source==='writing' && isWritingSaved(d.writing) && d.review.versionId===d.writing.versions.at(-1)?.id;
}
export function replaceReview(d: CaseDesign, review: ApplicationReview): CaseDesign {
  return {...d,review,reviewHistory:[...d.reviewHistory,...(d.review?[d.review]:[])]};
}
export function canFinalizeWriting(d: CaseDesign) {
  return reviewMatchesWriting(d) && d.review!.completed && d.review!.issues.every(i=>i.disposition!=='open');
}
export type ArtifactChoice = { id:string; title:string; detail:string; text:string };
export function artifactsFor(c:Case, d:CaseDesign):ArtifactChoice[] {
  const replies=c.rounds.flatMap(r=>[...r.finalHistory,...(r.final?[r.final]:[])].map(f=>({id:f.versionId,title:`${r.name} · 答复定稿`,detail:'答复文本快照 · 示例',text:f.text})));
  const versions=d.writing.versions.filter(v=>[...d.writing.finalHistory,d.writing.finalVersionId].includes(v.id));
  return [...replies,...versions.flatMap(v=>v.documents.map(doc=>({id:`${v.id}:${doc.id}`,title:doc.title,detail:`撰写定稿 · v${d.writing.versions.indexOf(v)+1} · 示例`,text:doc.text})))];
}
