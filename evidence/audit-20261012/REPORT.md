# 0.20.1 项目检查与 OpenCode 专项报告

检查日期：2026-10-12（北京时间）。基线：`d2270e0`，应用 0.20.1，捆绑 OpenCode 1.18.30。本报告是本次检查的固定记录；后续修复状态只维护在根目录 `EXEC_PLAN.md`。

结论：常规路径、现有自动化和制品一致性通过，但不能认定 OpenCode 模块已具备可靠的异常收尾能力。本次新增隔离复现确认 **6 项运行缺陷（3 项 P1、3 项 P2）**，主要集中在完成判定、启动取消、压缩传输和进程 / 请求清理。没有修改业务代码、依赖、版本或安装包。

## 检查范围与证据边界

| 范围 | 本次检查与结果 |
| --- | --- |
| 仓库与需求 | 核对 Git 根、当前提交、工作区、需求索引、模块需求、实施计划及近期缓存 / 内部流转变更。开始时已跟踪文件无 diff；原有 `.git-diff-temp.diff`、`work/baseland-api/`、`work/预审与优先审查参考/` 保留，未读取其中业务材料。 |
| 全量自动化 | `npm test`：787/787 通过，0 失败、0 跳过、0 取消；见 `tests.log`。覆盖案件阶段、账号 / IPC、模型配置、工具、恢复、文档、贝思兰德合成服务等。通过不代表下述缺口已被覆盖。 |
| 编译构建 | `npm run build` 通过，包括 TypeScript、Vite、Electron main / preload / 文档 worker；见 `build.log`。 |
| Electron 与 UI | 启动 release 中实际 0.20.1 `.app`，使用全新临时 userData；检查案件库、模型服务、文档工具、技能 / MCP、应用设置、本案对话、撰写与成果。创建合成案件，选择“说明书”起点，退出并重开后仍为 phase=2、jobs=0、confirmations=0。见 `native-*-summary.json` 和截图。 |
| 尺寸 | 在上述 Electron 页面模拟 1440×900、1920×1080、1280×800 CSS 视口，检查撰写页，无横向溢出；不代表两台物理显示器验收。 |
| OpenCode 实体运行 | 全量测试包含真实可执行文件 + 合成 Responses 服务；额外指定 release 包内运行时复跑读材料 → 写产物 → 正常结束 / 停止，1/1 通过。见 `runner-live-probe.log`。没有调用真实模型。 |
| 权限与文件 | 走查冻结快照、materialId / hash、受控 MCP、原生工具默认关闭、模型密钥代理、账号 / 案件 / 阶段作用域、产物校验及迟到结果保护；相关既有回归通过。启动取消仍存在 F2，不能将正常路径结论扩展到该异常路径。 |
| 文档与业务 | 核对答复 / 撰写 / 审查接入、模板校验、读取限额、版本保留、内部保存与转交结果核对。未执行新的真实 Word 版式验收，未使用真实案件，也未连接真实贝思兰德业务接口。 |
| 制品 | `.app` 目录树、`.pkg`、`.exe` 摘要全部与现有 release-manifest 一致；macOS bundle 结构与运行时摘要通过；main、preload、index.html 与本次源码构建一致。Windows 仅做文件摘要 / MZ 检查，不等于 Windows 启动或安装通过。见 `release-probe.json`。 |
| 依赖 | 查询 npm 官方 registry 的 audit 数据，返回 14 个受影响依赖节点（3 high、11 moderate）。这是依赖告警，不是 14 个已复现的应用漏洞；详见下文。 |

## OpenCode 实际接入结构

| 层 | 代码与职责 |
| --- | --- |
| 业务宿主 | `desktop/agent-host.ts` 管答复 / 讨论 / 复核；`professional-host.ts` 管撰写 / 独立审查。主进程负责状态、冻结材料和采用结果。 |
| 接入适配 | `agent-integration.ts` 选择捆绑二进制，将宿主调用转成运行器输入，复核产物路径 / 摘要并落入本机任务输出。 |
| 运行器 | `agent-runner.ts` 每次新建隔离 HOME / XDG / work，启动 `serve --pure`，通过 HTTP / SSE 及轮询读取结构化状态。 |
| 模型代理 | `agent-proxy.ts` 使用随机本机路由令牌；OpenCode 持有占位 key，真实模型 key 在主进程代理侧加入；按所选协议限制端点、模型与输出。 |
| 案件工具 | `agent-broker.ts` 提供 MCP 的材料读取、记忆、依据、检查点、产物及允许的本地工具。`extensions.ts` 接入已启用技能 / MCP。 |
| 运行时交付 | 仓库不包含 OpenCode 本体源码；本机 `.lab/agent-runtime` 和安装包 extraResources 提供两个平台二进制及清单。版本 1.18.30，默认关闭自动更新，启动不依赖用户旧仓库路径。 |

缓存专项：实测包内运行时发出的连续三次请求均包含相同的 `prompt_cache_key=ses_…`，并仍为 `store:false`。因此不能因为代理删除了强制 `store=false` 就断言当前原生路径已开启响应存储。见 `opencode-wire.json`。每次 runner 调用仍新建 OpenCode session；当前证据只证明同一次运行内发送缓存键，**没有证明真实供应商命中缓存、节省费用或跨任务稳定复用**。HTTP Cache-Control 透传本身不构成该验收。

## 已确认缺陷

### F1 · P1 · 工具回合被当成整个任务完成

位置：`desktop/agent-runner.ts:775–776`、`:1101–1106`。

`inspectAssistantTurn` 只要求最后 assistant 存在 `time.completed` 且没有 pending tools，未排除 `finish:'tool-calls'`。主循环使用 `completedByTime || completedByIdle`，所以即使刚读取的会话状态仍为 `busy`，也会结束或插入自动修复。

复现：合成 OpenCode REST 服务先经真实 broker 写入通过 `discuss` 校验的 result.json，然后持续返回 busy 和已完成的 tool-calls 回合；运行器返回 `completed`，finalText 为空，关闭运行时。证据：`runner-probes.json` 的 `completed-tool-turn-while-busy`。这证明检查规则会接受中间回合；未声称本轮真实供应商任务已经触发这一竞态。

影响：可能采用模型尚待核对的中间产物，或在已有回合仍继续时追加修复。建议把单次模型回合完成与整个会话结束分开，结合当前会话状态、最终 finish 类型和本轮有效产物再收尾，并覆盖工具回合结束到下一 assistant 创建间的窗口。

### F2 · P1 · 启动期间取消后代理仍可调用

位置：`desktop/agent-runner.ts:876–891`，以及其后的 broker / proxy 初始化。

取消会先将 `ioClosed` 置 true，但 broker / proxy 可能尚未赋值；随后初始化继续创建资源，最终 finish 再调用清理时直接返回。没有在每次异步资源创建后重新检查取消并释放新资源。

复现：传入已取消的 signal。`run()` 返回 aborted 后仍有两个 127.0.0.1 监听服务；用该任务配置中的临时路由调用模型代理，得到 HTTP 200，合成上游收到一次请求。证据：`runner-probes.json` 的 `pre-aborted`。复现结束已主动关闭这两个测试服务。

影响：停止成功不等于任务能力已撤销，模型代理仍持有本次配置且可继续请求；也会积累端口 / 服务。建议在启动各步处理 signal，并用可等待、可重复执行的资源清理逻辑覆盖初始化与停止竞态。

### F3 · P1 · Fetch 透传保留压缩头，导致重复解压

位置：`desktop/agent-proxy.ts:557`、`:658–670`；生产 Fetch 选择来自 `desktop/agent-runner.ts:807` 和 proxy `:805–808`。

Fetch 已解压上游响应正文，但 `copySafeHeaders` 继续转发原 `Content-Encoding` 和压缩前对应的 `Content-Length`。下游再次按 gzip 解码已解压文本而失败。运行器默认创建一个新的 bound fetch 并传入代理，因此生产路径进入 Fetch 分支；不能用代理默认 Node 分支通过来排除此问题。

复现：同一合成上游分别返回 gzip JSON 与 gzip SSE。Node 路径两项均完整读取；与运行器一致的 Fetch 路径两项均 `TypeError: terminated / incorrect header check`。证据：`proxy-probes.json`。

影响：使用压缩响应的兼容模型服务会报连接中断。建议根据实际传输路径和正文是否转换重建编码 / 长度头；DeepSeek 响应适配改变字节后也需遵循同一规则。

### F4 · P2 · OpenCode 崩溃后等待整个任务时限

位置：`desktop/agent-runner.ts:1048–1066`，子进程 exit 处理位于 `:988`。

仅启动健康检查阶段检查进程是否退出；进入主循环后，exit 事件只写诊断，状态与消息请求异常均被吞掉继续轮询。

复现：合成进程在收到 prompt 后以 17 退出。任务仍等到配置的 2500ms 时限，约 2532ms 后返回 `deadline`，而不是 server_exited。证据：`runner-probes.json` 的 `crash-after-prompt`。

影响：默认时限 60 分钟时，界面可能长时间显示任务未结束，错误提示还会误导为任务耗时。建议将 child exit / error 接入终止信号，并区分短暂 HTTP 失败、不可恢复的读取超限和后台退出。

### F5 · P2 · 请求体发送完后断流，上游未取消

位置：`desktop/agent-proxy.ts:789–790`。

代理只监听 IncomingMessage 的 aborted。请求体已发送完后，客户端关闭响应流通常体现为 ServerResponse close，当前代码没有将其传播给上游 controller。

复现：客户端完整 POST、读取第一段 SSE 后 abort；等待后合成上游 signal 仍未 aborted，直到关闭整个代理才收到取消。证据：`proxy-probes.json` 的 `client-disconnect`。

影响：OpenCode 某次请求被取消 / 重试后，旧上游请求仍可能继续占用连接或生成计费内容，直到结束或整个任务关闭。建议监听响应连接提前关闭并取消上游，正常写完时则解除监听。

### F6 · P2 · 父进程先退出后遗留子进程

位置：`desktop/agent-runner.ts:524–533`。

清理函数看到父进程 exitCode / signalCode 已设置就直接返回，不清理其后代。Windows 分支还先 `proc.kill()` 父进程，只有父进程未退出才使用 taskkill /T；父进程正常被终止时恰好会跳过树清理。

复现：macOS 上启动只属于本次测试的父进程和子进程，父进程以 17 退出后调用 `killManagedProcess`，子进程仍存活；已由复现脚本额外终止。见 `process-tree-probe.json`。Windows 分支为静态确认，本轮没有 Windows 运行证据。

影响：OpenCode 崩溃或在 Windows 停止时，本地 MCP 等后代进程可能留在后台。建议采用覆盖父进程早退的进程组 / Windows Job Object 或可靠的树管理策略，并实际验证父进程已退出的情形。

## 其他检查结果与待核对项

- **专业任务提示词互相冲突。** `professional-host.ts:386` 告知撰写 / 审查可用 mode=merge 保存 text / documents；`agent-runner.ts:433` 在其后追加“其他专业任务不使用 merge”，自动修复提示 `:1117` 又要求三类任务均用 merge。代码已支持专业检查点，提示应统一。此处是可确认的指令冲突，未将模型是否服从哪一句当成实测结论。
- **两条停止断言没有检验它们宣称的行为。** `agent-runner.test.ts:650` 包含永远不成立的 `Date.now() < 0`，`:651` 又允许写入成功；不能证明停止后没有迟到写入。应以停止时刻、实际文件、有效代理撤销及后代进程退出做断言。
- **文档与实际状态失配。** README 引用的 `evidence/release-0.20.1-20261009.json`、`docs/TESTING-0.20.1.md` 均不存在，实际只有 TESTING-0.20.0.md；README 仍称本轮源码未提交，但当前提交已为 d2270e0。架构 / 产品交付文档写 0.19.1，实施计划旧“当前基线”写 0.18.0。当前 release 只查到 0.20.1 三项制品，不能以旧“0.19.1 原地保留”的表述说明现在还在。安装清单 builtAt 为 2026-10-11 01:41:28（北京时间），与文档“10 月 9 日交付”也需区分。未核对远端推送状态。
- **撰写入口仍有过时提示。** 原生 `.app` 的本案对话显示“完整撰写申请文件尚未完成”“当前流程不可办理”，而撰写页可选择并持久化起点。位置 `AgentWorkbench.tsx:333,400`；成果页还统一展示答复定稿提示。见 `native-conversation.json` / 截图、`native-artifacts.json`。应说明“本页只讨论，正式撰写进入撰写页”，避免误认为产品能力未实现。
- **原生控制台存在字体 CSP 错误。** 数据 URI 字体被 default-src self 拦截；未发现 React 异常 / 空白页。字体来源和具体排版影响尚未定位，不能报控制台零错误，也不应据此放宽全部 CSP。
- **依赖告警需按实际使用路径治理。** `npm-audit.json` 中 3 个 high 均为开发 / 打包链：brace-expansion、http-cache-semantics、source-map-js；mammoth → argparse → sprintf-js 为 moderate 链。构建后的主进程未检索到 argparse / sprintf-js 模块，不能把 CLI 依赖告警直接算成文档输入可利用漏洞。audit 给出的部分修复版本甚至会降级直接依赖，应逐项选兼容修复，不能直接使用 force。二进制 OpenCode 不在 npm lock 审计覆盖范围内。

## 后续处理顺序与未执行范围

先修复 F1–F3，并让相同复现条件真正失败关闭 / 正确透传；随后完成 F4–F6 和有效的取消 / 进程回归，统一专业任务提示与文档。已有业务范围、独立复核可选性、材料 / 凭证边界无需因此收缩。

本次未读取真实案件或密钥，未执行真实模型请求、贝思兰德生产同步 / 写入、覆盖安装、Windows 启动、签名 / 公证、推送或发布。真实模型质量、真实内部流转、多设备 / 长任务、Windows 进程树以及复杂 Word 版式仍需对应证据。macOS 从现有 `.app` 直接启动成功不等于 `.pkg` 安装成功。

`repro/` 保存临时脚本原件（`.txt` 后缀），其中路径为本次环境；再次运行前应复制到独立临时目录并核对路径，不在真实业务目录执行。脚本只使用合成材料、合成凭证和本机服务。主要日志 / JSON / 截图的 SHA-256 见 `evidence-manifest.json`。初始阶段辅助脚本有一次误用不存在的 `DesktopService.saveSettings` 方法，修正为实际 `settings` 后完成准备；该失败没有产生产品缺陷结论。
