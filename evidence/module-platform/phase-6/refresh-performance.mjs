import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
const current='/Users/cyh/Documents/ChatGPT/patent-agent',baseline=(await fs.readFile('/tmp/patent-module-baseline-root.txt','utf8')).trim(),root=await fs.mkdtemp(path.join(os.tmpdir(),'module-refresh-performance-'));
const report={checkedAt:new Date().toISOString(),remoteCaseCount:12,latencyMs:20,samples:5,preparedCommonParents:true,baselineFreshRootFailure:"EEXIST during concurrent parent creation",variants:[]};
for(const [name,project]of[['baseline-0.21.0',baseline],['candidate-0.22.0',current]]){
 const {DesktopService}=await import(project+'/desktop/service.ts'),dir=root+'/'+name;await fs.mkdir(dir+'/work',{recursive:true});await fs.mkdir(dir+'/originals');await fs.mkdir(dir+'/work/案件/synthetic',{recursive:true});
 const s=new DesktopService(dir+'/profile',{available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''});await s.init();s.key='synthetic';s.account={origin:'https://synthetic.invalid',username:'synthetic',userId:'synthetic',displayName:'Synthetic',organization:'Synthetic',remembered:false,status:'authenticated'};s.workspace.settings={provider:'',baseUrl:'',model:'',workRoot:dir+'/work',originalLibrary:dir+'/originals'};
 const rows=Array.from({length:report.remoteCaseCount},(_,i)=>({CaseId:'remote-'+i,CaseProcId:'process-'+i,CaseName:'SYNTHETIC_REMOTE_'+i,CaseNo:'REFRESH-'+i,CaseProcName:'提出申请',CaseHandId:'',_status:0}));let calls=[];const delay=async(type,value)=>{calls.push(type);await new Promise(r=>setTimeout(r,report.latencyMs));return value;};const now=()=>new Date().toISOString();
 s.client={token:'synthetic',origin:'https://synthetic.invalid',personalCasesSnapshot:async()=>delay('personal-cases',{rows,stats:[{code:0,count:rows.length}]}),personalProcessStatistics:async()=>delay('statistics',[{code:0,count:rows.length}]),caseClosure:async()=>delay('closure',{finished:false,checkedAt:now()}),officialOutcome:async()=>delay('outcome',{state:'none',checkedAt:now()}),queryOfficial:async()=>delay('official',{submission:{state:'draft',source:'hand',checkedAt:now()},ok:true,canEdit:true}),files:async()=>delay('files',[]),download:async()=>{throw Error('Unexpected download')},flow:async item=>delay('flow',{at:now(),currentProcessId:item.current.processId,processes:structuredClone(item.remote),nodes:[],history:[]}),caseInfo:async()=>delay('case-info',{at:now()})};
 await s.sync({full:true});if(s.workspace.cases.length!==rows.length)throw Error('Incomplete sync '+s.syncState.message);
 const id=s.workspace.cases[0].id,result={name,full:[],single:[]};
 for(let i=0;i<report.samples;i++){
  calls=[];let t=performance.now();await s.sync({full:true});result.full.push({ms:performance.now()-t,calls:calls.length,byType:calls.reduce((a,k)=>(a[k]=(a[k]??0)+1,a),{})});if(s.workspace.cases.length!==rows.length||!s.syncState.message.includes('12'))throw Error('Sync incomplete '+s.syncState.message);
  calls=[];t=performance.now();await s.refreshCase('synthetic',id);result.single.push({ms:performance.now()-t,calls:calls.length,byType:calls.reduce((a,k)=>(a[k]=(a[k]??0)+1,a),{})});
 }
 await s.shutdown();report.variants.push(result);
}
await fs.writeFile(root+'/result.json',JSON.stringify(report,null,2));await fs.writeFile('/tmp/patent-module-refresh-performance-root.txt',root);console.log(JSON.stringify(report,null,2));
