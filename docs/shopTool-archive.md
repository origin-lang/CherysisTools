# 🏪商品店铺管理 · 功能与技术归档

归档时间：2026-09
归档对象：shopTool（🏪商品店铺管理）上架后阶段新增/调整的功能及其技术实现。
对应代码：`src/tools/shopTool/`（`index.ts` 后端 / `db.ts` 数据层 / `client.js` 前端 / `fragment.html` UI），主线文档见 `docs/shopTool.md`，配套测试数据见 `docs/shopTool测试数据/`。

---

## 一、本期功能清单

### 1. 封面图改为 base64 按需下发（重构）
- **背景**：原先注册 `cherysis-img://` webview 资源 scheme + `IMG_MIME`，要求图片目录在本机且依赖 webview 资源白名单，切工具/换目录易失效。
- **行为**：封面与放大看图都改走 **base64 按需下发**（与 lightbox 同一机制）：
  - 列表/画册只发**封面**（文件夹内数字排序第一张）；点开才拉全部图；
  - `uploadImages` / `clearImages` 后调 `invalidateCover(code)` 清缓存 → 前端**即时**变新封面/无图，不需要重开面板；
  - 任意图片目录都能用，无白名单限制。
- **删除**：ext 层移除 `registerWebviewImageScheme` + `IMG_MIME` + 相关 fs/path import。

### 2. 编号统一 3 位补零（+ 存量迁移）
- **规则**：`canonicalCode(n)` = `L` + 数字 `padStart(3,"0")`，范围 1~9999（`L7→L007`、`L76→L076`、`L1044→L1044`）。前后端各一份实现。
- **一次性迁移块**（首次加载时跑，`codeMigrated` 标记）：把存量 `products.code` 补零，并把图片文件夹 `L76`→`L076`（`fs.renameSync`，目标已存在则跳过）。注意迁移块里**直接 `db.getSetting("image_dir")`**，不能引用声明在它后面的 `imageDir()`（TDZ 坑）。

### 3. 每日销售「自动刷新」（修复 stale 数据 bug）
- **根因**：`saveSale/pasteSales/deleteSales` 都在 **db 写入前** `replySales(date)`（发旧数据），且 `loadAll()` 不推 `salesLoaded` → 表格永远停留在旧数据，要删一行才「全部更新」。
- **修复**：新增 `refreshSales(date)`（写入后 `db.getSales(date)` 重发 `salesLoaded`），在 saveSale / pasteSales / deleteSales / deleteProduct 的写入**之后**调用；`replySales` 只保留给 loadAll / loadSales 这类「加载」消息。
- 顺带修了 `updateQuickLog`：原来 `find()` 只取第一条，同一商品当天合并成一条记录后会显示错；改为按 code 求和 sold/refund 并显示「今日共 N 条记录」。

### 4. 每日销售表格 UX（表头 / 批量删 / 刷新按钮）
- 表头改为：勾选框 ｜ 编号 ｜ 名称 ｜ 卖出数量 ｜ 退款数量 ｜ 净售数量 ｜ 进价快照 ｜ 备注 ｜ 操作。
- 首列勾选框 + 表头「全选」；标题栏新增「🔄 刷新」「删除选中」按钮（选中 >0 才可用，文案带数量）。
- `进价快照` 列头/单元格带 tooltip：记录当天成交进价，之后改进价不影响历史记录与月报。
- 表格加竖向分隔线（`.data-table th/td { border-right }`），选中行高亮（`tbody tr.sel td`）。
- 产品列表**不做**批量删除（用户倾向用「下架」）。

### 5. 等级无规则时自动创建默认规则
- `db.ensureRule(grade)`：等级 1~99 且无规则时插入 `cost*1.5` + 尾数 `p88`，label `等级N`（`INSERT OR IGNORE` 语义，存在则不动）。
- 调用点：`addProduct`、`importProducts`、`updateProductField` 的 grade 分支。自动建规则时打日志「ℹ️等级 N 无规则，已自动创建默认规则」。
- 导入时注意 `db.getRules()` 要**在 ensureRule 之后重新拉取**（否则用的还是旧规则数组）。

### 6. 导入 / 粘贴表头识别（任意行）
- 原来只跳过第 0 行：`if (i === 0 && /…header…/i)`。
- 现在**任意一行**首格命中 `编号|名称|商品|code|id|品类|类别|分类|系列|等级|成本|进价|售价|数量|库存|状态|采购|备注` 即整行跳过。商品导入与粘贴销售两处逻辑同步。

### 7. 筛选改为回车触发
- `bindFilterRow`：`oninput` 只更新 `filters` + 控制「清除筛选」按钮可见性；**Enter** 才 `renderProducts()`（避免每敲一个字符全表重建）。

### 8. 字段显示弹窗按当前视图
- `openColSet` 不再同时渲染 list + gal 两组；按当前 `viewMode` 只显示**当前视图**的字段，两份配置仍分开存（`col_visible_list` / `col_visible_gallery`）。

### 9. 粘贴结果明细 + 月报/趋势使用提示
- 后端 `pasteResult` 新增 `badLines` 字段；前端 hint 显示 `新增X 更新Y 跳过Z，未匹配：…，无法解析 N 行：…`。
- 新增商品状态过滤在筛选行体验重复 → **已撤掉**（保留顶部「状态」下拉）。
- 每日销售、月报、销售趋势面板各加了一句 muted 用法提示。

### 10. 销售趋势修复（两个 bug）
- **后端**：`trendDay` 有 3 个占位符（`date LIKE ? AND (? IS NULL OR product_id = ?)`）但只传 2 个参数 → better-sqlite3 抛 `Too few parameter values were provided`。改为 `trendDay.all(month+"%", pid, pid)`。`trendMonth` 本就有 2 参对 2 占位，正常。
- **前端**：后端只回 `{period, sold, refund}`，`renderTrend` 却拿 `r.net` 画图（undefined→NaN 画不出）。改为前端 `net = sold - refund` 再画。

### 11. 测试数据
- `docs/shopTool测试数据/`：`import_products.tsv`（100 行，含手动价/采购链接/等级 1-3，等级 4 触发自动建规则）、`paste_sales.tsv`（含同批重复、退款、空号 L888、坏行 `ax243 2`）、`测试指引.md`。
- 图片样本在 `C:\Users\YFF\Desktop\图片\测试商品店铺管理\`（L001~L100 文件夹 + 封面；L050/L077 无图、L002 旧命名 `L2_1.jpg`、L003 24MB 大图，用于回归）。

### 12. ⭐直播排品（新增子功能）
- **场景**：直播带货前按「九宫格拼图」排品——画册星标选出一批商品 → 九个一组排到格子（顺序=手填编号）→ 每张直播图生成九宫格大图，格子底部标注 `N号 L001`，同时复制一份货源清单（编号/名称/售价/采购链接）。
- **选品**：商品管理「画册」卡片左上角新增 ⭐/☆ 按钮（列表「操作」列也有），点星加入/移出备选；备选持久化在 `live_star` 表。
- **排品页**：新增子页签「⭐直播排品」：
  - 上半：已选商品 chips（带 🗑 移除）；
  - 下半：九宫格格子，**全局编号跨组连续**（组1=1~9号、组2=10~18号…），每格手填编号（自动补零、失焦校验：不存在标红、重复标黄、合法变绿）；
  - 工具栏：「＋ 加一组 / 删组 / 清空格子 / 输出目录 / 复制清单 / 生成九宫格 + 复制清单」。
- **生成**：每格取商品**第一张图（封面）**，缺图灰底占位；一个非空组输出一张 `{起始}号-{结束}号_YYYYMMDD.jpg`（如 `10号-18号_20260906.jpg`）；生成后自动把清单写入剪贴板并打开输出文件夹。
- **输入防抖**：cfg 填充防抖保存（350ms，`scheduleLivePlanSave`），避免每个字符一次全表重写。

### 13. 800 商品压测数据（seedShopProducts.cjs）
- **动机**：验证画册卡片在 800 商品规模下的性能（含封面懒加载）。
- **脚本** `scripts/seedShopProducts.cjs`：**只插入、绝不删改现有数据**；读 shop.db 现行 `sale_rules` 按 `calcPrice` 逻辑复刻「成本→售价」（成本 ¥5~¥64，等级 1-3 随机）；新商品**无图片文件夹、无采购链接**。
- **用法**：`node scripts/seedShopProducts.cjs [dbPath] [targetTotal]`。
- **结果**：100 → 总 800（新 L101~L800）。⚠️ 这些压测商品别混进正式直播排品图。

---

## 二、技术实现与决策

- **封面 on-demand 缓存**：`index.ts` 用 `coverCache: Map<code, string>` + `getCoverMsg` 组装 `{type:"coverLoaded", code, dataUrl}`；上传/清空时 `invalidateCover(code)` 删除缓存条目。避免把全部图一次性塞进 postMessage。
- **迁移块位置**：放在 handleMessage 里 `initDB()` 之后；「补零 + 文件夹改名」都需要读 `image_dir`，而 `imageDir()` 声明在后面 → 直接 `db.getSetting("image_dir")` 读。
- **同名文件夹迁移防冲突**：`L76`→`L076` 若目标已存在跳过（已迁移或用户自建），日志提示手动处理。
- **刷新推送时机约定**：`refreshSales(date)` 必须写在**写入成功后**，且要重新 `db.getSales(date)` 而不是复用旧引用。
- **ensureRule 幂等**：`INSERT OR IGNORE` 语义（实现用先查 `rulesList.all()` 有无该 grade），重复调用返回 false 不打日志。
- **筛选 Enter**：回车只触发 `renderProducts()`；输入框值由 `filters` 对象在重建表头时回填，不会丢。
- **批量删除**：前端 `selSales: Set<id>`，全选/单选 toggle 行高亮；「删除选中」二次 `confirmBox`；后端 `deleteSales` 本就支持 `ids: number[]`。
- **直播排品数据层**：`live_star(code PK)` + `live_plan(group_no, slot_no, code, PK(group_no,slot_no))` 两张表；商品删除时同步清掉孤儿星标/格子（`deleteProduct` 内按 code 清理）。
- **直播排品消息协议**：`toggleLiveStar / setLiveStars / saveLivePlan / clearLivePlan / pickLiveOutDir / generateLiveGrid`；`loadAll` 会带 `liveState {stars, plan, outDir}`；`saveSettings` 白名单新增 `live_out_dir`。
- **九宫格合成（sharp）**：`renderLiveGrid` 单次 `composite` 完成「拼图 + 标注」——canvas 白底（tile 尺寸取第一张有效图，缺省 300）→ 逐个叠 cell 图（`resize fit:fill` 或灰底 SVG `无图`）→ 再叠每格 `N号 L001` 标注 SVG（白字黑描边，`paint-order="stroke fill"`）；`labelSvg` 的 stroke-width = `max(14, fs*0.32)` 兜底小字描边。
- **输出目录「都选」**：记忆 `live_out_dir` + 每次生成前 `ctx.confirm` 确认「还用上次目录吗」，取消则 `ctx.selectFolder` 重选。
- **前端焦点保护（本次的关键坑）**：格子输入是按字符触发输入的，若每条 keystroke 或每次 `liveState` 回包都重建网格会**丢失焦点/正在输入的文本**。两个对策：
  1. 输入只在 `oninput` 里更新本地 state + 防抖保存，**不重建网格**；
  2. `renderLiveGrid` 顶部 `if (area.contains(document.activeElement)) return;` —— 编辑中跳过整体重绘（但 chips / 输出目录标签照常更新）。
- **后端消息类型校验**：`generateLiveGrid` 用前端传来的 `plan`，先 `db.replaceLivePlan(plan)` 再按 `group_no` 分组生成；只生成**非空**组，缺图补灰格、空格不补。

---

## 三、维护要点 / 易踩坑

1. **编译分隔**：`index.ts` / `db.ts` 改动需 `pnpm run compile`（产物 `out/`）；`client.js` / `fragment.html` 改完 **F5 重载扩展**（或切工具）即生效。
2. **不要给销售表按「任意行表头」加太多关键字**：首格命中关键词即整行跳过，误伤规则见第 6 条清单；如果未来要支持「首列即名称」的导入格式，先想清楚与表头识别的冲突。
3. **`ensureRule` 后必须重新 `db.getRules()`**，导入循环里别复用循环外的旧 `rules` 数组。
4. **趋势 SQL 占位符个数要对**：`(? IS NULL OR x = ?)` 里 `? IS NULL` 那个也要**传值**（`null` 即可），better-sqlite3 按占位符个数严格校验；前端画图字段要用后端真实返回的 key（`sold/refund/period`），别用不存在的 `net`。
5. **粘贴 sales 同批重复编号会被忽略**（`seen` Set），跨批次才按模式 upsert——测试指引的「今日合计」数字要按这个口径算，别再按文件原始行数算。
6. **刷新按钮 = loadSales 消息**（后端在有/无锁定下都安全，只是"重新读"），批量删除/单删提交的是 `deleteSales {ids}`。
7. **直播排品坑**：
   - 格子输入**不要**在 `oninput` 里重建网格（丢焦点），只本地更新 + 防抖 `saveLivePlan`；
   - `renderLiveGrid` 回报 `liveState` 时先判「网格内是否有焦点在编辑」，有则跳过重绘；
   - `saveLivePlan` 会清掉空格子（后端只存非空）；**没有自动补空组**——删掉空组会保持删掉；手动填满一组后要么点「＋ 加一组」，要么点备选商品（`findNextEmptySlot` 无空格时自动开下一组）；
   - `deleteProduct` 已顺带清理 `live_star` / `live_plan`，无需前端额外处理；
   - `seedShopProducts.cjs` 是**纯插入**脚本，绝不会更新/删除现有商品；
   - sharp 合成标注放最后叠（数组顺序即 z 序），`N号 L001` 要盖在图之上，别插到 cell 层前面。

---

## 四、验证结论（归档时快照）

- `node --check src/tools/shopTool/client.js`：通过。
- `npx eslint src/tools/shopTool/{client.js,index.ts,db.ts} --fix`：通过（无 error）。
- `pnpm run compile`：通过（`tsc -p ./` 无报错）。
- `pnpm run lint`：仅剩 `excelAnalyzeTool/client.js` 的 pre-existing curly 警告（非本次引入）。
- 人工验收点：Reload Window 后 —— 封面/上传/清空即时生效；旧库自动补零 + 文件夹改名；录/粘/删销售表格自动刷新；批量勾选删除；筛选回车触发；等级 4 导入自动建规则；pasteHint 列出坏行；字段显示按当前视图；销售趋势按月 / 按日都能出图。
- 直播排品人工验收点（新增）：画册卡片 ⭐ 切换即时高亮 → 「⭐直播排品」页 chips 同步 → 填格自动补零/失焦校验（不存在标红、重复标黄、合法变绿）→ 「生成九宫格 + 复制清单」出图（文件名 `N号-M号_YYYYMMDD.jpg`、格底 `N号 L001` 标注、缺图灰格）→ 清单已复制 → 输出目录记忆 + 生成前确认可换 → 800 商品规模下画册滚动不卡。

---

## 五、直播排品收尾 + 全局 Toast（2026-09-06 第二波迭代）

### 本期功能清单

1. **「删组」恢复可用**：之前点删组"没反应"，两个根因叠加——
   - `renderLiveGrid` 的焦点守卫 `area.contains(document.activeElement)`：点按钮后按钮占焦点，被误判成"正在编辑"而跳过重绘；
   - 前端 `ensureLiveEmptyGroups` 每次数据回传都自动补一个末尾空组：删掉空组后又被补回来（"删完又出现"）。
   两处都修：守卫改为只看 `activeElement.closest("[data-ls-cell]")`（只有真在填输入框才跳过重绘）；彻底移除 `ensureLiveEmptyGroups`，**删掉就保持删掉**。
2. **每组一个「🖼 生成这组」按钮**（组头右侧，绿底）：只重出这一组的九宫格图、只复制这组清单——排品错了改完这一组随手重出；顶部按钮改为「生成全部九宫格」。
3. **星标 ↔ 九宫格联动**：点备选商品芯片 = 按**全局编号**填进下一个空格（底部 toast 提示 `L012 → 40号`）；满组时 `findNextEmptySlot` 自动开下一组；排品顺序 = 点击顺序，仍可手填微调。芯片悬停有绿色边框 + hover 提示。
4. **橙色含义 + 图例**：格子三态校验 🟩绿=有效编号 · 🟥红=编号不存在 · 🟧橙=**同编号出现≥2次（排品重复）**。九宫格面板下加图例文案，重复格悬停提示"请检查是否填重了"。设计原则：一批直播图里同一商品出现两次多半是填错，提前标黄提醒待人工确认。
5. **800 商品补图 `scripts/seedProductCovers.cjs`**：遍历 `products`，缺图编号文件夹自动创建并写入一张 400×400 JPEG（HSL 色块底 + 居中编号 + "测试商品封面"），已有图的文件夹跳过；本次 800 个商品里补了 701 张，全部有封面，用于画册滚动性能测试。
6. **全局 Toast（跨工具，不只店铺管理）**：每次操作的运行日志之外，前端底部中央再弹一个**气泡，约 2 秒自动消失**——与直播排品的 `L012 → 40号` 同款。

### 技术实现与决策

- **Toast 由后端 `ctx.log` 统一触发**（`toolContext.ts`）：日志若以 `RESULT_MARKERS`（`✅❌✏️🗑🔻🔺📐📦📝📥🖊⭐☆🖼🔒🔓⚙📁⚠ℹ⏭↩↪➕`，按首码点匹配）开头，视为「操作结果」，额外 `postToWebview({type:"toast", text: 首行})`。**所有工具零改动**即自动获得气泡；避免噪音：缩进行（如 `  ⚠️…`）、纯文本行（`== 本轮合计`）、无符号前缀（`[失败]…`）不弹。
- **后端多行结果只弹首行**：`text.split("\n")[0]`，导出的明细第二行不进气泡。
- **唯一渲染点 `main.html`**：单一 `#shToast` 元素 + `showGlobalToast()`（暴露为 `window.showGlobalToast`），`handleMessage` 分支处理 `type:"toast"`。新工具/新消息无需改客户端脚本。
- **客户端 toast 统一委托**：shopTool `toast()`、procurement `showToast()`、order1688 `showToast()` 开头都改为 `if (window.showGlobalToast)` 直接委托——避免同一操作同时弹两个气泡叠底（旧 `.toast` / `#pm_toast` / `#o8_toast` 元素已闲置，保留未删）。
- **星标填格** `findNextEmptySlot`：从 `livePlan` 建 occupied 集合，遍历 `group_no 1..maxG+1`、槽位 1..9 找第一个未占全局编号；`upsertLiveSlot` + 防抖保存 + `renderLiveGrid`（后置位无输入焦点，重绘安全）。
- **每组生成后端**：`generateLiveGrid` 接受可选 `groups: number[]`——`groupNos` 先按 `onlyGroups` 过滤，只合成/只复制被选组清单；前端 `generateGroup(g)` 先校验该组存在有效商品。

### 维护要点 / 易踩坑更新

- `renderLiveGrid` 焦点守卫现在必须是 `activeElement.closest("[data-ls-cell]")`，**不要**退回 `area.contains(activeElement)`（会导致点按钮后不重绘的旧 bug）。
- 以后想给某操作加气泡：确认它 `log()` 的首字符在 `RESULT_MARKERS` 里即可；不要在集合里加「空格/＃/＝/纯文本」前缀，会刷屏。
- 客户端想弹气泡一律 `window.showGlobalToast(text)`；别新建 `.toast` 分支元素（多个全叠底）。
- 删空组不再自动补；下一组用「＋ 加一组」或点备选商品。
- `seedProductCovers.cjs`：纯补图脚本（只建缺图文件夹 + 写 `${code}_1.jpg`），不动已有图片；预览用的色块样式在 `coverSvg()` 里改。

### 验收（本轮快照）

- `node --check`：shopTool / procurement / order1688 三个 `client.js` 通过。
- `pnpm run compile`：通过（`toolContext.ts` 变更走核心编译链）。
- `eslint` 核心 + 三个客户端：通过（无新警告）。
- 人工验收点：删组立即消失且不再冒出来；「生成这组」只出一张图 + 只复制该组清单；点备选商品立刻填格 + 气泡提示；重复编号橙色 + 图例可见；所有带 ✅❌🗑 等符号的操作底部弹气泡、2 秒自动消失；800 封面画册滚动流畅。