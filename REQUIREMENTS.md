# 已确认需求与决策索引

更新：2026-10-12。产品完整范围保留，细则按模块查阅。本文及下列模块文档共同构成已确认需求；已实现的过程与证据另行归档，不使需求失效。

## 产品边界

- 独立 macOS / Windows 桌面工作台，覆盖案件管理、答复与补正、撰写、可选独立审查、贝思兰德保存与内部转交；答复是当前完整交付重点。
- 一案只有一个当前办理阶段；历史只读，多案可并行。
- 应用掌握业务与文件，模型通过结构化接口工作；账号、案件、轮次、版本与任务上下文隔离。
- 原件、用户直接编辑稿及历史成果保留；Word 使用指定模板，真实业务写入须有对应授权。
- 保存、内部转交与官方递交分别核验；浏览器演示、源码完成、自动化通过和制品生成均不等于完整交付验收。

## 按模块查阅

| 模块 | 已确认细则 |
| --- | --- |
| 模块平台与统一数据管理 | [模块平台与统一数据管理](docs/requirements/module-platform.md) |
| 产品与交付 | [产品与交付](docs/requirements/product-delivery.md) |
| 案件管理与办理阶段 | [案件管理与办理阶段](docs/requirements/cases.md) |
| 贝思兰德同步与官方结论 | [贝思兰德同步与官方结论](docs/requirements/sync-status.md) |
| 答复、补正与定稿 | [答复、补正与定稿](docs/requirements/reply-finalization.md) |
| 撰写与独立审查 | [撰写与独立审查](docs/requirements/writing-review.md) |
| 提交与内部转交 | [提交与内部转交](docs/requirements/internal-transfer.md) |
| 模型、Agent 与扩展工具 | [模型、Agent 与扩展工具](docs/requirements/agent-tools.md) |
| 文档、目录、账号与安全 | [文档、目录、账号与安全](docs/requirements/documents-security.md) |

## 生效决定与查阅顺序

用户最新明确要求优先。需求文件描述应达到的行为，代码描述已经实现的行为，证据只证明指定版本 / 场景。三者有差异时保留需求，在 [当前计划](EXEC_PLAN.md) 登记；不把历史建议、未回答选项或一次测试变成新需求。

| 生效日期 | 决定 | 权威细则 |
| --- | --- | --- |
| 2026-10-12 | 完整规划并设定 UI 规范与设计标准，要求页面对齐、同类控件和各类页面统一；同时修复内部流转 / 工作任务首次打开的界面异常 | [模块平台 UI 要求](docs/requirements/module-platform.md#ui-对齐与页面统一)、[UI 规范](docs/design/ui-standards.md)、[页面统一方案](docs/design/ui-unification-plan.md) |
| 2026-10-12 | 完整核对文档与代码，按项目管理职责整理；现行说明、方案、历史记录和证据分开管理 | [文档管理](docs/project/documentation.md)、[代码对照](docs/project/traceability.md) |
| 2026-10-12 | 全局 / 单案分别注册；统一数据与可替换适配器；提供真实可接入模板并核对性能 | [模块平台](docs/requirements/module-platform.md) |
| 2026-10-12 | OpenCode v2，自动检查并安装兼容更新，空闲切换与回退；案件 / 阶段 / 分支会话隔离、保留及缓存核验 | [模型与工具](docs/requirements/agent-tools.md) |
| 2026-10-12 | 交付后清理旧安装包，本次仅保留 0.22.0 三项制品和当前清单；历史证据保留 | [产品与交付](docs/requirements/product-delivery.md#安装包保留与清理) |
| 2026-10-09 | 多份修改文件独立选择、保存、预览及恢复；真实工作台稿件保存失败根因仍须验证 | [内部转交](docs/requirements/internal-transfer.md) |
| 2026-10-01 | 官方结论只锁定结论所属流程；新后续流程仍可办理，缺少归属的旧记录保持整案锁定 | [案件与阶段](docs/requirements/cases.md)、[同步与结论](docs/requirements/sync-status.md) |
| 2026-10-01 | 退回后旧完成稿可经二次确认显式采用，保留原记录；答复、补正与撰写不自动采用旧上下文结果 | [答复与定稿](docs/requirements/reply-finalization.md)、[撰写与审查](docs/requirements/writing-review.md) |
| 2026-09-30 | 按已有材料选择撰写起点，缺失步骤再补；统一依据 / 产物 / 续办展示，保留单案唯一当前阶段 | [撰写与审查](docs/requirements/writing-review.md)、[模型与工具](docs/requirements/agent-tools.md) |
| 2026-09-29 至 10-01 | 目录整理、阶段 Word、案件关联、单份远端删除、公式往返及版本保护 | 对应业务模块细则和 [历史决定原文](docs/archive/decisions/2026-10-12-requirements-history.md) |

上述表格是检索入口，不替代九个模块的细则。全部整理前的决定及时间线保留在 [决定归档](docs/archive/decisions/2026-10-12-requirements-history.md)；历史推送 / 发布授权仅属于当次操作，不自动延续。

界面验证设备为用户指定的 13 英寸 MacBook Air 与 24 英寸 1080p 屏幕；覆盖 1280×800、1440×900、1920×1080 及窗口边框占用后的内容高度。CSS 视口检查与真实设备验收分别记录。当前待办和验收缺口仅维护于 EXEC_PLAN.md，已完成过程见 [档案索引](docs/archive/README.md)。
