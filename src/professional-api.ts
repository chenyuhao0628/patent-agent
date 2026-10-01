export const PROFESSIONAL_API_CONTRACT_VERSION = 1 as const;
export const PROFESSIONAL_WRITE_MESSAGE_MAX = 80_000;
export const PROFESSIONAL_DECISION_MAX = 20_000;
export { WRITING_PHASES } from './domain/professional-policy.ts';
export type { WritingPhase } from './domain/professional-policy.ts';
export type WorkFile={name:string;relativePath:string;hash?:string;role:string};
export type ReviewSource={reports?:ProfessionalJob[];supersededAt?:string;id:string;caseId:string;processKey:string;title:string;business:'申请'|'答复'|'补正';at:string;text:string;amendmentText?:string;correctionContents?:import('./domain/correction.ts').CorrectionContent[];applicationParts?:import('./domain/application-parts.ts').ApplicationParts;amendmentBasis?:string;files:WorkFile[]};
export type ProfessionalJob={progress?:import('./domain/task-progress.ts').TaskProgress;resumeFromRunId?:string;recovery?:{files:WorkFile[];contextHash:string};input?:string;memory?:import('./domain/task-memory.ts').TaskMemoryView;quality?:import('./domain/agent-evidence.ts').ArtifactQuality;id:string;caseId:string;processKey:string;kind:'writing'|'review';sourceId?:string;phase?:number;state:'running'|'completed'|'failed'|'stopped';at:string;endedAt?:string;error?:string;text?:string;documents?:Record<string,string>;tools:Array<{name:string;status:string;detail?:string}>;skillName:string;skillHash:string;artifactPath?:string;rawArtifactPath?:string;artifactHash?:string};
export type WritingConfirmation={jobId:string;phase:number;decision:string;at:string};
export type ProfessionalRecord={entry?:{phase:number;at:string};revision?:string;caseId:string;processKey:string;phase:number;confirmations:WritingConfirmation[];jobs:ProfessionalJob[];sources:ReviewSource[];completed:boolean;selectedMaterialIds?:string[]};
export type ReviewQueueItem={source:ReviewSource;caseTitle:string;caseNumber:string;archived:boolean;archiveReason?:string;report?:ProfessionalJob;reports?:ProfessionalJob[];running:boolean};
export type ProfessionalCaseView={writingContextHash?:string;profileKey:string;caseId:string;processKey:string;record:ProfessionalRecord;materials:Array<{id:string;name:string;role:string;ready:boolean;removable?:boolean;relativePath?:string}>;queue:ReviewQueueItem[];busy:boolean;partial?:string};
export type ProfessionalHistoryView={profileKey:string;caseId:string;sources:ReviewSource[];jobs:ProfessionalJob[]};
export type ProfessionalCommand={type:'start-at';phase:number}|{type:'resume';jobId:string}|{type:'write';message:string;materialIds:string[]}|{type:'confirm';jobId:string;decision:string}|{type:'restart';phase:number}|{type:'review';sourceId:string}|{type:'ready-manual'}|{type:'stop'};
export type ProfessionalAPI={previewDocument:(key:string,id:string,processKey:string,jobId:string)=>Promise<StageDocumentPreview>;pickReferences:(key:string,id:string)=>Promise<ProfessionalCaseView>;removeReference:(key:string,id:string,materialId:string)=>Promise<ProfessionalCaseView>;getCase:(key:string,id:string)=>Promise<ProfessionalCaseView>;history:(key:string,id:string)=>Promise<ProfessionalHistoryView>;listReviews:(key:string)=>Promise<ReviewQueueItem[]>;command:(key:string,id:string,cmd:ProfessionalCommand)=>Promise<ProfessionalCaseView>;pickFiles:(key:string,id:string)=>Promise<ProfessionalCaseView>;openFile:(key:string,id:string,relativePath:string)=>Promise<void>;onState:(callback:(key:string)=>void)=>()=>void};

export type WordInline={text:string;bold?:boolean;italic?:boolean;math?:boolean;image?:string};
export type WordBlock={kind:'paragraph';heading?:number;content:WordInline[]}|{kind:'table';rows:WordBlock[][][]};
export type StageDocumentPreview={jobId:string;processKey:string;relativePath:string;hash:string;blocks:WordBlock[]};
