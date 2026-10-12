# 开发与验证操作

本页对应仓库 `package.json` 的实际命令。先阅读 [仓库规则](../../AGENTS.md)、[已确认需求](../../REQUIREMENTS.md)、[当前计划](../../EXEC_PLAN.md) 和影响范围的 [代码对照](../project/traceability.md)。本地开发不要求修改旧 patent、DSH 或 0001 仓库。

## 开始工作

1. 确认 Git 根、分支、状态与相关 diff，保留已有改动；按任务读取源码和文档。
2. 按锁文件安装依赖。测试使用 Node 原生 TypeScript 类型剥离；使用支持项目实际命令及依赖 engines 声明的 Node 环境，不从浏览器预览能打开推断桌面可构建。
3. 用临时配置和合成案件验证，避免对真实用户数据执行开发操作。原生隔离启动可设置 `PATENT_AGENT_DATA_DIR`；运行时更新检查在合成测试中可用 `PATENT_AGENT_DISABLE_RUNTIME_UPDATE=1` 暂停。

## 命令及作用

| 命令 | 实际作用 |
| --- | --- |
| `npm ci` | 按 package-lock 安装依赖 |
| `npm run dev` | Vite 浏览器预览，127.0.0.1:5173；不是桌面运行 |
| `npm test` | 现有 domain、app、desktop 和 scripts 的测试通配路径 |
| `npm run build` | 类型检查 → 前端构建 → Electron 主进程 / preload 构建 |
| `npm run desktop` | 先构建再启动 Electron |
| `npm run preview` | 预览已有前端构建；同样不提供原生文件 / 凭证能力 |
| `npm run module:create -- --name case-notes --location global --title 全案笔记` | 生成全局编译期模块并注册；改用 case 可生成单案入口 |
| `npm run package:release` | 构建并核验 macOS / Windows 制品，写入本机 release；默认清理脚本识别的旧制品，不是上传或对外发布 |
| `npm run package:release -- --preserve-old` | 保留旧制品并校验摘要；同名版本已存在时拒绝覆盖 |
| `npm run package:mac` / `npm run package:win` | 只打对应平台；不能声称另一平台重新通过 |
| `npm run prepare:agent-runtime` | 校验并从已有 `.lab/agent-runtime` 复制到 `resources/agent-runtime`；不是下载最新版的命令 |

## 打包前提

`package.json` 的 extraResources 直接使用 `.lab/agent-runtime`，其中应有 macOS arm64 / Windows x64 二进制、许可证、版本与摘要清单；准备命令成功后才生成资源复制输出目录 `resources/agent-runtime`，该目录在未准备运行时时可以不存在。运行时准备脚本检查版本格式、文件格式与摘要；行为兼容还由 `desktop/runtime-acceptance.ts` 检查。不能把“目录存在”或“版本号大于 2”写成兼容性通过。

打包经 release-staging 暂存和核验后才更新 release 及其清单。保留 / 清理按当次用户要求，历史规则不自动延续；应用数据与运行时回退目录不属于旧安装包清理范围。历史证据的文件名和清单快照不改写。

新增功能、兼容修复和不兼容修改按三段版本规则调整；纯文档不升版。需要打包时同步 package、锁文件、README、计划和本次清单，不以升版掩盖未验收内容。

## 验证范围

- 先选与改动风险匹配的已有测试；共享合同或业务行为改变时执行完整测试及构建。build 已含类型检查，不重复宣称多轮独立验收。
- 模块生成后的测试路径未自动加入 npm test，另执行 `node --experimental-strip-types --test src/modules/generated/*/panel.test.ts`；无生成模块时不要运行空通配路径。接入细节见 [模块指南](module-guide.md)。
- 页面或状态修改核对路由、权限、旧历史目标、账号 / 案件 / 阶段变化及迟到回执；文件 / 长任务修改还需落盘、停止与重开。
- 浏览器、原生 GUI、安装包解包、实际安装、合成供应商和真实供应商分别记录。具体标准见 [验收规范](../architecture/verification.md)。
- 纯文档核对执行引用 / 代码路径 / 命令 / 版本 / 差异检查，不为排版改动重跑业务全量测试；发现行为差距时保留需求并登记，不虚构修复通过。
