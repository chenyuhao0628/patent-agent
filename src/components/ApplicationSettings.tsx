import { useEffect, useState } from 'react';
import type { ApplicationSettingsView } from '../application-api.ts';
import { desktop } from '../desktop.ts';
import '../application-settings.css';

export function ApplicationSettings() {
  const [view,setView]=useState<ApplicationSettingsView|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  useEffect(()=>{void desktop?.application.get().then(setView).catch(e=>setError(e.message));},[]);
  const save=async()=>{
    if(!view)return;setBusy(true);setError('');setMessage('');
    try{setView(await desktop!.application.save(view.preferences));setMessage('本机启动与窗口设置已保存。');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <section className="application-settings">
    <header className="application-settings-heading"><h3>启动与窗口</h3><p>设置这台电脑上的启动和窗口行为。后台运行时，同步与任务继续执行。</p></header>
    {view&&<fieldset disabled={busy} className="application-preferences">
      <div className="application-option-row">
        <div className="application-option-title">登录启动</div>
        <div className="application-option-controls">
          <label className="application-choice"><input type="checkbox" disabled={!view.startupSupported||!view.packaged} checked={view.preferences.openAtLogin} onChange={e=>setView({...view,preferences:{...view.preferences,openAtLogin:e.target.checked}})}/><span>登录电脑时自动启动</span></label>
          <p className="application-option-hint">系统状态：{view.startupStatus==='requires-approval'?'等待系统设置批准':view.startupEnabled?'已启用':'未启用'}{!view.packaged?' · 开发预览不修改系统启动项':''}</p>
          <label className="application-choice"><input type="checkbox" checked={view.preferences.startHidden} onChange={e=>setView({...view,preferences:{...view.preferences,startHidden:e.target.checked}})}/><span>自启时放入后台，不弹出窗口</span></label>
        </div>
      </div>
      <div className="application-option-row">
        <div className="application-option-title" id="close-behavior-label">关闭窗口</div>
        <div className="application-option-controls" role="radiogroup" aria-labelledby="close-behavior-label">
          <label className="application-choice"><input type="radio" name="close-behavior" checked={view.preferences.closeBehavior==='quit'} onChange={()=>setView({...view,preferences:{...view.preferences,closeBehavior:'quit'}})}/><span>保存并退出应用</span></label>
          <label className="application-choice"><input type="radio" name="close-behavior" checked={view.preferences.closeBehavior==='background'} onChange={()=>setView({...view,preferences:{...view.preferences,closeBehavior:'background'}})}/><span>隐藏到托盘，继续后台运行</span></label>
          <p className="application-option-hint">后台运行时，可从托盘重新打开工作台。</p>
        </div>
      </div>
      <div className="application-option-row">
        <div className="application-option-title">最小化</div>
        <div className="application-option-controls">
          <label className="application-choice"><input type="checkbox" checked={view.preferences.minimizeToTray} onChange={e=>setView({...view,preferences:{...view.preferences,minimizeToTray:e.target.checked}})}/><span>最小化时隐藏到托盘</span></label>
          <p className="application-option-hint">未勾选时，使用系统默认的窗口最小化方式。</p>
        </div>
      </div>
      <div className="application-settings-actions"><button className="primary" onClick={()=>void save()}>{busy?'保存中…':'保存设置'}</button><button onClick={()=>void desktop!.application.minimize()}>最小化窗口</button><button onClick={()=>void desktop!.application.quit()}>退出应用</button></div>
    </fieldset>}
    {error&&<p role="alert" className="application-settings-feedback inline-warning">{error}</p>}
    {message&&<p role="status" className="application-settings-feedback">{message}</p>}
  </section>;
}
