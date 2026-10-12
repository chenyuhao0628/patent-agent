# 阶段 4：配套修复

2026-10-12。原审计列出的提示词、停止断言、撰写文案、字体与当前文档问题已处理；对依赖按实际链路治理，不使用强制降级。

- 专业任务与答复统一 `mode=merge` 分项保存指令，documents 支持子项补齐，删除互相冲突的禁止语句。
- 真实 OpenCode 停止测试先等合成模型请求已开始，再取消并确认：无迟到工具事件、无 result.json、代理端点无法再连接；替换 `Date.now()<0` 及允许成功写入的无效断言。
- 本案对话明确“讨论不推进办理阶段”，撰写 / 审查进入各自入口；成果页按业务显示，撰写空态不再套答复定稿说明，设置的标准技能介绍同步修正。
- 字体错误定位为 Vite 将小于阈值的 KaTeX_Size3 字体内联为 data URI；设置 `assetsInlineLimit:0` 让字体随包加载，CSP 无需放宽。真实 Electron 中强制加载该字体成功，控制台无相关错误。
- 修正不存在的 0.20.1 证据引用；补写以当前核查为依据的测试说明，不补造历史验收。当前状态统一以 package / 实际安装清单为准。旧实施正文移动为明确历史归档，EXEC_PLAN 只维护当前目标及现场验收边界；当前文档相对链接检查无缺失。
- 打包新增 `--preserve-old`：核对并保留实际旧制品，拒绝同名覆盖，清单分别记录 retained 项。相关 13 项打包回归通过；最终构建使用此选项。

## 验证

全量 **828/828**，无失败 / 跳过 / 取消；构建、类型、停止路径定向 21/21 和打包定向 13/13 通过。最后追加成果空态与保留 pkg 平台标签后重做生产构建、打包检查与原生交互。

实际 Electron，独立 `/tmp/patent-v2-gui/desktop-profile`：创建合成撰写案 → 本案对话 → 成果 → 选择说明书起点 → 退出重开。重开记录 phase=2、jobs=0、confirmations=0，未启动模型或虚构前序确认。1440×900、1920×1080、1280×800 CSS 视口无横向溢出；字体加载成功，最终交互捕获无产品错误。使用原生 Electron 的独立 CDP；用户浏览器插件不控制原生应用，未新增浏览器依赖。辅助重开脚本曾在页面未创建时连接过早，以及误以为案件行是 button；读取 DOM 后改用实际 tr 完成同一进程验证，不属于产品故障。

## 依赖审计边界

更新受影响的兼容依赖：brace-expansion 1.1.21 / 2.1.7 / 5.0.12，http-cache-semantics 4.3.0，source-map-js 1.2.2，fast-uri 3.1.8。npm audit 从 3 high / 11 moderate 降为 **0 high / 10 moderate**。剩余 10 个节点都追溯到 `sprintf-js` 的同一 advisory `GHSA-hp3w-g68c-fv3c`，查询官方 npm latest 仍为 1.1.3，暂无上游修复版。

其路径为 mammoth 命令行的 argparse，以及 electron-builder 下载代理日志的 roarr / global-agent；应用导入 mammoth API，未执行其 CLI。esbuild 对桌面入口的实际依赖图 445 个输入中没有 sprintf-js / argparse / roarr / global-agent（mammoth API 98 项输入），发布配置又排除整树 node_modules。因此没有将此告警计为已修复或忽略，保留 npm 报告与实际构建边界。开发构建链仍保留依赖告警，后续上游修复应更新。没有为消除报表而将 mammoth 降到 0.3.29 或 electron-builder 降级。

未执行真实模型计费请求、真实材料 / 内部流转、Windows 实机、覆盖安装或发行签名 / 公证。
