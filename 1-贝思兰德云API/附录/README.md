# 附录：业务码对照 · 审查记录 · 实测证据 · 解析工具

> 总目录：[接入文档](../../README.md) ｜ 分册：[贝思兰德云 API](../README.md)

本附录**不是操作说明书**，是 [13-写操作-业务码与结果契约.md](../13-写操作-业务码与结果契约.md) 与各分册正文的**支撑材料**。日常操作只需读正文；本附录用于补文案、复核结论、重跑验证。

---

## 一、业务码中文对照

| 文件 | 内容 | 什么时候用 |
| --- | --- | --- |
| [业务码中文对照.md](./业务码中文对照.md) | 按端点列出每个业务码的**官方原文**，并标注"真失败 / 需重新打包 / 忙 / 需勾选" | 给报错提示写文案时 |
| [业务码中文对照.tsv](./业务码中文对照.tsv) | 113 行 / 11 张表 / 94 条带中文，列为「端点 · 用途 · 业务码 · i18nKey · 官方中文」 | 按码检索时（`awk -F'\t' '$3=="NeedRePack"'`） |

> 文案来源是**贝思兰德官方前端自己用的提示语**，不是服务端文档。各端点实际会遇到哪几个码，以真实调用返回为准。

---

## 二、审查记录

| 文件 | 内容 |
| --- | --- |
| [patent-agent接入正确性判断.md](./patent-agent接入正确性判断.md) | 对 `patent-agent`（专利工作台 0.3.0）接入贝思兰德的逐条只读审查：协议层对照、缺陷清单、未验证项、优先级建议。含 v1→v4 的更正记录 |

这份文档是**审查记录**，不是通用说明书；其中的 API 级结论已提炼进 [13-写操作-业务码与结果契约.md](../13-写操作-业务码与结果契约.md)。

---

## 三、实测证据（`实测证据/`）

全部为**只读**调用，未触发任何写接口、未向国家知识产权局网关发送请求。

| 内容 | 说明 |
| --- | --- |
| `README.md` | 早期「文档 33 条只读 curl 逐条复核」记录 |
| `curl-cmds.json`、`doc4_cmds.json`、`ro_verify.sh`、`run_ro_verify.sh`、`generated_calls.sh` | 从正文抽出的 curl 与批量复核脚本 |
| `bs_probe*.sh`、`bs_cross.sh`、`bs_dump.sh`、`bs_verdict.py`、`probe_gaps.sh`、`retry2.sh` | 权限探测与字段探测脚本 |
| `bs_pending.json`、`bs_probe_list.json`、`flow3.json`、`flow_result.json`、`hand_result.json` | 五个页签、流程链路、递交实例的真实返回快照 |
| `pa_judge_probe*.sh` / `.out` | 接入审查用的 9 轮探针与输出（分页行为、字段存在性、业务码、覆盖范围、Token 失效形态等） |
| `probe_current_terminal.sh`、`probe_personal_name_fields.sh`、`probe_history_name.sh`（含同名 `.out`） | 递交状态终态分布（当前流程 vs 全部流程两个口径）、`GetPersonalCase` 名字字段实况、官文/流程名字字段对照 |
| `probe_authorize.sh`、`probe_authorize2.sh`、`probe_authorize3.sh`、`probe_authorize4.sh`（含同名 `.out`） | 授权与获证检测：按客户名定位案件、案件新动态 13 类枚举与订阅口径、授权字段所在层级、案件状态字典解析 |
| `probe_notice.sh`、`probe_notice2.sh`、`probe_notice3.sh`（含同名 `.out`） | 授权通知书链路：`GetNoticeById` 取官文详情、案件官文清单、附件下载校验、官文状态与流程/案件状态字典 |
| `probe_result.sh`、`probe_result2.sh`、`probe_noticetype.sh`、`probe_noticetype2.sh`（含同名 `.out`） | 「只要授权/驳回结果」可行性：窗口参数实测不生效、13 类目条数、官文类型字典 337 条与结论判读表 |
| `probe_coverage.sh`、`probe_coverage2.sh`（含同名 `.out`） | 官文清单覆盖范围抽样（12 案）与「授权/获证后案卷字段仍为空」的对照 |
| `pick_ids.py`、`summarize.py`、`param_targets.txt` | 取真实 ID、汇总结果、参数探测目标清单 |
| `notice/`、`fee-notices.zip`、`oa-notices.zip` | 下载到的通知书与缴费通知书样本 |

重跑前先登录并准备一组真实 `caseId` / `caseProcId` / `caseHandId`（见 [1-通用前置：认证与标识.md](../1-通用前置：认证与标识.md)）。

---

## 四、解析工具（`解析工具/`）

用于从贝思兰德前端资源里反解「写接口 → 结果形态 → 业务码 → 中文」。

| 脚本 | 作用 |
| --- | --- |
| `baseland_result_contract.py` | 重建 webpack 模块索引，按调用点解析码表别名 |
| `baseland_result_contract2.py` | 严格版：只在调用点所在模块内解析，避免跨模块误配 |
| `baseland_code_messages.py` | 枚举前端所有 `{Success: ...}` 码表 |
| `baseland_code_messages2.py` | **产出本附录的 `业务码中文对照.tsv`**：展开 `Object(spread)` 基表 + i18n key 转中文 |

依赖 `/tmp/modindex.json`（模块索引）与 `/tmp/locale_zh.json`（i18n 文案表），由前两个脚本生成；`ROOT` 指向仓库的 `baseland-reverse/`。

刷新流程见 [13-写操作-业务码与结果契约.md](../13-写操作-业务码与结果契约.md) 第八节。
