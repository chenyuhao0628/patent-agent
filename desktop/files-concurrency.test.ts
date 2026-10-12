import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CaseFiles, managedPath } from './files.ts';
import type { Case } from '../src/domain/workflow.ts';

test('concurrent imports into a new work folder share safe parents and retain independent case identities',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'case-parent-race-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const files=new CaseFiles({provider:'',baseUrl:'',model:'',workRoot:root},'synthetic');
 const cases:Case[]=Array.from({length:24},(_,i)=>({id:'case-'+i,number:'CASE-'+i,title:'合成并发案件',type:'发明',deadline:'',tags:[],rounds:[],archived:false,current:{kind:'write'}}));
 const directories=await Promise.all(cases.map(item=>files.ensureCase(item)));
 assert.equal(new Set(directories).size,cases.length);
 for(let i=0;i<cases.length;i++){const saved=JSON.parse(await fs.readFile(path.join(root,directories[i],'案件信息.json'),'utf8'));assert.equal(saved.id,cases[i].id);assert.equal(saved.profile,'synthetic');}
 await fs.symlink(os.tmpdir(),path.join(root,'redirect'));
 await assert.rejects(managedPath(root,'redirect/new/output.json',true),/符号链接/);
 await fs.writeFile(path.join(root,'blocked'),'preserved');
 await assert.rejects(managedPath(root,'blocked/new/output.json',true),/被文件占用/);
 assert.equal(await fs.readFile(path.join(root,'blocked'),'utf8'),'preserved');
});
