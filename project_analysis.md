# 专利工作台当前摘要

> 更新：2026-09-22。版本 `0.13.0`。本文不是需求。

需求见 [REQUIREMENTS.md](REQUIREMENTS.md)。当前目标、实现和证据见 [EXEC_PLAN.md](EXEC_PLAN.md)。安装和使用见 [README.md](README.md)。

独立 Electron 桌面应用。主进程负责文件、同步、贝思兰德和模型任务。渲染进程只通过 `window.patentDesktop` 调用。答复状态在 `src/domain/agent.ts`，撰写和审查在 `desktop/professional-host.ts`，同步和账号在 `desktop/service.ts`，转交在 `desktop/transfer-host.ts`。

安装包、只读同步、本地办理和本机定稿可以按当前实现使用。真实写操作需要单独授权。尚未完成的使用验收见实施计划，不构成停用条件。
