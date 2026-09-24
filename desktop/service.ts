import path from 'node:path';
import { diagnostic, diagnosticError, withDiagnostics } from './diagnostics.ts';
import { SyncCache } from './sync-cache.ts';
import { BaselandAuthError } from './baseland.ts';
import { readSharedCases } from './shared.ts';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { applyRemoteClosure, applySubmissionToCurrent, assignCurrentProcess, BaselandClient, isInternallyActiveProcess, mergePersonalRows, officialDate, profileKey, rowStamp, shouldQueryOfficial, SUBMISSION_REFRESH_ERROR } from './baseland.ts';
import { applyCaseDeadline, mergeRemoteProcess } from '../src/domain/deadlines.ts';
import { atomicJSON, CaseFiles, digest, managedPath, readJSON, safeName, validateRoots } from './files.ts';
import { normalizeWorkspace, currentWork, editableCurrent } from '../src/domain/lifecycle.ts';
import { pauseRunning } from '../src/domain/workflow.ts';
import type { Case, CurrentFlowInfo, RemoteProcess, Settings, Submission, Workspace } from '../src/domain/workflow.ts';
import type { Account, DesktopState, FlowView, MigrationState, SyncState, StorageState } from '../src/desktop.ts';
import {
  assertDestinationOnlyOwnStaging, assertSourceUnchanged, buildPreview, cancelledError,
  copyAccountNamespace, ioErrorMessage, namespaceHasEntries, publishAccountNamespace,
  removeOwnStaging, rollbackAccountNamespace, scanAccountNamespace, stagingDirName,
  validateMigrationDestination, verifyCopiedNamespace, waitForFilesystemIdle,
} from './migration.ts';
import type { PreparedMigration } from './migration.ts';
import { organizeWorkFolders } from './work-folder-organizer.ts';

export type Vault={available:()=>boolean;encrypt:(text:string)=>Buffer;decrypt:(data:Buffer)=>string};
const empty=():Workspace=>({schema:1,cases:[],settings:{provider:'DeepSeek',baseUrl:'',model:''}});
export type SyncOptions={source?:'manual'|'timer'|'focus'|'login'|'settings'|'startup';full?:boolean};
type SyncSignals={processes:string;detailedAt:number};
// 官方递交状态缓存：在办流程 5 分钟，终态（已收到回执）1 小时。
// 「15 分钟强制核验」不该击穿终态流程的缓存。实测本所账号 40 案 / 50 流程、24 条流程有递交实例：
// 需要查官方状态的当前流程 22 个，其中 13 个已是「已收到回执」，每轮强制核验白刷 13 次
// queryOfficial = 26 次 HTTP；而 SendStatus 取值只有 0/1/2/3/6/100，6 是终值，不会回退。
const SUBMISSION_TTL=5*60*1000;
const TERMINAL_SUBMISSION_TTL=60*60*1000;
// 官方结论（授权/驳回）已判定后 7 天内不重复判读：结论不会自行回退，未出结论的案件才需要每轮判读。
// 判读跟随正常同步执行（含聚合门控命中），不再需要用户手动点「重新判读」才能看到结果。
const OUTCOME_SETTLED_TTL=7*24*60*60*1000;
export function outcomeSettled(c:Case,now=Date.now()):boolean{
  const outcome=c.officialOutcome;
  if(!outcome||outcome.incomplete)return false;
  if(outcome.state!=='granted'&&outcome.state!=='rejected')return false;
  const at=Date.parse(outcome.checkedAt);
  return Number.isFinite(at)&&now-at<OUTCOME_SETTLED_TTL;
}
export function isTerminalSubmission(sub:Submission|undefined):boolean{
  return sub?.state==='received';
}
const syncFingerprint=(c:Case|undefined)=>JSON.stringify(c&&[c.current,c.remote,c.remoteClosure,c.caseInfoAt,c.caseRemark,c.officialOutcome]);
export async function mapLimit<T>(items:T[],limit:number,run:(item:T)=>Promise<void>){
  let next=0,failed=false;
  let failure:unknown;
  const worker=async()=>{
    while(!failed){
      const index=next++;
      if(index>=items.length)return;
      try{await run(items[index]);}catch(error){failed=true;failure=error;}
    }
  };
  await Promise.all(Array.from({length:Math.min(limit,Math.max(items.length,1))},worker));
  if(failed)throw failure;
}
function mergeSyncMaterials(base:Case|undefined,incoming:Case,latest:Case,next:Case){
  const merge=(before:Case['materials'],downloaded:Case['materials'],live:Case['materials'])=>{
    const result=new Map((live??[]).map(m=>[m.id,m]));
    for(const m of downloaded??[]){
      const old=before?.find(x=>x.id===m.id);
      if(JSON.stringify(old)===JSON.stringify(m))continue;
      const current=result.get(m.id);
      if(!current||JSON.stringify(old)===JSON.stringify(current))result.set(m.id,m);
    }
    return [...result.values()];
  };
  next.materials=merge(base?.materials,incoming.materials,latest.materials);
  next.rounds=latest.rounds.map(r=>structuredClone(r));
  for(const r of incoming.rounds){
    const old=base?.rounds.find(x=>x.id===r.id),live=next.rounds.find(x=>x.id===r.id);
    if(!live){next.rounds.push(structuredClone(r));continue;}
    live.materials=merge(old?.materials,r.materials,live.materials);
    if(JSON.stringify(live.priorArt)===JSON.stringify(old?.priorArt))live.priorArt=r.priorArt;
  }
}
export class DesktopService {
  preparePriorArt?: (c:Case,key:string,signal?:AbortSignal,files?:CaseFiles)=>Promise<void>;
  root:string; vault:Vault; clientFactory:(origin:string,token?:string)=>BaselandClient;
  account:Account|null=null; key='local'; workspace=empty(); client:BaselandClient|null=null;
  syncState:SyncState={running:false,message:'登录并选择工作文件夹后自动同步个人案件。'};
  storageState:StorageState={running:false,message:'选择总工作文件夹后读取本工作台的案件索引、材料和稿件。'};
  generation=0; controller:AbortController|null=null; changed:()=>void=()=>{}; loginBusy=false; syncPreparing=false;
  submissionCache=new SyncCache<{at:number;submission:Submission;handId?:string;currentFlow?:CurrentFlowInfo;needSendOfficial?:boolean;canEdit?:boolean}>(SUBMISSION_TTL);
  caseClosureCache=new SyncCache<{closure:Case['remoteClosure'];at:number;processKey?:string}>(15*60*1000);
  private fileListCache=new SyncCache<{at:number}>(30*60*1000);
  private syncRequest?:{generation:number;full:boolean;queuedFull:boolean;promise:Promise<DesktopState>};
  private lastAutoSync?:{generation:number;at:number};
  private syncSignals?:SyncSignals;
  private readonly syncSignalMaxAge=15*60*1000;
  private stopping=false;
  migrationLock=false; migrationQueued=false; migrationAbort:AbortController|null=null; migrationTask:Promise<void>|null=null;
  preparedPreview:PreparedMigration|null=null;
  migrationState:MigrationState={running:false,phase:'idle',canCancel:false,message:''};
  migrationTestHook?:(phase:'beforeStaging'|'copying'|'verifying'|'beforePublish')=>void|Promise<void>;
  flowFileWrites=0;
  private persistGate:Promise<unknown>=Promise.resolve();
  private reauthTask?:Promise<boolean>;
  private reauthController?:AbortController;
  private savedCredentials?:{username:string;password:string};
  constructor(root:string,vault:Vault,clientFactory=(origin:string,token?:string)=>new BaselandClient(origin,token)) {this.root=root;this.vault=vault;this.clientFactory=clientFactory;}
  profileFile(){return path.join(this.root,'profiles',this.key,'workspace.json');}
  async init(verify=true){
    const saved=await readJSON<{key:string;account:Account;encrypted:string;credentials?:string}|null>(path.join(this.root,'session.json'),null);
    if(saved){
      try{
        if(!this.vault.available())throw new Error();
        const token=this.vault.decrypt(Buffer.from(saved.encrypted,'base64'));
        if(saved.credentials){
          try{
            const parsed=JSON.parse(this.vault.decrypt(Buffer.from(saved.credentials,'base64')));
            if(parsed&&typeof parsed.username==='string'&&typeof parsed.password==='string')this.savedCredentials=parsed;
          }catch{}
        }
        this.key=saved.key;this.account={...saved.account,status:'offline'};this.client=this.clientFactory(saved.account.origin,token);
        this.client.onUnauthorized=()=>this.reauthorize();
      }
      catch{this.account=null;this.key=saved.key;this.client=null;this.savedCredentials=undefined;this.auth={phase:'unreadable',message:'本机登录凭证无法读取，请重新登录；原账号案件记录已保留。',attempts:0};}
    }
    this.workspace=normalizeWorkspace(pauseRunning(await readJSON(this.profileFile(),empty())));
    if(this.workspace.settings.workRoot)await this.refreshShared(this.key);
    if(this.client&&this.account){this.auth={phase:'verifying',message:'正在验证登录…',attempts:0};if(verify)await this.verifyLogin(true);}
  }
  async reauthorize():Promise<boolean>{
    if(this.reauthTask)return this.reauthTask;
    const account=this.account,creds=this.savedCredentials,generation=this.generation,targetKey=this.key;
    if(!creds||!account||targetKey==='local')return false;
    const controller=new AbortController();
    this.reauthController=controller;
    const task=(async()=>{
      try{
        const client=this.clientFactory(account.origin);
        client.onUnauthorized=()=>this.reauthorize();
        const refreshed=await client.login(creds.username,creds.password,controller.signal);
        client.onUnauthorized=()=>this.reauthorize();
        if(controller.signal.aborted||generation!==this.generation||targetKey!==this.key||!this.account||this.account.username!==account.username||this.account.origin!==account.origin)return false;
        if(this.client)this.client.token=client.token;
        this.client=client;
        this.account={...refreshed,remembered:true};
        const encrypted=this.vault.encrypt(client.token).toString('base64');
        const credentials=this.vault.encrypt(JSON.stringify(creds)).toString('base64');
        if(controller.signal.aborted||generation!==this.generation||targetKey!==this.key||!this.account||this.account.username!==account.username)return false;
        await atomicJSON(path.join(this.root,'session.json'),{key:this.key,account:this.account,encrypted,credentials});
        this.auth={phase:'authenticated',message:'登录已自动重新获取授权',attempts:0,lastCheckedAt:new Date().toISOString()};
        this.syncState.message='登录已自动重新获取授权，可以同步个人案件。';
        this.changed();
        return true;
      }catch(e){
        if(controller.signal.aborted||generation!==this.generation||targetKey!==this.key)return false;
        if(e instanceof BaselandAuthError&&['expired','forbidden'].includes(e.kind)){
          this.savedCredentials=undefined;
          const saved=await readJSON<any>(path.join(this.root,'session.json'),null);
          if(saved&&saved.key===targetKey){delete saved.credentials;await atomicJSON(path.join(this.root,'session.json'),saved);}
          this.auth={phase:e.kind,message:e.kind==='expired'?'登录凭证已失效，请重新输入密码。':'当前账号无权访问，请核对权限。',attempts:0,lastCheckedAt:new Date().toISOString()};
          if(this.account&&this.account.username===account.username)this.account={...this.account,status:'expired'};
          this.changed();
        }
        return false;
      }
    })();
    this.reauthTask=task;
    task.finally(()=>{
      if(this.reauthTask===task){this.reauthTask=undefined;this.reauthController=undefined;}
    });
    return task;
  }
  auth:import('../src/desktop.ts').AuthState={phase:'signed-out',message:'未登录',attempts:0};
  private verification?:Promise<DesktopState>;
  async verifyLogin(force=false):Promise<DesktopState>{
    if(this.verification)return this.verification;
    if(!this.client||!this.account)return this.state();
    if(this.auth.phase==='expired'&&this.savedCredentials){
      const ok=await this.reauthorize();
      if(ok)return this.state();
    }
    if(!force&&(this.auth.phase==='expired'||this.auth.phase==='forbidden'||(this.auth.nextRetryAt&&Date.now()<Date.parse(this.auth.nextRetryAt))))return this.state();
    const client=this.client,account=this.account,generation=this.generation;
    const attempts=this.auth.attempts+1;
    this.auth={...this.auth,phase:'verifying',message:'正在验证登录…',attempts,nextRetryAt:undefined};this.changed();
    const task=(async()=>{
      try{
        const verified=await client.identity(account.username);
        if(generation!==this.generation||client!==this.client)return this.state();
        this.account={...verified,remembered:account.remembered};
        this.auth={phase:'authenticated',message:'登录已验证',attempts:0,lastCheckedAt:new Date().toISOString()};
        this.syncState.message='登录已验证，可以同步个人案件。';
      }catch(e){
        if(generation!==this.generation||client!==this.client)return this.state();
        const phase=e instanceof BaselandAuthError?e.kind:'offline';
        if(phase==='expired'&&this.savedCredentials){
          const reauthOk=await this.reauthorize();
          if(reauthOk)return this.state();
        }
        this.account={...account,status:phase==='expired'?'expired':'offline'};
        this.auth={phase,attempts,lastCheckedAt:new Date().toISOString(),
          message:phase==='expired'?'登录已过期，请重新登录。':phase==='forbidden'?'当前账号无权验证登录，请核对账号权限。':'暂时无法验证登录，可能是网络或服务异常。本机记录已保留。',
          nextRetryAt:phase==='offline'&&attempts<4?new Date(Date.now()+[0,15000,30000,60000][attempts]).toISOString():undefined};
        this.syncState.message=this.auth.message;
      }
      this.changed();return this.state();
    })();
    this.verification=task;
    try{return await task;}finally{if(this.verification===task)this.verification=undefined;}
  }
  async retryLoginIfDue(){
    if(this.auth.phase==='offline'&&this.auth.nextRetryAt&&Date.now()>=Date.parse(this.auth.nextRetryAt))return this.verifyLogin();
    return this.state();
  }
  version='开发预览';
  state():DesktopState {return structuredClone({profileKey:this.key,account:this.account,auth:this.auth,workspace:this.workspace,sync:this.syncState,storage:this.storageState,migration:this.migrationState,version:this.version,dataDirectory:path.join(this.root,'profiles',this.key)});}
  assertNotMigrating(){if(this.migrationLock)throw new Error('正在迁移当前账号工作目录，无法进行该操作。');}
  isWorkMigrationBusy(){return this.migrationLock||this.migrationQueued;}
  assertMigrationNotAccepted(){if(this.isWorkMigrationBusy())throw new Error('正在迁移当前账号工作目录，无法进行该操作。');}
  markWorkMigrationQueued(){this.assertMigrationNotAccepted();this.migrationQueued=true;}
  clearWorkMigrationQueued(){this.migrationQueued=false;}
  abortWorkMigration(){this.migrationAbort?.abort();}
  setMigration(patch:Partial<MigrationState>){this.migrationState={...this.migrationState,...patch};this.changed();}
  files(){return new CaseFiles(this.workspace.settings,this.key);}
  async persist(){await atomicJSON(this.profileFile(),structuredClone(this.workspace));}
  async login(input:{origin:string;username:string;password:string;remember:boolean}){
    this.assertNotMigrating();
    if(this.loginBusy)throw new Error('正在登录，请稍候。');
    if(!input.username.trim()||!input.password.trim())throw new Error('请填写账号和密码。');
    this.loginBusy=true;
    this.reauthController?.abort();
    const pendingReauth=this.reauthTask;
    this.reauthTask=undefined;
    this.reauthController=undefined;
    if(pendingReauth)await pendingReauth.catch(()=>{});
    const generation=this.generation;
    try{
      const client=this.clientFactory(input.origin),account=await client.login(input.username.trim(),input.password);
      if(generation!==this.generation)throw new Error('登录操作已取消。');
      const nextKey=profileKey(account.origin,account.username);
      const nextWorkspace=normalizeWorkspace(pauseRunning(await readJSON(path.join(this.root,'profiles',nextKey,'workspace.json'),empty())));
      if(generation!==this.generation)throw new Error('登录操作已取消。');
      account.remembered=input.remember&&this.vault.available();
      const encrypted=account.remembered?this.vault.encrypt(client.token).toString('base64'):undefined;
      const credentials=account.remembered?this.vault.encrypt(JSON.stringify({username:input.username.trim(),password:input.password})).toString('base64'):undefined;
      this.savedCredentials=account.remembered?{username:input.username.trim(),password:input.password}:undefined;
      await this.persist();
      if(account.remembered)await atomicJSON(path.join(this.root,'session.json'),{key:nextKey,account,encrypted,credentials});
      else await fs.rm(path.join(this.root,'session.json'),{force:true});
      this.controller?.abort();this.generation++;this.verification=undefined;this.submissionCache.clear();this.caseClosureCache.clear();this.fileListCache.clear();this.syncSignals=undefined;
      this.persistGate=Promise.resolve();
      this.syncPreparing=false;
      this.key=nextKey;this.client=client;this.client.onUnauthorized=()=>this.reauthorize();this.account=account;this.workspace=nextWorkspace;this.auth={phase:'authenticated',message:'登录已验证',attempts:0,lastCheckedAt:new Date().toISOString()};
      this.syncState={running:false,message:'已登录，准备读取工作目录。'};
      this.storageState={running:false,message:'请选择当前账号的总工作文件夹。'};
      if(this.workspace.settings.workRoot)await this.refreshShared(this.key);
      this.syncState={running:false,message:account.remembered?'已登录；仅同步当前账号负责的案件。':'已登录，本次凭证仅保留到退出应用。'};
      this.changed();return this.state();
    }finally{this.loginBusy=false;}
  }
  private enqueuePersist<T>(fn:()=>Promise<T>){
    const run=this.persistGate.then(fn,fn);
    this.persistGate=run.then(()=>{},()=>{});
    return run;
  }
  private filesystemBusy(){return this.storageState.running||this.syncPreparing||this.syncState.running||this.flowFileWrites>0;}
  async logout(){
    this.assertNotMigrating();
    this.reauthController?.abort();
    const pendingReauth=this.reauthTask;
    this.reauthTask=undefined;
    this.reauthController=undefined;
    if(pendingReauth)await pendingReauth.catch(()=>{});
    this.generation++;this.verification=undefined;this.controller?.abort();this.submissionCache.clear();this.caseClosureCache.clear();this.fileListCache.clear();this.syncSignals=undefined;await this.persist();await fs.rm(path.join(this.root,'session.json'),{force:true});
    this.persistGate=Promise.resolve();
    this.syncPreparing=false;
    this.client=null;this.account=null;this.savedCredentials=undefined;this.auth={phase:'signed-out',message:'已退出登录',attempts:0};this.key='local';this.workspace=await readJSON(this.profileFile(),empty());
    this.syncState={running:false,message:'已退出账号。'};this.storageState={running:false,message:'请选择总工作文件夹。'};if(this.workspace.settings.workRoot)await this.refreshShared(this.key);
    this.syncState={running:false,message:'已退出账号；原账号的本机记录已保留。'};this.changed();return this.state();
  }
  assertKey(key:string){if(key!==this.key)throw new Error('账号已切换，本次旧页面操作未保存。');}
  async settings(key:string,s:Settings){
    this.assertKey(key);this.assertNotMigrating();const roots=await validateRoots(s);
    if(this.workspace.settings.workRoot&&roots.workRoot!==this.workspace.settings.workRoot){
      const occupied=this.workspace.cases.some(c=>c.directory)||await namespaceHasEntries(this.workspace.settings.workRoot,this.key);
      if(occupied)throw new Error('工作文件夹已有案件。请保留当前目录；请使用当前账号工作目录迁移。');
    }
    const lastTransferRecipient=s.lastTransferRecipient??this.workspace.settings.lastTransferRecipient;
    const nextSettings={provider:s.provider,baseUrl:s.baseUrl,model:s.model,templatePath:s.templatePath,extensions:s.extensions, ...(lastTransferRecipient?{lastTransferRecipient}:{}), ...roots};
    // Publish settings in memory only after the atomic disk write succeeds.
    await atomicJSON(this.profileFile(),{...structuredClone(this.workspace),settings:nextSettings});
    this.assertKey(key);this.workspace.settings=nextSettings;
    this.storageState={running:false,message:roots.workRoot?(this.syncState.running?'目录设置已保存；正在同步，可在同步完成后刷新读取。':'目录设置已保存，准备读取工作目录。'):roots.originalLibrary?'原始申请文件库已保存；请选择总工作文件夹。':'请选择原始申请文件库和总工作文件夹。'};
    this.changed();return this.state();
  }
  refreshShared(key:string){
    const generation=this.generation;
    return this.enqueuePersist(async()=>{
      if(generation!==this.generation)throw new Error('账号已切换，本次旧页面操作未保存。');
      return this.refreshSharedNow(key);
    });
  }
  private async refreshSharedNow(key:string){
    const generation=this.generation;
    this.assertKey(key);this.assertNotMigrating();if(this.syncState.running)throw new Error('正在同步贝思兰德，请完成后再读取工作目录。');
    this.storageState={...this.storageState,running:true,message:'正在读取工作目录中的案件与稿件…'};this.changed();
    try{
      const {workRoot}=await validateRoots(this.workspace.settings);if(!workRoot)throw new Error('请先选择总工作文件夹。');
      const result=await readSharedCases(workRoot,key,this.workspace.cases);this.assertKey(key);
      if(generation!==this.generation)return this.state();
      this.workspace.cases=result.cases;await this.persist();
      this.storageState={running:false,lastAt:new Date().toISOString(),caseCount:result.count,message:`已读取 ${result.count} 个本工作台案件。`+(result.warnings.length?`${result.warnings.length} 个目录需核对：${result.warnings.slice(0,2).join('；')}`:result.count?'材料与工作稿已更新；本机对话和任务不从共享目录导入。':'新案件将在此创建；普通文件夹不会自动当作案件。')};
    }catch(e){if(key!==this.key||generation!==this.generation)return this.state();this.storageState={running:false,message:'工作目录未读取完成：'+(e as Error).message};}
    this.changed();return this.state();
  }
  async save(key:string,incoming:Workspace){
    this.assertKey(key);this.assertNotMigrating();if(incoming.schema!==1||!Array.isArray(incoming.cases))throw new Error('案件记录格式不正确。');
    return this.enqueuePersist(()=>this.saveNow(key,incoming));
  }
  async organizeFolders(key:string) {
    this.assertKey(key); this.assertNotMigrating();
    if (this.filesystemBusy()) throw new Error('当前仍有同步、读取或文件写入操作，请稍后再整理。');
    const generation = this.generation;
    const result = await this.enqueuePersist(async () => {
      this.assertKey(key);
      const organized = await organizeWorkFolders(this.workspace.settings, key, structuredClone(this.workspace.cases));
      if (generation !== this.generation) throw new Error('账号已切换，本次整理未完成。');
      const next = structuredClone(this.workspace);
      for (const c of next.cases) {
        const change = organized.caseChanges.find(x => x.caseId === c.id);
        if (!change) continue;
        const replace = (value: unknown): unknown => {
          if (typeof value === 'string') {
            const normalized = value.replaceAll('\\', '/');
            for (const [from, to] of change.replacements) {
              if (normalized === from || normalized.startsWith(`${from}/`)) return `${to}${normalized.slice(from.length)}`;
            }
            return value;
          }
          if (Array.isArray(value)) return value.map(replace);
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
          return value;
        };
        // Only case-relative references are changed; local task records remain outside the shared case tree.
        Object.assign(c, replace(c) as Case);
        c.directory = change.newDirectory;
      }
      this.workspace = next;
      await this.persist();
      return organized.report;
    });
    this.changed();
    return result;
  }
  private async saveNow(key:string,incoming:Workspace){
    this.assertKey(key);this.assertNotMigrating();
    // Renderer may edit local fields only, never remote identity, ownership or active workflow.
    const next=structuredClone(this.workspace),files=this.files();
    for(const c of next.cases){const edit=incoming.cases.find(x=>x.id===c.id);if(!edit)continue;
      c.archived=edit.archived===true;c.tags=Array.isArray(edit.tags)?edit.tags.filter(x=>typeof x==='string').slice(0,30):c.tags;
      if(c.source==='local'){
        if(typeof edit.title==='string'&&edit.title.trim())c.title=edit.title.trim().slice(0,250);
        if(typeof edit.deadline==='string'){if(!edit.deadline)c.deadline='';else if(officialDate(edit.deadline))c.deadline=officialDate(edit.deadline);}
        if(edit.current&&['write','review','reply','correction'].includes(edit.current.kind)){
          c.current=structuredClone(edit.current);
        }
      }
      if(editableCurrent(c)&&edit.current?.processId===c.current?.processId){
        c.localDraft=typeof edit.localDraft==='string'?edit.localDraft:c.localDraft;
        for(const v of edit.localVersions??[]){
          if(/^[a-f0-9-]{36}$/i.test(v.id)&&!c.localVersions?.some(x=>x.id===v.id)&&v.text===c.localDraft&&v.processId===c.current?.processId){c.localVersions=[...(c.localVersions??[]),{id:v.id,text:v.text,at:new Date().toISOString(),processId:v.processId}];}
        }
      }
      if(c.localDraft!==undefined)c.directory=await files.saveDraft(c);
    }
    this.assertKey(key);
    this.workspace={...this.workspace,cases:this.workspace.cases.map(c=>{const changed=next.cases.find(x=>x.id===c.id);if(!changed)return c;return {...c,archived:changed.archived,tags:changed.tags,...(c.source==='local'?{title:changed.title,deadline:changed.deadline,current:changed.current}:{}),...(c.current?.processId===changed.current?.processId?{localDraft:changed.localDraft,localVersions:changed.localVersions,directory:changed.directory,sharedDraftHash:changed.sharedDraftHash}:{})};})};
    await this.persist();
  }
  async createCase(input:{title:string;number:string;kind:'write'|'review'}) {
    this.assertNotMigrating();
    if(!input.title.trim()||!input.number.trim()||!['write','review'].includes(input.kind))throw new Error('请填写案件名称、案号和当前业务。');
    if(this.workspace.cases.some(c=>c.number===input.number.trim()))throw new Error('该案号已存在，请从案件库打开。');
    const c:Case={id:randomUUID(),number:input.number.trim(),title:input.title.trim(),type:'发明',deadline:'',tags:[],archived:false,rounds:[],materials:[],source:'local',current:{kind:input.kind},localDraft:'',localVersions:[]};
    c.directory=await this.files().ensureCase(c);this.workspace.cases.push(c);await this.persist();this.changed();return this.state();
  }
  findCase(id:string){const c=this.workspace.cases.find(c=>c.id===id);if(!c)throw new Error('当前账号没有该案件。');return c;}
  sync(options:SyncOptions={}):Promise<DesktopState>{
    if(this.stopping)return Promise.reject(new Error('应用正在退出。'));
    const source=options.source??'manual',full=options.full??source==='manual',generation=this.generation;
    const pending=this.syncRequest;
    if(pending?.generation===generation){
      if(full&&!pending.full)pending.queuedFull=true;
      diagnostic('sync','joined',{source,state:full?'full':'incremental'});
      return pending.promise;
    }
    if(source!=='manual'&&!full&&this.lastAutoSync?.generation===generation&&Date.now()-this.lastAutoSync.at<5*60*1000)return Promise.resolve(this.state());
    const request={generation,full,queuedFull:false,promise:Promise.resolve(this.state())};
    this.syncRequest=request;
    request.promise=(async()=>{
      try{
        let state=await this.runSync(source,full);
        if(request.queuedFull&&generation===this.generation&&!this.isWorkMigrationBusy()&&!this.stopping&&!this.controller?.signal.aborted){
          request.full=true;request.queuedFull=false;
          state=await this.runSync('manual',true);
        }
        return state;
      }finally{if(this.syncRequest===request)this.syncRequest=undefined;}
    })();
    return request.promise;
  }
  private runSync(source:NonNullable<SyncOptions['source']>,full:boolean){
    return withDiagnostics({syncId:randomUUID(),source},()=>this.syncNow(full));
  }
  private async syncNow(full:boolean){
    this.assertNotMigrating();
    if(this.syncState.running||this.syncPreparing)return this.state();
    if(this.account&&this.account.status!=='authenticated'&&this.savedCredentials){
      await this.reauthorize();
    }
    if(!this.client||this.account?.status!=='authenticated')throw new Error('请先登录贝思兰德。');
    if(!this.workspace.settings.workRoot)throw new Error('请先选择总工作文件夹。');
    const startingKey=this.key,startingGeneration=this.generation;this.syncPreparing=true;
    try{await this.refreshShared(startingKey);}finally{if(startingGeneration===this.generation)this.syncPreparing=false;}
    if(this.stopping||this.migrationLock||startingKey!==this.key||startingGeneration!==this.generation)return this.state();
    const key=this.key,generation=this.generation,client=this.client,controller=new AbortController();this.controller=controller;
    if(client&&!client.onUnauthorized)client.onUnauthorized=()=>this.reauthorize();
    const settings={...this.workspace.settings},persistFile=this.profileFile();
    const check=()=>{controller.signal.throwIfAborted();if(generation!==this.generation||key!==this.key||settings.workRoot!==this.workspace.settings.workRoot)throw new Error('同步范围已变化。');};
    const downloads=new CaseFiles(settings,key,false,check),files=new CaseFiles(settings,key,true,check);
    const started=Date.now();let outcome='failed';diagnostic('sync','started',{state:full?'full':'incremental'});
    this.lastAutoSync=undefined;
    this.submissionCache.prune();this.caseClosureCache.prune();this.fileListCache.prune();
    this.syncState={...this.syncState,running:true,message:'正在查询个人案件并保存新材料…'};this.changed();
    try{
      const baseline=structuredClone(this.workspace.cases);
      const previousSignals=this.syncSignals;
      const forceDetails=full||!previousSignals||Date.now()-previousSignals.detailedAt>=this.syncSignalMaxAge;
      let initialStats;
      if(!full){
        try{
          const processes=await client.personalProcessStatistics(controller.signal);
          check();
          const processKey=processes.map(row=>`${row.code}:${row.count}`).join(',');
          if(!forceDetails&&this.syncSignals&&processKey===this.syncSignals.processes){
            diagnostic('sync','aggregate_gate_hit',{ageMs:Date.now()-this.syncSignals.detailedAt});
            // 门控只跳过明细同步，不跳过官方结论判读：授权/驳回通知不一定会新建流程，统计不变也可能刚出结果。
            const held=await this.judgeOutcomes(client,check,controller.signal,key,generation);
            this.syncState={running:false,lastAt:new Date().toISOString(),message:held.length?`贝思兰德统计未变化，已跳过本轮明细同步。案件状态判读 ${held.length} 项待重试：${held.slice(0,2).join('；')}`:'贝思兰德统计未变化，已跳过本轮明细同步，案件状态已判读。'};
            outcome='completed';return this.state();
          }
          initialStats=processes;
          diagnostic('sync','aggregate_gate_miss',{processChanged:this.syncSignals?processKey!==this.syncSignals.processes:true});
        }catch(e){check();diagnostic('sync','aggregate_gate_fallback',{reason:(e as Error).message});}
      }
      this.syncSignals=undefined;
      const detailedAt=forceDetails?Date.now():previousSignals!.detailedAt;
      const snapshot=await client.personalCasesSnapshot(controller.signal,initialStats);check();
      const rows=snapshot.rows;
      const cases=mergePersonalRows(rows,baseline,new Date().toISOString());const failures:string[]=[];const outcomeFailures:string[]=[];
      const rowByProc=new Map(rows.map(r=>[String(r.CaseProcId),r]));
      await mapLimit(cases,4,async c=>{
        check();
        await withDiagnostics({caseId:c.id},async()=>{
        const base=baseline.find(x=>x.id===c.id);
        if(base?.source==='local')return;
        let closure:Case['remoteClosure'];
        if(c.remote){
          const cacheKey=c.remote.caseId,cached=this.caseClosureCache.get(cacheKey);
          const processKey=JSON.stringify(c.remote.processes.map(p=>[p.id,p.status]));
          const reusable=cached?.closure&&(cached.closure.finished||Date.now()-cached.at<3*60*1000)&&cached.processKey===processKey;
          if(!forceDetails&&reusable){closure=cached!.closure;diagnostic('sync','closure_cache_hit');}
          else{try{closure=await client.caseClosure(c,controller.signal);check();if(this.caseClosureCache.get(cacheKey)===cached&&syncFingerprint(this.workspace.cases.find(x=>x.id===c.id))===syncFingerprint(base)){if(closure)this.caseClosureCache.set(cacheKey,{closure,at:Date.now(),processKey});else this.caseClosureCache.delete(cacheKey);}}catch(e){check();failures.push(c.number+' / 结案核验：'+(e as Error).message);}}
        }
        // 官方授权/驳回结论与案件数据同一次同步判读；失败保留上次结论，绝不写入「未授权」。
        if(c.remote&&!c.archived&&!c.remoteClosure?.finished&&!outcomeSettled(c)){
          try{c.officialOutcome=await client.officialOutcome(c,controller.signal);check();}
          catch(e){check();outcomeFailures.push(c.number+' / 案件状态判读：'+(e as Error).message);}
        }
        const currentProc=c.remote?.processes.find(p=>p.id===c.current?.processId);
        if(currentProc&&shouldQueryOfficial(currentProc,rowByProc.get(currentProc.id))){
          await this.refreshProcessOfficial(c,currentProc,client,controller.signal,generation,forceDetails);
          if(currentProc.submission?.refreshError||currentProc.submission?.state==='unknown')failures.push(c.number+' / 官方状态需重试');
        }
        check();
        c.directory=await downloads.ensureCase(c);
        if(c.remote)for(const p of c.remote.processes){
          check();
          const round=c.rounds.find(r=>r.id==='proc-'+p.id);
          const cacheKey=this.fileListCacheKey(c,p,rowByProc.get(p.id));
          const materials=round?.materials??c.materials??[];
          if(!forceDetails&&c.current?.processId!==p.id&&materials.every(m=>m.ready)&&this.fileListCache.get(cacheKey)){diagnostic('sync','files_cache_hit',{processId:p.id});continue;}
          this.fileListCache.delete(cacheKey);
          let complete=true;
          try{
            const list=await withDiagnostics({processId:p.id},()=>client.files(p.id,controller.signal));check();
            for(const f of list){
              if(!f.FileNo||!f.FileName)continue;const id='file-'+String(f.FileNo),r=c.rounds.find(r=>r.id==='proc-'+p.id);
              const existing=[...(c.materials??[]),...c.rounds.flatMap(r=>r.materials)].find(m=>m.id===id);
              if(existing?.ready)continue;
              const m={id,name:String(f.FileName),fileNo:String(f.FileNo),role:/通知|审查意见|补正/.test(f.FileName)?'通知书':'系统材料',location:p.name,excerpt:'',ready:false,relativePath:undefined as string|undefined};
              try{const data=await client.download(m.fileNo,controller.signal);check();const saved=await downloads.writeMaterial(c,path.join('01_通知与材料',safeName(p.name,24)+'__'+digest(p.id).slice(0,8)),m.fileNo,m.name,data);m.relativePath=saved.relativePath;m.ready=true;}
              catch(e){check();complete=false;failures.push(m.name+'：'+(e as Error).message);}
              if(r)r.materials=[...r.materials.filter(x=>x.id!==id),m];else c.materials=[...(c.materials??[]).filter(x=>x.id!==id),m];
            }
            if(complete){check();this.fileListCache.set(cacheKey,{at:Date.now()});}
          }catch(e){check();failures.push(c.number+' / '+p.name+'：'+(e as Error).message);}
        }
        if(settings.originalLibrary&&!c.materials?.some(m=>m.role==='原始申请')){
          try{const choices=await downloads.findOriginals(c);check();if(choices.length===1){const saved=await downloads.copyOriginal(c,choices[0].id);c.materials=[...(c.materials??[]),{id:'original-'+digest(choices[0].id),name:choices[0].name,role:'原始申请',location:'原始申请文件库',excerpt:'',ready:true,relativePath:saved.relativePath}];}}
          catch(e){failures.push(c.number+'：'+(e as Error).message);}
        }
        if(this.preparePriorArt)try{await this.preparePriorArt(c,key,controller.signal,downloads);}catch(e){check();failures.push(c.number+" / 对比文件："+(e as Error).message);}
        await this.enqueuePersist(async()=>{
          check();
          const latest=this.workspace.cases.find(x=>x.id===c.id);
          if(base&&!latest)return;
          const stale=syncFingerprint(latest)!==syncFingerprint(base);
          const next=structuredClone(stale&&latest?latest:c);
          if(latest){
            next.archived=latest.archived;next.tags=latest.tags;
            if(stale||latest.current?.processId===next.current?.processId){next.localDraft=latest.localDraft;next.localVersions=latest.localVersions;next.sharedDraftHash=latest.sharedDraftHash;}
            else {
              // Rebase a real stage transition on the newest manual draft.
              next.localVersions=latest.localVersions;
              if(latest.localDraft?.trim())next.localVersions=[...(next.localVersions??[]),{id:randomUUID(),text:latest.localDraft,at:new Date().toISOString(),processId:latest.current?.processId}];
            }
            mergeSyncMaterials(base,c,latest,next);
          }
          // Dirty local (fingerprint changed mid-sync) still merges remote closure;
          // draft / tags / current stay on the latest local branch above.
          applyRemoteClosure(next,closure);
          if(stale)diagnostic('sync','newer_state_preserved');
          if(next.localDraft!==undefined)await files.saveDraft(next);else await files.ensureCase(next);
          check();
          this.workspace.cases=[...this.workspace.cases.filter(x=>x.id!==next.id),next];
          await atomicJSON(persistFile,structuredClone(this.workspace));
        });
        });
      });
      this.assertKey(key);
      // 判读失败单独计数：保留上次结论、不参与聚合门控快照判定，下一轮同步继续重试。
      const retryCount=failures.length+outcomeFailures.length;
      const retryNotes=[...failures.slice(0,3),...(outcomeFailures.length?[`案件状态判读 ${outcomeFailures.length} 项待重试：${outcomeFailures.slice(0,2).join('；')}`]:[])];
      this.syncState={running:false,lastAt:new Date().toISOString(),message:retryCount?`案件已保存，${retryCount} 项需重试：${retryNotes.join('；')}`:`已同步 ${rows.length} 条流程，归并为 ${cases.filter(c=>c.remote).length} 个案件。`};
      if(!failures.length){
        this.syncSignals={processes:snapshot.stats.map(row=>`${row.code}:${row.count}`).join(','),detailedAt};
      }else{
        this.syncSignals=undefined;
        diagnostic('sync','aggregate_snapshot_skipped',{failures:failures.length});
      }
      outcome=failures.length?'partial':'completed';
    }catch(e){diagnostic('sync','failed',diagnosticError(e));if(generation===this.generation){this.syncState={...this.syncState,running:false,message:(e as Error).message};if(e instanceof BaselandAuthError&&this.account){this.account.status=e.kind==='expired'?'expired':'offline';this.auth={phase:e.kind,message:e.kind==='expired'?'登录已过期，请重新登录。':'当前账号无权访问，请核对权限。',attempts:0,lastCheckedAt:new Date().toISOString()};}}}
    finally{diagnostic('sync','finished',{durationMs:Date.now()-started,state:controller.signal.aborted?'cancelled':outcome});if(generation===this.generation){if(!controller.signal.aborted)this.lastAutoSync={generation,at:Date.now()};this.syncState.running=false;this.changed();}}
    return this.state();
  }
  private officialCacheKey(c:Case,processId:string){return `${c.remote?.caseId??c.id}\0${processId}`;}
  /** Non-current file-list cache: bind identity + status/stamp so旁路通知 is not stuck behind the 30m TTL. */
  private fileListCacheKey(c:Case,p:RemoteProcess,row?:Record<string,unknown>){return `${c.remote?.caseId??c.id}\0${p.id}\0${p.status}\0${rowStamp(row)}`;}
  async refreshProcessOfficial(c:Case,p:RemoteProcess,client:BaselandClient,signal:AbortSignal,generation:number,force:boolean) {
    const key=this.officialCacheKey(c,p.id);
    const cached=this.submissionCache.get(key);
    // 终态流程不接受 force 击穿：只受更长的 TTL 约束，避免每轮强制核验重复查询不会变化的递交状态。
    const terminal=isTerminalSubmission(p.submission);
    const ttl=terminal?TERMINAL_SUBMISSION_TTL:SUBMISSION_TTL;
    if((!force||terminal)&&cached&&Date.now()-cached.at<ttl){
      p.canEdit=cached.canEdit;
      p.submission=cached.submission;if(cached.handId)p.handId=cached.handId;
      if('currentFlow' in cached)p.currentFlow=cached.currentFlow;
      if(cached.needSendOfficial!==undefined)p.needSendOfficial=cached.needSendOfficial;
      applySubmissionToCurrent(c,p);return;
    }
    const official=await client.queryOfficial(p.id,p.handId,signal,p.submission);
    if(generation!==this.generation)return;
    if(official.ok){
      p.submission=official.submission;if(official.handId)p.handId=official.handId;
      p.currentFlow=official.currentFlow;
      p.canEdit=official.canEdit;
      if(official.needSendOfficial!==undefined)p.needSendOfficial=official.needSendOfficial;
      if(this.submissionCache.get(key)===cached)this.submissionCache.set(key,{at:Date.now(),submission:official.submission,handId:official.handId,currentFlow:official.currentFlow,needSendOfficial:official.needSendOfficial,canEdit:official.canEdit});
    }else if(p.submission&&(p.submission.state==='sent'||p.submission.state==='received')){
      p.submission={...p.submission,refreshError:SUBMISSION_REFRESH_ERROR};
      if(official.handId)p.handId=official.handId;
    }else{
      p.submission=official.submission;if(official.handId)p.handId=official.handId;
    }
    if(!official.ok)p.canEdit=false;
    applySubmissionToCurrent(c,p);
  }
  private scopedPersonalProcesses(latest:Case,view:FlowView,personalIds:string[]){
    const allowed=new Set(personalIds);
    const incoming=(view.processes?.processes??[]).filter(p=>allowed.has(p.id));
    const previous=(latest.remote?.processes??[]).filter(p=>allowed.has(p.id));
    const byId=new Map(previous.map(p=>[p.id,p]));
    for(const p of incoming)byId.set(p.id,p);
    const merged:RemoteProcess[]=[];
    const seen=new Set<string>();
    for(const id of personalIds){
      const next=byId.get(id);
      if(next){
        const prev=previous.find(p=>p.id===id);
        merged.push(mergeRemoteProcess(prev,structuredClone(next)));
        seen.add(id);
      }
    }
    for(const p of incoming)if(!seen.has(p.id))merged.push(mergeRemoteProcess(undefined,structuredClone(p)));
    return merged;
  }
  private applyPersonalFlow(latest:Case,view:FlowView,personalIds:string[]){
    const keepId=latest.current?.processId;
    const blocked=latest.current?.kind==='external'&&!keepId;
    latest.remote={caseId:latest.remote!.caseId,syncedAt:view.at,processes:this.scopedPersonalProcesses(latest,view,personalIds)};
    const internallyActive=latest.remote.processes.filter(x=>personalIds.includes(x.id)&&isInternallyActiveProcess(x));
    const inPersonal=(id?:string)=>!!id&&personalIds.includes(id);
    const inActive=(id?:string)=>!!id&&internallyActive.some(x=>x.id===id);
    let selectedId:string|undefined;
    if(!blocked){
      if(internallyActive.length===1)selectedId=internallyActive[0].id;
      else if(internallyActive.length>1)selectedId=inActive(view.currentProcessId)?view.currentProcessId:inActive(keepId)?keepId:undefined;
      else selectedId=inPersonal(view.currentProcessId)?view.currentProcessId:inPersonal(keepId)?keepId:undefined;
    }
    const proc=selectedId?latest.remote.processes.find(p=>p.id===selectedId):undefined;
    let stageChanged=!!proc&&!!keepId&&proc.id!==keepId;
    if(!blocked&&proc&&personalIds.includes(proc.id)){
      if(stageChanged)assignCurrentProcess(latest,proc,view.at);
      else{
        if(latest.current)latest.current={...latest.current,remoteStatus:proc.status,processId:keepId||proc.id};
        applySubmissionToCurrent(latest,proc);
      }
      if(proc.submission&&!proc.submission.refreshError&&(proc.submission.state!=='unknown'||!/稍后重试/.test(proc.submission.message??''))){
        this.submissionCache.set(this.officialCacheKey(latest,proc.id),{at:Date.now(),submission:proc.submission,handId:proc.handId,currentFlow:proc.currentFlow,needSendOfficial:proc.needSendOfficial,canEdit:proc.canEdit});
      }
    }else if(!blocked&&internallyActive.length>1&&!inActive(keepId)){
      stageChanged=!!keepId;
      assignCurrentProcess(latest,undefined,view.at);
    }else applyCaseDeadline(latest);
    return stageChanged;
  }
  async selectCurrentProcess(key:string,caseId:string,processId:string){
    this.assertKey(key);this.assertNotMigrating();
    return this.enqueuePersist(async()=>{
      this.assertKey(key);this.assertNotMigrating();
      const c=this.findCase(caseId);
      if(c.archived)throw new Error('案件已归档，不能切换当前阶段。');
      if(!c.remote)throw new Error('本地案件尚未关联贝思兰德。');
      const p=c.remote.processes.find(x=>x.id===processId);
      if(!p)throw new Error('目标流程不在本案个人流程中。');
      if(!isInternallyActiveProcess(p))throw new Error('该流程已结束或不是当前可办理的内部流程。');
      const at=new Date().toISOString();
      assignCurrentProcess(c,p,at);
      await this.files().ensureCase(c);
      await this.files().saveDraft(c);
      await this.persist();
      this.changed();
      return this.state();
    });
  }
  private flowRequests=new Map<string,ReturnType<DesktopService['readCaseFlow']>>();
  flow(id:string,enqueueWrite?:<T>(fn:()=>Promise<T>)=>Promise<T>){
    const scope=`${this.generation}/${this.key}/${id}`;
    const existing=this.flowRequests.get(scope);if(existing)return existing;
    const request=this.readCaseFlow(id,enqueueWrite);this.flowRequests.set(scope,request);
    void request.finally(()=>{if(this.flowRequests.get(scope)===request)this.flowRequests.delete(scope);}).catch(()=>{});
    return request;
  }
  private async readCaseFlow(id:string,enqueueWrite?:<T>(fn:()=>Promise<T>)=>Promise<T>){
    this.assertMigrationNotAccepted();
    if(!this.client||this.account?.status!=='authenticated')throw new Error('请先登录贝思兰德。');
    const generation=this.generation,key=this.key,client=this.client;
    const files=new CaseFiles({...this.workspace.settings},key);
    const persistFile=this.profileFile();
    const ownedRoot=this.workspace.settings.workRoot;
    const c=this.findCase(id);
    if(!c.remote)throw new Error('本地案件尚未关联贝思兰德。');
    const remoteCaseId=c.remote.caseId;
    const personalIds=c.remote.processes.map(p=>p.id);
    const queriedProcessId=c.current?.processId??'';
    const queriedScope=personalIds.slice().sort().join('\0');
    const queriedSyncedAt=c.remote.syncedAt;
    const view=await client.flow(structuredClone(c));
    if(generation!==this.generation||this.key!==key)throw new Error('账号已切换，本次旧页面操作未保存。');
    if(this.isWorkMigrationBusy()||(ownedRoot&&this.workspace.settings.workRoot!==ownedRoot))return view;
    const commit=async()=>{
      if(generation!==this.generation||this.key!==key)throw new Error('账号已切换，本次旧页面操作未保存。');
      if(this.isWorkMigrationBusy()||(ownedRoot&&this.workspace.settings.workRoot!==ownedRoot))return view;
      const latest=this.workspace.cases.find(x=>x.id===id);
      if(!latest?.remote||latest.remote.caseId!==remoteCaseId)return view;
      const latestScope=latest.remote.processes.map(p=>p.id).slice().sort().join('\0');
      if((latest.current?.processId??'')!==queriedProcessId||latestScope!==queriedScope||latest.remote.syncedAt!==queriedSyncedAt){
        throw new Error('案件流程已更新，请重新查询。');
      }
      const stageChanged=this.applyPersonalFlow(latest,view,personalIds);
      this.flowFileWrites++;
      try{
        await files.ensureCase(latest);
        if(stageChanged)await files.saveDraft(latest);
        if(generation!==this.generation||this.key!==key)throw new Error('账号已切换，本次旧页面操作未保存。');
        if(ownedRoot&&this.workspace.settings.workRoot!==ownedRoot)throw new Error('账号已切换，本次旧页面操作未保存。');
        await atomicJSON(persistFile,structuredClone(this.workspace));
        this.changed();
        return view;
      }finally{this.flowFileWrites--;}
    };
    return enqueueWrite?enqueueWrite(()=>this.enqueuePersist(commit)):this.enqueuePersist(commit);
  }
  async caseInfo(key:string,id:string) {
    this.assertKey(key); this.assertMigrationNotAccepted();
    if (!this.client || this.account?.status !== 'authenticated') throw new Error('请先登录贝思兰德。');
    const generation=this.generation, root=this.workspace.settings.workRoot, c=structuredClone(this.findCase(id));
    const result=await this.client.caseInfo(c);
    return this.enqueuePersist(async()=>{
      this.assertKey(key); this.assertNotMigrating();
      const latest=this.findCase(id);
      if (generation!==this.generation || root!==this.workspace.settings.workRoot || latest.remote?.caseId!==c.remote?.caseId || latest.current?.processId!==c.current?.processId) throw new Error('案件或流程已变化，请刷新备注。');
      if (result.caseRemark!==undefined) latest.caseRemark=result.caseRemark;
      const proc=latest.remote?.processes.find(p=>p.id===result.processId);
      if (proc && result.process) Object.assign(proc,result.process);
      latest.caseInfoAt=result.at;applyRemoteClosure(latest,result.closure);
      if(latest.remote)this.caseClosureCache.delete(latest.remote.caseId);
      this.flowFileWrites++;
      try { await this.files().ensureCase(latest); await atomicJSON(this.profileFile(),structuredClone(this.workspace)); this.changed(); return this.state(); }
      finally { this.flowFileWrites--; }
    });
  }
  // 聚合门控命中时的判读：明细被跳过，但官方结论仍然要跟得上——授权/驳回通知不一定新建流程。
  // 只处理未出结论、未归档、未结案的案件；已出结论的按 OUTCOME_SETTLED_TTL 跳过。
  private async judgeOutcomes(client:BaselandClient,check:()=>void,signal:AbortSignal,key:string,generation:number):Promise<string[]>{
    const targets=this.workspace.cases.filter(c=>c.source==='baseland'&&c.remote&&!c.archived&&!c.remoteClosure?.finished&&!outcomeSettled(c));
    if(!targets.length)return [];
    const failures:string[]=[],results=new Map<string,Case['officialOutcome']>();
    await mapLimit(targets,4,async c=>{
      check();
      try{results.set(c.id,await client.officialOutcome(c,signal));check();}
      catch(e){check();failures.push(c.number+' / 案件状态判读：'+(e as Error).message);}
    });
    if(!results.size)return failures;
    await this.enqueuePersist(async()=>{
      if(generation!==this.generation)return;
      this.assertKey(key);
      for(const c of this.workspace.cases){
        const value=results.get(c.id);
        if(value&&c.remote)c.officialOutcome=value;
      }
      await atomicJSON(this.profileFile(),structuredClone(this.workspace));
    });
    return failures;
  }
  // 单案「重新判读」：只读这一案的官文清单，按需显式调用。
  async refreshCaseOutcome(key:string,id:string){
    this.assertKey(key);this.assertNotMigrating();
    if(!this.client||this.account?.status!=='authenticated')throw new Error('请先登录贝思兰德。');
    if(!this.workspace.settings.workRoot)throw new Error('请先选择总工作文件夹。');
    if(this.syncState.running||this.syncPreparing)throw new Error('正在同步案件，请同步完成后再重新判读。');
    const generation=this.generation,client=this.client,c=this.findCase(id);
    if(!c.remote)throw new Error('本机案件没有贝思兰德官文清单，无法判读官方结论。');
    const caseId=c.remote.caseId;
    const value=await client.officialOutcome(c);
    if(generation!==this.generation)throw new Error('账号已切换，本次判读结果未保存。');
    await this.enqueuePersist(async()=>{
      this.assertKey(key);this.assertNotMigrating();
      const latest=this.findCase(id);
      if(generation!==this.generation||latest.remote?.caseId!==caseId)throw new Error('案件或账号已变化，请重新判读。');
      latest.officialOutcome=value;
      await this.files().ensureCase(latest);
      await atomicJSON(this.profileFile(),structuredClone(this.workspace));
    });
    this.changed();
    return this.state();
  }
  // 手动「重新判读全部案件」：仅由用户在案件状态中心显式点击触发，逐案只读判读官方结论后一次性落盘，绝不混入常规同步。
  async refreshCaseOutcomes(key:string){
    this.assertKey(key);this.assertNotMigrating();
    if(!this.client||this.account?.status!=='authenticated')throw new Error('请先登录贝思兰德。');
    if(!this.workspace.settings.workRoot)throw new Error('请先选择总工作文件夹。');
    if(this.syncState.running||this.syncPreparing)throw new Error('正在同步案件，请同步完成后再重新判读。');
    const generation=this.generation,client=this.client,controller=new AbortController();
    const targets=this.workspace.cases.filter(c=>c.source==='baseland'&&c.remote);
    if(!targets.length)return this.state();
    const failures:string[]=[],results=new Map<string,Case['officialOutcome']>();
    await mapLimit(targets,4,async c=>{
      try{results.set(c.id,await client.officialOutcome(c,controller.signal));}
      catch(e){failures.push(c.number+' / '+(e as Error).message);}
    });
    if(generation!==this.generation)throw new Error('账号已切换，本次判读结果未保存。');
    await this.enqueuePersist(async()=>{
      this.assertKey(key);this.assertNotMigrating();
      if(generation!==this.generation)throw new Error('账号已切换，本次判读结果未保存。');
      for(const c of this.workspace.cases){
        const value=results.get(c.id);
        if(value&&c.remote){
          c.officialOutcome=value;
          await this.files().ensureCase(c);
        }
      }
      await atomicJSON(this.profileFile(),structuredClone(this.workspace));
    });
    this.changed();
    if(failures.length){
      const msg=results.size?`已判读 ${results.size} 个案件，${failures.length} 项待重试：${failures.slice(0,2).join('；')}`:`判读未能完成，${failures.length} 项待重试：${failures.slice(0,2).join('；')}`;
      throw new Error(msg);
    }
    return this.state();
  }
  async updateReferences(key:string,id:string,expected:{generation:number;root:string|undefined;process:string},added:Case['materials'],removeId?:string){
    return this.enqueuePersist(async()=>{
      this.assertKey(key);this.assertNotMigrating();if(this.syncState.running||this.syncPreparing)throw new Error('正在同步案件，请同步完成后再添加或移除材料。');const c=this.findCase(id);
      const w=currentWork(c),process=w.processId||w.roundId||`local-${w.kind}`;
      if(this.generation!==expected.generation||this.workspace.settings.workRoot!==expected.root||process!==expected.process||!editableCurrent(c)||w.kind!=='write')throw new Error('案件、账号或撰写阶段已变化，请重新选择材料。');
      if(removeId&&!c.materials?.some(m=>m.id===removeId&&m.id.startsWith('reference-')))throw new Error('仅可移除本案手动添加的参考材料。');
      const previous=c.materials;c.materials=[...(c.materials??[]).filter(m=>m.id!==removeId),...(added??[])];
      try{await this.files().ensureCase(c);await this.persist();}catch(e){c.materials=previous;throw e;}
      this.changed();
    });
  }
  async findOriginals(id:string){return this.files().findOriginals(this.findCase(id));}
  copyOriginal(id:string,source:string){
    const generation=this.generation,key=this.key,settings={...this.workspace.settings};
    const process=JSON.stringify(this.findCase(id).current);
    const check=()=>{this.assertMigrationNotAccepted();if(generation!==this.generation||key!==this.key||settings.workRoot!==this.workspace.settings.workRoot||process!==JSON.stringify(this.findCase(id).current))throw new Error('账号、目录或案件阶段已变化，请重新匹配。');};
    return this.enqueuePersist(async()=>{
      check();const c=structuredClone(this.findCase(id)),files=new CaseFiles(settings,key,false,check);
      const saved=await files.copyOriginal(c,source);check();
      c.materials=[...(c.materials??[]).filter(m=>m.id!=='original-'+digest(source)),{id:'original-'+digest(source),name:path.basename(source),role:'原始申请',location:'原始申请文件库',excerpt:'',ready:true,relativePath:saved.relativePath}];
      c.directory=saved.directory;await files.ensureCase(c,true);check();
      this.workspace.cases=this.workspace.cases.map(x=>x.id===id?c:x);await this.persist();this.changed();return this.state();
    });
  }
  async casePath(id:string,relative=''){const c=this.findCase(id);if(!c.directory)throw new Error('案件目录尚未创建。');const root=(await validateRoots(this.workspace.settings)).workRoot;if(!root)throw new Error('请先选择工作目录。');const dir=await managedPath(root,c.directory);return relative?managedPath(dir,relative):dir;}
  async shutdown(){
    this.stopping=true;
    this.controller?.abort();
    this.reauthController?.abort();
    this.abortWorkMigration();
    if(this.migrationTask)await this.migrationTask.catch(()=>{});
    if(this.syncRequest)await this.syncRequest.promise.catch(()=>{});
    this.workspace=pauseRunning(this.workspace);await this.persist();
  }
  assertMigrationPreviewAllowed(previewId:string,allowed:Set<string>){
    const prepared=this.preparedPreview;
    if(!prepared||prepared.preview.id!==previewId)throw new Error('请先预览并确认迁移。');
    if(![prepared.chosenPath,prepared.destResolved,prepared.preview.destinationRoot].some(p=>allowed.has(p)))throw new Error('请使用系统文件夹选择器设置目录。');
  }
  async previewWorkMigration(key:string,destination:string){
    this.assertKey(key);this.assertNotMigrating();
    const source=(await validateRoots(this.workspace.settings)).workRoot;
    if(!source)throw new Error('请先选择当前的总工作文件夹。');
    const dest=await validateMigrationDestination({sourceRoot:source,destination,originalLibrary:this.workspace.settings.originalLibrary});
    const scan=await scanAccountNamespace(source,this.key,new AbortController().signal);
    const preview=buildPreview({profileKey:this.key,sourceRoot:source,destinationRoot:dest.resolved,originalLibrary:dest.originalLibrary,scan});
    this.preparedPreview={preview,fingerprint:scan.fingerprint,chosenPath:destination,destResolved:dest.resolved,sourceRoot:source,profileKey:this.key};
    this.setMigration({running:false,phase:'preview',canCancel:false,preview,message:'已核对目标文件夹。确认后仅迁移当前账号工作文件。'});
    return preview;
  }
  async cancelWorkMigration(){
    this.abortWorkMigration();
    if(!this.migrationLock)this.setMigration({...this.migrationState,canCancel:false,message:this.migrationState.running?this.migrationState.message:'已取消迁移，未切换工作文件夹。'});
    return this.state();
  }
  async startWorkMigration(key:string,previewId:string){
    this.assertKey(key);
    if(this.migrationLock)throw new Error('正在迁移当前账号工作目录。');
    if(typeof previewId!=='string'||previewId.length>64)throw new Error('迁移预览无效。');
    this.migrationLock=true;
    this.migrationAbort=new AbortController();
    this.migrationTask=this.runWorkMigration(key,previewId);
    try{await this.migrationTask;}
    catch(e){
      const message=ioErrorMessage(e);
      this.migrationState={running:false,phase:'failed',canCancel:false,preview:this.preparedPreview?.preview,message,error:message};
      this.changed();
      throw new Error(message);
    }
    finally{
      this.migrationLock=false;this.migrationTask=null;this.migrationAbort=null;
    }
    if(this.migrationState.phase==='done'&&this.workspace.settings.workRoot){
      try{await this.refreshShared(this.key);}catch{/* refreshShared records its own storage message. */}
    }
    this.changed();
    return this.state();
  }
  private async runWorkMigration(key:string,previewId:string){
    const signal=this.migrationAbort?.signal??new AbortController().signal;
    const check=()=>{if(signal.aborted)throw cancelledError();if(this.key!==key)throw new Error('账号已切换，迁移未执行，未切换工作文件夹。');};
    this.setMigration({running:true,phase:'copying',canCancel:true,preview:this.preparedPreview?.preview,message:'正在等待当前目录读取结束…'});
    this.controller?.abort();
    check();
    await waitForFilesystemIdle({isBusy:()=>this.filesystemBusy(),signal});
    check();
    const prepared=this.preparedPreview;
    if(!prepared||prepared.preview.id!==previewId)throw new Error('迁移预览已失效，请重新选择目标文件夹。');
    if(prepared.profileKey!==this.key||prepared.preview.profileKey!==this.key)throw new Error('账号已切换，迁移未执行，未切换工作文件夹。');
    const currentRoot=(await validateRoots(this.workspace.settings)).workRoot;
    if(!currentRoot||currentRoot!==prepared.sourceRoot)throw new Error('当前工作文件夹已变化，请重新预览后再迁移。');
    const dest=await validateMigrationDestination({sourceRoot:currentRoot,destination:prepared.destResolved,originalLibrary:this.workspace.settings.originalLibrary});
    if(dest.resolved!==prepared.destResolved)throw new Error('目标文件夹已变化，请重新预览后再迁移。');
    const scan=await scanAccountNamespace(currentRoot,this.key,signal);
    if(scan.fingerprint!==prepared.fingerprint)throw new Error('工作文件在预览后发生了变化，请重新预览后再迁移。');
    check();
    if(scan.empty){
      this.setMigration({running:true,phase:'committing',canCancel:false,preview:prepared.preview,message:'正在保存新的总工作文件夹…'});
      await this.commitMigratedWorkRoot(key,dest.resolved);
      this.preparedPreview=null;
      this.storageState={running:false,message:'已切换到新的总工作文件夹。当前账号下没有需要复制的工作文件。'};
      this.setMigration({running:false,phase:'done',canCancel:false,preview:prepared.preview,message:'已切换到新的总工作文件夹。当前账号下没有需要复制的工作文件。'});
      return;
    }
    const stagingName=stagingDirName(prepared.preview.id);
    const stagingRoot=path.join(dest.resolved,stagingName);
    const stagedNamespace=path.join(stagingRoot,'案件',this.key);
    let published=false,createdStaging=false;
    try{
      await this.migrationTestHook?.('beforeStaging');
      try{await fs.mkdir(stagingRoot,{mode:0o700});createdStaging=true;}
      catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('目标中已有同名暂存目录，未覆盖，未切换工作文件夹。');throw e;}
      this.setMigration({running:true,phase:'copying',canCancel:true,preview:prepared.preview,progress:{copiedFiles:0,verifiedFiles:0,totalFiles:scan.fileCount,copiedBytes:0,totalBytes:scan.byteCount,currentPath:'',message:'正在复制当前账号工作文件…'},message:'正在复制当前账号工作文件…'});
      await this.migrationTestHook?.('copying');
      const records=await copyAccountNamespace({sourceRoot:scan.namespaceRoot,destRoot:stagedNamespace,scan,signal,sourceGuardRoot:currentRoot,destGuardRoot:dest.resolved,onProgress:p=>{
        this.setMigration({phase:'copying',canCancel:true,progress:{copiedFiles:p.copiedFiles,verifiedFiles:0,totalFiles:scan.fileCount,copiedBytes:p.copiedBytes,totalBytes:scan.byteCount,currentPath:p.currentPath.slice(0,300),message:'正在复制当前账号工作文件…'},message:`正在复制：${p.copiedFiles} / ${scan.fileCount} 个文件，${p.copiedBytes} / ${scan.byteCount} 字节`});
      }});
      check();
      this.setMigration({phase:'verifying',canCancel:true,message:'正在校验文件大小和内容摘要…',progress:{copiedFiles:scan.fileCount,verifiedFiles:0,totalFiles:scan.fileCount,copiedBytes:scan.byteCount,totalBytes:scan.byteCount,currentPath:'',message:'正在校验文件大小和内容摘要…'}});
      await this.migrationTestHook?.('verifying');
      await verifyCopiedNamespace({sourceRoot:scan.namespaceRoot,destRoot:stagedNamespace,scan,records,signal,sourceGuardRoot:currentRoot,destGuardRoot:dest.resolved,onProgress:p=>{
        this.setMigration({phase:'verifying',canCancel:true,progress:{copiedFiles:scan.fileCount,verifiedFiles:p.verifiedFiles,totalFiles:scan.fileCount,copiedBytes:scan.byteCount,totalBytes:scan.byteCount,currentPath:p.currentPath.slice(0,300),message:'正在校验文件大小和内容摘要…'},message:`正在校验：${p.verifiedFiles} / ${scan.fileCount} 个文件`});
      }});
      check();
      await this.migrationTestHook?.('beforePublish');
      await assertSourceUnchanged({sourceRoot:scan.namespaceRoot,scan,signal,sourceGuardRoot:currentRoot});
      await assertDestinationOnlyOwnStaging(dest.resolved,stagingName);
      this.setMigration({phase:'publishing',canCancel:false,message:'正在发布当前账号工作目录…'});
      await publishAccountNamespace(dest.resolved,stagingRoot,this.key);
      published=true;
      this.setMigration({phase:'committing',canCancel:false,message:'正在保存工作文件夹设置…'});
      try{await this.commitMigratedWorkRoot(key,dest.resolved);}
      catch{
        await rollbackAccountNamespace(dest.resolved,stagingRoot,this.key);
        published=false;
        throw new Error('工作目录设置未能保存，已撤销本次迁移发布。原工作文件夹仍在使用。');
      }
      if(createdStaging)await removeOwnStaging(stagingRoot).catch(()=>{});
      this.preparedPreview=null;
      this.storageState={running:false,message:'当前账号工作目录已迁移到新的总工作文件夹。原位置文件已保留作为备份。'};
      this.setMigration({running:false,phase:'done',canCancel:false,preview:{...prepared.preview,destinationRoot:dest.resolved},message:'当前账号工作目录已迁移。原始申请文件库未移动；原工作文件已保留作为备份。'});
    }catch(e){
      if(!published&&createdStaging)await removeOwnStaging(stagingRoot).catch(()=>{});
      throw e;
    }
  }
  private async commitMigratedWorkRoot(key:string,workRoot:string){
    this.assertKey(key);
    const nextSettings={...this.workspace.settings,workRoot};
    await atomicJSON(this.profileFile(),{...structuredClone(this.workspace),settings:nextSettings});
    this.assertKey(key);
    this.workspace.settings=nextSettings;
  }
}
