import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {callWebTool,configureWebTools,publicAddress,publicWebUrl} from './agent-web.ts';
import {configureManagedTools,configureAutomaticInstall,ensureDocumentTool,verifyToolArchive} from './managed-tools.ts';
import {startAgentBroker,randomRunToken} from './agent-broker.ts';
test('controlled web rejects local URLs and keeps upstream requests free of local credentials',async()=>{
  for(const url of ['file:///etc/passwd','http://127.0.0.1/','http://[::1]/','https://a:b@example.com/','http://192.168.1.2/'])await assert.rejects(publicWebUrl(url));
  assert.equal(publicAddress('100.64.0.1'),false);assert.equal(publicAddress('::ffff:127.0.0.1'),false);
  configureWebTools(false);await assert.rejects(callWebTool('web_search',{query:'公开技术'}),/关闭/);configureWebTools(true);
  let calls=0;
  const fetcher:typeof fetch=async(url,options)=>{calls++;assert.equal(url,'https://mcp.exa.ai/mcp');assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).has('Authorization'),false);const body=JSON.parse(String(options?.body));assert.equal(body.params.arguments.query,'公开技术');assert.equal(body.params.name,'web_search_exa');return new Response('event: message\ndata: '+JSON.stringify({result:{content:[{type:'text',text:'原始来源 https://example.com 技术说明'}]},jsonrpc:'2.0',id:1})+'\n\n');};
  assert.match(await callWebTool('web_search',{query:'公开技术'},undefined,fetcher),/外部网页资料.*\n\n原始来源/s);assert.equal(calls,1);
  await assert.rejects(callWebTool('web_search',{query:'x'.repeat(501)},undefined,fetcher));assert.equal(calls,1);
});
test('registered installer refuses altered archive and respects disabled automatic install',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'controlled-tools-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));configureManagedTools(root);
  const file=path.join(root,'archive');await fs.writeFile(file,'fixture');await verifyToolArchive(file,createHash('sha256').update('fixture').digest('hex'),7);
  await assert.rejects(verifyToolArchive(file,'0'.repeat(64),7),/校验失败/);await assert.rejects(verifyToolArchive(file,'0'.repeat(64),8),/不完整/);
  configureAutomaticInstall(false);await assert.rejects(ensureDocumentTool(),/关闭/);configureAutomaticInstall(true);
});
test('broker refuses arbitrary installers and extra URL arguments',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'controlled-broker-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const token=randomRunToken(),events:any[]=[];
  const broker=await startAgentBroker({token,snapshotRoot:path.join(root,'snap'),outputsRoot:path.join(root,'out'),materials:[],onToolEvent:e=>events.push(e)});t.after(()=>broker.close());
  for(const args of [{tool:'npm'},{tool:'libreoffice',url:'https://example.com/evil'}]){
    const res=await fetch(broker.url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ensure_tool',arguments:args}})});
    const data=await res.json();assert.equal(data.result.isError,true);assert.match(data.result.content[0].text,/只允许/);
  }assert.equal(events.length,2);assert.equal(events[0].success,false);
});
