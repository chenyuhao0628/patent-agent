import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {packagingCommands,verifyStaging,copyArtifact,hashPath,sha256File,acquirePackageLock,APP_ID,PRODUCT_NAME} from '/Users/cyh/Documents/ChatGPT/patent-agent/scripts/package-release.mjs';
const root='/Users/cyh/Documents/ChatGPT/patent-agent',version='0.18.0';
const require=createRequire(path.join(root,'package.json')),asar=require('@electron/asar');
const dir=await fs.mkdtemp('/tmp/patent-agent-ui-packaging-'),staging=path.join(dir,'release-staging');
await fs.mkdir(staging);const unlock=await acquirePackageLock(path.join(root,'.package-release.lock'));
const release=path.join(root,'release'),old=[];
const checksum=async(file)=>(await fs.lstat(file)).isDirectory()?hashPath(file):sha256File(file);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 for(const name of await fs.readdir(release))if(/\.(app|pkg|exe)$/.test(name))old.push({file:name,sha256:await checksum(path.join(release,name))});
 for(const step of packagingCommands({platforms:['mac','win'],projectRoot:root,stagingDir:staging}).filter(s=>s.role!=='build')){
  console.log('START',step.role);await new Promise((resolve,reject)=>{const child=spawn(step.command,step.args,{cwd:step.cwd,env:{...process.env,...step.env},stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(step.role+' exit '+code)));});
 }
 const verified=await verifyStaging(staging,{version,platforms:['mac','win']});
 const payload=[];
 for(const archive of [path.join(staging,'mac-arm64',PRODUCT_NAME+'.app/Contents/Resources/app.asar'),path.join(staging,'win-unpacked/resources/app.asar')]){
  for(const rel of ['desktop-dist/main.cjs','desktop-dist/preload.cjs']){const expected=hash(await fs.readFile(path.join(root,rel))),actual=hash(asar.extractFile(archive,rel));if(actual!==expected)throw new Error('Payload mismatch '+rel);payload.push({platform:archive.includes('mac-arm64')?'mac':'win',file:rel,sha256:actual});}asar.uncache(archive);
 }
 const installer=verified.find(a=>a.kind==='pkg');const expanded=path.join(dir,'expanded-pkg');execFileSync('pkgutil',['--expand',installer.source,expanded]);const distribution=await fs.readFile(path.join(expanded,'Distribution'),'utf8');if(!distribution.includes('version="'+version+'"'))throw new Error('PKG metadata version mismatch');
 const files=[];for(const item of verified){const dest=path.join(release,item.finalName);try{await fs.lstat(dest);throw new Error('Refuse existing destination '+dest);}catch(error){if(error.code!=='ENOENT')throw error;}await copyArtifact(item.source,dest);files.push({file:item.finalName,platform:item.platform,version,sha256:await checksum(dest),hashAlgorithm:item.kind==='mac'?'sha256-tree':'sha256'});}
 for(const item of old)if(await checksum(path.join(release,item.file))!==item.sha256)throw new Error('Previous artifact changed '+item.file);
 const manifest={version,builtAt:new Date().toISOString(),appId:APP_ID,productName:PRODUCT_NAME,files};const temp=path.join(release,'.ui-polish-manifest.tmp');await fs.writeFile(temp,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});await fs.rename(temp,path.join(release,'release-manifest.json'));
 const evidence={schema:1,version,builtAt:manifest.builtAt,source:{baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),uncommitted:true},files,payload,previousArtifactsPreserved:old,checks:{staging:true,macPackageMetadata:true,payloadMatchesBuiltSource:true,previousArtifactHashesUnchanged:true},limits:['未覆盖安装','未执行 Windows 实机启动','未签名或公证','未提交、推送或发布'],stagingDirectory:staging};
 await fs.writeFile('/tmp/patent-agent-ui-polish/release-0.18.0-20260930.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log('VERIFIED',JSON.stringify(evidence));
 await fs.rm(dir,{recursive:true,force:true});
}finally{await unlock();}
