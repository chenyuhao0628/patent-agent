# 案件同步与单案刷新

> 实现与验证历史归档，保留原日期、版本和证据口径。“完成”仅限当时记录的层级，不代表当前完整验收；旧操作授权不自动延续。当前状态与待办见 [实施计划](../../EXEC_PLAN.md)。代码路径相对仓库根目录。

## 2026-09-27：#8 单案定向刷新（历史源码与自动化验证记录）

用户已确认将案件内「刷新本案」从个人案件 `full:true` 全量同步改为单案定向刷新。单案刷新必须重新读取当前案件已知个人流程、附件清单、备注和官方结论，按不可变 `FileNo` 只下载新增或未就绪材料，不归并个人案件全库，也不改写其他案件。新案件、归属变化及此前未知的个人流程仍由案件库「刷新案件」和增量同步发现。

| 顺序 | 工作与验收边界 | 状态 |
| --- | --- | --- |
| 1 | 更新 `REQUIREMENTS.md`，明确单案刷新与全库同步职责边界 | 已完成 |
| 2 | 提取并复用单案材料同步，替换 `refreshCase()` 中的 `sync({full:true})` | 已完成 |
| 3 | 回归单案请求合并、作用域变化、流程 ABA、其他案件保留、FileNo 新增及失败重试 | 已完成；`desktop/concurrency.test.ts` 20/20 通过 |
| 4 | 定向测试、全量测试、类型与生产构建、UI 冒烟及差异检查 | `desktop/concurrency.test.ts` 20/20、`npm test` 681/681、`npm run build`、`git diff --check` 通过；已补齐生产前端合成接口视觉验收，覆盖刷新忙碌/成功/失败重试、切案迟到响应与 390px 窄屏；[截图与范围](../../evidence/pr8-visual-20260927/README.md) |
| 5 | 更新 README 与最终证据；不生成安装包，不执行真实服务写入 | 已完成；版本仍为 0.15.0，未打包、发布或调用真实贝思兰德写接口 |

### 3.1 2026-09-27 自动化与构建（历史记录）

以下保留 2026-09-27 的源码验证记录，使用合成数据与临时目录，没有调用真实模型、读取真实案件或执行真实业务提交。2026-09-29 五项修复的708 项测试及桌面验证结果见 [五项修复归档](writing-review.md)。

| 检查 | 当时结果 | 范围与限制 |
| --- | --- | --- |
| `npm test` | 681/681 通过 | 0 失败、0 取消、0 跳过；覆盖 DOCX、流转 UI、远端 FileNo、清理、中断恢复及 #8 单案刷新 |
| #8 定向回归 | 20/20 通过 | `desktop/concurrency.test.ts` 覆盖请求合并、不调用全库同步、未知流程隔离、其他案件保留、新增/未就绪/无文件名 FileNo、显示名变化，以及账号/目录/案件/流程 ABA 迟到拒绝 |
| `npm run build` | 通过 | 包含 `tsc --noEmit`、Vite 与 Electron 桌面 bundle；不是安装包或安装验收 |
| 浏览器生产预览 / #8 视觉验收 | 已补齐并通过 | 2026-09-27 直接操作 Chrome Agent Window：生产案件库、合成接口刷新忙碌/成功/失败重试、材料更新、切案迟到错误隔离、390×844 窄屏；[证据](../../evidence/pr8-visual-20260927/README.md)。仅生产前端及模拟接口，不替代 Electron 原生或真实服务验收；临时窗口和两项服务已关闭 |
| `git diff --check` | 通过 | 检查本次差异无空白错误；不代表业务验收 |

PDF 读取测试仍输出 `Cannot access the require function` 警告，对应 CJS 的 DOCX/PDF 实际提取测试通过；不据此声称所有文档格式均已验收。

本轮主要回归入口：`desktop/concurrency.test.ts`、`desktop/docx-content.test.ts`、`desktop/transfer-host.test.ts`、`desktop/transfer-preview.test.ts`、`src/app/transfer-ui-state.test.ts`，以及既有 Agent、Professional、Transfer、同步与并发集成测试。
