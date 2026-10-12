import fs from 'node:fs/promises';import {watch} from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {openDesktop,sleep} from '/tmp/patent-module-cdp.mjs';
import {DesktopService} from '/Users/cyh/Documents/ChatGPT/patent-agent/desktop/service.ts';
import {encodeResponsesSse} from '/Users/cyh/Documents/ChatGPT/patent-agent/desktop/synthetic-provider.ts';
const repo='/Users/cyh/Documents/ChatGPT/patent-agent',root=await fs.mkdtemp(path.join(os.tmpdir(),'module-performance-'));
const samples=Number(process.env.PERF_SAMPLES??5),label=process.env.PERF_LABEL??'before-optimization';
const report={label,checkedAt:new Date().toISOString(),root,caseCount:80,samples,networkDelayPerRequestMs:50,variants:[]};
const counts=new Map(),requests=[];
const provider=http.createServer(async(req,res)=>{
 try{const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString()),input=JSON.stringify(body.input),marker=[...input.matchAll(/<!--workbench-turn:([^>]+)-->/g)].at(-1)?.[1]??'none',n=counts.get(marker)??0;counts.set(marker,n+1);requests.push({marker,n});
 await sleep(50);res.writeHead(200,{'Content-Type':'text/event-stream',Connection:'close'});
 const output=n===0?[{type:'function_call',id:'fc_write',call_id:'write',name:'case_tools_write_artifact',arguments:JSON.stringify({name:'result.json',content:{kind:'discuss',reply:'SYNTHETIC_PERF_DONE_'+marker}})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic completed'}]}];res.end(encodeResponsesSse(body.model,output,24));
 }catch(error){res.writeHead(500);res.end(String(error));}
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));const providerPort=provider.address().port;
const candidates=[{name:'baseline-0.21.0',exe:repo+'/release/专利工作台-0.21.0-macOS-arm64.app/Contents/MacOS/专利工作台'},{name:'candidate-0.22.0',...(process.env.PERF_CANDIDATE_APP?{exe:process.env.PERF_CANDIDATE_APP}:{project:repo})}];
if(process.env.PERF_ORDER==='reverse')candidates.reverse();
try{
 for(const candidate of candidates){
  const dir=root+'/'+candidate.name;await fs.mkdir(dir+'/work',{recursive:true});await fs.mkdir(dir+'/originals');
  const service=new DesktopService(dir+'/profile',{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});await service.init();await service.settings('local',{provider:'',baseUrl:'',model:'',workRoot:dir+'/work',originalLibrary:dir+'/originals'});
  for(let i=0;i<report.caseCount;i++)await service.createCase({title:'SYNTHETIC_CASE_'+String(i).padStart(3,'0'),number:'PERF-'+String(i).padStart(3,'0'),kind:'write'});
  const id=service.workspace.cases[0].id;
  let c=await openDesktop({...candidate,profile:dir+'/profile',log:dir+'/desktop.log'});
  const result={name:candidate.name,startupMs:c.readyMs,route:[],refreshMs:[],saves:[],taskMs:[]};
  const navigate=async(hash,selector)=>c.evaluate(`new Promise((resolve,reject)=>{const t=performance.now();location.hash=${JSON.stringify(hash)};function probe(){if(performance.now()-t>10000){reject(Error('navigation timeout'));return;}if(location.hash===${JSON.stringify(hash)}&&document.querySelector(${JSON.stringify(selector)})&&!document.body.innerText.includes('正在加载面板…'))requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-t)));else requestAnimationFrame(probe);}requestAnimationFrame(probe);})`);
  try{
   await c.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
   result.coldCaseMs=await navigate('#/case/'+id+'/overview','.overview-grid');
   for(let i=0;i<samples;i++){result.route.push({libraryMs:await navigate('#/library','.library'),caseMs:await navigate('#/case/'+id+'/overview','.overview-grid')});}
   await navigate('#/library','.library');
   for(let i=0;i<samples;i++)result.refreshMs.push(await c.evaluate(`(async()=>{const t=performance.now();await window.patentDesktop.refreshShared('local');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-t;})()`));
   await navigate('#/case/'+id+'/overview','.overview-grid');
   for(let i=0;i<samples;i++){
    const title='SYNTHETIC_SAVED_'+i,profileFile=dir+'/profile/profiles/local/workspace.json';let observed;
    const watcher=watch(path.dirname(profileFile),async()=>{try{const saved=JSON.parse(await fs.readFile(profileFile,'utf8'));if(saved.cases?.some(c=>c.id===id&&c.title===title))observed??=Date.now();}catch{}});
    await c.evaluate(`document.querySelector('[aria-label="案件管理操作"]').click()`);await c.wait(`!![...document.querySelectorAll('label')].find(x=>x.innerText.trim()==='案件名称')?.querySelector('input')`);
    await c.evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(x=>x.innerText.trim()==='案件名称').querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(title)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(25);
    const timing=await c.evaluate(`new Promise((resolve,reject)=>{const t=performance.now(),epoch=Date.now();[...document.querySelectorAll('button')].find(x=>x.innerText==='保存修改').click();function probe(){if(performance.now()-t>10000){reject(Error('save timeout'));return;}if(document.querySelector('.case-intro h1')?.innerText===${JSON.stringify(title)})requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({uiMs:performance.now()-t,epoch})));else requestAnimationFrame(probe);}requestAnimationFrame(probe);})`);
    const end=Date.now()+5000;while(!observed&&Date.now()<end)await sleep(5);watcher.close();if(!observed)throw Error('Save not found on disk');
    result.saves.push({uiMs:timing.uiMs,diskMs:observed-timing.epoch});
   }
   const config=await c.evaluate(`window.patentDesktop.models.saveProvider('local',${JSON.stringify({name:'Synthetic performance',baseURL:`http://127.0.0.1:${providerPort}/v1`,protocol:'openai-responses',key:'synthetic-only',models:[{modelId:'synthetic-performance',displayName:'Synthetic',contextWindow:32000,maxOutput:1000,reasoningLevelId:'vendor-default'}]})})`);
   const added=config.providers.find(p=>p.name==='Synthetic performance');await c.evaluate(`window.patentDesktop.models.setDefault('local',${JSON.stringify(added.id)},${JSON.stringify(added.models[0].id)})`);
   await navigate('#/case/'+id+'/discussion','.agent-composer textarea');await c.wait('!!document.querySelector(".agent-composer textarea")');
   for(let i=0;i<3;i++){
    const previous=await c.evaluate(`window.patentDesktop.agent.getCase('local',${JSON.stringify(id)}).then(v=>v.process.jobs.length)`);
    await c.evaluate(`(()=>{const e=document.querySelector('.agent-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'合成性能试验 ${i}，保存一句简短结果。');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await sleep(25);
    const ms=await c.evaluate(`(async()=>{const t=performance.now();document.querySelector('.agent-composer button[type=submit]').click();for(;;){const v=await window.patentDesktop.agent.getCase('local',${JSON.stringify(id)}),job=v.process.jobs.at(-1);if(v.process.jobs.length>${previous}&&!v.busy){if(job?.state!=='completed')throw Error(JSON.stringify(job));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-t;}if(performance.now()-t>30000)throw Error('Task timeout');await new Promise(r=>setTimeout(r,15));}})()`);result.taskMs.push(ms);
   }
   result.errors=c.events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Log.entryAdded'&&e.params.entry.level==='error');if(result.errors.length)throw Error('Frontend errors');
   result.exit=await c.close();c=undefined;
   c=await openDesktop({...candidate,profile:dir+'/profile',log:dir+'/desktop.log'});result.reopenMs=c.readyMs;result.persisted=await c.evaluate(`window.patentDesktop.bootstrap().then(s=>s.workspace.cases.find(c=>c.id===${JSON.stringify(id)}).title)`);if(result.persisted!=='SYNTHETIC_SAVED_'+(samples-1))throw Error('Reopen lost save');await c.close();c=undefined;
   report.variants.push(result);await fs.writeFile(root+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(result,null,2));
  }finally{if(c)await c.close();}
 }
 report.requests=requests.length;await fs.writeFile(root+'/result.json',JSON.stringify(report,null,2));await fs.writeFile('/tmp/patent-module-performance-'+label+'-root.txt',root);
}finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));}
