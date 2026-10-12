# 开发与架构入口

更新：2026-10-12。当前源码和制品版本以 package.json、[安装清单](release/release-manifest.json) 为准；实施状态只维护于 [EXEC_PLAN.md](EXEC_PLAN.md)。

从修改需求进入开发时，先看 [代码 / 测试 / 证据对照](docs/project/traceability.md)，再看 [开发与验证操作](docs/development/README.md)。文档如何归位见 [文档管理](docs/project/documentation.md)。

UI 工作先读 [UI 规范与设计标准](docs/design/ui-standards.md) 和 [页面覆盖 / 分阶段方案](docs/design/ui-unification-plan.md)。规范管理目标参数，架构分册说明当前实现；不要把尚未生成的 token / 共用组件当作已有接口。

## 架构分册

| 主题 | 内容 |
| --- | --- |
| [架构与实现基线](docs/architecture/overview.md) | 产品职责、Electron 进程、业务模块、同步缓存与流转基线 |
| [公开接口与作用域](docs/architecture/contracts.md) | DesktopAPI、IPC 类型与解析、保存队列、账号 / 案件 / 流程隔离 |
| [页面与历史访问](docs/architecture/ui.md) | 页面装配、Feature Registry、只读历史、加载与错误状态 |
| [数据与安全](docs/architecture/data-security.md) | 领域记录、schema 迁移、共享边界、文件身份、凭证与工具权限 |
| [Agent、运行时与会话](docs/architecture/agent-runtime.md) | 结构化执行、会话隔离、上下文缓存 / 压缩、续办和 OpenCode 自动兼容更新 |
| [开发与验收规范](docs/architecture/verification.md) | 开发顺序、按风险验证、各类证据的适用边界 |
| [模块接入指南](docs/development/module-guide.md) | 全局 / 单案模板、统一数据、适配器、长任务与验证责任 |
| [模块平台方案](docs/design/module-platform.md) | 已授权的面板宿主、统一数据、适配器及模板实施方案与复核 |

## 实施记录去向

- 原第 8 节 A–C 的已完成清单、B/C 实现定位和复审证据归入 [平台模块档案](docs/archive/platform.md)。
- 原第 8 节 D 的未完成桌面、模型、文档及安装验收移至 [当前计划](EXEC_PLAN.md)，不在多份文件重复勾选。
- 单案刷新、内部流转、撰写与阅读区、发布和旧方案见 [模块归档索引](docs/archive/README.md)。
- 归档保留原日期、版本、测试数与限制；统一面板注册的当前实现及验收见模块平台方案、接入指南和当前计划。
- 0.22.0 模块平台与清包过程见 [2026-10-12 阶段归档](docs/archive/module-platform-20261012.md)；当前制品与历史测试说明由 [交付索引](docs/releases/README.md) 管理。

## 维护方式

先读 [已确认需求](REQUIREMENTS.md)、[仓库规则](AGENTS.md) 和当前计划，再按影响范围读分册。修改接口或行为时更新对应模块；完成的实施过程归档，只在当前计划保留摘要与链接。普通文档整理不改变产品规则或安装版本。
