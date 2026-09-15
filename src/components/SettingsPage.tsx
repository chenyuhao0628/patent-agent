import {DiagnosticSettings} from './DiagnosticSettings.tsx';
import { ExtensionSettings } from './ExtensionSettings.tsx';
import { PatsnapSettings } from './PriorArt.tsx';
import { ApplicationSettings } from './ApplicationSettings.tsx';
import { DocumentTools } from './DocumentTools.tsx';
import { FolderOrganization } from './FolderOrganization.tsx';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, FileText, FolderOpen, KeyRound, Plug, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Settings } from '../domain/workflow.ts';
import { Modal, Note } from './Primitives.tsx';
import { AccountSettings } from './AccountSettings.tsx';
import { DirectoryMigration } from './DirectoryMigration.tsx';
import { ModelSettings } from './ModelSettings.tsx';
import { desktop } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';

const sections=[{id:'account',title:'贝思兰德账号',icon:ShieldCheck},{id:'files',title:'文件与目录',icon:FolderOpen},{id:'model',title:'模型服务',icon:KeyRound},{id:'template',title:'模板与规则',icon:FileText},{id:'documents',title:'文档工具',icon:FileText},{id:'extensions',title:'技能与 MCP',icon:Plug},{id:'diagnostics',title:'诊断日志',icon:FileText},{id:'updates',title:'应用与更新',icon:RefreshCw}];
type SettingsNotice = {type:'saving'|'success'|'error';text:string} | null;
export function SettingsPage({settings,save,nativeState,refresh,initialSection}:{settings:Settings;save:(s:Settings)=>Settings|void|Promise<Settings|void>;nativeState?:DesktopState;refresh?:(s:DesktopState)=>void;initialSection?:string}){
  const start=initialSection&&sections.some(s=>s.id===initialSection)?initialSection:'account';
  const [value,setValue]=useState(settings),[section,setSection]=useState(start),[notice,setNotice]=useState<SettingsNotice>(null);
  useEffect(()=>{if(initialSection&&sections.some(s=>s.id===initialSection))setSection(initialSection);},[initialSection]);
  const [saving,setSaving]=useState(false);
  const savingRef=useRef(false),editRevision=useRef(0);
  const [templateType,setTemplateType]=useState('审查意见答复'),[showUpdate,setShowUpdate]=useState(false);
  const migrating=!!nativeState?.migration?.running;
  const workRootHasCases=!!nativeState?.workspace.cases.some(c=>c.directory);
  const patch=(p:Partial<Settings>)=>{editRevision.current++;setValue(previous=>({...previous,...p}));setNotice(null);};
  const persist=async()=>{
    if(savingRef.current||migrating)return;savingRef.current=true;setSaving(true);setNotice({type:'saving',text:'正在保存…'});
    const revision=editRevision.current;
    try{const saved=await save(value);if(revision===editRevision.current){if(saved)setValue(saved);setNotice({type:'success',text:desktop?'当前账号的设置已保存。':'浏览器设计偏好已保存，未连接本机文件。'});}else setNotice({type:'success',text:'此前设置已保存；新修改尚未保存。'});}
    catch(e){setNotice({type:'error',text:(e as Error).message});}
    finally{savingRef.current=false;setSaving(false);}
  };
  const choose=async(kind:'originalLibrary'|'workRoot')=>{try{const selected=await desktop!.selectDirectory(kind);if(selected)patch({[kind]:selected});}catch(e){setNotice({type:'error',text:(e as Error).message});}};
  const applyMigrated=(state:DesktopState)=>{
    refresh?.(state);
    const saved=state.workspace.settings;
    setValue(previous=>({...saved,provider:previous.provider,baseUrl:previous.baseUrl,model:previous.model,templatePath:previous.templatePath,extensions:previous.extensions}));
  };
  return <div className="page-pad settings-workspace"><div className="page-heading"><div><h1>设置</h1><p>管理当前账号、原始申请文件库和案件工作目录。</p></div>{section!=='account'&&section!=='model'&&section!=='template'&&section!=='documents'&&section!=='updates'&&section!=='extensions'&&section!=='diagnostics'&&<div className="heading-actions">{notice&&<span className={`settings-notice is-${notice.type}`} role={notice.type==='error'?'alert':'status'}>{notice.type==='success'&&<Check size={15}/>}{notice.text}</span>}<button className="primary" disabled={saving||migrating} onClick={()=>void persist()}>{migrating?'正在迁移…':saving?'正在保存…':'保存设置'}</button></div>}</div><div className="settings-layout"><nav aria-label="设置分类">{sections.map(s=><button key={s.id} className={s.id===section?'active':''} onClick={()=>{setSection(s.id);setNotice(null);location.hash=s.id==='account'?'#/settings':`#/settings/${s.id}`;}}><s.icon size={17}/>{s.title}</button>)}</nav><section className="settings-content">
    {section==='account'&&(migrating?<div className="dir-migration-block"><p>正在迁移当前账号工作目录。完成前不能切换账号或同步。</p></div>:<AccountSettings state={nativeState} refresh={refresh}/>)}
    {section==='model'&&(desktop&&nativeState?<ModelSettings key={nativeState.profileKey} api={desktop.models} profileKey={nativeState.profileKey} selectDshDirectory={()=>desktop!.selectDshDirectory()}/>:<><h2>模型服务</h2><Note>请在桌面程序中配置模型供应商和密钥。浏览器预览不保存密钥、不测试连接。</Note></>)}
    {section==='files'&&<><h2>文件与目录</h2><p className="section-copy">原始申请库沿用已有目录；案件工作目录可新建在你选择的云盘位置。</p><label className="field">原始申请文件库<div className="native-directory"><input readOnly value={value.originalLibrary??''} placeholder="选择已有原始申请文件所在的文件夹"/><button type="button" disabled={!desktop||saving||migrating} onClick={()=>void choose('originalLibrary')}>选择文件库</button></div><small>只读匹配，复制到案件目录时保留原件。</small></label><label className="field">总工作文件夹<div className="native-directory"><input readOnly value={value.workRoot??''} placeholder="选择案件工作文件的总存放位置"/><button type="button" disabled={!desktop||saving||migrating||workRootHasCases} onClick={()=>void choose('workRoot')}>选择工作文件夹</button></div><small>{workRootHasCases?'已有案件时请使用下方的当前账号目录迁移，不要直接保存为另一个总工作文件夹。':'可在系统选择器中新建文件夹，或选择云盘同步文件夹。保存后读取本工作台已有案件，新案件自动建立独立目录。'}</small></label>{desktop&&nativeState&&<div className="shared-folder-status"><h3>从工作目录读回案件</h3><p>{nativeState.storage.message}</p>{nativeState.storage.lastAt&&<p className="muted">最近读取：{new Date(nativeState.storage.lastAt).toLocaleString('zh-CN')}</p>}<button disabled={migrating||nativeState.storage.running||nativeState.sync.running||!value.workRoot||value.workRoot!==settings.workRoot} onClick={()=>void desktop!.refreshShared(nativeState.profileKey).then(s=>refresh?.(s)).catch(e=>setNotice({type:'error',text:e.message}))}>{nativeState.storage.running?'正在读取…':'刷新读取工作目录'}</button><small>另一台电脑登录同一账号、选择云盘中的同一目录，即可读回案件材料和稿件。两台电脑的本地路径可以不同；请等待云盘同步完成后再继续编辑。</small></div>}{desktop&&nativeState?.workspace.settings.workRoot&&<DirectoryMigration nativeState={nativeState} formSettings={value} saving={saving} onMigrated={applyMigrated}/>}<pre className="directory-example">{'总工作文件夹 / 案件 / 当前账号标识 /\n  案号_案件名称__稳定标识 /\n    00_原始申请\n    01_通知与材料 / 对应流程\n    02_工作稿 / 稿件与历史版本\n    03_定稿\n    04_内部说明'}</pre><p className="muted">案件改名不重新建目录；相同材料复用，不同内容保留独立文件。</p><div className="setting-explanation"><ShieldCheck size={20}/><div><h3>账号与案件分别保存</h3><p>各账号独立设置目录；本机登录凭证和任务记录保存在应用数据目录，不写入共享材料。使用网盘时，一次由一台电脑修改同案。</p></div></div>{nativeState&&<Note>本机记录：{nativeState.dataDirectory}</Note>}{!desktop&&<Note>在桌面程序中使用原生文件夹选择器；浏览器预览不访问本机文件。</Note>}</>}
    {section==='template'&&<><h2>模板与业务规则</h2><p className="section-copy">答复按通知类型使用已配置的规则。答复 Word 已接入确认模板。</p><div className="template-state"><FileText size={25}/><div><h3>已确认并内置 Word 模板</h3><p>答复采用秋泽案“一种汽车内饰用皮革裁切装置_第一次审查意见答复.docx”；申请文件版式采用桌面“模板.docx”。</p><p>答复先写抬头与开场；仅在修改权利要求时加入修改说明，再按具体审查问题展开，接续综上、结语和此致 / 敬礼。章节按实际内容连续编号。</p><p className="muted">模板随应用提供，自动用于答复定稿导出，无需填写本机模板路径。</p></div></div><label className="field">业务类型<select value={templateType} onChange={e=>setTemplateType(e.target.value)}><option>审查意见答复</option><option>补正说明</option><option>后续撰写</option></select></label><div className="rule-stage-list">{['材料核对','策略讨论','起草修改','独立复核','用户定稿'].map((s,i)=><div key={s}><span>0{i+1}</span><b>{s}</b><small>{i===1?'用户选定路径':i===3?'单独上下文':i===4?'模板 Word 分项归档':'按已确认材料与版本推进'}</small></div>)}</div><Note>{templateType==='后续撰写'?'完整撰写申请文件尚未完成。':'答复可按第一次、第二次、第三次审查意见和补正使用已配置规则。'}</Note></>}
    {section==='documents'&&desktop&&<><DocumentTools/>{nativeState&&<div className="prior-art-settings"><PatsnapSettings key={nativeState.profileKey} profileKey={nativeState.profileKey}/></div>}</>}
    {section==='extensions'&&(desktop&&nativeState?<ExtensionSettings key={nativeState.profileKey} profileKey={nativeState.profileKey}/>:<Note>请在桌面应用中管理扩展。</Note>)}
    {section==='diagnostics'&&<DiagnosticSettings/>}
    {section==='updates'&&<><h2>应用与更新</h2>{desktop&&<ApplicationSettings/>}<p className="section-copy">{desktop?`桌面版 ${nativeState?.version??'0.2.0'}。答复 Word 已接入确认模板。`:'浏览器预览；请使用桌面程序登录和管理本机文件。'}</p><dl className="review-definition"><div><dt>目标平台</dt><dd>macOS / Windows</dd></div><div><dt>更新方式</dt><dd>下载新版安装包后运行，安装器识别已有安装并覆盖程序；账号、设置、对话与工作目录保留。</dd></div><div><dt>最小化</dt><dd>按上方最小化选项保留窗口或隐藏到托盘，同步继续检查。</dd></div><div><dt>完全退出</dt><dd>停止网络操作，保存本机记录。</dd></div></dl><button onClick={()=>setShowUpdate(true)}>查看安装与更新说明<ArrowRight size={15}/></button><Note>macOS 使用 .pkg 安装包，Windows 使用 Setup.exe。请安装到原安装位置，更新前先在工作台中退出应用。</Note></>}
    </section></div>
    {showUpdate&&<Modal title="安装与覆盖更新" onClose={()=>setShowUpdate(false)}><div className="update-flow">{['取得适合本机的新版本安装包','在工作台中保存工作并退出应用','运行安装包，自动识别原安装；按提示覆盖程序','重新打开，原账号、设置和案件工作目录继续使用'].map((s,i)=><div key={s}><span>0{i+1}</span><p>{s}</p></div>)}</div><Note>macOS 安装器按应用标识定位既有版本；首次安装默认应用程序目录。Windows 安装器沿用原安装位置；从旧便携版首次转为安装版时，会保留同一用户的本机数据。仅替换程序，不迁移原始库和工作目录。在线检查新版本尚未启用。</Note></Modal>}
  </div>;
}
