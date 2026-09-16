# 只读校验记录

目的：确认 `接入文档/` 里每一条只读 curl 都能照抄执行并得到文档描述的结果。全程只读，未调用任何写接口。

## 做法

1. `curl-cmds.json` —— 从 `接入文档/1-贝思兰德云API/` 的 1–6 章逐条抽出 curl 原文（35 条）；
2. `ro_verify.sh` —— 登录取 Token、取一组真实 `caseId`/`caseProcId`/`caseHandId`，然后**原样**执行这些 curl；
3. 结果按 `IsSuccess` / `Message` / 返回条数汇总。

## 结果

| 项 | 结果 |
| --- | --- |
| 文档中的 curl 总数 | 35 |
| 实际执行 | 33（2 条为取 Token 与写文件，未重复执行） |
| 与文档描述一致 | **33 / 33** |
| 写接口调用 | 0 |

执行方式、参数取值完全照抄文档。两处首轮不一致都是**取参数时没照文档的「来源」列**，按文档改正后即通过：

| 接口 | 首轮 | 照文档取参后 |
| --- | --- | --- |
| `CaseInfo/ProcCaculateNextYearLegalDate` | `参数错误`（误用 `CaseProcId`） | `IsSuccess=true`（文档已写明要用 `GetCaseDetailProcList` 的 `ProcId`） |
| `ApplyCase/GetLegalDate` | `参数验证失败`（`caseRelatedTypeId` 填了占位值） | `IsSuccess=true`（文档已写明来源是列表行的 `CaseRelationTypeId`） |

## 附带确认的返回形态

| 接口 | 实际返回 |
| --- | --- |
| `CaseInfo/GetPersonalCase` | `Data` 是**数组**（不是 `{ListData}`），本次待办 18 条 |
| `CaseInfo/GetPersonalProcStatistics` | `Data` 数组，5 条 |
| `CaseInfo/GetPersonalCaseSubTabStatisticsCount` | `Data` 数组，2 条 |
| `CaseInfo/GetCaseDetailProcList` | `Data` 数组，2 条；行内含 `CaseProcId` 与 `ProcId` |
| `CaseInfo/GetCaseProcFileList` | `Data` 数组，2 条；行内含 `FileNo` / `FileTypeName` / `NoticeName` |
| `CaseInfo/GetCaseHandFileList` | `Data` 数组（本次样例 0 条） |
| `CaseInfo/GetCaseFileAllList` | `Data.List`，1 条 |
| `CaseMonitor/GetCaseMonitoringListByCase` | `Data.ListData` + `Data.TotalCount` |
| `CaseInfo/GetClientListByCaseDetail` | `Data` 数组，10 条 |
| `CaseInfo/GetOfficialFormList` | `Data` 数组，15 条 |

> 待办案件的行内 `CaseHandId` 为空——与「只有存在递交实例的案件才有 `CaseHandId`」一致；涉及 `caseHandId` 的接口需从**递交中**页签取样。

## 文件

- `curl-cmds.json`   抽出的 curl 原文
- `ro_verify.sh`     校验入口（在装有凭据的主机上执行）
- `pick_ids.py`      取样例 ID
- `summarize.py`     结果汇总

## 案件文件删除权限实测（2026-09-14）

| 文件 | 内容 |
| --- | --- |
| `find_case_file.sh` | 按案号定位案件、读出案件级与流程级文件清单 |
| `diag_file_delete.sh` | 逐字段打印文件记录、跨案件对照 `IsCanDelete`、读 `OperateAuthority` |
| `file_center_check.sh` | 文件中心 `CaseFile/GetFileList`（表 20101）与 `GetFileCount` |
| `删除误传文件-2026-09-14.sh` | 带前置校验的删除脚本（校验 `CaseFileId`+文件名后调用，删后复核） |

**结论**：`GET /CaseInfo/DeleteFile` 在无权限时返回 `{"Data":"NotPermission","IsSuccess":true,"Code":0}` —— HTTP 200、`IsSuccess:true`，但文件**未删除**。详见 [13-写操作-业务码与结果契约.md](../../13-写操作-业务码与结果契约.md) §7.3。

## 增量与变更检测（2026-09-14）

| 文件 | 内容 |
| --- | --- |
| `probe_change_detect.sh` | 消息中心 / 案件新动态 / 操作日志 / 计数接口的可达性与返回 |
| `probe_incremental.sh` | `GetFileCount` 筛选能力、Count 与 List 一致性、排序参数、`PagedInfo` 形状 |
| `probe_free_signal.sh` | 案件行自带字段（`CaseProcFileTotalCount` 等）是否可当变更信号、三个聚合计数接口 |
| `probe_count_reconcile.sh` | `GetPersonalProcStatistics` 稳定性、与 `GetPersonalCaseCount` 口径对账 |
| `probe_latency.sh` | 各接口耗时与体积、`UserTableTitleColumnList` 是否生效、pageSize 影响、gzip 对比 |
| `probe_concurrency.sh` | 响应头（HTTP/2 + brotli）、串行 vs 并行 vs 20 路并发 |

**结论**：无推送通道；文件级变更用 `CaseFile/GetFileCount` + 增量筛选；案件级变更用 `CaseInfo/GetPersonalProcStatistics`（1 次请求 5 个数字）。详见 [14-只读-增量与变更检测.md](../../14-只读-增量与变更检测.md)。

## 递交状态终态与名字字段（2026-09-14，patent-agent 复审核对）

| 文件 | 内容 |
| --- | --- |
| `probe_current_terminal.sh` / `.out` | 按 patent-agent 自身的「当前流程」选择规则逐案复算：哪些案件每轮强制同步会去查官方递交状态、其中多少已是终态 |
| `probe_personal_name_fields.sh` / `.out` | `GetPersonalCase` 各页签行里 `CaseProcName` / `CaseProcNameInfo` 的实际取值 |
| `probe_history_name.sh` / `.out` | `GetCaseAllFlowHistoryInfo`、`GetCaseDetailProcList` 的名字字段对照 |

**结论（均为只读，账号 40 案 / 50 流程）**：

1. `GetPersonalCase` 五个页签的行里 **`CaseProcName` 一律为 `null`**，真名在 `CaseProcNameInfo.CaseProcName`（`waitHand` / `delivering` / `finish` 三个页签都验过）。只读顶层字段会得到空流程名。
2. 24 条流程有递交实例，`SendStatus` 分布为 `received` 15 条 / `draft` 9 条；15 条 `received` **全部**落在「已完成」页签（`ProcStatusCode=500`），9 条 `draft` 全部落在「递交中」页签（400）。
3. 按 patent-agent 的规则，40 个案件里 37 个能选出「当前流程」，其中 **22 个需要查官方递交状态**：13 个已是 `received`（终态）、9 个是 `draft`。即每轮强制核验有 13 次 `queryOfficial`（= 26 次 HTTP）查的是不会变化的结果。
4. `GetCaseAllFlowHistoryInfo` 顶层 `CaseProcName` 正常返回（`CaseProcNameInfo` 为 `null`），项目直读无问题；`GetCaseDetailProcList` 两处都有，且顶层带期次后缀（`答复审查意见(一)`）比 `CaseProcNameInfo` 更完整，`processRow` 优先取顶层是对的。

> 第 1 条只影响「只读顶层 `CaseProcName`」的写法；patent-agent 的 `processRow` 已按 `CaseProcName ?? CaseProcNameInfo.CaseProcName` 兜底，故不构成缺陷。

## 授权与获证检测（2026-09-14，按客户名「银生」定位到案）

| 文件 | 内容 |
| --- | --- |
| `probe_authorize.sh` / `.out` | 按客户名在五个页签定位案件，输出**案件行**、`GetUpdateCaseInfo.CaseInfo`、流程明细三处 |
| `probe_authorize2.sh` / `.out` | 自定义案件状态字典（56 条）、案件文件中心清单（20 个文件）、案件新动态类目计数 |
| `probe_authorize3.sh` / `.out` | 案件状态名解析（`NameLanguage[].Value`）与 `GetCaseNewTrendsDetailList` 请求体矩阵 |
| `probe_authorize4.sh` / `.out` | `ItemType` 13 类全集、窗口与订阅设置、授权/获证明细、期限类变体 |

**结论**（只读；样例案 `202606291-0096`，客户「四川银生供应链管理有限公司」）：

1. **能查到已授权**：`POST /NoPermissionRequired/GetCaseNewTrendsDetailList`（`ItemType=2` 授权专利(中国)）返回该案 1 条，`PostDate=2026-09-14`；`ItemType=8` 获证专利当时为 0 条。
2. **统计口径受订阅限制**：`GetCaseNewTrendsItemTypeDropDown` 有 13 类，而 `GetCaseNewTrendsStatisticsCount` 只回 11 类，差的两类（9 视撤、10 其他官文）正是 `GetCaseNewTrendsUserSetting.ItemTypeList` 未订阅的。
3. **案卷字段可能滞后**：同日 `GetUpdateCaseInfo.CaseInfo` 的 `AuthorizeDate` / `AuthorizePostDate` / `CertificateDate` / `CertificateNo` / `IssueDate` / `IssueNo` 全为 `null`，只有 `PublicDate=2026-07-17`、`PublicNo=CN 122414968 A`。
4. **列表行的同名键恒为 `null`**：`GetPersonalCase` 页签行里这些键存在但无值，不能用来判断授权。
5. **所内状态不自动跟随**：该案 `CaseStatusId` 解析为「一通回案实审」（字典 `Code=3`/`CodeName=审查中`），而字典里已有「待领证」；案件文件中心也没有授权通知书。

用法与参数陷阱见 [15-只读-授权与获证检测.md](../../15-只读-授权与获证检测.md)。

## 授权通知书链路（2026-09-14，同一案续查）

| 文件 | 内容 |
| --- | --- |
| `probe_notice.sh` / `.out` | 用动态行的 `NoticeId` 调 `GetNoticeById`；案件官文清单 `GetNoticeListByCaseId`（8 条） |
| `probe_notice2.sh` / `.out` | 办登官文全字段（`Notice` / `NoticeExtend` / `FileList` / `NoticeFeeList`）、文件下载校验、官文管理类接口权限、各官文类型码 |
| `probe_notice3.sh` / `.out` | 官文状态字典、流程名目录、个人流程状态字典、`CaseStatusType` 枚举 |

**结论**：

1. **授权类官文的名字是「办理登记手续通知书」**（`NoticeTypeCode=200602`），2026-09-14 到所；`NoticeNumber=10173760295294`、`NoticeExtend.FaWenXLH=2026091400182230`、**`NoticeExtend.DaFuRQ=2026-11-16`（办理/答复期限）**、`Volume=0293`、`NoticeFeeList` 带「年费 135.00 CNY」。
2. **附件可直接下载**：`GetNoticeById.FileList` 给 `FileNo`，经 `NoPermissionRequired/FileStorageGetFile?fileNo=…&forBlob=true` 取回 PDF（610,152 B，头 `%PDF-`）与 ZIP（589,996 B，头 `PK\x03\x04`）。
3. **官文状态 = 200「待导入」**（字典：99 无需导入 / 200 待导入 / 300 已导入 / 400 异常官文 / 500 未关联案件）。也就是说官文已进官文库、**尚未进案卷**——与「案件文件中心无此文件、案件流程无办登节点、`CaseInfo.AuthorizeDate` 等仍为空」一致。
4. **案件级官文清单可用**（8 条，含 `NoticeTypeCode`、`NoticeStatusName`、`IsRead`、`IsUserDownloaded`）；**全局官文管理列表无权限**：`GetNoticeList` / `GetNoticeListTabCount` / `GetNoticeListChildTabCount` 均 `无访问权限`，且 `TabCount` 返回**全零占位对象**并带 `IsSuccess=false`，不可当作「没有官文」。
5. `GET /SystemTypeSetting/GetCaseStatusType` 含**4 待领证 / 5 领证中**；该案 `CaseStatusType=3 审查中`，即所内办登起点尚未推进。`GetCaseProcStatusType` 为五个页签字典（0 待处理 / 200 核稿中 / 300 待递交 / 400 递交中 / 500 已完成）。
6. `GET /CaseProcProcess/GetCaseProcProcessDropdownList` 本账号返回**空数组**，未能取得流程名目录。
7. 官文下载只在远端 `/tmp` 校验文件头后**立即删除**，未保留客户文档；本轮全部为只读请求。

链路用法见 [15-只读-授权与获证检测.md](../../15-只读-授权与获证检测.md) 第三节，官文接口通用说明见 [5-只读-表单与通知书.md](../../5-只读-表单与通知书.md) §2.8。

## 「只要官方结果（授权/驳回）」可行性实测（2026-09-14）

| 文件 | 内容 |
| --- | --- |
| `probe_result.sh` / `.out` | 13 个 `ItemType` 的历史条数（365 天 vs 7 天）、窗口参数上限、驳回/授权明细、`ItemTypeList` 行为 |
| `probe_result2.sh` / `.out` | 交叉核对：动态里出现的案件，其官文清单是否仍在「待导入」 |
| `probe_noticetype.sh` / `.out` | `NoticeType/GetNoticeType` 与 `GetNoticeTypeCount` 均 `无访问权限`；`GetNoticeTypeDropDown` 可用 |
| `probe_noticetype2.sh` / `.out` | 官文类型字典全量 337 条，按结论分组（授权/证书/驳回/视撤/审查意见…） |

**结论**：

1. **授权可以只用 1 次请求拿到**：`ItemType=2`（授权专利(中国)）已在当前订阅列表里，`GetCaseNewTrendsStatisticsCount` 直接给条数，明细给案号/客户/`PostDate`/`NoticeId`。
2. **但案件新动态只有「近 7 天」**：明细传 `ReminderDuration` = 30/90/365/3650/36500 **均不生效**（`ItemType=2` 六个窗口同一结果）；本账号 47 天前的「驳回决定」、41 天前的「第一次审查意见通知书」都不出现在动态里。窗口只由 `GetCaseNewTrendsUserSetting.ReminderDuration`（默认 7）决定。
3. **驳回类目暂未验证**：`ItemType=5`（驳回专利(中国)）在 365 天口径下仍为 0（两件有驳回决定的案子都超窗），**没有窗口内样例**。
4. **不受窗口限制的做法是案件官文清单**：`GetNoticeListByCaseId` 实测列到 07-29 的「驳回决定」、06-30 的初审合格通知书；配合类型码判读（`200602` 办理登记手续＝授权办登、`400001~400003` 专利证书＝获证、`200305`/`210407`/`210408` 驳回决定）即可只看结果、不看文件。
5. **明细必须给单个 `ItemType`**：写成 `ItemTypeList:[2,5]` 或不给 → 返回 **0 行且不报错**（静默空集，易误判）。
6. 官文类型字典用 `GET /NoticeType/GetNoticeTypeDropDown`（337 条，含 `NoticeCode`/`label`/`ApplyTypeCode`）；`GetNoticeType` 与 `GetNoticeTypeCount` 本账号**无访问权限**。

## 官文清单的覆盖范围与案卷字段可靠性（2026-09-14）

| 文件 | 内容 |
| --- | --- |
| `probe_coverage.sh` / `.out` | 12 个跨月份案件的官文清单对照：条数、最早官文、是否含受理通知书 |
| `probe_coverage2.sh` / `.out` | 已走完「授权→获证」的两案（0737/0749）官文清单 vs 案卷字段；官文规则接口权限 |

**结论**：

1. **官文清单不是完整历史**：12 案抽样中 **7 案清单为空**（含 6 月立案 3 件、8 月新立案 4 件）；各案最早官文为 06-29 / 06-30 / 07-08 / 07-28；**12 案全部没有「专利申请受理通知书」(200101)**。清空的案子无法排除「其实有官方文件但没收录」。
   → 用官文清单判定**已有结果**（出现 `200602` 办登 / `40000x` 证书 / 驳回决定）可靠；用「清单里没有」判定**没有结果**不可靠。
2. **案卷字段彻底不可信**：`202606292-0737` 与 `-0749` 两件实用新型，官文清单已有 `200602 办理登记手续通知书`(08-17) 与 **`400002 实用新型专利证书`(09-08)**，而两案的 `CaseInfo` 中 `AuthorizeDate`/`CaseAuthorizePostDate`/`CertificateDate`/`CertificateNo`/`IssueDate`/`IssueNo` **全为空**，`CaseStatusType` 仍为 `3 审查中`、`IsFinishCase=false`。
3. **一并确认的四类官方结果实例**：授权办登 `200602`（银生案 09-14、0737/0749 08-17）、获证 `400002`（0737/0749 09-08）、驳回 `200305`（0880，08-27）与 `210407`（0181，07-29）。
4. **规则侧无权限**：`PatentNoticeRule/GetPatentNoticeRuleList`、`GetPatentNoticeRuleItemList` 均 `无访问权限`，无法从下载规则解释第 1 条的缺失；`NoticeType/GetNoticeTypeRequiredFieldTypeList` 返回空数组。

