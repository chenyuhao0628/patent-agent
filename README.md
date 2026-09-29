# 专利工作台 0.15.3

独立 macOS / Windows 桌面应用，覆盖案件管理、答复与补正、五阶段撰写、可选独立审查和贝思兰德内部流转。应用管理业务与文件，模型通过随包 OpenCode 接入，无须旧项目源码。

## 当前状态

- 当前源码为修复版 **0.15.3**，包含撰写阅读区独立滚动、布局调整和 Windows 菜单移除；继承五项实测修复、远端单文件关联删除和材料界面统一。
- 0.15.3 双平台安装包正在构建，成功后替换旧包并更新安装清单。统一面板注册仅完成可行性评估，尚未实施。
- 源码、自动化、真实服务、桌面 GUI 和安装验收分别记录；完整交付验收仍未完成。当前缺口见 [实施计划](EXEC_PLAN.md)，已完成记录见 [模块归档](docs/archive/README.md)。

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

以 [当前安装清单](release/release-manifest.json) 为准，release 仅保留最新版本制品及清单：macOS Apple Silicon 使用 `.app` / `.pkg`，Windows x64 使用 NSIS `.exe`。构建与摘要证据见 [0.15.2 记录](evidence/release-0.15.2-20260929.json)。

安装器使用固定应用标识并保留用户数据；Mac 安装至所选安装域的 Applications，Windows 保留安装路径和 AppData。账号、加密凭证和本机设置在应用数据目录；工作目录与原始申请库单独选择。当前包无发行签名、macOS 公证及在线自动更新。

## 开发

```sh
npm ci
npm test
npm run build
npm run desktop
npm run package:release
```

`npm test` 覆盖领域、主进程和打包脚本；构建包含类型检查；打包前在 `.lab/agent-runtime` 准备固定版本的 OpenCode，打包失败保留上一版安装包。按本次授权执行提交、打包、推送和发布；文档整理不升版本、不重跑无关业务验证。
