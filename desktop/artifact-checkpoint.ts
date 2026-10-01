import fs from 'node:fs/promises';
import {atomicJSON, managedPath, digest, readBoundedFile} from './files.ts';

// An execution-local checkpoint, never a published/adopted manuscript.
export class ArtifactCheckpoint {
  private value: Record<string, unknown> = {};
  readonly root: string; readonly identity: string;
  recovery: {status:'none'|'restored'|'legacy'|'unavailable';note?:string}={status:'none'};
  constructor(root: string, identity: string) { this.root=root; this.identity=identity; }
  snapshot(): Record<string, unknown> { return structuredClone(this.value); }
  descriptor(){return Object.keys(this.value).length?{relativePath:'artifact-checkpoint.json',hash:digest(JSON.stringify(this.value))}:undefined;}
  async restore(source = this.root): Promise<void> {
    try {
      if((await fs.lstat(source)).isSymbolicLink())throw new Error('检查点目录不能是符号链接');
      const file = await managedPath(source, 'artifact-checkpoint.json');
      const stored = JSON.parse((await readBoundedFile(file,2_000_000)).toString('utf8'));
      if (stored.identity !== this.identity) {this.recovery={status:'unavailable',note:'任务范围或材料版本已变化，旧内容保留；本次从当前要求继续。'};return;}
      if (!stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value) || ![1,2].includes(stored.schema))throw new Error('检查点格式无效');
      if(stored.schema===2&&stored.hash!==digest(JSON.stringify(stored.value)))throw new Error('检查点摘要不匹配');
      this.value = stored.value;
      this.recovery={status:stored.schema===2?'restored':'legacy',note:stored.schema===2?'已恢复摘要匹配的分项内容，完成前仍按当前规则核对。':'已找回旧版分项内容，旧记录没有摘要，需重新核对后保存。'};
      if (source !== this.root) await this.save(this.value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')this.recovery={status:'unavailable',note:'旧检查点无法核验，原文件保留；本次仍可重新保存所需内容。'};
    }
  }
  async save(value: Record<string, unknown>): Promise<void> {
    await atomicJSON(await managedPath(this.root, 'artifact-checkpoint.json', true), {schema: 2, identity: this.identity, hash:digest(JSON.stringify(value)),value});
    this.value = structuredClone(value);
  }
  async merge(patch: unknown): Promise<Record<string, unknown>> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('分项保存的 content 必须是对象。');
    const keys = new Set(['kind','strategyId','draftVersionId','body','amendmentText','amendmentBasis','reviewNotes','applicationParts','correctionContents','opinions','strategies','modelSelectedStrategyId','summary','issues','reply','text','documents','evidenceCitations','opinionResponses']);
    for (const key of Object.keys(patch)) if (!keys.has(key)) throw new Error('未知产物字段：'+key+'。请按当前任务的产物格式保存。');
    const p=patch as Record<string,unknown>, next = {...this.value, ...p};
    if(p.documents&&typeof p.documents==='object'&&!Array.isArray(p.documents))next.documents={...(this.value.documents as object??{}),...p.documents};
    await this.save(next);
    return this.snapshot();
  }
}
