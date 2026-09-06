# 📦供应商采购管理 · 功能与技术归档

归档时间：2026-09
归档对象：procurementTool（📦供应商采购管理）本期全部新增/调整的功能及其技术实现。
对应代码：`src/tools/procurementTool/`（`index.ts` 后端 / `db.ts` 数据层 / `client.js` 前端 / `fragment.html` UI），主线文档见 `docs/procurementTool.md`。

---

## 一、本期功能清单

### 1. 表格右键复制「整行 / 整列 / 整表」（新增）
- **行为**：在任一数据表格上右键弹出自定义菜单——
  - 点「数据格」：复制整行 / 整列 / 整表；
  - 点「列头」：复制整列 / 整表。
- **输出格式**：TSV（Tab 分隔），可直接粘进 Excel。
- **数据来源**：`state` 里的完整值（不受单元格省略号截断影响）；范围 = 当前筛选 + 排序后的可见行；仅含数据字段列（排除复选框列 / 操作列）。
- **复制通道**：`navigator.clipboard`，失败回退临时 `textarea + execCommand('copy')`；成功在右下角弹 toast 角标提示。
- **入口文件**：`client.js` → `attachContextMenu` / `showContextMenu` / `copyRowAsTsv` / `copyColumnAsTsv` / `copyTableAsTsv` / `copyToClipboard` / `showToast`；样式与容器 `.ctx-menu` / `.toast` 在 `fragment.html`。

### 2. 删除确认规则调整（行为变更）
- **行内删除按钮**（供应商 / 订单操作列）：**不再弹确认框**，直接删。
- **勾选 + 顶部「删除选中」**：**保留二次确认**（批量误删风险高）。
- **删除日志带标识**：单删日志带「订单号 / 厂商名」，批量删除列出被删名称用 `joinList` 截断（上限 8 条，超出显示 `等 n 个`），方便核对。
- **入口文件**：`index.ts` → `deleteOrder`（去确认框）、`deleteSuppliers`、`deleteOrders`、`joinList`（行 702）。

### 3. 撤销（Undo，带回退动作描述）
- **入口**：每个 Tab 工具栏「↩ 撤销」（`pm_btnUndo` / `pm_btnUndoOrders`），无可用快照时灰显。
- **行为**：恢复「上一步操作之前」的整库状态，日志打印 `↩ 已撤销：<动作描述>`；描述来自 `FIELD_LABELS`（字段 key → 中文名）+ 动作模板，如 `删除订单「PO-xxx」`、`修改订单「PO-xxx」的「签收时间」`。
- **已纳入撤销的改动类消息**：新增/修改供应商、新增/修改订单、删除/批量删除（两类）、自动签收、两个 Excel 导入（`updateSupplier` / `updateOrder` 旧消息也纳入但前端未用）。

### 4. 重做（Redo）
- **入口**：工具栏「↪ 重做」（`pm_btnRedo` / `pm_btnRedoOrders`），无可用快照时灰显。
- **行为**：抵销上一次撤销，日志打印 `↪ 已重做：<动作描述>`；撤销 ↔ 重做可来回切换。
- **补充**：撤销 ≠ 重做（两个按钮）。界面上的"回退"就是撤销（Undo），"重做"是撤销的逆操作（Redo，Excel 的 Ctrl+Y）。已与用户确认语义。

### 5. 订单表「供应商」组合框（可输入 + 自动匹配 + 键盘选择）
- **行为**：「新增一行」与「双击单元格编辑」里的供应商字段，从纯下拉 `<select>` 改为**文本框 + 自绘下拉候选**：
  - 输入即按**子串匹配**（不区分大小写）过滤候选；
  - **↑/↓ 键**切换高亮（循环），**Enter** 在有高亮时先填入再提交；
  - 单击候选选中；失焦自动确认（仅行内编辑）；
  - 提交时用 `state.suppliers.find(s => s.name === 输入值)` 把名字**解析成 id** 入库；匹配不到打日志并中止，不会写入脏数据。
- **入口文件**：`client.js` → `buildSupplierCombo(commit, cancel, blurCommit)`（行 477）；行内编辑在 `buildEditor` 的 `supplierSelect` 分支、`commitInlineEdit`；新增行在 `makeAddRowControl`、`saveAddRow`。样式 `.pm-sup-combo` / `.pm-sup-list` / `.pm-sup-opt.active` 在 `fragment.html`。

### 6. 供应商行内删除按钮图标化
- 操作列删除按钮由「🗑删除」改为纯图标「🗑」，悬停 `title="删除"`（订单表本就是纯图标，两表风格统一）。

---

## 二、技术实现与决策

### 1. 消息协议增量
后端 → 前端 `postAll()` 统一回推，全量重加载回包新增两个可用性字段：
```
{ type: "suppliersLoaded", suppliers, undoAvailable, redoAvailable }
{ type: "ordersLoaded",    orders,    suppliers, undoAvailable, redoAvailable }
```
前端 → 后端新增两条消息：`undoRequest`、`redoRequest`（各带 `toolName: "procurementTool"`）。
前端 `onMessage` 里 `undoAvailable` / `redoAvailable` 各自独立更新（`undefined` 时保留当前值，兼容旧回包），再统一刷新 4 个按钮的灰显。

### 2. 撤销 / 重做双快照栈（核心机制）
```
UNDO_LIMIT = REDO_LIMIT = 30（内存栈）
undoStack: 每条 = 某次改动「之前」的 { suppliers, orders, desc }
redoStack: 撤销时压入「当前状态」，供重做取回
```
- **记录时机**：所有改动类消息在 `db` 写入**成功后** `pushUndo(snapIt(), desc)`（失败不压栈，不污染历史）；每次 push 后 `redoStack.length = 0`（产生新分支即作废已撤销的分支，同 Excel 规则）。
- **Undo**：`undoStack.pop()` → 先把 `snapIt()`（=当前整库状态）压入 `redoStack` → `db.restoreAll(snap.suppliers, snap.orders)`（失败只打日志不退出，最后统一 `postAll()`）。
- **Redo**：`redoStack.pop()` → 先 `pushUndo(snapIt(), desc)`（这样撤销一个重做还能退回来）→ `restoreAll`。
- **快照为何不深拷贝**：`getSuppliers()/getOrders()` 每次都是新查询返回新对象，直接存引用即可。
- **恢复如何不撞 id**：SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` 会跳到「历史最大值 + 1」，按原 id 回插不会与后续新行冲突。
- **生命周期**：两栈仅存内存，面板关闭 / 扩展重载即清空；`importDB` 换库成功后**两栈同时清空**（旧库快照对新库无效）。
- **数据层**：`db.ts` 新增 `restoreAll(suppliers, orders)`，实现为事务（`d.transaction`）：清空两表后按原 id 批量回插，原子生效。

### 3. 组合框自绘（放弃 native datalist 的原因）
- 原生 `<datalist>` 在 Chromium WebView 里**只弹一次式候选、不支持 ↑/↓ 键盘导航**，不满足"输入快 + 键盘选"需求 → 改为自绘下拉。
- 组件要点：
  - `buildSupplierCombo` 返回一个 `.pm-sup-combo` 容器 div，内含 `input.cell-input` + `div.pm-sup-list`（候选列表）。
  - 容器 div 用 `Object.defineProperty(wrap, "value", { get/set })` 代理内层 input 的值，这样 `commitInlineEdit` / `saveAddRow` 的 `read(key)`（`el.value`）无需区分控件类型。
  - 新增行里给容器设 `dataset.f = def.key`，`saveAddRow` 的 `tr.querySelector('[data-f="supplier_id"]')` 取到容器再从 `value` 拿文本。
  - 候选查找：`state.suppliers.filter(s => s.name.toLowerCase().includes(输入.toLowerCase()))`（子串匹配，空输入 = 全列表）。
  - 键盘：`ArrowDown/ArrowUp` 循环移动高亮（`scrollIntoView({block:"nearest"})` 保证可见）；`Enter` 先 `choose(highlight)` 填入再 `commit()`；`Escape` 关闭并 `cancel()`；`Tab` 仅收起。
  - 鼠标：候选 `onmousedown → e.preventDefault()`（防止 input 先失焦闭表）再选择；`onmouseenter` 同步高亮。
  - 失焦：`setTimeout 150ms` 后收表；仅行内编辑时（`blurCommit=true`）顺带 `commit()`。
  - `list.hidden` 边做开关；渲染时 `items`、`highlight` 全量重建，避免残留高亮。
- **地址栏注意**：下拉列表绝对定位在容器下方（`.pm-sup-list`），`z-index:80` 高于表格本身；`data-table` 外层若套滚动容器，列表可能被裁切（WebView 内效果可接受）。

### 4. 右键复制实现要点
- 菜单是**页面级单例**：`pm_ctxMenu` 容器复用，点菜单项/再点其他地方/滚动时关闭（`hideContextMenu`），避免堆叠。
- TSV 生成：按「表头 + 可见行」遍历，单元格取 `state` 完整值而非 DOM 文本；`supplier_id` 列先转成厂商名再导出（`supplierNameOf`）。
- `copyToClipboard(text, msg)`：优先 `navigator.clipboard.writeText`，`catch` 后建临时 `textarea`（`display:fixed`、透明）`select()` + `document.execCommand("copy")`，两种都成功才 `showToast(msg)`。

### 5. 删除业务规则（防悬空引用）
- 数据库层 `deleteSupplier` 若厂商存在关联订单会 `throw`（`db.ts` 行 172）；`deleteSuppliers` 批量时逐个 try，跳过关联厂商并汇总 `skipped` 数量。
- 前端校验先行：批量删除（选中供应商 / 订单）先弹 `ctx.confirm`，确认后前端清选择集再发后端。

---

## 三、维护要点 / 易踩坑

1. **编译分隔（重要）**：`index.ts` / `db.ts` 改动需 `pnpm run compile`（产物在 `out/`）；`fragment.html` / `client.js` 由后端运行期直接读 `src/`，改完 **F5 重载扩展** 或切走再切回即可生效。本期改过 `index.ts`（重做）→ 已编译通过。
2. **组合框勿回退到 datalist**：键盘导航是需求硬约束，`datalist` 不满足；如后续要「防抖加载远程厂商」，扩展点仍在 `buildSupplierCombo` 的 `matches` / `render`。
3. **加字段联动**：`SUPPLIER_FIELDS / ORDER_FIELDS` 增列时，同步改 `buildEditor`（若 supplierSelect 类似字段）、`makeAddRowControl`、`saveAddRow`、`commitInlineEdit`、右键复制的列集合（自动按字段定义生成，无需多改）、批量删除。组合框仅订单表 `supplier_id` 使用。
4. **撤销水位**：每动作存全库快照，30 条上限即「最多回退 30 步」；若库存超大，快照内存占用会线性上涨，需关注（当前量级无压力）。
5. **语义备忘**：界面按钮「撤销」= Undo、「重做」= Redo；用户语境里"回退"通常指 Undo。
6. **后端 `joinList`** 在 `index.ts` 行 702，修改批量删除日志格式时复用，勿在两个位置各写一份截断逻辑。

---

## 四、验证结论（归档时快照）

- `pnpm run compile`：通过（`tsc -p ./` 无报错）。
- `out/tools/procurementTool/index.js` 已含 `redoStack` / `redoRequest` / `redoAvailable` / `restoreAll`。
- `node --check client.js`：通过。
- 前端改动待人工 F5 后验收：复制菜单、撤销/重做按钮灰显与日志、组合框键盘导航、删除按钮图标、行内删除无确认框。