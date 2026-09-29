# 已确认需求与决策索引

更新：2026-09-30。产品完整范围保留，细则按模块查阅。本文及下列模块文档共同构成已确认需求；已实现的过程与证据另行归档，不使需求失效。

## 产品边界

- 独立 macOS / Windows 桌面工作台，覆盖案件管理、答复与补正、撰写、可选独立审查、贝思兰德保存与内部转交；答复是当前完整交付重点。
- 一案只有一个当前办理阶段；历史只读，多案可并行。
- 应用掌握业务与文件，模型通过结构化接口工作；账号、案件、轮次、版本与任务上下文隔离。
- 原件、用户直接编辑稿及历史成果保留；Word 使用指定模板，真实业务写入须有对应授权。
- 保存、内部转交与官方递交分别核验；浏览器演示、源码完成、自动化通过和制品生成均不等于完整交付验收。

## 按模块查阅

| 模块 | 已确认细则 |
| --- | --- |
| 产品与交付 | [产品与交付](docs/requirements/product-delivery.md) |
| 案件管理与办理阶段 | [案件管理与办理阶段](docs/requirements/cases.md) |
| 贝思兰德同步与官方结论 | [贝思兰德同步与官方结论](docs/requirements/sync-status.md) |
| 答复、补正与定稿 | [答复、补正与定稿](docs/requirements/reply-finalization.md) |
| 撰写与独立审查 | [撰写与独立审查](docs/requirements/writing-review.md) |
| 提交与内部转交 | [提交与内部转交](docs/requirements/internal-transfer.md) |
| 模型、Agent 与扩展工具 | [模型、Agent 与扩展工具](docs/requirements/agent-tools.md) |
| 文档、目录、账号与安全 | [文档、目录、账号与安全](docs/requirements/documents-security.md) |

## 状态与决策去向

- 当前版本、待办与验收缺口只维护在 [EXEC_PLAN.md](EXEC_PLAN.md)；已实现记录见 [模块归档索引](docs/archive/README.md)。
- 2026-09-29 五项实测修复要求分别归入案件、内部转交、撰写与交付；单文件删除归入内部转交。阅读区要求在撰写模块，Windows 菜单要求在工具与诊断细则。
- 已完成的构建、PR 核对与推送授权见 [历史操作决策](docs/archive/decisions/2026-09-29-delivery.md)，不自动延续授权。
- 统一面板注册只有 [可行性设计](docs/design/panel-registry.md)，未确认实施，不能当作已实现需求。
- 2026-09-30 文档整理保持全部产品范围和业务规则；随后用户授权按修复版升至 0.15.3，构建成功后清理旧包并推送 GitHub，不触发 GitHub Actions。旧建议、历史方案和未回答选项不自动成为新需求。
