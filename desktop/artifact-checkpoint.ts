import * as fs from 'node:fs/promises';
import {atomicJSON, managedPath} from './files.ts';

// An execution-local checkpoint, never a published/adopted manuscript.
export class ArtifactCheckpoint {
  private value: Record<string, unknown> = {};
  private root: string;
  private identity: string;
  constructor(root: string, identity: string) { this.root=root; this.identity=identity; }
  snapshot(): Record<string, unknown> { return structuredClone(this.value); }
  async restore(source = this.root): Promise<void> {
    try {
      const file = await managedPath(source, 'artifact-checkpoint.json');
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      if (stored.identity !== this.identity || !stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value)) return;
      this.value = stored.value;
      if (source !== this.root) await this.save(this.value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async save(value: Record<string, unknown>): Promise<void> {
    await atomicJSON(await managedPath(this.root, 'artifact-checkpoint.json', true), {schema: 1, identity: this.identity, value});
    this.value = structuredClone(value);
  }
  async merge(patch: unknown): Promise<Record<string, unknown>> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('分项保存的 content 必须是对象。');
    const keys = new Set(['kind','strategyId','draftVersionId','body','amendmentText','amendmentBasis','reviewNotes','applicationParts','correctionContents','opinions','strategies','modelSelectedStrategyId','summary','issues','reply']);
    for (const key of Object.keys(patch)) if (!keys.has(key)) throw new Error(`未知产物字段：${key}。请按当前任务的产物格式保存。`);
    const next = {...this.value, ...patch};
    await this.save(next);
    return this.snapshot();
  }
}
