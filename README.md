# 专利工作台 0.22.1

独立 macOS / Windows 桌面应用，覆盖案件管理、答复与补正、五阶段撰写、可选独立审查和贝思兰德内部流转。应用管理业务与文件，模型通过随包 OpenCode 接入，无须旧项目源码。

## 当前状态

- 当前源码和安装清单为 **0.22.1 修复候选版**；macOS .app / .pkg 与 Windows .exe 已重新构建并核对。修复内部流转 / 工作任务首开缺样式，案件记录和业务流程保持原语义；当前可用制品以 [安装清单](release/release-manifest.json) 为准。按最新要求清理 0.22.0 三项旧制品及打包暂存，release 仅保留 0.22.1 与清单。
- 本版 UI 修复时 **865/865** 全量测试通过；此次重构建执行 **19/19** 打包 / 运行时 / 全局样式定向测试、类型检查及完整构建。最终 .app 再次使用合成案件核验冷开、切页、硬刷新、搜索 / 筛选及确切任务导航，四种视口无溢出和前端错误；退出重开后案件、任务与工作目录保留。两平台各 83 个构建文件摘要一致，pkg 内应用与独立 .app 摘要一致，见 [0.22.1 验收说明](docs/TESTING-0.22.1.md)。
- 全局与单案面板分别注册，共用宿主；案件数据统一通过主进程仓储和渲染 Store 管理。可替换适配器与模块生成模板已实测，接入见 [模块指南](docs/development/module-guide.md)。
- OpenCode 已迁移 v2，当前打包快照 2.0.27。按账号、案件、阶段与分支保存会话；自动检查并安装通过兼容性验证的更新，空闲切换并保留回退，不锁死补丁版本。
- 0.22.0 已有 **864/864**、构建和模板 **2/2**、原生保存 / 重开、任务切页 / 停止及三视口证据；见 [历史交付报告](evidence/module-platform/phase-6/RESULT.md) 和 [性能对照](evidence/module-platform/phase-6/PERFORMANCE.md)。本次首开样式缺陷说明旧验收未覆盖有内容的冷启动全局列表，修复验证单独记录。
- 用户此前报告的真实贝思兰德稿件保存失败根因尚未证实；合成通过不等于生产验收。历史真实模型与 Word 结果见 [既有验收记录](evidence/native-acceptance-20261001.md)，本轮边界见测试说明。
- 2026-10-12 文档对账确认四项实现差距，已保留原需求并登记在 [当前计划](EXEC_PLAN.md#实现差距)。文档整理不代表这些代码差距已经修复。

## 文档入口

| 用途 | 入口 |
| --- | --- |
| 按项目管理流程查阅文档 | [文档总索引](docs/README.md)、[职责与维护](docs/project/documentation.md) |
| 已确认需求，按模块查阅 | [REQUIREMENTS.md](REQUIREMENTS.md) |
| 当前任务、版本边界与未完成项 | [EXEC_PLAN.md](EXEC_PLAN.md) |
| 需求对应哪些代码、测试和证据 | [代码对照表](docs/project/traceability.md) |
| 技术结构、接口与开发验证 | [DEVELOPMENT.md](DEVELOPMENT.md) |
| UI 对齐、控件和页面统一 | [UI 1.0 规范](docs/design/ui-standards.md)、[完整迁移方案](docs/design/ui-unification-plan.md) |
| 案件、办理、流转、文档与工具操作 | [使用说明](docs/USER_GUIDE.md) |
| 当前安装包及历史版本 | [交付索引](docs/releases/README.md) |
| 仓库规则 | [AGENTS.md](AGENTS.md) |

## 安装

安装文件见 [安装清单](release/release-manifest.json) 及 [交付索引](docs/releases/README.md)。macOS Apple Silicon 使用 .app / .pkg，Windows x64 使用 NSIS .exe；安装与现场验收见 [0.22.1 测试说明](docs/TESTING-0.22.1.md)。旧包保留 / 清理及各平台验收以当前计划和实际清单为准。

安装器配置保留应用数据；账号、凭证和本机设置在应用数据目录，工作目录与原始申请库另行管理。当前包无发行签名和 macOS 公证，整体应用通过安装包更新。OpenCode 后台默认自动验证并更新，和应用安装包更新分开。

## 开发

```sh
npm ci
npm test
npm run desktop
```

`npm run desktop` 包含类型检查、前端及主进程构建。浏览器预览、模块生成、隔离验证和打包前提见 [开发操作](docs/development/README.md)。桌面模型任务及打包需要准备匹配平台的 OpenCode 运行时；`prepare:agent-runtime` 校验 / 复制已有资源，不自动下载最新版。安装包清理与保留按当次要求执行。

UI 规范已经制定，全部页面的视觉迁移仍按方案推进；不能将文档完成等同全应用已经统一。当前实施状态只见 EXEC_PLAN.md。
