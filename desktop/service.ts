import path from 'node:path';
import { BaselandAuthError } from './baseland.ts';
import { readSharedCases } from './shared.ts';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { applyRemoteClosure, applySubmissionToCurrent, assignCurrentProcess, BaselandClient, isInternallyActiveProcess, mergePersonalRows, officialDate, profileKey, shouldQueryOfficial, SUBMISSION_REFRESH_ERROR } from './baseland.ts';
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

export type Vault={available:()=>boolean;encrypt:(text:string)=>Buffer;decrypt:(data:Buffer)=>string};
const empty=():Workspace=>({schema:1,cases:[],settings:{provider:'DeepSeek',baseUrl:'',model:''}});
export class DesktopService {
  preparePriorArt?: (c:Case,key:string,signal?:AbortSignal)=>Promise<void>;
  root:string; vault:Vault; clientFactory:(origin:string,token?:string)=>BaselandClient;
  account:Account|null=null; key='local'; workspace=empty(); client:BaselandClient|null=null;
  syncState:SyncState={running:false,message:'登录并选择工作文件夹后自动同步个人案件。'};
  storageState:StorageState={running:false,message:'选择总工作文件夹后读取本工作台的案件索引、材料和稿件。'};
  generation=0; controller:AbortController|null=null; changed:()=>void=()=>{}; loginBusy=false; syncPreparing=false;
  submissionCache=new Map<string,{at:number;submission:Submission;handId?:string;currentFlow?:CurrentFlowInfo;needSendOfficial?:boolean;canEdit?:boolean}>();
  caseClosureCache=new Map<string,{closure:Case['remoteClosure'];at:number}>();
  migrationLock=false; migrationQueued=false; migrationAbort:AbortController|null=null; migrationTask:Promise<void>|null=null;
  preparedPreview:PreparedMigration|null=null;
  migrationState:MigrationState={running:false,phase:'idle',canCancel:false,message:''};
  migrationTestHook?:(phase:'beforeStaging'|'copying'|'verifying'|'beforePublish')=>void|Promise<void>;
  flowFileWrites=0;
  private persistGate:Promise<unknown>=Promise.resolve();
  constructor(root:string,vault:Vault,clientFactory=(origin:string,token?:string)=>new BaselandClient(origin,token)) {this.root=root;this.vault=vault;this.clientFactory=clientFactory;}
  profileFile(){return path.join(this.root,'profiles',this.key,'workspace.json');}
  async init(verify=true){
    const saved=await readJSON<{key:string;account:Account;encrypted:string}|null>(path.join(this.root,'session.json'),null);
    if(saved){
      try{if(!this.vault.available())throw new Error();const token=this.vault.decrypt(Buffer.from(saved.encrypted,'base64'));this.key=saved.key;this.account={...saved.account,status:'offline'};this.client=this.clientFactory(saved.account.origin,token);}
      catch{this.account=null;this.key=saved.key;this.client=null;this.auth={phase:'unreadable',message:'本机登录凭证无法读取，请重新登录；原账号案件记录已保留。',attempts:0};}
    }
    this.workspace=normalizeWorkspace(pauseRunning(await readJSON(this.profileFile(),empty())));
    if(this.workspace.settings.workRoot)await this.refreshShared(this.key);
    if(this.client&&this.account){this.auth={phase:'verifying',message:'正在验证登录…',attempts:0};if(verify)await this.verifyLogin(true);}
  }
  auth:import('../src/desktop.ts').AuthState={phase:'signed-out',message:'未登录',attempts:0};
  private verification?:Promise<DesktopState>;
  async verifyLogin(force=false):Promise<DesktopState>{
    if(this.verification)return this.verification;
    if(!this.client||!this.account)return this.state();
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
    this.loginBusy=true;const generation=this.generation;
    try{
      const client=this.clientFactory(input.origin),account=await client.login(input.username.trim(),input.password);
      if(generation!==this.generation)throw new Error('登录操作已取消。');
      const nextKey=profileKey(account.origin,account.username);
      const nextWorkspace=normalizeWorkspace(pauseRunning(await readJSON(path.join(this.root,'profiles',nextKey,'workspace.json'),empty())));
      if(generation!==this.generation)throw new Error('登录操作已取消。');
      account.remembered=input.remember&&this.vault.available();
      const encrypted=account.remembered?this.vault.encrypt(client.token).toString('base64'):undefined;
      await this.persist();
      if(account.remembered)await atomicJSON(path.join(this.root,'session.json'),{key:nextKey,account,encrypted});
      else await fs.rm(path.join(this.root,'session.json'),{force:true});
      this.controller?.abort();this.generation++;this.verification=undefined;this.submissionCache.clear();this.caseClosureCache.clear();
      this.key=nextKey;this.client=client;this.account=account;this.workspace=nextWorkspace;this.auth={phase:'authenticated',message:'登录已验证',attempts:0,lastCheckedAt:new Date().toISOString()};
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
    this.generation++;this.verification=undefined;this.controller?.abort();this.submissionCache.clear();this.caseClosureCache.clear();await this.persist();await fs.rm(path.join(this.root,'session.json'),{force:true});
    this.client=null;this.account=null;this.auth={phase:'signed-out',message:'已退出登录',attempts:0};this.key='local';this.workspace=await readJSON(this.profileFile(),empty());
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
    const nextSettings={provider:s.provider,baseUrl:s.baseUrl,model:s.model,templatePath:s.templatePath,extensions:s.extensions, ...roots};
    // Publish settings in memory only after the atomic disk write succeeds.
    await atomicJSON(this.profileFile(),{...structuredClone(this.workspace),settings:nextSettings});
    this.assertKey(key);this.workspace.settings=nextSettings;
    this.storageState={running:false,message:roots.workRoot?(this.syncState.running?'目录设置已保存；正在同步，可在同步完成后刷新读取。':'目录设置已保存，准备读取工作目录。'):roots.originalLibrary?'原始申请文件库已保存；请选择总工作文件夹。':'请选择原始申请文件库和总工作文件夹。'};
    this.changed();return this.state();
  }
  async refreshShared(key:string){
    this.assertKey(key);this.assertNotMigrating();if(this.syncState.running)throw new Error('正在同步贝思兰德，请完成后再读取工作目录。');
    this.storageState={...this.storageState,running:true,message:'正在读取工作目录中的案件与稿件…'};this.changed();
    try{
      const {workRoot}=await validateRoots(this.workspace.settings);if(!workRoot)throw new Error('请先选择总工作文件夹。');
      const result=await readSharedCases(workRoot,key,this.workspace.cases);this.assertKey(key);
      this.workspace.cases=result.cases;await this.persist();
      this.storageState={running:false,lastAt:new Date().toISOString(),caseCount:result.count,message:`已读取 ${result.count} 个本工作台案件。`+(result.warnings.length?`${result.warnings.length} 个目录需核对：${result.warnings.slice(0,2).join('；')}`:result.count?'材料与工作稿已更新；本机对话和任务不从共享目录导入。':'新案件将在此创建；普通文件夹不会自动当作案件。')};
    }catch(e){if(key!==this.key)return this.state();this.storageState={running:false,message:'工作目录未读取完成：'+(e as Error).message};}
    this.changed();return this.state();
  }
  async save(key:string,incoming:Workspace){
    this.assertKey(key);this.assertNotMigrating();if(incoming.schema!==1||!Array.isArray(incoming.cases))throw new Error('案件记录格式不正确。');
    return this.enqueuePersist(()=>this.saveNow(key,incoming));
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
    this.workspace={...this.workspace,cases:this.workspace.cases.map(c=>{const changed=next.cases.find(x=>x.id===c.id);if(!changed)return c;return {...c,archived:changed.archived,tags:changed.tags,...(c.source==='local'?{title:changed.title,deadline:changed.deadline}:{}),...(c.current?.processId===changed.current?.processId?{localDraft:changed.localDraft,localVersions:changed.localVersions,directory:changed.directory,sharedDraftHash:changed.sharedDraftHash}:{})};})};
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
  async sync(){
    this.assertNotMigrating();
    if(this.syncState.running||this.syncPreparing)return this.state();
    if(!this.client||this.account?.status!=='authenticated')throw new Error('请先登录贝思兰德。');
    if(!this.workspace.settings.workRoot)throw new Error('请先选择总工作文件夹。');
    const startingKey=this.key,startingGeneration=this.generation;this.syncPreparing=true;
    try{await this.refreshShared(startingKey);}finally{this.syncPreparing=false;}
    if(this.migrationLock||startingKey!==this.key||startingGeneration!==this.generation)return this.state();
    const key=this.key,generation=this.generation,client=this.client,controller=new AbortController();this.controller=controller;
    this.syncState={...this.syncState,running:true,message:'正在查询个人案件并保存新材料…'};this.changed();
    try{
      const rows=await client.personalCases(controller.signal);if(generation!==this.generation)return this.state();
      const cases=mergePersonalRows(rows,this.workspace.cases,new Date().toISOString());const failures:string[]=[];
      const rowByProc=new Map(rows.map(r=>[String(r.CaseProcId),r]));
      for(const c of cases){
        if(controller.signal.aborted||generation!==this.generation)return this.state();
        let closure:Case['remoteClosure'];
        if(c.remote){
          // 已结案件（finished=true）5 分钟内复用上次 caseClosure 结果，避免每轮 sync 都对每案调 GetUpdateCaseInfo；
          // 未结案件每轮查（及时检测结案）。结案后不会撤销，缓存安全。
          const cacheKey=c.remote.caseId,cached=this.caseClosureCache.get(cacheKey);
          if(cached&&cached.closure?.finished&&Date.now()-cached.at<5*60*1000){closure=cached.closure;}
          else{try{closure=await client.caseClosure(c,controller.signal);if(closure?.finished)this.caseClosureCache.set(cacheKey,{closure,at:Date.now()});}catch(e){if(controller.signal.aborted)return this.state();failures.push(c.number+' / 结案核验：'+(e as Error).message);}}
        }
        const currentProc=c.remote?.processes.find(p=>p.id===c.current?.processId);
        if(currentProc&&shouldQueryOfficial(currentProc,rowByProc.get(currentProc.id)))await this.refreshProcessOfficial(c,currentProc,client,controller.signal,generation,false);
        if(generation!==this.generation)return this.state();
        c.directory=await this.files().ensureCase(c);
        if(c.remote)for(const p of c.remote.processes){
          // 非当前办理流程、且该流程已有材料全部就绪时，本轮跳过文件列表查询，减少无效 GetCaseProcFileList 调用。
          // 当前办理流程必查（最可能有新文件）；首次同步（无 round 或材料未就绪）也会查；手动刷新或退出重登可重新拉取全量。
          const round=c.rounds.find(r=>r.id==='proc-'+p.id);
          if(round&&c.current?.processId!==p.id&&round.materials.length>0&&round.materials.every(m=>m.ready))continue;
          try{
            const list=await client.files(p.id,controller.signal);
            for(const f of list){
              if(!f.FileNo||!f.FileName)continue;const id='file-'+String(f.FileNo),r=c.rounds.find(r=>r.id==='proc-'+p.id);
              const existing=[...(c.materials??[]),...c.rounds.flatMap(r=>r.materials)].find(m=>m.id===id);
              if(existing?.ready)continue;
              const m={id,name:String(f.FileName),fileNo:String(f.FileNo),role:/通知|审查意见|补正/.test(f.FileName)?'通知书':'系统材料',location:p.name,excerpt:'',ready:false,relativePath:undefined as string|undefined};
              try{const data=await client.download(m.fileNo,controller.signal);if(generation!==this.generation)return this.state();const saved=await this.files().writeMaterial(c,path.join('01_通知与材料',safeName(p.name,24)+'__'+digest(p.id).slice(0,8)),m.fileNo,m.name,data);m.relativePath=saved.relativePath;m.ready=true;}
              catch(e){if(controller.signal.aborted)return this.state();failures.push(m.name+'：'+(e as Error).message);}
              if(r)r.materials=[...r.materials.filter(x=>x.id!==id),m];else c.materials=[...(c.materials??[]).filter(x=>x.id!==id),m];
            }
          }catch(e){if(controller.signal.aborted)return this.state();failures.push(c.number+' / '+p.name+'：'+(e as Error).message);}
        }
        if(this.workspace.settings.originalLibrary&&!c.materials?.some(m=>m.role==='原始申请')){
          try{const choices=await this.files().findOriginals(c);if(choices.length===1){const saved=await this.files().copyOriginal(c,choices[0].id);c.materials=[...(c.materials??[]),{id:'original-'+digest(choices[0].id),name:choices[0].name,role:'原始申请',location:'原始申请文件库',excerpt:'',ready:true,relativePath:saved.relativePath}];}}
          catch(e){failures.push(c.number+'：'+(e as Error).message);}
        }
        if(this.preparePriorArt)try{await this.preparePriorArt(c,key,controller.signal);}catch(e){failures.push(c.number+" / 对比文件："+(e as Error).message);}
        // Commit one complete case at a time, preserving edits made while network work ran.
        if(generation!==this.generation)return this.state();
        const latest=this.workspace.cases.find(x=>x.id===c.id);
        if(latest&&latest.current?.processId===c.current?.processId){c.localDraft=latest.localDraft;c.localVersions=latest.localVersions;c.sharedDraftHash=latest.sharedDraftHash;c.archived=latest.archived;c.tags=latest.tags;}
        applyRemoteClosure(c,closure);
        if(c.localDraft!==undefined)await this.files().saveDraft(c);else await this.files().ensureCase(c);
        if(generation!==this.generation)return this.state();
        this.workspace.cases=[...this.workspace.cases.filter(x=>x.id!==c.id),c];await this.persist();
      }
      this.assertKey(key);this.syncState={running:false,lastAt:new Date().toISOString(),message:failures.length?`案件已保存，${failures.length} 项需重试：${failures.slice(0,3).join('；')}`:`已同步 ${rows.length} 条流程，归并为 ${cases.filter(c=>c.remote).length} 个案件。`};
    }catch(e){if(generation===this.generation){this.syncState={...this.syncState,running:false,message:(e as Error).message};if(e instanceof BaselandAuthError&&this.account){this.account.status=e.kind==='expired'?'expired':'offline';this.auth={phase:e.kind,message:e.kind==='expired'?'登录已过期，请重新登录。':'当前账号无权访问，请核对权限。',attempts:0,lastCheckedAt:new Date().toISOString()};}}}
    finally{if(generation===this.generation){this.syncState.running=false;this.changed();}}
    return this.state();
  }
  private officialCacheKey(c:Case,processId:string){return `${c.remote?.caseId??c.id}\0${processId}`;}
  async refreshProcessOfficial(c:Case,p:RemoteProcess,client:BaselandClient,signal:AbortSignal,generation:number,force:boolean) {
    const key=this.officialCacheKey(c,p.id);
    const cached=this.submissionCache.get(key);
    if(!force&&cached&&Date.now()-cached.at<5*60*1000){
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
      this.submissionCache.set(key,{at:Date.now(),submission:official.submission,handId:official.handId,currentFlow:official.currentFlow,needSendOfficial:official.needSendOfficial,canEdit:official.canEdit});
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
    const selectedId=blocked?undefined:view.currentProcessId&&personalIds.includes(view.currentProcessId)?view.currentProcessId:internallyActive.length>1?undefined:keepId;
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
    }else if(!blocked&&internallyActive.length>1){
      stageChanged=!!keepId;
      assignCurrentProcess(latest,undefined,view.at);
    }else applyCaseDeadline(latest);
    return stageChanged;
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
    const run=enqueueWrite??(fn=>this.enqueuePersist(fn));
    return run(commit);
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
      this.flowFileWrites++;
      try { await this.files().ensureCase(latest); await atomicJSON(this.profileFile(),structuredClone(this.workspace)); this.changed(); return this.state(); }
      finally { this.flowFileWrites--; }
    });
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
  async copyOriginal(id:string,source:string){this.assertNotMigrating();const c=this.findCase(id),saved=await this.files().copyOriginal(c,source);c.materials=[...(c.materials??[]).filter(m=>m.id!=='original-'+digest(source)),{id:'original-'+digest(source),name:path.basename(source),role:'原始申请',location:'原始申请文件库',excerpt:'',ready:true,relativePath:saved.relativePath}];await this.files().ensureCase(c);await this.persist();this.changed();return this.state();}
  async casePath(id:string,relative=''){const c=this.findCase(id);if(!c.directory)throw new Error('案件目录尚未创建。');const root=(await validateRoots(this.workspace.settings)).workRoot;if(!root)throw new Error('请先选择工作目录。');const dir=await managedPath(root,c.directory);return relative?managedPath(dir,relative):dir;}
  async shutdown(){
    this.controller?.abort();
    this.abortWorkMigration();
    if(this.migrationTask)await this.migrationTask.catch(()=>{});
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
