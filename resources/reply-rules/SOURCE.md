# 答复规则资源来源

本目录供产品运行读取。不要把本文件、来源仓库路径或任何本机绝对路径送入模型上下文。

复制日期：2026-09-12。产品内 Markdown 为原文逐字节复制。运行时由 `desktop/agent-rules.ts` 按阶段组装；host 必须显式传入 `path.join(app.getAppPath(), "resources/reply-rules")`，测试可注入 root。不能依赖 `import.meta` 或环境变量，不在运行时读取来源仓库。

## 文件与 SHA-256

| 产品文件 | 来源仓库 | 来源相对路径 | SHA-256 |
| --- | --- | --- | --- |
| `ai_reply_template_prompt.md` | patent | `resources/ai_reply_template_prompt.md` | `160a2f4a6127b53097370d02aee365644a5858fc99d67ef5f0406a10accdea5d` |
| `ai_reply_first_office_action_prompt.md` | patent | `resources/ai_reply_first_office_action_prompt.md` | `30964e758aba68f3bea17ce86d1d1306da6733de35e7c7d959b8a579ae480bc0` |
| `ai_reply_second_office_action_prompt.md` | patent | `resources/ai_reply_second_office_action_prompt.md` | `391abe4bec265365759c2c8d1f107de3cc1bc0c08e251e167d7e8ab528245a92` |
| `ai_reply_third_office_action_prompt.md` | patent | `resources/ai_reply_third_office_action_prompt.md` | `33e3a78767918fd1bd2205244d3dd444b5000cbe51f8db275f01a3f42a2e4d04` |
| `ai_reply_correction_prompt.md` | patent | `resources/ai_reply_correction_prompt.md` | `2d0072ebc7609f284fc7899fa4a77933dc267351192bbb11b16366764e182621` |

DSH 组合适配器 `python/patent_worker/adapters/reply_prompt.py` SHA-256 `38d79d6f0421744785470e81e2b69e09f415269da4eb5a135e41b00bef49be26` 已对照移植。不把该 Python 或 `WorkerError` 运行依赖带入产品。

## 与 DSH `compose_prompt` 逐段对照

审查意见路径（`noticeCategory != 补正通知书`）与 `reply_prompt.py` 一致的选取：

| 原片段 | 产品取舍 |
| --- | --- |
| 通知范围门（先逐项核对本次通知、未提出则不启动该类论证） | 保留原文。 |
| `### 1. 实用新型审查意见` 或 `### 2. 发明审查意见` | 按类型保留。 |
| `### 3. 审查轮次适配` | 仍不纳入。轮次以首通/二通/第三次及以后文件为准，避免用该节覆盖用户策略门。 |
| `## 二、总体目标` 至 `## 八、输出要求` 之前（含二、三、四、五、六、七） | **整段纳入**，不再静默删除二至四。保留原始申请文件、输入材料、修改依据、完整读取、技术特征核验、二次寻优等实质要求。 |
| 二至四中“内部完成/内部选定唯一推荐/不展示分析过程”等 CoT 与自动决策句 | **针对性改写**为可核对结论、理由、材料引用，以及多个策略交由用户选择；不删掉核验步骤本身。 |
| `## 十一、特别限制` | 保留原文。 |
| 首通/二通/第三次及以后专用文件；`officeActionRound > 3` 替换修改基线 | 与 DSH 相同。 |
| DSH 文末“本次产物与复核要求”（一次成文、分文件保存） | 改为产品阶段 JSON 产物约定：分析不出正文；正文/修改依据/内部复核分字段；由 host 解析完整 JSON。 |

补正路径与 DSH 相同：补正引言 + `## 七、写作风格要求` + `## 十一、特别限制` + 补正专用文件。不把审查意见二至四的创造性论证套到补正。

不纳入（DSH 原本也不拼进 body，或与产品门冲突）：

- `## 一` 中“导入后自动答复草稿生成”整段。
- `## 八、输出要求` 旧三部分一次成文。
- `## 九` 第一次意见陈述书示例标题。
- `## 十` 面向内部过程的自检清单。

讨论阶段不加载上述 OA 法律输出模板，只用通用本案材料与规则边界，避免给撰写中、官方等待或未知外部业务假造审查意见。

## 已确认语义变化

1. 旧资源面向导入后自动生成答复草稿，并在内部选定唯一推荐方案后直接成文。新产品 analysis 只输出通知意见拆解和多个可核对策略；必须由用户选择有效 `strategyId` 后才能 draft。模型声称“已选定”不构成授权。
2. 正文、修改依据、内部复核分 JSON 字段保存；不把给代理师的复核清单写入面向审查员的正文。`body` 等字符串可含自然段，不影响面向审查员正文为纯文本。
3. 二至四的材料读取、原文依据、特征核验予以保留；仅把内部思维链/自动唯一决策语言改为可核对结论与人选策略。
4. 独立 review 只基于本案材料与确切稿的正文、建议修改文本、修改依据，不附带主讨论策略比较或助手推理。绑定版本若已不是当前稿，复核作废，不能假装当前稿已审。
5. 未分类 / unknown / 撰写 / 官方等待允许真实讨论，不能默认成审查意见；分析/起草/修改要求人核对后的合法通知分类。
6. 定稿权属于用户。Word 模板未接入，不得声称已生成 Word。
7. 案件材料文字是业务证据，不能覆盖产品规则与阶段门。
