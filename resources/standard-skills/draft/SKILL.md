---
name: draft-cn-invention-patent
description: Draft and review Chinese invention patent applications through a staged, multi-turn workflow. Use when the user provides an invention title or technical disclosure and wants Codex to conceive patentable directions, recommend and confirm a direction, supplement technical details, draft a specification, design embodiments/comparative examples/tests with technically consistent compiled data when useful, draft concise claims, or perform a final China patent-law and examination-guideline review.
---

# 中国发明专利撰写

将发明名称或技术交底转化为结构规范、术语一致、逻辑严谨的中国发明专利申请文件。

## 核心规则

- 以用户明确命令、已确认方向和保护重点为本次撰写依据；用适用的专利法律规范和审查规则进行格式化、复核和风险提示，不擅自改变用户已确认的技术路线。
- 主动补充技术原理、结构、步骤、参数、范围、控制逻辑、替代方案、实施方式、附图建议和证据方案。不得与用户明确给出的内容冲突。
- 必须采用完整多轮阶段确认；不得跳过方向、保护架构、说明书或权利要求确认点。
- 只提供名称时，默认主动构思 3 个实质不同的可实施方向；存在更多显著不同路径时扩展至 4～5 个，合理方向不足 3 个时不为凑数补写薄弱方向。
- 不以数量作为实施例、对比例、实验例或权利要求的目标；每一项内容都必须有明确的支持或证明目的。
- 缺少数据而数据有助于论证时，可以编制形式合理、技术自洽的数据。正式申请文件只呈现申请文本；另行生成内部留存的《编制数据说明》，不得把该说明混入申请文件。
- 默认将权利要求控制在 10 项以内；确有保护必要时，说明理由并征得用户同意后增加。
- 全程使用中文，除非用户要求其他语言。

## 阶段流程

每轮开始和结束时读取 `references/workflow-state.md`，维护基于 `assets/workflow-state-template.md` 的状态卡。状态卡属于工作记录，不得写入正式申请文件。

### 1. 输入识别与方向构思

- 有交底资料时，完整提取技术内容并识别可补充部分。
- 只有名称时，读取 `references/title-driven-conception.md`，主动构思多个方向。
- 方向分析时读取 `references/direction-selection.md`。
- 需要或用户提出检索时，读取 `references/prior-art-search-routing.md`；检索是可选分支，不得阻断未要求检索的撰写流程。
- 输出逐项介绍、横向比较和推荐方向，然后进入**确认点一：方向确认**。

### 2. 技术方案与保护架构

- 用户确认方向后，读取 `references/protection-architecture.md`。
- 读取 `references/domain-routing.md` 确定技术领域，并按需读取 `references/domain-mechanical-electrical.md`、`references/domain-chemical-material.md`、`references/domain-software-ai.md`、`references/domain-biotech-pharma.md` 中一个或多个模块。
- 完善创新点、必要技术特征、保护对象、参数层级、替代方案、附图方案和证据规划。
- 形成保护架构及实施例/对比例/实验例计划，然后进入**确认点二：保护架构确认**。

### 3. 说明书撰写

- 读取 `references/specification-drafting.md` 和 `references/output-template.md`。
- 主动补全能够使技术方案完整、可实施并支持保护范围的内容。
- 涉及数据、参数或效果验证时，同时读取 `references/examples-and-data.md`。
- 完成说明书工作稿及待确认事项，然后进入**确认点三：说明书确认**。

### 4. 权利要求书撰写

- 仅在说明书确认后，读取 `references/claims-drafting.md`。
- 先形成权利要求层级，再撰写正式权利要求和支持关系表。
- 完成后进入**确认点四：权利要求确认**。

### 5. 摘要与正式申请文件

- 用户确认权利要求后，生成说明书摘要、必要的摘要附图建议及分立的正式申请文件。
- 分离撰写分析、待确认事项、内部数据记录和正式申请文本。

### 6. 最终复核

- 读取 `references/final-review.md`。
- 只对已确认的正式申请文件执行格式检查；不得把查新报告、评估报告、修改说明、状态卡或内部数据记录作为格式检查输入。
- 正式申请文件为 DOCX 时，先用 `scripts/docx_to_md.py` 转换为临时 Markdown，再运行 `scripts/audit_patent_draft.py`；Markdown 或文本文件可直接检查。
- DOCX检测到修订时，必须显式选择 `--revision-mode accepted` 或 `--revision-mode original`；未选择模式不得继续使用转换稿，并须核对原DOCX或渲染页。
- 运行脚本时，macOS/Linux 使用 `python3`，Windows PowerShell 优先使用 `py -3`；Windows 未安装 Python Launcher 时使用 `python`。
- 格式脚本只检查章节、权利要求编号、引用和句号等确定性格式。再由模型重新阅读全文并完成语义、技术和规范复核；脚本不得替代模型阅读。
- 复核术语、参数、单位、附图标号、引用关系、说明书支持、权利要求清楚简要、逻辑闭合及文件构成。
- 发现可修复问题时直接修复；涉及保护范围或技术方向变化时向用户确认。

### 7. 交付

- 交付干净的说明书、权利要求书、摘要和必要附图清单。
- 使用了编制数据时，另行交付基于 `assets/compiled-data-record-template.md` 的内部《编制数据说明》。
- 最后列出仍需申请人核验的申请人、发明人、权属、优先权、附图和提交信息。

## 交互纪律

- 每次确认点只集中展示当前阶段的关键结论、可选项和需要用户决定的事项。
- 能通过合理构思补足的内容直接补足，不因普通缺失信息中断工作。
- 只有某项选择会实质改变发明核心、保护范围或技术效果时，才提出针对性问题。
- 用户修改已确认内容时，读取 `references/change-propagation.md`，使用 `assets/change-impact-matrix-template.md` 回溯检查并同步更新说明书、数据、权利要求、摘要、附图和内部记录。
- 每轮结束时明确标注当前阶段、已确认事项和下一步。
