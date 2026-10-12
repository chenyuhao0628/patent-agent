# 文档总索引

更新：2026-10-12，当前应用 **0.22.1**。按“需求 → 计划 → 设计与实现 → 验证 → 交付 → 归档”查阅。现行说明描述实际代码，需求保留应达到的行为，两者差距集中在当前计划；历史报告只代表当时的版本与场景。

## 按项目管理流程查阅

| 环节 | 入口与用途 |
| --- | --- |
| 项目概况 | [README](../README.md)：产品范围、当前版本、安装与开发入口 |
| 工作规则 | [AGENTS](../AGENTS.md)：授权、资料边界、实施与验收规则 |
| 需求与决定 | [REQUIREMENTS](../REQUIREMENTS.md)：九个模块及生效决定，保留完整产品范围 |
| 当前执行 | [EXEC_PLAN](../EXEC_PLAN.md)：唯一当前任务、实现差距与待验收项入口 |
| 设计与实现 | [DEVELOPMENT](../DEVELOPMENT.md)：六个架构分册、模块方案与开发操作 |
| UI 规范与统一方案 | [UI 1.0](design/ui-standards.md)：对齐、尺寸、控件和状态标准；[页面统一方案](design/ui-unification-plan.md)：完整覆盖、阶段及复核 |
| 需求追溯 | [代码对照表](project/traceability.md)：需求对应实现、测试与已有证据 |
| 开发操作 | [命令与验证](development/README.md)、[模块接入](development/module-guide.md)：环境、生成、保存与替换合同 |
| 用户操作 | [使用说明](USER_GUIDE.md)：首次设置、全案与单案、业务办理、会话和更新 |
| 交付与验收 | [交付索引](releases/README.md)、[0.22.1 测试说明](TESTING-0.22.1.md)：当前包、证据及平台边界 |
| 已完成与历史 | [归档索引](archive/README.md)：旧决定、已完成阶段、评估和旧版本记录 |
| 文档维护 | [职责与更新流程](project/documentation.md)：信息放在哪里、何时更新、如何保留历史 |

## 按模块查阅

| 模块 | 已确认需求 | 当前技术说明 / 操作 |
| --- | --- | --- |
| 模块平台 | [需求](requirements/module-platform.md) | [接入指南](development/module-guide.md)、[已实施方案](design/module-platform.md) |
| 产品与交付 | [需求](requirements/product-delivery.md) | [开发操作](development/README.md)、[交付索引](releases/README.md) |
| 案件与阶段 | [需求](requirements/cases.md) | [实现基线](architecture/overview.md)、[页面与历史](architecture/ui.md) |
| 同步与官方结论 | [需求](requirements/sync-status.md) | [同步参数与已知差距](architecture/overview.md#22-同步与缓存) |
| 答复、补正与定稿 | [需求](requirements/reply-finalization.md) | [使用说明](USER_GUIDE.md#答复与补正)、[接口与作用域](architecture/contracts.md) |
| 撰写与独立审查 | [需求](requirements/writing-review.md) | [使用说明](USER_GUIDE.md#撰写与独立审查)、[任务续办合同](architecture/contracts.md#任务续办合同自-0170-引入) |
| 提交与内部转交 | [需求](requirements/internal-transfer.md) | [使用说明](USER_GUIDE.md#提交与内部转交)、[实现基线](architecture/overview.md#23-办理与流转) |
| Agent、模型与工具 | [需求](requirements/agent-tools.md) | [Agent / 运行时 / 会话](architecture/agent-runtime.md)、[使用说明](USER_GUIDE.md#会话上下文缓存与更新) |
| 文档、目录与账号 | [需求](requirements/documents-security.md) | [数据与安全](architecture/data-security.md)、[使用说明](USER_GUIDE.md#首次设置) |

各模块的具体代码、测试和证据见代码对照表。历史证据索引不表示本次重新执行验证；既有 `evidence/` 文件和编号保留，运行资源、接口参考和案件材料按原职责管理。
