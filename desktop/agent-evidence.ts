import type { ArtifactQuality, CitationCheck, EvidencePolicy, EvidenceRange, EvidenceUnit, MaterialCoverage, ReadEvidence } from '../src/domain/agent-evidence.ts';
import { isNoticeMaterial, mergeEvidenceRanges, missingEvidenceRanges } from '../src/domain/agent-evidence.ts';

export type EvidenceSource = { id: string; name: string; hash: string; role: string };
export type ReadObservation = ReadEvidence & { chunks: Array<EvidenceRange & { text: string }> };
const normalize = (text: string) => text.normalize('NFC').replace(/\s+/gu,'');
const record = (value: unknown): Record<string,unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
const unitLabel = (unit: EvidenceUnit) => unit === 'page' ? '页' : unit === 'image' ? '图' : '行';
const readHint = (materialId: string, start?: number, end?: number) => {
  const tool = materialId === 'current-draft' ? 'read_draft' : 'read_material';
  const args = materialId === 'current-draft' ? [] : ['materialId=' + materialId];
  if (start !== undefined) args.push('startLine=' + start);
  if (end !== undefined) args.push('endLine=' + end);
  return tool + '(' + args.join(', ') + ')';
};

/** Text stays within the task broker; the public report contains only claimed quotes. */
export class EvidenceLedger {
  private observations = new Map<string,ReadObservation[]>();
  private sources: EvidenceSource[];
  private policy: EvidencePolicy;
  constructor(sources: EvidenceSource[], policy: EvidencePolicy = {formal:false}) { this.sources=sources; this.policy=policy; }
  observe(source: EvidenceSource, observation?: ReadObservation): ReadEvidence {
    const read: ReadObservation = observation && observation.hash === source.hash && observation.materialId === source.id
      ? structuredClone(observation)
      : {materialId:source.id,hash:source.hash,unit:'unknown',start:0,end:0,mode:'unknown',completeUnits:false,chunks:[]};
    const previous=this.observations.get(source.id) ?? [];
    // Repeated reads do not inflate coverage or memory use.
    const key=JSON.stringify([read.hash,read.unit,read.start,read.end,read.mode,read.completeUnits]);
    const index=previous.findIndex(r=>JSON.stringify([r.hash,r.unit,r.start,r.end,r.mode,r.completeUnits])===key);
    if(index<0)previous.push(read);else previous[index]=read;
    this.observations.set(source.id,previous);
    const {chunks,...evidence}=read; return evidence;
  }
  coverage(): MaterialCoverage[] {
    return this.sources.map(source=>{
      const observations=this.observations.get(source.id) ?? [];
      const known=observations.filter(r=>r.mode!=='derived' && r.unit!=='unknown');
      const unit=known[0]?.unit ?? 'unknown';
      const compatible=known.filter(r=>r.unit===unit);
      const totals=compatible.map(r=>r.total).filter((n):n is number=>Number.isSafeInteger(n) && n!>0);
      const total=totals.length?Math.max(...totals):undefined;
      const ranges=mergeEvidenceRanges(compatible.filter(r=>r.completeUnits).map(r=>({start:r.start,end:r.end})));
      const missing=total?missingEvidenceRanges(ranges,total):[];
      return {materialId:source.id,name:source.name,hash:source.hash,unit,total,ranges,missing,
        status:!observations.length?'unread':!total?'unknown':missing.length?'partial':'complete',
        visual:observations.some(r=>r.mode==='visual'),derived:observations.some(r=>r.mode==='derived'),
        required:!!this.policy.noticeCoverage && isNoticeMaterial(source.role)};
    });
  }
  inspect(raw?: unknown): ArtifactQuality {
    const result:ArtifactQuality={schema:1,materials:this.coverage(),citations:[],issues:[]};
    const issue=(code:string,severity:'error'|'warning',message:string,materialId?:string,citationId?:string)=>result.issues.push({code,severity,message,materialId,citationId});
    if(this.policy.formal) for(const material of result.materials){
      if(material.status==='unread') issue('MATERIAL_UNREAD','error',`请先 ${readHint(material.materialId)} 读取 ${material.name}。`,material.materialId);
      else if(material.required && material.status==='partial'){
        const gap=material.missing[0];
        issue('NOTICE_INCOMPLETE','error',`当前通知 ${material.name} 尚缺第 ${gap.start}-${gap.end} ${unitLabel(material.unit)}，请 ${readHint(material.materialId,gap.start,gap.end)} 续读后重新保存。`,material.materialId);
      }else if(material.status==='partial') issue('REFERENCE_PARTIAL','warning',`${material.name} 仅覆盖所列范围；其余范围不代表已经核对。`,material.materialId);
      else if(material.status==='unknown') issue('COVERAGE_UNKNOWN','warning',`${material.name} 已有读取记录，但覆盖范围不能自动确认。`,material.materialId);
      if(material.visual) issue('VISUAL_REVIEW','warning',`${material.name} 含已返回页图；图中文字和解释需视觉核对，未标记为文字匹配通过。`,material.materialId);
      if(material.derived) issue('DECLARED_CONVERSION','warning',`${material.name} 含模型声明关联的转换结果，原件与转换结果的一致性待核对。`,material.materialId);
    }
    const artifact=record(raw);
    if(!artifact)return result;
    const citations=artifact.evidenceCitations;
    if(citations===undefined || Array.isArray(citations)&&!citations.length){
      if(this.policy.formal)issue('CITATIONS_NOT_STRUCTURED','warning','未提供结构化原文引用，文字依据仍须人工核对；不阻止办理。');
    }else if(!Array.isArray(citations) || citations.length>200){
      issue('CITATION_FORMAT','error','evidenceCitations 必须是最多 200 项的引用列表；无引用时可以省略或使用空列表。');
    }else{
      const ids=new Set<string>();
      for(const value of citations){
        const c=record(value);
        if(!c || typeof c.id!=='string'||!c.id.trim()||c.id.length>120||ids.has(c.id) || typeof c.materialId!=='string'||typeof c.hash!=='string'||!['line','page','image'].includes(String(c.unit))||!Number.isSafeInteger(c.start)||!Number.isSafeInteger(c.end)||Number(c.start)<1||Number(c.end)<Number(c.start)||c.quote!==undefined&&(typeof c.quote!=='string'||c.quote.length>8000)||c.target!==undefined&&(typeof c.target!=='string'||c.target.length>240)){
          issue('CITATION_FORMAT','error','引用需唯一 id、materialId、hash、unit、有效 start/end；quote 最多 8000 字、target 最多 240 字。');continue;
        }
        ids.add(c.id);
        const source=this.sources.find(s=>s.id===c.materialId);
        const checked:CitationCheck={id:c.id,materialId:c.materialId,name:source?.name,unit:c.unit as EvidenceUnit,start:Number(c.start),end:Number(c.end),quote:c.quote as string|undefined,target:c.target as string|undefined,status:'unverified',detail:''};
        result.citations.push(checked);
        const invalid=(code:string,message:string)=>{checked.status='invalid';checked.detail=message;issue(code,'error',message,c.materialId as string,c.id as string);};
        if(!source){invalid('CITATION_SOURCE',`引用 ${c.id} 的材料不在本次冻结清单；请使用 read_material 返回的 materialId。`);continue;}
        if(c.hash!==source.hash){invalid('CITATION_VERSION',`引用 ${c.id} 不是 ${source.name} 的本次冻结版本，请核对 hash。`);continue;}
        const observations=(this.observations.get(source.id)??[]).filter(r=>r.unit===c.unit && r.mode!=='derived' && r.mode!=='unknown');
        const total=observations.find(r=>r.total!==undefined)?.total;
        if(total!==undefined && Number(c.end)>total){invalid('CITATION_RANGE',`引用 ${c.id} 超过 ${source.name} 的 ${total} ${unitLabel(c.unit as EvidenceUnit)}。`);continue;}
        const inRange=observations.filter(r=>r.completeUnits && r.end>=Number(c.start) && r.start<=Number(c.end));
        const ranges=mergeEvidenceRanges(inRange.map(r=>({start:r.start,end:r.end})));
        if(!ranges.some(r=>r.start<=Number(c.start)&&r.end>=Number(c.end))){
          if((this.observations.get(source.id)??[]).some(r=>r.mode==='derived')){checked.detail='仅有声明关联的转换来源，需与原件核对。';issue('CITATION_UNVERIFIED','warning',`引用 ${c.id}：${checked.detail}`,source.id,c.id);continue;}
          invalid('CITATION_UNREAD',`引用 ${c.id} 所在范围尚未读取，请 ${readHint(source.id,Number(c.start),Number(c.end))} 后重试。`);continue;
        }
        const textReads=inRange.filter(r=>r.mode==='text');
        const textRanges=mergeEvidenceRanges(textReads.map(r=>({start:r.start,end:r.end})));
        if(!textRanges.some(r=>r.start<=Number(c.start)&&r.end>=Number(c.end))){checked.status='visual';checked.detail='已返回原始页图，文字引用仍需视觉核对。';issue('CITATION_VISUAL','warning',`引用 ${c.id}：${checked.detail}`,source.id,c.id);continue;}
        if(typeof c.quote!=='string'||!c.quote.trim()){checked.detail='范围与版本已核对，未提供原文片段。';issue('CITATION_NO_QUOTE','warning',`引用 ${c.id}：${checked.detail}`,source.id,c.id);continue;}
        // Slice to the claimed location; never validate against unrelated pages or metadata.
        const units=new Map<number,string>();
        for(const read of textReads)for(const chunk of read.chunks){
          if(c.unit==='line')chunk.text.split('\n').forEach((line,index)=>{const unit=chunk.start+index;if(unit>=Number(c.start)&&unit<=Number(c.end))units.set(unit,line);});
          else if(chunk.start===chunk.end&&chunk.start>=Number(c.start)&&chunk.end<=Number(c.end))units.set(chunk.start,chunk.text);
        }
        const text=[...units].sort(([a],[b])=>a-b).map(([,text])=>text).join('\n');
        if(!normalize(text).includes(normalize(c.quote))){invalid('CITATION_QUOTE',`引用 ${c.id} 的原文片段与已读范围不符；请核对准确原文，不要把释义写成逐字引用。`);continue;}
        checked.status='verified';checked.detail='冻结版本、读取范围与原文片段匹配；未判断论证是否成立。';
      }
    }
    const opinions=this.policy.opinionIds??[];
    if(opinions.length){
      const mapping=artifact.opinionResponses;
      if(mapping===undefined)issue('OPINIONS_UNMAPPED','warning',`尚未逐项标记 ${opinions.length} 项通知意见的回应位置，请核对遗漏；不阻止办理。`);
      else if(!Array.isArray(mapping)||mapping.length>200)issue('RESPONSE_FORMAT','error','opinionResponses 应为最多 200 项的 {opinionId,response,citationIds?} 列表。');
      else{
        const covered=new Set<string>();
        for(const value of mapping){const item=record(value);
          if(!item||typeof item.opinionId!=='string'||!opinions.includes(item.opinionId)||covered.has(item.opinionId)||typeof item.response!=='string'||!item.response.trim()||item.response.length>8000||item.citationIds!==undefined&&(!Array.isArray(item.citationIds)||item.citationIds.some(id=>typeof id!=='string'||!result.citations.some(c=>c.id===id)))){issue('RESPONSE_FORMAT','error','意见回应需有效且不重复的 opinionId、非空 response；citationIds 只能引用本产物的引用编号。');continue;}
          covered.add(item.opinionId);
        }
        const missing=opinions.filter(id=>!covered.has(id));if(missing.length)issue('OPINIONS_UNMAPPED','warning',`待核对未标记回应的意见：${missing.join('、')}。`);
      }
    }
    return result;
  }
}
