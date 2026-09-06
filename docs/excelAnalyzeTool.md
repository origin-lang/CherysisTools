# 📊 Excel清洗统计绘图（excelAnalyzeTool）

后端：`src/tools/excelAnalyzeTool/index.ts` · UI：`src/tools/excelAnalyzeTool/fragment.html` · 前端：`src/tools/excelAnalyzeTool/client.js`

通用数据分析工具：读 Excel/CSV → 选列 + 正则分组清洗 → 聚合 → canvas 图表 → 可筛选排序的结果表 → 导出 Excel/PNG。**后端持有已加载文件**（模块级 `loadedFile` 跨消息保留）。

## 使用流程（用户视角）

1. 选文件（支持 xlsx/xls/csv，只读**第一张工作表**）→ 显示行数与字段列表，X/Y 列下拉填充。
2. 配置：X 轴原始列、Y 轴数值列、分组正则（可多条，可加可删）、聚合方式（求和/计数/平均值）、图表类型（柱状/折线/饼图）、正则匹配失败处理策略。
3. 「▶ 执行分析并绘图」→ 左侧结果表 + 右侧图表同步出现。
4. 结果表可点表头排序、X 标签筛选、数值筛选（支持 `>100`、`>=N`、`10-50` 区间、纯文本包含）。
5. 选导出目录 → 「导出统计表格Excel」「保存图表PNG」。

## 清洗/统计核心（后端 `analyzeRows`）

- **分组规则**：按数组顺序编译，每条正则命中即用其**第 1 个捕获组**（无捕获组用整串）作分组标签，命中的行不再参与后续规则。规则为空时：原文即标签，恒为匹配成功。
- **失败处理（仅在有规则时生效）**：`success_only` 只看成功 / `fail_only` 只看失败 / `separate` 都看，失败行以其原始文本成组（key=null 归空串） / `merge_other` 都看，失败行归为「其他」。
- **Y 值**：count 不需要 Y 数值；sum/mean 遇到非数值行做 dropna（不参与聚合）。
- 结果按聚合值降序输出 `{xName, value}`。

## 消息协议

webview → 后端：

| type | 参数 | 后端回包 |
| --- | --- | --- |
| `selectFile` | — | `fileLoaded {filePath, columns, rowCount}` |
| `runAnalysis` | `{xCol, yCol, rules:[{regex}], aggType, chartType, invalidMode}` | `clearLog` + `analysisResult {statRows, xHeader, yHeader, chartType, rowCount}` |
| `selectOutFolder` | — | `outFolderSelected {path}` |
| `openTargetFolder` | `{targetPath}` | `ctx.log` |
| `exportExcel` | `{outDir, statRows, xHeader, yHeader}` | `ctx.log` |
| `saveChart` | `{outDir, dataUrl}`（`data:image/png;base64,…`） | `ctx.log` |

前端处理：`fileLoaded / analysisResult / outFolderSelected`。前端自己维护 `statRows → displayRows`（排序/筛选），导出用的是 **displayRows**（即用户当前筛选排序后的结果）。

## 前端 canvas 图表要点（无图表库，纯手绘，`client.js`）

- **DPR 适配**：逻辑宽 `logicalW/logicalH` × `devicePixelRatio` 设 canvas 尺寸，绘制前 `ctx.setTransform(dpr,…)`。
- 柱状/折线：绘图区 260px 高，`padB` 随**最长 X 标签**自适应（竖直逐字绘制，不截断，外层 `.chart-scroll` 滚动看全文）；数值用 `fmtShort` 千分位。
- 饼图：按比例扇区 + 百分比标注（frac>4.5% 才标）+ 底部图例。
- **悬浮 tooltip 命中检测**：`hoverShapes[]` 存 rect / pie(用角度区间)，`mousemove` 命中后显示 `标签\n数值 (百分比)`。
- 图表换类型后同数据重画（`setupCanvas`）；导出 PNG 用**独立白底 canvas** 重绘 `logicalW×logicalH`。

## 维护注意

- `analyzeRows` / `exportStatToExcel` 已 `export`，可单独单测。
- 文件是模块级单例状态（`loadedFile`），一个时间只能分析一个文件，切工具再回来仍保留（client.js 里 state 也随 `window.toolClients` 保留，但 `init()` 会重置 state.filePath 显示，需留意）。
- 后端读取用 `raw:true`（日期取 Excel 序列号、数值取数字），与供应商模块 `importOrders` 的处理不同，别混用。
- 改后端 `index.ts` 需 `pnpm run compile`；改 client.js / fragment.html 直接 F5 重载。