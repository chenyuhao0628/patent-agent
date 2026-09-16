import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { desktop } from '../desktop.ts';
import type { DesktopState } from '../desktop.ts';
import { Note } from './Primitives.tsx';
export function AccountSettings({state,refresh}:{state?:DesktopState;refresh?:(s:DesktopState)=>void}){
  const [origin,setOrigin]=useState(state?.account?.origin??'https://cqgd.baselandtec.com'),[username,setUsername]=useState(state?.account?.username??''),[password,setPassword]=useState(''),[remember,setRemember]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[switching,setSwitching]=useState(false);
  const account=state?.account;
  const act=async(fn:()=>Promise<DesktopState>)=>{setBusy(true);setError('');try{refresh?.(await fn());setSwitching(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);setPassword('');}};
  return <><div className="section-heading"><div><h2>贝思兰德账号</h2><p className="section-copy">使用自己的账号登录，只同步分配给你或由你负责的案件。</p></div><span className="connection-state">{state?.auth?.phase==='verifying'?'正在验证':account?.status==='authenticated'?'已登录':state?.auth?.phase==='expired'?'登录已过期':account?'暂时离线':'未登录'}</span></div>
    {account&&<div className="account-card"><UserRound size={28}/><div><h3>{account.displayName}</h3><p>账号：{account.username}</p>{<p>机构：{account.organization||'未取得机构名称'}</p>}<p>系统：{account.origin}</p><small>{account.remembered?'已使用系统安全存储加密保留登录，支持过期自动重新授权':'本次登录在退出应用后失效'}</small></div></div>}
    {state?.auth&&<div className={`account-auth-status is-${state.auth.phase}`} role="status"><p>{state.auth.message}</p>{state.auth.lastCheckedAt&&<small>上次验证：{new Date(state.auth.lastCheckedAt).toLocaleString()}</small>}{state.auth.nextRetryAt&&<small>将自动重试；也可立即重新验证。</small>}{account&&account.status!=='authenticated'&&<div className="button-row">{state.auth.phase==='expired'&&account.remembered?<><button className="primary" disabled={busy} onClick={()=>void act(()=>desktop!.verifyLogin!())}>重新获取授权</button><button disabled={busy} onClick={()=>{setUsername(account.username);setSwitching(true);}}>重新输入密码</button></>:<><button disabled={busy||state.auth.phase==='verifying'} onClick={()=>void act(()=>desktop!.verifyLogin!())}>重新验证</button><button disabled={busy} onClick={()=>{setUsername(account.username);setSwitching(true);}}>重新登录</button></>}</div>}</div>}
    {account&&!switching?<div className="button-row"><button disabled={busy} onClick={()=>setSwitching(true)}>切换账号</button><button disabled={busy} onClick={()=>void act(()=>desktop!.logout())}>退出登录</button></div>:<form onSubmit={e=>{e.preventDefault();void act(()=>desktop!.login({origin,username,password,remember}));}}>
      <label className="field">系统地址<input value={origin} onChange={e=>setOrigin(e.target.value)} type="url" required placeholder="https://机构名.baselandtec.com" disabled={!desktop||busy}/></label>
      <label className="field">登录账号<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" required disabled={!desktop||busy}/></label>
      <label className="field">密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required disabled={!desktop||busy}/></label>
      <label className="checkbox"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} disabled={!desktop||busy}/>在这台电脑保留登录</label>
      <div className="action-bar">{switching&&<button type="button" onClick={()=>setSwitching(false)}>返回</button>}<button className="primary" disabled={!desktop||busy||!username.trim()||!password}>{busy?'正在登录…':'登录贝思兰德'}</button></div>
    </form>}
    {error&&<p className="inline-warning" role="alert">{error}</p>}
    {!desktop&&<Note>请在桌面程序中登录。浏览器设计预览不接收账号密码。</Note>}
    <Note>切换账号后使用各自的案件、工作目录和本机记录；勾选保留登录时凭据由本机系统安全存储（Keychain/DPAPI）加密保护，支持过期自动重获授权；凭证绝不进入共享材料或外发。</Note>
    {account&&<div className="setting-explanation"><div><h3>个人案件同步</h3><p>{state?.sync.message}</p>{state?.sync.lastAt&&<small>最近检查：{new Date(state.sync.lastAt).toLocaleString('zh-CN')}</small>}<div className="button-row"><button disabled={busy||state?.sync.running||account.status!=='authenticated'} onClick={()=>void act(()=>desktop!.sync())}>{state?.sync.running?'同步中…':'立即同步个人案件'}</button></div></div></div>}
  </>;
}
