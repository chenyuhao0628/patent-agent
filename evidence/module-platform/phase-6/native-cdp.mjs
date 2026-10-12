import fs from 'node:fs/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function openDesktop({project,exe='/Users/cyh/Documents/ChatGPT/patent-agent/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',profile,log}){
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const output=await fs.open(log,'a',0o600),started=performance.now();
 const child=spawn(exe,[...(project?[project]:[]),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{env:{...process.env,PATENT_AGENT_DATA_DIR:profile,PATENT_AGENT_DISABLE_RUNTIME_UPDATE:'1'},stdio:['ignore',output.fd,output.fd]});
 const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));let socket;
 try{
  for(let i=0;i<300;i++){
   try{const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json(),page=pages.find(p=>p.type==='page'&&p.url.includes('/dist/index.html'));if(page){socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});break;}}catch{}
   if(child.exitCode!==null)throw Error('Desktop exited: '+await fs.readFile(log,'utf8'));
   await sleep(30);
  }
  if(!socket)throw Error('Desktop debugger not found');
  let id=0;const pending=new Map(),events=[];
  socket.onmessage=e=>{const p=JSON.parse(e.data);if(p.id){const t=pending.get(p.id);pending.delete(p.id);p.error?t?.reject(p.error):t?.resolve(p.result);}else events.push(p);};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await call('Runtime.enable');await call('Log.enable');await call('Page.enable');
  const wait=async(expression,timeout=20000)=>{const end=performance.now()+timeout;while(performance.now()<end){if(await evaluate(expression))return;await sleep(25);}throw Error('Timed out: '+expression+' / '+await evaluate('document.body.innerText'));};
  await wait('!!document.querySelector(".global-sidebar")');
  await wait('!!document.querySelector(".library")');
  const readyMs=performance.now()-started;
  return {call,evaluate,wait,events,child,readyMs,async snapshot(file){const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(file,Buffer.from(shot.data,'base64'));},async close(){await evaluate('window.patentDesktop.application.quit()').catch(()=>{});socket.close();const timer=setTimeout(()=>child.kill('SIGTERM'),10000);const result=await exited;clearTimeout(timer);await output.close();return result;}};
 }catch(error){socket?.close();child.kill('SIGTERM');await exited;await output.close();throw error;}
}
