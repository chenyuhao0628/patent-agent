# 2026-09-30 UI 统一与流程核对的合成验证证据（0.18.0）

由 `/tmp/patent-agent-ui-polish` 全量持久化而来（2026-10-01），防止临时目录清理后证据丢失。

- 内容：真实 `CaseSpace` / `ProfessionalWork` / `AgentWorkbench` 组件 + 合成案件与合成 API 的验证脚手架（`fixture.tsx`、`fixture-components.tsx`、`index.html`）、各场景截图（png）、几何数据（json）、交互记录、构建与测试日志、0.18.0 制品核验记录。
- `bundle/` 为 esbuild 构建产物，可重建，不入库。重建命令（在本目录执行）：

  ```sh
  /path/to/patent-agent/node_modules/.bin/esbuild fixture.tsx --bundle --format=esm --platform=browser \
    --outfile=bundle/fixture.js --loader:.woff2=file --loader:.woff=file --loader:.ttf=file --loader:.png=file \
    '--asset-names=[name]-[hash]'
  ```

  然后以本目录为根启动静态 HTTP 服务打开 `index.html`（`frame.html?w=&h=` 用于精确 CSS 视口模拟）。
- 边界：全部数据为合成数据，不涉及真实案件、凭证或真实服务；截图与几何不替代原生桌面、安装或真实模型验收。
- 2026-10-01 复审修复后的 `fixture.tsx` 已增强 confirm 模拟语义（旧上下文结果需 `adoptEarlier` 显式采用），0.19.0 的 M4 视觉验证见 [../ui-adopt-0.19.0-20261001/](../ui-adopt-0.19.0-20261001/)。
