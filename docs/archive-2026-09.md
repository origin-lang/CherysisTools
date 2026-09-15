# 🧰 Cherysis 工具集 · 功能与技术归档

归档时间：2026-09
归档对象：本轮改动——活动栏目录树导航、小工具切换保留页面数据、商品图片列粘贴/拖入，以及打包链路固化的关键决策。
对应代码：`src/webview/`（toolTree.ts、main.html）、`src/core/toolRegistry.ts`、`src/extension.ts`、`src/tools/shopTool/`；打包配置见 `package.json`、`pnpm-workspace.yaml`、`patches/`。

---

## 一、本期功能清单

### 1. 活动栏目录树导航（CMake Tools 风格）
- **背景**：6 个工具原来靠 webview 顶部一排按钮切换，空间越来越挤；希望工具入口进侧边栏、可继续扩容。
- **行为**：
  - `package.json` 增加 `viewsContainers.activitybar`（id `cherysis`，icon `images/cherysis.svg`）+ `views.cherysis` 树视图 `cherysis.tools`「工具」；新增 `Cherysis.openTool` 命令（commandPalette 里 `when:false` 隐藏）；
  - 新增 `src/webview/toolTree.ts`：`TreeDataProvider`，顶层两组「系统管理」「小工具」，默认展开；
  - `ToolDefinition`/`ToolMeta` 增加 `category: "system" | "utility"`，6 个工具各标注（3 个带库的 → system，3 个无库的 → utility）；
  - 树节点点击 → `Cherysis.openTool` → `toolRegistry.openTool()`：复用**同一个** WebviewPanel；面板不存在时先置 `lastToolName`，等 `init` 透过 `autoOpenTool` 自动切过去（与关面板再开恢复的是同一条链路）；
  - `main.html` 移除顶部 `nav-bar` 渲染，首页文案改为「在左侧活动栏选择工具」。
- **决策**：
  - 选原生 Activity Bar + `TreeDataProvider`（vs 侧栏 webview / 面板内分组两种备选）：外观统一、可复用 VS Code 树交互、无需自绘 UI；
  - `activationEvents` 由空数组改为显式列出 `onView`/`onCommand`——**空数组会让活动栏图标一直不激活不出现**；
  - 不新建多面板：6 个工具共享单面板，树点击只触发 `switchFragment`，避免多个 webview 的资源开销。

### 2. 小工具切换保留页面数据（DOM 保活）
- **背景**：切换工具时 `switchFragment` 重新 `innerHTML = 文件内容` + 重跑客户端 `init()`，小工具里填的路径/Excel 规则行/九宫格构图全被重置。
- **行为**（`main.html`）：
  - 后端 `initToolList` 下发 `category`，webview 维护 `utilityTools` 集合与 `toolHolders` 隐藏容器；
  - 切走小工具时 `stashCurrentUtility()` 把 `fragmentContainer` 的子节点**原样搬进**该工具的 holder；切回时 `showUtilityFragment()` 再搬回来，并**跳过** `loadToolClient`/`init`——节点引用保留，输入值、规则行、九宫格、图表全部还在；
  - `switchFragment` 消息额外带 `toolName`，webview 用它维护 `currentToolName`（后端直接切工具时也能同步）。
- **决策**：
  - 只对「小工具」（utility）保活；**系统工具每次切换仍全量重渲染**，目的是每次拿到数据库最新数据，避免陈旧表格；
  - 用「节点搬移」而不是 `innerHTML` 字符串缓存：`innerHTML` 快照会丢文件输入值与已绑定的 onclick，且 `excelAnalyze`/`nineGrid` 的 `init()` 会重建规则列表/网格——切回时避开 re-init 才能真保留。

### 3. shopTool 商品图片列：粘贴 / 拖入图片
- **行为**：
  - 后端 `handlers/image.ts` 新增 `receiveImageData`：解析 `data:image/<mime>;base64,` → Buffer，按 mime 定扩展名（png/jpeg/gif/webp/bmp）；文件名优先用原文件名，重名走 `uniqueTargetPath` 加时间戳/序号；写入 `image_dir/<code>/` 后 `reloadImages` + `invalidateCover` + `loadAll`（与「上传图片」同链路）；
  - 前端 `client-product.js`：图片列/整行 `drop`，`document` 级 `paste` 捕获（目标定位：图片列 `[data-p-act=img]` → 任意 `[data-pid]` 行 → 灯箱 `state.lbCode`）；`collectFiles()` 按 `name+size+lastModified` 去重；`.img-drop-hover` 虚线高亮 + toast 提示。
- **踩坑**：
  - 剪贴板里**同一个文件会同时出现在 `clipboardData.items` 和 `.files`**，不去重一次粘贴会写 2 张 → `collectFiles()` 统一去重（也是本次修复的 bug 根因）；
  - **VS Code webview 的 OS 文件拖入默认被劫持**为「拖到编辑器打开」，必须**按住 Shift** 拖入才会把 `dragover`/`drop` 放行给 webview，插件无法绕过 → 拖放定位为次路径（放宽到整行/整卡投放 + 提示按住 Shift）；**粘贴走剪贴板事件不受此限制，是主路径**（点开大图 → Ctrl+V）；
  - 图片走 base64 过 `postMessage`，>25MB 跳过并提示（约束 webview 消息体与会话内存）。

---

## 二、打包链路决策（近期固化，勿回退）

- **唯一打包命令**：`pnpm run package`（即 `vsce-pnpm package`，`vscode:prepublish` 仍为 `pnpm run compile`）。
- **pnpm v11 配置都在 `pnpm-workspace.yaml`** 的 `patchedDependencies`（`package.json` 的 `pnpm` 字段会被 pnpm 忽略并告警）：
  - `vsce-pnpm@0.1.0` 补丁——支持 pnpm scoped 依赖解析、不打平，否则打包缺 `@img/*`；
  - `lazystream@1.0.1` 补丁——`require('readable-stream/lib/_stream_passthrough.js')`。官方 `readable-stream@3.6.2` 已删除根级 shim，不打补丁则扩展激活报 `Cannot find module 'readable-stream/passthrough'`。
- **`.vscodeignore` 不能排除 `node_modules`**：实测排除后只剩 646 文件/24MB，exceljs/globby 及全部传递依赖被砍，激活即失败。收集生产依赖交给 vsce-pnpm。
- 版本 **0.0.8**，产物 `Cherysis-0.0.8.vsix`（win 平台 3838 文件 / 31.11MB）。

---

## 三、验证要点

- `pnpm run compile` + `pnpm run lint` 全绿（仅 `excelAnalyzeTool/client.js` 4 条存量 curly warning，非本轮引入）。
- 手测清单：树点击任意工具能开面板并切到位；小工具填值→切到别的工具→切回数据不丢；灯箱内 Ctrl+V 一次只加 1 张；按住 Shift 从资源管理器拖图片到商品行松手即上架该图。