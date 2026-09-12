import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { desktop } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
import { Note } from './Primitives.tsx';
export function AccountSettings({state,refresh}:{state?:DesktopState;refresh?:(s:DesktopState)=>void}){
  const [origin,setOrigin]=useState(state?.account?.origin??'https://cqgd.baselandtec.com'),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[remember,setRemember]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[switching,setSwitching]=useState(false);
  const account=state?.account;
  const act=async(fn:()=>Promise<DesktopState>)=>{setBusy(true);setError('');try{refresh?.(await fn());setSwitching(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);setPassword('');}};
  return <><div className="section-heading"><div><h2>贝思兰德账号</h2><p className="section-copy">使用自己的账号登录，只同步分配给你或由你负责的案件。</p></div><span className="connection-state">{account?.status==='authenticated'?'已登录':account?'需要验证登录':'未登录'}</span></div>
    {account&&<div className="account-card"><UserRound size={28}/><div><h3>{account.displayName}</h3><p>账号：{account.username}</p>{account.organization&&<p>机构：{account.organization}</p>}<p>系统：{account.origin}</p><small>{account.remembered?'已使用本机安全存储保留登录':'本次登录在退出应用后失效'}</small></div></div>}
    {account&&!switching?<div className="button-row"><button disabled={busy} onClick={()=>setSwitching(true)}>切换账号</button><button disabled={busy} onClick={()=>void act(()=>desktop!.logout())}>退出登录</button></div>:<form onSubmit={e=>{e.preventDefault();void act(()=>desktop!.login({origin,username,password,remember}));}}>
      <label className="field">系统地址<input value={origin} onChange={e=>setOrigin(e.target.value)} type="url" required placeholder="https://机构名.baselandtec.com" disabled={!desktop||busy}/></label>
      <label className="field">登录账号<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" required disabled={!desktop||busy}/></label>
      <label className="field">密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required disabled={!desktop||busy}/></label>
      <label className="checkbox"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} disabled={!desktop||busy}/>在这台电脑保留登录</label>
      <div className="action-bar">{switching&&<button type="button" onClick={()=>setSwitching(false)}>返回</button>}<button className="primary" disabled={!desktop||busy||!username.trim()||!password}>{busy?'正在登录…':'登录贝思兰德'}</button></div>
    </form>}
    {error&&<p className="inline-warning" role="alert">{error}</p>}
    {!desktop&&<Note>请在桌面程序中登录。浏览器设计预览不接收账号密码。</Note>}
    <Note>切换账号后使用各自的案件、工作目录和本机记录；密码不落盘，登录凭证不进入共享材料。</Note>
    {account&&<div className="setting-explanation"><div><h3>个人案件同步</h3><p>{state?.sync.message}</p>{state?.sync.lastAt&&<small>最近检查：{new Date(state.sync.lastAt).toLocaleString('zh-CN')}</small>}<div className="button-row"><button disabled={busy||state?.sync.running||account.status!=='authenticated'} onClick={()=>void act(()=>desktop!.sync())}>{state?.sync.running?'同步中…':'立即同步个人案件'}</button></div></div></div>}
  </>;
}
