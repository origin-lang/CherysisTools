# Cherysis 工具模块文档索引

VSCode Webview 面板小工具集。每个工具 = `fragment.html`(UI) + `client.js`(前端脚本，可选) + `index.ts`(后端处理)，在 `src/extension.ts` 里注册。

在线索：`src/tools/<toolName>/`、`src/core/`（toolRegistry / toolContext / utils）、`src/webview/main.html`（壳 + 通用路由 + 日志区）。

| toolName | 中文名 | 一句话用途 | 文档 |
| --- | --- | --- | --- |
| imageBatchTool | 🗂️图片批量工具箱 | 批量建目录 / 序列重命名 / 按编号分发 / 追加标识导出 | [imageBatchTool.md](imageBatchTool.md) |
| nineGridTool | 🧩九宫格工具箱 | 9 图合成九宫格大图、给九宫格加序号 | [nineGridTool.md](nineGridTool.md) |
| excelAnalyzeTool | 📊Excel清洗统计绘图 | 正则分组清洗 + 聚合统计 + canvas 图表 + 导出 | [excelAnalyzeTool.md](excelAnalyzeTool.md) |
| procurementTool | 📦供应商采购管理 | 供应商档案 + 采购订单 + 分析（SQLite 持久化） | [procurementTool.md](procurementTool.md) |
| shopTool | 🏪商品店铺管理 | 商品档案(L编号/售价规则/库存/图片) + 每日销售 + 月结盈亏（SQLite） | [shopTool.md](shopTool.md) |
| order1688Tool | 📥1688订单提取 | 粘贴1688订单文本自动解析 → 核对入库SQLite + 导出采集Excel（按订单号去重） | [order1688Tool.md](order1688Tool.md) |
| **网页版（shopTool 手机版）** | 🌐浏览器 / 手机访问 | 同一套 handler 的另一层皮：HTTP 服务 + 手机版页面，手机录商品、盘点、看图 | **上手与自测（先看这篇）：[网页版-上手与自测.md](网页版-上手与自测.md)**；方案：[网页版方案-设计.md](网页版方案-设计.md)；使用与运维：[网页版-使用与运维.md](网页版-使用与运维.md) |

> 单次迭代的功能/技术变更归档（含本期复制/删除规则/撤销重做/组合框等）：[procurementTool-archive.md](procurementTool-archive.md)；shopTool 迭代归档（base64 封面 / 编号 3 位补零迁移 / 每日销售自动刷新与批量删除 / 趋势修复 / ⭐直播排品 / 800 压测种子 / 九宫格合成与焦点保护 / **直播排品收尾（删组·每组生成·星标点选填格·橙色图例）** / 全局 Toast / 800 封面补图脚本 / **性能与加载优化（封面缩略图·聚合缓存增量维护·封面请求限流·渲染减负）**）：[shopTool-archive.md](shopTool-archive.md)；order1688Tool 迭代归档（预览空白根因=JS 同名函数覆盖 / 回车触发解析 / 右栏日志折叠）：[order1688Tool-archive.md](order1688Tool-archive.md)

## 通用架构速记（每个工具一样，不重复写进各工具文档）

- **前端→后端**：`vscode.postMessage({type, toolName, ...})`；`src/core/toolRegistry.ts` 按 `toolName` 分发到 `index.ts` 的 `handleMessage(msg, ctx)`。
- **后端→前端**：`ctx.log(text)`（进共享 `#logArea`，支持含换行的多行文本）/ `ctx.postToWebview(msg)`。日志区在页面底部：标题栏「运行日志」+ 右上角「清空」按钮，固定高度 `overflow-y:auto` 可滚动、可用鼠标拖底部拉伸。`main.html` 只处理全局类型：`initToolList / switchFragment / log / clearLog / folderSelected`；其余工具消息交给当前工具的 `onMessage`（未加载先入 `pendingClientMessages` 队列）。
- **前端脚本注册**：`window.toolClients[toolName] = { init, onMessage, _state, _isReady }`。
- **两种前端风格**：
  - **data-action 托管**（仅 imageBatchTool）：按钮声明 `data-action / data-tool-name / data-sub-mode`，事件由 `main.html` 的 `bindFragmentGenericEvents()` 统一绑定，**无 client.js**。
  - **自绑定**（其余工具）：`client.js` 里 `document.getElementById(...)` 手动绑事件。
- **编译规则（重要）**：`index.ts`(TS) 编译到 `out/` 运行，**改后端必须 `pnpm run compile`**；`fragment.html` / `client.js` 运行时直接从 `src/` 读取，改完 F5 重载扩展即生效。
- **shopTool 前后端规则对账（重要）**：`productFields.ts`（`PRODUCT_FIELDS` / `normText` / `normMoney` / `normGrade` / `normInt`）与 `client-core.js`（`FIELD_SPECS` / `sanitizeProductField`）是**两份手工维护的同源规则**，改任一侧后必须跑 `pnpm run check:parity`（已挂进 `pretest` 与 `vscode:prepublish`，测试/打包会自动拦）。脚本：`scripts/check-shopTool-parity.cjs`。
- **数据存储**：SQLite 文件放在扩展全局存储 `globalStorageUri`（procurement 模块），跨工作区共享；**可用设置项 `cherysis.storageDir`（`contributes.configuration`，settings.json 里填绝对路径）指定存放目录**，留空则退回默认 `%APPDATA%\Code\User\globalStorage\<publisher>.<name>\`。面板打开时 `init` 会打印 `🗂数据存储目录：<路径>`。图片/Excel 处理直接读写用户磁盘。
- **公共依赖**：`xlsx`(Excel)、`sharp`(图像)、`better-sqlite3`(SQLite)、`fs/promises`、`child_process`。前端零框架，原生 JS + canvas/SVG。