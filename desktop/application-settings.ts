import { atomicJSON, readJSON } from './files.ts';
import { DEFAULT_APPLICATION_PREFERENCES } from '../src/application-api.ts';
import type { ApplicationPreferences, ApplicationSettingsView } from '../src/application-api.ts';
export type LoginAdapter={get:()=>{openAtLogin:boolean;status?:string};set:(enabled:boolean)=>void};
export function validateApplicationPreferences(value:unknown):ApplicationPreferences {
  if (!value || typeof value!=='object') throw new Error('应用设置格式无效。');
  const p=value as ApplicationPreferences;
  if (typeof p.openAtLogin!=='boolean'||typeof p.startHidden!=='boolean'||typeof p.minimizeToTray!=='boolean'||!['quit','background'].includes(p.closeBehavior)) throw new Error('应用设置格式无效。');
  return {openAtLogin:p.openAtLogin,startHidden:p.startHidden,closeBehavior:p.closeBehavior,minimizeToTray:p.minimizeToTray};
}
export function loginArguments(platform:string,executable:string,portableExecutable?:string) {
  return platform==='win32'?{path:portableExecutable || executable,args:['--startup'],name:'PatentWorkbench'}:{};
}
export class ApplicationSettings {
  preferences:ApplicationPreferences={...DEFAULT_APPLICATION_PREFERENCES};
  readonly file:string; readonly login:LoginAdapter; readonly supported:boolean; readonly packaged:boolean;
  constructor(file:string,login:LoginAdapter,supported:boolean,packaged:boolean){this.file=file;this.login=login;this.supported=supported;this.packaged=packaged;}
  async init(){this.preferences=validateApplicationPreferences({...DEFAULT_APPLICATION_PREFERENCES,...await readJSON(this.file,{})});if(this.preferences.openAtLogin&&this.supported&&this.packaged&&!this.login.get().openAtLogin)this.login.set(true);}
  view():ApplicationSettingsView {
    let status={openAtLogin:false,status:this.supported?'未启用':'当前平台不支持'};
    if(this.supported) { const current=this.login.get(); status={openAtLogin:current.openAtLogin,status:current.status || (current.openAtLogin?'enabled':'not-registered')}; }
    return {preferences:{...this.preferences},startupEnabled:status.openAtLogin,startupStatus:status.status,startupSupported:this.supported,packaged:this.packaged};
  }
  async save(input:unknown) {
    const next=validateApplicationPreferences(input),previous=this.preferences;
    const changed=next.openAtLogin!==previous.openAtLogin;
    if (changed&&(!this.supported||!this.packaged)) throw new Error('请使用已构建的 macOS 或 Windows 应用设置开机自启。');
    if(changed) this.login.set(next.openAtLogin);
    try { await atomicJSON(this.file,next); }
    catch(e) { if(changed) this.login.set(previous.openAtLogin); throw e; }
    this.preferences=next; return this.view();
  }
}
