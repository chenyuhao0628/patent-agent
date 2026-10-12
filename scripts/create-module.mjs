import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const templates=fileURLToPath(new URL('../templates/module/',import.meta.url));
const marker=name=>`// module-generator:${name}`;
function insert(source,name,content){
  const token=marker(name);
  if(source.split(token).length!==2)throw new Error(`注册入口标记缺失或重复：${name}`);
  return source.replace(token,content+'\n'+(name==='imports'?'':'  ')+token);
}
async function directory(file,create=false){
  if(create)await fs.mkdir(file).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const stat=await fs.lstat(file);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('模块路径必须是仓库内的普通目录。');
}
export async function createModule({root=process.cwd(),name,location,title=name}){
  if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name??'')||name.length>48)throw new Error('名称须为最多 48 位的小写英文、数字及单个连字符。');
  if(!['global','case'].includes(location))throw new Error('必须明确指定 --location global 或 case。');
  if(typeof title!=='string'||!title.trim()||title.length>80||/[\u0000-\u001f\u007f]/.test(title))throw new Error('标题须为 1–80 位普通文本。');
  const workspace=await fs.realpath(root),modules=path.join(workspace,'src/modules'),registry=path.join(modules,'custom.ts');
  for(const part of ['src','src/modules'])await directory(path.join(workspace,part));
  const registryStat=await fs.lstat(registry);
  if(!registryStat.isFile()||registryStat.isSymbolicLink())throw new Error('模块注册文件必须是普通文件。');
  const lockPath=path.join(modules,'.module-create.lock');
  const lock=await fs.open(lockPath,'wx').catch(error=>{if(error.code==='EEXIST')throw new Error('另一模块接入正在进行，请稍后重试。');throw error;});
  const folder=`${location}-${name}`,target=path.join(modules,'generated',folder),tempRegistry=registry+'.'+randomUUID()+'.tmp';
  let ownsTarget=false,published=false;
  try{
    const source=await fs.readFile(registry,'utf8');
    const symbol='module_'+folder.replaceAll('-','_');
    const next=insert(insert(source,'imports',`import ${symbol} from './generated/${folder}/panel.ts';`),location,`${symbol},`);
    await directory(path.join(modules,'generated'),true);
    await fs.mkdir(target).catch(error=>{if(error.code==='EEXIST')throw new Error('目标模块已存在，未覆盖文件或注册项。');throw error;});ownsTarget=true;
    const substitutions={
      ID:JSON.stringify(`custom.${location}.${name}`),LOCATION:JSON.stringify(location),ROUTE:JSON.stringify('ext-'+name),TITLE:JSON.stringify(title.trim()),
      TITLE_TEXT:'{'+JSON.stringify(title.trim())+'}',
      DEFINITION_TYPE:location==='global'?'GlobalPanelDefinition':'CasePanelDefinition',NAVIGATION:JSON.stringify(location==='global'?'main':'case'),
      SCOPE_TEXT:location==='global'?'当前账号的案件摘要':'当前案件的摘要',CASE_ID:location==='global'?'undefined':"'a'",EXPECTED_IDS:location==='global'?"['a','b']":"['a']",
    };
    for(const file of ['Panel.tsx','panel.ts','panel.test.ts']){
      const template=await fs.readFile(path.join(templates,file+'.tpl'),'utf8');
      const content=template.replace(/__([A-Z_]+)__/g,(_match,key)=>{if(!(key in substitutions))throw new Error('未知模板参数：'+key);return substitutions[key];});
      await fs.writeFile(path.join(target,file),content,{flag:'wx'});
    }
    if(await fs.readFile(registry,'utf8')!==source)throw new Error('注册文件在生成期间发生变化，未覆盖，请重试。');
    await fs.writeFile(tempRegistry,next,{flag:'wx',mode:registryStat.mode});
    await fs.rename(tempRegistry,registry);published=true;
    return {location,id:`custom.${location}.${name}`,directory:target,registry,route:location==='global'?`#/ext-${name}`:`#/case/<caseId>/ext-${name}`};
  }finally{
    if(ownsTarget&&!published)await fs.rm(target,{recursive:true,force:true});
    await fs.rm(tempRegistry,{force:true});await lock.close();await fs.rm(lockPath,{force:true});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i+=2){
      const key=args[i].replace(/^--/,'');
      if(!args[i].startsWith('--')||!['name','location','title','root'].includes(key)||!args[i+1]||args[i+1].startsWith('--')||key in options)throw new Error('用法：npm run module:create -- --name case-notes --location global|case --title 案件笔记');
      options[key]=args[i+1];
    }
    console.log(JSON.stringify(await createModule(options),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
