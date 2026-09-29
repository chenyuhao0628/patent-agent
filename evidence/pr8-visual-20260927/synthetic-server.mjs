import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {seedWorkspace} from '/Users/cyh/Documents/ChatGPT/patent-agent/src/domain/workflow.ts';
const root='/Users/cyh/Documents/ChatGPT/patent-agent/dist';
const workspace=seedWorkspace();
workspace.cases=workspace.cases.slice(0,2);
workspace.settings.workRoot='/synthetic-visual-only';
workspace.cases.forEach((c,i)=>{
  c.id='qa-visual-'+(i+1);c.number='QA-VISUAL-'+(i+1);c.title=i?'合成对照案：夹持机构（保持不变）':'合成验收案：温控装置';c.source='baseland';c.tags=['合成视觉验收'];
  const pid='qa-proc-'+(i+1),r=c.rounds[0];c.rounds=[r];r.id='proc-'+pid;r.name='审查意见答复';r.stage='materials';r.confirmed=false;r.draft='合成稿件 KEEP-'+(i+1);
  r.materials=[{id:'file-ready-'+i,fileNo:'ready-'+i,name:'审查意见通知书（已下载）.pdf',role:'通知书',location:'审查意见答复',excerpt:'仅合成材料，不包含真实案件。',ready:true,relativePath:'synthetic/notice.pdf'}];
  c.current={kind:'reply',processId:pid,roundId:r.id,remoteStatus:200};c.localDraft='合成稿件 KEEP-'+(i+1);c.caseRemark='刷新前合成备注-'+(i+1);
  c.remote={caseId:'remote-visual-'+i,syncedAt:'2026-09-27T08:00:00Z',processes:[{id:pid,name:'审查意见答复',status:200,personalStatus:200,node:'答复处理',undertaker:'合成办理人',deadline:'2026-10-08',baselandDeadline:'2026-10-08',canEdit:true}]};
});
function bridge(workspace){
  const listeners=new Set(),calls=[],errors=[];
  window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  const state={profileKey:'visual-only',snapshotVersion:1,scopeVersion:1,caseRevisions:Object.fromEntries(workspace.cases.map(c=>[c.id,0])),account:{username:'synthetic',displayName:'合成视觉验收',organization:'仅本地夹具',origin:'http://127.0.0.1:4176',userId:'synthetic-user',status:'authenticated',remembered:false},workspace,sync:{running:false,message:'仅合成接口，未连接业务服务'},storage:{running:false,message:'内存夹具，不写案件文件'},migration:{running:false,phase:'idle',canCancel:false,message:''},version:'0.15.0',dataDirectory:'/synthetic-visual-only'};
  const snapshot=()=>structuredClone(state),emit=()=>{state.snapshotVersion++;for(const cb of listeners)cb(snapshot());};
  const getFlow=id=>{const c=workspace.cases.find(c=>c.id===id);return {at:'2026-09-27T09:40:00Z',currentProcessId:c.current.processId,processes:structuredClone(c.remote),nodes:[{name:'任务接收',user:'合成办理人',running:false,finished:true,start:'2026-09-27T08:00:00Z',end:'2026-09-27T08:10:00Z'},{name:'答复处理',user:'合成办理人',running:true,finished:false,isCurrent:true,start:'2026-09-27T08:10:00Z',end:''}],history:[{name:'审查意见答复',created:'2026-09-27T08:00:00Z',finished:''}]};};
  let pending;
  window.__qa={calls,errors,snapshot,resolve(){if(!pending)throw Error('No pending refresh');const {id,resolve}=pending;pending=null;const c=workspace.cases.find(c=>c.id===id);c.caseRemark='单案刷新成功：新增材料已同步（合成）';c.officialOutcome={state:'none',checkedAt:'2026-09-27T09:40:00Z'};if(!c.rounds[0].materials.some(m=>m.fileNo==='qa-new'))c.rounds[0].materials.push({id:'file-qa-new',fileNo:'qa-new',name:'新增审查意见附件_单案刷新视觉验收.pdf',role:'通知书',location:'审查意见答复',excerpt:'合成新材料',ready:true,relativePath:'synthetic/new.pdf'});emit();resolve({state:snapshot(),flow:getFlow(id)});},reject(){if(!pending)throw Error('No pending refresh');const {reject}=pending;pending=null;reject(Error('材料刷新有 1 项待重试：合成附件下载失败；已保存材料保留。'));}};
  window.patentDesktop={contractVersion:1,bootstrap:async()=>snapshot(),onState:cb=>{listeners.add(cb);return()=>listeners.delete(cb);},agent:{command:async(key,id,command)=>{if(command.type!=='opened')throw Error('本夹具禁止业务启动');calls.push({method:'opened',id});},history:async()=>[]},professional:{history:async(key,id)=>({profileKey:key,caseId:id,sources:[],jobs:[]})},transfer:{history:async()=>[]},flow:async id=>{calls.push({method:'flow',id});return getFlow(id);},refreshCase:(key,id)=>{calls.push({method:'refreshCase',id});return new Promise((resolve,reject)=>{pending={id,resolve,reject};});},sync:async()=>{calls.push({method:'sync'});throw Error('视觉验收禁止全库同步');},caseInfo:async()=>snapshot(),saveWorkspace:async()=>{throw Error('本夹具禁止保存工作区');}};
}
const inject='<script>('+bridge.toString()+')('+JSON.stringify(workspace)+');</script>';
const server=http.createServer(async(req,res)=>{
 try{const url=new URL(req.url,'http://127.0.0.1:4176');let name=decodeURIComponent(url.pathname);if(name==='/'||name==='/pr8-visual')name='/index.html';const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}let content=await fs.readFile(file);if(name==='/index.html')content=Buffer.from(content.toString().replace('<head>','<head>'+inject));const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.png':'image/png'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';"});res.end(content);}catch{res.writeHead(404);res.end('Not found');}
});
server.listen(4176,'127.0.0.1',()=>console.log('Synthetic visual bridge ready http://127.0.0.1:4176/pr8-visual?qa=1'));
