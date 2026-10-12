import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {panels}=await import(root+'/src/app/panels.ts');const {featureContext}=await import(root+'/src/app/features.ts');const {projectCaseView}=await import(root+'/src/domain/case-view.ts');
const {DesktopService}=await import(root+'/desktop/service.ts');const {CaseFiles}=await import(root+'/desktop/files.ts');const {organizeWorkFolders}=await import(root+'/desktop/work-folder-organizer.ts');
const result={checkedAt:new Date().toISOString(),baseline:'027c9de',networkRequests:0};
const remote={id:'synthetic-case',number:'DOC-001',title:'合成核对案',companyName:'合成客户',type:'发明',deadline:'',tags:[],rounds:[],archived:false,source:'baseland',current:{kind:'write',processId:'synthetic-process',remoteStatus:0},remote:{caseId:'synthetic-remote',syncedAt:new Date().toISOString(),processes:[{id:'synthetic-process',name:'提出申请',status:0,canEdit:true}]}};
const tabs=panels.navigation('case',{...featureContext(true),caseView:projectCaseView(remote),historical:false}).map(p=>({route:p.route,order:p.order,label:p.label}));
result.navigation={tabs,submitBeforeFlow:tabs.findIndex(p=>p.route==='submit')<tabs.findIndex(p=>p.route==='flow')};assert.equal(result.navigation.submitBeforeFlow,true);
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'patent-doc-probe-'));const vault={available:()=>false,encrypt:()=>Buffer.alloc(0),decrypt:()=>''};
try{
 const work=path.join(temporary,'work');await fs.mkdir(work);const settings={provider:'',baseUrl:'',model:'',workRoot:work};
 const c={...structuredClone(remote),id:'synthetic-local',source:'local',current:{kind:'write'},remote:undefined};const files=new CaseFiles(settings,'local');c.directory=await files.ensureCase(c);
 const before=c.directory,organized=await organizeWorkFolders(settings,'local',[c]),after=organized.caseChanges[0].newDirectory;await fs.access(path.join(work,after,'案件信息.json'));
 result.folderNames={initial:before,afterOrganization:after,initialContainsCompany:before.includes('合成客户'),renamedFolders:organized.report.renamedFolders};assert.equal(result.folderNames.initialContainsCompany,false);
 const service=new DesktopService(path.join(temporary,'profile'),vault);await service.init();service.workspace.settings=settings;
 const at=Date.now()-6*60*1000;service.submissionCache.set('terminal-six-minutes',{at,submission:{state:'received',source:'hand',checkedAt:new Date(at).toISOString()}});
 result.terminalCache={containerTtlMs:service.submissionCache.ttl,entryAfterSixMinutesRetained:!!service.submissionCache.get('terminal-six-minutes'),documentedTerminalTtlMs:60*60*1000};assert.equal(result.terminalCache.entryAfterSixMinutesRetained,false);
 service.account={origin:'https://synthetic.invalid',username:'synthetic',userId:'synthetic',displayName:'合成',organization:'合成',status:'authenticated',remembered:false};
 let calls=0;service.client={personalProcessStatistics:async()=>[],personalCasesSnapshot:async()=>{calls++;throw Error('SYNTHETIC_SYNC_FAILURE');}};
 await service.sync({source:'startup'});const first=calls;await service.sync({source:'startup'});const second=calls;await service.sync({source:'manual'});const manual=calls;
 result.failedSyncThrottle={afterFirstFailure:first,afterImmediateAutomaticRetry:second,afterManualRetry:manual,automaticRetrySkipped:second===first};assert.equal(first,1);assert.equal(second,1);assert.equal(manual,2);
}finally{await fs.rm(temporary,{recursive:true,force:true});}
const serialized=JSON.stringify(result,null,2)+'\n';
if(process.argv[2])await fs.writeFile(path.resolve(process.argv[2]),serialized);
console.log(serialized);
