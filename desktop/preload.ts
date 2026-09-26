import { contextBridge, ipcRenderer } from 'electron';
const call=async(name:string,...args:unknown[])=>{
  try{return await ipcRenderer.invoke('desktop:'+name,...args);}
  catch(e){throw new Error((e instanceof Error?e.message:String(e)).replace(/^Error invoking remote method 'desktop:[^']+': (?:Error: )?/,''));}
};
const modelCall=(method:string,key:string,args:unknown[],requestId?:string)=>call('model',method,key,args,requestId);
contextBridge.exposeInMainWorld('patentDesktop',{
  contractVersion:1,
  diagnosticExport:()=>call('diagnosticExport'),diagnosticReport:(input:unknown)=>call('diagnosticReport',input),
  extensions:{test:(k:string,id:string)=>call('extensions','test',k,id),list:(k:string)=>call('extensions','list',k),toggle:(k:string,id:string,v:boolean)=>call('extensions','toggle',k,id,v),remove:(k:string,id:string)=>call('extensions','remove',k,id),saveMcp:(k:string,raw:string,id?:string)=>call('extensions','saveMcp',k,raw,id),saveSkill:(k:string,n:string,t:string,id?:string)=>call('extensions','saveSkill',k,n,t,id),importSkill:(k:string)=>call('extensions','importSkill',k)},
  priorArt:{status:(k:string)=>call('priorArt','status',k),save:(k:string,v:string)=>call('priorArt','save',k,v),clear:(k:string)=>call('priorArt','clear',k),importLegacy:(k:string)=>call('priorArt','importLegacy',k),test:(k:string)=>call('priorArt','test',k),prepare:(k:string,id:string,v:string)=>call('priorArt','prepare',k,id,v)},
  verifyLogin:()=>call('verifyLogin'),bootstrap:()=>call('bootstrap'),login:(input:unknown)=>call('login',input),logout:()=>call('logout'),
  selectDirectory:(kind:string)=>call('selectDirectory',kind),saveSettings:(key:string,s:unknown)=>call('saveSettings',key,s),saveWorkspace:(key:string,w:unknown)=>call('saveWorkspace',key,w),
  refreshShared:(key:string)=>call('refreshShared',key),sync:(source?:'manual'|'focus')=>call('sync',source),createCase:(input:unknown)=>call('createCase',input),flow:(id:string)=>call('flow',id),
  caseInfo:(key:string,id:string)=>call('caseInfo',key,id),
  refreshCaseOutcomes:(key:string)=>call('refreshCaseOutcomes',key),
  refreshCaseOutcome:(key:string,id:string)=>call('refreshCaseOutcome',key,id),
  selectCurrentProcess:(key:string,id:string,processId:string)=>call('selectCurrentProcess',key,id,processId),
  openCaseDirectory:(id:string)=>call('openCaseDirectory',id),openMaterial:(id:string,rel:string)=>call('openMaterial',id,rel),findOriginals:(id:string)=>call('findOriginals',id),copyOriginal:(id:string,source:string)=>call('copyOriginal',id,source),
  previewWorkMigration:(key:string,destination:string)=>call('previewWorkMigration',key,destination),
  startWorkMigration:(key:string,previewId:string)=>call('startWorkMigration',key,previewId),
  cancelWorkMigration:()=>call('cancelWorkMigration'),
  organizeWorkFolders:(key:string)=>call('organizeWorkFolders',key),
  selectDshDirectory:()=>call('selectDshDirectory'),
  models:{
    list:(key:string)=>modelCall('list',key,[]),
    saveProvider:(key:string,input:unknown)=>modelCall('saveProvider',key,[input]),
    deleteProvider:(key:string,id:string)=>modelCall('deleteProvider',key,[id]),
    setDefault:(key:string,providerId:string,modelId:string)=>modelCall('setDefault',key,[providerId,modelId]),
    testConnection:(key:string,id:string,opts?:{modelEntryId?:string;requestId?:string})=>modelCall('testConnection',key,[id,opts],opts?.requestId),
    listRemoteModels:(key:string,id:string,opts?:{modelEntryId?:string;requestId?:string})=>modelCall('listRemoteModels',key,[id,opts],opts?.requestId),
    addDiscoveredModels:(key:string,id:string,models:unknown)=>modelCall('addDiscoveredModels',key,[id,models]),
    previewDshProviders:(dir:string)=>call('model','previewDshProviders','',[dir]),
    importDshProvider:(key:string,dir:string,providerKey:string)=>call('model','importDshProvider',key,[dir,providerKey]),
    cancelRequest:(requestId:string)=>call('modelCancel',requestId),
    selectDshDirectory:()=>call('selectDshDirectory'),
  },
  agent:{
    onPreparation:(callback:(value:unknown)=>void)=>{
      const listener=(_e:unknown,value:unknown)=>callback(value);
      ipcRenderer.on('desktop:agentPreparation',listener);
      return()=>ipcRenderer.removeListener('desktop:agentPreparation',listener);
    },
    listProgress:(key:string)=>call('agentProgress',key),
    getCase:(key:string,id:string)=>call('agentGetCase',key,id),
    command:(key:string,id:string,cmd:unknown)=>call('agentCommand',key,id,cmd),
    listTasks:(key:string)=>call('agentTasks',key),
    onState:(callback:(view:unknown)=>void)=>{
      const listener=(_e:unknown,view:unknown)=>callback(view);
      ipcRenderer.on('desktop:agentState',listener);
      return()=>ipcRenderer.removeListener('desktop:agentState',listener);
    },
  },
  transfer:{
    inspect:(key:string,id:string)=>call('transferInspect',key,id),
    prepare:(key:string,id:string,sourceMode?:string)=>call('transferPrepare',key,id,sourceMode),
    pickFile:(key:string,id:string,role:string)=>call('transferPickFile',key,id,role),
    removeFile:(key:string,id:string,role:string)=>call('transferRemoveFile',key,id,role),
    clearRemote:(key:string,id:string)=>call('transferClearRemote',key,id),
    previewFile:(key:string,id:string,fileRef:unknown)=>call('transferPreviewFile',key,id,fileRef),
    startHand:(key:string,id:string)=>call('transferStartHand',key,id),
    saveLocalReview:(key:string,id:string,review:unknown)=>call('transferSaveLocalReview',key,id,review),
    save:(key:string,id:string,review:unknown)=>call('transferSave',key,id,review),
    submit:(key:string,id:string,review?:unknown)=>call('transferSubmit',key,id,review),
    refresh:(key:string,id:string)=>call('transferRefresh',key,id),
    reprepare:(key:string,id:string)=>call('transferReprepare',key,id),
    revoke:(key:string,id:string)=>call('transferRevoke',key,id),
    onConfirmNameRequest:(callback:(req:any)=>void)=>{const listener=(_e:unknown,req:any)=>callback(req);ipcRenderer.on('desktop:transferConfirmNameRequest',listener);return()=>ipcRenderer.removeListener('desktop:transferConfirmNameRequest',listener);},
    respondConfirmName:(reqId:string,confirmed:boolean)=>{ipcRenderer.send('desktop:transferConfirmNameResponse',reqId,confirmed);},
  },
  professional:{pickReferences:(key:string,id:string)=>call('professionalPickReferences',key,id),removeReference:(key:string,id:string,mid:string)=>call('professionalRemoveReference',key,id,mid),getCase:(key:string,id:string)=>call('professionalGet',key,id),listReviews:(key:string)=>call('professionalReviews',key),command:(key:string,id:string,cmd:unknown)=>call('professionalCommand',key,id,cmd),pickFiles:(key:string,id:string)=>call('professionalPick',key,id),openFile:(key:string,id:string,rel:string)=>call('professionalOpen',key,id,rel),onState:(callback:(key:string)=>void)=>{const listener=(_e:unknown,key:string)=>callback(key);ipcRenderer.on('desktop:professionalState',listener);return()=>ipcRenderer.removeListener('desktop:professionalState',listener);}},
  application:{get:()=>call('applicationGet'),save:(settings:unknown)=>call('applicationSave',settings),minimize:()=>call('applicationMinimize'),quit:()=>call('applicationQuit')},
  documentTools:{detect:()=>call('documentToolsDetect'),status:()=>call('documentToolsStatus'),selectConverter:()=>call('documentToolsSelect'),installConverter:()=>call('documentToolsInstall'),configure:(value:{webEnabled:boolean;autoInstall:boolean;commandsEnabled:boolean;downloadsEnabled:boolean})=>call('documentToolsConfigure',value),openDirectory:()=>call('documentToolsOpen'),removeConverter:()=>call('documentToolsRemove')},
  onState:(callback:(state:unknown)=>void)=>{const listener=(_e:unknown,state:unknown)=>callback(state);ipcRenderer.on('desktop:state',listener);return()=>ipcRenderer.removeListener('desktop:state',listener);},
});
