import type { Case } from './workflow.ts';
import { currentWork } from './lifecycle.ts';

export type CaseAssociation = { sourceCaseId:string; remoteCaseId:string; linkedAt:string; localProcessKey:string; processId?:string };
export type CaseLinkCandidate = { id:string;number:string;title:string;remoteCaseId:string;processName:string;hasDraft:boolean };
export function linkCases(local:Case,remote:Case,at:string):{current:Case;history:Case}{
  if(local.id===remote.id||local.source!=='local'||local.remote||local.linkedTo||local.association||local.archived)throw new Error('只能关联尚未绑定的本地案件。');
  if(remote.source!=='baseland'||!remote.remote?.caseId||remote.linkedTo||remote.association||remote.archived)throw new Error('请选择当前账号已同步且未归档的贝思兰德案件。');
  const work=currentWork(local),remoteWork=currentWork(remote);
  const current=structuredClone(local),history=structuredClone(remote);
  current.source='baseland';current.remote=structuredClone(remote.remote);current.current=structuredClone(remoteWork);
  current.association={sourceCaseId:remote.id,remoteCaseId:remote.remote.caseId,linkedAt:at,localProcessKey:work.processId||work.roundId||`local-${work.kind}`,processId:remoteWork.processId};
  current.title=remote.title;current.number=remote.number;current.type=remote.type;current.deadline=remote.deadline;
  current.applicationNumber=remote.applicationNumber;current.companyName=remote.companyName;current.caseRemark=remote.caseRemark;current.caseInfoAt=remote.caseInfoAt;
  current.officialOutcome=structuredClone(remote.officialOutcome);current.remoteClosure=structuredClone(remote.remoteClosure);
  current.tags=[...new Set([...local.tags,...remote.tags])];
  const duplicates=local.rounds.filter(r=>remote.rounds.some(other=>other.id===r.id));
  if(duplicates.length)throw new Error('双方存在相同轮次标识，无法安全自动关联；原记录未更改。');
  current.rounds=[...structuredClone(local.rounds),...structuredClone(remote.rounds)];
  current.materials=[...(current.materials??[]),...(structuredClone(remote.materials)??[])];
  if(remote.localDraft?.trim())current.localVersions=[...(current.localVersions??[]),{id:crypto.randomUUID(),text:remote.localDraft,at,processId:remoteWork.processId}];
  current.localVersions=[...(current.localVersions??[]),...(structuredClone(remote.localVersions)??[])];
  const versions=new Map<string,NonNullable<Case['localVersions']>[number]>();
  for(const version of current.localVersions){
    const prior=versions.get(version.id);
    if(prior&&(prior.text!==version.text||prior.processId!==version.processId))throw new Error('双方案件存在冲突的稿件版本标识，原记录未更改。');
    versions.set(version.id,version);
  }
  current.localVersions=[...versions.values()];
  history.linkedTo=local.id;history.archived=true;
  return {current,history};
}
