import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModule } from './create-module.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'module-generator-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'src/modules'),{recursive:true});
 const registry=path.join(root,'src/modules/custom.ts');await fs.copyFile(new URL('../src/modules/custom.ts',import.meta.url),registry);
 return {root,registry};
}
test('global and case entries with the same feature name register independently without overwriting source',async t=>{
 const {root,registry}=await fixture(t);
 const global=await createModule({root,name:'notes',location:'global',title:'全案笔记'}),single=await createModule({root,name:'notes',location:'case',title:'本案笔记'});
 assert.notEqual(global.directory,single.directory);assert.equal(global.route,'#/ext-notes');assert.equal(single.route,'#/case/<caseId>/ext-notes');
 const before=await fs.readFile(registry,'utf8'),panel=await fs.readFile(path.join(single.directory,'Panel.tsx'),'utf8');
 await assert.rejects(createModule({root,name:'notes',location:'case'}),/已存在/);
 assert.equal(await fs.readFile(registry,'utf8'),before);assert.equal(await fs.readFile(path.join(single.directory,'Panel.tsx'),'utf8'),panel);
 assert.match(before,/CUSTOM_GLOBAL_PANELS[^]*module_global_notes/);assert.match(before,/CUSTOM_CASE_PANELS[^]*module_case_notes/);
});
test('unsafe names, missing scope, registry drift and symlink directories leave the registry untouched',async t=>{
 const {root,registry}=await fixture(t),original=await fs.readFile(registry,'utf8');
 await assert.rejects(createModule({root,name:'../../escape',location:'case'}),/名称/);
 await assert.rejects(createModule({root,name:'notes'}),/location/);
 await fs.writeFile(registry,original.replace('// module-generator:case',''));
 await assert.rejects(createModule({root,name:'notes',location:'case'}),/标记/);
 await fs.writeFile(registry,original);
 await fs.symlink(os.tmpdir(),path.join(root,'src/modules/generated'));
 await assert.rejects(createModule({root,name:'notes',location:'case'}),/普通目录/);
 assert.equal(await fs.readFile(registry,'utf8'),original);
 await assert.rejects(fs.access(path.join(root,'src/modules/.module-create.lock')));
});
