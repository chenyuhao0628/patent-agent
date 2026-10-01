import type { ArtifactQuality } from './agent-evidence.ts';

export type TaskContract = { kind: 'analysis'|'discuss'|'draft'|'revise'|'review'|'writing'; professional?: boolean; phase?: number; strategyId?: string; draftVersionId?: string };
export type RecoveryFile = { relativePath: string; hash: string; bytes: number; state: 'saved'|'reused'|'changed'|'missing'; };
export type OperationReceipt = { id: string; name: string; state: 'started'|'finished'; success?: boolean };
export type TaskProgress = {
  schema: 1; saved: Array<{id:string;label:string}>; pending: Array<{id:string;label:string}>;
  accepted: boolean; problem?: string; warnings: number; opinions: number;
  checkpoint?: { relativePath: string; hash: string };
  recovery?: { status: 'none'|'restored'|'legacy'|'unavailable'; note?:string; files: RecoveryFile[]; operations: OperationReceipt[] };
  metrics: { completed: string[]; errors: number; requiredReadUnits: number };
};
const filled=(v:unknown)=>typeof v==='string'&&!!v.trim();
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const rows=(v:unknown,keys:string[],minimum:number)=>Array.isArray(v)&&v.length>=minimum&&v.every(row=>keys.every(key=>filled(object(row)[key])));

/** Describes the existing artifact contract; this is not a new acceptance gate. */
export function taskProgress(value:Record<string,unknown>,contract:TaskContract|undefined,quality:ArtifactQuality,accepted=false,problem?:string):TaskProgress {
  const saved:TaskProgress['saved']=[],pending:TaskProgress['pending']=[];
  const add=(id:string,label:string,valid:boolean)=> (valid?saved:pending).push({id,label});
  if(contract){
    add('kind','任务类型',value.kind===contract.kind);
    if(contract.professional){
      add('text',contract.kind==='review'?'独立审查报告':'本阶段正文',filled(value.text)&&String(value.text).length<=400000);
      if(contract.kind==='writing'&&contract.phase===4){
        const docs=object(value.documents);
        for(const [key,label] of [['ABSTRACT','摘要'],['ABSTRACT_IMAGE','摘要附图说明'],['CLAIMS','权利要求书'],['DESCRIPTION','说明书'],['DRAWINGS','附图清单']])add('documents.'+key,label,['ABSTRACT_IMAGE','DRAWINGS'].includes(key)?typeof docs[key]==='string':filled(docs[key]));
      }
    }else if(contract.kind==='analysis'){
      add('opinions','通知意见拆解',rows(value.opinions,['id','title','summary','basis'],1));
      add('strategies','可选策略',rows(value.strategies,['id','title','summary','benefits','risks','basis'],2));
    }else if(contract.kind==='discuss')add('reply','讨论回复',filled(value.reply));
    else if(contract.kind==='review'){
      add('draftVersionId','冻结稿件版本',filled(value.draftVersionId)&&(!contract.draftVersionId||value.draftVersionId===contract.draftVersionId));
      add('summary','复核摘要',filled(value.summary));
      add('issues','复核问题清单',rows(value.issues,['id','finding','basis','suggestion'],0)&&Array.isArray(value.issues)&&value.issues.every(i=>['error','warning','info'].includes(String(object(i).severity))));
    }else{
      for(const [key,label] of [['body','答复正文'],['amendmentText','建议修改文本'],['amendmentBasis','修改依据'],['reviewNotes','内部复核说明']])add(key,label,filled(value[key]));
      add('strategyId','已选策略',filled(value.strategyId)&&(!contract.strategyId||value.strategyId===contract.strategyId));
    }
  }
  const errors=quality.issues.filter(i=>i.severity==='error').length;
  const requiredReadUnits=quality.materials.filter(m=>m.required).reduce((sum,m)=>sum+m.ranges.reduce((n,r)=>n+r.end-r.start+1,0),0);
  return {schema:1,saved,pending,accepted,problem,warnings:quality.issues.filter(i=>i.severity==='warning').length,
    opinions:rows(value.opinions,['id','title','summary','basis'],1)?(value.opinions as unknown[]).length:0,
    metrics:{completed:saved.map(s=>s.id),errors:errors+(problem?1:0)+pending.length,requiredReadUnits}};
}

/** Count improvements against all-time bests, never changes in prose or oscillating fields. */
export class RepairProgressTracker {
  private seen=new Set<string>(); private bestErrors=Infinity; private bestRead=-1; private started=false; private stalled=0;
  observe(progress:Pick<TaskProgress,'metrics'>):number {
    const m=progress.metrics;
    const better=m.completed.some(key=>!this.seen.has(key))||m.errors<this.bestErrors||m.requiredReadUnits>this.bestRead;
    this.stalled=this.started&&!better?this.stalled+1:0;this.started=true;
    m.completed.forEach(key=>this.seen.add(key));this.bestErrors=Math.min(this.bestErrors,m.errors);this.bestRead=Math.max(this.bestRead,m.requiredReadUnits);
    return this.stalled;
  }
}
