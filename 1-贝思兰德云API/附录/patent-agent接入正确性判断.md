# patent-agent 贝思兰德接入正确性判断（v2 · 已按对方核查修正）

- 判断对象：`/Users/cyh/Documents/ChatGPT/patent-agent`（专利工作台 0.3.0，commit `121e303`）
- v1：2026-09-13 首轮只读审查 + 4 轮实测
- v2：2026-09-13 按对方核查意见复核，**修正 3 处自身误判、追加 5 项新发现**（新增 3 轮实测 probe5-8）
- 全程**未修改对方项目任何文件，未执行任何贝思兰德写接口**

---

## 〇、更正记录（我 v1 报告说错的地方）

### 更正 1：`MixFile:{fileNo,fileName}` 小写 — **原文疑点作废，项目写法正确**

官方上传组件 `app_latest.js`：

```js
u._fileInfo={fileNo:t.FileNo,fileName:r}, i.uploadSuccess(u);      // 分片上传走完
a={fileNo:t.fileList[0].FileNo,fileName:t.fileList[0].FileName}, t.uploadSuccess({_fileInfo:a});   // OSS 路径
...
t._fileInfo=e._fileInfo                                             // 上传成功回调保存
...
i={FileList:e,CaseHandId:...,IsUseXmlHand:...,MixFile:t._fileInfo}  // 传给 ModifyFormInstructionsAndImage
```

`_fileInfo` 就是 `{fileNo, fileName}` 小写驼峰。项目 `baseland-transfer.ts:125` 的写法和官方一致。**我的疑点是错的，撤回。**

### 更正 2：`IsNeedSendToOfficail` — **原文"被当成是否已递交"是误读，项目语义正确**

官方 `chunk-2eb54c96` 的 `isShowStartSend`：

```js
this.isSecondLastStep
  && !this.info.isPackageSendSuccess
  && (e===null || e===A['编辑'] || e===A['发送失败'])
  && this.info.isNeedSendToOfficail          // ← 「该流程是否需要递交官方」能力位
```

它是**和 `isPackageSendSuccess`/`SendStatus` 组合**使用的"是否需要递交官方"，不是"是否已递交"。项目的 `applySubmissionToCurrent()` 正是这个结构：先用 `isConfirmedOfficialSubmission(p.submission)`（来自 `IsPackageSendSuccess` + `GetCaseHandSendInfo.SendStatus`）判断是否已递交，**再**用 `needSendOfficial` 选文案。语义无误。**原报告的"缺陷 3"整条撤回。**

**关于"死代码"的说法也撤回**，并补上实测数据（probe5，全 5 页签 50 条流程全量采样）：

| `IsNeedSendToOfficail` | 条数 |
|---|---|
| `true` | 21 |
| 缺失（无递交实例 → `None`） | 29 |
| **`false`** | **0** |

分业务类型：`提出申请`/`答复审查意见`/`补正`/`请求复审` 有实例时为 `true`；`请求实审`/`请求提前公开`/`取消提出申请` 无递交实例 → 缺失。

→ `undefined` 分支**确证可达**（29 条），`invalid` 的 `===false` 分支**从未观测到**。正确表述是"未证可达"，不是"死代码"。

### 更正 3：Setting 的 `CaseName` / `HasConfirmCaseNameIsNotSame` — **原文"多余字段"错误，实为实质缺陷**

官方 `saveHandler(e,t,a)` 三参含义 = `(IsShowCaseName, formData, HasConfirmCaseNameIsNotSame)`：

```js
o = {
  CaseHandFormInstructionsAndImageSettingId: t.CaseHandFormInstructionsAndImageSettingId,
  CaseHandId: n.caseHandId,
  IsUseXmlFormatHand: t.IsUseXmlFormatHand,
  CaseName: e ? t.CaseName?.trim() : null,        // ← 条件传值：IsShowCaseName 为假时传 null
  HasConfirmCaseNameIsNotSame: a
};
s = t.CaseHandFormInstructionsAndImageSettingId ? Update(o) : Insert(o);
if("NeedConfirmCaseNameIsNotSame" === s){         // ← 业务码
  l = await $showConfirmMessageAsync('【说明书、说明书摘要、权利要求书与附图】的案件名称与系统案件名称不一致，确认继续保存吗？');
  if(l) return saveHandler(e, t, true);           // ← 用 HasConfirmCaseNameIsNotSame=true 重试
  return false;
}
return s;
```

调用点两处均为 `saveHandler(this.formData.IsShowCaseName, formData, false)`。

**实测**（probe6，真实可编辑实例）：`GetFormInstructionsAndImage` 返回
`IsShowCaseName=false`、`CaseName=null`、`IsUseXmlFormatHand=true`、`CaseHandFormInstructionsAndImageSettingId=null`。

→ 官方此时发 `CaseName: null`，项目发 `CaseName: setting.CaseName || input.caseTitle`（本地案件名）。
→ 且项目**完全没有 `NeedConfirmCaseNameIsNotSame` 分支**。

### 更正 4：**"回读失败不会脏写"不成立**，撤回

`saveRemoteTransfer()` 的回读点（`GetFormInstructionsAndImage` 比对、`GET_FORM[route]` 比对）都排在 `uploadDocument` / `UploadExistFileFormInstructionsAndImage` / `ModifyFormInstructionsAndImage` **之后**。回读失败只能阻止"继续执行"，无法证明此前的写请求没有在服务端留下变更。原报告这句话是过度推断。

### 更正 5：**"只读完全正确、可以放心用"过度概括**，收回

v1 只覆盖了：5 个页签与分页、项目读取的 358 个字段的存在性、30 个端点的 HTTP 方法与参数形状、递交状态机、流程节点字段、`ProcCode` 常数、五书卡片、期限口径。
**未覆盖**：超过 100 行的分页行为、`FileStorageGetFile` 在项目调用路径下的表现、错误/离线 UI、`caseInfo`/`caseClosure`（v2 已补测，见下）。
正确表述是"**已核对范围内一致**"，不是"完全正确"。

---

## 一、修正后的结论

| 层 | 修正后评价 |
|---|---|
| 协议映射（认证 / 信封 / 页签 / 分页参数 / HTTP 方法 30 项 / 参数形状 11 项 / 状态机 / 五书卡片 / 期限口径） | ✅ 在已核对范围内**一致**（样本：本账号个人案件 50 条、7 种业务类型） |
| 只读路径 | ✅ 已补测 `GetCaseProcById` / `GetUpdateCaseInfo` / token 失效，**结论正确**；仍有未覆盖面 |
| 写路径 | ⚠️ 结构对齐，但**业务码处理整体缺失**，其中 1 个端点**无任何回读兜底**；另 3 处细节待真实验证 |

**明确缺陷 5 条**（原 4 条中 2 条撤回、1 条改判，新增 2 条）：

| # | 缺陷 | 性质 | 证据 |
|---|---|---|---|
| 1 | `取消提出申请` 被 `/提出申请|撰写/` 误判为 `write` | 业务分类错误 | 实测该流程 `ProcCode=0` 存在（probe3） |
| 2 | `HandInfo?.SendStatus` 字段不存在，该守卫无效 | 假保护 | 实测 `HandInfo` 9 键无 `SendStatus`（probe1/3） |
| 3 | `identity().organization` 恒为空 | 显示缺陷 | 实测两个身份接口都无机构名字段（probe4） |
| 4 | **业务码（`Data.Result`）完全未处理**，`Insert/UpdateFormInstructionsAndImageSetting` 无回读兜底 | **静默不生效** | 官方码表 + `isSuccess` 定义（见三·1） |
| 5 | `CaseName` 未按 `IsShowCaseName` 条件传值 | 参数偏差 | 实测 `IsShowCaseName=false`（probe6） |

---

## 二、v2 新增的验证通过项

### 2.1 Token 失效形态（probe7 · 已判定项目正确）

用伪造/空 token 只读调用：

```
Authorization: 'bogus-token-123'  →  HTTP 200  {"IsSuccess":false,"Code":401,"Message":"无效的Token"}
Authorization: ''                 →  HTTP 200  {"IsSuccess":false,"Code":401,"Message":"Token值为空"}
```

**Token 失效不是 HTTP 401，而是 HTTP 200 + body `Code:401`。**

项目 `request()` 的 `response.status===401||403` 分支实际永不触发，但 `data.IsSuccess!==true` 后的正则 `/登录|Token|token|认证|过期/` **命中 `Token`** → 抛「登录已失效，请重新登录。」✅ **结论正确**（虽然保护机制与代码假设不同）。

补充：`Auth/GetToken` 的 `Data` 含
`{ForbidLoginMinute, IsLoginAs, License, LoginByUserId, Result, ResultString, SsoResult, Token, WorkWechatResult}`，
其中 `License = {IsValid:true, ExpirationDate:null, UntilExpirationDays:0, IsExpireWithin1Month:false, IsNoLimit:true}`。
→ 这是**现成的授权到期预警源**，项目未使用（本账号 `IsNoLimit:true`，暂无影响）。

### 2.2 `GetCaseProcById` 的备注字段（probe6 · 判定项目正确）

`Data.CaseProc`（50 个键）含 `OfficeNote`（实测值 `'第一次审查意见通知书；；'`）、`ProcNote`，**不含** `FlowRemark`。

而个人列表行用的是 `CaseProcOfficeNote` / `CaseProcProcNote`。

项目对**两个来源用了两套字段名**：

```js
// processRow()：读列表行
[['FlowRemark','flowRemark'],['CaseProcOfficeNote','officeNote'],['CaseProcProcNote','procNote']]
// caseInfo()：读 GetCaseProcById
[['FlowRemark','flowRemark'],['OfficeNote','officeNote'],['ProcNote','procNote']]
```

两边都正确 ✅。这一点项目做得比我 v1 报告描述的更细致（`FlowRemark` 被 `.filter(field in r)` 自动剔除，不会写入脏值）。

### 2.3 `GetUpdateCaseInfo`（probe6 · 项目正确，但守卫是空的）

`Data.CaseInfo.Remark = ''` ✅ 存在；`Data.CaseInfo.IsFinishCase = false` ✅ 存在；
但 `CaseInfo.CaseId` **不存在** → 项目的一致性守卫 `if(info.CaseId && clean(info.CaseId)!==c.remote.caseId) throw` **恒不触发**（无害，等于没有该校验；真正的 `CaseId` 在 `Data.CaseId` 层）。

### 2.4 分页（probe7/8 · 结论收窄但更可靠）

**`GetPersonalCaseCount` 存在且可用（POST，与 `GetPersonalCase` 同一 body）**：

| 页签 | Count 接口 | 列表实际行数 |
|---|---|---|
| waitHand | 18 | 18 |
| auditing | 0 | 0 |
| waitDeliver | 0 | 0 |
| delivering | 7 | 7 |
| finish | 25 | 25 |

**逐一对上** → 这是安全的数量校验源。

另外：`ProcStatusTypeList:[0,200,300,400,500]` + `pageSize:1000` 与 `pageSize:100` 均返回 50 行 → 服务端接受 `pageSize ≥ 50`，项目用 100 目前安全。

但项目的终止条件是 `if(list.length < 100 || Number.isFinite(total) && page*100 >= total) break`，而 `GetPersonalCase` 顶层**不存在** `Total/TotalCount/RecordCount`（实测为空）→ `Number.isFinite(total)` 恒 `false`，**实际只靠"返回少于 100 就停"**。若某天某页签超过服务端 pageSize 上限，会**静默截断**。

建议（低成本、已验证可行）：并列调用 `GetPersonalCaseCount`，用 `rows.length === count` 作为完成判据；不等则继续翻页或报错。

### 2.5 `GetPersonalCaseSubTabStatisticsCount`（顺带发现）

`GET /CaseInfo/GetPersonalCaseSubTabStatisticsCount?caseProcStatusType=400` 返回按 `ProcId` 的计数（`[{ProcId, ProcName, ProcCount}]`），是**业务类型维度**的计数，不是总数。项目未使用，无影响。

---

## 三、v2 新增的两条实质缺陷

### 3.1 业务码（`Data.Result`）整体未被处理 —— 本轮最重要的发现

**官方契约**（`app_latest.js` 响应拦截器，模块 `56d7`）：

```js
if(t.IsSuccess){
  if(t.Data?.Result || t.Data?.ResultType){
    var i = t.Data.Result ? "Result" : "ResultType";
    return Object(T["a"])(t.Data, i);      // T = n("c034")，映射后返回业务码
  }
  return t.Data;
}
return R(e);                                 // IsSuccess=false → 走错误分支
```

**业务码判定**（模块 `2e47` → `P`，挂到 Vue 原型 `prototype.isSuccess = Ct`）：

```js
function P(e){ var t = arguments.length>0&&void 0!==arguments[0]?arguments[0]:""; return "success"===e?.toLowerCase(); }
```

即：只有字面 `"success"`（忽略大小写）算成功，**`isSuccess(undefined)` 也是 `false`**。

**官方前端对项目用到的每个写接口都逐个检查业务码，且各有码表**：

| 端点 | 官方检查写法 |
|---|---|
| `SubmitHandFlow` | `I=N.Result; t.isSuccess(I)? … : push(error)` |
| `AddCaseHandForm` | `t.isSuccess(r) || (t.$warn(d["h"][r]), 回滚勾选)` |
| `DeleteFormFile` | `n=t.t0; $showInfoMessage(d["q"][n], …); isSuccess(n)? … : …` |
| `InsertFromPatentRequestInfo` / `UpdateFormPatentRequestInfo` | `n=t.t1; $showInfoMessage(d["D"][n], ()=>{isSuccess(n)&&…})` |
| `StartHand` | `isSuccess(r) \|\| "AlreadyStarted"===r`（`"NeedConfirmReStart"` 另有分支） |
| `Insert/UpdateFormInstructionsAndImageSetting` | `"NeedConfirmCaseNameIsNotSame"!==s`（裸字符串比较） |

**项目 `request()` 只看 `IsSuccess`，从不看业务码，返回值一律丢弃。**

逐个核对"丢弃业务码之后有没有兜底"：

| 端点 | 检查业务码 | 回读兜底 | 结果 |
|---|---|---|---|
| `StartHand` | ✗ | ✓ `readRemoteTransfer` 必须返回非 null | 安全 |
| `AddCaseHandForm` | ✗ | △ 事前 `IsHasCaseHandForm`，事后无 | 部分 |
| `ModifyFormInstructionsAndImage` | ✗ | ✓ 重读比对五书与混合文件 | 安全 |
| `DeleteFormFile` / `DeleteFormInstructionsAndImageMixFile` | ✗ | ✓ 重读比对 | 安全 |
| `UploadExistFileFormInstructionsAndImage` | ✗ | ✓ 要求解析出所选部分 | 安全 |
| **`Insert/UpdateFormInstructionsAndImageSetting`** | ✗ | **✗ 无任何回读** | **静默不生效** |
| `Insert/UpdateFormOpinionStatement/FormCorrection/FormPatentRequestInfo` | ✗ | ✓ 专用接口回读 + `includesValues` | 安全 |
| `SubmitHandFlow` | ✗ | ✓ `GetHandInfo` 回读节点与处理人 | 安全 |
| `FileStorageUploadFile` | ✗ | ✓ 要求 `Data.FileNo` | 安全 |

→ **唯一完全没有兜底的端点**恰好就是 `NeedConfirmCaseNameIsNotSame` 所在的 `Insert/UpdateFormInstructionsAndImageSetting`。

> ⚠️ **收紧 1（接受对方核查意见）**：不能说"其余点安全"。准确表述是——**在被比较的字段这个范围内**其余端点有回读；回读通过只证明**被比较的那几个字段**符合预期，不等于服务端状态正确。已核对源码的两个反例：
> - `AddCaseHandForm` 只在事前查 `IsHasCaseHandForm`，**事后没有重新校验选中状态**（官方会 `t.isSuccess(r) || (warn + 回滚勾选)`）；
> - `submitRemoteTransfer` 回读比较的是 `handId`、`CurrentFlowInfo.FlowNodeName`、`FlowUserName` —— **节点名与姓名**，不等价于核验**节点 ID 与接收人 ID**。而实测 `GetHandInfo.CurrentFlowInfo` 同时提供 `CaseHandStepId` 与 `FlowUserId`，`GetHandNextFlowUserByStepId` 返回项里也有 `value`（用户 ID），项目**本可用 ID 比较**，比姓名严格。
>
> 其余端点在业务码失败时不会静默错状态，但**报错文案会误导**：真实原因是"案件名称不一致需确认"，用户看到的是「五书回读与本次文件或勾选不一致」。

> ⚠️ **收紧 2（接受对方核查意见）**：不能机械要求所有写接口都判 `Data.Result === 'Success'`。**每个端点有自己的码表，允许的结果不止 `Success`**（已从官方前端提取到 60 张码表）。例如 `StartHand` 明确把 `AlreadyStarted` 当成功、`NeedConfirmReStart` 走确认分支；`Insert/UpdateFormInstructionsAndImageSetting` 的码表是 `{Success, ExistSetting, CannotFoundSetting, MustCheckIsUseXmlFormatHand}`。修复必须按端点分「成功 / 待确认 / 失败」三类处理，并回读服务端状态。

### 3.1.1 拦截器解包形态已定死（v3 更新，原"诚实说明"已闭环）

模块 `c034` 的键在压缩后是**无引号形式** `c034:function`，我原来的 `"c034":function` 搜法漏掉了。已重新拉取当前 `app.b16037655860f0e73a8f.js` 并解出：

```js
n.d(t,"a",(function(){return ge}))
function ge(e, t){ t = arguments.length>1 && arguments[1]!==undefined ? arguments[1] : "Result";
                  return e[t] && (e["is".concat(e[t])] = true), e }
```

即拦截器 `Object(T["a"])(t.Data, i)` **返回 `Data` 本身**，只是额外注入 `Data["is<Code>"] = true`。

因此**两种返回形态并存，且都能自洽解释前端调用点**：

| 服务端返回 | 拦截器返回 | 前端典型用法 |
|---|---|---|
| `Data = "XXX"`（裸字符串） | 该字符串 | `isSuccess(r)`、`码表[r]`、`"NeedConfirmCaseNameIsNotSame"!==s` |
| `Data = {Result:"XXX", ...}` | `Data` 对象（注入 `isXXX`） | `I = N.Result; isSuccess(I)`；或直接读注入标志 `t.isNeedConfirmInventor` |

**推论（可直接用于修复）**：`saveHandler` 里是 `"NeedConfirmCaseNameIsNotSame" !== s` 的**裸字符串比较**，说明该码必须以**字符串形态**放在 `Data` 上返回。而项目的 `request()` 对 `kind='data'` 返回的正是 `data.Data` —— 也就是**这个字符串会被原样返回、然后被丢弃**。协议层因此完全坐实："设置未保存且无任何提示"。

### 3.2 `CaseName` 未按 `IsShowCaseName` 条件传值

见「更正 3」。官方：`CaseName: IsShowCaseName ? CaseName.trim() : null`；实测 `IsShowCaseName=false`；项目恒发本地案件名。配合 3.1 的"无回读"，这条会与名称确认缺陷叠加。

---

## 四、仍待真实验证（3 条，写路径）

| # | 端点 | 疑点 | 现状 |
|---|---|---|---|
| 1 | `POST/GET /CaseInfo/StartHand` | 官方包装器 6 参 `{caseProcId, isSubmitToLastSecondStep, nextDeptStepId, nextFlowUserId, submitRemark, ignorePermit}`，项目只传 `{caseProcId}`；官方调用点见过 `(caseProcId,true,null,null,'预审完成自动提交',true)` 与 `(caseProcId)` 两种 | 保留待验证。是**第一道写操作**，失败会挡住整条链路（好在 `if(!s.remote) throw` 是 fail-loud） |
| 2 | `POST /NoPermissionRequired/FileStorageUploadFile?1=1` | 官方 el-upload 把 token 拼成 **query** `&Authorization=<token>`，项目用**请求头**。该路径不在我抽出的 6301 条清单里（前端字符串拼接、非包装器调用），**从未实测** | 同目录 `FileStorageGetFile` 用请求头实测可通，**大概率可用**，但仍需 dry-run |
| 3 | `Insert/UpdateFormInstructionsAndImageSetting` 重试链路 | 缺少 `NeedConfirmCaseNameIsNotSame` → 确认 → `HasConfirmCaseNameIsNotSame:true` 重试；且重试要用 `hasConfirm=true` 重走一遍 | 未实测 |

---

## 五、修复优先级建议（对回复意见的回应）

**v3 定稿：同意对方的顺序。** 分页完整性提到机构名称之前，我补一条更硬的理由——

> **分页静默截断 = 案件直接不上班（漏案）**，与"机构名显示为空"不是一个量级。

最终顺序：

1. **写接口业务结果处理 + `Insert/UpdateFormInstructionsAndImageSetting` 条件传值、人工确认、回读**
   （`CaseName` 按 `IsShowCaseName` 传值；收到 `NeedConfirmCaseNameIsNotSame` 弹人工确认，**确认后才**用 `HasConfirmCaseNameIsNotSame:true` 重试；重试后回读 CaseName 与 `IsUseXmlFormatHand`。按端点分「成功 / 待确认 / 失败」三类，不搞 `=== 'Success'` 一刀切。）
2. `取消提出申请` 分类（`/取消提出申请/` 先行排除，或改用 `ProcCode` 判定）
3. `readRemoteTransfer` 的已递交判定改为读 `GetCaseHandSendInfo.SendStatus`（`HandInfo.SendStatus` 不存在）
4. **分页完整性**：并入 `GetPersonalCaseCount` 做 `rows.length === count` 校验（已验证五页签逐一对上）
5. `identity().organization`
6. 可选加固：`submitRemoteTransfer` 回读改比 `CaseHandStepId` / `FlowUserId`（ID 比姓名严格）；`AddCaseHandForm` 事后补一次 `IsHasCaseHandForm` 复核

另两条同意对方：`MixFile` 小写**保持现状不改**；名称不一致**绝不能自动置 `HasConfirmCaseNameIsNotSame:true`**，必须人工确认后才重试。

---

## 六、判断汇总（v2）

| 项 | 结论 |
|---|---|
| 认证 / 请求头 / 信封判定 | ✅ 一致 |
| Token 失效处理 | ✅ 结论正确（机制与代码假设不同） |
| 5 页签 + 分页参数 | ✅ 一致；终止条件缺数量校验 |
| HTTP 方法 30 项 | ✅ 30/30 |
| 参数形状 11 项 | ✅ 全部一致 |
| 递交状态机 0/1/2/3/6/100 | ✅ 与实测字典逐字一致 |
| 流程节点字段 | ✅ 正确（缺字段已正确回退） |
| `GetCaseProcById` / `GetUpdateCaseInfo` 字段 | ✅ 正确（`CaseId` 守卫是空的） |
| `ProcCode`（提出申请=105） | ✅ 正确 |
| 五书虚拟卡 `000000` | ✅ 与官方前端逻辑等价 |
| 期限口径 | ✅ **正确**（未把贝思兰德日期当官方期限） |
| `MixFile` 小写 | ✅ **正确**（v1 疑点作废） |
| `IsNeedSendToOfficail` 用法 | ✅ **正确**（v1 缺陷 3 撤回） |
| 凭据落盘 | ✅ 只存 token 且加密 |
| **业务码（`Data.Result`）** | ❌ **完全未处理**，1 个端点无兜底 → 静默不生效 |
| `CaseName` 条件传值 | ❌ 未按 `IsShowCaseName` |
| `HandInfo.SendStatus` 守卫 | ❌ 字段不存在，守卫无效 |
| `identity().organization` | ❌ 已测账号与响应结构下恒为空 |
| `取消提出申请` 分类 | ❌ 误判为 `write` |
| `StartHand` 参数完整性 / 上传接口认证 / 名称确认重试 | ⚠️ 待真实验证 |

**一句话**：协议映射在已核对范围内一致，`MixFile` 与 `IsNeedSendToOfficail` 两处我 v1 判错了；但**"业务码未处理 + Setting 无回读"是本轮唯一会静默不生效的缺陷，应优先于回复意见中列的前三项修复**。

---

## 附：证据文件

| 文件 | 内容 |
|---|---|
| `实测证据/pa_judge_probe.sh` | 分页与递交实例字段 |
| `实测证据/pa_judge_probe2.sh` / `.out` | 分页行为、个人列表 358 字段核对、3 个 fileType 卡片 |
| `实测证据/pa_judge_probe3.sh` / `.out` | `CaseProcOperateInfo` 全键、`ProcCode` 常数表、`GetHandNextFlowList`、`formCode=000000`、递交状态字典 |
| `实测证据/pa_judge_probe4.sh` / `.out` | `GetLoginInfo`/`GetCurrentUserInfo` 实际返回、`GetCaseDetailProcList` 原样 body、`GetCaseAllFlowHistoryInfo` |
| `实测证据/pa_judge_probe5.sh` / `.out` | **`IsNeedSendToOfficail` 全 50 条采样（21 true / 29 缺失 / 0 false）** |
| `实测证据/pa_judge_probe6.sh` / `.out` | `GetCaseProcById` 与 `GetUpdateCaseInfo` 字段名、`IsShowCaseName=false` |
| `实测证据/pa_judge_probe7.sh` / `.out` | **token 失效形态**、`GetToken` 的 `License`、分页跨状态行为 |
| `实测证据/pa_judge_probe8.out` | **`GetPersonalCaseCount` 与列表行数逐一对上** |
| `实测证据/pa_judge_probe9.sh` / `.out` | **同步覆盖范围：视图 A（5 页签 50 条）vs 视图 B（6 页签 19 条），差集 0** |

前端对照源：`baseland-reverse/app_latest.js`（拦截器、`isSuccess`、`_fileInfo`）、`baseland-reverse/_chunks/`（**773 个 chunk 全量已补齐**；`chunk-2eb54c96...js` 的 `saveHandler`/`isShowStartSend`/`loadTabFileTypeData`、`chunk-244055f8...js` 的页签定义、`chunk-2d0b9df7...js` 的 API 包装器 30 项、`chunk-080c8887...js` 的 Setting 码表）、`app.b16037655860f0e73a8f.js`（模块 `c034` 的定义所在）。

全部为**只读**调用，**未触发任何写接口、未向官方网关发送任何请求**，未修改 `patent-agent` 项目任何文件。

---

## 七、v3 补充：本轮新闭环项与"仍未查明白"清单

### 7.1 本轮新闭环（3 项）

**① 同步覆盖范围：无漏案 ✅**

系统里其实有**两套「我的案件」视图**，项目只用了第一套：

| | 视图 A（项目使用） | 视图 B（项目未用） |
|---|---|---|
| 端点 | `GetPersonalCase` | `GetCaseHandInfoListOfStart/Pending/WaitSend/Processing/EntrustCase/Finish`（+ 各配套 `GetCaseHandInfoCountOf*`） |
| TableType | 50010 / 50011 / 50012 / 50013 / 50014 | 40010 / 40011(40012) / 40016(40017) / 40013 / 40014 / 40015 |
| 页签 | waitHand / auditing / waitDeliver / delivering / finish | waitStartAudit / waitAudit / wait2Official / auditing / auditingThirdParty / finishAudit |
| 分页 | `PagedInfo` | `PageInfo` |

实测（probe9）：视图 A 去重 50 条 `CaseProcId`，视图 B（`IsWorkAgent:true`）去重 19 条，**仅在 B 而不在 A 的 = 0**。
→ 视图 B 是"有递交实例的那部分"，天然是子集。**项目按视图 A 同步没有漏案。**

**② 拦截器解包形态：已定死 ✅**（见 3.1.1）

**③ Setting 接口的业务码全集：已定死 ✅**

官方码表（`chunk-080c8887` 的 `J` 表）：

```js
J = { Success:i,
      ExistSetting:"r20210629172543240897",
      CannotFoundSetting:"r20210629172623152087",
      MustCheckIsUseXmlFormatHand:"r20260721103044790620" }
```

- **`NeedConfirmCaseNameIsNotSame` 不在任何码表里** → 它是 `saveHandler` 里 ad hoc 处理的返回，形态是**裸字符串**（与 ② 的推论一致）。
- 附带确认项目的两个判断**恰好是对的**：用 `CaseHandFormInstructionsAndImageSettingId` 决定 Insert/Update，正是 `ExistSetting`/`CannotFoundSetting` 的正确判别依据；硬编码 `IsUseXmlFormatHand:true` 正好满足 `MustCheckIsUseXmlFormatHand` 的前置要求。这两个码正常情况下不会触发。

### 7.2 仍未查明白（按对修复的阻塞程度排序）

| # | 未明事项 | 阻塞什么 | 能否本地解决 |
|---|---|---|---|
| 1 | **每个写接口 ↔ 码表的精确绑定**：已提取 **60 张码表**，但把 `d["q"]` / `d["h"]` 这类 webpack 模块别名精确解析到具体端点，需要重建跨 chunk 的模块导入图。目前只确定了 Setting 一张 | 决定每个端点要处理哪些码 | 可以（纯本地解析，工作量中等） |
| 2 | **`StartHand` 的真实必填参数**：官方包装器 6 参，项目传 1 参；官方调用点见过传 1 参与传 6 参两种 | 第一道写操作能否成功 | **不能**，必须真写一次 |
| 3 | **`FileStorageUploadFile` 的认证方式**：官方 el-upload 用 query `&Authorization=`，项目用请求头 | 上传路线能否走通 | **不能**，必须真写一次 |
| 4 | **`NeedConfirmCaseNameIsNotSame` 的真实触发条件与返回形态**：什么条件下服务端返回（上传的申请原文解析名 ≠ 系统案件名？）、返回后重试是否真的落库 | 名称确认分支的完整性 | **不能**，必须真写一次 |
| 5 | **服务端 `pageSize` 上限**：实测 `pageSize≥50` 被接受（跨状态一次取回 50 条），但上限值本身无法用当前数据（最多 25 行的页签）探出 | 分页截断风险的量化 | **不能**，需数据量增长后复测 |
| 6 | **期限近似的影响面未量化**：贝思兰德 `CaseProcLegalDate` 不做工作日顺延（已验证一例：`2026-08-29`(周六) vs 官方 `yuqirq 2026-08-31`(周一)，差 2 天），项目的"已超期"卡片与提示基于该日期 → 可能**比官方口径提前**判超期。早期笔记里另有一例差 20 天，但**方向与成因未重新验证，不引用** | "已超期"展示的准确度 | 部分（需 CPC 客户端隧道比对更多样本） |
| 7 | **写路径整体真实验收**（双方共识未完成）：所有写接口的真实行为，以及 `GetCaseProcFileList → FileStorageGetFile` 在项目调用路径下的附件下载 | 上线前验收 | **不能**，必须真写 |

### 7.3 结论

除上表 7 项外，**其余事项本轮已查清**。其中第 1 项可纯本地解决（重建模块导入图即可列出每个端点的码全集）；第 2～4、7 项属于**只能靠真实写入验收**的，任何静态分析都无法替代；第 5、6 项受当前数据量与工具链限制。

---

## 八、v4：写接口结果合约已解出（原第 7.2 节第 1 项已闭环）

工具：`解析工具/baseland_result_contract.py`（含 `_contract2.py` 严格版）。方法：重建 webpack 模块索引（4202 个十六进制模块键，覆盖 app 主包 + 773 个 chunk），在**调用点所在模块内**解析码表别名，再经 `n.d(t,"<字母>",…return VAR)` 取到真实码表变量；对 `Object(spread)` 合成表用「到顶层逗号为止」的括号配对还原。

### 8.1 每个写接口的结果形态与业务码

| 端点 | **返回形态** | 业务码（源码确认） | 项目现状 |
|---|---|---|---|
| `StartHand` | **裸字符串** | 12 项：`Success, AlreadyStarted, CannotFoundFlow, CannotFoundCaseProc, NotUndertaker, NotPendingHand, NotReviewDraft, NotFinishedHand, NeedConfirmReStart, Handing, IsDraftReviewing, Auditing`。其中 **`AlreadyStarted` 视为成功**、**`NeedConfirmReStart` 走确认分支**（前端 `t.isSuccess(r)\|\|"AlreadyStarted"===r`） | 丢弃 |
| `AddCaseHandForm` | **裸字符串** | `Success, ExistsForm, NotExistsForm, NoAuthority` | 丢弃（事后无校验） |
| `DeleteFormFile` | **裸字符串** | 基表 + 9 个文件/表单码：`FileNull, UploadTypeNotSupported, InvalidFileFormat, ParagraphEndSpaceOverLong, ImageNonConformance, VerifyPdfImageError, OtherProveFileIsPartOfOptionStatement, OtherProveFileIsPartOfOptionStatementForNotNormalApply, ProveFileIsPartOfReviewInvalidOpinionStatement` | 丢弃（有重读兜底） |
| `Insert/UpdateFormPatentRequestInfo` | **裸字符串** | 基表 + 6 项：`DivisionalCaseNull, IsPublicAdvanceNull, NotChecked, NotChecked1, InventHasSameDayApply, UtilityHasSameDayApply` | 丢弃（有回读兜底） |
| **`SubmitHandFlow`** | **对象**（`Data.Result`，与其余端点不同！） | **31 项**：`Success, NotPermission, AlreadyFinished, NotStartedFlow, CannotFoundNextFlow, CannotFoundBackHistory, CannotFoundBackSelf, FlowUserInvalid, NoPassVerifyBeforeCaseHand, NoPassVerifyBeforeSubmit, Handing, IsInEntrusting, IsPacking, IsSending, NeedConfirmForRepack, NeedRePack, NotPack, NotPackSuccess, NotSendSuccess, CannotBatchSubmit, CannotBackForSendSuccess, CannotBackForSending, CannotBackForWaitSend, NeedRePackForApplicantChange, NeedRePackForInventorChange, NeedRePackForCaseChange, NeedRepackForFormChanged, DescItemChangeDeclareNeedAgencyApplyType, DescItemChangeDeclareNeedApplicantApplyType, OtherCountryNoHandFile, NoAuthority` | 丢弃（有回读兜底） |
| `Insert/UpdateFormInstructionsAndImageSetting` | **裸字符串** | **已发现的码表**：`Success, ExistSetting, CannotFoundSetting, MustCheckIsUseXmlFormatHand`；**另有不在码表内的特殊分支 `NeedConfirmCaseNameIsNotSame`**（ad hoc 处理） | 丢弃，且**无回读** |

**对修复直接有用的三条结论：**

1. **`SubmitHandFlow` 是唯一返回对象形态（`Data.Result`）的端点**，其余都是裸字符串。所以取值要写成 `typeof r === 'string' ? r : r?.Result`。
2. **允许的结果不止 `Success`** —— `StartHand` 的 `AlreadyStarted` 必须当成功，`NeedConfirmReStart` 必须走确认；`SubmitHandFlow` 的 `NeedConfirmForRepack/NeedRePack*/NotPack*` 属于"需重新打包"而不是失败。
3. `ExistSetting` / `CannotFoundSetting` **在并发修改或快照过期时仍可能触发**（按设置 ID 选择 Insert/Update 只是正常路径），这两码必须处理。

### 8.2 接受的四处收紧（本轮修正）

| # | 对方意见 | 我的处理 |
|---|---|---|
| 1 | "无漏案"只能限定本次样本（比的是 50 vs 19 个**流程**、B 限定 `IsWorkAgent=true`、各页签只取第一页、未调 Count 校验） | **接受**。报告表述已改为"**本账号、本次查询条件下**，视图 B 已返回的流程全部包含在视图 A 中"；不再推断"B 永远是 A 的子集"或"同步整体无遗漏" |
| 2 | 拦截器行为已查清 ≠ Setting 实际响应已证明 | **接受**。源码只证明拦截器保留 `Data` 形态、调用点证明前端**预期**确认码是裸字符串；真实原始响应仍需真写取证。**但项目丢弃结果、漏验 Setting 的缺陷不依赖该取证即成立** |
| 3 | Setting 码表不是服务端返回值"全集" | **接受**。已改称"**已发现的码表及特殊分支**"；并补上 `ExistSetting`/`CannotFoundSetting` 的并发/过期触发场景 |
| 4 | 分页上限未知不必阻塞完整性修复 | **接受**。修复改为：**同一筛选条件下核对 Count → 检查重复流程 → 检查翻页无进展**；计数变化或不一致时**明确标记未完成并重新核对**，不再以"先测出上限"为前提 |

### 8.3 定稿优先级（转交 ID 核验升级进第一批）

1. **写接口业务结果处理 + `Insert/UpdateFormInstructionsAndImageSetting`**（条件传值 / 人工确认 / 回读；按端点分「成功 / 待确认 / 失败」，`SubmitHandFlow` 记得取 `Data.Result`）
2. **转交按节点 ID、用户 ID 核验**（`CurrentFlowInfo.CaseHandStepId` + `FlowUserId` ↔ `GetHandNextFlowUserByStepId` 的 `value`）—— 由"可选加固"**升为第一批** ✅
3. `取消提出申请` 分类
4. 发送状态保护数据来源（改读 `GetCaseHandSendInfo.SendStatus`）
5. 分页完整性（Count 核对 + 重复/无进展检测，按 8.2-4 的宽松前提实施）
6. `identity().organization`
7. 可选：`AddCaseHandForm` 事后补一次 `IsHasCaseHandForm` 复核

`MixFile` 保持现状；名称不一致**必须由用户明确确认**，绝不自动置 `true`。

---

## 九、v4 附：对"实施中的修复"的只读核对

> ⚠️ 说明：核对报告时发现 `patent-agent` 工作区**已不再是干净的**（9 个文件改动 + 新文件 `desktop/baseland-results.ts`）。**这不是本会话的改动**——本会话对该项目全程只读。看内容应是在按前几轮结论实施修复。以下为只读核对结果（未修改任何文件）。

### 9.1 已实现且方向正确（逐项对照）

| 前几轮结论 | 实施情况 |
|---|---|
| 业务码未处理（最高优先级） | ✅ 新增 `desktop/baseland-results.ts`：`businessCode()` 同时处理**裸字符串**与 `Data.Result`/`Data.ResultType`**两种形态**；`assertWriteResult()` 对 15 个写接口 fail-closed（未登记直接抛错） |
| `SubmitHandFlow` 返回对象形态 | ✅ `businessCode()` 已覆盖 `Result`/`ResultType` |
| `StartHand` 的 `AlreadyStarted` 视为成功 | ✅ `ep==='StartHand' && code==='AlreadyStarted'` 直接放行 |
| `NeedConfirmCaseNameIsNotSame` 人工确认后重试 | ✅ 弹窗确认 → 确认期间比对 fingerprint → 用 `HasConfirmCaseNameIsNotSame:true` 重试 → `assertWriteResult` |
| `CaseName` 按 `IsShowCaseName` 条件传值 | ✅ `showName?String(setting.CaseName??'').trim():null` |
| Setting 缺回读 | ✅ 回读 `IsUseXmlFormatHand` / `CaseHandFormInstructionsAndImageSettingId` / `CaseName` |
| `HandInfo.SendStatus` 不存在（假保护） | ✅ 改为 `GetCaseHandSendInfo` + `combineOfficialSubmission`，未知状态直接拒绝整理 |
| 转交按节点 ID、用户 ID 核验 | ✅ 改为 `CurrentFlowInfo.CaseHandStepId` + `FlowUserId`（`reparepare` 路径同步改） |
| `AddCaseHandForm` 事后无校验 | ✅ `ensure()` 补一次 `IsHasCaseHandForm` 复核 |
| 分页无数量校验 | ✅ 改为前后各调一次 `GetPersonalCaseCount`、去重、`pageRows.length===expected`、不一致则**标记未完成**并保留本地数据（正是 8.2-4 的宽松前提方案） |
| `取消提出申请` 误判 | ✅ `if(/^取消提出申请(?:$|[（(\s])/.test(name.trim()))return undefined;` |
| `identity().organization` 恒空 | ✅ UI 改为显示「未取得机构名称」 |

### 9.2 发现一处缺口：`SubmitHandFlow` 的非失败码被统一归为"失败/待核验"

`assertWriteResult` 的兜底文案是：

> 「服务端未确认本次操作成功，结果待核验；**已发出的请求可能已生效，请勿直接重复执行。**」

这个文案对真正的失败码是对的，但 `SubmitHandFlow` 的 31 个码里有**两类不是失败**（源码取自官方码表）：

| 类别 | 码 | 正确动作 |
|---|---|---|
| **需（重新）打包** | `NotPack`、`NotPackSuccess`、`NeedRePack`、**`NeedConfirmForRepack`**、`NeedRePackForApplicantChange`、`NeedRePackForInventorChange`、`NeedRePackForCaseChange`、`NeedRepackForFormChanged` | 走 `StartPack` → 轮询 `GetPackInfo`（`PackageStatus` `0`待打包/`100`打包中/`1`打包成功/`2`打包失败）→ 再重试提交；`NeedConfirmForRepack` 需**人工确认**（与 `NeedConfirmReStart` 同类，当前 `messages` 表里没有它） |
| **忙 / 进行中** | `IsPacking`、`IsSending`、`Handing`、`IsInEntrusting` | 稍后重试或刷新核对（很可能已被他人推进），不是"别重复执行" |

风险：用户看到「请勿直接重复执行」会**卡住**，而这几个码的正确出路是"先打包再提交"或"等一会儿"。建议给这两类码单独文案与后续动作。

### 9.3 其余写接口的码表（供补文案参考）

**完整对照：[业务码中文对照.md](./业务码中文对照.md)（可读版）+ [业务码中文对照.tsv](./业务码中文对照.tsv)（113 行 / 11 张表 / 94 条带官方中文）**，含每个码的 i18n key 与官方原文。

摘要：

- **`DeleteFormFile`**：基表（`Success/CaseHandIdNullOrEmpty/FormCodeNullOrEmpty/NoAuthority` + `ExistsForm/NotExistsForm`）+ 9 个文件码。其中 **`ImageNonConformance`（"说明书附图中{0}大小超出165mm x 245mm"）等官方给的是"具体原因 + 怎么改"的文案**，统一兜底会让用户不知道要改什么。
- **`Insert/UpdateFormPatentRequestInfo`**：基表 + `DivisionalCaseNull`（请求书中分案信息未填写）、`IsPublicAdvanceNull`、`NotChecked`、`NotChecked1`、`InventHasSameDayApply`、`UtilityHasSameDayApply` —— **后 5 个是"请去勾选"的引导，不是失败**。
- **`AddCaseHandForm` / `IsHasCaseHandForm`**：`{Success, ExistsForm(表单已存在), NotExistsForm(表单不存在), NoAuthority}`（前两个都算未成功，前端会**回滚勾选**）。
- **Setting**：`ExistSetting`＝"配置数据已存在"、`CannotFoundSetting`＝"找不到配置数据"、`MustCheckIsUseXmlFormatHand`＝"加速审查或延迟审查需勾选【使用xml格式递交】"；`NeedConfirmCaseNameIsNotSame` 不在码表内。

> 出处与置信度：以上码表是用 `解析工具/baseland_result_contract.py` / `baseland_result_contract2.py` / `baseland_code_messages2.py` 从官方前端反解（重建 webpack 模块索引 → 定位调用点所在模块 → 解析码表别名 → 取导出变量 → 展开 `Object(spread)` 基表 → 用 i18n 表把 `r2021...` key 转中文），**是官方前端自己用的文案，不是服务端文档**。各端点实际会遇到哪几个码，仍建议首次 dry-run 时把真实返回打日志核对。

### 9.4 一处残留风险（非缺陷）

`assertWriteResult` 对"返回 `Data` 不含 `Result` 字段"的成功写操作会判为失败。官方前端同样是 `isSuccess(返回值)` 直接判定，因此**与官方行为一致**；但若某端点成功时返回 `Data:null`，会误报。建议首次 dry-run 时确认。

## 十、v5：同步开销复审与已落地的三处修复

### 10.1 先更正我上一轮的口径错误

上一轮我说「24 条有递交实例的**当前流程**里有 15 条已到终态」。**口径说错了**：项目每轮强制核验只对每个案件的**当前流程**查一次官方状态（`refreshProcessOfficial` 在 `service.ts` 中唯一的强制核验调用点就落在 `currentProc` 上），不是对全部流程查。两个口径实测如下（[probe_current_terminal.out](./实测证据/probe_current_terminal.out)）：

| 口径 | 数字 |
| --- | --- |
| 全部流程 | 40 案 / 50 流程；24 条有递交实例（`received` 15 / `draft` 9） |
| 当前流程 | 37 案能选出当前流程；**22 案会查官方状态**，其中 **13 案已是 `received`**、9 案 `draft` |

结论方向不变——每轮强制核验确实有 13 次 `queryOfficial`（每次 2 个 HTTP，共 **26 次请求**）查的是不会变化的结果；但成因是「案件的当前流程正好落在终态流程上」，不是「15 条终态流程每轮都被查一遍」。

### 10.2 顺带查实的一处字段陷阱（非缺陷）

`GetPersonalCase` 五个页签的行里 **`CaseProcName` 一律为 `null`**，真名在 `CaseProcNameInfo.CaseProcName`（`waitHand` / `delivering` / `finish` 均已验，见 [probe_personal_name_fields.out](./实测证据/probe_personal_name_fields.out)）。`processRow` 已按 `CaseProcName ?? CaseProcNameInfo.CaseProcName` 兜底，**项目现有取值是对的**；风险只在于今后任何「只读 `row.CaseProcName`」的新代码都会拿到空流程名。

同批核对（[probe_history_name.out](./实测证据/probe_history_name.out)）：`GetCaseAllFlowHistoryInfo` 顶层 `CaseProcName` 正常返回（`CaseProcNameInfo` 为 `null`），直读无问题；`GetCaseDetailProcList` 两处都有，且**顶层带期次后缀**（`答复审查意见(一)`）比 `CaseProcNameInfo` 更完整，`processRow` 优先取顶层的写法是对的。

> 记一笔操作教训：我第一版探针只读了顶层 `CaseProcName`，名字全空导致当前流程判定全错，得出过「终态 0 个」的假结论。同一条业务字段「哪个端点给、哪个端点不给」必须逐端点验。

### 10.3 已落地的修复

| 编号 | 修复 | 落地与验证 |
| --- | --- | --- |
| **F1** | 终态（已收到回执）流程不再被「15 分钟强制核验」击穿：`SUBMISSION_TTL` 5 分钟、`TERMINAL_SUBMISSION_TTL` 1 小时，短路条件改为 `(!force\|\|terminal)`；`received` 是递交状态机（`0/1/2/3/6/100`）的终值，不会回退 | 新增 2 条回归用例：① 终态在强制轮次不被重查；② 同一案件、同一递交实例处于 `sent` 时仍每轮重查（对照，证明省下的是终态判定而非查询门槛被关） |
| **F2** | 个人案件五个页签由串行改为并发（`Promise.all`），行序、跨页签去重、计数核对、两次尝试语义保持不变 | 新增 1 条用例：并发峰值 > 1 且行序仍为页签顺序。收益见 [14 号文档](../14-只读-增量与变更检测.md) 的并发实测（5 页签串行 1954 ms → 并行 365 ms） |
| **F3** | `fileCount` / `fileListSince` 补注释：说明当前不被产品代码调用及原因（`GetFileCount` 的 `CaseNo` 不能批量，接回会变成替他人上传的文件付费） | — |

验证：`node --experimental-strip-types --test src/domain/*.test.ts desktop/*.test.ts scripts/*.test.mjs` → **428 通过 / 0 失败**（基线 425，新增 3 条）。

未做且不在本轮框架内：`list.xml` 自动生成、真实写路径（`StartHand` / 递交）端到端验收。

### 10.4 本轮证据文件

| 文件 | 内容 |
| --- | --- |
| [probe_current_terminal.sh](./实测证据/probe_current_terminal.sh) · [.out](./实测证据/probe_current_terminal.out) | 按项目自身的当前流程规则逐案复算官方状态查询与终态分布 |
| [probe_personal_name_fields.sh](./实测证据/probe_personal_name_fields.sh) · [.out](./实测证据/probe_personal_name_fields.out) | `GetPersonalCase` 名字字段实况 |
| [probe_history_name.sh](./实测证据/probe_history_name.sh) · [.out](./实测证据/probe_history_name.out) | `GetCaseAllFlowHistoryInfo` / `GetCaseDetailProcList` 名字字段对照 |

三个探针均为只读（`Auth/GetToken`、`GetPersonalCase`、`GetHandInfo`、`GetCaseHandSendInfo`、`GetCaseAllFlowHistoryInfo`、`GetCaseDetailProcList`），本轮未触碰任何写接口。


