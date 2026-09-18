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

---

## 六、性能与加载优化（2026-09-08 第三波迭代）

> 主题：商品店铺管理在**性能 / 加载**上的整轮优化。核心策略一句话：**图片全链路小图化 + IPC 限流，聚合改成缓存增量维护，前端只渲染当前视图**。这套打法同样适用于 procurement / order1688 等其它 SQLite 工具。

### 本期功能清单

1. **封面缩略图（重构加载成本的根本）**
   - 背景：封面/缩略图之前把**原图整张 base64** 过 IPC——目录里一张 5MB 照片 ≈ 6.7MB dataURL，一页 200 商品就是上百 MB；34px 缩略图根本用不到原图。
   - 做法：所有封面/图条统一 `sharp` 缩到 **160px（`fit:"cover"`）→ `webp q80`** 再过 IPC（每张几十 KB）。`thumbToBase64()` 是通用工具，失败回退原图 base64 保底。
   - **封面磁盘缓存**：`{storageDir}/shop_thumbs/{code}.webp` + 同名 `.json`（含来源文件名 + 指纹 `mtimeMs|size`），命中直接读盘、不跑 sharp；`invalidateCover(code)` 同步删内存 + 磁盘缓存。

2. **lightbox 图片按需加载**
   - `getImages` 只回「首图原图（`big0`）+ 其余**缩略图**」；点缩略图时前端才发 `getFullImage {code,index}` 拉那一张原图；`lbFullCache` 按 `code:index` 记住已拉过的原图，同图不重复请求。

3. **封面请求限流（客户端队列）**
   - `ensureCovers` 不再把一页 200 个 `getCover` 一次性全发；`coverQueue` + 常驻 **6 并发**，每个 `coverLoaded` 回来才放行下一个，避免积压风暴与瞬时内存峰值。

4. **库存 / 销量聚合缓存（db 层）**
   - 之前每次任意改动（改个名称也）都触发全表 `GROUP BY stock_in` / `GROUP BY sales_record` 现算，历史记录越滚越慢。
   - 现在 `getStockTotals() / getSaleTotals()` **首次懒加载**全量聚合进 `aggCache`，之后在 `addStockIn / deleteStockIn / upsertSale / deleteSales / deleteProduct` **各写入路径增量维护**；`loadAll` 不再全表聚合。

5. **单商品查询与语句优化**
   - 新增 `getProductById(id)`，`index.ts` 里 6 处 `db.getProducts().find(...)` 全替换（少整表扫描）。
   - `updateProductField` 改用 11 个字段的**预编译 UPDATE Map**，去掉每次调用都 `c.prepare`。

6. **前端渲染减负**
   - `renderProducts` **只渲染当前视图**（列表或画册二选一），不再两套 HTML 一起重建。
   - `loadAll` 回包三连（productsLoaded / rulesLoaded / settingsLoaded）里，只保留最后到达的 `settingsLoaded` 触发渲染，去掉两次重复整表渲染。
   - 批量勾选商品改为 `updateSelectionUI()` 局部更新计数条 + 全选框，不整表重建（0↔1 边界才 rerender）。
   - `populateFilters` 下拉按「系列 / 品类 / 趋势下拉」的**内容签名**做缓存，商品集合没变不重建 `<option>`。

### 技术实现与决策

- **缩略图缓存归一化**：封面用 `coverThumbToBase64(src, storageDir, code)`（带磁盘缓存），lightbox 缩略条 / 上传回包用 `thumbToBase64(src)`（不带磁盘缓存）——共用同一 webp 管道，避免 getImages 的每张图都写进 code 封面缓存槽而互相覆盖。
- **聚合缓存的正确性关键**：
  - 缓存挂在**模块级**（不能放 `getDB()` 闭包内——每次消息都会重建闭包）；`closeDB()` 里 `resetAggCache()`。
  - 「先写库、再改缓存」：缓存更新只在 `aggCache.loaded` 为真时生效；首次消息的懒加载仍从库里读全量，天然消除遗漏增量的错账。
  - `deleteSales / deleteStockIn / upsertSale` 都先 `SELECT` 出原值再算增量（`deltaSold/deltaRefund`、借助预编译 `saleById` / `stockInGet`）。
  - `deleteProduct` 删子表后同步删对应聚合 key。
- **消息协议变化**：`imagesLoaded` 的 `images[]` 现在一律是**缩略图数组**，新增 `big0`（首图原图）；`fullImageLoaded {code,index,data}` 为新消息。`uploadImages` 回包同步改造，`clearImages` 不变。
- **渲染点收敛依赖回包顺序**：`loadAll` 固定回包顺序 productsLoaded → rulesLoaded → settingsLoaded → settlesLoaded → liveState，settingsLoaded 一定是最后一个到达的，被作为唯一渲染点。

### 维护要点 / 易踩坑

- 以后**别再用 `getStockGroups()/getSaleGroups()` 全集合计**（已不被 loadAll 使用）；要走 `getStockTotals()/getSaleTotals()`，且任何**新写入路径**（尤其新表）记得同步 `aggCache` 增量——漏一处 = 累计数字在「第二次改动起」悄悄错（首次打开因懒加载全量读不会错，最容易麻痹你）。
- 缩略图磁盘缓存当前是一商品一槽（封面）；若未来把「图条 × 多张图」也做磁盘缓存，key 要按 `code_序号` 细分，别与封面槽共用。
- `imagesLoaded[i]` 与 `getFullImage index=i` 一一对应（都走同一份 `listImageFiles` 排序），改这两处之一要两处一起改。
- 前端渲染依赖「settingsLoaded 兜底」；若未来 loadAll 把 settings 提前到 products 前发，要把渲染点调回去。

### 验收（本轮快照）

- `pnpm run compile`：通过（`tsc -p ./` 无报错）。
- `pnpm run lint`：shopTool 三文件 0 错误；仅 `excelAnalyzeTool/client.js` 四条 pre-existing curly 警告。
- 人工验收点：首屏 / 翻页封面渐次出现且 payload 显著变小（lightbox 不再一次性拉全部原图）；batch 勾选只刷计数条不整表闪烁；改字段 / 入库 / 记销售 / 删销售后库存与销量合计数字仍正确（聚合缓存全写入路径生效）；800 商品下画册滚动顺畅。

---

## 七、九宫格体验修正（2026-09-08 第四波迭代）

> 主题：直播排品值班使用一轮后的体验修正——**图上标注只留 N号、封面+输入框同一格、修掉像素上限报错、去掉自动复制、筛选行吸顶、日志换行、组号复用最小空缺不重排**。

### 本期功能清单

1. **图上标注只留「N号」**：格子标注原先把 `cell.code` 也拼进去，图上太挤。现在只画 `N号`（`index.ts renderLiveGrid`：`text = \`${startNum + idx}号\``）。
2. **九宫格布局合并「封面在上、输入在下」**（用户最终选择的方案）：
   - 一个 3×3 网格，每格 = `.live-cover` 封面子块（左上角 `.lp-num` 的 N号 角标，缺图灰格 `.cover-ph`）+ 下方编号输入框；
   - `index.ts` 每次生成时下发 `{image, cells:{N号,坏格,缺图,不存在,重复}}` 元数据，前端 `renderLivePreview(groupNo)` 只更新 `.live-cover`，不重建输入区 → **焦点不丢**。
3. **生成像素上限修复**：原用第一张商品原图尺寸做格尺寸，画布 `tile×3` 在 4K 原图下超过 sharp 默认 ~268MP → 报 `Input image exceeds pixel limit`。修复：长边 clamp `MAX_EDGE=1024`、短边等比、下限 `MIN_EDGE=256`。
4. **生成后不再自动复制剪贴板**：去掉 `vscode.env.clipboard.writeText` 与后端 list 构建；「复制清单」按钮保留，格式精简为纯「编号↔编码」对照（`客户端 buildLiveListText`：`N号 Lxxx` + 空行 + `第N组` 头），复制这组同理。
5. **日志换行修复**（`main.html`）：原来 `logDom.innerText += msg.text + "\n"` 换行会被 innerText 折叠（连成一条超长串）；改为每条日志**独立 `<div class="log-line">`**（`#logArea` 保持 `white-space:pre-wrap`）。
6. **筛选行吸顶**：`#tabProducts .data-table thead tr.filter-row th { position:sticky; top: var(--thead-h, 25px); z-index:2 }`；`--thead-h` 由 JS 实测表头高度写入 `.table-wrap`，**tab 隐藏时 offsetHeight=0 就 removeProperty 走 CSS 兜底**（否则 0 会让筛选行重叠在表头下面）。
7. **组号「复用最小空缺、不重排」**：删第2组后仍 1、3；加组时 `findNextLiveGroupNo()` 取**不存在的最小正整数**（1、3 → 新组=2）；显示按组号升序，永远正序。空组持久化：加组不再 push 9 个空行，改为单个占位行 `{group_no, slot_no: 0, code: ""}`，`db.replaceLivePlan`（`PRIMARY KEY(group_no, slot_no)` 天然支持 slot 0）放行该占位行——否则空组会被 350ms 保存回传丢弃。
8. **「加了组马上又消失」修复**（关键 bug）：`scheduleLivePlanSave` 里 `plan: state.livePlan.filter(r => r.code)` 把 `code:""` 的占位行滤掉了 → 350ms 防抖保存只发 1、3 组 → 后端全清再插 → 回包 `liveState` 覆盖本地 → 第2组消失、回到 1、3。改为 `.filter(r => r.code || r.slot_no === 0)`，占位行进入请求并被后端显式落库。

### 技术实现与决策

- **封面元数据一次生成、前端增量渲染**：`renderLiveGrid`（后端）返回 `grid` 数组（每格 image/data-url/坏格标记），前端 `coverTile()` 按元数据拼 `img/占位/svg`，`renderLivePreviews()` 遍历各组调 `renderLivePreview(g)` 只改 `.live-cover` 的 innerHTML。输入框由前端 `renderLiveGrid` 单独渲染，存档在 `.live-cell[data-g][data-s]`，行内 input `oninput` 只更新 state + 防抖，不重建。
- **组号猜测策略**——为何不重排：重排（删组后连续化）会改变已生成直播图的组号、且让用户记忆错位；用户明确要「1、3 稳定，新组=2」。实现只看 `live_plan` 的 `group_no` 集合，`while(set.has(n)) n++`。
- **占位行设计**：只存 `{group_no, slot_no:0}`，渲染时组内固定展开 9 个格（画 9 个空输入框），所以空白组也「存在」；删组 = 删整组所有行（含 slot 0）；清空格子 = `state.livePlan = []` + `clearLivePlan`（连占位行一起清）。
- **后端 saveLivePlan 对 slot 0 的显式分支**：`s===0` 时不上抛校验 `if (!code) continue`，直接 `INSERT OR REPLACE` 空码行；而普通空格（s≥1、code 空）照旧跳过，避免库里攒碎行。

### 维护要点 / 易踩坑更新

- `scheduleLivePlanSave` 的过滤条件**必须**带上 `slot_no === 0`，不能只按 `r.code` 过滤——否则空组「加了就消失」。
- 格子布局改动后旧前缀全清：`.live-preview` / `.lp-tile` / `.cell-code` / `previewTile` 已删除，别混用（`cell-code` 现仅指商品列表的「编号」列）。
- tile 尺寸必须 clamp，否则 4K 原图 × 9 格必炸 sharp 像素上限；`MIN_EDGE` 保证小图不糊。
- 筛选行 sticky 的 `--thead-h` 必须实测 + 兜底，tab 隐藏时测到 0 会破坏布局。
- 日志别再退回 `innerText += text + "\n"` 拼接。

### 验收（本轮快照）

- `node --check src/tools/shopTool/client.js`、`pnpm run compile`、`pnpm run lint`（0 error，4 条既有 warning）通过。
- 人工验收点：1、3 组时点「＋ 加一组」→ 第2组出现且**不消失**、刷新面板仍在；删第2组回 1、3；大图商品正常生成、剪贴板不被占用；筛选行随滚动吸顶、切 Tab 回来不叠头；日志逐条换行。

---

## 八、数据库备份 / 恢复 + 写失败反馈（2026-09-08 第五波迭代）

> 主题：数据安全两件事——**① 原数据文件级备份/恢复（本工具唯一的恢复手段，性价比最高）；② 写操作失败的 UI 明确反馈（不再静默/只进日志）**。

### 本期功能清单

1. **数据库备份**：设置 Tab 新增「数据库备份 / 恢复」面板，`备份数据库` → 选目录 → 生成 `商品数据_YYYYMMDD_HHMMSS.db` 一致性快照。
2. **从备份恢复**：`从备份恢复`（二次 confirmBox 确认）→ 选 `.db` → 校验合法后整体替换当前库，恢复完成自动重发全量状态（`loadAll` + `postLiveState`）。
3. **写失败反馈**：`handleMessage` 整个 switch 包进 try/catch，任何异常 → 后端 `log("❌操作失败：<msg>")` + 前端红色气泡（新增 `dbOpError` 消息）；另加通用 `toast` 消息分支，backup/restore 成功失败都在前端弹气泡。

### 技术实现与决策

- **备份用 better-sqlite3 原生 `db.backup(dest)`**（在线备份 API，单个文件、含 WAL 未落盘数据）而不是 `VACUUM INTO`；⚠️ v13 该 API 是**异步**的（返回 `Promise`），必须 `await`，否则文件没写完就返回、后续 `statSync` 直接 ENOENT。
- **恢复的安全顺序**（`db.restoreDB(src, storageDir)`）：
  1. 拒绝「自我恢复」（目标路径 === 源路径）；
  2. 拷到**同目录**临时文件 `shop.db.restore.<ts>.tmp` → 校验 SQLite 魔数（`SQLite format 3\0`）；
  3. **只读探针连接**查 `sqlite_master` 有 `products` 表（防把别人的库换进来，校验不污染主连接）；
  4. `closeDB()` → 删旧 `-wal` / `-shm`（否则旧 WAL 会回放到新库上）→ `renameSync` **原子替换**；
  5. `initDB(storageDir)` 重开；失败分支尽量 `initDB` 恢复现场再上抛。
- **连接换代**：`index.ts` 的 `db` 从 `const` 改 `let`；恢复成功后 `db = getDB()`，由于所有 helper（`loadAll`/`postLiveState`/`getSetting`…）都闭包引用 `db` 这个**绑定**，重赋值后同一消息内的收尾推送自动用新连接。
- **错误不再「静默」**：写路径原有局部 try/catch 的地方保留（如单组生成失败），外层 catch 兜底那些**没有** catch 的写操作（UNIQUE 冲突、校验遗漏、磁盘问题等）→ 必然有日志 + 气泡，与「成功 toast」区分。

### 维护要点 / 易踩坑更新

- **新增任何**「能关到数据库连接的恢复类操作」都要重取 `db = getDB()`；闭包捕获的是绑定不是值，改 `let` 即可。
- 备份目标目录若不存在，`backupDB` 已 `mkdirSync recursive`；备份文件命名含时间戳，天然防覆盖。
- 恢复是**整体替换**，无撤销；前端已二次确认，将来若要「恢复前自动备份」，在该 case 里先 `backupDB` 一次即可。
- 外层 try/catch 只兜未捕获异常；`log("❌…") + break` 这类**预期校验不弹气泡**（避免验证性错误刷屏）。
- 相关类型：`ShopDB` 新增 `getDBFilePath / backupDB / restoreDB`。

### 验收（本轮快照）

- `pnpm run compile`、`pnpm run lint`（0 error）、`node --check client.js` 通过。
- **端到端冒烟**（临时 SQLite 实例，脚本跑通）：插商品/入库/live_plan → `backupDB` 落盘 → `deleteProduct + clear` 制造破坏 → `restoreDB` 恢复 → 商品/排品占位行/库存合计全部还原；写入非法文本文件被拒且连接仍存活。
- 人工验收点：设置页点「备份数据库」生成 .db；改几项数据后「从备份恢复」→ 数据回到备份点、面板全量刷新；故意选非 SQLite 文件被拒 + 红色气泡提示。
## 九、模块化重构（按域拆分，纯搬移 0 行为变化）

### 背景与目标

- shopTool 是唯一一个「越做越大」的工具：后端 `index.ts` 一度 1397 行、前端 `client.js` 2426 行，全部业务挤在单文件，改一个功能要滚动很长的上下文。
- 本轮只做 **结构拆分，不改变任何行为**：前端每个函数原样搬进新文件，后端把纯工具函数抽取为模块。刚修好的边界全部保留（如 `scheduleLivePlanSave` 保 `slot_no=0` 占位行、备份/恢复、组号复用空缺不重排）。

### 后端拆分（index.ts 1397 → 1120 行）

| 模块 | 内容 |
| --- | --- |
| `pricing.ts` | `todayStr / fileStamp / canonicalCode / extractCodeToken / round2 / applyExpr / calcPrice / monthOf / normalizeRule`（价格规则与编码，进口 `SaleRule`）
| `images.ts` | `IMAGE_EXTS / UPLOAD_FILTER / listImageFiles / firstImageFile / COVER_THUMB / coverThumbCachePaths / thumbToBase64 / coverThumbToBase64`（图片目录与封面缩略，`fileFingerprint` 内部）
| `liveGrid.ts` | `renderLiveGrid`（九宫格 SVG，含 1024/256 像素上限 clamp；`localYmd / greyCellSvg / labelSvg` 内部）
| `index.ts` | 删除整块辅助函数与 `sharp` 依赖（缩略图已统一走 sharp → 无残留引用），换成模块 import + `readImageToBase64` 等保留项

> ESM / Node16 已支持 `.js` 相对导入（`./db.js` 先例），无需改编译配置。

### 前端拆分（client.js 2426 行 → 6 个模块）

| 文件 | 加载序 | 职责 |
| --- | --- | --- |
| `client-core.js` | 1 | 共享 `state`、常量、`$ / post / esc / money / qty`、价格/编码工具、toast/modal/confirm/copyText、封面 pump 管线、`window.toolClients` 初始化 |
| `client-product.js` | 2 | 商品管理：列表/画册、筛选、内联编辑、批量、新建/导入/入库、列设置、右键菜单、`stateProduct` |
| `client-sales.js` | 3 | 销售：今日销售渲染、快捷录入、批量删除选中、分析趋势 |
| `client-report.js` | 4 | 月报/月结面板、定价规则、设置渲染 |
| `client-live.js` | 5 | 直播排品：九宫格、加组/删组、预览、生成 |
| `client-main.js` | 6 | `bindEvents / init / onMessage` 装配 `window.toolClients.shopTool = { init, onMessage, _state, _isReady }` |

### 技术方案与决策

- **平台小改（多脚本加载）**：
  - `toolRegistry.ts`：`ToolMeta.clientScriptPath` 支持 `string | string[]`；`switchFragment` 不再传单 `uri`，改传 `clientScript: { uris: string[], toolName }`（沿用逐条 `asWebviewUri`）；
  - `main.html loadToolClient`：`script.id` → `script.className="toolClientScript"`，**按序加载全部**，最后一个 `onload` 后统一 `init()` 并投递 `pendingClientMessages`。两态兼容：单文件工具照旧只要一个 `uris` 元素。
- **为什么不每个文件一个 IIFE（关键决策）**：原 `client.js` 是单一闭包，函数间靠闭包变量（`state`、`selSales`、**会重赋值的** `sortKey / sortDir / visList / visGallery / listPage / pageSize / viewMode`）互访。若拆成独立 IIFE，传值/传引用会断裂。方案改为 **6 个经典 script 共享全局作用域**：
  - 共享可变状态用 **`var`**（不是 `const/let`）声明在 `client-core.js` 顶层 → 跨文件共享同一份全局绑定，且**工具切换后重载不报 `Identifier has already been declared`**（`const/let` 全局词法绑定被占用会抛 SyntaxError，`var` 可重复声明）✓ 已验证其它工具 client 均为 IIFE、无顶层全局名冲突；
  - 函数声明天然可跨文件在调用期解析（global function / var），调用都发生在 `init()` 之后，加载顺序只保证 core 先于引用它的文件。
- **结构探测脚本**：顶部 4 空格缩进可判定功能边界 —— 实测 `^    \}$` 行数 === 顶层函数数（72），据此按 [start, 后一个 `    }` ] 精确切函数、捕获函数间散落的顶层语句（`let toastTimer`、`let livePlanSaveTimer` 原样归位到 core/live），保证 0 行漂移。
- **行为等价验证**：
  1. 6 文件拆后合并再 `node --check` → parse OK；
  2. Node 桩环境（stub `window/__vscode/document`）跑 **18 项跨模块冒烟**全 PASS：`canonicalCode`、`calcPrice(p99)`、`fillCustom`/`gradeLabel`、`fullName(模板)`、`stateProduct`、`findNextEmptySlot / findNextLiveGroupNo / buildLiveListText / removeLiveGroup`、以及 `scheduleLivePlanSave` 350ms 保存仍保留 `slot_no=0` 占位行；
  3. `pnpm run compile`、`pnpm run lint`（0 error，仅 excelAnalyzeTool 既有 4 条 curly warning）、全部 6 文件 `node --check` 通过。
- **副作用提示**：client-*.js 现在会泄漏一组全局名（`state/post/$/toast/…` 及各渲染函数）；已核对 `main.html`（无同名）、`fragment.html`（无内联脚本）、其它工具 client（IIFE 无全局）均不冲突，且本工具重载用 `var` 自洽。

### 维护要点 / 易踩坑更新

- 换工具再切回 shopTool = **重新加载** 6 个脚本，`var` 声明安全；**不要**把顶层共享声明改回 `const/let`（重载会直接 SyntaxError）。
- 新加跨文件函数：放进对应域文件即可，天然是全局函数；要共享的**可变状态**必须声明在 `client-core.js`（全局 `var`），别在域文件里再声明同名 `let`。
- 后端新增纯函数优先落 `pricing/images/liveGrid` 等模块，`index.ts` 只保留消息处理与调度。

### 验收（本轮快照）

- `pnpm run compile`、`pnpm run lint`（0 error）、`node --check` × 6 文件、合并脚本 parse、18 项跨模块冒烟全 PASS。
- 需人工复验面板：切到 shopTool（6 脚本按序加载无报错）→ 商品/销售/月报/排品各 Tab 正常 → 加一组再生成（占位行保留）→ 备份/恢复。

## 十、Excel 导出（xlsx）

### 功能

| 位置 | 入口 | 内容 | 列 |
| --- | --- | --- | --- |
| 商品管理 | `📤 导出Excel`（工具栏） | **按当前筛选结果**导出，无筛选即全部 | 编号/名称/品类/系列/等级/进价/售价/**库存**/累计售出/累计净售/状态/采购链接 |
| 销售录入 | `导出销售流水`（专属面板，可**选日期段** from/to） | 指定区间流水（按日升序、编号） | 日期/编号/名称/销量/退款/净售/成本/备注 |
| 月度结算 | `📤 导出Excel`（月份旁） | 全部月份月报汇总 | 月份/收入/额外支出/货品成本/累计售出/累计退款/利润/已锁定/更新时间 |
| 直播排品 | `📤 导出Excel`（九宫格工具栏） | 当前全部排品（含有效占位判断） | 组号/号数/编号/名称 |

统一交互：选文件夹 → `名称_时间戳.xlsx`（`fileStamp()`）→ 后端 `log` ✅ + 前端 `toast`；失败 → `log` ❌ + 红色 `dbOpError` 气泡。复用 `xlsx@0.18.5`（order1688/procurement/excelAnalyze 同款），不引新依赖。

### 技术实现与决策

- **商品筛选导出**：前端 `bindEvents` 里 `filteredProducts().map(x => x.code)` 把当前筛选后的编号顺序发给后端（`exportProducts`），后端用 `Map(code→product)` 保序还原，**导出顺序与页面所见一致**；无筛选时就是全量，故不做第二个按钮。
- **日期段查询**：`db.ts` 新增 prepared statement `salesRange`（`WHERE s.date >= ? AND s.date <= ?`，JOIN products 联出 code/name）与 `ShopDB.getSalesRange(from, to)`；字符串日期字典序等价于日期序。前端口 `salesFrom`/`salesTo` 默认本月1日 ~ 今天。
- **等级/状态本地化**：等级用 `rules` 映射中文名；状态 `1→上架 / 0→下架`；库存 `getStockTotals()`、售/退 `getSaleTotals()`，净售 = 售 − 退。数值列直接落数值（便于 Excel 求和），中文列头直写。
- **排品**：只导出 `code` 非空的有效槽，号数 = `(组-1)*9 + 槽`，附商品名称。

### 维护要点 / 易踩坑更新

- 新增导出放在 `default` 之前、`exportDB` 之前；每个 case 单独 try/catch（外层兜底也保留），失败给 `dbOpError` 气泡不与成功 toast 混淆。
- 日期段为空时后端直接导空表（前端默认已填本月），不会报错。
- 文件命名带 `fileStamp()` 时间戳，避免覆盖；Excel 中文列无需特殊编码（xlsx 库原样写入）。

### 验收（本轮快照）

- `pnpm run compile`、`pnpm run lint`（0 error，仅 excelAnalyzeTool 既有 4 条 curly）、`node --check client-main.js` 通过。
- **导出冒烟**（临时 SQLite，17 项全 PASS）：`getSalesRange` 区间/排除边界；商品筛选保序 + 库存/净售/等级/状态；销售流水行数与退款净售=0；月报数值；排品号数与名称。
- 需人工复验：各 Tab 点导出生成 .xlsx → 用 Excel 打开核对列/中文/求和；商品先筛选再导出看是否只出筛选集。

## 十一、客户体验改进：导出口径 / 自动备份 / 全局搜索 / 空态引导

### 功能

| 项 | 入口 | 行为 |
| --- | --- | --- |
| 导出口径 | 四类导出按钮 | 成功后气泡**带完整路径** + 「📂 查看文件」按钮（`revealFileInOS` 定位到资源管理器）；商品导出气泡**区分「筛选结果 N 条 / 全部 N 条」**；点按钮即置灰「⏳ 生成中…」直至收到结果 |
| 自动备份 | 无入口（自动） | **每日首次启动**自动留档 `backups/shop_auto_时间戳.db`，写设置 `auto_backup_date` 记录日期；**破坏性操作前**（删除商品/删除销售/清空图片/恢复数据库）追加 `shop_pre_时间戳.db` |
| 备份配额 | 无入口（自动） | 两类**分开剪除、只留最近 N 份**：`shop_auto_*` 保留 14、`shop_pre_*` 保留 20，按 mtime 从旧到新删，不无限累积 |
| 全局商品搜索 | 商品工具栏 `🔍 编号/名称/品类/系列` | 实时子串过滤（含编号去前缀数字化匹配，输 `007` 也中 `L007`）；与既有筛选叠加，同样作用于「筛选后导出」 |
| 空态引导 | 商品 Tab 顶部（无商品时） | 三步中文引导（设置图片目录→建/导入商品→录销售）；「去设置图片目录」跳转规则与设置页、「我已知道，收起」记 `localStorage` 本会话不再弹 |

### 技术实现与决策

- **导出口径**：后端 4 个导出 case 从同步 `XLSX.writeFile` 改为 `XLSX.write(type:"buffer")` + `await fs.promises.writeFile`（大表不阻塞面板）；成功统一回 `exportDone{kind, path, count, filtered?}`，前端 `onMessage` 用 `window.showGlobalToast(text, [{label, handler}])` 带操作按钮（`main.html` 的 `showGlobalToast` 加了可选 `actions` 参数与 `#shToastActions` CSS，兼容旧单参调用）。商品按钮点击时前端算 `filtered = filteredProducts().length < state.products.length` 随消息发出；`beginExport/endExport` 管理按钮忙态，`dbOpError` 也会复位。
- **自动备份**：`backupToDir` 复用 `db.backupDB`（better-sqlite3 的 `db.backup()`，**异步必须 await**）；`maybeAutoBackup` 挂在 `handleMessage` 开头（进程内 `lastAutoBackupCheckDate` 缓存，一天只查一次 DB）；破坏性 case 各自在改动前 `await preOpBackup`，失败不阻断操作只记日志。目录统一 `storageDir/backups`（resourceRoots 已含 storageDir，天然在数据目录内）。
- **全局搜索**：关键字存 `filters.keyword`（`client-product.js filteredProducts` 新增子串过滤：code/name/category/series 拼接小写子串 或 编号去 `\D` 数字化包含），`filterSig` 序列化含 `filters` → 输入自动重置翻页；不引拼音依赖，先做子串。
- **空态引导**：`onboardPanel` 由 `maybeShowOnboard()` 在 `productsLoaded`/`productsImported` 后按 `无商品 && !localStorage("shopOnboardHidden")` 显隐；「去设置图片目录」直接 `.click()` 复用 main.html 泛用 sub-tab 切换。

### 维护要点 / 易踩坑更新

- 自动备份参数在 `index.ts` 顶部常量 `AUTO_BACKUP_KEEP=14` / `PRE_BACKUP_KEEP=20`，改配额只动这两处。
- 手动备份（备份数据库）不在自动剪除范围（它往 `backups` 外的自选路径写）；剪除只按前缀匹配 `shop_auto_*`/`shop_pre_*`。
- `showGlobalToast(text, actions?)` 第二参为 `[{label, handler}]`，其它工具仍可单参调用；带 action 时停留 6s，无则维持 2s。
- `revealFile` 消息后端用 `vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fp))`（与直播「生成后打开目录」同一命令），路径来自后端返回，不信任前端拼接。

### 验收（本轮快照）

- `pnpm run compile`（0 error）、`pnpm run lint`（0 error，仅 excelAnalyzeTool 既有 4 条 curly）、`node --check` client-main.js / client-product.js 通过。
- **备份冒烟**（临时 SQLite，5 项全 PASS）：`backupDB` 真实落盘 ×3、按 mtime 剪除保留 N 份裁掉最早、`auto_backup_date` 读写、pre/auto 前缀互不干扰。
- 需人工复验：导出后气泡带路径→「查看文件」定位；商品搜 `007`/`手链` 即时过滤并联动清除筛选；删一条商品前后看在 `storageDir/backups` 出现 `shop_pre_*.db`；空库首次打开见三步引导、收起后本会话不重现。

## 十二、每日销售录入与对账三件套

- **连续录入**：`quickSaveBtn` 逻辑抽为 `submitQuick()`（client-main.js）；`quickCode / quickSold / quickRefund / quickNote` 任意回车即保存，保存后清空卖出/退款/备注与编号，并 `focus()+select()` 编号框——柜台可全程键盘连录。编号非法/不存在时只提示并把光标留在框内，不吞输入。
- **当日合计行**：`renderSales` 表底加 `<tfoot>`「合计 N 条 + 卖出/退款/净售件数」（client-sales.js），进价/备注/删除列留空跨列。
- **负净售标红**：行级与合计行的净售 `< 0` 加 `.num-neg`（fragment.html 新增 CSS，`--vscode-errorForeground`，与库存预警同色系）。
- 验证：`node --check` ×2、`pnpm run compile`（0 error）、`pnpm run lint`（仅既有 4 条警告）。人工复验：连续回车录 3 单、合计行数字、退款>卖出看红字。

## 十三、分析·月报直观化（去掉「生成/刷新」，分区三步）

- **去掉「生成/刷新月报」按钮**：改为自动刷新——月份切换（`settleMonth.onchange`）、进入月报 Tab（`.sub-tab[data-sub="tabMonthly"]` 上附加 click 监听，与 main.html 泛用 tab 切换并存）、以及 `init()` 首帧各触发一次 `monthBuild`，面板数字总是最新快照。
- **面板拆三部曲**（fragment.html）：`① 本月数字`（自动汇总）→ `② 到账收入 + 支出 + 保存/删除` → `③ 封账`（锁定/解锁 + 徽章 + 人话说明）。
- **锁定/解锁语义说明**：`③` 区配常识文案「锁定 = 封账：锁定后当月销售不能改，数字固定，随时可解锁再改」；`renderSettlePanel` 按锁定态显示/隐藏 锁定按钮、解锁按钮、`settleLockBadge` 徽章（锁定后保存按钮变灰「已锁定，不能改」）；月报列表行内锁定/解锁按钮补 `title` 说明。
- **解锁二次确认**：面板「解锁」与月报列表「解锁」都弹确认框（提示影响：当月销售恢复可改、月报回滚草稿）。
- 收入计算未动（仍为手动到账），后端零改动。
- 验证：`node --check` ×2、`pnpm run compile`（0 error）、`pnpm run lint`（仅既有 4 条警告）、无 `settleBuildBtn` 残留引用。人工复验：切到月报 Tab 数字自动出现；换月即刷新；锁定后保存/删除变灰且月报列表出现「已锁定」；解锁有确认。

## 十四、每日销售「覆盖」模式修复（真的覆盖）

- **问题**：saveSale（index.ts）与 pasteSales（index.ts）的模式归一化三目把 "overwrite" 吞成 "accumulate"——前端选「覆盖」，后端实际走累加（改错数越改越大），db.upsertSale 的覆盖分支（db.ts else → 直接替换）从未被触发。
- **修复**：两处归一化改为 msg.mode === "overwrite" ? "overwrite" : msg.mode === "skip" ? "skip" : "accumulate"；保存日志按真实语义措辞（已覆盖 （替换为 卖x退y） vs 已累加）。
- **tooltip**：每日销售「当天已有记录时」下拉加 	itle，把累加/覆盖/跳过三个语义说清（减少再误会）。
- 验证：smoke-overwrite.cjs（临时 SQLite）8 项 PASS——首次 created、累加 3+2=5、覆盖后 = 8 而非 13、跳过不动 8。

## 十五、商品管理精简（顶栏 + 行操作 + 留档补漏 + 反馈）

- **A 顶栏 13→10**：撤掉「全部系列」「全部品类」两个下拉（keywordSearch 已覆盖系列/品类子串搜索），同时**整行移除列头筛选输入框**（enderList 的 ilter-row 及其 indFilterRow、FILTER_FIELDS、.filter-row CSS、--thead-h 计算全部删除）；保留 搜索/列表/画册/状态/新建/字段显示/导入/导出/清除筛选。ilteredProducts 只剩 状态 + 关键字 两路过滤，ilterSig 同步精简。
- **B 行操作 6→4**：行内只留 ★（星标）· 📋（复制名称）· 📦（补货）· 🗑（删除）；**上·下架、清空图片夹**移入右键菜单（在原有「复制整行/复制整表」下扩两项，分隔线分组，清空图保留二次确认）。
- **C 批量删除补留档**：deleteProducts case 在删除前 wait preOpBackup——之前只给单删 deleteProduct 留了档，**批量删漏了**，补齐后可恢复。
- **D 反馈小修**：画册卡片占位文案「无图（双击表格行可改）」（画廊根本没这功能）→「暂无图片」；双击单元格保存后气泡「已保存」；新建商品成功由后端发 	oast（ddProduct case 内 postToWebview）。
- 验证：
ode --check ×3、pnpm run compile（0 error）、pnpm run lint（仅既有 4 条）、smoke-overwrite 8 PASS、smoke-backup 5 PASS、全文件 grep 无 ilterSeries/filterCategory/filter-row/bindFilterRow/FILTER_FIELDS/thead-h 残留。
- 人工复验：顶栏只剩一个搜索框 + 状态下拉；右键商品行出现「下架/上架」「清空图片文件夹…」；勾选多个商品批量删除后在 storageDir/backups 出现 shop_pre_*.db；新建商品弹「已新建 Lxxx」；编辑单元格回车弹「已保存」。

## 十六、每日销售再顺路：面板顺序、行内改数、模板预览、趋势联动

- **A 面板顺序重排**（fragment 纯调块）：每日销售页自上而下改为 **快捷录入 → 当日销售表 → 批量粘贴 → 导出流水 → 销售趋势**。柜台录完一笔，下方立刻看到表格确认，不必再滚屏。
- **B 销售行内改数量**：双击当日表「卖出/退款数量」单元格直接改（number 输入，Enter/blur 提交、Escape 取消，复刻商品 Tab 内联编辑手感）。后端新增 case "updateSalesField"（index.ts，字段白名单 sold_qty/refund_qty/note，数值校验 ≥0 整数，走 equireMonthUnlocked 拒绝锁定月份）+ db.updateSalesField（按 id UPDATE，增量维护 ggCache.sale；接口 db.ts:129 附近，实现紧邻 deleteSales）。改错数不用再删除重录。
- **C 完整名称模板实时预览**：设置页「完整名称模板」下方新增实时预览行（previewNameTemplate(tpl, p)，参数化 {name}{category}{series}{grade}{code} 替换，ullName 改为复用它，逻辑不变）；setNameTemplate.oninput + enderSettings/productsLoaded 各刷新一次，无商品时显示占位文案。
- **D 趋势小联动**：syncTrendMonthField()——切「按日（选月）」自动补当月并显示月份行，切回「按月累计」收起月份行，init() 首帧即调；刷新语义不变。
- 验证：
ode --check ×4、pnpm run compile（0 error）、pnpm run lint（仅既有 4 条）、smoke-salesfield 6 PASS（改 sold/refund、agg 合计一致、note、不存在 id 静默）、smoke-overwrite 8 PASS、smoke-backup 5 PASS。
- 人工复验：每日销售页面板新顺序；双击销售数改为 8 回车后表格与合计立即刷新、锁定月份则拒绝；模板预览随输入即时变化；趋势切按日出现月份框。

## 十七、粘贴入库「单空格」分隔修复

- **问题**：pasteSales 的分隔正则 /\t|[,;，；]|\s{2,}/ 只把「2 个以上连续空格」当分隔符——用户输 L001 5 4（单空格）整行被当成 1 个 token，extractCodeToken 只抠出编号 L001，5/4 丢失，落库成 卖出0 退款0，看起来就是「粘贴不生效」。
- **修复**（index.ts pasteSales）：分隔改为 [,;，；]|\s+（任意空白/逗号/分号均可分隔；销售粘贴每行只有 编号/卖出/退款，无名称列，单空格安全）；另加校验：**卖出与退款同时为 0 的行判为「无法解析」**并在摘要里列明，不再静默建空行。
- **备注**：商品导入 importProducts 沿用 \s{2,} 不动（那台每行含名称列，名称里有单空格，按单空格切会错位）。
- 验证：compile 0 error、lint 仅既有 4 条、smoke-paste 8 PASS（单空格 L001 5 4 → sold5 refund4；Tab/逗号/单空格各格式；0/0 判失败；重复行拒绝）。人工复验：粘贴「L001 5 4」后当日表出现卖出 5 退款 4。

## 十八、直播排品九宫格双列排布

- 纯 CSS（fragment.html）：#liveGridArea 改 display:grid; grid-template-columns: repeat(auto-fit, minmax(360px,1fr)); gap:12px 16px——宽面板一行 2 组、窄自动回 1 列；.live-group 的 margin-bottom 交给容器 gap；.g-head 加 lex-wrap: wrap。
- .live-grid 的 max-width:540px 保留（窄列自动跟列宽）。JS/后端零改动，刷新面板即生效。

## 十九、图片右键菜单（复制/系统打开/删单张）

- **浮层 menu**：showImageCtxMenu(x,y,items)（client-core.js）——自定义右键浮层，复用 .ctx-item 样式 + 新增 .ctx-danger（红色危险项），点击外部/Esc/blur/resize 关闭。
- **复制图片**：copyImageFromDataUrl（client-core.js）data URL→canvas→PNG→
avigator.clipboard，跨格式稳定，可粘贴到微信/文档。
- **大图/缩略图右键**（imagesLoaded 处绑定）：复制这张图片（缩略图未载入大图时先 getFullImage 载入后自动复制，state.lbPendingCopy 接力）、复制完整名称、系统看图打开原图、删除这张图片…；
- **后端新增**（index.ts）：openImageFile（scode.env.openExternal(Uri.file) 系统看图软件打开原文件）、deleteImageFile（按 index 删单张，preOpBackup 后刷新 imagesLoaded + invalidateCover + loadAll）。索引与 getImages 共用 listImageFiles 排序（数字升序），冒烟验证索引映射一致。
- **封面右键**（onProductCtx 扩展 + 画册视图补 contextmenu 绑定）：复制封面图、查看大图。
- 验证：compile 0 error、lint 仅既有 4 条、smoke-img 4 PASS。前端刷新面板、后端 compile 后 F5 生效。

## 二十、直播排品组边界/价格与导出状态修复

- **导出状态反了**：index.ts exportProducts 里状态列写的是 p.status === 1 ? "上架" : "下架"，而 status=1 表示下架——已改为 "下架" : "上架"。
- **双列边界**：.live-group 加边框+圆角+浅底+头部分割线，两列相邻不再糊成一团；组头加「已填 x/9」。
- **价格框**：每个格子输入框下方加 live-meta，填了有效商品就显示金色 ¥售价，输入时联动刷新。
- **按钮排布**：toolbar 按「组操作（加一组/清空格子）｜清单（复制清单/导出Excel）｜输出（输出目录+路径）｜生成全部九宫格」重排，	oolbar-fill 撑开留白。
- 验证：compile 0 error、lint 仅既有 4 条；编译产物确认状态列已修正。前端刷新面板、后端 F5 生效。

## 二十一、组合筛选/清空本组/图片菜单收敛

- **组合筛选**：商品管理工具栏按「状态 + 品类 + 系列 + 关键词」四维 AND 组合筛（ilterCat/ilterSeries 下拉，选项随商品数据自动刷新并保留当前值）；hasFilter/syncClearFilterBtn 统一判断，任一维度生效即显示「清除筛选」，清除时一并重置状态/品类/系列/关键词。
- **清空本组**：每个九宫格组头新增「清空本组」按钮（保留组、只清格子，确认后执行 clearLiveGroup）。
- **图片右键菜单收敛**：移除与浮层头「📋 复制完整名称」重复的菜单项；「打开原图」改为「📂 打开图片文件夹」（evealFileInOS，与导出定位同一机制），后端 openImageFile 改为直接 reveal 该编码的图片文件夹。
- 验证：compile 0 error、lint 仅既有 4 条。前端刷新面板、后端 F5 生效。

## 二十二、每日销售表：表头排序 + 筛选

- 当日销售表表头可点击排序（编号/名称/卖出数量/退款数量/净售数量/进价快照/备注，点击切换升/降序，表头 ▲▼ 提示），onSalesAct 新增 	h[data-sort] 分支。
- 「当日销售」标题行新增筛选框（编号/名称/备注关键词，含编号数字忽略格式匹配），salesKw + salesTableRows() 先筛后排序；合计行按筛选后结果汇总；无记录/筛空分别给提示。
- 仅前端改动。验证：node --check 过、lint 仅既有 4 条。刷新面板即生效。

## 二十三、待办·规划（暂缓，后续慢慢做）

> 归档时间：2026-09-16。非本次实现，登记留档，后续按需逐条立项。状态：**待办**。

1. **盘点 / 清点留痕（stock_adjust_log）**
   - 现状：`setStockQty`（双击库存列「清点」）直接改 `products.stock_manual`，无记录、无确认、不产生任何审计痕迹——「账上 10 变 3」查不到是谁/何时改的。
   - 规划：新增 `stock_adjust_log`（`product_id` / `code` / `old` / `new` / `delta` / `date` / `remark`），清点、批量调整、盘点都落一条明细；商品列表或设置页提供「库存变动台账」查看；清点/盘点类操作前也补 `preOpBackup`（当前只有删除类做事前留档）。
2. **候选（未确认，暂缓）**：采购（procurementTool）与店铺打通（采买到货自动更新进价/库存/补货入库）；「建议补货清单」导出（缺货 × 补到目标量）；品类/系列维度的销售与利润聚合分析；通用列映射导入对话框（预留接微信/抖音订单明细，`[待确认#3]`）；盘点工作表（按编号 Enter 依次填实存 + 批次写库 + 差异清单）。
3. **实现基线**（立项时注意）：库存读写已全部收敛到 `stock_manual` 单列 + 各写入路径增量维护（一定别回退到「现算」）；新写入路径要同步 `aggCache`；清点操作建议进撤销栈（现状 `setStockQty` 已 pushUndo，保持）。

## 二十四、商品导入预览（先解析预览、确认后才落库）

> 归档时间：2026-09-16。状态：**已实现**。

- **背景**：导入商品原是「粘贴 → 直接写库」一步到位，批量导入时看不到会改哪些行，「无法解析」的行要到事后日志才看到；误点会把已有商品一次性覆盖，不可逆。
- **决策（定档）**：做完整版——解析后先展示「将新增/将更新/将跳过」+ 每个 update 行的**字段级 diff**（旧→新），确认后才提交；只做商品导入，粘贴销售（pasteSales）本次不改；品类/系列销售利润分析按指示砍掉并登记进「二十三、待办·规划」。
- **后端**（`handlers/product.ts`）：
  - 从原 `importProducts` 抽出**无副作用**纯解析 `buildImportPlan`：逐行决策逻辑与旧版完全一致，只收集"计划"不落库；
  - 拆两个消息：`previewImportProducts {text, mode, fields}` → 回 `importPreview {token, created, updated, skipped, bad[], rows[], total, truncated}`（rows 上限 200 + `truncated` 防消息体过大）；`commitImportProducts {token}` → 沿用原 `productsImported` 消息体；
  - 计划暂存模块级 `pendingImport` + 随机 token 防误提交（不匹配直接拒绝）；**预览零副作用**（不写库、不 ensureRule）；
  - 售价按规则重算的一致性：ensureRule 默认规则是确定性的（expr `cost*1.5` + tail `p88`→`+0.88`），预览用 `IMPORT_DEFAULT_MISSING_RULE` 占位，与 commit 时 ensure 后 `calcPrice` 的结果**完全一致**（不必提交时重算）；
  - commit 全流程（preOpBackup + 快照 + 缺的等级规则才 ensureRule 并提示 + 写库 + pushUndo + loadAll + productsImported）与旧行为逐条等价；**提交前身份复检**：预览后编号被占用/删除 → 该行跳过并单独提示，避免覆盖；
  - 语义与旧版一致：表头行整行跳过、缺编号 = `bad`、文本字段 `has` 即写（同值也计 updated）、`touched>0` 才算更新、非手动价时售价列可见或等级/进价有变才按规则重算、status 支持 在售/上架=0·已下架/下架=1。
- **前端**：
  - `client-product.js`：`openImportProducts`**单页弹窗**（V1 是两页切换，有「返回修改」卡在「解析中…」的缺陷，本轮一并修掉并去掉 `#ipOptions/#ipBack/toggleImportStep`）——**导入方式改为顶部三段式 Tab**（`.mode-tabs`），粘贴框常驻、预览表直接渲染在**下方**不再整页跳走；按钮态 `[取消][解析预览]` ⇄ `[取消][重新解析][确认导入]`；**改内容/换字段/切 Tab 即作废旧预览**（`invalidatePreview`，切 Tab 时按新方式自动重解析），确认导入永不落旧计划；`dbOpError` 时 `resetImportBtns` 顺带清空预览与令牌；
  - `client-main.js`：新增 `importPreview` 分支渲染预览；`productsImported` 自动关导入弹窗；`dbOpError` 复位按钮防卡「解析中…/导入中…」；
  - 令牌用 `var pendingImportToken` / `ipMask` 挂全局——**共享全局只能 `var`**，脚本重载同作用域 `let/const` 会 SyntaxError；
  - `fragment.html`：补 `.mode-tabs/.mode-tab` 分段控键样式 + `#ipPreview` 样式（汇总色、粘性表头、max-height 滚动、bad 红色块）。
- **文档**：`shopTool-manual.md` 导入小节补「先解析预览再确认」；测试指引同步为「解析预览 → 确认导入」两步。
- 验证：`tsc -p ./` 0 error、`eslint src` 仅既有 4 条存量 warning、`node --check` ×2 通过。测试运行本次押后。

## 二十五、导入重复编号去重 + 图片「同内容不再复制」

> 归档时间：2026-09-16。状态：**已实现**。

- **A 导入商品：同批粘贴重复编号只取第一条**（`handlers/product.ts`）
  - 现象：预览不落库、只查库 → 库里不存在的同号两行预览都判「新增」（将新增 2），提交时第二行走「身份复检」被跳过（实际只加 1 条）——预览数字与结果不一致；
  - 约定（与 pasteSales 同批重复忽略的口径一致）：**只取第一次出现的行，其余计入「跳过」并标注**；`buildImportPlan` 加 `newCodes` 集合收集 `dupLines`；
  - `importPreview` 消息带 `duplicates` 计数 → 前端汇总行显示「重复编号 N 行已忽略」；预览/提交日志都逐条 `⚠️行N: 编号 X 重复，仅保留第一条`；
  - 已存在编号的重复行行为不变（仍各计一次更新，幂等）。
- **B 图片粘贴/拖入：同内容不再落副本**（`handlers/image.ts` `receiveImageData`）
  - 现象：画册大图浮层里把已存在的图再拖入/V 过去，`uniqueTargetPath` 只按文件名去重 → 又生成一个 `xxx_2.jpg` 副本，越拖越多；
  - 修复（两层）：
    - 前端**源头掐断**（`client-product.js`）：拖拽的是画册/灯箱里**已经显示出来的图本身**时，Chromium 默认会把 `<img>` 当一个文件塞进 `dataTransfer.files`，一松手就被 `receiveImageData` 再写一份 → document 捕获层新增 `dragstart` 拦截（`onInternalImgDragStart`），命中 `<img>` 直接 `preventDefault` 取消拖拽并提示「这张图已经在这里了」，外部 OS 文件拖入不受影响；
    - 后端**同内容守卫**：`receiveImageData` 写盘前 `sameContentExists`（字节 SHA1 比对该商品文件夹全部现有图）→ 命中则跳过并计数，日志「已粘贴/拖入 N 张 → 文件夹（M 张与已有图片重复已忽略）」；只重复无新增时不刷新。
  - 语义口径：**前端拦截的是「拖已显示的图」，后端守卫兜底「任何路径碰到同内容图」**；`uploadImages`（picker 显式选择）保持现状不动。
- 验证：`tsc -p ./` 0 error、`eslint src` 仅既有 4 条存量 warning、`node --check` 通过；前端刷新面板、后端 F5 生效。

## 二十六、星标升级为通用标记 + 批量导出 / 封面总览拼图

> 归档时间：2026-09-16。状态：**已实现**。

- **用户决策（访谈定稿）**：直播排品用得少、星标不该只服务它；选定「**通用单星标**」——星标 = 标记商品，直播排品备选池**继续复用同一份星标**，不另建体系；拼图格式选「**自动密度**」，星标不分组、不备注。
- **前端交互**（`client-product.js` / `client-main.js` / `fragment.html`）
  - 列表末列与画册卡片 ⭐ 工具提示改为「标记星标（直播排品备选同用）」；
  - 顶栏新增：`⭐ 只看星标`（写 `filters.f_stared`，`filteredProducts()` 里挡掉未打星的；再次点击/清除筛选取消）、`⭐ 复制星标`（`copyStarList`——不依赖当前勾选/筛选，全部星标商品按**当前可见列**拼 TSV，随「清除筛选」一起复位高亮）、`🖼 星标总览图`；
  - 顶栏新增 `✕ 取消全部星标`（confirm → `clearLiveStars`），列表行右键 `🗑 取消全部星标…`（confirm → `clearAllStars` 公共函数）；
  - 行右键菜单：**标记/取消该商品星标**（`setLiveStar`：本地 Set 更新 + `setLiveStars` 全量持久化）；
  - 画册卡片右键菜单补「标记/取消该商品星标」「🗑 取消全部星标…」（复用 `clearAllStars`）；
  - 画册卡片原本就按 `visGallery` 显示 `编号/售价/进价`（¥ 前缀、低库存高亮）——无需改动，仅文档补说明。
- **后端**（`handlers/live.ts` / `liveGrid.ts`）
  - `clearLiveStars`：清空 `live_star` 表回推 `liveState`；
  - `renderStarOverview`：读星标优先序 → 过滤已删商品 → 解析输出目录（沿用 `live_out_dir` 复用确认/另选的流程）→ **自动密度** `side = max(3, ⌈√n⌉)`，超出 `side×side` 自动分页多张 → `renderStarOverviewGrid`（白底 sharp 合成，逐格封面 `fit:fill` + SVG 标签压 `编号`(大)与 `¥售价`(黄) 双行，无图灰底）→ 文件名 `星标总览_{N}款_第{K}张_{ymd}.jpg`；生成后为每张出 **900px 宽缩略 base64** 随 `starOverviewDone` 消息回传前端预览（不落盘单独缩略图）；同时 `revealFileInOS` 打开输出目录 + `🖼` 日志气泡；
  - `openStarOutDir`：前端预览弹窗里「📂 打开文件夹」触发（`revealFileInOS` `live_out_dir`）；
  - 图内价格只标**售价**（直播前扫款用），进价不进图。
- 验证：`tsc -p ./` 0 error、`eslint src` 仅既有 4 条存量 warning、`node --check` ×2 通过。测试运行本次押后。

### 二十六·补记（星标交互第 4 版形态，2026-09-17）

用户试用心得的**收敛性修订**（此前 `e2569c1`、`029564c` 的入口冗余/一步到位被推翻）：

- **入口合并**：顶栏 4 个按钮（只看星标 / 复制星标 / 总览图 / 取消全部）→ 合并为单个「**⭐ 星标 ▾**」（`#starMenuBtn`）下拉子菜单（复用图片右键菜单组件 `showImageCtxMenu`：只想看（带 ✓ 回显数量）/ 复制星标清单 / 星标总览图（先预览）/ 取消全部…）；「✕ 取消全部星标」按钮删除，「取消全部」仅留**列表行右键**与**下拉子菜单**两处同一入口。
- **画册/行右键回退**：画册（封面）右键**不再放星标菜单**（恢复原样）；列表行右键删掉「标记/取消该商品星标」（操作列已有 ⭐ 按钮），**保留**「🗑 取消全部星标…」。相应删除 `setLiveStar`（取消本地持久化函数）与 `staron/stardoff` 两分支。
- **总览图「先预览，点生成才落盘」**：`renderStarOverview` 一分为二——`previewStarOverview`（`renderStarOverviewBuffer` 内存渲染 → 900px JPEG base64 回传，**不写盘不弹目录**）与 `generateStarOverview`（预览确认后同样弹输出目录确认/另选 → `renderStarOverviewGrid` 写盘 → `revealFileInOS` → `🖼` 日志 → `starOverviewDone`）。`liveGrid.ts` 把同一渲染拆成**内存 Buffer 版**（预览复用）与写文件包装版。
  - **前端弹窗**（`showStarOverviewPreview` / `onStarOverviewDone` + `starOv` 全局态）：多张可 `‹ 上一张 / 下一张 ›` **翻页**（N/M）；「✅ 生成」后按钮禁置、文案「正在生成…（会弹目录确认）」；完成后 footer 切「已生成 N 张 → 目录 [📂 打开文件夹] [完成]」；弹窗已关则只 toast。
- **批量标星**：批量栏新增「⭐ 标星」「☆ 取消星标」两个按钮（`setStarsForSelected(true/false)`：勾选商品全量标记/取消，本地 Set + `setLiveStars` 持久化）。
- **backend 约束修正**：handlers 由 `await fn(msg, h)` 裸调用（`index.ts`），`this` 为 `undefined` → `buildStarRows`/`chunksOf`/`type StarRow` 提到**工厂闭包**顶层，两个 handler 直接复用同份解析/分页逻辑。
- **文档**：manual §2.6 补批量星标、§2.7 重写为「⭐ 星标 ▾」四项口径。
- 验证：`tsc -p ./` 0 error、`eslint src` 0 error（188 条存量风格 warning）、`node --check` ×2 通过。

### 二十六·补记 2（可设每张几行×几列 · 弹窗点外部不再关 · 取消全部星标仅留下拉，2026-09-17）

三点追加修订（推翻上一条补记里的两处描述）：

- **每张排版可自定义（`liveGrid.ts` / `handlers/live.ts`）**：`renderStarOverviewBuffer`/`renderStarOverviewGrid` 参数由 `side`（只能方阵）改为 **`cols × rows`**（`idx→col=idx%cols, row=⌊idx/cols⌋`；预览/写盘同源）。`chunksOf(rows, cols, rowsN)`：固定排版时 `cap=cols·rows` 分页、末页留白格，不再自动膨胀；0/0=仍是自动方形（旧逻辑）。`resolveGrid(msg)` 收前端传入并夹取 1..10，缺省回退后端设置 `star_grid_cols`/`star_grid_rows`；`generateStarOverview` 把弹窗选中的排版 `setSetting` 持久化，下次预览/生成直接用。
- **前端弹窗排版控件（`client-product.js`）**：预览弹窗顶部「每张排版」下拉（自动 / 3×3 / 4×3 / 3×4 / 4×4 / 5×5 / 自定义…，自定义展开行×列数字框）。**改动即带 `cols/rows` 重发 `previewStarOverview`，弹窗原地换数据不重建不闪烁**（`starOv.reloading` 期间禁用控件、状态行「正在按…重新排版预览…」）；「✅ 生成」同参发给 `generateStarOverview`。`starOverviewPreview` 回带实际排版，弹窗标题/下拉按它回显。
- **弹窗不再一点外部就关（`client-core.js`）**：`showModal` 里 `mask` 点击关闭逻辑**删除**，改为挂 document `keydown` **Esc → `closeModal()`**（关闭时 `removeEventListener` 防泄漏）。所有弹窗统一：误点空白不丢内容，关靠按钮/Esc；右键菜单（`showImageCtxMenu`）点外部关闭保留。
- **列表行右键删「🗑 取消全部星标…」**（`client-product.js`）：菜单项与其 handler 一并删除，「取消全部星标」**只在「⭐ 星标 ▾」下拉**一处。
- **文档**：manual §2.7 补排版/弹窗说明、删列表右键口径、加「弹窗点空白不关」提示。
- 验证：`tsc -p ./` 0 error、`eslint src` 0 error、`node --check` ×2 通过。

## 二十七、列表页 UI 瘦身（工具栏合一 · 筛选归拢 · 提示折叠）

> 归档时间：2026-09-17。状态：**已实现**。用户审视列表页后反馈「太乱太杂」，选了 A/C/D 三项做。

- **A 工具栏合一 + 分组**（`fragment.html` / `client-product.js`）：
  - 独立的分页条 `<div id="productPager" class="toolbar">` **并入主 `.toolbar`**（撤销/重做之前），不再单独一行；新增 `.tb-sep`（1px 竖分隔线）把按钮分成「视图｜字段｜筛选｜星标」左组与「新建/导入 · 分页 · 撤销/重做」右组，`toolbar-fill` 弹性留白；`.toolbar` 本身 `flex-wrap` 兜底窄窗口换行；
  - `renderPager`：`total===0` 时隐藏整条分页（含两侧 `#pagerSepL/R` 分隔线，避免双竖线），不再显示孤零零「共 0 条」；`client-main.js` 的分页点击委托基于容器冒泡，位置变动无需改。
- **C 提示墙折叠**（`client-product.js` `renderList`）：表格底部 3 行说明改 `<details><summary>ℹ️ 操作提示</summary>`，默认收起、点开展开（原生 HTML，无 JS）。
- **D 筛选归拢 + 清除常驻**：
  - `fragment.html`：清除筛选按钮去掉 `visibility:hidden` 内联样式 → 初始 **`disabled` 灰态**，与状态下拉同组（两侧 `.tb-sep` 框成「筛选」组）；
  - `client-product.js` `syncClearFilterBtn` → `clear.disabled = !hasFilter()`（列头筛选/状态下拉每次改动都会调它，按钮随筛选即时置亮）；
  - **顺手清掉历史残留**：`client-report.js` 有行 `$("clearFilterBtn").style.visibility = hasFilter() ? "visible" : "hidden"` —— 月报页根本没有自己的清除按钮，切到月报会反过来覆盖商品页按钮显影，属跨面板串扰 bug，删除。
- **文档**：manual §2.3 补「清除按钮常驻灰态/分页并入顶栏/空结果自动隐藏分页/提示折叠」口径。
- 验证：`node --check` ×3（product/main/report）通过、`eslint` 0 error。

### 二十七·补记（滚动位置保留 + 分页移到下方，2026-09-17）

- **滚动弹回顶部根因**：`#tabProducts .table-wrap` 才是列表的实际滚动容器；任何改动（改格子/星标/库存…）→ 后端 `productsDelta` → `renderProducts()` → `renderList` 用 `innerHTML` 整段重建，滚动容器连同其 `scrollTop` 一起销毁 → 视角弹回表格顶部。
- **修复（A）**：`renderProducts()` 渲染前记 `#productListView .table-wrap.scrollTop`，渲染（列表视图）后还原——全操作受益，位置原地保留；内容变短时由浏览器自动钳制。`renderList` 里 `syncListCellState()` 会重打已选格高亮，不因保留滚动而丢。
- **分页条移到下方**（用户提出「下一页/上一页放下面更合理」）：`#productPager` 从顶栏内挪出，放到 `#productListView`/`#productGalleryView` 之后独立一行（`margin-top:8px`），删除两侧 `pagerSepL/R` 分隔线与对应显隐逻辑；空结果仍整条隐藏。
- 验证：`node --check` 通过。

### 二十七·补记2（分页居中 + 操作提示移到分页下方，2026-09-17）

- **分页居中**：`#productPager` 加 `justify-content:center`（用户提「移到中间？」即取中，居中更常见；改回右下角只需换成 `justify-content:flex-end`）。
- **操作提示改静态挂载**：从 `renderList` 的 `innerHTML` 里抽出，作为静态 `<details id="listHints">` 放在 `fragment.html` 中 `#productPager` 之后——顺序为「表格 → 分页 → 操作提示」，且列表/画册两种视图下都常驻（原来仅供列表）。样式（`summary` 光标/字号、内部间距）收进 `#listHints` CSS 而非内联。
- 验证：`node --check` 通过。

### 二十七·补记3（操作提示挪进「规则与设置」标签，2026-09-17）

- 用户嫌操作提示占列表页位置，指定挪走：「不要放在列表那边」。
- `fragment.html`：删除列表底部的 `<details id="listHints">` 与其 CSS；在 `#tabSettings` 里新增「**商品列表操作提示**」panel（置于「录入与命名规范」之前），内容原样搬入。
- 日期/无 JS 改动；manual §2.3 提示语同步。

### 二十七·补记4（分页贴底 + 表格区撑满，2026-09-18）

- 用户要「上一页/下一页挨到（视图）底部，表格区域大点儿」。
- **布局改 flex 纵向**：`#tabProducts.show` → `display:flex; flex-direction:column; height:calc(100vh - 112px); overflow:hidden`；工具栏/分页条固定（`flex:1; min-height:0` 给两个视图容器），`.table-wrap` 的 `max-height:calc(100vh - 300px); min-height:320px` 改 `flex:1; max-height:none` → 表格区自动吃满视口余高，滚动发生在表内。
- 显示切换不再依赖 `inline display:block/none`：`#productListView/#productGalleryView` 的 markup 去掉内联样式，样式表默认 `display:flex`；`renderProducts()` 里 JS 切换改为 `style.display = ""` / `"none"`（空串回落到 flex）。
- 画册容器单独 `overflow-y:auto`；滚动位置保留逻辑不受影响（仍记/还原 `.table-wrap.scrollTop`）。
- 验证：`node --check`、`eslint` 通过。

## 二十八、日志开关改右下角幽灵图标（全局壳）· 星标总览每次弹选目录

> 归档时间：2026-09-18。状态：**已实现**。

### 一、运行日志按钮 → 右下角小图标（`src/webview/main.html`，全局壳、所有工具受益）

- 用户反馈「运行日志按钮好占空间」，选了右下角方案（主要是开发时看，不需日常占位）。
- 删除顶部整行 `<div class="top-row">`（含边框/留白约 35px）；`#logPanelToggle` 改为 `<body>` 直属、`position:fixed; bottom:14px; right:16px`，`opacity:0.35` 半透明、hover 变 `1`，`z-index:50` 浮于内容之上；label 仍是「📋 运行日志」。JS `setLogCollapsed`/onclick/**`active` 高亮逻辑原样不动**。

### 二、星标总览图：出图目录跟「导出 Excel」一致，每次弹选（`handlers/live.ts` / `client-product.js`）

- 用户要求：不要默认桌面/默认上次目录，要像导出 Excel 一样**每次直接弹文件夹选择框**。
- `generateStarOverview`：**删掉**「读 `live_out_dir` → 若存在则 `ctx.confirm` 复用、取消才另选」整段，改为无条件 `await ctx.selectFolder("选择星标总览输出目录")`，取消则 `log("❌未选择输出目录，已取消")` 返回；**不再写 `live_out_dir`**——星标总览目录与直播排品九宫格 `live_out_dir` 彻底解耦。
- `openStarOutDir(msg)`：优先用 `msg.dir`（前端把 `starOverviewDone` 带回的目录存在 `starOv.lastDir`，「📂 打开文件夹」随 `dir` 发出），不存在才退回 `live_out_dir`，再没有才报「还没生成过总览图」。
- 生成中提示文案「会弹目录确认」→「请选择输出目录」。

## 二十九、清除筛选按钮改回「有筛选才出现」

> 归档时间：2026-09-18。状态：**已实现**。

- 用户对筛选交互表态「其实也还行 不换了」，仅改一处：清除筛选按钮**不再常驻灰态**，而是**只在任一筛选生效时显示**（`syncClearFilterBtn` 改 `row.style.display = hasFilter() ? "" : "none"`；`client-product.js:628`）。与「二十七」里 D 项的「常驻 disabled」相反，属用户定夺回退。
- `fragment.html`：`#clearFilterBtn` 初始去掉 `disabled`、改 `style="display:none"`（初始化走 `syncClearFilterBtn` 定显隐）；点击行为不变（`client-main.js:97` 一键清全部）。
- manual §2.3 措辞同步为「有任一筛选生效时出现清除筛选按钮」；验证：`node --check`、`eslint` 通过。
- 验证：`tsc -p ./`、`eslint`、`node --check`。
