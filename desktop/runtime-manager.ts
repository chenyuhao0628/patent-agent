import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, managedPath } from './files.ts';
import type { AgentRunner } from './agent-contract.ts';
import { engineAdapters } from './engine-adapters.ts';
import { downloadRuntime, latestRuntimeRelease, newerVersion, runtimeFileHash, stableRuntimeVersion, type InstalledRuntime, type RuntimeRelease } from './runtime-download.ts';
import { verifyOpenCodeRuntime } from './runtime-acceptance.ts';
import type { EngineRuntimeStatus } from '../src/domain/engine-runtime.ts';

type RuntimeState = { schema: 1; automatic: boolean; active?: InstalledRuntime; previous?: InstalledRuntime; candidate?: InstalledRuntime; checkedAt?: string; error?: string; rejected: string[]; rejectedReleases?: Record<string,string> };
type Options = {
  root: string; bundled: InstalledRuntime;
  latest?: (signal: AbortSignal) => Promise<RuntimeRelease>;
  download?: typeof downloadRuntime;
  verify?: (binary: string, options: {signal: AbortSignal}) => Promise<{version:string}>;
  intervalMs?: number;
  startAutomaticChecks?: boolean;
  createRunner?: (runtime: InstalledRuntime) => AgentRunner;
};
const FAILURE_CODES = new Set(['runtime_incompatible', 'server_exited', 'process_error', 'health_timeout']);

export class RuntimeManager implements AgentRunner {
  private readonly options: Options;
  private state: RuntimeState = { schema: 1, automatic: true, rejected: [] };
  private phase: EngineRuntimeStatus['state'] = 'idle';
  private activeRuns = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private checking?: Promise<EngineRuntimeStatus>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly stop = new AbortController();
  private closed = false;
  constructor(options: Options) { this.options = options; }
  private locked<T>(fn: () => Promise<T>): Promise<T> { const next = this.serial.then(fn, fn); this.serial = next.catch(() => {}); return next; }
  private get file() { return path.join(this.options.root, 'state.json'); }
  private current() { return this.state.active ?? this.options.bundled; }
  private save() { return atomicJSON(this.file, this.state); }
  status(): EngineRuntimeStatus {
    return { automatic: this.state.automatic, state: this.state.candidate ? 'pending' : this.phase, activeVersion: this.current().version, previousVersion: this.state.previous?.version, candidateVersion: this.state.candidate?.version, activeRuns: this.activeRuns, checkedAt: this.state.checkedAt, error: this.state.error };
  }
  async init() {
    await fs.mkdir(this.options.root, {recursive:true,mode:0o700});
    if ((await fs.lstat(this.options.root)).isSymbolicLink()) throw new Error('运行时更新目录不能是符号链接。');
    let raw: RuntimeState | undefined;
    try { raw = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('运行时更新记录损坏，原记录已保留。'); }
    if (raw) {
      if (raw.schema !== 1 || typeof raw.automatic !== 'boolean' || !Array.isArray(raw.rejected) || raw.rejected.some(x => typeof x !== 'string')) throw new Error('运行时更新记录格式无效。');
      this.state = raw;
      for (const key of ['active','previous','candidate'] as const) if (this.state[key]) {
        try { await this.validateInstalled(this.state[key]!); }
        catch { if (key === 'active') this.state.error = '已下载运行时缺失或摘要变化，已回退到捆绑版本。'; delete this.state[key]; }
      }
      if (this.state.active && newerVersion(this.options.bundled.version, this.state.active.version)) {
        this.state.previous=this.state.active; delete this.state.active;
        if(this.state.candidate&&!newerVersion(this.state.candidate.version,this.options.bundled.version))delete this.state.candidate;
      }
    }
    await this.activateIfIdle(); await this.save();
    if (this.options.startAutomaticChecks !== false) {
      this.timer = setInterval(() => { if (this.state.automatic) void this.check().catch(() => {}); }, this.options.intervalMs ?? 6 * 60 * 60 * 1_000); this.timer.unref();
      if (this.state.automatic) void this.check().catch(() => {});
    }
  }
  private async validateInstalled(runtime: InstalledRuntime) {
    if (!stableRuntimeVersion(runtime.version) || !/^[a-f\d]{64}$/.test(runtime.sha256)) throw new Error('运行时记录无效。');
    if (runtime.source === 'bundled') {
      if (runtime.binaryPath !== this.options.bundled.binaryPath || runtime.sha256 !== this.options.bundled.sha256) throw new Error('捆绑运行时记录过期。');
    } else {
      if (runtime.source !== 'update') throw new Error('运行时来源无效。');
      const relative = path.relative(this.options.root, runtime.binaryPath);
      if (await managedPath(this.options.root, relative) !== path.resolve(runtime.binaryPath)) throw new Error('运行时路径无效。');
    }
    const stat = await fs.lstat(runtime.binaryPath);
    if (stat.isSymbolicLink() || !stat.isFile() || await runtimeFileHash(runtime.binaryPath) !== runtime.sha256) throw new Error('运行时摘要不匹配。');
  }
  private async activateIfIdle() {
    if (this.closed || this.activeRuns || !this.state.candidate) return;
    const next = this.state.candidate;
    await this.validateInstalled(next);
    const previous = this.current();
    const state = {...this.state, active:next, previous}; delete state.candidate;
    await atomicJSON(this.file,state); this.state=state; this.phase = 'idle';
  }
  async automatic(value: boolean) { return this.locked(async () => { this.state.automatic = value; await this.save(); return this.status(); }); }
  async rollback() {
    return this.locked(async () => {
      if (!this.state.previous) throw new Error('没有可回退的运行时。');
      this.state.rejected = [...new Set([...this.state.rejected, this.current().sha256])].slice(-32);
      this.state.candidate = this.state.previous;
      await this.activateIfIdle(); await this.save(); return this.status();
    });
  }
  check(): Promise<EngineRuntimeStatus> {
    if (this.checking) return this.checking;
    if (this.closed) return Promise.resolve(this.status());
    this.checking = this.performCheck().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async performCheck() {
    let staging: string | undefined;
    let release: RuntimeRelease | undefined, candidate: InstalledRuntime | undefined;
    try {
      this.phase = 'checking';
      release = await (this.options.latest ?? latestRuntimeRelease)(this.stop.signal);
      if (!stableRuntimeVersion(release.version)) throw new Error('官方更新版本格式无效。');
      if (!newerVersion(release.version, this.current().version) || this.state.candidate?.version === release.version || this.state.rejectedReleases?.[release.version] === release.integrity) {
        await this.locked(async () => { this.state.checkedAt = new Date().toISOString(); this.phase = 'idle'; await this.save(); });
        return this.status();
      }
      this.phase = 'downloading';
      staging = await fs.mkdtemp(path.join(this.options.root, '.candidate-'));
      candidate = await (this.options.download ?? downloadRuntime)(release, staging, this.stop.signal);
      await this.validateInstalled(candidate);
      if (this.state.rejected.includes(candidate.sha256)) {
        await this.locked(async()=>{this.state.rejectedReleases={...this.state.rejectedReleases,[release!.version]:release!.integrity};this.phase='idle';this.state.checkedAt=new Date().toISOString();await this.save();});
        return this.status();
      }
      this.phase = 'verifying';
      const report = await (this.options.verify ?? verifyOpenCodeRuntime)(candidate.binaryPath, {signal:this.stop.signal});
      if (report.version !== candidate.version) throw new Error('下载元数据与实际运行时版本不一致。');
      this.stop.signal.throwIfAborted();
      const installed = await managedPath(this.options.root, `versions/${candidate.version}-${candidate.sha256.slice(0,16)}`);
      await fs.mkdir(path.dirname(installed), {recursive:true,mode:0o700});
      try { await fs.rename(staging, installed); staging=undefined; }
      catch (error) { if (!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      const entry = {...candidate,binaryPath:path.join(installed,path.basename(candidate.binaryPath))};
      await this.validateInstalled(entry);
      await this.locked(async () => {
        // A manual rollback while this candidate was checked takes precedence.
        if(this.state.rejected.includes(entry.sha256))return;
        this.state.candidate = entry; this.state.checkedAt = new Date().toISOString(); delete this.state.error;
        await this.activateIfIdle(); await this.save();
      });
    } catch (error) {
      if (!this.closed) await this.locked(async () => {
        if(this.phase==='verifying'&&candidate&&release){this.state.rejected=[...new Set([...this.state.rejected,candidate.sha256])].slice(-32);this.state.rejectedReleases={...this.state.rejectedReleases,[release.version]:release.integrity};}
        this.phase = 'idle'; this.state.checkedAt = new Date().toISOString();
        this.state.error = error instanceof Error && error.message.startsWith('OpenCode 兼容性检查') ? error.message.slice(0,200) : '运行时更新未通过下载或兼容性检查，继续使用当前版本。';
        await this.save();
      });
    } finally { if (staging) await fs.rm(staging, {recursive:true,force:true}); }
    return this.status();
  }
  async acquire() {
    return this.locked(async () => {
      if (this.closed) throw new Error('后台运行时正在退出。');
      await this.activateIfIdle(); const runtime = {...this.current()}; this.activeRuns++;
      let released = false;
      return { ...runtime, release: async () => {
        if (released) return; released = true;
        await this.locked(async () => { this.activeRuns--; await this.activateIfIdle(); });
      } };
    });
  }
  async run(input: Parameters<AgentRunner['run']>[0]) {
    const lease = await this.acquire();
    try {
      const runner=this.options.createRunner?.(lease)??engineAdapters.create('opencode',{binaryPath:lease.binaryPath,runtimeIdentity:lease.sha256});
      const result = await runner.run(input);
      if (result.status === 'failed' && FAILURE_CODES.has(result.error?.code ?? '') && this.current().sha256 === lease.sha256 && this.state.previous) {
        await this.locked(async () => {
          this.state.rejected = [...new Set([...this.state.rejected, lease.sha256])].slice(-32);
          this.state.candidate = this.state.previous; this.state.error = '后台运行时异常，任务记录已保留；空闲后回退上一版本，后续任务可继续。'; await this.save();
        });
      }
      return result;
    } finally { await lease.release(); }
  }
  async shutdown() { this.closed=true; this.stop.abort(); if(this.timer)clearInterval(this.timer); await this.checking?.catch(()=>{}); await this.serial; }
}

export async function bundledRuntimeRecord(binaryPath: string): Promise<InstalledRuntime> {
  let directory=path.dirname(binaryPath), manifest: {version?:string;files?:Array<{sha256?:string;file?:string}>} | undefined;
  for(let i=0;i<3;i++) {
    try { manifest=JSON.parse(await fs.readFile(path.join(directory,'runtime-manifest.json'),'utf8'));break; }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; directory=path.dirname(directory); }
  }
  if(!stableRuntimeVersion(manifest?.version))throw new Error('请使用包含 OpenCode v2 的安装包。');
  const sha256=await runtimeFileHash(binaryPath);
  if(!manifest.files?.some(row=>row.sha256===sha256&&path.resolve(directory,row.file??'')===path.resolve(binaryPath)))throw new Error('捆绑 OpenCode 摘要与清单不一致。');
  return {version:manifest.version,sha256,binaryPath:path.resolve(binaryPath),source:'bundled'};
}
