# 专利工作台 0.22.0

独立 macOS / Windows 桌面应用，覆盖案件管理、答复与补正、五阶段撰写、可选独立审查和贝思兰德内部流转。应用管理业务与文件，模型通过随包 OpenCode 接入，无须旧项目源码。

## 当前状态

- 当前源码和安装清单为 **0.22.0 候选测试版**；macOS .app / .pkg 与 Windows .exe 已生成并核验，已按用户要求清理旧安装包，当前仅保留 0.22.0 三项制品。
- 全局与单案面板分别注册，共用宿主；案件数据统一通过主进程仓储和渲染 Store 管理。可替换适配器与模块生成模板已实测，接入见 [模块指南](docs/development/module-guide.md)。
- OpenCode 已迁移 v2，当前打包快照 2.0.27。按账号、案件、阶段与分支保存会话；自动检查并安装通过兼容性验证的更新，空闲切换并保留回退，不锁死补丁版本。
- 全量 **864/864**、类型与构建通过；生成模块另有 **2/2** 验证。最终 .app 已检查保存 / 重开、导航、任务切页 / 停止及三视口；已修复性能对照暴露的面板等待和并行创建目录竞态。六阶段本地提交，未推送或对外发布；见 [交付报告](evidence/module-platform/phase-6/RESULT.md) 和 [性能对照](evidence/module-platform/phase-6/PERFORMANCE.md)。
- 用户此前报告的真实贝思兰德稿件保存失败根因尚未证实；合成通过不等于生产验收。历史真实模型与 Word 结果见 [既有验收记录](evidence/native-acceptance-20261001.md)，本轮边界见测试说明。

## 文档入口

| 用途 | 入口 |
| --- | --- |
| 全部文档与维护方式 | [文档总索引](docs/README.md) |
| 已确认需求，按模块查阅 | [REQUIREMENTS.md](REQUIREMENTS.md) |
| 当前任务、版本边界与未完成项 | [EXEC_PLAN.md](EXEC_PLAN.md) |
| 技术结构、接口与开发验证 | [DEVELOPMENT.md](DEVELOPMENT.md) |
| 案件、办理、流转、文档与工具操作 | [使用说明](docs/USER_GUIDE.md) |
| 仓库规则 | [AGENTS.md](AGENTS.md) |

## 安装

当前 **0.22.0** 三项制品见 [安装清单](release/release-manifest.json)。macOS Apple Silicon 使用 .app / .pkg，Windows x64 使用 NSIS .exe；安装与现场验收见 [0.22.0 测试说明](docs/TESTING-0.22.0.md)。0.20.1、0.21.0 旧制品和未验收中间包已清理，历史验收证据保留。Windows 包已实际解包核对，Windows 实机及覆盖安装尚未验收。

安装器配置保留应用数据；账号、凭证和本机设置在应用数据目录，工作目录与原始申请库另行管理。当前包无发行签名和 macOS 公证，整体应用通过安装包更新。OpenCode 后台默认自动验证并更新，和应用安装包更新分开。

## 开发

```sh
npm ci
npm test
npm run build
npm run desktop
npm run package:release
```

`npm test` 覆盖领域、主进程和打包脚本；构建包含类型检查；打包前在 `.lab/agent-runtime` 准备通过兼容检查的官方 OpenCode，清单记录实际版本与摘要。保留旧制品时使用 `--preserve-old`；打包失败保留上一版。本轮仅本地提交与构建，不推送或发布。

本版继续保留中断续办与任务产物进度：撰写和独立审查可以继续当前未完成任务；按正文、修改依据及申请文件部分显示已保存与待补齐内容。恢复先核对范围和摘要，结果不明的操作不自动重放；提示不增加定稿或内部转交门槛。
