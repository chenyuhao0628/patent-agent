import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicJSON, digest } from './files.ts';
import { normalizeWorkspace } from '../src/domain/lifecycle.ts';
import { pauseRunning, type Case, type Settings, type Workspace } from '../src/domain/workflow.ts';
import { caseFromRecord, caseRecordFromCase, caseRecordsFromStoredWorkspace, preserveRecordFields, validLegacyCases, type CaseRecord, type StoredCaseWorkspace } from '../src/domain/case-record.ts';

const empty = (): Workspace => ({schema:1,cases:[],settings:{provider:'DeepSeek',baseUrl:'',model:''}});
type StoredProfileWorkspace = Partial<StoredCaseWorkspace> & { cases?: Case[]; profile?: string };
export type ProfileLoad = { workspace: Workspace; needsPersist: boolean; needsBackup: boolean; unsafe: boolean; message?: string };
function objectOf(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined; }

/** All private case-record serialization is owned here. Business operations
 * retain their scope and file guards; adapters cannot grant write authority. */
export interface WorkspaceRepository {
  readonly id: string;
  readonly contractVersion: 1;
  file(profileKey: string): string;
  load(profileKey: string): Promise<ProfileLoad>;
  save(profileKey: string, workspace: Workspace, guard: () => void): Promise<void>;
  record(profileKey: string, item: Case): CaseRecord;
}

export class FileWorkspaceRepository implements WorkspaceRepository {
  readonly id = 'local-files';
  readonly contractVersion = 1 as const;
  readonly root: string;
  private profileRecords = new Map<string, CaseRecord[]>();
  private profileExtras = new Map<string, Record<string, unknown>>();
  private blocked = new Set<string>();
  constructor(root: string) { this.root = root; }
  file(key: string) {
    if (!/^[\w-]+$/.test(key)) throw new Error('账号标识无效。');
    return path.join(this.root,'profiles',key,'workspace.json');
  }
  record(key: string, item: Case) { return preserveRecordFields(this.profileRecords.get(key)?.find(r=>r.identity.id===item.id),caseRecordFromCase(item)); }
  async load(key:string):Promise<ProfileLoad>{
    const file=this.file(key);
    const unsafe=(reason:string,workspace=empty()):ProfileLoad=>{this.blocked.add(key);return ({
      workspace,needsPersist:false,needsBackup:false,unsafe:true,
      message:`本机案件记录未能安全读取（${reason}），原文件已保留；请先备份后再迁移。`,
    });};
    let raw:unknown;
    let exists=true;
    try{raw=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){
      if((e as NodeJS.ErrnoException).code==='ENOENT'){
        exists=false;
        raw={schema:1,settings:empty().settings,cases:[]};
      }else return unsafe('本机记录无法读取');
    }
    const stored=objectOf(raw) as StoredProfileWorkspace|undefined;
    if(!stored||stored.schema!==1||!objectOf(stored.settings))return unsafe('工作区结构无效');
    if(stored.profile!==undefined&&stored.profile!==key)return unsafe('账号工作区标识不匹配');
    const rawSettings=stored?.settings;
    const rawCases=stored?.cases;
    const legacyValid=validLegacyCases(rawCases);
    const legacy:Workspace={
      schema:1,
      cases:legacyValid?rawCases:[],
      settings:typeof rawSettings==='object'&&rawSettings ? rawSettings as Settings : empty().settings,
    };
    let normalized:Workspace;
    try{
      normalized=normalizeWorkspace(pauseRunning(legacy));
    }catch{return unsafe('旧版案件记录结构不完整');}
    this.profileExtras.set(key,Object.fromEntries(Object.entries(stored).filter(([name])=>!['schema','profile','settings','cases','caseRecords','caseRecordsSchema','caseRecordsHash'].includes(name))));
    const hasRecords=!!stored&&Object.prototype.hasOwnProperty.call(stored,'caseRecords');
    if(!hasRecords){
      if(!legacyValid)return unsafe('旧版案件记录结构不完整');
      this.blocked.delete(key);
      this.profileRecords.set(key,[]);
      return {workspace:normalized,needsPersist:true,needsBackup:exists,unsafe:false};
    }
    const profileMatches=stored?.profile===key;
    const records=caseRecordsFromStoredWorkspace(stored?.caseRecords);
    const hashIsValid=Array.isArray(stored?.caseRecords)
      && stored?.caseRecordsSchema===1
      && typeof stored.caseRecordsHash==='string'
      && !!stored.caseRecordsHash
      && digest(JSON.stringify(stored.caseRecords))===stored.caseRecordsHash;
    if(!profileMatches||!records||!hashIsValid){
      const reason=!profileMatches?'账号工作区标识不匹配':!records?'案件领域记录结构不完整':'案件领域记录摘要校验失败';
      // A damaged canonical envelope must never be replaced by a derived
      // legacy projection on startup. The caller can still inspect the
      // legacy snapshot, but the original bytes remain untouched.
      return unsafe(reason,normalized);
    }
    if(rawCases!==undefined&&(!legacyValid||rawCases.length!==records.length||rawCases.some(c=>!records.some(r=>r.identity.id===c.id))))return unsafe('领域记录与兼容案件索引不完整或冲突',normalized);
    if(legacyValid&&rawCases.some(c=>{
      const record=records.find(r=>r.identity.id===c.id)!;
      const canonical=caseRecordFromCase(caseFromRecord(record)),compatible=caseRecordFromCase(c);
      return !isDeepStrictEqual(JSON.parse(JSON.stringify(canonical)),JSON.parse(JSON.stringify(compatible)));
    }))return unsafe('领域记录与兼容稿件内容冲突',normalized);
    this.blocked.delete(key);
    this.profileRecords.set(key,records);
    const rebuilt={
      ...normalized,
      cases:records.map(record=>{
        const base=normalized.cases.find(candidate=>candidate.id===record.identity.id);
        return normalizeWorkspace({
          schema:1,
          cases:[caseFromRecord(record,base)],
          settings:normalized.settings,
        }).cases[0];
      }),
    };
    // Startup recovery pauses jobs from canonical records as well. The
    // compatibility projection can never reintroduce running work.
    return {
      workspace:normalizeWorkspace(pauseRunning(rebuilt)),
      needsPersist:stored.profile!==key,
      needsBackup:stored.profile!==key,
      unsafe:false,
    };
  }

  async save(key: string, workspace: Workspace, guard: () => void) {
    guard();
    if (this.blocked.has(key)) throw new Error('本机案件领域记录未通过安全校验，未写入；请先备份并修复原文件。');
    const snapshot=structuredClone(workspace);
    const previous=this.profileRecords.get(key);
    const records=snapshot.cases.map(c=>preserveRecordFields(previous?.find(r=>r.identity.id===c.id),caseRecordFromCase(c)));
    const hash=digest(JSON.stringify(records));
    const stored:StoredCaseWorkspace={...this.profileExtras.get(key),schema:1,profile:key,settings:snapshot.settings,
      caseRecords:records,caseRecordsSchema:1,caseRecordsHash:hash,cases:records.map(r=>caseFromRecord(r))};
    await atomicJSON(this.file(key),stored,guard);
    guard();this.profileRecords.set(key,records);
  }
}
