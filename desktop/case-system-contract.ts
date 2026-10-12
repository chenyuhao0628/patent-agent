import type { Account, FlowView } from '../src/contracts/desktop-state.ts';
import type { Case, RemoteProcess, Submission } from '../src/domain/workflow.ts';
export type ProcessStatistic={code:number;count:number};
export type CaseOutcomeResult={state:'granted'|'rejected'|'none';noticeName?:string;noticeTypeCode?:string;postDate?:string;checkedAt:string;incomplete?:boolean};
export type CaseInformation={closure?:{finished:boolean;checkedAt:string};caseRemark?:string;processId?:string;process?:Partial<RemoteProcess>;at:string};
export type OfficialStatusResult={submission:Submission;handId?:string;currentFlow?:{name:string;user:string;serial?:number;total?:number};needSendOfficial?:boolean;canEdit?:boolean;ok:boolean};
/** Raw rows belong to the protocol adapter. Existing normalization and business
 * checks remain mandatory before importing or accepting a write result. */
export type CaseSystemRow=Record<string,any>;
export interface CaseSystemClient {
 origin:string;token:string;onUnauthorized?:()=>Promise<boolean>;
 identity(username:string,signal?:AbortSignal):Promise<Account>;
 login(username:string,password:string,signal?:AbortSignal):Promise<Account>;
 personalCasesSnapshot(signal:AbortSignal,initial?:ProcessStatistic[]):Promise<{rows:CaseSystemRow[];stats:ProcessStatistic[]}>;
 personalCases(signal:AbortSignal):Promise<CaseSystemRow[]>;
 personalProcessStatistics(signal?:AbortSignal):Promise<ProcessStatistic[]>;
 caseFileCount(caseId:string,signal?:AbortSignal):Promise<number>;
 files(processId:string,signal:AbortSignal):Promise<CaseSystemRow[]>;
 download(fileNo:string,signal:AbortSignal,retried?:boolean):Promise<Buffer>;
 queryOfficial(processId:string,handId?:string,signal?:AbortSignal,previous?:Submission):Promise<OfficialStatusResult>;
 caseClosure(item:Case,signal?:AbortSignal):Promise<{finished:boolean;checkedAt:string}|undefined>;
 officialOutcome(item:Case,signal?:AbortSignal):Promise<CaseOutcomeResult>;
 caseInfo(item:Case,signal?:AbortSignal):Promise<CaseInformation>;
 flow(item:Case,signal?:AbortSignal):Promise<FlowView>;
 uploadDocument(name:string,bytes:Buffer,signal?:AbortSignal):Promise<string>;
 request(endpoint:string,body?:unknown,params?:Record<string,string>,signal?:AbortSignal,kind?:'data'|'list',retried?:boolean):Promise<any>;
}
export type CaseSystemFactory=(origin:string,token?:string)=>CaseSystemClient;
