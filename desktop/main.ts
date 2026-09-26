import { initializeDiagnostics, diagnostic, diagnosticError, sampleRuntime } from './diagnostics.ts';
import { writeFile } from 'node:fs/promises';
import { ensureCaseStarted } from './start-work.ts';
import { probeMcp } from './mcp-probe.ts';
import { ExtensionService } from './extensions.ts';
import { PatsnapService } from './patsnap.ts';
import { preparePriorArt } from './prior-art.ts';
import { configureLocalTools, localToolPermissions, detectLocalTools } from './agent-local-tools.ts';
import { ProfessionalHost } from './professional-host.ts';
import { ApplicationSettings, loginArguments } from './application-settings.ts';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { DesktopService } from './service.ts';
import { ModelService } from './model-service.ts';
import { handleModelIpc, ModelRequestRegistry } from './model-ipc.ts';
import { AgentHost } from './agent-host.ts';
import { TransferHost } from './transfer-host.ts';
import { configureDocumentConverter, findDocumentConverter } from './document-converter.ts';
import { configureManagedTools, configureAutomaticInstall, ensureDocumentTool, managedToolsStatus, removeDocumentTool } from './managed-tools.ts';
import { configureWebTools } from './agent-web.ts';
import { atomicJSON, readJSON } from './files.ts';
import { OpenCodeRunner } from './agent-runner.ts';
import { bundledOpenCodePath, createHostRun, replyRulesRoot } from './agent-integration.ts';
import {
  ipcAgentCommand,
  ipcBoolean,
  ipcCaseId,
  ipcCreateCaseInput,
  ipcExtensionMethod,
  ipcLoginInput,
  ipcMaterialId,
  ipcProcessId,
  ipcPriorArtMethod,
  ipcProfessionalCommand,
  ipcProfileKey,
  ipcRelativePath,
  ipcSettings,
  ipcTransferRole,
  ipcTransferFilePreviewRef,
  ipcTransferReview,
  ipcTransferSource,
  ipcWorkspace,
} from './ipc-contracts.ts';

app.setName('专利工作台');
if(process.env.PATENT_AGENT_DATA_DIR)app.setPath('userData',path.resolve(process.env.PATENT_AGENT_DATA_DIR));
let window:BrowserWindow|null=null,service:DesktopService,modelService:ModelService,agentHost:AgentHost,quitting=false,closing=false,readyToQuit=false;
const modelRequests=new ModelRequestRegistry();
const chosenDsh=new Set<string>();
let operations=Promise.resolve();
const serial=<T>(fn:()=>Promise<T>)=>{const p=operations.then(fn);operations=p.then(()=>{},()=>{});return p;};
let agentOps=Promise.resolve();
const agentSerial=<T>(fn:()=>Promise<T>)=>{const p=agentOps.then(fn);agentOps=p.then(()=>{},()=>{});return p;};
if(!app.requestSingleInstanceLock())app.quit();
else {
app.on('second-instance',()=>{window?.show();window?.focus();});
app.whenReady().then(async()=>{
  const diagnostics=initializeDiagnostics(path.join(app.getPath('userData'),'diagnostics'));
  const stopRuntimeSampling=sampleRuntime();
  app.on('will-quit',stopRuntimeSampling);
  diagnostic('app','started',{version:app.getVersion(),platform:process.platform});
  process.on('uncaughtExceptionMonitor',error=>diagnostic('main','uncaught',diagnosticError(error)));
  process.on('unhandledRejection',error=>diagnostic('main','unhandled_rejection',diagnosticError(error)));
  const exportDiagnostics=async()=>{
    const snapshot=diagnostics.snapshot(app.getVersion());
    const choice=await dialog.showSaveDialog({title:'导出最近 10 分钟诊断日志',defaultPath:`专利工作台-诊断-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,filters:[{name:'诊断日志',extensions:['json']}]});
    if(choice.canceled||!choice.filePath)return {canceled:true};
    await writeFile(choice.filePath,JSON.stringify(snapshot,null,2),{mode:0o600});
    return {canceled:false,path:choice.filePath,count:snapshot.records.length,droppedWrites:snapshot.droppedWrites};
  };

  service=new DesktopService(app.getPath('userData'),{available:()=>safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text'),encrypt:text=>safeStorage.encryptString(text),decrypt:data=>safeStorage.decryptString(data)});
  service.version=app.getVersion();
  modelService=new ModelService({root:service.root,profileKey:()=>service.key,generation:()=>service.generation,getVault:()=>service.vault});
  try{await service.init(false);}catch(e){dialog.showErrorBox('本机记录读取失败',(e as Error).message);app.quit();return;}
  const startupSupported=process.platform==='darwin'||process.platform==='win32';
  const loginOptions=loginArguments(process.platform,process.execPath,process.env.PORTABLE_EXECUTABLE_FILE);
  const applicationSettings=new ApplicationSettings(path.join(service.root,'application-settings.json'),{
    get:()=>app.getLoginItemSettings(loginOptions),
    set:enabled=>app.setLoginItemSettings({...loginOptions,openAtLogin:enabled}),
  },startupSupported,app.isPackaged);
  await applicationSettings.init();
  const autoStarted=process.argv.includes('--startup') || (process.platform==='darwin'&&app.getLoginItemSettings().wasOpenedAtLogin);
  const startHidden=autoStarted&&applicationSettings.preferences.startHidden;
  const patsnap=new PatsnapService(service.root,service.vault);
  service.preparePriorArt=(c,key,signal,files)=>preparePriorArt(c,files??service.files(),patsnap,key,signal);
  const converterFile=path.join(service.root,'document-tools.json');
  let converterConfig=await readJSON<{executable?:string;webEnabled?:boolean;autoInstall?:boolean;commandsEnabled?:boolean;downloadsEnabled?:boolean}>(converterFile,{});
  configureManagedTools(path.join(service.root,'tools'));
  const configureConverter=()=>{configureDocumentConverter(converterConfig.executable,path.join(service.root,'profiles',service.key,'document-conversions'));configureWebTools(converterConfig.webEnabled!==false);configureAutomaticInstall(converterConfig.autoInstall!==false);configureLocalTools({commandsEnabled:converterConfig.commandsEnabled===true,downloadsEnabled:converterConfig.downloadsEnabled===true});};
  configureConverter();
  const extensions=new ExtensionService(service.root,service.vault);
  let hostRun=createHostRun({run:async()=>{throw new Error('产品未捆绑 OpenCode 运行时，无法启动 Agent。请使用带运行时的安装包。');}});
  try{
    const binary=bundledOpenCodePath({resourcesPath:process.resourcesPath,appPath:app.getAppPath()});
    hostRun=createHostRun(new OpenCodeRunner({binaryPath:binary}),extensions);
  }catch(e){
    const message=(e as Error).message||'产品未捆绑 OpenCode 运行时，无法启动 Agent。';
    hostRun=createHostRun({run:async()=>{throw new Error(message);}});
  }
  agentHost=new AgentHost({
    desktopService:service,
    beforeFormalRun:(key,id)=>ensureCaseStarted(service,key,id),
    modelService,
    serialize:agentSerial,
    rulesRoot:replyRulesRoot(app.getAppPath()),
    standardSkillsRoot:path.join(app.getAppPath(),'resources','standard-skills'),
    run:hostRun,
  });
  const professionalHost=new ProfessionalHost(service,agentHost,modelService,hostRun,path.join(app.getAppPath(),'resources'));
  professionalHost.beforeWriting=(key,id)=>ensureCaseStarted(service,key,id);
  professionalHost.changed=key=>{if(window&&!window.isDestroyed())window.webContents.send('desktop:professionalState',key);};
  const transferHost=new TransferHost(service,agentHost,{
    confirmName:async({applicationName,caseName})=>{
      if(!window||window.isDestroyed())return false;
      const reqId=`cn_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      return new Promise<boolean>((resolve)=>{
        let settled=false;
        const finish=(result:boolean)=>{
          if(settled)return;
          settled=true;
          clearTimeout(timer);
          ipcMain.removeListener('desktop:transferConfirmNameResponse',onResponse);
          resolve(result);
        };
        const timer=setTimeout(()=>finish(false),5*60*1000);
        const onResponse=(_e:unknown,id:string,confirmed:boolean)=>{
          if(id===reqId)finish(Boolean(confirmed));
        };
        ipcMain.on('desktop:transferConfirmNameResponse',onResponse);
        try{
          window!.webContents.send('desktop:transferConfirmNameRequest',{reqId,applicationName,caseName});
        }catch{
          finish(false);
        }
      });
    },
    templatesRoot:path.join(app.getAppPath(),'resources','document-templates'),
    applicationFile:(key,id)=>professionalHost.submissionApplication(key,id),
  });
  window=new BrowserWindow({show:!startHidden,width:1400,height:940,minWidth:900,minHeight:650,title:'专利工作台',icon:path.join(app.getAppPath(),'resources/branding/icon.png'),backgroundColor:'#f6f7f9',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.on('unresponsive',()=>diagnostic('renderer','unresponsive'));
  window.on('responsive',()=>diagnostic('renderer','responsive'));
  window.webContents.on('render-process-gone',(_e,details)=>diagnostic('renderer','process_gone',{state:details.reason,exitCode:details.exitCode}));
  const showWindow=()=>{if(window?.isMinimized())window.restore();window?.show();window?.focus();};
  let tray:Tray|null=null;
  const configureTray=()=>{
    const p=applicationSettings.preferences;
    if(p.closeBehavior==='background'||p.minimizeToTray||p.startHidden){
      if(!tray){
        tray=new Tray(nativeImage.createFromPath(path.join(app.getAppPath(),'resources/branding/icon.png')).resize({width:20,height:20}));
        tray.setToolTip('专利工作台');
        tray.setContextMenu(Menu.buildFromTemplate([{label:'打开专利工作台',click:showWindow},{type:'separator'},{label:'退出应用',click:()=>app.quit()}]));
        tray.on('click',showWindow);
      }
    }else if(tray){if(window&&!window.isVisible())showWindow();tray.destroy();tray=null;}
  };
  configureTray();
  app.on('activate',showWindow);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'专利工作台',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'unhide'},{type:'separator'},{role:'quit'}]},{label:'帮助',submenu:[{label:'导出最近 10 分钟日志…',click:()=>{void exportDiagnostics().catch(()=>dialog.showErrorBox('日志导出失败','请检查保存位置和磁盘空间。'));}}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'窗口',submenu:[{role:'minimize'},{role:'zoom'}]}]));
  const page=path.join(__dirname,'../dist/index.html');
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',e=>e.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_w,_permission,callback)=>callback(false));
  const emitDesktop=()=>{if(window&&!window.isDestroyed())window.webContents.send('desktop:state',service.state());};
  service.changed=()=>{
    configureConverter();
    modelService.noteAccountChange();
    agentHost.noteAccountChange();
    professionalHost.noteScopeChange();
    professionalHost.changed(service.key);
    emitDesktop();
  };
  agentHost.onChanged(view=>{
    if(quitting||view.profileKey!==service.key)return;
    if(window&&!window.isDestroyed())window.webContents.send('desktop:agentState',view);
  });
  agentHost.preparationChanged=view=>{if(!quitting&&view.profileKey===service.key&&window&&!window.isDestroyed())window.webContents.send('desktop:agentPreparation',view);};
  function handle<Args extends unknown[]>(name:string,fn:(...args:Args)=>unknown,queued=false,rejectIfMigrating=false){ipcMain.handle('desktop:'+name,async(event,...args)=>{
    if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('不接受非应用窗口请求。');
    const started=Date.now();
    if(name!=='diagnosticReport')diagnostic('ipc','started',{operation:name});
    try{
      if(quitting)throw new Error('应用正在退出。');
      if(rejectIfMigrating)service.assertMigrationNotAccepted();
      return await (queued?serial(async()=>fn(...args as Args)):fn(...args as Args));
    }catch(e){diagnostic('ipc','failed',{operation:name,...diagnosticError(e)});if(e instanceof Error)throw e;throw new Error('操作未完成。');}finally{if(name!=='diagnosticReport')diagnostic('ipc','finished',{operation:name,durationMs:Date.now()-started});}
  });}
  handle('diagnosticExport',exportDiagnostics);
  let rendererReports=0,rendererWindow=0;
  handle('diagnosticReport',(input:unknown)=>{
    if(Date.now()-rendererWindow>60000){rendererWindow=Date.now();rendererReports=0;}
    if(++rendererReports>60)return;
    const v=input as {type?:string;line?:number;column?:number};
    if(v&&['error','unhandledrejection','react_error'].includes(v.type||''))diagnostic('renderer','error',{type:v.type,line:v.line,column:v.column});
  });
  const chosen=new Set<string>();
  handle('applicationGet',()=>applicationSettings.view());
  handle('applicationSave',async(input:unknown)=>{const view=await applicationSettings.save(input);configureTray();return view;},true);
  handle('applicationMinimize',()=>window?.minimize());
  handle('applicationQuit',()=>{app.quit();});
  handle('caseInfo',(key:unknown,id:unknown)=>service.caseInfo(ipcProfileKey(key),ipcCaseId(id)));
  handle('refreshCaseOutcomes',(key:unknown)=>service.refreshCaseOutcomes(ipcProfileKey(key)),true,true);
  handle('refreshCaseOutcome',(key:unknown,id:unknown)=>service.refreshCaseOutcome(ipcProfileKey(key),ipcCaseId(id)),true,true);
  handle('selectCurrentProcess',(key:unknown,id:unknown,processId:unknown)=>service.selectCurrentProcess(ipcProfileKey(key),ipcCaseId(id),ipcProcessId(processId)),true,true);
  handle('bootstrap',()=>service.state());
  handle('verifyLogin',async()=>{const s=await service.verifyLogin(true);if(s.account?.status==='authenticated'&&s.workspace.settings.workRoot&&!service.isWorkMigrationBusy())void service.sync({source:'login'}).catch(()=>{});return s;});
  handle('extensions',async(methodValue:unknown,keyValue:unknown,...args:unknown[])=>{
    const method=ipcExtensionMethod(methodValue),key=ipcProfileKey(keyValue);
    service.assertKey(key);
    if(method==='list')return extensions.list(key);
    if(method==='test'){const id=ipcMaterialId(args[0]);const e=(await extensions.all(key)).find(e=>e.id===id);if(!e?.config)throw new Error('请选择 MCP。');if(e.config.type==='local'&&!localToolPermissions().commandsEnabled)throw new Error('请先开启任意命令权限。');try{return await probeMcp(await extensions.preparedConfig(e.config));}catch(e){throw new Error((e as Error).message.startsWith('MCP')||(e as Error).message.startsWith('本地 MCP')?(e as Error).message:'MCP 连接测试失败，请核对地址、命令和认证。');}}
    if(method==='toggle')return extensions.toggle(key,ipcMaterialId(args[0]),ipcBoolean(args[1],'扩展启用状态'));
    if(method==='remove')return extensions.remove(key,ipcMaterialId(args[0]));
    if(method==='saveMcp'){if(typeof args[0]!=='string')throw new Error('MCP 配置无效。');if(args[1]!==undefined&&typeof args[1]!=='string')throw new Error('扩展标识无效。');return extensions.saveMcp(key,args[0],args[1]);}
    if(method==='saveSkill'){if(typeof args[0]!=='string'||typeof args[1]!=='string')throw new Error('技能内容无效。');if(args[2]!==undefined&&typeof args[2]!=='string')throw new Error('扩展标识无效。');return extensions.saveSkill(key,args[0],args[1],args[2]);}
    if(method==='importSkill'){
      const r=await dialog.showOpenDialog(window!,{title:'选择包含 SKILL.md 的技能文件夹',properties:['openDirectory']});
      service.assertKey(key);if(r.canceled)return extensions.list(key);return extensions.importSkill(key,r.filePaths[0]);
    }
    throw new Error('不支持的扩展操作。');
  },true,true);

  handle('priorArt',async(methodValue:unknown,keyValue:unknown,id?:unknown,content?:unknown)=>{
    const method=ipcPriorArtMethod(methodValue),key=ipcProfileKey(keyValue);
    service.assertKey(key);
    if(method==='status')return patsnap.status(key);
    if(method==='save')return patsnap.save(key,typeof id==='string'?id:'');
    if(method==='clear')return patsnap.clear(key);
    if(method==='importLegacy')return patsnap.importLegacy(key);
    if(method==='test'){await patsnap.download(key,'CN120069239A');service.assertKey(key);return patsnap.status(key);}
    if(method==='prepare'){
      service.assertMigrationNotAccepted();if(service.syncState.running)throw new Error('正在同步，请稍后重试。');
      const caseId=ipcCaseId(id),text=content===undefined?undefined:typeof content==='string'?content:undefined;
      if(content!==undefined&&text===undefined)throw new Error('对比文件说明无效。');
      const c=service.findCase(caseId);await preparePriorArt(c,service.files(),patsnap,key,undefined,text);service.assertKey(key);
      await service.files().ensureCase(c);await service.persist();service.changed();return service.state();
    }
    throw new Error('不支持的对比文件操作。');
  },true,true);

  handle('login',async(input:unknown)=>{const s=await service.login(ipcLoginInput(input));if(s.workspace.settings.workRoot&&!service.isWorkMigrationBusy())void service.sync({source:'login'}).catch(()=>{});return s;},true,true);
  handle('logout',()=>service.logout(),true,true);
  handle('selectDirectory',async(kind:string)=>{
    if(!['originalLibrary','workRoot'].includes(kind))throw new Error('目录类型无效。');
    const r=await dialog.showOpenDialog(window!,{title:kind==='originalLibrary'?'选择原始申请文件库':'选择总工作文件夹',properties:kind==='workRoot'?['openDirectory','createDirectory']:['openDirectory']});
    const selected=r.canceled?null:r.filePaths[0];if(selected)chosen.add(selected);return selected;
  },false,true);
  handle('previewWorkMigration',async(key:unknown,destination:unknown)=>{
    const profileKey=ipcProfileKey(key);
    if(typeof destination!=='string'||!destination.trim())throw new Error('目录参数无效。');
    if(!chosen.has(destination))throw new Error('请使用系统文件夹选择器设置目录。');
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    return service.previewWorkMigration(profileKey,destination);
  },true,true);
  handle('startWorkMigration',async(key:unknown,previewId:unknown)=>{
    const profileKey=ipcProfileKey(key);
    if(typeof previewId!=='string'||!previewId.trim())throw new Error('迁移预览标识无效。');
    service.assertMigrationPreviewAllowed(previewId,chosen);
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    service.markWorkMigrationQueued();
    try{return await serial(()=>service.startWorkMigration(profileKey,previewId));}
    finally{service.clearWorkMigrationQueued();}
  });
  handle('cancelWorkMigration',()=>service.cancelWorkMigration());
  handle('organizeWorkFolders',async(key:unknown)=>{
    const profileKey=ipcProfileKey(key);
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    service.markWorkMigrationQueued();
    try{return await serial(()=>service.organizeFolders(profileKey));}
    finally{service.clearWorkMigrationQueued();}
  },false,true);
  handle('saveSettings',async(key:unknown,settingsValue:unknown)=>{
    const profileKey=ipcProfileKey(key);
    const settings=ipcSettings(settingsValue);
    for(const k of ['originalLibrary','workRoot'] as const)if(settings[k]&&settings[k]!==service.workspace.settings[k]&&!chosen.has(settings[k]))throw new Error('请使用系统文件夹选择器设置目录。');
    if(settings.workRoot&&settings.workRoot!==service.workspace.settings.workRoot){agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();}
    const saved=await service.settings(profileKey,settings);
    // Reply after the settings write. Index reading / network sync reports its own status.
    if(saved.workspace.settings.workRoot)setImmediate(()=>{
      const report=(e:unknown)=>{if(profileKey!==service.key||quitting)return;service.storageState={running:false,message:'目录已保存，后续读取未完成：'+(e as Error).message};service.changed();};
      void serial(async()=>{
        if(quitting||profileKey!==service.key||service.syncState.running||service.isWorkMigrationBusy())return;
        if(service.account?.status==='authenticated')void service.sync({source:'settings'}).catch(report);
        else await service.refreshShared(profileKey);
      }).catch(report);
    });
    return saved;
  },true,true);
  handle('saveWorkspace',(key:unknown,w:unknown)=>service.save(ipcProfileKey(key),ipcWorkspace(w)),true,true);
  handle('createCase',(input:unknown)=>service.createCase(ipcCreateCaseInput(input)),true,true);
  handle('refreshShared',key=>service.refreshShared(ipcProfileKey(key)),true,true);
  handle('sync',(source:unknown)=>{if(service.isWorkMigrationBusy())return service.state();if(source!==undefined&&source!=='manual'&&source!=='focus')throw new Error('同步来源无效。');return service.sync({source:source==='focus'?'focus':'manual'});});
  handle('flow',(id:unknown)=>service.flow(ipcCaseId(id),fn=>serial(fn)),false,true);
  handle('findOriginals',(id:unknown)=>service.findOriginals(ipcCaseId(id)),false,true);
  handle('copyOriginal',(id:unknown,source:unknown)=>service.copyOriginal(ipcCaseId(id),ipcMaterialId(source)),true,true);
  handle('openCaseDirectory',async(id:unknown)=>{const caseId=ipcCaseId(id);await service.files().writeFileGuide(service.findCase(caseId));const error=await shell.openPath(await service.casePath(caseId));if(error)throw new Error('系统未能打开案件目录。');},false,true);
  handle('openMaterial',async(id:unknown,rel:unknown)=>{
    const caseId=ipcCaseId(id),relativePath=ipcRelativePath(rel),key=service.key,c=service.findCase(caseId);
    const material=[...(c.materials??[]),...c.rounds.flatMap(r=>r.materials)].some(m=>m.relativePath===relativePath&&m.ready);
    if(!material){const view=await agentHost.getCase(key,caseId);if(!view.artifacts.some(a=>a.relativePath===relativePath))throw new Error('文件不属于当前案件。');}
    service.assertKey(key);
    const error=await shell.openPath(await service.casePath(caseId,relativePath));if(error)throw new Error('系统未能打开该文件。');
  },false,true);
  handle('selectDshDirectory',async()=>{
    const r=await dialog.showOpenDialog(window!,{title:'选择 DSH 目录',defaultPath:path.join(app.getPath('home'),'.dsh'),properties:['openDirectory','showHiddenFiles']});
    const selected=r.canceled?null:r.filePaths[0];
    if(selected)chosenDsh.add(path.resolve(selected));
    return selected;
  },false,true);
  handle('professionalGet',(key:unknown,id:unknown)=>professionalHost.getCase(ipcProfileKey(key),ipcCaseId(id)));
  handle('professionalReviews',(key:unknown)=>professionalHost.listReviews(ipcProfileKey(key)));
  handle('professionalCommand',(key:unknown,id:unknown,cmd:unknown)=>professionalHost.command(ipcProfileKey(key),ipcCaseId(id),ipcProfessionalCommand(cmd)));
  handle('professionalPick',async(key:unknown,id:unknown)=>{
    const profileKey=ipcProfileKey(key),caseId=ipcCaseId(id);
    service.assertKey(profileKey);const processKey=service.findCase(caseId).current?.processId,generation=service.generation;
    const picked=await dialog.showOpenDialog(window!,{title:'选择本案完成稿（原件保留）',properties:['openFile','multiSelections'],filters:[{name:'稿件与图像',extensions:['docx','doc','pdf','txt','md','png','jpg','jpeg']}]});
    if(generation!==service.generation||service.findCase(caseId).current?.processId!==processKey)throw new Error('账号或案件流程已变化，请重新选择。');
    return picked.canceled?professionalHost.getCase(profileKey,caseId):professionalHost.addFiles(profileKey,caseId,picked.filePaths);
  },false,true);
  handle('professionalPickReferences',async(key:unknown,id:unknown)=>{
    const profileKey=ipcProfileKey(key),caseId=ipcCaseId(id);
    service.assertKey(profileKey);const c=service.findCase(caseId),before=JSON.stringify(c.current),generation=service.generation;
    const picked=await dialog.showOpenDialog(window!,{title:'添加本案撰写参考材料（原件保留）',properties:['openFile','multiSelections'],filters:[{name:'文档与图像',extensions:['docx','doc','pdf','txt','md','png','jpg','jpeg']}]});
    service.assertKey(profileKey);if(generation!==service.generation||JSON.stringify(service.findCase(caseId).current)!==before)throw new Error('账号或案件流程已变化，请重新选择。');
    return picked.canceled?professionalHost.getCase(profileKey,caseId):professionalHost.addReferences(profileKey,caseId,picked.filePaths);
  },true,true);
  handle('professionalRemoveReference',(key:unknown,id:unknown,mid:unknown)=>professionalHost.removeReference(ipcProfileKey(key),ipcCaseId(id),ipcMaterialId(mid)),true,true);
  handle('professionalOpen',async(key:unknown,id:unknown,rel:unknown)=>{
    const profileKey=ipcProfileKey(key),caseId=ipcCaseId(id),relativePath=ipcRelativePath(rel),generation=service.generation;
    return professionalHost.fileAllowed(profileKey,caseId,relativePath).then(async allowed=>{
      if(!allowed)throw new Error('文件不属于本案成果。');
      const target=await service.casePath(caseId,relativePath);
      service.assertKey(profileKey);
      if(generation!==service.generation)throw new Error('账号已变化，请重新打开成果。');
      const error=await shell.openPath(target);if(error)throw new Error('文件未能打开。');
    });
  });
  handle('agentGetCase',(profileKey:unknown,caseId:unknown)=>agentHost.getCase(ipcProfileKey(profileKey),ipcCaseId(caseId)));
  handle('agentCommand',(profileKey:unknown,caseId:unknown,command:unknown)=>agentHost.command(ipcProfileKey(profileKey),ipcCaseId(caseId),ipcAgentCommand(command)));
  handle('agentProgress',(profileKey:unknown)=>agentHost.listProgress(ipcProfileKey(profileKey)));
  handle('agentTasks',async(profileKey:unknown)=>[...await agentHost.listTasks(ipcProfileKey(profileKey)),...await professionalHost.listTasks(ipcProfileKey(profileKey))]);
  let detectedTools=await detectLocalTools();
  const documentStatus=async()=>({permissions:localToolPermissions(),detectedTools,converter:await findDocumentConverter()??null,vision:true,managed:managedToolsStatus(),webEnabled:converterConfig.webEnabled!==false,autoInstall:converterConfig.autoInstall!==false});
  handle('documentToolsStatus',documentStatus);
  handle('documentToolsDetect',async()=>{detectedTools=await detectLocalTools();return documentStatus();});
  handle('documentToolsSelect',async()=>{
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    const r=await dialog.showOpenDialog(window!,{title:'选择 LibreOffice 应用或 soffice 可执行文件',properties:['openFile'],filters:process.platform==='darwin'?[{name:'LibreOffice',extensions:['app','*']}]:[{name:'LibreOffice',extensions:['exe']}]});
    if(!r.canceled){let executable=r.filePaths[0];if(executable.endsWith('.app'))executable=path.join(executable,'Contents','MacOS','soffice');if(!['soffice','soffice.exe','libreoffice'].includes(path.basename(executable).toLowerCase()))throw new Error('请选择 LibreOffice 的 soffice 可执行文件。');converterConfig={...converterConfig,executable};configureConverter();if(!await findDocumentConverter())throw new Error('所选组件不可用。');await atomicJSON(converterFile,converterConfig);}
    return documentStatus();
  },true,true);
  handle('documentToolsInstall',async()=>{await ensureDocumentTool(undefined,true);return documentStatus();});
  handle('documentToolsRemove',async()=>{agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();await removeDocumentTool();return documentStatus();},true,true);
  handle('documentToolsConfigure',async(value:{webEnabled:boolean;autoInstall:boolean;commandsEnabled:boolean;downloadsEnabled:boolean})=>{
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    if(typeof value?.webEnabled!=='boolean'||typeof value?.autoInstall!=='boolean'||typeof value?.commandsEnabled!=='boolean'||typeof value?.downloadsEnabled!=='boolean')throw new Error('工具权限设置无效。');
    const next={...converterConfig,webEnabled:value.webEnabled,autoInstall:value.autoInstall,commandsEnabled:value.commandsEnabled,downloadsEnabled:value.downloadsEnabled};await atomicJSON(converterFile,next);converterConfig=next;configureConverter();return documentStatus();
  },true,true);
  handle('documentToolsOpen',async()=>{await import('node:fs/promises').then(fs=>fs.mkdir(path.join(service.root,'tools'),{recursive:true}));await shell.openPath(path.join(service.root,'tools'));});
  handle('transferInspect',(key:unknown,id:unknown)=>transferHost.inspect(ipcProfileKey(key),ipcCaseId(id)),true,true);
  handle('transferPrepare',(key:unknown,id:unknown,sourceMode)=>transferHost.prepare(ipcProfileKey(key),ipcCaseId(id),false,sourceMode===undefined?undefined:ipcTransferSource(sourceMode)),true,true);
  handle('transferPickFile',async(key,id,role)=>{
    const profileKey=ipcProfileKey(key),caseId=ipcCaseId(id),fileRole=ipcTransferRole(role);
    const selected=await dialog.showOpenDialog(window!,{title:fileRole==='baseline'?'选择本次修改所基于的完整申请文件':fileRole==='reply'?'选择本次定稿意见陈述书':'选择完整修改后的申请文件',filters:[{name:'Word 文档',extensions:['docx']}],properties:['openFile']});
    if(selected.canceled)return transferHost.refresh(profileKey,caseId);
    return transferHost.addFile(profileKey,caseId,fileRole,selected.filePaths[0]);
  },true,true);
  handle('transferStartHand',(key:unknown,id:unknown)=>transferHost.startHand(ipcProfileKey(key),ipcCaseId(id)),true,true);
  handle('transferSaveLocalReview',(key:unknown,id:unknown,review:unknown)=>transferHost.saveLocalReview(ipcProfileKey(key),ipcCaseId(id),ipcTransferReview(review)),true,true);
  handle('transferSave',(key:unknown,id:unknown,review:unknown)=>transferHost.save(ipcProfileKey(key),ipcCaseId(id),ipcTransferReview(review)),true,true);
  handle('transferSubmit',async(key:unknown,id:unknown,review:unknown)=>{const profileKey=ipcProfileKey(key),caseId=ipcCaseId(id);const v=await transferHost.submit(profileKey,caseId,review===undefined?undefined:ipcTransferReview(review));if(v.phase==='submitted')professionalHost.noteSubmitted(profileKey,v.caseId);else professionalHost.changed(profileKey);return v;},true,true);
  handle('transferRefresh',async(key:unknown,id:unknown)=>{const profileKey=ipcProfileKey(key),caseId=ipcCaseId(id);const v=await transferHost.refresh(profileKey,caseId);if(v.phase==='submitted')professionalHost.noteSubmitted(profileKey,v.caseId);else professionalHost.changed(profileKey);return v;},true,true);
  handle('transferReprepare',(key:unknown,id:unknown)=>transferHost.reprepare(ipcProfileKey(key),ipcCaseId(id)),true,true);
  handle('transferRevoke',(key:unknown,id:unknown)=>transferHost.revoke(ipcProfileKey(key),ipcCaseId(id)),true,true);
  handle('transferRemoveFile',(key:unknown,id:unknown,role)=>transferHost.removeFile(ipcProfileKey(key),ipcCaseId(id),ipcTransferRole(role)),true,true);
  handle('transferClearRemote',(key:unknown,id:unknown)=>transferHost.clearRemote(ipcProfileKey(key),ipcCaseId(id)),true,true);
  handle('transferPreviewFile',(key:unknown,id:unknown,fileRef:unknown)=>transferHost.previewFile(ipcProfileKey(key),ipcCaseId(id),ipcTransferFilePreviewRef(fileRef)),true,true);
  ipcMain.handle('desktop:model',async(event,method,profileKey,args,requestId)=>{
    if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('不接受非应用窗口请求。');
    const name='model';
    const started=Date.now();
    diagnostic('ipc','started',{operation:name});
    try{
      if(quitting)throw new Error('应用正在退出。');
      return await handleModelIpc({
        modelService,serial,
        isMainFrame:(sender,frame)=>sender===window?.webContents&&frame===window.webContents.mainFrame,
        senderId:sender=>sender.id,
        getProfileKey:()=>service.key,
        getGeneration:()=>service.generation,
        chosenDsh,
      },modelRequests,event.sender,event.senderFrame,String(method),String(profileKey??''),Array.isArray(args)?args:[],typeof requestId==='string'?requestId:undefined);
    }catch(e){diagnostic('ipc','failed',{operation:name,...diagnosticError(e)});throw new Error((e as Error).message||'操作未完成。');}finally{diagnostic('ipc','finished',{operation:name,durationMs:Date.now()-started});}
  });
  ipcMain.handle('desktop:modelCancel',async(event,requestId)=>{
    if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('不接受非应用窗口请求。');
    if(typeof requestId!=='string')throw new Error('请求标识无效。');
    modelRequests.cancel(requestId,event.sender.id);
  });
  await window.loadFile(page);
  void service.verifyLogin(true).then(s=>{
    if(s.account?.status==='authenticated'&&s.workspace.settings.workRoot&&!service.isWorkMigrationBusy()){
      void service.sync({source:'startup'}).catch(()=>{});
    }
  }).catch(()=>{
    if(service.account?.status==='authenticated'&&service.workspace.settings.workRoot&&!service.isWorkMigrationBusy()){
      void service.sync({source:'startup'}).catch(()=>{});
    }
  });
  const authTimer=setInterval(()=>{const was=service.account?.status;void service.retryLoginIfDue().then(s=>{if(was!=='authenticated'&&s.account?.status==='authenticated'&&s.workspace.settings.workRoot&&!service.isWorkMigrationBusy())void service.sync({source:'login'}).catch(()=>{});}).catch(()=>{});},5000);
  app.on('before-quit',()=>clearInterval(authTimer));
  window.on('minimize',()=>{if(applicationSettings.preferences.minimizeToTray&&!quitting)window?.hide();});
  window.on('close',e=>{
    if(readyToQuit)return;
    e.preventDefault();
    if(!quitting&&applicationSettings.preferences.closeBehavior==='background'){window?.hide();return;}
    app.quit();
  });
  app.on('before-quit',e=>{
    if(readyToQuit)return;
    e.preventDefault();
    if(closing)return;
    closing=true;
    quitting=true;
    service.controller?.abort();
    service.abortWorkMigration();
    modelService.abortRequests();
    modelRequests.abortAll();
    void Promise.all([agentHost.shutdown(),professionalHost.shutdown()]).then(()=>serial(()=>service.shutdown())).then(()=>{
      readyToQuit=true;
      app.quit();
    }).catch(()=>{
      closing=false;
      quitting=false;
      dialog.showErrorBox('记录保存失败','请保持应用打开，检查磁盘空间后重试。');
    });
  });
});
}
