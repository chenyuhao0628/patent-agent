# 2026-10-01 真实验收记录（macOS：安装、原生 GUI、真实模型、Word 版式）

对象：0.19.0 安装制品（用户域安装）+ 含公式修复的源码构建（0.19.1-dev）。Windows 实机安装由用户执行，另行记录。全部业务数据为合成验收案件（“验收合成-可调节夹持装置 / QA-ACCEPT-001”），未使用真实案件材料，未执行真实业务写入。

## 安装与启动

- `installer -pkg PatentWorkbench-0.19.0-macOS-arm64.pkg -target CurrentUserHomeDirectory` 成功（“Upgrading at base path /Users/cyh”），安装至 `~/Applications/专利工作台.app`，`CFBundleShortVersionString=0.19.0`。
- 系统域 `/Applications` 覆盖安装未执行：无管理员密码时 macOS TCC「App Management」拒绝替换 root 属主应用；`sudo` 需密码。旧版 0.15.2 仍在 `/Applications`（备份意图与路径见实施计划）。
- 启动、干净退出（无残留进程、无崩溃报告）、重开后用户数据完整保留（应用使用原用户数据目录启动并正常读入）。

## 原生 GUI（CDP 驱动真实界面，非浏览器合成）

- 新建本地案件 → 撰写页 → 生成任务 → 预览 → 停止/续办 全链路走通。
- 撰写阅读区独立滚动：结果容器独立滚动（scrollHeight 1142 / clientHeight 837），页面与确认区不随之滚动。
- 界面版本标识「桌面版 0.19.0」。

## 真实模型（随包 OpenCode 运行时）

- 运行 1（0.15.x/0.19.0 代码）：9 次工具调用（read_skill×7、discover_tools、write_artifact），产物已保存（3954 字），但结果验收因公式导出缺陷判“未完成”（m:sty）。
- 运行 2（含 m:sty 修复）：10 次工具调用，暴露第二类缺口（m:nary）。
- 运行 3（含全部公式修复）：**完整成功**——任务完成、产物检查通过、依据面板与待核对提示正常、DOCX（含标题/表格/公式）导出成功并在界面以 KaTeX 渲染、任务记忆合并前几轮要求、零控制台错误。
- 停止路径：新任务运行中点“停止”→ 状态“已停止”、出现“继续未完成任务”入口、提示“未将迟到结果写入案件”。

## Word 模板版式（原生 Microsoft Word）

- 使用指定模板派生副本 `resources/document-templates/reply.docx`（SHA-256 与 manifest.templateSha256 一致：fd18a8fd…8986）。
- 3 页样稿：标题/正文/标题样式、页边距、模板角标正常；分页准确（第 1 页，共 3 页）。
- 公式以 Word 原生 OMML 渲染（$P=F/S$、$F=k·Δx$、$v=s/t$、$R=U/I$、$Δx$）；表格边框与加粗表头正常；内嵌 PNG 图片导出+回读完整（程序化验证）。
- 观察项：指定模板以 Word「兼容模式」打开（模板固有）；公式回读后部分运算符包在 `\text{}` 中（语义与显示保留）；Markdown 表格行之间有空行时不识别为表格（按标准 Markdown 行连续书写即可）。

## 截图

| 文件 | 内容 |
| --- | --- |
| native-model-completed.png | 原生应用内真实模型任务完成态（含公式 KaTeX 渲染与 DOCX 预览） |
| word-page1.png / word-page2.png / word-formulas.png | 原生 Word 第 1/2 页与公式区渲染 |
| word-table.png | 原生 Word 表格渲染复验 |

边界：合成案件与合成材料；真实贝思兰德写入、双案上下文隔离、Windows 实机、系统域安装、签名/公证未在本记录内完成。
