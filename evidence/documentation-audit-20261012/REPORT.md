# 项目文档与代码对账报告

核对日期：2026-10-12（北京时间），代码基线 `027c9de`，分支 `codex/module-platform`，当前应用 / 安装清单 **0.22.0**。

## 核对目标

本轮按用户要求完整核对项目文档，并按项目管理逻辑整理为：已确认需求、当前执行计划、当前架构与实现、开发与验证、用户说明、交付索引、历史归档和独立证据。核对同时检查文档是否准确描述当前代码，发现差异时保留需求并登记到 `EXEC_PLAN.md`，没有通过改写需求制造“已完成”结论。

盘点受管 Markdown 共 116 份：37 份现行 / 入口 / 版本说明、14 份归档、19 份证据报告、43 份运行资源、3 份业务 / 外部参考。文档结构与链接检查覆盖前 70 份；运行资源只核对应用加载与引用，不改写业务规则；业务 / 外部参考只确认分类，不读取真实材料。

本轮不修改业务源码、不读取真实凭证或案件、不执行真实服务写入、不推送或发布，也不因纯文档修改升版本或重打包。

## 文档归位结果

| 管理职责 | 主要入口 |
| --- | --- |
| 仓库规则与授权边界 | `AGENTS.md` |
| 已确认产品范围与生效决定 | `REQUIREMENTS.md`、`docs/requirements/` |
| 当前任务、差距和待验收项 | `EXEC_PLAN.md` |
| 文档职责与更新顺序 | `docs/project/documentation.md` |
| 需求到实现、测试、证据映射 | `docs/project/traceability.md` |
| 当前技术结构 | `DEVELOPMENT.md`、`docs/architecture/` |
| 模块接入与替换合同 | `docs/development/` |
| 用户操作 | `docs/USER_GUIDE.md` |
| 当前包和历史包说明 | `docs/releases/README.md`、`docs/TESTING-0.22.0.md`、旧版 `docs/TESTING-*` |
| 已完成过程与旧决定 | `docs/archive/` |
| 指定范围的验证结果 | `evidence/` |
| 应用加载的规则、技能和模板 | `resources/`（保留运行资源职责，不作为普通文档改写） |

新增的 Agent / 运行时分册说明了 OpenCode v2、会话范围、公开上下文、缓存 / 压缩、任务恢复和自动兼容更新；使用说明补上首次设置、全案 / 单案、后台会话和更新操作。

## 代码对账范围

实际读取并对照了面板注册与宿主、统一数据入口、适配器合同、案件领域与生命周期、同步服务与缓存、Agent / OpenCode 运行时、引擎会话、上下文压缩、任务恢复、目录整理、Word 导出、内部流转、设置页面和打包脚本。逐模块映射见 [`docs/project/traceability.md`](../../docs/project/traceability.md)。

### 已确认的当前实现差距

| 编号 | 结论 | 复现证据 |
| --- | --- | --- |
| D1 | 提交页 `order=5`，贝思兰德流程页 `order=8`，当前提交实际排在流程之前 | `code-probes.json` 的 `navigation.submitBeforeFlow=true` |
| D2 | 新建案件目录仍是案号 / 标题 / 稳定标识；目录整理后才变为客户名 + 专利名 + 类型 | `code-probes.json` 的 `folderNames` |
| D3 | 终态分支声明 60 分钟，但 `submissionCache` 容器 TTL 是 5 分钟，6 分钟旧条目已清除 | `code-probes.json` 的 `terminalCache` |
| D4 | 自动同步失败也记录节流时间，立即再次自动触发不会重试；手动刷新可以执行 | `code-probes.json` 的 `failedSyncThrottle` |

上述差距不是文档缺陷，已保留在需求和当前计划中；本轮没有修改源码来掩盖它们。修复时应分别增加代码变更、定向回归和新的证据。

## 已有验收边界

0.22.0 的 `864/864`、构建、最终 `.app`、双平台包内核对、模块模板和 OpenCode v2 合成验证属于此前交付证据，本轮通过索引引用，没有重新执行全量应用测试。真实供应商质量、真实缓存命中率、Windows 实机、macOS pkg 覆盖安装、复杂 Word 版式和贝思兰德生产写入仍按 `EXEC_PLAN.md` 单独验收。

历史版本文档保留原编号、原路径和当时语义；已清理的旧安装包不再被描述为当前可用制品。当前 release 目录仅以 0.22.0 安装清单为准，清理证据见 `evidence/release-cleanup-20261012.json`。

## 本轮文档检查

- 文档链接检查器：受管 Markdown 共 **70** 个文件，**533** 个本地链接，**9** 个外部链接未联网检查；最终结果为 0 个本地断链。
- 代码核对脚本：使用临时目录和合成案件，网络请求数为 **0**；输出保存在 `code-probes.json`。
- 版本核对：`package.json`、`package-lock.json`、`README.md`、`EXEC_PLAN.md`、`release/release-manifest.json` 均以 **0.22.0** 为当前版本；安装清单列出 macOS `.app` / `.pkg` 和 Windows `.exe` 三项制品。
- 路径检查：现行文档中的代码、脚本、证据和配置引用均已核对；`resources/agent-runtime` 和模块指南中的 `src/modules/generated/` 示例是运行命令后的生成路径，未执行生成时可以不存在。
- 差异检查：本轮 diff 没有源码业务文件修改；保留初始未跟踪 `.git-diff-temp.diff`、`work/baseland-api/` 和 `work/预审与优先审查参考/`。
- 外链未联网检查，不能据此声称官方链接当前可达；本地路径和标题锚点以最终链接检查结果为准。

## 复现

```sh
python3 evidence/documentation-audit-20261012/document-links.py /tmp/patent-doc-links-after.json
node --experimental-strip-types evidence/documentation-audit-20261012/code-probe.mjs /tmp/patent-code-probes-recheck.json
```

上述脚本只使用本机项目代码、临时目录和合成数据，不读取真实案件或凭证，也不请求真实服务。诊断脚本已随本报告保存，自动定位当前仓库；复跑使用临时输出，不覆盖已捕获证据。代码诊断断言针对 `027c9de` 的四项差距，后续修复后不能当作期望业务行为的回归测试。最终结论以本报告、`code-probes.json`、`EXEC_PLAN.md` 和对应代码版本为准。
