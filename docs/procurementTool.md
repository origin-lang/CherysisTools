# 📦 供应商采购管理（procurementTool）

> 本页为模块主线文档；**单次迭代的功能/技术变更归档**（复制、删除规则、撤销重做、组合框等）见 [procurementTool-archive.md](procurementTool-archive.md)。

后端：`src/tools/procurementTool/index.ts` · 数据层：`src/tools/procurementTool/db.ts` · UI：`src/tools/procurementTool/fragment.html` · 前端：`src/tools/procurementTool/client.js`

**唯一有状态持久化的模块**：SQLite（`better-sqlite3`），数据库文件默认在扩展全局存储目录（跨工作区共享，可通过"导入/导出数据库"迁移备份）；**存放目录可用设置项 `cherysis.storageDir` 指定**（见 `docs/README.md` 的「数据存储」）。三个子 Tab：供应商档案 / 采购订单 / 分析。

数据模型（见 `db.ts`）：
- `suppliers`：id, name(唯一), free_shipping(0/1), relationship(待评估/进行中/已终止), quality_desc
- `orders`：id, order_no(唯一索引), supplier_id(FK references suppliers), pay_amount, receive_time, deadline, paid_amount, status(已下单/已签收/待退款/待退货/已结束)

## 使用流程与关键行为

### 供应商档案
- 行内双击编辑（text/bool/select）；底部「新增一行」可批量录入后保存；表头可排序（点击列头）、支持列头筛选；行内 🗑 删除（**无确认框，直接删**）；「删除选中」批量删除（**有订单关联的供应商会被跳过**并计入日志，因为 `db.deleteSupplier` 对有订单引用的厂商抛错）。
- 导入/导出 Excel；「导出数据库(.db)」「导入数据库(.db)」用于跨电脑同步。

### 采购订单
- 行内双击编辑（含供应商下拉选择、日期、状态）；「新增一行」；自动签收（一键填今天为签收时间、7 天后截止时间、状态改已签收，需确认）。
- **日期录入/导入规范**：所有日期统一存 `YYYY-MM-DD` 字符串。导入订单 Excel 时，`parseDate` 支持 Excel 序列号(46267)、`2026-08-14`、`2026/8/13`、`2026.8.13`、`2026年8月13日`；日期无法识别则**跳过该行**并打日志。行内/新增行的日期框也是文本输入 + 同款解析，非法不提交并打日志。
- **订单编号唯一**：库内已存在 / 本文件内重复的 `order_no` 都不导入，记入跳过日志；数据库层 `initDB` 尝试建 `idx_orders_order_no` 唯一索引兜底（历史库已有重复编号时静默跳过建索引，唯一性靠导入去重逻辑保证）。
- **导入订单跳过机制**：导入是「两遍扫描」——第一遍逐行校验并收集问题，第二遍真写库。缺供应商名 / 日期无效 / 编号重复 → 直接跳过；**厂商不在档案中 → 弹一次确认框列出缺的厂商名，点「确定」自动把缺的厂商按「待评估」加入供应商档案（日志 `➕已自建厂商:xxx(id=n)`）并继续导入，取消则跳过**。所有跳过都以「类别标题一行 + 明细每行一条」的**多行**日志输出，行号即原 Excel 行号（表头第 1 行）。
- 列头筛选：金额区间、日期区间、状态下拉；日期筛选基于字符串字典序（所以必须统一格式）。

### 分析
- 数据来源选订单/供应商，X 轴分组（供应商、状态、月份…），Y 轴统计（数量、付款总额、实付总额、平均付款）。
- 柱状图为内联 SVG，柱上有 `<title>` 悬浮显示 X 轴全称+数值。

## 消息协议

webview → 后端（`index.ts` handleMessage），回包基本都是「重新加载」型（全量推给前端重渲染）：

| type | 参数 | 回包 |
| --- | --- | --- |
| `loadSuppliers` | — | `suppliersLoaded {suppliers}` |
| `addSupplier` | `{name, freeShipping, relationship, qualityDesc}` | `ctx.log` + `suppliersLoaded` |
| `updateSupplierField` | `{id, field, value}` | `ctx.log` + `suppliersLoaded` |
| `deleteSupplier` | `{id}` | `ctx.log` + `suppliersLoaded`（无确认框） |
| `deleteSuppliers` | `{ids}` | 确认框 + `ctx.log`(含跳过数) + `suppliersLoaded` |
| `loadOrders` | — | `ordersLoaded {orders, suppliers}` |
| `addOrder` | `{orderNo, supplierId, payAmount, receiveTime, deadline, paidAmount, status}` | `ctx.log` + `ordersLoaded` |
| `updateOrderField` | `{id, field, value}` | `ctx.log` + `ordersLoaded` |
| `deleteOrder` | `{id}` | `ctx.log` + `ordersLoaded`（无确认框，行内按钮直接删） |
| `deleteOrders` | `{ids}` | 确认框 + `ctx.log` + `ordersLoaded` |
| `autoReceipt` | `{id, name}` | 确认框 + `ctx.log` + `ordersLoaded` |
| `undoRequest` | — | `ctx.log` + 重发全量 `suppliersLoaded` + `ordersLoaded`（无可用快照时只打日志） |
| `redoRequest` | — | `ctx.log` + 重发全量 `suppliersLoaded` + `ordersLoaded`（无可用快照时只打日志） |
| `exportDB` / `importDB` | — | `ctx.log`（导入后会重发全量 `ordersLoaded`；**成功即清空撤销/重做栈**，因为库已换） |
| `importSuppliers` | — | `ctx.log` + `suppliersLoaded` |
| `exportSuppliers` | — | `ctx.log` |
| `importOrders` | — | `ctx.log`（跳过明细按类分**多行**：编号重复/日期无效/厂商不存在/缺供应商名，行号即原表行号；厂商缺失可选自动加入档案）+ `ordersLoaded` |
| `exportOrders` | — | `ctx.log` |

所有重加载类回包现在都附带 `undoAvailable` 与 `redoAvailable`（分别为 `undoStack/redoStack` 非空），前端据此控制两个「↩ 撤销」与两个「↪ 重做」按钮的灰显。

前端处理：`suppliersLoaded / ordersLoaded`。选择集合（`sSel / oSel`）、筛选、排序、全选都由 client.js 维护，回包后按 id **过滤掉已不存在的选中项**。

## 前端要点

- 客户脚本里**每个新文件被 `loadSuppliers`/`loadOrders` 覆盖前先过滤选择集**，避免出现"选中项已删除"。
- 表头 `selAll` 复选框：勾选=选中所有**当前可见**（筛选后）行，取消=清空选择集（已修过 bug，勿回退）。
- 内联编辑器 `buildEditor`：select/date/number/text 分支；`commitInlineEdit` 对字段校验（厂商名非空、日期合法）；`redrawCell` 对 status 用 `<span class="status status-…">` 渲染。
- **厂商组合框** `buildSupplierCombo`（订单表「供应商」字段，行内编辑与新增行共用）：文本框 + 自绘 `.pm-sup-list` 候选下拉，支持输入即按**子串匹配**、`↑/↓` 键切换高亮、**Enter**（有高亮先填入再确认）、单击选中、失焦自动确认（仅行内）。提交时在 `commitInlineEdit`/`saveAddRow` 里用 `state.suppliers.find(s => s.name === 输入值)` 解析成 id，匹配不到打日志并中止。样式在 fragment.html（`.pm-sup-combo`/`.pm-sup-opt.active`）。
- 底部新增行 `startAddRow` 直接 append 一行假数据保存，加字段要同步改 `saveAddRow` 的读取。
- **右键复制**：表格区右键出自定义菜单——点数据格：复制整行 / 整列 / 整表；点列头：复制整列 / 整表。输出为 TSV（可直接粘进 Excel），来源是 `state` 里的完整值（不受行内省略号截断影响），范围 = 当前筛选+排序后的可见行，仅含数据字段列（不含复选框列/操作列）。复制走 `navigator.clipboard`，失败回退临时 textarea + `execCommand('copy')`；成功弹出角标提示。

## 维护注意

- **数据库单例**：`db.ts` 用模块级变量持有单例连接；`initDB(storageDir)` 建表，`getDB()` 每次返回新包装对象但共享连接。`importDB` 会 `closeDB()` 换文件再重连。
- **撤销/重做（快照双栈）**：后端内存栈 `undoStack` / `redoStack`（各上限 30），每条是某次改动**之前**的 `{suppliers, orders}` 全量快照。所有**改动类**消息（新增/双击编辑/删除/批量删除/自动签收/两个 Excel 导入）都在成功后 `pushUndo(snap, desc)`（失败不压栈），并清空重做栈（新改动即作废重做分支）；`undoRequest` 弹出撤销栈顶、把**当前状态**压入重做栈后 `db.restoreAll()` 回插；`redoRequest` 对称地先 `pushUndo(当前, desc)` 再恢复重做栈顶。restoreAll 用 SQLite 自增计数自动跳高，不会与新行撞 id。两栈仅存内存，面板重开即清；`importDB` 成功会清空（避免用旧库快照）；`updateSupplier`/`updateOrder`（旧消息）也纳入撤销但前端未使用。
- 供应商 `name` 唯一约束（`assertNameUnique`），重复会抛错；订单 `order_no` 唯一索引在 `initDB` 里 try/catch（历史重复时跳过，不阻塞初始化）。
- 分组日志辅助函数 `logGroup(header, items, log)`：多行输出跳过明细，改导入日志格式时复用。
- 后端日期解析有两个实现：`index.ts` 的 `parseDate`（导入）与 client.js 的 `parseDateInput`（前端录入），改格式必须**两处同步**。
- 分析图表是内联 SVG（不是 canvas），改样色走 `barColor = "#23a884"`。
- 改后端 `index.ts`/`db.ts` 需 `pnpm run compile`；改 client.js / fragment.html / 存储目录配置 直接 F5 重载。