# 🧩 九宫格工具箱（nineGridTool）

后端：`src/tools/nineGridTool/index.ts` · UI：`src/tools/nineGridTool/fragment.html` · 前端：`src/tools/nineGridTool/client.js`

交互式工具：9 个格子可视化摆图 → 合成大图；另有一个给合成图底部打序号的子功能。图片预览通过 `src/core/utils.ts` 的 `readImageToBase64()` 转 base64 dataURL 塞进 `<img>`，路径存于 client 的 `state.uriMap`。

## 使用流程（用户视角）

### Tab「九宫格拼图」
1. 「选择多张图片」或「读取文件夹内图片」→ 自动填入前几个空格；
2. 点格子选中（蓝色高亮）再点另一格 → 交换位置；右键格子弹菜单：旋转 90° / 删除；
3. 选择输出目录 → 「执行九宫格拼图」→ 生成 `ninegrid_<ts>.jpg`（ts 为 ISO 时间替换掉 `:` `.`）。

### Tab「九宫格添加序号」
1. 选择一张九宫格大图（有预览框）；输入起始编号；
2. 可选输出目录（不选则存原图同目录）→ 「开始生成带编号图片」→ 每格底部叠 `<N>号` 白字描边，输出 `ninegrid_labeled_<ts>.jpg`。

## 关键技术点

- **拼图**：以第 1 张图宽高为基准，9 张全部 `resize(填满)` 到同样尺寸；白色底 `3×3` composite 合成 JPEG（quality 95）。**要求 9 个格子必须填满**才执行。
- **打序号**：每格左下大字，绘制用 **SVG 文本**（`<svg><text …/></svg>` buffer）作 composite input，字号 = min(格宽,格高)×0.15。
- **旋转**：`sharp().rotate(90)`，先写临时文件再 `unlink` 原文件 + `rename` 回去（**原地修改源图片**，失败会清理临时文件）。

## 消息协议

webview → 后端：

| type | 参数 | 后端回包 |
| --- | --- | --- |
| `openSelectImages` | — | `addImagePaths {paths, uriMap}` |
| `openLoadImageFolder` | — | `addImagePaths {paths, uriMap}` |
| `selectOutputFolder` | — | `setOutputDir {path}` |
| `openMergeOutputFolder` | `{outDir}` | `ctx.log` |
| `runMerge` | `{grid, outDir}` | `clearLog` + `ctx.log`（9 张不全或目录无效则失败日志） |
| `selectLabelImage` | — | `setLabelImage {path, base64}` |
| `selectLabelOutDir` | — | `setLabelOutDir {path}` |
| `openLabelOutputFolder` | `{targetDir}` | `ctx.log` |
| `runLabel` | `{srcPath, startNum, outDir}` | `clearLog` + `ctx.log` |
| `rotateImage` | `{idx, grid}` | `rotatedCellUpdate {idx, filePath, newBase64}` + `ctx.log` |

前端处理：`addImagePaths / setOutputDir / setLabelOutDir / setLabelImage / rotatedCellUpdate`。删除格子、交换、右键菜单等纯前端无消息。

## client.js 要点

- `state.gridItems` 9 长度的路径数组（null=空）；`uriMap` 路径→base64 预览，`addImagePaths` 是**合并**不是覆盖。
- 交互：点击选中再点另一格交换；右键出自定义 `#ctxMenu`，位置用 `ev.pageX/pageY`。
- 打开文件夹用的是 vscode 命令 `revealFileInOS`（`vscode.commands.executeCommand`）。

## 维护注意

- 旋转、删格会**直接改动用户图片文件**（旋转是原地 90°），不可逆，改动时别破坏这条安全边界。
- 后端逻辑函数 `handleNineGridMergeFromList / handleNineGridLabel / rotateImageInPlace / scanImageFiles` 都单独 `export`，**可直接复用/单测**。
- 改后端 `index.ts` 需 `pnpm run compile`；改 client.js / fragment.html 直接 F5 重载。