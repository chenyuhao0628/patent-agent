# 按模块归档索引

整理：2026-09-30；记录截至 2026-09-29。已完成的实现、评估与历史方案分别标明层级；归档不表示全部交付验收完成，也不撤销持续有效的需求。当前待办只见 [EXEC_PLAN.md](../../EXEC_PLAN.md)。

## 已完成的实现与证据

| 模块 | 档案 / 证据 | 完成层级与边界 |
| --- | --- | --- |
| 平台、领域、案件中心与历史 | [平台档案](platform.md) | A–C 源码、自测及合成浏览器；保留旧编号，原生与安装按当前计划验收 |
| 案件同步与单案刷新 | [同步档案](sync.md)、[#8 视觉证据](../../evidence/pr8-visual-20260927/README.md) | 源码、合成自动化与浏览器；不替代真实服务 |
| 内部转交、材料删除与预览 | [流转档案](internal-transfer.md) | PR 修复、单文件删除与材料 UI 已实现；真实删除及修复版写入待复验 |
| 撰写、阶段文档与案件关联 | [撰写档案](writing-review.md)、[五项修复证据](../../evidence/five-fixes-20260929/README.md) | 五项修复进入 0.15.2；有隔离 macOS 主路径证据，Word 分页与完整桌面稳定性未验收 |
| 阅读区与 Windows 菜单 | [源码修复记录](writing-review.md#已完成源码修复撰写阅读区与-windows-菜单) | 源码、合成验证与打包已完成（0.15.3，构建源码 d99da21 已推送），Windows 原生待验 |
| 模型后台选择 | [后台对照证据](../../evidence/BACKEND-COMPARISON.md) | 2026-09-12 用户采用 OpenCode；当时文本读写与重开证据不替代完整模型验收 |
| 答复、补正与独立审查 | [平台与历史实现](platform.md)、[后台对照](../../evidence/BACKEND-COMPARISON.md) | 现有实现与规则持续有效；需求见 [答复与定稿](../requirements/reply-finalization.md)、[撰写与审查](../requirements/writing-review.md)，不额外宣称完整质量验收 |
| 构建、PR 核对与源码推送 | [交付档案](releases.md)、[0.15.2 构建证据](../../evidence/release-0.15.2-20260929.json) | 0.15.2 制品生成与摘要核验、源码推送已完成；无远端安装包发布 |

## 评估与历史方案

| 档案 | 定位 |
| --- | --- |
| [统一面板注册](../design/panel-registry.md) | 评估完成、设计待实施，不放入已实现架构 |
| [2026-09-29 交付授权与决定](decisions/2026-09-29-delivery.md) | 历史授权，不自动授权后续操作 |
| [2026-09-25 专项修正](history/correction-2026-09-25.md) | 保留当时 A–E 方案与局部验证；不是当前阶段清单 |
| [2026-09-22 实现摘要](history/project-analysis-2026-09-22.md) | 0.13.0 历史背景 |
| [2026-09-15 页面规划](history/page-map-2026-09-15.md) | 0.12.0 界面分析和未确认建议 |
| [浏览器原型](history/browser-prototype.md) | 原型设计和示例交互；图片仍在原目录 |

## 旧入口对照

| 整理前位置 | 整理后位置 |
| --- | --- |
| REQUIREMENTS.md 的产品与业务细则 | [需求总入口](../../REQUIREMENTS.md) 下的 8 个模块 |
| DEVELOPMENT.md 第 1–7、9 节 | [开发入口](../../DEVELOPMENT.md) 下的 5 个架构分册 |
| DEVELOPMENT.md 第 5.5 节、EXEC_PLAN.md 面板评估 | [面板设计与评估](../design/panel-registry.md) |
| DEVELOPMENT.md 第 8 节 A–C；EXEC_PLAN.md 第 2、3.2、3.4、5 节 | [平台档案](platform.md) |
| DEVELOPMENT.md 第 8 节 D 与旧计划未完成事项 | [当前实施计划](../../EXEC_PLAN.md#未完成与待决定) |
| EXEC_PLAN.md 单案刷新及第 3.1 节 | [同步档案](sync.md) |
| EXEC_PLAN.md 单文件删除与八项 PR 修复 | [流转档案](internal-transfer.md) |
| EXEC_PLAN.md 五项实测修复、阅读区与菜单 | [撰写档案](writing-review.md) |
| EXEC_PLAN.md 构建、PR 推送、第 1、3.3、4 节旧状态 | [交付档案](releases.md)，旧状态明确标注已被取代 |
| CORRECTION_PLAN.md、project_analysis.md、design 两份旧文档 | 本页历史方案；原路径保留短入口 |
| README.md 的详细操作说明 | [使用说明](../USER_GUIDE.md) |

既有 evidence 文件不移动、不改名；本文对其索引不代表本次重新执行验证。后续归档应进入对应模块，保留来源日期、完成层级和未完成边界，不创建新的活动 TODO。
