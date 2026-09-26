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
import { handleModelIpc, ModelRequestRegistry, parseModelIpcRequest } from './model-ipc.ts';
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
  ipcApplicationPreferences,
  ipcBoolean,
  ipcCaseId,
  ipcCreateCaseInput,
  ipcArgs,
  ipcDiagnosticReport,
  ipcDirectoryKind,
  ipcDocumentToolsConfig,
  ipcExtensionMethod,
  ipcExtensionsArgs,
  ipcOptional,
  ipcLoginInput,
  ipcMaterialId,
  ipcProcessId,
  ipcPriorArtMethod,
  ipcPriorArtArgs,
  ipcProfessionalCommand,
  ipcProfileKey,
  ipcRelativePath,
  ipcSettings,
  ipcNoArgs,
  ipcSyncSource,
  ipcText,
  ipcTransferRole,
  ipcTransferFilePreviewRef,
  ipcTransferReview,
  ipcTransferSource,
  ipcWorkspace,
} from './ipc-contracts.ts';
import { serializeContractError } from '../src/contracts/version.ts';

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
      const requestGeneration=service.generation;
      const requestProfileKey=service.key;
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
        const onResponse=(event:Electron.IpcMainEvent,id:unknown,confirmed:unknown)=>{
          if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)return;
          if(service.generation!==requestGeneration||service.key!==requestProfileKey){finish(false);return;}
          if(typeof id!=='string'||typeof confirmed!=='boolean')return;
          if(id===reqId)finish(confirmed);
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
  function handle(name:string,parser:(args:readonly unknown[])=>unknown[],fn:(...args:unknown[])=>unknown,queued=false,rejectIfMigrating=false){ipcMain.handle('desktop:'+name,async(event,...args)=>{
    if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('不接受非应用窗口请求。');
    const started=Date.now();
    if(name!=='diagnosticReport')diagnostic('ipc','started',{operation:name});
    try{
      if(quitting)throw new Error('应用正在退出。');
      if(rejectIfMigrating)service.assertMigrationNotAccepted();
      const parsed=parser(args);
      return await (queued?serial(async()=>fn(...parsed)):fn(...parsed));
    }catch(e){diagnostic('ipc','failed',{operation:name,...diagnosticError(e)});throw serializeContractError(e);}finally{if(name!=='diagnosticReport')diagnostic('ipc','finished',{operation:name,durationMs:Date.now()-started});}
  });}
  handle('diagnosticExport',ipcNoArgs,exportDiagnostics);
  let rendererReports=0,rendererWindow=0;
  handle('diagnosticReport',ipcArgs(ipcDiagnosticReport),(input:unknown)=>{
    if(Date.now()-rendererWindow>60000){rendererWindow=Date.now();rendererReports=0;}
    if(++rendererReports>60)return;
    const v=input as {type?:string;line?:number;column?:number};
    if(v&&['error','unhandledrejection','react_error'].includes(v.type||''))diagnostic('renderer','error',{type:v.type,line:v.line,column:v.column});
  });
  const chosen=new Set<string>();
  handle('applicationGet',ipcNoArgs,()=>applicationSettings.view());
  handle('applicationSave',ipcArgs(ipcApplicationPreferences),async(input:unknown)=>{const view=await applicationSettings.save(input);configureTray();return view;},true);
  handle('applicationMinimize',ipcNoArgs,()=>window?.minimize());
  handle('applicationQuit',ipcNoArgs,()=>{app.quit();});
  handle('caseInfo',ipcArgs(ipcProfileKey,ipcCaseId),(key:unknown,id:unknown)=>service.caseInfo(key as string,id as string));
  handle('refreshCaseOutcomes',ipcArgs(ipcProfileKey),(key:unknown)=>service.refreshCaseOutcomes(key as string),true,true);
  handle('refreshCaseOutcome',ipcArgs(ipcProfileKey,ipcCaseId),(key:unknown,id:unknown)=>service.refreshCaseOutcome(key as string,id as string),true,true);
  handle('selectCurrentProcess',ipcArgs(ipcProfileKey,ipcCaseId,ipcProcessId),(key:unknown,id:unknown,processId:unknown)=>service.selectCurrentProcess(key as string,id as string,processId as string),true,true);
  handle('bootstrap',ipcNoArgs,()=>service.state());
  handle('verifyLogin',ipcNoArgs,async()=>{const s=await service.verifyLogin(true);if(s.account?.status==='authenticated'&&s.workspace.settings.workRoot&&!service.isWorkMigrationBusy())void service.sync({source:'login'}).catch(()=>{});return s;});
  handle('extensions',ipcExtensionsArgs,async(methodValue:unknown,keyValue:unknown,...args:unknown[])=>{
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

  handle('priorArt',ipcPriorArtArgs,async(methodValue:unknown,keyValue:unknown,id?:unknown,content?:unknown)=>{
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

  handle('login',ipcArgs(ipcLoginInput),async(input:unknown)=>{const s=await service.login(ipcLoginInput(input));if(s.workspace.settings.workRoot&&!service.isWorkMigrationBusy())void service.sync({source:'login'}).catch(()=>{});return s;},true,true);
  handle('logout',ipcNoArgs,()=>service.logout(),true,true);
  handle('selectDirectory',ipcArgs(ipcDirectoryKind),async(kind:unknown)=>{
    const directoryKind=kind as 'originalLibrary'|'workRoot';
    const r=await dialog.showOpenDialog(window!,{title:directoryKind==='originalLibrary'?'选择原始申请文件库':'选择总工作文件夹',properties:directoryKind==='workRoot'?['openDirectory','createDirectory']:['openDirectory']});
    const selected=r.canceled?null:r.filePaths[0];if(selected)chosen.add(selected);return selected;
  },false,true);
  handle('previewWorkMigration',ipcArgs(ipcProfileKey,ipcText('目录参数',4096)),async(key:unknown,destination:unknown)=>{
    const profileKey=key as string,destinationPath=destination as string;
    if(!chosen.has(destinationPath))throw new Error('请使用系统文件夹选择器设置目录。');
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    return service.previewWorkMigration(profileKey,destinationPath);
  },true,true);
  handle('startWorkMigration',ipcArgs(ipcProfileKey,ipcText('迁移预览标识',256)),async(key:unknown,previewId:unknown)=>{
    const profileKey=key as string,preview=previewId as string;
    service.assertMigrationPreviewAllowed(preview,chosen);
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    service.markWorkMigrationQueued();
    try{return await serial(()=>service.startWorkMigration(profileKey,preview));}
    finally{service.clearWorkMigrationQueued();}
  });
  handle('cancelWorkMigration',ipcNoArgs,()=>service.cancelWorkMigration());
  handle('organizeWorkFolders',ipcArgs(ipcProfileKey),async(key:unknown)=>{
    const profileKey=key as string;
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    service.markWorkMigrationQueued();
    try{return await serial(()=>service.organizeFolders(profileKey));}
    finally{service.clearWorkMigrationQueued();}
  },false,true);
  handle('saveSettings',ipcArgs(ipcProfileKey,ipcSettings),async(key:unknown,settingsValue:unknown)=>{
    const profileKey=key as string;
    const settings=settingsValue as ReturnType<typeof ipcSettings>;
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
  handle('saveWorkspace',ipcArgs(ipcProfileKey,ipcWorkspace),(key:unknown,w:unknown)=>service.save(key as string,w as ReturnType<typeof ipcWorkspace>),true,true);
  handle('createCase',ipcArgs(ipcCreateCaseInput),(input:unknown)=>service.createCase(input as ReturnType<typeof ipcCreateCaseInput>),true,true);
  handle('refreshShared',ipcArgs(ipcProfileKey),(key:unknown)=>service.refreshShared(key as string),true,true);
  handle('sync',ipcArgs(ipcSyncSource),(source:unknown)=>{if(service.isWorkMigrationBusy())return service.state();return service.sync({source:source==='focus'?'focus':'manual'});});
  handle('flow',ipcArgs(ipcCaseId),(id:unknown)=>service.flow(id as string,fn=>serial(fn)),false,true);
  handle('findOriginals',ipcArgs(ipcCaseId),(id:unknown)=>service.findOriginals(id as string),false,true);
  handle('copyOriginal',ipcArgs(ipcCaseId,ipcMaterialId),(id:unknown,source:unknown)=>service.copyOriginal(id as string,source as string),true,true);
  handle('openCaseDirectory',ipcArgs(ipcCaseId),async(id:unknown)=>{const caseId=id as string;await service.files().writeFileGuide(service.findCase(caseId));const error=await shell.openPath(await service.casePath(caseId));if(error)throw new Error('系统未能打开案件目录。');},false,true);
  handle('openMaterial',ipcArgs(ipcCaseId,ipcRelativePath),async(id:unknown,rel:unknown)=>{
    const caseId=id as string,relativePath=rel as string,key=service.key,c=service.findCase(caseId);
    const material=[...(c.materials??[]),...c.rounds.flatMap(r=>r.materials)].some(m=>m.relativePath===relativePath&&m.ready);
    if(!material){const view=await agentHost.getCase(key,caseId);if(!view.artifacts.some(a=>a.relativePath===relativePath))throw new Error('文件不属于当前案件。');}
    service.assertKey(key);
    const error=await shell.openPath(await service.casePath(caseId,relativePath));if(error)throw new Error('系统未能打开该文件。');
  },false,true);
  handle('selectDshDirectory',ipcNoArgs,async()=>{
    const r=await dialog.showOpenDialog(window!,{title:'选择 DSH 目录',defaultPath:path.join(app.getPath('home'),'.dsh'),properties:['openDirectory','showHiddenFiles']});
    const selected=r.canceled?null:r.filePaths[0];
    if(selected)chosenDsh.add(path.resolve(selected));
    return selected;
  },false,true);
  handle('professionalGet',ipcArgs(ipcProfileKey,ipcCaseId),(key:unknown,id:unknown)=>professionalHost.getCase(key as string,id as string));
  handle('professionalReviews',ipcArgs(ipcProfileKey),(key:unknown)=>professionalHost.listReviews(key as string));
  handle('professionalCommand',ipcArgs(ipcProfileKey,ipcCaseId,ipcProfessionalCommand),(key:unknown,id:unknown,cmd:unknown)=>professionalHost.command(key as string,id as string,cmd as ReturnType<typeof ipcProfessionalCommand>));
  handle('professionalPick',ipcArgs(ipcProfileKey,ipcCaseId),async(key:unknown,id:unknown)=>{
    const profileKey=key as string,caseId=id as string;
    service.assertKey(profileKey);const processKey=service.findCase(caseId).current?.processId,generation=service.generation;
    const picked=await dialog.showOpenDialog(window!,{title:'选择本案完成稿（原件保留）',properties:['openFile','multiSelections'],filters:[{name:'稿件与图像',extensions:['docx','doc','pdf','txt','md','png','jpg','jpeg']}]});
    if(generation!==service.generation||service.findCase(caseId).current?.processId!==processKey)throw new Error('账号或案件流程已变化，请重新选择。');
    return picked.canceled?professionalHost.getCase(profileKey,caseId):professionalHost.addFiles(profileKey,caseId,picked.filePaths);
  },false,true);
  handle('professionalPickReferences',ipcArgs(ipcProfileKey,ipcCaseId),async(key:unknown,id:unknown)=>{
    const profileKey=key as string,caseId=id as string;
    service.assertKey(profileKey);const c=service.findCase(caseId),before=JSON.stringify(c.current),generation=service.generation;
    const picked=await dialog.showOpenDialog(window!,{title:'添加本案撰写参考材料（原件保留）',properties:['openFile','multiSelections'],filters:[{name:'文档与图像',extensions:['docx','doc','pdf','txt','md','png','jpg','jpeg']}]});
    service.assertKey(profileKey);if(generation!==service.generation||JSON.stringify(service.findCase(caseId).current)!==before)throw new Error('账号或案件流程已变化，请重新选择。');
    return picked.canceled?professionalHost.getCase(profileKey,caseId):professionalHost.addReferences(profileKey,caseId,picked.filePaths);
  },true,true);
  handle('professionalRemoveReference',ipcArgs(ipcProfileKey,ipcCaseId,ipcMaterialId),(key:unknown,id:unknown,mid:unknown)=>professionalHost.removeReference(key as string,id as string,mid as string),true,true);
  handle('professionalOpen',ipcArgs(ipcProfileKey,ipcCaseId,ipcRelativePath),async(key:unknown,id:unknown,rel:unknown)=>{
    const profileKey=key as string,caseId=id as string,relativePath=rel as string,generation=service.generation;
    return professionalHost.fileAllowed(profileKey,caseId,relativePath).then(async allowed=>{
      if(!allowed)throw new Error('文件不属于本案成果。');
      const target=await service.casePath(caseId,relativePath);
      service.assertKey(profileKey);
      if(generation!==service.generation)throw new Error('账号已变化，请重新打开成果。');
      const error=await shell.openPath(target);if(error)throw new Error('文件未能打开。');
    });
  });
  handle('agentGetCase',ipcArgs(ipcProfileKey,ipcCaseId),(profileKey:unknown,caseId:unknown)=>agentHost.getCase(profileKey as string,caseId as string));
  handle('agentCommand',ipcArgs(ipcProfileKey,ipcCaseId,ipcAgentCommand),(profileKey:unknown,caseId:unknown,command:unknown)=>agentHost.command(profileKey as string,caseId as string,command as ReturnType<typeof ipcAgentCommand>));
  handle('agentProgress',ipcArgs(ipcProfileKey),(profileKey:unknown)=>agentHost.listProgress(profileKey as string));
  handle('agentTasks',ipcArgs(ipcProfileKey),async(profileKey:unknown)=>[...await agentHost.listTasks(profileKey as string),...await professionalHost.listTasks(profileKey as string)]);
  let detectedTools=await detectLocalTools();
  const documentStatus=async()=>({permissions:localToolPermissions(),detectedTools,converter:await findDocumentConverter()??null,vision:true,managed:managedToolsStatus(),webEnabled:converterConfig.webEnabled!==false,autoInstall:converterConfig.autoInstall!==false});
  handle('documentToolsStatus',ipcNoArgs,documentStatus);
  handle('documentToolsDetect',ipcNoArgs,async()=>{detectedTools=await detectLocalTools();return documentStatus();});
  handle('documentToolsSelect',ipcNoArgs,async()=>{
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    const r=await dialog.showOpenDialog(window!,{title:'选择 LibreOffice 应用或 soffice 可执行文件',properties:['openFile'],filters:process.platform==='darwin'?[{name:'LibreOffice',extensions:['app','*']}]:[{name:'LibreOffice',extensions:['exe']}]});
    if(!r.canceled){let executable=r.filePaths[0];if(executable.endsWith('.app'))executable=path.join(executable,'Contents','MacOS','soffice');if(!['soffice','soffice.exe','libreoffice'].includes(path.basename(executable).toLowerCase()))throw new Error('请选择 LibreOffice 的 soffice 可执行文件。');converterConfig={...converterConfig,executable};configureConverter();if(!await findDocumentConverter())throw new Error('所选组件不可用。');await atomicJSON(converterFile,converterConfig);}
    return documentStatus();
  },true,true);
  handle('documentToolsInstall',ipcNoArgs,async()=>{await ensureDocumentTool(undefined,true);return documentStatus();});
  handle('documentToolsRemove',ipcNoArgs,async()=>{agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();await removeDocumentTool();return documentStatus();},true,true);
  handle('documentToolsConfigure',ipcArgs(ipcDocumentToolsConfig),async(value:unknown)=>{
    agentHost.assertIdleForMigration();professionalHost.assertIdleForMigration();
    const config=value as ReturnType<typeof ipcDocumentToolsConfig>;
    const next={...converterConfig,webEnabled:config.webEnabled,autoInstall:config.autoInstall,commandsEnabled:config.commandsEnabled,downloadsEnabled:config.downloadsEnabled};await atomicJSON(converterFile,next);converterConfig=next;configureConverter();return documentStatus();
  },true,true);
  handle('documentToolsOpen',ipcNoArgs,async()=>{await import('node:fs/promises').then(fs=>fs.mkdir(path.join(service.root,'tools'),{recursive:true}));await shell.openPath(path.join(service.root,'tools'));});
  handle('transferInspect',ipcArgs(ipcProfileKey,ipcCaseId),(key:unknown,id:unknown)=>transferHost.inspect(key as string,id as string),true,true);
  handle('transferPrepare',ipcArgs(ipcProfileKey,ipcCaseId,ipcOptional(ipcTransferSource)),(key:unknown,id:unknown,sourceMode:unknown)=>transferHost.prepare(key as string,id as string,false,sourceMode as 'workbench'|'local'|undefined),true,true);
  handle('transferPickFile',ipcArgs(ipcProfileKey,ipcCaseId,ipcTransferRole),async(key:unknown,id:unknown,role:unknown)=>{
    const profileKey=key as string,caseId=id as string,fileRole=role as 'baseline'|'application'|'reply';
    const selected=await dialog.showOpenDialog(window!,{title:fileRole==='baseline'?'选择本次修改所基于的完整申请文件':fileRole==='reply'?'选择本次定稿意见陈述书':'选择完整修改后的申请文件',filters:[{name:'Word 文档',extensions:['docx']}],properties:['openFile']});
    if(selected.canceled)return transferHost.refresh(profileKey,caseId);
    return transferHost.addFile(profileKey,caseId,fileRole,selected.filePaths[0]);
  },true,true);
  handle('transferStartHand',ipcArgs(ipcProfileKey,ipcCaseId),(key:unknown,id:unknown)=>transferHost.startHand(key as string,id as string),true,true);
  handle('transferSaveLocalReview',ipcArgs(ipcProfileKey,ipcCaseId,ipcTransferReview),(key:unknown,id:unknown,review:unknown)=>transferHost.saveLocalReview(key as string,id as string,review as ReturnType<typeof ipcTransferReview>),true,true);
  handle('transferSave',ipcArgs(ipcProfileKey,ipcCaseId,ipcTransferReview),(key:unknown,id:unknown,review:unknown)=>transferHost.save(key as string,id as string,review as ReturnType<typeof ipcTransferReview>),true,true);
  handle('transferSubmit',ipcArgs(ipcProfileKey,ipcCaseId,ipcOptional(ipcTransferReview)),async(key:unknown,id:unknown,review:unknown)=>{const profileKey=key as string,caseId=id as string;const v=await transferHost.submit(profileKey,caseId,review as ReturnType<typeof ipcTransferReview>|undefined);if(v.phase==='submitted')professionalHost.noteSubmitted(profileKey,v.caseId);else professionalHost.changed(profileKey);return v;},true,true);
  handle('transferRefresh',ipcArgs(ipcProfileKey,ipcCaseId),async(key:unknown,id:unknown)=>{const profileKey=key as string,caseId=id as string;const v=await transferHost.refresh(profileKey,caseId);if(v.phase==='submitted')professionalHost.noteSubmitted(profileKey,v.caseId);else professionalHost.changed(profileKey);return v;},true,true);
  handle('transferReprepare',ipcArgs(ipcProfileKey,ipcCaseId),(key:unknown,id:unknown)=>transferHost.reprepare(key as string,id as string),true,true);
  handle('transferRevoke',ipcArgs(ipcProfileKey,ipcCaseId),(key:unknown,id:unknown)=>transferHost.revoke(key as string,id as string),true,true);
  handle('transferRemoveFile',ipcArgs(ipcProfileKey,ipcCaseId,ipcTransferRole),(key:unknown,id:unknown,role:unknown)=>transferHost.removeFile(key as string,id as string,role as 'baseline'|'application'|'reply'),true,true);
  handle('transferClearRemote',ipcArgs(ipcProfileKey,ipcCaseId),(key:unknown,id:unknown)=>transferHost.clearRemote(key as string,id as string),true,true);
  handle('transferPreviewFile',ipcArgs(ipcProfileKey,ipcCaseId,ipcTransferFilePreviewRef),(key:unknown,id:unknown,fileRef:unknown)=>transferHost.previewFile(key as string,id as string,fileRef as ReturnType<typeof ipcTransferFilePreviewRef>),true,true);
  ipcMain.handle('desktop:model',async(event,method,profileKey,args,requestId)=>{
    if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('不接受非应用窗口请求。');
    const name='model';
    const started=Date.now();
    diagnostic('ipc','started',{operation:name});
    try{
      if(quitting)throw new Error('应用正在退出。');
      const request=parseModelIpcRequest(method,profileKey,args,requestId);
      return await handleModelIpc({
        modelService,serial,
        isMainFrame:(sender,frame)=>sender===window?.webContents&&frame===window.webContents.mainFrame,
        senderId:sender=>sender.id,
        getProfileKey:()=>service.key,
        getGeneration:()=>service.generation,
        chosenDsh,
      },modelRequests,event.sender,event.senderFrame,request.method,request.profileKey,request.args,request.requestId);
    }catch(e){diagnostic('ipc','failed',{operation:name,...diagnosticError(e)});throw serializeContractError(e);}finally{diagnostic('ipc','finished',{operation:name,durationMs:Date.now()-started});}
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
