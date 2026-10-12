# 开发与架构入口

更新：2026-10-12。当前源码和制品版本以 package.json、[安装清单](release/release-manifest.json) 为准；实施状态只维护于 [EXEC_PLAN.md](EXEC_PLAN.md)。

## 架构分册

| 主题 | 内容 |
| --- | --- |
| [架构与实现基线](docs/architecture/overview.md) | 产品职责、Electron 进程、业务模块、同步缓存与流转基线 |
| [公开接口与作用域](docs/architecture/contracts.md) | DesktopAPI、IPC 类型与解析、保存队列、账号 / 案件 / 流程隔离 |
| [页面与历史访问](docs/architecture/ui.md) | 页面装配、Feature Registry、只读历史、加载与错误状态 |
| [数据与安全](docs/architecture/data-security.md) | 领域记录、schema 迁移、共享边界、文件身份、凭证与工具权限 |
| [开发与验收规范](docs/architecture/verification.md) | 开发顺序、按风险验证、各类证据的适用边界 |
| [模块平台方案](docs/design/module-platform.md) | 已授权的面板宿主、统一数据、适配器及模板实施方案与复核 |

## 实施记录去向

- 原第 8 节 A–C 的已完成清单、B/C 实现定位和复审证据归入 [平台模块档案](docs/archive/platform.md)。
- 原第 8 节 D 的未完成桌面、模型、文档及安装验收移至 [当前计划](EXEC_PLAN.md)，不在多份文件重复勾选。
- 单案刷新、内部流转、撰写与阅读区、发布和旧方案见 [模块归档索引](docs/archive/README.md)。
- 归档保留原日期、版本、测试数与限制；Feature Registry 已实现不代表统一面板注册已实现。

## 维护方式

先读 [已确认需求](REQUIREMENTS.md)、[仓库规则](AGENTS.md) 和当前计划，再按影响范围读分册。修改接口或行为时更新对应模块；完成的实施过程归档，只在当前计划保留摘要与链接。普通文档整理不改变产品规则或安装版本。
