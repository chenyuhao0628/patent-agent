import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApplicationSettings, loginArguments } from './application-settings.ts';
test('window preferences persist independently; startup only changes on explicit toggle and uses portable executable',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'window-settings-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let enabled=false;const writes:boolean[]=[];const adapter={get:()=>({openAtLogin:enabled}),set:(value:boolean)=>{writes.push(value);enabled=value;}};
 const settings=new ApplicationSettings(path.join(root,'settings.json'),adapter,true,true);await settings.init();assert.deepEqual(writes,[]);
 await settings.save({...settings.preferences,closeBehavior:'background',minimizeToTray:true});assert.deepEqual(writes,[]);
 await settings.save({...settings.preferences,openAtLogin:true});assert.deepEqual(writes,[true]);
 const reopened=new ApplicationSettings(settings.file,adapter,true,true);await reopened.init();assert.equal(reopened.preferences.closeBehavior,'background');assert.equal(reopened.view().startupEnabled,true);
 await reopened.save({...reopened.preferences,openAtLogin:false});assert.deepEqual(writes,[true,false]);
 assert.equal(loginArguments('win32','C:\\temp\\app.exe','C:\\apps\\portable.exe').path,'C:\\apps\\portable.exe');
 const dev=new ApplicationSettings(path.join(root,'dev.json'),adapter,true,false);await assert.rejects(dev.save({...dev.preferences,openAtLogin:true}),/已构建/);assert.deepEqual(writes,[true,false]);
 await fs.mkdir(path.join(root,'blocked'));const broken=new ApplicationSettings(path.join(root,'blocked'),adapter,true,true);await assert.rejects(broken.save({...broken.preferences,openAtLogin:true}));assert.equal(enabled,false);
});

test('upgrade restores only an already enabled login preference at new executable location',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'upgrade-settings-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'settings.json');
 await fs.writeFile(file,JSON.stringify({openAtLogin:true,startHidden:true,closeBehavior:'background',minimizeToTray:true}));
 const calls:boolean[]=[];const settings=new ApplicationSettings(file,{get:()=>({openAtLogin:false}),set:v=>{calls.push(v);}},true,true);await settings.init();assert.deepEqual(calls,[true]);assert.equal(settings.preferences.startHidden,true);
});
