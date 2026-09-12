import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadStandardSkill} from './standard-skills.ts';
test('both exact standard skill bundles verify content hashes; modified resources fail closed',async t=>{
 for(const kind of ['draft','review'] as const){const skill=await loadStandardSkill(path.resolve('resources/standard-skills'),kind);assert(skill.resources.length>10);assert.match(skill.name,new RegExp(kind));assert(skill.resources.some(r=>r.path.endsWith('/SKILL.md')));}
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'standard-skills-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.cp(path.resolve('resources/standard-skills'),root,{recursive:true});await fs.appendFile(path.join(root,'review/SKILL.md'),'changed');await assert.rejects(loadStandardSkill(root,'review'),/校验失败/);
});
