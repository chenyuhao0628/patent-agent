import { useEffect, useState } from 'react';
import { desktop, type DocumentToolStatus } from '../desktop.ts';
export function DocumentTools(){
  const [status,setStatus]=useState<DocumentToolStatus>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function refresh(){try{setStatus(await desktop!.documentTools.status());setError('');}catch(e){setError((e as Error).message);}}
  useEffect(()=>{if(!desktop)return;void refresh();const timer=setInterval(()=>void desktop!.documentTools.status().then(setStatus).catch(()=>{}),1500);return()=>clearInterval(timer);},[]);
  async function configure(key:'webEnabled'|'autoInstall'|'commandsEnabled'|'downloadsEnabled',value:boolean){if(!status)return;setBusy(true);try{setStatus(await desktop!.documentTools.configure({webEnabled:status.webEnabled,autoInstall:status.autoInstall,...status.permissions,[key]:value}));setError('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const installing=busy||status?.managed.phase==='downloading'||status?.managed.phase==='installing';
  const system=status?.converter==='/usr/bin/textutil';
  return <div><h2>文档工具与 Agent 权限</h2><p className="section-copy">由你选择 Agent 的能力。优先复用本机工具，也可下载轻量工具、自行安装依赖。</p>
    <div className="agent-card"><h3>工具权限</h3>
      <label className="tool-setting"><input type="checkbox" checked={status?.webEnabled??false} disabled={!status||busy} onChange={e=>void configure('webEnabled',e.target.checked)}/><span><strong>联网检索</strong><small>通过 Exa 检索和读取公开网页，保留来源和调用记录。</small></span></label>
      <label className="tool-setting"><input type="checkbox" checked={status?.permissions.downloadsEnabled??false} disabled={!status||busy} onChange={e=>void configure('downloadsEnabled',e.target.checked)}/><span><strong>软件下载</strong><small>可从任意公开软件来源下载，集中保存并记录来源与摘要；下载后不会自动运行。</small></span></label>
      <label className="tool-setting"><input type="checkbox" checked={status?.permissions.commandsEnabled??false} disabled={!status||busy} onChange={e=>void configure('commandsEnabled',e.target.checked)}/><span><strong>任意命令与软件安装</strong><small>可执行脚本、安装任意工具、调用已有 WPS / Word 等应用。以你的本机用户权限运行，可访问其他文件和联网；默认工作目录不是沙箱。此选项开启后，命令自行联网不受上面两个开关限制。</small></span></label>
      <label className="tool-setting"><input type="checkbox" checked={status?.autoInstall??false} disabled={!status||busy} onChange={e=>void configure('autoInstall',e.target.checked)}/><span><strong>预设转换组件自动安装</strong><small>保留 LibreOffice 固定版本安装快捷方式，可单独关闭。不是唯一转换方式。</small></span></label>
      <p className="muted">开关立即保存，本机各账号共用；运行中需先停止任务再修改。新增下载与命令权限默认关闭。命令、退出码及限长输出保存在本次任务的 tool-audit 记录，停止任务会终止所管理的命令进程。</p>
    </div>
    <div className="agent-card"><h3>本机工具</h3><p className="muted">Agent 可检测这些工具，并在命令权限开启后尝试调用。检测到安装不等于已验证自动转换；具体能力由安装版本决定。</p>
      <div className="button-row"><button disabled={busy} onClick={()=>void desktop!.documentTools.detect().then(setStatus).catch(e=>setError(e.message))}>重新检测本机工具</button><button onClick={()=>void desktop!.documentTools.openDirectory()}>打开工具目录</button></div>
      <div className="detected-tools">{status?.detectedTools.map(t=><details key={t.path}><summary>{t.name}<span className="muted">已检测到</span></summary><p className="tool-path">{t.path}</p><p className="muted">{t.note}</p></details>)}{status&&!status.detectedTools.length&&<p>未在常见安装位置检测到，可让 Agent 按需查找或安装。</p>}</div>
      <p className="tool-path">{status?.managed.root}</p><p className="muted">downloads 保存下载文件；custom 保存可复用工具及依赖，应用更新时保留。命令默认使用本次材料副本和独立工作目录。自行指定系统安装位置的工具由对应安装器管理。</p>
    </div>
    <div className="agent-card"><h3>PDF 页图与模型视觉</h3><p>已内置。扫描件直接交给模型查看，保留页码与未读范围，不额外安装 OCR 引擎。</p></div>
    <div className="agent-card"><h3>旧 DOC 转 DOCX</h3>
      <p>{system?'macOS 系统转换已就绪，普通文字阅读无需下载。':status?.converter?'本机转换组件已就绪，Agent 读取旧 DOC 时自动调用。':'可让 Agent 检测已有工具，或按需下载和安装合适的转换工具。'}</p>
      <p className="muted">系统转换适合文字阅读；复杂公式、附图与版式需要选择合适工具并核对。原始 DOC 始终保留。</p>
      <details><summary>可选 LibreOffice 转换组件</summary><p>LibreOffice {status?.managed.version} 不放进安装包。首次安装需要下载约 284 MB（Mac）／356 MB（Windows），安装后占用约 801 MB／1.5 GB，各案件共用一份。不会写入原始申请库或云同步工作目录。</p><p className="tool-path">{status?.managed.root}</p>
        <div className="button-row"><button disabled={installing} onClick={()=>{setBusy(true);setError('');void desktop!.documentTools.installConverter().then(setStatus).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>{installing?'正在准备组件…':'按需安装完整组件'}</button><button onClick={()=>void desktop!.documentTools.openDirectory()}>打开工具目录</button><button disabled={installing} onClick={()=>void desktop!.documentTools.selectConverter().then(setStatus).catch(e=>setError(e.message))}>选择已有组件</button><button onClick={()=>void refresh()}>重新检测</button><button disabled={installing} onClick={()=>void desktop!.documentTools.removeConverter().then(setStatus).catch(e=>setError(e.message))}>移除下载组件</button></div>
        {status?.converter&&<p className="tool-path muted">当前组件：{status.converter}</p>}
      </details>
      {status?.managed.phase==='downloading'&&<progress aria-label="文档组件下载进度" max={status.managed.total} value={status.managed.downloaded}/>}
      {status?.managed.message&&<p role="status">{status.managed.message}</p>}
    </div>{error&&<p role="alert" className="inline-warning">{error}</p>}</div>;
}
