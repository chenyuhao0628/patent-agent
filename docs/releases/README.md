# 交付与版本索引

更新：2026-10-12。当前源码 / 锁文件 / 安装清单为 **0.22.0**。可使用制品以 [当前安装清单](../../release/release-manifest.json) 和实际 release 目录为准；历史报告中的包名不表示该文件仍被保留。

## 当前交付

| 项目 | 文件或依据 |
| --- | --- |
| macOS Apple Silicon 应用 | `release/专利工作台-0.22.0-macOS-arm64.app` |
| macOS 安装器 | `release/PatentWorkbench-0.22.0-macOS-arm64.pkg` |
| Windows x64 安装器 | `release/PatentWorkbench-0.22.0-Windows-x64-Setup.exe` |
| 使用与现场检查 | [0.22.0 测试说明](../TESTING-0.22.0.md) |
| 构建、原生与包内证据 | [最终交付报告](../../evidence/module-platform/phase-6/RESULT.md)、[包内核对](../../evidence/module-platform/phase-6/release-check.json) |
| 安装包清理 | [2026-10-12 清理记录](../../evidence/release-cleanup-20261012.json)：六个旧版制品和三个未验收中间制品已删除，当前三项摘要不变 |

0.22.0 已有 864/864 自动化、构建、macOS 原生直接启动、保存 / 重开与三视口、Windows 安装器实际解包及两平台包内摘要证据。Windows 实机和 macOS pkg 覆盖安装仍未验收；发行签名、公证、真实服务与真实模型质量不能由这些结果代替。待验收事项只在 [当前计划](../../EXEC_PLAN.md) 维护。

应用版本与 OpenCode 运行时版本分开管理：安装包记录捆绑快照，启动后可自动验证并更新兼容运行时。模块前端源码的变更随应用重新构建；不把后台自动更新当作应用整体自动更新。

## 历史说明与证据

| 版本 / 时段 | 入口 | 当前用途 |
| --- | --- | --- |
| 0.21.0 | [历史测试说明](../TESTING-0.21.0.md)、[v2 交付证据](../../evidence/opencode-v2-migration/phase-5/RESULT.md) | OpenCode v2 / 会话 / 缓存的历史验证；安装包已清理 |
| 0.20.1 | [历史测试说明](../TESTING-0.20.1.md)、[制品审计](../../evidence/audit-20261012/release-probe.json) | 实物构建时间核对为 2026-10-11（北京时间）；旧文档的 10-09 证据缺失，不补造验收；安装包已清理 |
| 0.20.0 | [历史保存验证步骤](../TESTING-0.20.0.md) | 真实工作台稿件保存故障的排查方法；不是当前安装指引 |
| 更早版本与推送 | [交付档案](../archive/releases.md)、[历史操作授权](../archive/decisions/2026-09-29-delivery.md) | 保留当时过程、授权与验证边界，不自动延续操作授权 |

只改项目文档不变更 0.22.0 安装版本。当前清单可因清理而变化，交付时的清单快照保持原样，用于历史摘要追溯。
