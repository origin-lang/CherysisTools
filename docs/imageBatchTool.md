# 🗂️ 图片批量工具箱（imageBatchTool）

后端：`src/tools/imageBatchTool/index.ts` · UI：`src/tools/imageBatchTool/fragment.html` · **无 client.js**

纯表单+执行型工具：4 个子 Tab，每个都是"填路径/参数 → 点执行 → 看日志"。日志进共享 `#logArea`，所有子功能执行前先发 `clearLog`。

## 使用流程（用户视角）

1. 切到对应子 Tab，选/粘贴源目录与输出目录（可手动输入路径，或点"选择文件夹"、"打开文件夹"）。
2. 填参数（前缀、编号范围、冲突策略等）。
3. 点「▶ 执行…」青色主按钮 → 后端跑完逐条打日志，底部给汇总（成功/跳过/失败数）。

## 子功能与参数

### 批量建文件夹（subMode: `tabMkdir`）
- `ib_mk_target` 目标父目录（必填） · `ib_mk_prefix` 前缀 · `ib_mk_start`/`ib_mk_end` 起始/结束数字 · `ib_mk_digit` 位数(3/4) · `ib_mk_clear_before` 是否先清空目标目录（默认勾选，⚠危险）
- 生成 `<前缀><补零编号>` 目录，已存在则跳过。

### 图片序列重命名（subMode: `tabRename`）
- `ib_re_src` 源目录（必填） · `ib_re_out` 输出目录（仅复制模式必填） · `ib_re_mode` 0=复制导出(先清空输出目录) / 1=原地重命名(危险) · `ib_re_prefix` 基础前缀（必填，如 `L001` → `L001_1.jpg`） · `ib_re_imgonly` 仅图片 · `ib_re_ov` 冲突 0=跳过 / 1=覆盖
- 源目录与输出目录不能相同。

### 图片按编号分发（subMode: `tabDist`）
- `ib_dis_src` 源目录（必填） · `ib_dis_target` 目标根目录（必填） · `ib_dis_ov` 0=跳过 / 1=覆盖
- 按文件名**第一个下划线前段** `key` 复制到 `<目标根>/<key>/`；目标子文件夹必须**预先建好**，没有则跳过并计数。文件名无下划线直接跳过。

### 图片追加标识导出（subMode: `tabAppend`）
- `ib_ap_src` 源目录（必填） · `ib_ap_out` 输出目录（必填，执行前清空） · `ib_ap_text` 追加标识（必填，`demo.jpg` → `demo_cover.jpg`） · `ib_ap_imgonly` 仅图片 · `ib_ap_rmdir` 清空时是否连子文件夹一起删

## 消息协议

webview → 后端（`index.ts` handleMessage）：

| type | 参数 | 后端回包 |
| --- | --- | --- |
| `selectFolder` | `{targetId}` | `folderSelected {path, targetId}`（main.html 填充对应 input） |
| `openTargetFolder` | `{targetPath}` | 无回包，`ctx.log` 成败 |
| `runTool` | `{params:{subMode, ib_*…}}` | `clearLog` + 逐条 `log` |

## 技术与数据

- 纯 `fs/promises`（readdir/unlink/rm/copyFile/rename/mkdir），**不做图像解码**（imgonly 只看扩展名）。
- "打开文件夹"用 `child_process.exec("explorer …")`，**只凭 stderr 判断失败**（explorer 成功也会返回非零码）。

## 维护注意

- fragment.html 的按钮靠 `data-action / data-tool-name / data-sub-mode` 属性驱动，由 `main.html` 的 `bindFragmentGenericEvents()` 绑定；改按钮动作时**不要在 client.js 里找绑定**（没有 client.js）。
- `runTool` 的参数从"当前 `.sub-panel.show` 面板内"收集：radio 取 `name=值`、checkbox 取 `id=checked`、其它 input 取 `id=value`（number 会转数字）。加新输入控件必须给 id。
- 清空目录、原地重命名等操作不可恢复，UI 上已有红色风险提示，改动时别破坏。