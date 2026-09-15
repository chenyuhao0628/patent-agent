import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Case, Settings } from '../src/domain/workflow.ts';
import { currentWork, processBusinessKind } from '../src/domain/lifecycle.ts';
import { atomicJSON, digest, managedPath, portable, safeName, validateRoots } from './files.ts';

export type FolderOrganizationReport = {
  renamedFolders: number;
  renamedFiles: number;
  skippedFiles: number;
  unknownPaths: string[];
  conflicts: string[];
  cases: number;
  message: string;
};
export type FolderOrganizationCaseChange = {
  caseId: string;
  oldDirectory: string;
  newDirectory: string;
  replacements: Array<[string, string]>;
};

type Rename = { from: string; to: string };
type ManifestUpdate = { oldFile: string; newFile: string; value: unknown };

const fixed = new Set(['00_原始申请', '01_通知与材料', '02_工作稿', '03_定稿', '04_内部说明']);
const generatedIndex = /^(agent-(?:run|final)-|transfer-)/i;
const identitySuffix = /(?:__|[-_])[a-f0-9]{8,64}(?=\.[^.]+$|$)/i;

function cleanFileName(name: string) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext).replace(/^agent-(?:run|final)-[a-f0-9-]+$/i, '任务记录');
  return safeName(stem.replace(identitySuffix, '').replace(/(?:__|[-_])[a-f0-9]{8,64}(?=(?:__|[-_]|$))/gi, ''), 76) + ext.toLowerCase();
}

function categoryFor(c: Case, folder: string): string | undefined {
  const base = folder.replace(identitySuffix, '');
  const process = c.remote?.processes.find(p => base.includes(safeName(p.name, 24)))
    ?? c.rounds.find(r => base.includes(safeName(r.name, 24)));
  const name = process?.name ?? base;
  const kind = processBusinessKind(name);
  if (kind === 'write' || c.current?.kind === 'write' && /撰写|申请/.test(name)) return '撰写';
  if (kind === 'correction' || c.current?.kind === 'correction' && /补正/.test(name)) return '答复补正';
  if (kind === 'reply' || c.current?.kind === 'reply' && /答复|审查意见|复审/.test(name)) return '答复审查意见';
  if (/撰写|申请/.test(name)) return '撰写';
  if (/补正/.test(name)) return '答复补正';
  if (/答复|审查意见|复审/.test(name)) return '答复审查意见';
  return undefined;
}

function caseLabel(c: Case) {
  return safeName(`${c.companyName?.trim() || '客户未填写'}+${c.title}+${c.type || '专利'}`, 100);
}

function targetFolder(c: Case, folder: string, section: string, used: Set<string>) {
  const category = categoryFor(c, folder);
  if (!category) return;
  const base = `${category}+${safeName(c.title, 48)}`;
  let target = base;
  let n = 2;
  while (used.has(`${section}/${target}`)) target = `${base}+第${n++}次`;
  used.add(`${section}/${target}`);
  return target;
}

function historicalFolderName(folder: string, used: Set<string>) {
  const withoutDate = folder.replace(/^\d{4}-\d{2}-\d{2}(?:[_-]\d{2}-\d{2}-\d{2}(?:-\d+)?)?_/, '');
  const base = safeName(withoutDate.replace(identitySuffix, ''), 54);
  if (!base || base === folder) return;
  let target = base; let n = 2;
  while (used.has(target)) target = `${base}+第${n++}版`;
  used.add(target);
  return target;
}

async function listDirectories(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name);
}

function replacePath(value: string, replacements: Map<string, string>) {
  const normalized = portable(value);
  const exact = replacements.get(normalized);
  if (exact) return exact;
  for (const [from, to] of replacements) {
    if (normalized.startsWith(`${from}/`)) return `${to}${normalized.slice(from.length)}`;
  }
  return value;
}

function replaceValue(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === 'string') return replacePath(value, replacements);
  if (Array.isArray(value)) return value.map(v => replaceValue(v, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceValue(v, replacements)]));
  }
  return value;
}

async function renameSafely(ops: Rename[]) {
  const temps: Rename[] = [];
  const ordered = [...ops].sort((a, b) => b.from.length - a.from.length);
  for (const op of ordered) {
    const temporary = `${op.from}.整理中-${digest(op.to).slice(0, 12)}`;
    await fs.rename(op.from, temporary);
    temps.push({ from: temporary, to: op.to });
  }
  for (const op of temps) await fs.rename(op.from, op.to);
}

async function renameDirectories(ops: Rename[]) {
  for (const op of [...ops].sort((a, b) => b.from.length - a.from.length)) await fs.rename(op.from, op.to);
}

export async function organizeWorkFolders(settings: Settings, profile: string, cases: Case[]) {
  const { workRoot } = await validateRoots(settings);
  if (!workRoot) throw new Error('请先选择总工作文件夹。');
  const namespace = await managedPath(workRoot, path.posix.join('案件', profile));
  const report: FolderOrganizationReport = { renamedFolders: 0, renamedFiles: 0, skippedFiles: 0, unknownPaths: [], conflicts: [], cases: 0, message: '' };
  const caseChanges: FolderOrganizationCaseChange[] = [];
  const allFolderOps: Rename[] = [];
  const allFileOps: Rename[] = [];
  const manifestUpdates: ManifestUpdate[] = [];
  const usedRoots = new Set<string>();

  for (const c of cases) {
    if (!c.directory) continue;
    const caseRoot = await managedPath(workRoot, c.directory);
    const manifest = path.join(caseRoot, '案件信息.json');
    try {
      const raw = JSON.parse(await fs.readFile(manifest, 'utf8')) as { id?: string; profile?: string };
      if (raw.id !== c.id || raw.profile !== profile) {
        report.unknownPaths.push(portable(path.relative(workRoot, caseRoot)) + '/案件信息.json');
        continue;
      }
    } catch {
      report.unknownPaths.push(portable(path.relative(workRoot, manifest)));
      continue;
    }
    report.cases++;
    const oldDirectory = portable(c.directory);
    const rootBase = caseLabel(c);
    let rootName = rootBase;
    let rootN = 2;
    const currentRootName = path.basename(c.directory);
    while (usedRoots.has(rootName) || rootName !== currentRootName && await fs.stat(path.join(namespace, rootName)).then(() => true).catch(() => false)) rootName = `${rootBase}+${rootN++}`;
    usedRoots.add(rootName);
    const newDirectory = portable(path.posix.join('案件', profile, rootName));
    const replacements = new Map<string, string>();
    if (oldDirectory !== newDirectory) {
      allFolderOps.push({ from: caseRoot, to: path.join(workRoot, newDirectory) });
      replacements.set(oldDirectory, newDirectory);
    }
    const used = new Set<string>();
    const label = caseLabel(c);
    const sections = ['01_通知与材料', '02_工作稿', '03_定稿', '04_内部说明'];
    for (const section of sections) {
      const sectionRoot = path.join(caseRoot, section);
      const folders = await listDirectories(sectionRoot).catch(() => []);
      for (const folder of folders) {
        if (section === '04_内部说明' && folder === '撰写与审查') continue;
        const target = targetFolder(c, folder, section, used);
        if (!target) {
          report.unknownPaths.push(portable(path.relative(workRoot, path.join(sectionRoot, folder))));
          continue;
        }
        const from = path.join(sectionRoot, folder);
        const to = path.join(sectionRoot, target);
        if (from !== to) {
          allFolderOps.push({ from, to });
          const fromRel = portable(path.relative(caseRoot, from));
          const toRel = portable(path.relative(caseRoot, to));
          replacements.set(fromRel, toRel);
        }
      }
      const nestedUsed = new Set<string>();
      const collectNested = async (dir: string, depth: number) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          if (section === '04_内部说明' && entry.name === '撰写与审查') continue;
          const full = path.join(dir, entry.name);
          if (depth >= 2) {
            const target = historicalFolderName(entry.name, nestedUsed);
            if (target && target !== entry.name) {
              allFolderOps.push({ from: full, to: path.join(dir, target) });
              const fromRel = portable(path.relative(caseRoot, full));
              const toRel = portable(path.join(path.dirname(fromRel), target));
              replacements.set(fromRel, toRel);
            }
          }
          await collectNested(full, depth + 1);
        }
      };
      await collectNested(sectionRoot, 1).catch(() => {});
    }
    const rootRenames: Rename[] = [];
    for (const section of sections) {
      const sectionRoot = path.join(caseRoot, section);
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) { report.unknownPaths.push(portable(path.relative(workRoot, path.join(dir, entry.name)))); continue; }
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { await walk(full); continue; }
          if (!entry.isFile()) continue;
          if (entry.name === '工作稿.json' || generatedIndex.test(entry.name)) { report.skippedFiles++; continue; }
          const next = cleanFileName(entry.name);
          if (next === entry.name) continue;
          const rel = portable(path.relative(caseRoot, full));
          const nextRel = portable(path.join(path.dirname(rel), next));
          replacements.set(rel, nextRel);
          rootRenames.push({ from: full, to: path.join(dir, next) });
        }
      };
      await walk(sectionRoot).catch(() => {});
    }
    allFileOps.push(...rootRenames);
    // The case folder itself remains stable; the readable identity is stored in the manifest.
    const oldManifest = JSON.parse(await fs.readFile(manifest, 'utf8')) as Record<string, unknown>;
    const nextManifest = replaceValue({ ...oldManifest, readableFolderName: label }, replacements);
    const newManifest = path.join(workRoot, newDirectory, '案件信息.json');
    manifestUpdates.push({ oldFile: manifest, newFile: newManifest, value: nextManifest });
    caseChanges.push({ caseId: c.id, oldDirectory, newDirectory, replacements: [...replacements] });
  }

  for (const op of [...allFolderOps, ...allFileOps]) {
    if (await fs.stat(op.to).then(() => true).catch(() => false)) {
      report.conflicts.push(portable(path.relative(workRoot, op.to)));
    }
  }
  if (report.conflicts.length) throw new Error(`发现 ${report.conflicts.length} 个目标名称冲突，未执行整理。`);
  // Files are renamed while their original parent directories still exist.
  // Directory moves then run deepest-first so nested sources remain valid.
  await renameSafely(allFileOps);
  await renameDirectories(allFolderOps);
  for (const update of manifestUpdates) await atomicJSON(update.newFile, update.value);
  report.renamedFolders = allFolderOps.length;
  report.renamedFiles = allFileOps.length;
  report.message = report.unknownPaths.length
    ? `已整理 ${report.cases} 个案件，改名 ${report.renamedFolders} 个文件夹、${report.renamedFiles} 个文件；${report.unknownPaths.length} 个未知路径未改动。`
    : `已整理 ${report.cases} 个案件，改名 ${report.renamedFolders} 个文件夹、${report.renamedFiles} 个文件。`;
  return { report, caseChanges };
}
