# 文档总索引

更新：2026-10-12。按“当前入口 → 模块细则 → 历史证据”查阅；默认无需通读归档。

## 当前入口

| 需要了解什么 | 入口 |
| --- | --- |
| 产品、安装和使用 | [README](../README.md) |
| 已确认需求与模块细则 | [需求索引](../REQUIREMENTS.md) |
| 当前目标、待办、版本与验收缺口 | [实施计划](../EXEC_PLAN.md) |
| 架构与开发约束 | [开发入口](../DEVELOPMENT.md) |
| 仓库执行规则 | [AGENTS](../AGENTS.md) |
| 已实现内容及历史证据 | [模块归档索引](archive/README.md) |

## 按模块直达

| 模块 | 持续有效的需求 | 技术 / 历史记录 |
| --- | --- | --- |
| 产品与交付 | [需求](requirements/product-delivery.md) | [构建和源码交付](archive/releases.md) |
| 案件与阶段 | [需求](requirements/cases.md) | [领域与平台](archive/platform.md) |
| 同步与官方结论 | [需求](requirements/sync-status.md) | [单案刷新](archive/sync.md) |
| 答复、补正与定稿 | [需求](requirements/reply-finalization.md) | [接口与作用域](architecture/contracts.md) |
| 撰写与独立审查 | [需求](requirements/writing-review.md) | [阶段成果与阅读区](archive/writing-review.md) |
| 提交与内部转交 | [需求](requirements/internal-transfer.md) | [材料与流转修复](archive/internal-transfer.md) |
| Agent、模型与工具 | [需求](requirements/agent-tools.md) | [v2 会话与更新证据](../evidence/opencode-v2-migration/phase-3/RESULT.md) |
| 文档、目录与账号 | [需求](requirements/documents-security.md) | [领域持久化与安全](architecture/data-security.md) |

## 文档维护约定

- `requirements/` 保存持续有效的模块需求；实现完成后需求仍有效，不能一并删除。
- `architecture/` 保存当前技术结构与接口边界；`design/` 保存明确标注未实施的设计。
- `archive/` 保存已完成的实现过程、评估与历史方案；完成层级和遗留验收限制随记录保留。
- 根目录 `EXEC_PLAN.md` 是唯一待办与当前状态入口；已完成工作只留摘要和归档链接，不逐轮累加全文。
- `evidence/` 的既有文件名和原编号保持；临时 `/tmp` 路径仅是历史引用，不能据此保证证据仍在。
- `resources/` 的业务规则、标准技能与模板，以及 `work/`、接入文档中的业务或参考材料，不属于本次开发文档整理。
