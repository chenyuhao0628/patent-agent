# 后台候选对照

日期：2026-09-12。环境：macOS / arm64。已完成两候选真实 Go Responses 文本读写与重开对照，用户已明确采用 OpenCode。文件边界、停止和完整格式继续在产品接入中验收。下方空会话记录保留为较早协议证据。

## 真实模型工具对照

使用用户指定 OpenCode Go 的 `deepseek-v4.1-flash` / Responses，凭证只由本机代理持有；两个案件均为新建的合成中文文本材料，不含用户实际案件。运行使用固定独立会话请求头、`reasoning.effort=low`、`store=false`、4096 输出上限。

[首轮安全结果](backend-live-probe-initial.json)：

| 场景 | Hermes 0.21.1 + ad03f20 | OpenCode 1.18.30 |
| --- | --- | --- |
| 两案实际读取与结果落盘 | 通过，工具记录及磁盘标识/事实均核对 | 读取通过，写入被测试权限拒绝 |
| 会话内容分离 | 通过 | 本轮未完成完整核验 |
| 请求读取另一案件 | 真实工具允许读取，缺少强制目录限制 | 本轮未完成 |
| 运行中停止 | 返回 interrupted，约 6.4 秒 | 本轮未完成 |
| 关闭重开 | 消息保留，无自动重发 | 本轮未完成 |

Hermes 报告的 `ok:true` 仅代表脚本主流程读写/停止/重开完成，不代表文件隔离或产品验收。其文件工具需要应用强制限定范围。

OpenCode 写入失败已定位测试设置：在无 Git 项目的目录，其 project.worktree 为 `/`；当前版本 write 使用相对 worktree 的路径匹配 edit 权限，原绝对路径规则不匹配。依据 [1.18.30 官方 write 实现](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/tool/write.ts) 和实际本机 DB/工具拒绝记录修正。此配置错误不能作为否定后台能力的结论；随后为合成案件建立独立项目进行了下述复测。此为测试环境修正，不把 Git 安装变成产品运行前提。

后续 [OpenCode 复测原始结果](backend-live-opencode-recheck.json) 确认两个合成案件均真实 read/write（约 10.65 / 10.07 秒），会话内容分开，重开消息保留且未自动重发。以下两项必须单独解释：

- 跨目录读取探测为 inconclusive-no-tool-record，没有确证工具拒绝；不能算文件隔离通过。产品将由宿主的材料 ID 工具强制限定文件范围。
- 停止脚本虽然 `ok:true`，但终态为 unknown、没有 abort 错误事件，耗时约 20.4 秒；Codex 不接受其为停止验收通过，产品 Runner 必须继续验证真正停止。

用户基于实际读写和重开证据确认采用 OpenCode（R-56）。PDF / 图片 / DOCX / 旧 DOC / 模板 Word、扩展、Windows 实机与独立分发仍未验收；本次文本工具测试不替代完整首版矩阵。

## 较早空会话验证

[机器结果](backend-protocol-probe.json) 来自 [验证脚本](../scripts/probe-backends.py)。未提交提示词、未调用模型、未传入用户凭证。样本为 `.lab/` 下新建的空目录和虚构会话名；测试进程结束后已停止。

| 项目 | OpenCode | Hermes |
| --- | --- | --- |
| 实际版本 | 1.18.30 | 0.21.1；源码 `ad03f20dd61919ca2135d6904e787a94284aacaf` |
| 运行入口 | `serve --pure`，本地 HTTP 与临时 Basic Auth | `python -m tui_gateway.entry`，stdio JSON-RPC |
| 结构化就绪 | `/global/health` 返回 healthy | 收到 `gateway.ready` 事件 |
| 会话创建 | 两个不同 ID，列表可读回 | 两个不同 ID，空历史与活动列表接口可回应 |
| 中文工作目录 | 回读目录与启动目录一致 | 两个中文 cwd 分别与创建参数一致 |
| 进程重启 | 两个空会话重启后仍在列表 | 尚未验证持久对话恢复；上游新建空会话采用延迟持久化 |
| 案件隔离 | 两个会话仍在同一目录，未证明跨案件文件隔离 | 参数归属可读回，未证明执行时文件权限隔离 |

OpenCode 安装来源为 npm 官方包 `opencode-ai`；Hermes 为 [官方仓库](https://github.com/NousResearch/hermes-agent) 的隔离克隆及 Python 3.12 可编辑安装。安装与服务启动不等于可独立分发的桌面安装包。

接口依据为已阅读的 [OpenCode Server](https://opencode.ai/docs/server/)、[SDK](https://opencode.ai/docs/sdk/) 和 [Hermes 程序集成](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)。仅把本表中实际执行的项目记为运行证据。

## 仍需同场景验证

1. 相同 DeepSeek / 自定义 API 配置、错误反馈与凭证保护。
2. 同一授权案件副本的 PDF、DOCX、旧 DOC、页图与引用定位；证明实际读取内容及成果落盘。
3. 同案多对话、两个案件同时执行、材料与模型上下文隔离；检查运行中的结构化事件。
4. 分析及文件写入期间取消、应用退出、进程重启、用户恢复，确认原件和用户编辑稿不受覆盖。
5. 技能 / MCP 权限范围、依赖交付，以及 macOS / Windows 实际安装运行。

真实模型的合成文本工具证据见上节；实际案件副本、模板 Word 和 Windows 证据仍缺。不能据空会话接口推断上述能力。

## 来源仓库复核

本轮只读复核；未执行 fetch，表中同步关系仅相对本地已有 `origin/main` 引用。本项目未修改来源仓库。

| 来源 | 2026-09-12 HEAD | 实际工作树 |
| --- | --- | --- |
| `/Users/cyh/Documents/patent` | `da1c5f17152a284e26f26856dda94467cb84d8ed` | main，工作树干净，本地远端引用一致 |
| `/Users/cyh/Documents/DSH/dsh-patent-workbench` | `5559588e47fc4ff9d188ce272b581a56624a7a21` | main，本地远端引用一致；未跟踪 `.workbuddy/` |
| `/Users/cyh/Documents/0001` | `19fcfe8e10b6396c57d16cf2a4b044c15f50f735` | main，本地远端引用一致；接入资料、工具、测试等存在既有未提交改动 |

DSH 当前 `python/patent_worker/adapters/reply_prompt.py` 仍按通知类型组合来源业务规则。本轮已在隔离开发副本复制五份规则及来源摘要，正在对照策略、起草、复核和定稿语义；未把旧仓库路径作为产品运行依赖。
