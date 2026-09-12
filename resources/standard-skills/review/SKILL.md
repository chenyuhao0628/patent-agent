---
name: review-cn-invention-patent
description: Independently review and, when authorized, revise Chinese invention patent application files before filing or after revision. Use for full-application review, targeted re-review, or controlled correction of specifications, claims, abstracts, drawings, Markdown, text, DOC/DOCX, embodiments, comparative examples, test data, claim dependency and antecedent basis, drawing-derived disclosures, mechanical apparatus completeness, method-flow consistency, data provenance, and cross-version consistency. Do not use for title-only invention conception or office-action response drafting.
---

# 中国发明专利独立审查 V3

对已有中国发明专利申请文件执行完整审查、定向复核或受控修改。保留V2的证据、参数、数据、附图、传播和版本门禁，并增加程序阶段、权利要求依赖、图纸证据边界、机械功能闭环、方法状态和语义增量控制。

## 核心边界

- 默认只读；用户明确授权后才能修改。
- 不因局部优化改变技术问题、核心创新点、必要技术特征、权利要求架构、参数作用或保护范围。
- 涉及技术事实、数据、技术关系、保护范围或方案变化时按C级处理并取得确认。
- 保留当前正式文件，修改结果另存新版本；未经明确要求不得覆盖原文件。
- 不从发明名称重新构思方案；该任务使用`draft-cn-invention-patent`。
- 不默认处理审查意见答复、复审或无效程序。
- 现有技术检索为可选分支；未检索时不对新颖性、创造性作确定结论。
- 格式脚本通过不等于实质审查通过或可提交。

## 一、选择工作模式

读取`references/review-workflow.md`并选择：

1. **完整审查**：审查整套申请，执行全部适用矩阵、报告和提交准备判断；
2. **定向复核**：只处理用户指定问题，同时检查依赖、支持和传播位置；未检查部分不得报告为“没有问题”；
3. **受控修改**：在完整或定向审查基础上修改文件，执行修改依据、语义增量、传播和交付回归。

完整审查保留三类强制矩阵。定向复核只建立或更新受影响矩阵，不重复处理无关数据。

## 二、锁定程序阶段、来源和版本

始终读取`references/source-and-stage-control.md`：

- 标记`pre-filing`、`post-filing`或`unknown`；
- 区分当前稿、原始提交文件、交底书、图纸、实验记录、内部审核和旧稿；
- 记录文件名、版本、日期、哈希、缺件、排除文件和审查范围；
- 必要时使用`assets/source-admissibility-template.csv`。

程序阶段不明且拟增加技术内容时停止修改。不得用交底书、工程常识或外部资料替代原始公开。

交付物状态使用：`formal-source`、`internal-record`、`compiled-data`、`awaiting-applicant-confirmation`、`submission-ready`。

## 三、规范化文件

- Markdown和UTF-8文本直接读取。
- DOCX使用`scripts/docx_to_md.py`转换到过程目录并阅读全部警告。
- DOCX检测到修订时，必须显式选择`--revision-mode accepted`或`--revision-mode original`；未选择模式不得继续使用转换稿。
- 存在公式、附图、修订、批注、脚注、内容控件或嵌入对象时，核对原DOCX或渲染页。
- 旧版DOC保留原件和哈希，在过程目录转换为DOCX；核对页数、表格、图片、公式、批注和分页。
- 编辑或交付DOCX时同时使用`documents` skill并渲染全部页面。
- 只把正式申请文件输入格式脚本，内部记录单独审查。

## 四、执行审查

先运行`scripts/audit_patent_format.py`。该脚本只检查必要章节、权利要求编号和引用、句号结构。

### 完整审查

重新阅读全文并读取：

- `references/legal-and-structure-review.md`
- `references/claims-and-support-review.md`
- `references/specification-and-evidence-review.md`
- `references/consistency-and-reporting.md`

建立：

1. 权利要求—说明书支持矩阵；
2. 实施例/对比例×证据维度矩阵；
3. 独立权利要求必要特征—技术效果—证据类型矩阵。

证据矩阵单元格只能填写具体值或位置、`同实施例/对比例X`、`N/A：理由`、`缺失：P级`，不得留空。

### 定向复核

读取与问题直接相关的参考文件及`references/consistency-and-reporting.md`。检查该问题的引用基础、说明书支持、附图、摘要和修改传播，但不对未审范围作结论。

### 条件专项

- 多项权利要求、重复对象、并列从属分支或权利要求修改：读取`references/claim-dependency-and-antecedent.md`，使用`assets/claim-element-ledger-template.csv`；
- 附图核验、依据图纸补充或重绘：读取`references/drawing-evidence-control.md`；
- 机械装置、实验设备、加载、压力或测量系统：读取`references/mechanical-apparatus-review.md`，必要时使用`assets/mechanical-function-closure-template.md`；
- 方法权利要求、工艺步骤或流程图：读取`references/method-state-and-flowchart-review.md`，使用`assets/method-step-crosswalk-template.csv`；
- 实施例删减、参数缩限、补编数据、附图修改或多轮版本：读取`references/revision-evidence-control.md`。

## 五、报告

使用`assets/review-report-template.md`。分别报告确定性格式、实质审查、证据和数据、附图、检索状态、程序阶段、审查范围和提交准备状态。

每个问题写明文件、位置、问题、依据及证据等级、影响、建议和确认需求。同一根因影响多个位置时建立一个主问题并列出传播位置。

## 六、受控修改门禁

用户授权修改后，先使用`assets/findings-register-template.md`锁定全局方案、术语、权利要求架构、参数、数据结论和拟修复问题。

执行：

1. **修改依据门禁**：确认程序阶段、来源角色和使用等级；
2. **删减门禁**：证明剩余材料仍覆盖全部权利要求特征、核心效果和因果对比；
3. **参数来源门禁**：端点和确定值可追溯，禁止拼接未经整体公开的组合；
4. **必要特征证据门禁**：标记实施例、机理、对比和现有技术区别证据；
5. **编制数据门禁**：只有用户明确授权后进入编制数据模式；
6. **附图门禁**：区分D1至D4，默认保留说明作用并重绘冲突；
7. **语义增量门禁**：使用`assets/revision-semantic-delta-template.csv`记录新增或删除的对象、关系和范围影响。

修改权限：

- A级：格式、标点和不改变技术含义的明显语病；
- B级：术语、指代、引用、附图标记和前后文同步，须记录传播位置；
- C级：核心方案、技术事实、必要特征、空间/连接/运动/受力/步骤关系、参数、数据、权利要求架构或保护范围，确认后修改。

只修复对象引入或指代时采用最小文字修复，不顺带增加“设置于、固定于、连通、限位、防脱、抗转”等新关系。

## 七、修改后回归

1. 更新适用矩阵、要素台账、步骤对照和语义增量台账；
2. 重跑格式、术语、参数、单位、附图标记和传播扫描；
3. 运行适用脚本：
   - `audit_evidence_matrix.py`
   - `audit_parameter_provenance.py`
   - `audit_claim_antecedent_basis.py`
   - `audit_method_step_alignment.py`
   - `audit_revision_semantic_delta.py`
   - `audit_revision_propagation.py`
   - `audit_version_bundle.py`
4. 重新阅读全文并检查技术问题—技术手段—技术效果是否漂移；
5. 核对权利要求依赖路径、说明书、摘要、附图和内部记录；
6. 用户要求标注版时，核验Word真批注、修订或高亮的形式、锚点和既有批注；
7. 渲染全部页面，检查分页、遮挡、图片、公式和图中文字；
8. 报告已修复、未修复、新增问题、同步位置、数据状态和版本差异。

## 八、问题分级

- **P0 阻断**：文件不能形成有效申请、关键方案不可实施、独立权利要求缺少核心必要特征、明显无支持或文件严重混杂；
- **P1 高风险**：可能导致不清楚、不支持、不充分公开、客体、单一性或保护范围重大缺陷；
- **P2 中风险**：从属层级、前置基础、术语、参数、证据链、附图或一致性问题；
- **P3 优化**：表达、结构、冗余和可读性改进。

## 九、数据和测量

- 编制数据须记录来源、基准、控制变量、趋势、区间、计算、使用位置和确认状态；
- 不得虚构检测报告号、仪器原始记录、第三方证明或声称已经实际测试；
- 正式申请文本不得混入内部来源说明；
- 性能、组织或结果参数须检查标准、试样、状态、载荷/时间、测点、仪器阈值、重复次数和统计方法；
- 区分设定值、名义值、传感器读数和试件实际值；浮力、摩擦、自重或热梯度只有经误差估算后才能认定可忽略。

## 十、跨平台命令

- macOS/Linux使用`python3`；
- Windows PowerShell优先使用`py -3`。

```powershell
py -3 "$env:USERPROFILE\.codex\skills\review-cn-invention-patent\scripts\docx_to_md.py" "申请文件.docx" -o "申请文件.md"
py -3 "$env:USERPROFILE\.codex\skills\review-cn-invention-patent\scripts\audit_patent_format.py" "申请文件.md"
py -3 "$env:USERPROFILE\.codex\skills\review-cn-invention-patent\scripts\test_review_tools.py"
py -3 "$env:USERPROFILE\.codex\skills\review-cn-invention-patent\scripts\test_v2_tools.py"
py -3 "$env:USERPROFILE\.codex\skills\review-cn-invention-patent\scripts\test_v3_tools.py"
```
