# 📊 Excel清洗统计绘图（excelAnalyzeTool）

后端：`src/tools/excelAnalyzeTool/index.ts` · UI：`src/tools/excelAnalyzeTool/fragment.html` · 前端：`src/tools/excelAnalyzeTool/client.js`

通用数据分析工具：读 Excel/CSV → 选列 + 正则分组清洗 → 聚合 → canvas 图表 → 可筛选排序的结果表 → 导出 Excel/PNG。**后端持有已加载文件**（模块级 `loadedFile` 跨消息保留）。

## 使用流程（用户视角）

1. 选文件（支持 xlsx/xls/csv，只读**第一张工作表**）→ 显示行数与字段列表，X 下拉填充、Y 列勾选列表（**自动勾选第一列**，可直接执行）。
2. 配置：X 轴原始列、Y 轴数值列（可多选）、分组正则（可多条，可加可删）、聚合方式（求和/计数/平均值）、图表类型（柱状/折线/饼图）、正则匹配失败处理策略。
3. 「▶ 执行分析并绘图」→ 左侧结果表 + 右侧图表同步出现。
4. 结果表可点表头排序（X 或任一数值列）、X 标签筛选、数值筛选（可下拉选择作用于哪一列；支持 `>100`、`>=N`、`10-50` 区间、纯文本包含）。
5. 选导出目录 → 「导出统计表格Excel」「保存图表PNG」。

## 清洗/统计核心（后端 `analyzeRowsMulti`）

- **分组规则**：按数组顺序编译，每条正则命中即用其**第 1 个捕获组**（无捕获组用整串）作分组标签，命中的行不再参与后续规则。规则为空时：原文即标签，恒为匹配成功。
- **失败处理（仅在有规则时生效）**：`success_only` 只看成功 / `fail_only` 只看失败 / `separate` 都看，失败行以其原始文本成组（key=null 归空串） / `merge_other` 都看，失败行归为「其他」。
- **多 Y 列**：勾选多个数值列时逐列聚合，`sum/mean` 每列独立 dropna（一行所有列都缺才整行跳过）；`count` 只数行数、**与 Y 列无关**（不选列也能跑）。
- 结果降序（按第一列聚合值）输出 `MultiStatRow {xName, data[]}`，`data[i]` 与 `yHeaders[i]` 一一对应；`analyzeRows` 为单列委托包装。

## 消息协议

webview → 后端：

| type | 参数 | 后端回包 |
| --- | --- | --- |
| `selectFile` | — | `fileLoaded {filePath, columns, rowCount}` |
| `runAnalysis` | `{xCol, yCols:[…], rules:[{regex}], aggType, chartType, invalidMode}`（兼容旧单列 `yCol`；count 时可无 `yCols`） | `clearLog` + `analysisResult {statRows, xHeader, yHeaders, yCols, chartType, rowCount}` |
| `selectOutFolder` | — | `outFolderSelected {path}` |
| `openTargetFolder` | `{targetPath}` | `ctx.log` |
| `exportExcel` | `{outDir, statRows, xHeader, yHeaders}` | `ctx.log` |
| `saveChart` | `{outDir, dataUrl}`（`data:image/png;base64,…`） | `ctx.log` |

前端处理：`fileLoaded / analysisResult / outFolderSelected`。前端自己维护 `statRows → displayRows`（排序/筛选），导出用的是 **displayRows**（即用户当前筛选排序后的结果）。

## 前端 canvas 图表要点（无图表库，纯手绘，`client.js`）

- **DPR 适配**：逻辑宽 `logicalW/logicalH` × `devicePixelRatio` 设 canvas 尺寸，绘制前 `ctx.setTransform(dpr,…)`。
- 柱状/折线：绘图区 380px 高，`padB` 随**最长 X 标签**自适应（竖直逐字绘制，不截断，外层 `.chart-scroll` 滚动看全文）；数值用 `fmtShort` 千分位。
- **多系列（勾选多 Y 列）**：柱状=分组柱、折线=每列一条线；顶部绘制**画布内图例条**（随 PNG 导出），点击可切换某列显隐（隐藏显示划杠+半透明，图例始终列出全部列以便复显）；饼图只用第 1 列、图例不可点击。
- 饼图：按比例扇区 + 百分比标注（frac>4.5% 才标）+ 底部图例。
- **悬浮 tooltip 命中检测**：`hoverShapes[]` 存 rect / pie(用角度区间) / legend，`mousemove` 命中后显示 `标签\n数值 (百分比)`；命中柱/点时列出该行所有可见系列值，命中图例提示"点击显示/隐藏"。
- 图表换类型后同数据重画（`setupCanvas`）；导出 PNG 用**独立白底 canvas** 重绘 `logicalW×logicalH`。

## 维护注意

- `analyzeRows` / `analyzeRowsMulti` / `exportStatToExcel` 已 `export`，可单独单测。
- 文件是模块级单例状态（`loadedFile`），一个时间只能分析一个文件，切工具再回来仍保留（client.js 里 state 也随 `window.toolClients` 保留，但 `init()` 会重置 state.filePath 显示，需留意）。
- 后端读取用 `raw:true`（日期取 Excel 序列号、数值取数字），与供应商模块 `importOrders` 的处理不同，别混用。
- 改后端 `index.ts` 需 `pnpm run compile`；改 client.js / fragment.html 直接 F5 重载。