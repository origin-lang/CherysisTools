// shopTool 前端模块（加载顺序第 3 个）：商品管理（列表/画册/筛选/内联编辑/批量/新建/导入/入库/列设置/右键菜单）
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
function cellValue(p, key) {
  switch (key) {
    case "code":
      return p.code;
    case "grade":
      return displayGrade(p);
    case "status":
      return p.status === 1 ? "已下架" : "在售";
    case "netTotal":
      return String(p.soldTotal - p.refundTotal);
    case "cost_price":
      return String(p.cost_price);
    case "sale_price":
      return String(p.sale_price);
    case "stockTotal":
      return String(p.stockTotal || 0);
    case "soldTotal":
      return String(p.soldTotal || 0);
    case "purchase_link":
      return p.purchase_link || "";
    default:
      return String(p[key] ?? "");
  }
}

var selCell = null; // { pid, field } 列表视图当前选中的单元格
var appClipboard = null; // { value } 内部单元格剪贴板内容 | null
var pendingImportToken = ""; // 商品导入「解析预览→确认提交」的令牌
var ipMask = null; // 当前商品导入弹窗遮罩（提交成功/取消后复位）

// series 从这里挪走了：它现在是「离散值多选」的一员（ENUM_FILTER_FIELDS）。
// 留着的话会被当作子串再筛一遍，而多选存的是数组，String(数组) 是 "A,B" 这种串，
// 拿去 includes 永远匹配不上，筛选会直接变成空表。下面的循环里也补了一道防护。
const TEXT_FILTER_FIELDS = new Set([
  "name",
  "soldTotal",
  "netTotal",
  "remark",
]);
const RANGE_FILTER_FIELDS = new Set(["cost_price", "sale_price", "stockTotal"]);
// 离散值列：取值有限可枚举，适合「勾哪几个看哪几个」。像进价这种连续数值、
// 名称备注这种自由文本，硬做成勾选列表只会得到一个滚不到头的清单，
// 所以那几列继续沿用原来的表达式写法（范围 / 子串 / 编号语法）。
// status 也在里面：取值只有「在售 / 已下架」两种，cellValue 本来就出中文标签
// （注意 status===0 是「在售」、===1 是「已下架」），多选比单选下拉顺手。
const ENUM_FILTER_FIELDS = new Set(["category", "series", "grade", "status"]);
// 编号列筛选语法：含 ~ 走「前缀+数字区间」，否则沿用子串匹配。
const CODE_HINT =
  "筛选编号：支持 A1~A33 / a1~a33 / 1~33（两端无字母按 A 段）/ 多段 A1~A33,L1~L22；" +
  "~ 两侧空格可忽略；单个带字母的编号按精确匹配（L1→L001，" +
  "要「所有 L1xx」请写 L1~L199）；纯数字或文本按子串匹配（如 007、7、A）。";
// 一个范围项：字母+数字 ~ 字母+数字，~ 两侧允许空格
const CODE_TERM_RE = /^([A-Za-z]?)(\d{1,4})\s*~\s*([A-Za-z]?)(\d{1,4})$/;
// 列表分隔（不含空格：空格留给 ~ 两侧的容错）
const CODE_LIST_RE = /[,，、;；\n\r]+/;
const CODE_HAS_RANGE_RE = /~/;

/**
 * 单个编号词元 → {p,n}；字母可省（按 A 段），n ∈ 0~9999。非编号词元返回 null。
 * bareAsA=false 时要求必须带字母（排序沿用旧口径：裸数字不参与字母分组）。
 */
function parseCodeTok(s, bareAsA) {
  const m = String(s ?? "")
    .trim()
    .match(/^([A-Za-z]?)(\d{1,4})$/);
  if (!m) {
    return null;
  }
  if (!m[1] && bareAsA === false) {
    return null;
  }
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n < 0 || n > 9999) {
    return null;
  }
  return { p: (m[1] || "A").toUpperCase(), n };
}

const CODE_BAD_HINT = {
  mixedPrefix: "两侧字母不一致：请用同一个字母，如 A1~A33",
  halfPrefix: "字母要么两端都写（A1~A33），要么两端都不写（1~33）",
  reversed: "区间反了，请从小到大写，如 A1~A33",
  invalid: "解析不出合法区间：格式为 字母+数字~字母+数字，如 A1~A33",
};

/**
 * 解析编号列筛选表达式 → { terms, bad, msg }。
 * 逗号分段，多段取并集。每段：
 *  - 含 ~ → 区间项（两端字母要么都有要么都没有，无字母按 A 段）；
 *  - 带字母的单值（A7 / l007）→ 精确编号项（lo=hi），补零口径与库里一致；
 *  - 其余（纯数字 7/007、文本 A、链…）→ 子串项，维持旧行为。
 * 含 ~ 但解析失败时 bad=true（0 结果 + 红框提示，不静默出空表）。
 */
function parseCodeQuery(raw) {
  const q = { terms: [], bad: false, msg: "" };
  const groups = String(raw ?? "").split(CODE_LIST_RE);
  for (const g of groups) {
    const s = g.trim();
    if (!s) {
      continue;
    }
    if (!CODE_HAS_RANGE_RE.test(s)) {
      const one = parseCodeTok(s, false);
      q.terms.push(
        one
          ? { kind: "range", p: one.p, lo: one.n, hi: one.n }
          : { kind: "text", s: s.toLowerCase() },
      );
      continue;
    }
    const m = s.match(CODE_TERM_RE);
    if (!m) {
      if (!q.bad) {
        q.bad = true;
        q.msg = `「${s}」${CODE_BAD_HINT.invalid}`;
      }
      continue;
    }
    const p1 = m[1].toUpperCase();
    const p2 = m[3].toUpperCase();
    let why = "";
    if (p1 && p2 && p1 !== p2) {
      why = CODE_BAD_HINT.mixedPrefix;
    } else if (!!p1 !== !!p2) {
      why = CODE_BAD_HINT.halfPrefix;
    }
    const lo = Number(m[2]);
    const hi = Number(m[4]);
    if (!why && lo > hi) {
      why = CODE_BAD_HINT.reversed;
    }
    if (why) {
      if (!q.bad) {
        q.bad = true;
        q.msg = `「${s}」${why}`;
      }
      continue;
    }
    q.terms.push({ kind: "range", p: p1 || p2 || "A", lo, hi });
  }
  return q;
}

function matchCodeRange(code, t) {
  const c = parseCodeTok(code);
  if (!c || c.p !== t.p) {
    return false;
  }
  return c.n >= t.lo && c.n <= t.hi;
}

/** 编号是否命中筛选表达式；多段取并集（任一段命中即列出）。表达式写错（bad）一律不命中，空表达式视为不过滤。 */
function matchCodeQuery(code, q) {
  if (!q) {
    return true;
  }
  if (q.bad) {
    return false;
  }
  if (!q.terms.length) {
    return true;
  }
  for (const t of q.terms) {
    if (t.kind === "range") {
      if (matchCodeRange(code, t)) {
        return true;
      }
    } else if (
      String(code ?? "")
        .toLowerCase()
        .includes(t.s)
    ) {
      return true;
    }
  }
  return false;
}

let _cqRaw = null;
let _cqParsed = null;
/** parseCodeQuery 的一格记忆：一次渲染会多次调 filteredProducts，避免重复解析。 */
function codeQueryMemo(raw) {
  const k = String(raw ?? "");
  if (_cqRaw !== k) {
    _cqRaw = k;
    _cqParsed = parseCodeQuery(k);
  }
  return _cqParsed;
}

// —— 工具栏全局搜索：跨列找一行，跟列头漏斗是叠加关系不是替代 ——
// 漏斗是「结构化筛一批」（勾枚举 / 写范围），这里是「凭印象找一行」：记不清编号前缀
// 或者只记得「香薰摆件」里有哪几个字时用。两者 AND 叠加，随便一起开。
//
// 匹配口径照搬删除前那版（f09f3e7 删掉、这次按原样找回），两个已知行为保持不变：
//   ① 四个字段是用空格拼成一句话再匹配的，所以「200ml 个护」会命中
//      「名称尾=200ml 且 品类=个护」的行。坑在打法的空格得正好对上字段之间那道缝：
//      「香薰 蜡烛」是搜不到的，因为「香薰」只是「香薰蜡烛」的前缀，不是一个完整字段值。
//      看着像巧合，但一直是这个语义，改了就是另一套；
//   ② 编号的「去零兜底」只作用于编号列，且关键字里只要含数字就启用，
//      所以「香薰 12」也会顺带去编号里找 12。误伤面小（只可能捞中编号，意图八成也是编号）。
//
// 上面两条只属于「全部」这条路径。工具栏那个「搜哪一列」下拉（kwScope）默认 all；
// 选定某一列后只剩该列的子串匹配，①的跨字段空格和②的去零兜底都不再走。
// 不跟着收窄的话会出现最莫名其妙的一种结果：明明选了「名称」，打「香薰 12」
// 还捞出一堆编号对不上的行。
const KEYWORD_FIELDS = ["code", "name", "category", "series"];
// 下拉的可选列 = 这份清单的唯一出处：fragment.html 的 <option> 照它排，client-main 的
// 占位符/提示文案照它取标签。取值一律走 cellValue —— 状态那列出的是「在售/已下架」，
// 和漏斗面板、画册、导出是同一套中文标签，不用另写映射。
const KW_SCOPE_LABEL = { code: "编号", name: "名称", category: "品类", series: "系列", status: "状态" };
let kwScope = "all";
let _kwRaw = null;
let _kwParsed = null;
/** 跟 codeQueryMemo 同一套一格记忆：一次渲染会多次过 filteredProducts，别每行都重算。 */
function keywordMemo(raw) {
  const k = String(raw ?? "");
  if (_kwRaw !== k) {
    _kwRaw = k;
    const kw = k.trim().toLowerCase();
    _kwParsed = { kw, digits: kw.replace(/\D/g, "") };
  }
  return _kwParsed;
}

function matchKeyword(p, q) {
  if (!q.kw) {
    return true;
  }
  if (kwScope !== "all") {
    // 单列：只在这一列里找子串。大小写不敏感。
    // 不用去零兜底：选了「编号」的话子串本来就够（L007 含 7、L76 含 76），
    // 再兜一遍没多捞出任何行；选了别的列则是纯粹添乱。
    return String(cellValue(p, kwScope) ?? "")
      .toLowerCase()
      .includes(q.kw);
  }
  const hay = KEYWORD_FIELDS.map((f) => String(p[f] ?? "")).join(" ");
  if (hay.toLowerCase().includes(q.kw)) {
    return true;
  }
  return q.digits.length > 0 && String(p.code ?? "").replace(/\D/g, "").includes(q.digits);
}

function saveFieldValue(pid, field, raw) {
  const res = sanitizeProductField(field, raw);
  if (!res.ok) {
    toast(res.msg);
    return false;
  }
  if (field === "stockTotal") {
    post({ type: "setStockQty", id: pid, qty: res.value });
  } else {
    post({
      type: "updateProductField",
      id: pid,
      field,
      value: field === "grade" ? Number(res.value) : res.value,
    });
    if (res.truncated) {
      toast("已保存（超出长度已截断）");
      return "truncated";
    }
  }
  toast("已保存");
  return true;
}

function selectListCell(pid, field) {
  selCell = { pid: Number(pid), field: String(field) };
  syncListCellState();
}

function copyCell(p, field) {
  const value = field ? cellValue(p, field) : "";
  copyText(value, "已复制该格 ✅");
  appClipboard = value;
}

function cutCell(p, field) {
  if (!CUTTABLE_FIELDS.has(field)) {
    toast("该列不可清空，无法剪切");
    return;
  }
  const value = field ? cellValue(p, field) : "";
  copyText(value);
  appClipboard = value;
  const r = saveFieldValue(p.id, field, "");
  toast(r === false ? "已复制，但源格清空失败" : `已剪切并清空源格 ✅`);
  if (selCell && selCell.pid === p.id && selCell.field === field) {
    selectListCell(p.id, field);
  }
}

function pasteCell(pid, field) {
  const doPaste = (val) => {
    const v = String(val ?? "").trim();
    if (!v) {
      toast("剪贴板无内容");
      return;
    }
    saveFieldValue(pid, field, v);
    syncListCellState();
  };
  if (appClipboard) {
    doPaste(appClipboard);
  } else if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard
      .readText()
      .then(doPaste)
      .catch(() => toast("无法读取系统剪贴板"));
  } else {
    toast("剪贴板为空：请先右击「复制」或「剪切」");
  }
}

function syncListCellState() {
  document
    .querySelectorAll("#productListView td.cell-selected")
    .forEach((el) => el.classList.remove("cell-selected"));
  if (selCell) {
    const td = document.querySelector(
      `#productListView td[data-pid="${selCell.pid}"][data-f="${selCell.field}"]`,
    );
    if (td) {
      td.classList.add("cell-selected");
    }
  }
}

function filteredProducts() {
  const cq = codeQueryMemo(filters.f_code);
  const kw = keywordMemo(filters.keyword);
  // 枚举列勾选集合预先整理成 Set：原版每条商品都 filterCurrent() 一次、再展开一次数组，
  // 筛选面板的勾选在这一次计算里不会变，算一次就好。
  const enumPicks = new Map();
  for (const key of ENUM_FILTER_FIELDS) {
    const picked = filterCurrent(key);
    if (picked.length > 0) {
      enumPicks.set(key, new Set(picked));
    }
  }
  // 走子串匹配的文本框字段（排除走多选那条通道的枚举列）
  const textKeys = [...TEXT_FILTER_FIELDS].filter((k) => !ENUM_FILTER_FIELDS.has(k));
  const rangeKeys = [...RANGE_FILTER_FIELDS];

  // 原版是五段链式 filter（每段把数组整份重拷一遍再重扫），合并成一趟遍历：
  // 各路谓词在同一趟里全判断完，判断顺序与原来一致，都不改变结果。
  const out = [];
  test: for (const p of state.products) {
    for (const [key, pick] of enumPicks) {
      if (!pick.has(cellValue(p, key))) {
        continue test;
      }
    }
    if (!matchCodeQuery(p.code, cq)) {
      continue;
    }
    for (const key of textKeys) {
      const v = filters["f_" + key];
      if (
        v &&
        !String(cellValue(p, key)).toLowerCase().includes(String(v).toLowerCase())
      ) {
        continue test;
      }
    }
    for (const key of rangeKeys) {
      const raw = filters["f_" + key];
      if (!raw) {
        continue;
      }
      const [mn, mx] = splitRangeValue(raw);
      if (mn && Number(p[key]) < Number(mn)) {
        continue test;
      }
      if (mx && Number(p[key]) > Number(mx)) {
        continue test;
      }
    }
    if (
      filters.f_stared &&
      !(state.liveStars && state.liveStars.has(p.code))
    ) {
      continue;
    }
    // 全局搜索放最后：当最后一道关，前面漏斗/范围已经把大部分行筛掉了
    if (!matchKeyword(p, kw)) {
      continue;
    }
    out.push(p);
  }

  // 排序：显示值/排序器都只算一次，比每比一次都重取省一个量级。
  // 排序结果与原来完全一致——编号走 parseCodeTok + 数字补齐比较，其余数字列比数字、
  // 混合或文本列比显示值，用的排序器locale也保持 zh-Hans-CN 不变。
  if (sortKey === "code") {
    out.sort((a, b) => {
      const ca = parseCodeTok(a.code, false);
      const cb = parseCodeTok(b.code, false);
      let r;
      if (ca && cb) {
        r = ca.p < cb.p ? -1 : ca.p > cb.p ? 1 : ca.n - cb.n;
      } else {
        r = String(a.code || "").localeCompare(String(b.code || ""));
      }
      return r * sortDir;
    });
    return out;
  }
  const coll = new Intl.Collator("zh-Hans-CN");
  const keyed = out.map((p) => {
    const va = p[sortKey];
    if (typeof va === "number") {
      return { p, num: va };
    }
    return { p, str: cellValue(p, sortKey) };
  });
  keyed.sort((a, b) => {
    let r;
    if (typeof a.num === "number" && typeof b.num === "number") {
      r = a.num - b.num;
    } else if (typeof a.num === "number") {
      r = -1;
    } else if (typeof b.num === "number") {
      r = 1;
    } else {
      r = coll.compare(a.str, b.str);
    }
    return r * sortDir;
  });
  return keyed.map((x) => x.p);
}

function lowStock(p) {
  return (
    state.settings.stock_alert > 0 &&
    p.status === 0 &&
    p.stockTotal <= state.settings.stock_alert
  );
}

function fillCatList() {
  const dl = $("shopCatList");
  if (!dl) {
    return;
  }
  const set = new Set(PRESET_CATEGORIES);
  for (const p of state.products) {
    if (p.category) {
      set.add(p.category);
    }
  }
  dl.innerHTML = [...set]
    .map((c) => `<option value="${esc(c)}"></option>`)
    .join("");
}

// 灯箱缩放范围。1 = 原始适配大小（CSS 里的 max-width/max-height 决定）
const LB_ZOOM_MIN = 0.2;
const LB_ZOOM_MAX = 8;
const LB_ZOOM_STEP = 1.15;

function lbStage() {
  return document.getElementById("lbStage");
}

// 缩放只改 img 的**真实** width/height，不走 transform: scale()：
// transform 不改变布局尺寸，舞台拿不到真实滚动范围，放大后边缘就够不着了。
function applyLbZoom() {
  const stage = lbStage();
  const big = document.getElementById("lbBig");
  if (!stage || !big || !state.lbBase) {
    return;
  }
  const z = state.lbZoom;
  if (z === 1) {
    // 四个一起清：下面放大时会把 max-* 写成 none，复位不还原的话
    // 图片会按原始像素铺开、再也不受 860px / 62vh 约束
    big.style.width = "";
    big.style.height = "";
    big.style.maxWidth = "";
    big.style.maxHeight = "";
  } else {
    // max-width/max-height 是**硬上限，优先级高于 width**：不解除的话
    // 想放到 1720px 会被砍回 860px，而图片本来就在上限上，等于纹丝不动；
    // object-fit:contain 再把多出来的横向空间填成白边（看着像「没放大、
    // 反而左右多出白边」）。写 width/height 之前必须先解除这两个上限。
    big.style.maxWidth = "none";
    big.style.maxHeight = "none";
    big.style.width = Math.round(state.lbBase.w * z) + "px";
    big.style.height = Math.round(state.lbBase.h * z) + "px";
  }
  // 只有真溢出了才提示可拖动
  stage.classList.toggle(
    "lb-pannable",
    stage.scrollWidth > stage.clientWidth + 1 ||
      stage.scrollHeight > stage.clientHeight + 1
  );
}

function resetLbZoom() {
  state.lbZoom = 1;
  applyLbZoom();
}

// 缩放锚在指针位置：按 scroll 补偿，让指针下那一个像素点在缩放前后不动，
// 否则滚轮往上滚时画面会「往一边跑」，放大到某个角落根本盯不住。
function zoomLbAt(clientX, clientY, next) {
  const stage = lbStage();
  if (!stage || !state.lbBase) {
    return;
  }
  const z = Math.min(LB_ZOOM_MAX, Math.max(LB_ZOOM_MIN, next));
  if (z === state.lbZoom) {
    return;
  }
  const r = stage.getBoundingClientRect();
  const px = clientX - r.left + stage.scrollLeft;
  const py = clientY - r.top + stage.scrollTop;
  const f = z / state.lbZoom;
  state.lbZoom = z;
  applyLbZoom();
  stage.scrollLeft = px * f - (clientX - r.left);
  stage.scrollTop = py * f - (clientY - r.top);
}

function openLightbox(product) {
  // closeLightbox() 必须排在赋值**前面**：它会把 state.lbCode 清成 null，
  // 反过来先赋值就会被自己刚清掉的那个值抹回去，后面所有 imagesLoaded 都对不上 code。
  closeLightbox();
  state.lbCode = product.code;
  state.lbIdx = 0;
  state.lbZoom = 1;
  state.lbBase = null;
  state.lbDragged = false;
  state.lbImagesLoaded = false;
  state.lbNames = [];
  // 缓存键是 `${code}:${文件名}`，同一商品内复用是安全的（文件名变了就是另一张图，
  // 不存在「序号被复用」那种张冠李戴）。但别的商品的条目留着纯占内存（一张图转成
  // base64 能有几 MB），开新的就把它们清掉。
  const keep = `${product.code}:`;
  for (const k of Object.keys(state.lbFullCache)) {
    if (!k.startsWith(keep)) {
      delete state.lbFullCache[k];
    }
  }
  const lb = document.createElement("div");
  lb.id = "lbBox";
  lb.className = "lightbox";
  lb.innerHTML = `
          <div class="lb-head">
            <span><b>${esc(product.code)}</b> ${esc(product.name)} <span class="muted" style="color:#aaa">（${esc(displayGrade(product))}・售价 ¥${money(product.sale_price)}）</span></span>
            <span style="display:flex;gap:8px;align-items:center">
              <button id="lbCopy">📋 复制完整名称</button>
              <button id="lbUpload">🖼 上传图片</button>
              <button id="lbClearImg" class="btn-danger">清空图片夹</button>
              <button class="lb-cls" id="lbClose">✕</button>
            </span>
          </div>
          <div class="lb-stage" id="lbStage">
            <img class="big" id="lbBig" style="display:none" />
          </div>
          <div class="thumbs" id="lbThumbs"><span class="muted" style="color:#aaa">图片加载中…</span></div>`;
  const stage = lb.querySelector("#lbStage");
  const big = lb.querySelector("#lbBig");
  lb.addEventListener("click", (e) => {
    // 拖动平移结束时浏览器照样补一个 click，不挡掉的话平移一下灯箱就关了
    if (state.lbDragged) {
      state.lbDragged = false;
      return;
    }
    // e.target === stage 这条不能少：图片周围那片空白现在落在 stage 上，
    // 只认 lb 的话点空白就关不掉了
    if (e.target === lb || e.target === stage) {
      closeLightbox();
    }
  });
  // 黑区右键：以前只挂了 click，黑区没拦 contextmenu，右键就漏到 VS Code
  // 宿主菜单去了。跟图片右键走同一套菜单。
  lb.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".thumbs")) {
      return; // 缩略图自己有菜单
    }
    e.preventDefault();
    openCurrentLightboxMenu(e);
  });
  // 图片载入完量一次「缩放 1 倍」的真实显示尺寸，作为所有缩放的基准。
  // 量之前四个属性都得清：applyLbZoom 放大时把 max-* 写成了 none，
  // 只清 width/height 的话会量到「上限已解除」下的原始像素尺寸而不是适配尺寸，
  // 于是「放大着看 A → 点缩略图切 B」时 B 的基准偏大，之后每一步放大都跟着偏。
  big.addEventListener("load", () => {
    if (state.lbCode !== product.code) {
      return; // 灯箱已关/已换商品，别往陈旧的 state 上写
    }
    big.style.width = "";
    big.style.height = "";
    big.style.maxWidth = "";
    big.style.maxHeight = "";
    state.lbBase = { w: big.offsetWidth, h: big.offsetHeight };
    applyLbZoom();
  });
  big.addEventListener("dblclick", (e) => {
    e.preventDefault();
    resetLbZoom();
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      // ctrl+wheel 留给 VS Code 自己的界面缩放，别抢
      if (e.ctrlKey || e.metaKey || !state.lbBase) {
        return;
      }
      e.preventDefault();
      zoomLbAt(e.clientX, e.clientY, state.lbZoom * (e.deltaY < 0 ? LB_ZOOM_STEP : 1 / LB_ZOOM_STEP));
    },
    { passive: false }
  );
  // 拖拽平移：只在舞台**真的溢出**时才启动。
  // 1 倍时 overflow 恒为 0，点黑区照常关闭、拖一下也不会误吞关闭。
  let drag = null;
  stage.addEventListener("mousedown", (e) => {
    if (e.button !== 0) {
      return;
    }
    if (
      stage.scrollWidth <= stage.clientWidth + 1 &&
      stage.scrollHeight <= stage.clientHeight + 1
    ) {
      return;
    }
    drag = {
      x: e.clientX,
      y: e.clientY,
      sl: stage.scrollLeft,
      st: stage.scrollTop,
      moved: false,
    };
    stage.classList.add("lb-dragging");
  });
  const endDrag = () => {
    if (!drag) {
      return;
    }
    if (drag.moved) {
      state.lbDragged = true;
    }
    drag = null;
    stage.classList.remove("lb-dragging");
  };
  const onMove = (e) => {
    if (!drag) {
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag.moved = true;
    }
    stage.scrollLeft = drag.sl - dx;
    stage.scrollTop = drag.st - dy;
  };
  // 这两个挂在 window 上，lb.remove() 摘不掉元素级监听器。
  // 不显式回收的话，每开一次灯箱就漏两个 window 监听器 + 一整棵已脱离文档的 DOM。
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", endDrag);
  state.lbTeardown = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", endDrag);
  };
  document.body.appendChild(lb);
  lb.querySelector("#lbClose").onclick = closeLightbox;
  lb.querySelector("#lbCopy").onclick = () => copyText(fullName(product));
  lb.querySelector("#lbUpload").onclick = () =>
    post({ type: "uploadImages", code: product.code });
  lb.querySelector("#lbClearImg").onclick = async () => {
    if (
      await confirmBox(
        `确认清空 ${product.code} 的图片文件夹？（文件会真的删除）`,
      )
    ) {
      // 同右键删图：这个按钮就长在抽屉里，#lbBig 正在用 webview URI 读原图，
      // Chromium 攥着句柄不清空不掉。先关抽屉再发请求。
      closeLightbox();
      requestAnimationFrame(() => {
        post({ type: "clearImages", code: product.code });
      });
    }
  };
  post({ type: "getImages", code: product.code });
}

function closeLightbox() {
  const lb = document.getElementById("lbBox");
  if (state.lbTeardown) {
    state.lbTeardown();
    state.lbTeardown = null;
  }
  if (lb) {
    lb.remove();
  }
  // 必须清掉：灯箱关了还留着 code，拖放/粘贴的落点解析（productForDropOrPaste）会
  // 拿它去找商品，imagesLoaded / fullImageLoaded 也会误以为灯箱还开着，
  // 往一个没人看的 state 上写，下次开别的商品时那份陈旧数据就成了串味的来源
  state.lbCode = null;
}

function filterSig(list) {
  return JSON.stringify({
    len: list.length,
    filters,
    sortKey,
    sortDir,
    // 搜索范围也是结果集的一部分：查询词一个字没改、只切了下拉，行就换了。
    // 不把它算进 sig 的话，切范围时若新旧结果条数刚好相同，翻到第 2 页不会退回第 1 页。
    kw: kwScope,
  });
}

// 表头的重建判据，照 filterSig 的写法。
// 刻意**不含** filters 和 state.products 的版本号：这两样一变就重画表头，
// 现在表头上没有输入框了，这一条是为了保住横向滚动位置和已绑定的事件，
// 筛选状态改由 refreshHeadFilterMarks() 描回漏斗上，不需要动 DOM。
// 品类/系列的选项清单也不再进签名：它们在打开面板那一刻才算，实时且不必为此重画表头。
function headSig() {
  return JSON.stringify({
    vis: [...visList],
    img: showImageList,
    ops: showOpsList,
    sortKey,
    sortDir,
  });
}

function paginate(list) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (listPage > pages) {
    listPage = pages;
  }
  if (listPage < 1) {
    listPage = 1;
  }
  const start = (listPage - 1) * pageSize;
  return { total, pages, page: list.slice(start, start + pageSize) };
}

// 分页条外壳只建一次，之后只改会变的几处（条数/页码/前后按钮禁用态/每页下拉的选中值），
// 不再每次整条 innerHTML 重建：排序、筛选、改格子都会触发重渲染，重建 pager 是纯浪费，
// 还会把用户正往跳页框里输的半截数字打断。
let pagerRefs = null;
function renderPager(pd) {
  const el = $("productPager");
  if (!el) {
    return;
  }
  const show = pd.total > 0;
  el.style.display = show ? "" : "none";
  if (!show) {
    return;
  }
  if (!pagerRefs) {
    el.innerHTML = `
        <span class="muted">共 <b id="pagerCount"></b> 条　每页</span>
        <select id="pageSizeSel">
          ${[50, 100, 200, 500].map((n) => `<option value="${n}">${n}</option>`).join("")}
        </select>
        <button class="mini-btn" data-pg="prev">‹ 上一页</button>
        <span class="muted">第 <b id="pagerCur"></b> / <span id="pagerTotal"></span> 页</span>
        <button class="mini-btn" data-pg="next">下一页 ›</button>
        <input id="pageJump" type="number" min="1" max="999999" placeholder="跳页" style="width:56px" />
      `;
    pagerRefs = {
      count: el.querySelector("#pagerCount"),
      cur: el.querySelector("#pagerCur"),
      total: el.querySelector("#pagerTotal"),
      sel: el.querySelector("#pageSizeSel"),
      prev: el.querySelector('[data-pg="prev"]'),
      next: el.querySelector('[data-pg="next"]'),
      jump: el.querySelector("#pageJump"),
    };
  }
  pagerRefs.count.textContent = pd.total;
  pagerRefs.cur.textContent = listPage;
  pagerRefs.total.textContent = pd.pages;
  pagerRefs.prev.disabled = listPage <= 1;
  pagerRefs.next.disabled = listPage >= pd.pages;
  if (Number(pagerRefs.sel.value) !== pageSize) {
    pagerRefs.sel.value = String(pageSize);
  }
  const jump = pagerRefs.jump;
  jump.max = String(pd.pages);
  // 用户正往跳页框里打字时别清它；没在输入就还原成空再接新的
  if (document.activeElement !== jump) {
    jump.value = "";
  }
}

function tableScrollTop() {
  const wrap = document.querySelector("#productListView .table-wrap");
  return wrap ? wrap.scrollTop : 0;
}

function renderProducts() {
  // 列表重渲染前记住内部滚动偏移，渲染后还原——改格子/星标/库存等操作不再被弹回顶部
  const prevScroll = viewMode === "list" ? tableScrollTop() : 0;
  const list = filteredProducts();
  const sig = filterSig(list);
  if (sig !== lastFilterSig) {
    lastFilterSig = sig;
    listPage = 1;
  }
  const pd = paginate(list);
  renderPager(pd);
  if (viewMode === "gallery") {
    $("productListView").style.display = "none";
    $("productGalleryView").style.display = "";
    renderGallery(pd.page);
  } else {
    $("productListView").style.display = "";
    $("productGalleryView").style.display = "none";
    renderList(pd.page);
    const wrap = document.querySelector("#productListView .table-wrap");
    if (wrap) {
      wrap.scrollTop = prevScroll;
    }
  }
  ensureCovers(pd.page);
}

// 没有列头筛选的列：累计售出/净售是统计列（筛它们没意义，库存才有意义），
// 采购链接是长 URL（勾选列表和子串都没意义）。status 不在这儿了——
// 它走 ENUM_FILTER_FIELDS 的勾选面板，比原先工具栏那个单选下拉顺手。
const NO_FILTER_FIELDS = new Set(["soldTotal", "netTotal", "purchase_link"]);

// —— 表头筛选：点表头上的漏斗弹面板 ——
// 选项后面的数字按「整份商品里这个值共有多少条」算，不叠加别的列的筛选。
// 这是 Excel 的口径，好处是数字稳定：你在别的列改筛选时，这里的数不会跟着一起跳。
function enumOptions(key) {
  const tally = new Map();
  for (const p of state.products) {
    const v = cellValue(p, key);
    if (!v) {
      continue;
    }
    tally.set(v, (tally.get(v) || 0) + 1);
  }
  return [...tally.entries()]
    .map(([v, n]) => ({ v, n }))
    .sort((a, b) => String(a.v).localeCompare(String(b.v), "zh-Hans-CN"));
}

// 这一列用什么方式筛。返回空串 = 不提供入口（沿用 NO_FILTER_FIELDS 的老规矩）。
function filterKind(key) {
  if (ENUM_FILTER_FIELDS.has(key)) {
    return "enum";
  }
  if (RANGE_FILTER_FIELDS.has(key)) {
    return "range";
  }
  if (key === "code") {
    return "code";
  }
  if (NO_FILTER_FIELDS.has(key)) {
    return "";
  }
  return "text";
}

const EXPR_LABEL = {
  cost_price: "进价",
  sale_price: "售价",
  stockTotal: "库存",
  name: "名称",
  remark: "备注",
};

function exprTitle(key) {
  if (RANGE_FILTER_FIELDS.has(key)) {
    return `筛选${EXPR_LABEL[key]}：输入 10~30 表示 10 到 30，也可直接输 10 或 >10 / <30`;
  }
  if (key === "code") {
    return CODE_HINT;
  }
  return `筛选${EXPR_LABEL[key]}：输入包含的文字，回车或点「确定」生效`;
}

function exprPlaceholder(key) {
  if (RANGE_FILTER_FIELDS.has(key)) {
    return "范围";
  }
  if (key === "code") {
    return "编号/范围";
  }
  return "含关键词";
}

// 当前这一列选了哪些值（enum）/ 写了什么表达式（其余）。
// 写成数组还是字符串由 filterKind 决定，读的地方统一走这里，避免两种格式混用时对不上。
function filterCurrent(key) {
  const raw = filters["f_" + key];
  if (filterKind(key) === "enum") {
    return Array.isArray(raw) ? [...raw] : raw ? [raw] : [];
  }
  return typeof raw === "string" ? raw : "";
}

// 15px：13px 在宽列上偏小、难点。表头行高是 26px 定死的，漏斗又是 float:right（浮动不参与
// 行盒高度计算），所以放大不会把表头撑高——15+2×2=19px 溢出的那 3px 只是落进 th 的下内边距里。
// 每个可筛列宽 2px（约 10~12 列，表格总宽 +20~24px），.table-wrap 有 overflow:auto 兜着。
// viewBox 固定 12，改的是渲染尺寸，path 坐标不动。
const FUNNEL_SVG =
  '<svg viewBox="0 0 12 12" width="15" height="15" aria-hidden="true"><path d="M1.6 2h8.8L7 6.3v3.1L5 8.4V6.3z" fill="currentColor"/></svg>';

function headFilterBtn(key) {
  if (!filterKind(key)) {
    return "";
  }
  return `<span class="th-filter" data-th-filter="${key}" title="筛选：点这里选这一列要看的值">${FUNNEL_SVG}<span class="fp-badge" style="display:none"></span></span>`;
}

// 表头与表体共用的列布局：可见列 + 图片列插在哪（状态前一格 → 采购链接前一格 → 都不可见就落最末）
function listColumns() {
  const vis = PRODUCT_FIELDS.filter((f) => visList.has(f.key));
  const plIdx = vis.findIndex((f) => f.key === "purchase_link");
  const stIdx = vis.findIndex((f) => f.key === "status");
  const imgAt = showImageList
    ? stIdx >= 0
      ? stIdx
      : plIdx >= 0
        ? plIdx
        : vis.length
    : -1;
  return { vis, imgAt };
}

function renderListHead() {
  const thead = document.querySelector("#productListView table.data-table thead");
  if (!thead) {
    return;
  }
  const sig = headSig();
  if (sig === lastHeadSig) {
    return;
  }
  lastHeadSig = sig;
  const { vis, imgAt } = listColumns();
  const headCols = [];
  for (let i = 0; i < vis.length; i++) {
    if (i === imgAt) {
      headCols.push(`<th><span class="th-label">图片</span></th>`);
    }
    const f = vis[i];
    headCols.push(
      `<th><span class="th-label" data-sort="${f.key}">${f.label}${sortKey === f.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}</span>${headFilterBtn(f.key)}</th>`,
    );
  }
  if (imgAt >= vis.length) {
    headCols.push(`<th><span class="th-label">图片</span></th>`);
  }
  if (showOpsList) {
    headCols.push(`<th><span class="th-label">操作</span></th>`);
  }
  thead.innerHTML = `<tr>
       <th style="width:30px"><input type="checkbox" id="selectAllProducts" title="全选 / 取消全选" /></th>
       ${headCols.join("")}
     </tr>`;
  refreshHeadFilterMarks();
}

function renderListBody(list) {
  const { vis, imgAt } = listColumns();
  const body = list
    .map((p) => {
      const net = p.soldTotal - p.refundTotal;
      const off = p.status === 1;
      const low = lowStock(p);
      const coverData = state.coverCache[p.code] || "";
      const cover = coverData
        ? `<img class="thumb" data-p-act="img" data-id="${p.id}" src="${coverData}" title="查看大图 · 可拖入或粘贴图片到此" />`
        : `<span class="thumb placeholder" data-p-act="img" data-id="${p.id}" title="查看大图 · 可拖入或粘贴图片到此">无图</span>`;
      const starred = state.liveStars && state.liveStars.has(p.code);
      const tds = [];
      const isSelected = state.selectedProducts.has(p.id);
      tds.push(
        `<td><input type="checkbox" class="product-checkbox" data-id="${p.id}" ${isSelected ? "checked" : ""} title="选择 #${p.code}" /></td>`,
      );
      for (let i = 0; i < vis.length; i++) {
        if (i === imgAt) {
          tds.push(`<td>${cover}</td>`);
        }
        const f = vis[i];
        let v = "";
        let cls = "";
        let tip = "";
        const editable = EDITABLE_FIELDS.has(f.key) ? 'data-edit="1"' : "";
        switch (f.key) {
          case "code":
            v = `<div class="clip-cell" data-p-act="edit" data-id="${p.id}" title="点击打开详情 / 编辑：${esc(p.code)}"><b>${esc(p.code)}</b></div>`;
            cls = "cell-code";
            break;
          case "name":
            v = `<div class="clip-cell" title="${esc(p.name)}">${esc(p.name)}</div>`;
            break;
          case "category":
            v = `<div class="clip-cell" title="${esc(p.category || "")}">${esc(p.category || "")}</div>`;
            break;
          case "series":
            v = `<div class="clip-cell" title="${esc(p.series || "")}">${esc(p.series || "")}</div>`;
            break;
          case "grade":
            v = esc(displayGrade(p));
            break;
          case "cost_price":
            v = money(p.cost_price);
            cls = "num";
            break;
          case "sale_price":
            v = money(p.sale_price);
            cls = "num";
            break;
          case "stockTotal":
            v = qty(p.stockTotal || 0);
            cls = "num cell-stock";
            break;
          case "soldTotal":
            v = qty(p.soldTotal || 0);
            cls = "num";
            break;
          case "netTotal":
            v = qty(net);
            cls = "num";
            break;
          case "status":
            v = `<span class="badge ${off ? "badge-off" : "badge-on"}">${off ? "已下架" : "在售"}</span>`;
            break;
          case "purchase_link":
            v = p.purchase_link
              ? `<a href="${esc(p.purchase_link)}" target="_blank">打开</a>`
              : "";
            break;
          case "remark":
            v = esc(p.remark);
            if (p.remark) {
              tip = ` title="${esc(p.remark)}"`;
            }
            break;
        }
        tds.push(
          `<td class="${cls}" data-f="${f.key}" data-pid="${p.id}" ${editable}${tip}>${v}</td>`,
        );
      }
      if (imgAt >= vis.length) {
        tds.push(`<td>${cover}</td>`);
      }
      if (showOpsList) {
        tds.push(`<td>
              <button class="mini-btn" data-s-act="toggle" data-code="${esc(p.code)}" data-id="${p.id}" title="${starred ? "取消星标" : "标记星标（直播排品备选同用）"}">${starred ? "★" : "☆"}</button>
              <button class="mini-btn" data-p-act="copy" data-id="${p.id}" title="复制完整名称">📋</button>
              <button class="mini-btn" data-p-act="stockin" data-id="${p.id}" title="补货入库">📦</button>
              <button class="mini-btn btn-danger" data-p-act="del" data-id="${p.id}" title="删除(含记录)">🗑</button>
            </td>`);
      }
      return `<tr class="${off ? "off " : ""}${low ? "lowstock " : ""}" data-id="${p.id}">${tds.join("")}</tr>`;
    })
    .join("");
  const selectedCount = state.selectedProducts.size;
  const tbody = document.querySelector("#productListView table.data-table tbody");
  if (tbody) {
    tbody.innerHTML = body;
  }
  // 全选框的 disabled/checked 跟着**表体**走（有多少行、有没有全选），
  // 不跟着表头走 —— 表头已经不是每次都重画了，这两个状态得单独同步
  const selAll = $("selectAllProducts");
  if (selAll) {
    selAll.disabled = list.length === 0;
    selAll.checked =
      list.length > 0 && list.every((p) => state.selectedProducts.has(p.id));
  }
  syncBatchBar(selectedCount);
}

function renderList(list) {
  const view = $("productListView");
  if (list.length === 0 && !hasFilter()) {
    // 一个商品都没有时整块清空，不摆任何提示文案（工具栏上就有「＋ 新建商品 / 导入/导出」，
    // 反复提示只是噪音）。签名必须作废，否则下面重建骨架时会跳过表头。
    view.innerHTML = "";
    lastHeadSig = "";
    return;
  }
  if (!view.querySelector("table.data-table")) {
    view.insertAdjacentHTML(
      "beforeend",
      `<div class="table-wrap"><table class="data-table"><thead></thead><tbody></tbody></table></div>`,
    );
    lastHeadSig = "";
  }
  renderListHead();
  renderListBody(list);
  bindBatchOps();
  refreshHeadFilterMarks();
  syncListCellState();
}

function splitRangeValue(raw) {
  const s = String(raw || "").trim();
  if (!s) {
    return ["", ""];
  }
  if (s.startsWith(">")) {
    return [s.slice(1).trim(), ""];
  }
  if (s.startsWith("<")) {
    return ["", s.slice(1).trim()];
  }
  const parts = s
    .split(/[~～\-—到,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return [parts[0] || "", parts[1] || ""];
}

// —— 悬浮筛选面板 ——
// 面板挂在 body 上而不是表头里面：表头是 sticky 的、外层还有滚动容器，
// 塞在里面会被裁掉、或者跟着横向滚动跑偏。
let filterPanel = null;

function closeFilterPanel() {
  if (!filterPanel) {
    return;
  }
  filterPanel.remove();
  filterPanel = null;
  document.removeEventListener("mousedown", onPanelOutside, true);
  document.removeEventListener("keydown", onPanelEsc, true);
}

function onPanelOutside(e) {
  if (filterPanel && !filterPanel.contains(e.target)) {
    closeFilterPanel();
  }
}

function onPanelEsc(e) {
  if (e.key === "Escape") {
    closeFilterPanel();
  }
}

function placeFilterPanel(panel, anchor) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = r.left;
  if (left + panel.offsetWidth > vw - 8) {
    left = Math.max(8, vw - panel.offsetWidth - 8);
  }
  let top = r.bottom + 4;
  // 下面放不下就往上翻；上头也放不下就贴着底边，总之别出屏
  if (top + panel.offsetHeight > vh - 8) {
    const up = r.top - panel.offsetHeight - 4;
    if (up > 8) {
      top = up;
    }
  }
  panel.style.left = Math.max(8, left) + "px";
  panel.style.top = Math.max(8, top) + "px";
}

// keepOpen 只给表达式面板的「✕ 清空这一列」用：清完就地生效，但面板要留着，
// 否则用户想清第二列得重新点一次漏斗。其它调用（确定/回车）都照旧关面板。
// 面板还开着时 renderProducts 只换表体不动表头（headSig 不含 filters），
// 锚点不会跑，所以不用重新 placeFilterPanel。
function applyFilterValue(key, value, keepOpen) {
  if (Array.isArray(value)) {
    if (value.length) {
      filters["f_" + key] = value;
    } else {
      delete filters["f_" + key];
    }
  } else if (String(value ?? "").trim()) {
    filters["f_" + key] = String(value);
  } else {
    delete filters["f_" + key];
  }
  if (!keepOpen) {
    closeFilterPanel();
  }
  syncClearFilterBtn();
  renderProducts();
}

function openFilterPanel(key, anchor) {
  const kind = filterKind(key);
  if (!kind) {
    return;
  }
  closeFilterPanel();
  const panel = document.createElement("div");
  panel.className = "fp-panel";
  panel.dataset.fp = key;
  let collect;
  let focusEl = null;
  if (kind === "enum") {
    const opts = enumOptions(key);
    const picked = new Set(filterCurrent(key));
    panel.innerHTML =
      `<div class="fp-head"><input class="fp-search" type="text" placeholder="搜索选项…" title="只筛选项名单，已经勾上的不会因为搜索看不见而丢" /></div>` +
      `<div class="fp-list">` +
      `<label class="fp-item fp-all"><input type="checkbox" data-fp-all="1" /><span class="fp-name">全选</span><span class="fp-n">(${opts.length})</span></label>` +
      opts
        .map(
          (o) =>
            `<label class="fp-item" data-v="${esc(o.v)}"><input type="checkbox" value="${esc(o.v)}" ${picked.has(o.v) ? "checked" : ""} /><span class="fp-name" title="${esc(o.v)}">${esc(o.v)}</span><span class="fp-n">(${o.n})</span></label>`,
        )
        .join("") +
      `</div><div class="fp-none">没有匹配的选项</div>` +
      `<div class="fp-foot"><span class="fp-sel">已选 <b data-sel-now>0</b> / <span data-sel-all>${opts.length}</span></span>` +
      `<button class="mini-btn" data-fp-act="cancel">取消</button>` +
      `<button class="mini-btn fp-ok" data-fp-act="ok">确定</button></div>`;
    const rows = [...panel.querySelectorAll(".fp-item:not(.fp-all)")];
    const none = panel.querySelector(".fp-none");
    const shown = () => rows.filter((r) => r.style.display !== "none");
    const refresh = () => {
      const n = rows.filter((r) => r.querySelector("input").checked).length;
      panel.querySelector("[data-sel-now]").textContent = String(n);
      const vis = shown();
      const visOn = vis.filter((r) => r.querySelector("input").checked).length;
      const all = panel.querySelector("[data-fp-all]");
      all.checked = vis.length > 0 && visOn === vis.length;
      all.indeterminate = visOn > 0 && visOn < vis.length;
      none.style.display = vis.length === 0 && rows.length > 0 ? "" : "none";
    };
    panel.querySelector(".fp-search").oninput = (ev) => {
      const q = ev.target.value.trim().toLowerCase();
      for (const r of rows) {
        r.style.display = !q || r.dataset.v.toLowerCase().includes(q) ? "" : "none";
      }
      refresh();
    };
    panel.querySelector("[data-fp-all]").onchange = (ev) => {
      for (const r of shown()) {
        r.querySelector("input").checked = ev.target.checked;
      }
      refresh();
    };
    for (const r of rows) {
      r.querySelector("input").onchange = refresh;
    }
    refresh();
    focusEl = panel.querySelector(".fp-search");
    collect = () => rows.filter((r) => r.querySelector("input").checked).map((r) => r.dataset.v);
  } else {
    const cur = filterCurrent(key);
    panel.innerHTML =
      `<div class="fp-expr">` +
      // ✕ 单独套一层 relative：它要对着**输入框**居中，不能对着 .fp-expr 居中——
      // .fp-expr 里还塞着 .fp-hint，一旦底下出现报错文案，容器就变高，✕ 会跟着往下飘
      `<div class="fp-in-wrap">` +
      `<input class="fp-input" type="text" value="${esc(cur)}" placeholder="${esc(exprPlaceholder(key))}" title="${esc(exprTitle(key))}" />` +
      `<button class="fp-clear" type="button" title="清空这一列的筛选" aria-label="清空这一列的筛选" hidden>✕</button>` +
      `</div>` +
      `<div class="fp-hint"></div></div>` +
      `<div class="fp-foot"><span class="fp-sel"></span>` +
      `<button class="mini-btn" data-fp-act="cancel">取消</button>` +
      `<button class="mini-btn fp-ok" data-fp-act="ok">确定</button></div>`;
    const input = panel.querySelector(".fp-input");
    const hint = panel.querySelector(".fp-hint");
    const clearBtn = panel.querySelector(".fp-clear");
    // 编号那套 ~ 区间语法有专门的报错文案，边输边给用户看是哪儿写岔了
    const check = () => {
      if (key !== "code") {
        input.classList.remove("err");
        return true;
      }
      const cq = codeQueryMemo(input.value);
      hint.textContent = cq.bad ? `写法有问题：${cq.msg}` : "";
      input.classList.toggle("err", !!cq.bad);
      return !cq.bad;
    };
    // 空框上摆个 ✕ 纯属多余，所以跟着输入内容显隐
    const syncClear = () => {
      clearBtn.hidden = !input.value;
    };
    input.oninput = () => {
      check();
      syncClear();
    };
    check();
    syncClear();
    clearBtn.onclick = () => {
      input.value = "";
      // 先 check() 再 applyFilterValue：清空之后编号那套语法错误提示和红框都得跟着没，
      // 不然框是空的、底下还挂着上一句「写法有问题」。
      check();
      syncClear();
      // 传 keepOpen：清完就地生效，面板留着，好让用户接着清别的列
      applyFilterValue(key, "", true);
      // 焦点还给输入框，不然点完 ✕ 焦点落在一个已被隐藏的按钮上，键盘直接失联
      input.focus();
    };
    focusEl = input;
    collect = () => input.value.trim();
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (check()) {
          applyFilterValue(key, collect());
        }
      }
    };
  }
  panel.querySelector('[data-fp-act="cancel"]').onclick = closeFilterPanel;
  panel.querySelector('[data-fp-act="ok"]').onclick = () => {
    applyFilterValue(key, collect());
  };
  document.body.appendChild(panel);
  // 必须在这里把面板记进 filterPanel：closeFilterPanel / onPanelOutside / onPanelEsc
  // 全靠它定位面板，漏了这行的话取消、点外面、Esc、确定全都变成空转，
  // 而且每点一次漏斗就往 body 上多挂一个再也删不掉的 .fp-panel。
  // 赋在 placeFilterPanel 之前，万一定位那步抛错，面板也还能被关掉。
  filterPanel = panel;
  placeFilterPanel(panel, anchor);
  // 光标要在面板真正进了 DOM 之后给，在此之前 focus() 是空操作
  if (focusEl) {
    focusEl.focus();
    if (focusEl.select) {
      focusEl.select();
    }
  }
  document.addEventListener("mousedown", onPanelOutside, true);
  document.addEventListener("keydown", onPanelEsc, true);
}

// 表头不随 filters 重建（见 headSig），所以筛选值变了要把状态描回那几个漏斗上：
// 这一列筛着就点亮，并在角标上标出勾了几个值 / 写了条件。删掉常驻那一行之后，
// 「现在到底筛了几列」全靠这几个点亮的漏斗告诉用户——不然筛选是看不见的。
function refreshHeadFilterMarks() {
  document.querySelectorAll(".th-filter[data-th-filter]").forEach((el) => {
    const key = el.dataset.thFilter;
    const cur = filterCurrent(key);
    const n = Array.isArray(cur) ? cur.length : cur.trim() ? 1 : 0;
    el.classList.toggle("on", n > 0);
    const badge = el.querySelector(".fp-badge");
    if (badge) {
      badge.textContent = String(n);
      badge.style.display = n > 0 ? "" : "none";
    }
    const tip = Array.isArray(cur)
      ? n > 0
        ? `已筛选：${cur.join("、")}`
        : "筛选：点这里选这一列要看的值"
      : cur.trim()
        ? `已筛选：${cur}`
        : "筛选：点这里写这一列的筛选条件";
    el.title = tip;
  });
}

// 批量栏在表格**外面**（#productListView 的直接子节点），跟表头表体两段重画无关，
// 单独按勾选数增删。以前它是被 renderList 整块 innerHTML 顺带写出来的。
function syncBatchBar(selectedCount) {
  const view = $("productListView");
  if (!view) {
    return;
  }
  const bar = $("batchOpsBar");
  if (selectedCount <= 0) {
    if (bar) {
      bar.remove();
    }
    return;
  }
  const countEl = bar ? bar.querySelector("[data-sel-count]") : null;
  if (countEl) {
    countEl.textContent = String(selectedCount);
    return;
  }
  const wrap = view.querySelector(".table-wrap");
  if (!wrap) {
    return;
  }
  wrap.insertAdjacentHTML("beforebegin", `<div class="batch-ops" id="batchOpsBar">
<span>已选 <b data-sel-count>${selectedCount}</b> 个商品</span>
<button class="mini-btn" id="batchCopy" title="把选中的商品按当前可见列复制到剪贴板（带表头）">📋 复制选中</button>
<button class="mini-btn batch-menu-btn" id="batchMenuBtn">批量操作 ▾</button>
<button class="mini-btn" id="batchClear" title="取消全部选择">✕ 取消</button>
</div>`);
  bindBatchBar();
}

function hasFilter() {
  // 多选列存的是数组，其余列存的是字符串，两种都要算进来
  return Object.values(filters).some((v) =>
    Array.isArray(v) ? v.length > 0 : String(v ?? "").trim().length > 0,
  );
}

function syncClearFilterBtn() {
  const clear = $("clearFilterBtn");
  if (clear) {
    clear.style.display = hasFilter() ? "" : "none";
  }
}

function updateSelectionUI() {
  const selAll = $("selectAllProducts");
  if (selAll) {
    const cbs = document.querySelectorAll(".product-checkbox");
    selAll.checked = cbs.length > 0 && Array.from(cbs).every((c) => c.checked);
  }
  syncBatchBar(state.selectedProducts.size);
}

// 批量操作清单：工具栏「批量操作 ▾」下拉与列表右键「批量操作」子菜单共用这一份，
// 两处入口永远长一样（改一条只需要改这里）。返回函数而不是直接跑，菜单自己决定何时执行。
// selOnly 的那两条只管「勾选这件事本身」，批量栏里已经有 📋复制选中 / ✕取消 两个按钮，
// 所以右键子菜单用 { selOnly: false } 把它们滤掉——菜单里再放一遍是重复。
function batchOpsItems(opts) {
  const all = [
    { label: "复制选中", selOnly: true, run: copySelectedProducts },
    { label: "取消全部勾选", selOnly: true, run: clearProductSelection },
    { sep: true },
    { label: "上架", run: () => batchSetStatus(0) },
    { label: "下架", run: () => batchSetStatus(1) },
    { label: "标星", run: () => setStarsForSelected(true) },
    { label: "取消星标", run: () => setStarsForSelected(false) },
    { sep: true },
    { label: "改等级", run: batchSetGrade },
    { label: "改采购链接", run: batchSetLink },
    { label: "改库存", run: batchSetStock },
    { sep: true },
    { label: "清空图片文件夹", danger: true, run: batchClearImages },
    { label: "删除", danger: true, run: batchDelete },
  ];
  if (!opts || opts.selOnly !== false) {
    return all;
  }
  // 滤掉 selOnly 那两条会让清单以一条分隔线开头，菜单顶上挂一道横线很难看：
  // 首尾的分隔线一律不要，中间被滤空的那一段分隔线也顺手收掉。
  return all
    .filter((it) => !it.selOnly)
    .filter((it, i, arr) => !(it.sep && (!arr[i - 1] || arr[i + 1].sep)));
}

function clearProductSelection() {
  state.selectedProducts.clear();
  renderProducts();
}

function bindBatchOps() {
  const selectAll = $("selectAllProducts");
  if (selectAll) {
    selectAll.onchange = () => {
      const checked = selectAll.checked;
      document.querySelectorAll(".product-checkbox").forEach((cb) => {
        const id = Number(cb.dataset.id);
        if (checked) {
          state.selectedProducts.add(id);
        } else {
          state.selectedProducts.delete(id);
        }
      });
      renderProducts();
    };
  }

  document.querySelectorAll(".product-checkbox").forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) {
        state.selectedProducts.add(id);
      } else {
        state.selectedProducts.delete(id);
      }
      updateSelectionUI();
    };
  });

  bindBatchBar();
}

// 批量栏那三个按钮。单独拆出来是因为 syncBatchBar() 在勾选数从 0 变正时
// 会就地长出这根栏（不必整表重画），那时候还没跑过 bindBatchOps，
// 按钮得在这里自己绑一次，不然会出现「栏在、按钮点不动」。
function bindBatchBar() {
  const batchCopy = $("batchCopy");
  if (batchCopy) {
    batchCopy.onclick = copySelectedProducts;
  }

  const batchClear = $("batchClear");
  if (batchClear) {
    batchClear.onclick = clearProductSelection;
  }

  const batchMenuBtn = $("batchMenuBtn");
  if (batchMenuBtn) {
    batchMenuBtn.onclick = (ev) => {
      ev.stopPropagation();
      const old = document.getElementById("batchDropdown");
      if (old) { old.remove(); return; }
      const items = batchOpsItems();
      const rect = batchMenuBtn.getBoundingClientRect();
      const menu = document.createElement("div");
      menu.id = "batchDropdown";
      menu.className = "batch-dropdown";
      menu.innerHTML = items.map((it, i) => {
        if (it.sep) return '<div class="batch-dd-sep"></div>';
        return '<div class="batch-dd-item' + (it.danger ? ' batch-dd-danger' : '') + '" data-bi="' + i + '">' + it.label + '</div>';
      }).join("");
      menu.style.left = rect.left + "px";
      menu.style.top = rect.bottom + 4 + "px";
      document.body.appendChild(menu);
      const close = () => { menu.remove(); window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
      const onDown = (ev) => { if (!menu.contains(ev.target)) close(); };
      const onKey = (ev) => { if (ev.key === "Escape") close(); };
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      menu.querySelectorAll("[data-bi]").forEach((el) => {
        el.onclick = () => { close(); items[Number(el.dataset.bi)].run(); };
      });
    };
  }
}

// 以下批量操作一律是模块级函数（不进 bindBatchOps 的闭包）：列表右键菜单的
// 「批量操作」子菜单也要用它们，闭包里的东西那里够不着。
function batchSetStatus(status) {
  if (state.selectedProducts.size === 0) return;
  const n = state.selectedProducts.size;
  post({ type: "setProductsStatus", ids: [...state.selectedProducts], status });
  // 正筛着某个状态时把这批行改成别的状态，它们会当场从结果里消失，看着像行凭空没了，
  // 所以这种情况下把筛选清掉。方向容易搞反：status 是改**之后**的状态，
  // 而会失配的是改**之前**那个（status===0 上架 ⇒ 这些行原本是「已下架」）。
  const prevLabel = status === 0 ? "已下架" : "在售";
  const f = filters.f_status;
  if (Array.isArray(f) && f.length === 1 && f[0] === prevLabel) {
    delete filters.f_status;
  }
  syncClearFilterBtn();
  toast("✅已" + (status === 0 ? "上架" : "下架") + " " + n + " 个商品");
  renderProducts();
}

function batchDelete() {
  if (state.selectedProducts.size === 0) return;
  confirmBox("确认删除选中的 " + state.selectedProducts.size + " 个商品？\n将同时删除它们的销售记录和入库记录，且不可恢复！").then((ok) => {
    if (ok) {
      post({ type: "deleteProducts", ids: [...state.selectedProducts] });
      state.selectedProducts.clear();
    }
  });
}

// 批量清空图片。传的是编号而不是 id：图片夹就是按编号命名的（{图片根}/{编号}），
// 让后端从库里反查编号等于为清图白读一趟整库，扩展宿主里不划算。
// 删完不取消勾选——和清库操作不同，用户多半想接着看着这批商品清第二遍别的。
function batchClearImages() {
  if (state.selectedProducts.size === 0) return;
  const codes = [...new Set(
    [...state.selectedProducts]
      .map((id) => state.products.find((p) => p.id === id)?.code)
      .filter(Boolean),
  )];
  if (codes.length === 0) return;
  confirmBox(
    `确认清空选中的 ${codes.length} 个商品的图片文件夹？\n` +
      `图片文件会被真的删除，且不可恢复（不进 ↩ 撤销，也不进 backups/ —— 那里只备份商品库）。`,
  ).then((ok) => {
    if (ok) {
      post({ type: "clearImagesBatch", codes });
      toast(`🗑已提交批量清空图片 × ${codes.length}`);
    }
  });
}

function batchSetStock() {
  const n = state.selectedProducts.size;
  if (n === 0) return;
  const mask = showModal(`
      <h3>批量改库存</h3>
      <p class="muted">将修改选中的 <b>${n}</b> 个商品（可用 ↩ 撤销）。</p>
      <div class="rows" style="margin-top:12px">
        <div class="field">
          <label>方式</label>
          <select id="bssMode">
            <option value="set">设为固定值</option>
            <option value="add">在现有基础上增加</option>
            <option value="sub">在现有基础上减少</option>
          </select>
        </div>
        <div class="field">
          <label>数量</label>
          <input id="bssQty" type="number" min="0" step="1" value="0" style="width:120px" />
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button data-bss="cancel">取消</button>
        <button data-bss="ok" class="btn-teal">确定</button>
      </div>`);
  const qtyInput = mask.querySelector("#bssQty");
  qtyInput.focus();
  qtyInput.select();
  const submit = () => {
    const mode = mask.querySelector("#bssMode").value;
    const q = Math.floor(Number(qtyInput.value || 0));
    if (!Number.isInteger(q) || q < 0) {
      toast("数量需为非负整数");
      return;
    }
    closeModal();
    post({ type: "setProductsStock", ids: [...state.selectedProducts], mode, qty: q });
    const label = mode === "add" ? `增加 ${q}` : mode === "sub" ? `减少 ${q}` : `设为 ${q}`;
    toast(`✅已提交批量改库存（${label}）× ${n}`);
  };
  mask.querySelector('[data-bss="ok"]').onclick = submit;
  mask.querySelector('[data-bss="cancel"]').onclick = closeModal;
  qtyInput.onkeydown = (ev) => {
    if (ev.key === "Enter") submit();
  };
}

function batchSetGrade() {
  const n = state.selectedProducts.size;
  if (n === 0) return;
  const mask = showModal(`
      <h3>批量改等级（${n} 个商品）</h3>
      <p class="muted">将修改选中的 <b>${n}</b> 个商品，售价按所选等级规则重算（可用 ↩ 撤销）。</p>
      <div class="rows" style="margin-top:12px">
        <div class="field">
          <label>等级</label>
          <select id="bsgGrade">
            <option value="0">自定义（不按公式自动算）</option>
            ${state.rules.map((r) => `<option value="${r.grade}">${esc(gradeLabel(r.grade))}</option>`).join("")}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button data-bsg="cancel">取消</button>
        <button data-bsg="ok" class="btn-teal">确定</button>
      </div>`);
  const submit = () => {
    const grade = Number(mask.querySelector("#bsgGrade").value);
    closeModal();
    post({ type: "setProductsField", ids: [...state.selectedProducts], field: "grade", value: grade });
    toast(`✅已提交批量改等级 × ${n}`);
  };
  mask.querySelector('[data-bsg="ok"]').onclick = submit;
  mask.querySelector('[data-bsg="cancel"]').onclick = closeModal;
}

function batchSetLink() {
  const n = state.selectedProducts.size;
  if (n === 0) return;
  const mask = showModal(`
      <h3>批量改采购链接（${n} 个商品）</h3>
      <p class="muted">将写入所选商品的「采购链接」（可用 ↩ 撤销）；<br>留空提交 = 清空所有选中商品的链接。</p>
      <input id="bslLink" type="text" placeholder="https://…" style="width:100%;box-sizing:border-box;margin-top:8px" />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button data-bsl="cancel">取消</button>
        <button data-bsl="ok" class="btn-teal">确定</button>
      </div>`);
  const input = mask.querySelector("#bslLink");
  input.focus();
  const submit = () => {
    const res = sanitizeProductField("purchase_link", input.value);
    if (!res.ok) {
      toast(res.msg);
      return;
    }
    closeModal();
    post({ type: "setProductsField", ids: [...state.selectedProducts], field: "purchase_link", value: res.value });
    toast(`✅已提交批量改采购链接 × ${n}`);
  };
  mask.querySelector('[data-bsl="ok"]').onclick = submit;
  mask.querySelector('[data-bsl="cancel"]').onclick = closeModal;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") submit();
  };
}

function copySelectedProducts() {
  const rows = state.products.filter((p) => state.selectedProducts.has(p.id));
  if (rows.length === 0) {
    toast("先勾选要复制的商品");
    return;
  }
  const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => visList.has(k));
  const lines = [
    keys.map((k) => PRODUCT_FIELDS.find((f) => f.key === k).label).join("\t"),
  ];
  for (const row of rows) {
    lines.push(keys.map((k) => cellValue(row, k)).join("\t"));
  }
  copyText(lines.join("\n"), `已复制 ${rows.length} 行到剪贴板 ✅`);
}

// 复制全部星标商品（不依赖当前勾选/筛选），列跟随列表可见列
function copyStarList() {
  const stars = state.liveStars ? [...state.liveStars] : [];
  const rows = state.products
    .filter((p) => stars.includes(p.code))
    .sort(
      (a, b) =>
        Number(a.code.replace(/^\D+/, "")) - Number(b.code.replace(/^\D+/, "")),
    );
  if (rows.length === 0) {
    toast("还没有打星标的商品（列表/画册点 ⭐ 标记）");
    return;
  }
  const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => visList.has(k));
  const lines = [
    keys.map((k) => PRODUCT_FIELDS.find((f) => f.key === k).label).join("\t"),
  ];
  for (const row of rows) {
    lines.push(keys.map((k) => cellValue(row, k)).join("\t"));
  }
  copyText(lines.join("\n"), `已复制 ${rows.length} 个星标商品到剪贴板 ✅`);
}

// 显式把某商品设为/取消星标（右键菜单用；按钮点按仍走 toggleLiveStar 翻转）
// 取消全部星标（列表右键、⭐ 星标 ▾ 子菜单共用）
function clearAllStars() {
  confirmBox("确认取消全部商品的星标？").then((ok) => {
    if (!ok) {
      return;
    }
    if (state.liveStars) {
      state.liveStars = new Set();
    }
    delete filters.f_stared;
    syncClearFilterBtn();
    post({ type: "clearLiveStars" });
    renderProducts();
  });
}

// ⭐ 星标 ▾ 下拉：工具栏只保留一个入口（复用图片右键菜单组件）
function showStarMenu(btn) {
  const rect = btn.getBoundingClientRect();
  const starOnlyOn = !!filters.f_stared;
  const starCount = state.liveStars ? state.liveStars.size : 0;
  showImageCtxMenu(rect.left, rect.bottom, [
    {
      label: `${starOnlyOn ? "✓ " : ""}只看星标（${starCount} 个）`,
      run: toggleStarOnly,
    },
    { label: "复制星标清单", run: () => copyStarList() },
    // 走 starOvRequestPreview 而不是裸 post：它会先弹遮罩 + 转圈，再发请求。
    // 裸 post 时弹窗要等后端渲染完才出现，点下去看着像没点上。
    { label: "生成星标总览图", run: starOvRequestPreview },
    { sep: true },
    { label: "取消全部星标", run: () => clearAllStars(), danger: true },
  ]);
}

function toggleStarOnly() {
  if (filters.f_stared) {
    delete filters.f_stared;
  } else {
    filters.f_stared = "1";
  }
  syncClearFilterBtn();
  renderProducts();
}

// 批量栏：把勾选商品全部标记/取消星标（本地 Set + setLiveStars 持久化）
function setStarsForSelected(on) {
  const codes = state.products
    .filter((p) => state.selectedProducts.has(p.id))
    .map((p) => p.code);
  if (codes.length === 0) {
    toast("先勾选要操作的商品");
    return;
  }
  if (!state.liveStars) {
    state.liveStars = new Set();
  }
  const set = new Set(state.liveStars);
  for (const c of codes) {
    if (on) {
      set.add(c);
    } else {
      set.delete(c);
    }
  }
  state.liveStars = set;
  post({ type: "setLiveStars", codes: [...set] });
  renderProducts();
  toast(
    on
      ? `已标记 ${codes.length} 个商品星标 ✅`
      : `已取消 ${codes.length} 个商品星标`,
  );
}

// ===== 星标总览图「先预览，点生成才落盘」 =====
var starOv = {
  mask: null,
  idx: 0,
  previews: [],
  pageCount: 1,
  total: 0,
  generating: false,
  reloading: false,
  pending: -1,
  token: 0,
  cols: 0,
  rows: 0,
  auto: false,
  lastDir: "",
  labels: { code: true, costPrice: false, salePrice: true, fontSize: 0 },
  _fsTimer: null,
  // 打开总览永远从 3×3 开始，不记上次排版；本次弹窗里改的排版只在本次内生效。
  // 「🔄 确认」按钮触发的那次请求读输入框，其余调用一律用已确认的排版。
  _useDraft: false,
};

// 3×3 排第一：自动档已不是默认（星标 60 款开方就是首屏 64 格，每格从共享盘拉 4.5MB 原图）。
// 想要一屏塞满的人自己往下选「自动（智能）」。
const STAR_GRID_PRESETS = [
  ["3x3", "3 × 3"],
  ["4x3", "4 × 3"],
  ["3x4", "3 × 4"],
  ["4x4", "4 × 4"],
  ["5x5", "5 × 5"],
  ["0", "自动（智能）"],
];

// 星标图上标注的字号预设：0＝随格子自动（推荐）；其余为格子坐标系固定像素
const STAR_FONT_PRESETS = [
  ["0", "自动（推荐）"],
  ["9", "9%"],
  ["12", "12%"],
  ["16", "16%"],
  ["20", "20%"],
  ["24", "24%"],
];

// 弹窗还没开时（第一次从工具栏菜单进来）没有 mask 可问：永远回 3×3。
// 不记上次排版，也不把 0/0 丢给后端让它去回想——打开总览就该是 3×3。
// auto 只在用户真的点了「自动（智能）」时为 true：光靠 cols/rows=0 分不出
// 「选了自动」和「没选」，后端会把自动当没选、回落到默认 3×3。
function starOvDims() {
  // isConnected 这半句是「还是会记住」的根：closeModal() 只 remove() 节点，starOv.mask
  // 还指着那个已摘除的子树，里面的 [data-so-grid] 仍拖着上次选的值——弹窗关了再开，
  // 这里会在旧 select 上读出 4×3 / custom / 自动…… 把上次排版原样送回去。跟
  // starOvRequestPreview 开窗判断同一个口径：mask 不在文档里就算「没开」，永远回 3×3。
  if (!starOv.mask || !starOv.mask.isConnected) {
    return { cols: 3, rows: 3, auto: false };
  }
  // 消费「🔄 确认」动作：只有这次读输入框。改标注/翻页/生成一律用已确认的排版，
  // 免得数字输到一半被别的入口拿半截值去排。
  const useDraft = starOv._useDraft;
  starOv._useDraft = false;
  const sel = starOv.mask.querySelector("[data-so-grid]");
  if (sel && sel.value === "custom") {
    const c = useDraft
      ? parseInt(starOv.mask.querySelector("[data-so-cc]").value || "0", 10)
      : starOv.cols;
    const r = useDraft
      ? parseInt(starOv.mask.querySelector("[data-so-cr]").value || "0", 10)
      : starOv.rows;
    return {
      cols: Number.isFinite(c) ? Math.min(10, Math.max(1, c)) : 0,
      rows: Number.isFinite(r) ? Math.min(10, Math.max(1, r)) : 0,
      auto: false,
    };
  }
  if (sel && sel.value === "0") {
    return { cols: 0, rows: 0, auto: true };
  }
  if (sel && sel.value) {
    const [c, r] = sel.value.split("x").map((x) => parseInt(x, 10));
    return { cols: c || 0, rows: r || 0, auto: false };
  }
  return { cols: 0, rows: 0, auto: false };
}

function starOvDimsLabel(d) {
  if (d && d.cols && d.rows) {
    return `${d.rows} 行 × ${d.cols} 列`;
  }
  return d && d.auto ? "自动方阵" : "3 × 3（默认）";
}

function starOvSyncGrid() {
  const mask = starOv.mask;
  const sel = mask.querySelector("[data-so-grid]");
  const cc = mask.querySelector("[data-so-cc]");
  const cr = mask.querySelector("[data-so-cr]");
  const cust = mask.querySelector("[data-so-cust]");
  const key = starOv.cols && starOv.rows ? `${starOv.cols}x${starOv.rows}` : "0";
  const preset = sel.querySelector(`option[value="${key}"]`);
  if (preset) {
    sel.value = key;
    cust.style.display = "none";
  } else {
    sel.value = "custom";
    // 预填当前已确认的行列（3 兜底：1×1 是个没人想要的格子），用户改一个数就好
    cr.value = starOv.rows || 3;
    cc.value = starOv.cols || 3;
    cust.style.display = "inline-flex";
  }
}

function starOvSetEnabled(on) {
  if (!starOv.mask) {
    return;
  }
  const q = (s) => starOv.mask.querySelector(s);
  ["[data-so-grid]", "[data-so-cc]", "[data-so-cr]", "[data-so-cust-go]", "[data-so-prev]", "[data-so-next]", "[data-so-gen]"].forEach((s) => {
    const el = q(s);
    if (el) {
      el.disabled = !on;
    }
  });
}

// 图片区遮罩：半透明 + 转圈 + 文案，渲染期间盖住旧图
function starOvLoading(msg) {
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const lo = starOv.mask.querySelector("[data-so-loading]");
  const txt = starOv.mask.querySelector("[data-so-msg]");
  if (lo) {
    lo.style.display = "flex";
  }
  if (txt) {
    txt.textContent = msg || "正在渲染预览…";
  }
}

function starOvUnloading() {
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const lo = starOv.mask.querySelector("[data-so-loading]");
  if (lo) {
    lo.style.display = "none";
  }
}

// 改排版/标注/字号后自动重预览（防抖 700ms）
function starOvScheduleRefresh() {
  if (starOv._fsTimer) {
    clearTimeout(starOv._fsTimer);
  }
  starOv._fsTimer = setTimeout(() => {
    if (!starOv.mask || !starOv.mask.isConnected) {
      return;
    }
    if (starOv.generating || starOv.reloading) {
      return;
    }
    starOvRequestPreview();
  }, 700);
}

function starOvRequestPreview() {
  if (starOv.generating || starOv.reloading) {
    return;
  }
  const d = starOvDims();
  if ((d.cols && !d.rows) || (!d.cols && d.rows)) {
    toast("自定义排版要同时填「行」和「列」");
    return;
  }
  starOv.reloading = true;
  starOv.pending = -1;
  starOv.previews = [];
  // 第一次打开：先弹窗占位（遮罩可见），出图后再填；已开弹窗：遮罩盖旧图
  if (!starOv.mask || !starOv.mask.isConnected) {
    starOvOpenMask("⭐ 星标总览图（加载中…）");
  }
  // 放在开窗之后：首次打开时上一句之前 mask 还不存在，那次置灰是空转，
  // 控件会保持可点（好在 starOvLoadPage 有 reloading 拦着，但别依赖这层兜底）
  starOvSetEnabled(false);
  starOvLoading(`正在按「${starOvDimsLabel(d)}」排版第 1 张…`);
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    status.style.display = "none";
  }
  post({ type: "previewStarOverview", cols: d.cols || 0, rows: d.rows || 0, auto: !!d.auto, labels: starOv.labels });
}

function starOvFrame() {
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const n = Math.max(1, starOv.pageCount);
  const img = starOv.mask.querySelector("[data-so-img]");
  const cap = starOv.mask.querySelector("[data-so-cap]");
  const ctr = starOv.mask.querySelector("[data-so-ctr]");
  const prev = starOv.mask.querySelector("[data-so-prev]");
  const next = starOv.mask.querySelector("[data-so-next]");
  if (ctr) {
    ctr.textContent = `${starOv.idx + 1} / ${n}`;
  }
  if (prev) {
    prev.disabled = starOv.idx === 0;
  }
  if (next) {
    next.disabled = starOv.idx >= n - 1;
  }
  const p = starOv.previews[starOv.idx];
  if (p) {
    starOvUnloading();
    if (img) {
      img.src = p.data;
    }
    if (cap) {
      cap.textContent = p.name;
    }
  } else {
    img.removeAttribute("src");
    if (cap) {
      cap.textContent = "";
    }
    starOvLoadPage(starOv.idx);
  }
}

// 按需渲染某一页：翻页到没出过的页才请求，回来后缓存；陈旧响应按 token 丢弃
function starOvLoadPage(idx) {
  if (starOv.reloading || starOv.generating || starOv.pending === idx) {
    return;
  }
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  starOv.pending = idx;
  const token = ++starOv.token;
  starOvLoading(`正在出第 ${idx + 1} 张预览…`);
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    status.style.display = "none";
  }
  const d = starOvDims();
  post({
    type: "renderStarOverviewPage",
    page: idx,
    cols: d.cols || 0,
    rows: d.rows || 0,
    auto: !!d.auto,
    labels: starOv.labels,
    token,
  });
}

function starOvOnPagePreview(msg) {
  if (starOv.reloading || starOv.generating) {
    return;
  }
  const token = Number(msg.token ?? -1);
  if (token !== starOv.token) {
    return; // 陈旧响应（换排版/标注后翻页的旧图）
  }
  const page = Number(msg.page ?? starOv.pending);
  if (starOv.pending === page) {
    starOv.pending = -1;
  }
  if (msg.error) {
    starOvUnloading();
    const img = starOv.mask.querySelector("[data-so-img]");
    if (img) {
      img.removeAttribute("src");
    }
    const cap = starOv.mask.querySelector("[data-so-cap]");
    if (cap) {
      cap.textContent = `第 ${page + 1} 张渲染失败：${msg.error}（再点「下一张/上一张」可重试）`;
    }
    starOvSetEnabled(true);
    return;
  }
  if (msg.preview) {
    starOv.previews[page] = { name: String(msg.preview.name || ""), data: String(msg.preview.data || "") };
  }
  starOvFrame();
}

function starOvOpenMask(title) {
  closeModal();
  // 每次打开都回到 3×3（不记上次排版）——下拉框、标题在第一次渲染响应回来前就显示 3×3
  starOv.cols = 3;
  starOv.rows = 3;
  starOv.auto = false;
  // 加载保存的标注选项
  try {
    const saved = JSON.parse(state.settings.star_label_options || "{}");
    if (saved.code !== undefined) starOv.labels.code = saved.code;
    if (saved.costPrice !== undefined) starOv.labels.costPrice = saved.costPrice;
    if (saved.salePrice !== undefined) starOv.labels.salePrice = saved.salePrice;
    if (saved.fontSize !== undefined) starOv.labels.fontSize = Number(saved.fontSize) || 0;
  } catch { /* 忽略 */ }
  const L = starOv.labels;
  const mask = showModal(`
    <h3 data-so-title>${title || `⭐ 星标总览图（${starOv.total} 款 · ${starOv.pageCount} 张 · ${starOvDimsLabel(starOv)}）`}</h3>
    <div class="muted" style="margin-bottom:6px">预览未落盘——满意后点「✅ 生成」才写入输出目录。</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
      <span class="muted">每张排版</span>
      <select data-so-grid style="min-width:110px">
        ${STAR_GRID_PRESETS.map(
          ([v, t]) => `<option value="${v}">${t}</option>`,
        ).join("")}
        <option value="custom">自定义…</option>
      </select>
      <span data-so-cust style="display:none;align-items:center;gap:4px" class="muted">
        <input data-so-cr type="number" min="1" max="10" style="width:56px" title="行数" />行
        × <input data-so-cc type="number" min="1" max="10" style="width:56px" title="列数" />列
        <button data-so-cust-go class="mini-btn" title="行/列填好后点这里才重新排版（回车不触发）">🔄 预览</button>
      </span>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
      <span class="muted">图上标注</span>
      <label class="io-chip"><input type="checkbox" data-so-lbl="code" ${L.code ? "checked" : ""} />编号</label>
      <label class="io-chip"><input type="checkbox" data-so-lbl="costPrice" ${L.costPrice ? "checked" : ""} />进价</label>
      <label class="io-chip"><input type="checkbox" data-so-lbl="salePrice" ${L.salePrice ? "checked" : ""} />售价</label>
      <span class="muted" style="margin-left:8px">字号</span>
      <select data-so-fs title="标注文字大小＝占格子边长的百分比；预览与生成相对比例一致（推荐「自动」）">
        ${STAR_FONT_PRESETS.map(
          ([v, t]) => `<option value="${v}">${t}</option>`,
        ).join("")}
      </select>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <button data-so-prev class="mini-btn">‹ 上一张</button>
      <span data-so-ctr style="min-width:44px;text-align:center"></span>
      <button data-so-next class="mini-btn">下一张 ›</button>
    </div>
    <div data-so-status class="muted" style="display:none;margin-bottom:4px"></div>
    <div style="text-align:center">
      <div data-so-imgwrap style="position:relative;display:inline-block;line-height:0">
        <div data-so-loading style="display:none;position:absolute;inset:0;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(0,0,0,.35);z-index:5;border:1px solid var(--vscode-panel-border);border-radius:4px;min-width:320px;min-height:120px">
          <div class="so-spinner"></div>
          <div data-so-msg class="muted" style="color:#fff"></div>
        </div>
        <img data-so-img style="max-width:min(720px,86vw);max-height:62vh;border:1px solid var(--vscode-panel-border);border-radius:4px" />
      </div>
      <div data-so-cap class="muted" style="margin-top:4px;font-size:12px"></div>
    </div>
    <div data-so-footer style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button data-so-close>关闭</button>
      <button data-so-gen class="btn-teal">✅ 生成</button>
    </div>`);
  starOv.mask = mask;
  starOvSyncGrid();
  mask.querySelector("[data-so-grid]").onchange = () => {
    const cust = mask.querySelector("[data-so-cust]");
    if (mask.querySelector("[data-so-grid]").value === "custom") {
      cust.style.display = "inline-flex";
      // 切进自定义：预填当前已确认的行列，但不立即渲染——自定义是「填好点 🔄 预览」的模式
      const cc = mask.querySelector("[data-so-cc]");
      const cr = mask.querySelector("[data-so-cr]");
      cc.value = starOv.cols || 3;
      cr.value = starOv.rows || 3;
    } else {
      cust.style.display = "none";
      // 预设仍是防抖即时渲染，只有自定义要走确认
      starOvScheduleRefresh();
    }
  };
  // 自定义的确认按钮：校验行/列都在 1~10，置草稿标志后走同一套预览流程
  // （回车不触发——用户只要这个按钮）
  mask.querySelector("[data-so-cust-go]").onclick = () => {
    const c = parseInt(mask.querySelector("[data-so-cc]").value || "0", 10);
    const r = parseInt(mask.querySelector("[data-so-cr]").value || "0", 10);
    if (!Number.isFinite(c) || !Number.isFinite(r) || c < 1 || c > 10 || r < 1 || r > 10) {
      toast("自定义排版的「行」和「列」都要填，每格 1~10");
      return;
    }
    starOv._useDraft = true;
    starOvRequestPreview();
  };
  mask.querySelectorAll("[data-so-lbl]").forEach((el) => {
    el.onchange = () => {
      starOv.labels.code = mask.querySelector("[data-so-lbl='code']").checked;
      starOv.labels.costPrice = mask.querySelector("[data-so-lbl='costPrice']").checked;
      starOv.labels.salePrice = mask.querySelector("[data-so-lbl='salePrice']").checked;
      starOvScheduleRefresh();
    };
  });
  const fsSel = mask.querySelector("[data-so-fs]");
  fsSel.value = String(starOv.labels.fontSize || 0);
  if (fsSel.selectedIndex === -1) {
    // 旧版本保存的固定像素值已不适用百分比预设 → 回退自动
    starOv.labels.fontSize = 0;
    fsSel.value = "0";
  }
  fsSel.onchange = () => {
    starOv.labels.fontSize = parseInt(fsSel.value || "0", 10) || 0;
    starOvScheduleRefresh();
  };
  mask.querySelector("[data-so-prev]").onclick = () => {
    if (starOv.generating || starOv.reloading) {
      return;
    }
    starOv.idx = Math.max(0, starOv.idx - 1);
    starOvFrame();
  };
  mask.querySelector("[data-so-next]").onclick = () => {
    if (starOv.generating || starOv.reloading) {
      return;
    }
    starOv.idx = Math.min(starOv.pageCount - 1, starOv.idx + 1);
    starOvFrame();
  };
  mask.querySelector("[data-so-close]").onclick = () => closeModal();
  starOvShowFooter(mask);
  starOvFrame();
}

function showStarOverviewPreview(msg) {
  const previews = Array.isArray(msg.previews) ? msg.previews : [];
  const total = Number(msg.total || 0);
  const pageCount = Math.max(1, Number(msg.pageCount ?? 0));
  // 换排版/标注：作废所有在途翻页响应
  starOv.token++;
  starOv.reloading = false;
  starOv.pending = -1;
  starOv.generating = false;
  starOv.total = total;
  starOv.pageCount = pageCount;
  starOv.cols = Number(msg.cols || 0);
  starOv.rows = Number(msg.rows || 0);
  starOv.auto = !!msg.auto;
  starOv.previews = new Array(pageCount);
  starOv.idx = Math.min(starOv.idx, pageCount - 1);
  if (!starOv.mask || !starOv.mask.isConnected) {
    starOv.idx = 0;
    starOvOpenMask(`⭐ 星标总览图（${total} 款 · ${pageCount} 张 · ${starOvDimsLabel(msg)}）`);
  }
  const h3 = starOv.mask.querySelector("[data-so-title]");
  if (h3) {
    h3.textContent = `⭐ 星标总览图（${total} 款 · ${pageCount} 张 · ${starOvDimsLabel(msg)}）`;
  }
  starOvSyncGrid();
  starOvSetEnabled(total > 0);
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    status.style.display = "none";
  }
  const img = starOv.mask.querySelector("[data-so-img]");
  const cap = starOv.mask.querySelector("[data-so-cap]");
  starOvUnloading();
  if (total === 0) {
    if (img) {
      img.removeAttribute("src");
    }
    if (cap) {
      cap.textContent = "当前没有星标商品，去商品列表 ⭐ 标记后再来";
    }
    toast("没有星标商品可预览（先去 ⭐ 标记）");
    return;
  }
  if (previews.length === 0) {
    // 第 1 张渲染失败（同排版其余页大概率一样）
    if (img) {
      img.removeAttribute("src");
    }
    if (cap) {
      cap.textContent = "第 1 张预览失败，可调整排版/标注后自动重试";
    }
    return;
  }
  starOv.previews[0] = previews[0];
  starOvFrame();
}

function starOvGenerate() {
  if (starOv.generating || starOv.reloading) {
    return;
  }
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  if (starOv.total <= 0) {
    toast("当前没有星标商品，先去商品列表 ⭐ 标记");
    return;
  }
  const d = starOvDims();
  if ((d.cols && !d.rows) || (!d.cols && d.rows)) {
    toast("自定义排版要同时填「行」和「列」");
    return;
  }
  starOv.generating = true;
  const footer = starOv.mask.querySelector("[data-so-footer]");
  footer.innerHTML =
    `<div class="muted" style="align-self:center;margin-right:auto">正在生成…（请选择输出目录）</div>` +
    `<button data-so-close>取消</button>`;
  footer.querySelector("[data-so-close]").onclick = () => closeModal();
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    status.style.display = "none";
  }
  post({ type: "generateStarOverview", cols: d.cols || 0, rows: d.rows || 0, auto: !!d.auto, labels: starOv.labels });
}

function starOvShowFooter(mask) {
  const footer = mask.querySelector("[data-so-footer]");
  footer.innerHTML =
    `<button data-so-close>关闭</button>` +
    `<button data-so-gen class="btn-teal">✅ 生成</button>`;
  footer.querySelector("[data-so-close]").onclick = () => closeModal();
  footer.querySelector("[data-so-gen]").onclick = starOvGenerate;
}

function onStarOverviewCancelled() {
  starOv.generating = false;
  starOv.reloading = false;
  const noStars = starOv.total <= 0;
  if (starOv.mask && starOv.mask.isConnected) {
    const status = starOv.mask.querySelector("[data-so-status]");
    if (status) {
      status.textContent = noStars
        ? "当前没有星标商品，无法生成"
        : "已取消生成，可再次生成";
      status.style.display = "";
    }
    starOvShowFooter(starOv.mask);
    starOvSetEnabled(!noStars);
  }
}

// 生成进度：服务端每张写消息时回发一条，界面实时显示，避免误以为卡死
function starOvOnProgress(msg) {
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    const total = Number(msg.total || 0);
    const page = Number(msg.page || 0);
    const name = String(msg.name || "");
    const ok = msg.ok !== false;
    if (!ok) {
      status.textContent = `第 ${page} / ${total} 张生成失败已跳过（${name}）`;
    } else if (page <= 0) {
      status.textContent = total > 0 ? `正在生成…共 ${total} 张` : "正在生成…";
    } else {
      status.textContent = `正在生成第 ${page} / ${total} 张…`;
    }
    status.style.display = "";
  }
  const footer = starOv.mask.querySelector("[data-so-footer]");
  if (footer) {
    const div = footer.querySelector('[style*="align-self:center"]');
    if (div && div.textContent.indexOf("请选择输出目录") !== -1) {
      div.textContent = "正在生成…";
    }
  }
}

function onStarOverviewDone(msg) {
  const dir = String(msg.dir || "");
  const count = Number(msg.count || 0);
  starOv.lastDir = dir;
  if (starOv.mask && starOv.mask.isConnected) {
    starOv.generating = false;
    starOv.reloading = false;
    const footer = starOv.mask.querySelector("[data-so-footer]");
    if (footer) {
      footer.innerHTML =
        `<div class="muted" style="align-self:center;margin-right:auto">已生成 ${count} 张 → ${esc(dir)}</div>` +
        `<button data-so-open title="在系统文件管理器中打开输出目录">📂 打开文件夹</button>` +
        `<button data-so-close class="btn-teal">完成</button>`;
      footer.querySelector("[data-so-open]").onclick = () =>
        post({ type: "openStarOutDir", dir: starOv.lastDir });
      footer.querySelector("[data-so-close]").onclick = () => closeModal();
    }
  } else {
    toast(`已生成 ${count} 张星标总览图 → ${dir}`);
  }
}

function renderGallery(list) {
  $("productGalleryView").innerHTML =
    list.length === 0
      ? `<p class="muted">（无商品）</p>`
      : `<div class="card-grid">${list
          .map((p) => {
            const off = p.status === 1;
            const low = lowStock(p);
            const fields = PRODUCT_FIELDS.filter(
              (f) => f.key !== "purchase_link" && visGallery.has(f.key),
            );
            const lines = fields
              .map((f) => {
                let v = "";
                if (f.key === "grade") {
                  v = esc(displayGrade(p));
                } else if (f.key === "status") {
                  v = "";
                } else if (f.key === "netTotal") {
                  v = qty(p.soldTotal - p.refundTotal);
                } else {
                  v = esc(p[f.key] ?? "");
                }
                if (v === "") {
                  return "";
                }
                if (f.key === "code") {
                  return `<div class="code">${v}</div>`;
                }
                if (f.key === "stockTotal") {
                  return `<div class="${low ? "low-stock-tag" : ""}">${f.label}：${qty(p.stockTotal || 0)}</div>`;
                }
                if (f.key === "cost_price" || f.key === "sale_price") {
                  return `<div>${f.label}：¥${money(v)}</div>`;
                }
                return `<div>${f.label}：${v}</div>`;
              })
              .filter((x) => x !== "")
              .join("");
            const coverData = state.coverCache[p.code] || "";
            const starred = state.liveStars && state.liveStars.has(p.code);
            return `<div class="card ${off ? "off" : ""}" data-p-act="img" data-id="${p.id}">
                  <button class="star ${starred ? "on" : ""}" data-s-act="toggle" data-code="${esc(p.code)}" data-id="${p.id}" title="${starred ? "取消星标" : "标记星标（直播排品备选同用）"}">${starred ? "★" : "☆"}</button>
                  <span class="card-badge ${off ? "off" : ""}">${off ? "已下架" : p.code}</span>
                  ${showImageGallery ? (coverData ? `<img src="${coverData}" />` : `<div class="ph">暂无图片</div>`) : ""}
                  <div class="card-body">${lines}</div>
                  <button class="edit-btn" data-p-act="edit" data-id="${p.id}" title="打开详情 / 编辑">编辑</button>
                </div>`;
          })
          .join("")}</div>`;
}

function stateProduct(code) {
  return state.products.find((p) => p.code === code);
}

// ─── 商品详情抽屉（画册「编辑」按钮 / 列表点名称共用）作者：字段改动即存 ───
const DRAWER_GROUPS = [
  { title: "① 商品档案", keys: ["code", "name", "category", "series", "grade"] },
  { title: "② 价格与销售", keys: ["cost_price", "sale_price", "stockTotal", "soldTotal", "netTotal"] },
  { title: "③ 状态与辅助", keys: ["status", "purchase_link", "remark"] },
];
// 抽屉里可编辑的字段（status 走 setStatus，其余走 saveFieldValue）
const DRAWER_EDITABLE = new Set([...EDITABLE_FIELDS, "status"]);
let drawerPid = 0;
let drawerKeyHandler = null;

function fieldLabel(key) {
  const f = PRODUCT_FIELDS.find((x) => x.key === key);
  return f ? f.label : key;
}

function openProductDrawer(product) {
  if (!product) {
    return;
  }
  drawerPid = product.id;
  const mask = $("drawerBackdrop");
  const box = $("productDrawer");
  if (mask) {
    mask.style.display = "";
  }
  if (box) {
    box.style.display = "";
  }
  if (!drawerKeyHandler) {
    drawerKeyHandler = (e) => {
      if (e.key !== "Escape" || !drawerPid) {
        return;
      }
      // 有模态框/大图灯箱时，先让它们各自处理 Esc，不连带关掉抽屉
      if (document.getElementById("dynModalMask") || document.getElementById("lbBox")) {
        return;
      }
      closeProductDrawer();
    };
    document.addEventListener("keydown", drawerKeyHandler);
  }
  renderProductDrawer();
}

function closeProductDrawer() {
  drawerPid = 0;
  const mask = $("drawerBackdrop");
  const box = $("productDrawer");
  if (mask) {
    mask.style.display = "none";
  }
  if (box) {
    box.style.display = "none";
    box.innerHTML = "";
  }
}

function drawerFieldValue(p, key) {
  switch (key) {
    case "grade":
      return esc(displayGrade(p));
    case "cost_price":
    case "sale_price":
      return `¥${money(p[key])}`;
    case "stockTotal":
      return qty(p.stockTotal || 0);
    case "soldTotal":
      return qty(p.soldTotal || 0);
    case "netTotal":
      return qty(p.soldTotal - p.refundTotal);
    case "purchase_link":
      return p.purchase_link
        ? `<a href="${esc(p.purchase_link)}" target="_blank">打开</a>`
        : "";
    case "status":
      return `<span class="badge ${p.status === 1 ? "badge-off" : "badge-on"}">${p.status === 1 ? "已下架" : "在售"}</span>`;
    default:
      return esc(p[key] ?? "");
  }
}

function drawerControl(p, key) {
  if (key === "grade") {
    return `<select class="d-field" data-d-f="grade" data-id="${p.id}">
      <option value="0" ${p.price_manual === 1 ? "selected" : ""}>自定义（不按公式自动算）</option>
      ${state.rules
        .map(
          (r) =>
            `<option value="${r.grade}" ${p.price_manual !== 1 && r.grade === p.grade ? "selected" : ""}>${esc(gradeLabel(r.grade))}</option>`,
        )
        .join("")}
    </select>`;
  }
  if (key === "status") {
    return `<select class="d-field" data-d-f="status" data-id="${p.id}">
      <option value="0" ${p.status === 0 ? "selected" : ""}>在售</option>
      <option value="1" ${p.status === 1 ? "selected" : ""}>已下架</option>
    </select>`;
  }
  if (key === "cost_price" || key === "sale_price") {
    return `<input class="d-field" data-d-f="${key}" data-id="${p.id}" type="text" inputmode="decimal" value="${esc(String(p[key] ?? ""))}" />`;
  }
  if (key === "stockTotal") {
    return `<input class="d-field" data-d-f="stockTotal" data-id="${p.id}" type="number" min="0" step="1" value="${p.stockTotal || 0}" />`;
  }
  if (key === "remark") {
    return `<textarea class="d-field" data-d-f="remark" data-id="${p.id}" rows="2" spellcheck="false">${esc(p.remark || "")}</textarea>`;
  }
  const attrs =
    key === "category"
      ? ` list="shopCatList" maxlength="50"`
      : key === "name"
        ? ` maxlength="100"`
        : key === "series"
          ? ` maxlength="50"`
          : key === "purchase_link"
            ? ` maxlength="500"`
            : "";
  return `<input class="d-field" data-d-f="${key}" data-id="${p.id}"${attrs} value="${esc(String(p[key] ?? ""))}" />`;
}

function renderProductDrawer() {
  const box = $("productDrawer");
  if (!box || !drawerPid) {
    return;
  }
  const p = state.products.find((x) => x.id === drawerPid);
  if (!p) {
    closeProductDrawer();
    return;
  }
  // 重绘前记住焦点字段，重绘后恢复：避免「改一个存一个」数据回推时抢走焦点
  const active = document.activeElement;
  const activeKey =
    active && box.contains(active) ? active.dataset.dF || null : null;
  const off = p.status === 1;
  const groups = DRAWER_GROUPS.map(
    (g) =>
      `<div class="d-group-title">${g.title}</div><div class="d-form">` +
      g.keys
        .map((k) =>
          DRAWER_EDITABLE.has(k)
            ? `<label>${fieldLabel(k)}</label>${drawerControl(p, k)}`
            : `<label>${fieldLabel(k)}</label><div class="d-f-val">${drawerFieldValue(p, k)}</div>`,
        )
        .join("") +
      `</div>`,
  ).join("");
  box.innerHTML = `
    <div class="d-head">
      <div>
        <div class="d-title"><b>${esc(p.code)}</b>${esc(p.name)}</div>
        <div class="d-sub">
          <span>${esc(displayGrade(p))} · 售价 ¥${money(p.sale_price)}</span>
          <span class="badge ${off ? "badge-off" : "badge-on"}">${off ? "已下架" : "在售"}</span>
        </div>
      </div>
      <button class="d-close" data-d-act="close" title="关闭（Esc）">✕</button>
    </div>
    <div class="d-body">
      ${groups}
    </div>
    <div class="d-foot">
      <button class="mini-btn" id="drawerUndoBtn" ${state.canUndo ? "" : "disabled"} title="撤销上一步修改">↩ 撤销</button>
      <button class="mini-btn" id="drawerRedoBtn" ${state.canRedo ? "" : "disabled"} title="重做上一步">↪ 重做</button>
      <span class="d-fill"></span>
      <button class="mini-btn" data-d-act="stockin" title="补货入库">📦 补货</button>
      <button class="mini-btn btn-danger" data-d-act="del" title="删除(含记录)">🗑 删除</button>
    </div>`;
  box.querySelectorAll("[data-d-act]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onDrawerAct(e, p);
    });
  });
  const undo = $("drawerUndoBtn");
  const redo = $("drawerRedoBtn");
  if (undo) {
    undo.onclick = () => post({ type: "undoRequest" });
  }
  if (redo) {
    redo.onclick = () => post({ type: "redoRequest" });
  }
  bindDrawerFields(box, p);
  if (activeKey) {
    const again = box.querySelector(`.d-field[data-d-f="${activeKey}"]`);
    if (again) {
      again.focus();
      if (again.setSelectionRange && typeof again.value === "string") {
        try {
          again.setSelectionRange(again.value.length, again.value.length);
        } catch {
          /* number 输入不支持 setSelectionRange，忽略 */
        }
      }
    }
  }
}

function bindDrawerFields(box, p) {
  box.querySelectorAll(".d-field").forEach((el) => {
    const key = el.dataset.dF;
    const commit = () => commitDrawerField(p.id, key, el.value);
    if (el.tagName === "SELECT") {
      el.onchange = commit;
      return;
    }
    el.onblur = commit;
    el.onkeydown = (e) => {
      if (e.key === "Enter" && el.tagName !== "TEXTAREA") {
        e.preventDefault();
        el.blur();
      }
    };
  });
}

function commitDrawerField(pid, field, raw) {
  if (field === "status") {
    post({ type: "setStatus", id: pid, status: Number(raw) === 1 ? 1 : 0 });
    return;
  }
  if (saveFieldValue(pid, field, raw) === false) {
    // 校验失败：重绘回显原值
    renderProductDrawer();
  }
}

function onDrawerAct(e, p) {
  const el = e.target.closest("[data-d-act]");
  if (!el) {
    return;
  }
  const act = el.dataset.dAct;
  if (act === "close") {
    closeProductDrawer();
  } else if (act === "stockin") {
    openStockIn(p);
  } else if (act === "del") {
    confirmBox(
      `确认删除 ${p.code} ${p.name}？\n将同时删除它的销售记录和入库记录，且不可恢复！`,
    ).then((ok) => {
      if (ok) {
        post({ type: "deleteProduct", id: p.id });
      }
    });
  }
}

function openInlineEditor(td) {
  const pid = Number(td.dataset.pid);
  const field = td.dataset.f;
  const orig = td.innerHTML;
  td.dataset.orig = orig;
  const product = state.products.find((x) => x.id === pid);
  if (!product) {
    return;
  }
  let editor;
  let done = false;
  const finish = (commit) => {
    if (done) {
      return;
    }
    done = true;
    if (commit) {
      const r = saveFieldValue(pid, field, editor.value);
      if (r === false) {
        td.innerHTML = td.dataset.orig;
        return;
      }
      if (r === "truncated") {
        return;
      }
    }
    td.innerHTML = td.dataset.orig;
    delete td.dataset.orig;
  };
  if (field === "grade") {
    editor = document.createElement("select");
    editor.innerHTML =
      `<option value="0" ${product.price_manual === 1 ? "selected" : ""}>自定义（不按公式自动算）</option>` +
      state.rules
        .map(
          (r) =>
            `<option value="${r.grade}" ${product.price_manual !== 1 && r.grade === product.grade ? "selected" : ""}>${esc(gradeLabel(r.grade))}</option>`,
        )
        .join("");
    editor.onchange = () => finish(true);
  } else if (field === "cost_price" || field === "sale_price") {
    editor = document.createElement("input");
    editor.type = "text";
    editor.inputMode = "decimal";
    editor.min = "0";
    editor.value = product[field];
  } else if (field === "stockTotal") {
    editor = document.createElement("input");
    editor.type = "number";
    editor.min = "0";
    editor.step = "1";
    editor.value = product.stockTotal || 0;
  } else {
    if (field === "category") {
      editor = document.createElement("input");
      editor.setAttribute("list", "shopCatList");
    } else {
      editor = document.createElement("textarea");
      editor.setAttribute("rows", "1");
      editor.spellcheck = false;
    }
    editor.value = cellValue(product, field);
  }
  editor.style.cssText =
    "width:100%;min-width:70px;box-sizing:border-box;padding:2px 5px";
  const isTextarea = editor.tagName === "TEXTAREA";
  if (isTextarea) {
    editor.style.resize = "vertical";
    editor.style.maxHeight = "160px";
    editor.style.overflow = "auto";
    editor.style.lineHeight = "1.4";
  }
  const autosize = () => {
    editor.style.height = "auto";
    editor.style.height = Math.min(160, editor.scrollHeight) + "px";
  };
  td.innerHTML = "";
  td.appendChild(editor);
  editor.onblur = () => finish(true);
  editor.onkeydown = (e) => {
    if (e.key === "Enter") {
      if (isTextarea && e.shiftKey) {
        return;
      }
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
    e.stopPropagation();
  };
  if (isTextarea) {
    editor.oninput = autosize;
    autosize();
  }
  setTimeout(() => {
    if (Array.isArray(editor) ? false : editor.focus) {
      editor.focus();
      if (editor.select) {
        editor.select();
      }
    }
  }, 0);
}

function populateFilters() {
  const trendAll = state.products.map((p) => `${p.id}|${p.code}|${p.name}`);
  const sig = JSON.stringify(trendAll);
  if (sig === filtersSig) {
    return;
  }
  filtersSig = sig;
  const trendSel = $("trendProduct");
  const curP = trendSel.value;
  trendSel.innerHTML =
    `<option value="">全部商品（按月）</option>` +
    state.products
      .map(
        (p) => `<option value="${p.id}">${esc(p.code)} ${esc(p.name)}</option>`,
      )
      .join("");
  trendSel.value = curP;
  fillCatList();
}

function openNewProduct() {
  // 规则表空的时候不要凭空造一个「等级1」出来：那只是下拉里看着有，
  // 一点保存后端又 ensureRule 出一条 cost*1.5 的规则，等于凭空多了一档。
  // 没有规则就只留「自定义」一个选项。
  const gradeOptions = state.rules
    .map((r) => `<option value="${r.grade}">${esc(gradeLabel(r.grade))}</option>`)
    .join("");
  const mask = showModal(`
        <h3>＋ 新建商品</h3>
        <div class="form-grid">
          <label>编号 *</label><div><input id="npCode" placeholder="如 A001 / L007，1 个字母 + 数字，自动补零到 3 位" /><span id="npCodeHint" class="muted" style="display:block;font-size:11px;margin-top:2px"></span></div>
          <label>名称</label><input id="npName" maxlength="100" placeholder="如：铜合金锆石手链 四叶花" />
          <label>品类</label><input id="npCategory" list="shopCatList" maxlength="50" placeholder="手链 / 项链 / 耳环 / 戒指 / 手镯…可自定义" />
          <label>系列</label><input id="npSeries" maxlength="50" placeholder="A类 / B类 / C类…（平台链接系列，可空）" />
          <label>等级</label><select id="npGrade"><option value="0">自定义（售价手动定）</option>${gradeOptions}</select>
          <label>进价 ¥</label><input id="npCost" type="number" min="0" step="0.01" value="0" />
          <label>售价 ¥</label><input id="npSale" type="number" min="0" step="0.01" placeholder="可留空，之后再填" />
          <label></label><span class="computed" id="npPreview">售价将自动计算</span>
          <label>期初库存</label><input id="npStock" type="number" min="0" step="1" value="0" />
          <label>采购链接</label><input id="npLink" maxlength="500" placeholder="下次进货去这里" />
          <label>备注</label><input id="npRemark" maxlength="200" />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="npCancel">取消</button>
          <button id="npSave" class="btn-teal">保存</button>
        </div>`);
  const upd = () => {
    const cost = Number($("npCost").value || 0);
    const grade = Number($("npGrade").value);
    const rule = state.rules.find((r) => r.grade === grade);
    const manual = Number($("npSale").value || 0);
    $("npPreview").textContent =
      manual > 0
        ? `手动售价 ¥${money(manual)}`
        : grade === 0
          ? `自定义：售价先留空，之后在列表里补填`
          : `将按规则自动算：进价 ¥${money(cost)} → ¥${money(calcPrice(cost, rule))}`;
  };
  $("npGrade").onchange = upd;
  $("npCost").oninput = upd;
  $("npSale").oninput = upd;
  upd();
  $("npCode").value = nextAvailableCode("A") || "";
  $("npCode").oninput = () => {
    const el = $("npCodeHint");
    if (!el) {
      return;
    }
    const v = String($("npCode").value || "").trim();
    const mm = v.match(/^([A-Za-z])/);
    const prefix = mm ? mm[1].toUpperCase() : "A";
    const next = nextAvailableCode(prefix);
    el.textContent = `前缀 ${prefix} · 当前最小未用：${next || "已用完（9999 满，请换一个前缀）"}`;
  };
  $("npCode").oninput();
  $("npCancel").onclick = closeModal;
  $("npSave").onclick = () => {
    const codeRaw = canonicalCode($("npCode").value);
    if (!codeRaw) {
      toast("编号格式不对（1 个字母 + 数字，最多 4 位，如 A001 / L007）");
      $("npCode").focus();
      return;
    }
    const name = sanitizeProductField("name", $("npName").value);
    if (!name.ok) {
      toast(name.msg);
      $("npName").focus();
      return;
    }
    const category = sanitizeProductField("category", $("npCategory").value);
    if (!category.ok) {
      toast(category.msg);
      $("npCategory").focus();
      return;
    }
    const series = sanitizeProductField("series", $("npSeries").value);
    if (!series.ok) {
      toast(series.msg);
      $("npSeries").focus();
      return;
    }
    const link = sanitizeProductField("purchase_link", $("npLink").value);
    if (!link.ok) {
      toast(link.msg);
      $("npLink").focus();
      return;
    }
    const remark = sanitizeProductField("remark", $("npRemark").value);
    const cost = sanitizeProductField("cost_price", $("npCost").value);
    if (!cost.ok) {
      toast(cost.msg);
      $("npCost").focus();
      return;
    }
    const sale = sanitizeProductField("sale_price", $("npSale").value);
    if (!sale.ok) {
      toast(sale.msg);
      $("npSale").focus();
      return;
    }
    const stock = sanitizeProductField("stockTotal", $("npStock").value);
    if (!stock.ok) {
      toast(stock.msg);
      $("npStock").focus();
      return;
    }
    const npGrade = Number($("npGrade").value);
    // 售价允许留空：自定义等级下留空就是「还没定价」，落库 sale_price=0、price_manual=1，
    // 之后在列表里补填即可。以前这里硬拦「自定义等级需要填写售价」。
    post({
      type: "addProduct",
      code: codeRaw,
      name: name.value,
      category: category.value,
      series: series.value,
      grade: npGrade,
      costPrice: cost.value,
      salePrice: sale.value,
      initialStock: stock.value,
      purchaseLink: link.value,
      remark: remark.value,
    });
    closeModal();
  };
}

// 「导入/导出」合并下拉：点按钮出菜单，两项分别开导入/导出弹窗
function openIoMenu() {
  const old = document.getElementById("ioMenu");
  if (old) {
    if (old._ioClose) {
      old._ioClose();
    }
    return;
  }
  const btn = $("ioBtn");
  const r = btn.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.id = "ioMenu";
  menu.style.cssText =
    "position:fixed;z-index:70;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px 0;min-width:150px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  menu.innerHTML =
    `<div class="ctx-item" data-io="import">导入商品</div>` +
    `<div class="ctx-item" data-io="export">导出Excel</div>`;
  menu.style.left = Math.min(r.left, window.innerWidth - 160) + "px";
  menu.style.top = r.bottom + 4 + "px";
  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    window.removeEventListener("mousedown", onDown);
    window.removeEventListener("keydown", onKey);
  };
  menu._ioClose = close;
  const onDown = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== btn) {
      close();
    }
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      close();
    }
  };
  window.addEventListener("mousedown", onDown);
  window.addEventListener("keydown", onKey);
  menu.addEventListener("click", () => close());
  menu.querySelector('[data-io="import"]').onclick = openImportProducts;
  menu.querySelector('[data-io="export"]').onclick = openExportProducts;
}

// 可导入字段（编号固定第 1 列）：与后端 IMPORTABLE_FIELD_ORDER 保持一致
const IMPORT_WRITABLE_KEYS = [
  "name",
  "category",
  "series",
  "grade",
  "cost_price",
  "sale_price",
  "status",
  "purchase_link",
];
const IMPORT_SAMPLES = {
  name: "铜合金锆石手链四叶花",
  category: "手链",
  series: "C类",
  grade: "2",
  cost_price: "12",
  sale_price: "",
  status: "在售",
  purchase_link: "",
};

function savedFieldSet(settingKey) {
  const s = new Set();
  try {
    const arr = JSON.parse(state.settings[settingKey] || "[]");
    if (Array.isArray(arr)) {
      arr.forEach((k) => s.add(String(k)));
    }
  } catch {
    /* 忽略 */
  }
  return s;
}

/**
 * 导入完成、但有行没进去时弹出来。用模态而不是 toast：toast 几秒就没了，
 * 而这些行号是要照着去改表格的，必须点「知道了」才算完。
 * 全部列出不截断（列表区自己滚），别让人只能看见前几条。
 */
function showImportIssues(bad, dups) {
  const section = (title, arr) =>
    !arr.length
      ? ""
      : `<h4 style="margin:12px 0 4px">${title}（${arr.length}）</h4>` +
        '<div style="max-height:44vh;overflow:auto;font-size:12px;white-space:pre-wrap;' +
        `word-break:break-all;border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px 8px">${arr
          .map(esc)
          .join("<br>")}</div>`;
  const mask = showModal(`
    <h3>导入完成，但有 ${bad.length + dups.length} 行没进去</h3>
    ${section("编号重复，仅保留第一条", dups)}
    ${section("无法解析", bad)}
    <p class="muted" style="margin-top:14px">这些行没有写入数据库。改完上面的内容可以重新导入。</p>
    <div style="display:flex;justify-content:flex-end;margin-top:8px">
      <button class="btn-teal" data-import-ok="1">知道了</button>
    </div>`);
  mask.querySelector("[data-import-ok]").onclick = () => closeModal();
}

function renderImportPreview(msg) {
  pendingImportToken = String(msg.token || "");
  const el = document.getElementById("ipPreview");
  if (!el) {
    return;
  }
  const rows = Array.isArray(msg.rows) ? msg.rows : [];
  const rowHtml = rows
    .map(
      (r) =>
        `<tr><td>${r.kind === "new" ? "新增" : "更新"}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="muted">${esc(r.detail)}</td></tr>`,
    )
    .join("");
  const badHtml =
    msg.bad && msg.bad.length
      ? `<details style="margin:6px 0"><summary class="muted">无法解析 ${msg.bad.length} 行（点击展开）</summary><div class="pre-blocks">${msg.bad.map(esc).join("<br>")}</div></details>`
      : "";
  // 重复编号要列到具体行，不能只给个数：光知道「有 2 行重复」根本没法改
  const dupHtml =
    msg.duplicateLines && msg.duplicateLines.length
      ? `<details style="margin:6px 0"><summary class="muted">编号重复 ${msg.duplicateLines.length} 行（点击展开看是哪几行）</summary><div class="pre-blocks">${msg.duplicateLines.map(esc).join("<br>")}</div></details>`
      : "";
  el.innerHTML =
    `<div class="ip-summ">将<span class="ip-ok">新增 ${msg.created}</span> · 将<span class="ip-upd">更新 ${msg.updated}</span> · 将跳过 ${msg.skipped}` +
    (msg.duplicates
      ? ` · <span class="muted">重复编号 ${msg.duplicates} 行已忽略</span>`
      : "") +
    `</div>` +
    dupHtml +
    badHtml +
    (rows.length
      ? `<div class="ip-table-wrap"><table class="data-table"><thead><tr><th>类型</th><th>编号</th><th>名称</th><th>变更</th></tr></thead><tbody>${rowHtml}</tbody></table>` +
        (msg.truncated
          ? `<p class="muted">不止这些：共 ${msg.total} 行（预览最多显示 ${rows.length} 行）</p>`
          : "") +
        `</div>`
      : `<p class="muted">没有可新增或更新的行</p>`);
  el.style.display = "";
  const commitBtn = document.getElementById("ipCommit");
  if (commitBtn) {
    commitBtn.style.display = "";
    commitBtn.disabled = false;
    commitBtn.textContent = "确认导入";
  }
  const doBtn = document.getElementById("ipDo");
  if (doBtn) {
    doBtn.disabled = false;
    doBtn.textContent = "重新解析";
  }
}

function closeImportMask() {
  pendingImportToken = "";
  if (ipMask) {
    closeModal();
    ipMask = null;
  }
}

function resetImportBtns() {
  const doBtn = document.getElementById("ipDo");
  if (doBtn) {
    doBtn.disabled = false;
    doBtn.textContent = "解析预览";
  }
  const commitBtn = document.getElementById("ipCommit");
  if (commitBtn) {
    commitBtn.disabled = false;
    commitBtn.textContent = "确认导入";
  }
  const prev = document.getElementById("ipPreview");
  if (prev) {
    prev.innerHTML = "";
    prev.style.display = "none";
  }
  pendingImportToken = "";
}

function openImportProducts() {
  let sel = savedFieldSet("import_fields");
  if (sel.size === 0) {
    // 兜底：当前「字段显示」勾出的可写列
    PRODUCT_FIELDS.forEach((f) => {
      if (IMPORT_WRITABLE_KEYS.includes(f.key) && visList.has(f.key)) {
        sel.add(f.key);
      }
    });
  }
  let mode =
    state.settings.import_mode === "add" ||
    state.settings.import_mode === "update"
      ? state.settings.import_mode
      : "both";
  const impKeys = () =>
    PRODUCT_FIELDS.filter(
      (f) =>
        f.key !== "code" &&
        IMPORT_WRITABLE_KEYS.includes(f.key) &&
        sel.has(f.key),
    );
  const hiHint = {
    both: "符合的行：已有编号＝更新，新编号＝新建；",
    add: "只新增：已有编号的行跳过（不更新）；",
    update: "只修改：不存在的编号跳过（不新建）；",
  };
  const MODE_TABS = [
    { v: "both", t: "新增＋修改" },
    { v: "add", t: "只新增" },
    { v: "update", t: "只修改" },
  ];
  const mask = showModal(`
    <h3>📥 导入商品</h3>
    <div class="mode-tabs">
      ${MODE_TABS.map(
        (m) =>
          `<button type="button" class="mode-tab${m.v === mode ? " active" : ""}" data-tab="${m.v}">${m.t}</button>`,
      ).join("")}
    </div>
    <div style="margin-bottom:8px">
      <div class="muted" style="margin-bottom:4px">导入字段（编号固定第 1 列，其余按勾选、顺序固定）</div>
      <div style="margin-bottom:4px">
        <button class="mini-btn" id="ipAll">全选</button>
        <button class="mini-btn" id="ipNone">不选</button>
      </div>
      <div class="io-chips">
        <label class="io-chip" title="编号固定第 1 列"><input type="checkbox" data-ip-k="code" checked disabled />编号</label>
        ${PRODUCT_FIELDS.filter((f) => IMPORT_WRITABLE_KEYS.includes(f.key))
          .map(
            (f) =>
              `<label class="io-chip"><input type="checkbox" data-ip-k="${f.key}" ${sel.has(f.key) ? "checked" : ""} />${f.label}</label>`,
          )
          .join("")}
      </div>
    </div>
    <p class="muted" id="ipColDesc"></p>
    <p class="muted" id="ipModeHint"></p>
    <textarea id="ipText"></textarea>
    <div id="ipPreview" style="display:none"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button id="ipCancel">取消</button>
      <button id="ipDo" class="btn-teal">解析预览</button>
      <button id="ipCommit" class="btn-teal" style="display:none">确认导入</button>
    </div>`);
  ipMask = mask;
  // 预览已存在时改了内容/字段/方式 → 作废旧预览，避免「确认导入」用了旧的计划
  const invalidatePreview = () => {
    if (!pendingImportToken) {
      return;
    }
    pendingImportToken = "";
    const prev = document.getElementById("ipPreview");
    if (prev) {
      prev.innerHTML = "";
      prev.style.display = "none";
    }
    const commitBtn = document.getElementById("ipCommit");
    if (commitBtn) {
      commitBtn.style.display = "none";
      commitBtn.disabled = false;
      commitBtn.textContent = "确认导入";
    }
    const doBtn = document.getElementById("ipDo");
    if (doBtn) {
      doBtn.disabled = false;
      doBtn.textContent = "解析预览";
    }
  };
  const doPreview = () => {
    const text = document.getElementById("ipText").value;
    if (!text.trim()) {
      toast("先粘贴内容");
      return;
    }
    const b = document.getElementById("ipDo");
    b.disabled = true;
    b.textContent = "解析中…";
    const commitBtn = document.getElementById("ipCommit");
    if (commitBtn) {
      commitBtn.disabled = true;
    }
    post({ type: "previewImportProducts", text, mode, fields: [...sel] });
  };
  const renderIp = () => {
    const cols = ["编号"].concat(impKeys().map((f) => f.label));
    document.getElementById("ipColDesc").innerHTML =
      `列顺序＝<b>${cols.join("、")}</b><br />` +
      "· 分隔：Tab / 空格 / 逗号；名称里不要带空格（空格按列分隔）<br />" +
      "· 库存/累计售出/累计净售是自动统计列，导入不参与；状态列可导入（填 在售/已下架 或 0/1）；备注不导入" +
      (cols.length <= 2 ? "<br />· 只贴编号也能建（其余走默认）" : "");
    document.getElementById("ipModeHint").textContent = hiHint[mode] || "";
    document.getElementById("ipText").placeholder =
      "示例：\n" +
      "A001\t" +
      impKeys()
        .map((f) => IMPORT_SAMPLES[f.key] ?? "")
        .join("\t");
  };
  renderIp();
  // 导入方式 = 分段 Tab
  mask.querySelectorAll(".mode-tab").forEach((tb) => {
    tb.onclick = () => {
      if (tb.dataset.tab === mode) {
        return;
      }
      mode = tb.dataset.tab;
      mask
        .querySelectorAll(".mode-tab")
        .forEach((x) => x.classList.toggle("active", x.dataset.tab === mode));
      renderIp();
      // 切方式＝结果会变：已有预览则按新方式自动重解析
      if (pendingImportToken) {
        doPreview();
      }
    };
  });
  mask.querySelectorAll("[data-ip-k]").forEach((cb) => {
    cb.onchange = () => {
      if (cb.disabled || cb.dataset.ipK === "code") {
        return;
      }
      cb.checked ? sel.add(cb.dataset.ipK) : sel.delete(cb.dataset.ipK);
      renderIp();
      invalidatePreview();
    };
  });
  document.getElementById("ipAll").onclick = () => {
    IMPORT_WRITABLE_KEYS.forEach((k) => sel.add(k));
    mask.querySelectorAll("[data-ip-k]").forEach((cb) => {
      if (!cb.disabled) {
        cb.checked = sel.has(cb.dataset.ipK);
      }
    });
    renderIp();
    invalidatePreview();
  };
  document.getElementById("ipNone").onclick = () => {
    sel.clear();
    mask.querySelectorAll("[data-ip-k]").forEach((cb) => {
      if (!cb.disabled) {
        cb.checked = sel.has(cb.dataset.ipK);
      }
    });
    renderIp();
    invalidatePreview();
  };
  document.getElementById("ipText").oninput = invalidatePreview;
  document.getElementById("ipCancel").onclick = () => {
    pendingImportToken = "";
    ipMask = null;
    closeModal();
  };
  document.getElementById("ipDo").onclick = doPreview;
  document.getElementById("ipCommit").onclick = () => {
    if (!pendingImportToken) {
      return;
    }
    const b = document.getElementById("ipCommit");
    b.disabled = true;
    b.textContent = "导入中…";
    post({ type: "commitImportProducts", token: pendingImportToken });
  };
}

function exportGroupHtml(checked, withImageChip) {
  const exChip = (key) => {
    if (key === "code") {
      return `<label class="io-chip" title="编号固定第 1 列"><input type="checkbox" data-io-e="code" checked disabled />编号</label>`;
    }
    if (key === "_image") {
      return withImageChip
        ? `<label class="io-chip" title="图片列：插在状态列前；状态与采购链接都取消时在末列"><input type="checkbox" data-io-e="_image" ${checked.has("_image") ? "checked" : ""} />图片</label>`
        : "";
    }
    const f = PRODUCT_FIELDS.find((x) => x.key === key);
    return `<label class="io-chip" title=""><input type="checkbox" data-io-e="${key}" ${checked.has(key) ? "checked" : ""} />${f ? f.label : key}</label>`;
  };
  return (
    CS_GROUPS.map((g) => {
      const chips = g.keys.map((k) => (k === "image" ? "_image" : k)).map(exChip).join("");
      return `<div class="cs-group"><div class="cs-group-title">${g.title}</div><div class="io-chips">${chips}</div></div>`;
    }).join("")
  );
}

function openExportProducts() {
  const checked = new Set();
  visList.forEach((k) => {
    if (k !== "code" && PRODUCT_FIELDS.some((f) => f.key === k)) {
      checked.add(k);
    }
  });
  const saved = savedFieldSet("export_fields");
  if (saved.size > 0) {
    checked.clear();
    saved.forEach((k) => checked.add(k));
  }
  checked.add("code");
  const total = state.products.length;
  const list = filteredProducts();
  const hasFilter = list.length < total;
  const selCount = state.selectedProducts.size;
  const starCount = state.liveStars ? state.liveStars.size : 0;
  const radio = (val, label, disabled) =>
    `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;cursor:${disabled ? "not-allowed" : "pointer"}"><input type="radio" name="eoScope" value="${val}" ${disabled ? "disabled" : ""}/>${label}</label>`;
  const defaultScope =
    selCount > 0 ? "selected" : hasFilter ? "filtered" : "all";
  const mask = showModal(`
    <h3>📤 导出商品 Excel</h3>
    <p class="muted" style="margin-bottom:6px">导出范围：</p>
    <div style="margin-bottom:8px">
      ${radio("all", `全部商品（${total} 条）`)}
      ${hasFilter ? radio("filtered", `当前筛选结果（${list.length} 条）`) : radio("filtered", "当前筛选结果", true)}
      ${selCount > 0 ? radio("selected", `勾选的 ${selCount} 个`) : ""}
      ${starCount > 0 ? radio("starred", `星标商品（${starCount} 条）`) : ""}
      ${radio("manual", "指定编号")}
    </div>
    <textarea id="eoCodes" placeholder="示例：L001，A007  L003、L005；逗号/空格/Tab/换行分隔，编号可省略字母前缀（如 7 默认补 A）" style="display:none;width:100%;box-sizing:border-box;min-height:72px;margin-bottom:6px"></textarea>
    <div id="eoBadWrap" style="display:none;max-height:88px;overflow:auto;margin-bottom:6px;padding:6px 8px;border:1px solid var(--vscode-inputValidation-warningBorder);border-radius:3px;background:var(--vscode-inputValidation-warningBackground);font-size:12px"></div>
    <p class="muted" id="eoScopeDesc" style="margin-bottom:8px"></p>
    ${exportGroupHtml(checked, true)}
    <p class="muted" id="eoColDesc"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button id="eoCancel">取消</button>
      <button id="eoDo" class="btn-teal">导出</button>
    </div>`);
  const scopeLabels = {
    all: `全部商品（${total} 条）`,
    filtered: `当前筛选结果（${list.length} 条）`,
    selected: `勾选的 ${selCount} 个`,
    manual: "指定编号",
  };
  const matchedByCode = new Map(state.products.map((p) => [p.code, p]));
  const renderEo = () => {
    const scope = [...mask.querySelectorAll('input[name="eoScope"]')].find(
      (r) => r.checked,
    );
    const scopeVal = scope ? scope.value : defaultScope;
    const isManual = scopeVal === "manual";
    $("eoCodes").style.display = isManual ? "" : "none";
    if (isManual) {
      const { valid, bad } = parseEoCodes($("eoCodes").value);
      const uniq = [...new Set(valid)];
      const matched = uniq.filter((c) => matchedByCode.has(c));
      const missing = uniq.filter((c) => !matchedByCode.has(c));
      const badUniq = [...new Set(bad)];
      $("eoScopeDesc").textContent =
        `识别 ${valid.length} 个编号 → 匹配到 ${matched.length} 条商品`;
      const lines = [];
      if (badUniq.length) {
        lines.push(`无法解析 ${badUniq.length} 个：${badUniq.join("、")}`);
      }
      if (missing.length) {
        lines.push(`不存在 ${missing.length} 个：${missing.join("、")}`);
      }
      const wrap = $("eoBadWrap");
      wrap.style.display = lines.length ? "" : "none";
      wrap.innerHTML = lines.map((l) => esc(l)).join("<br>");
    } else {
      $("eoScopeDesc").textContent =
        scopeLabels[scopeVal] === undefined
          ? ""
          : `范围：${scopeLabels[scopeVal]}`;
    }
    renderEoCols();
  };
  const renderEoCols = () => {
    const imgOn = checked.has("_image");
    const cols = [];
    let imgInserted = false;
    for (const f of PRODUCT_FIELDS) {
      if (f.key === "code") {
        continue;
      }
      if (!imgInserted && (f.key === "status" || f.key === "purchase_link")) {
        if (imgOn) {
          cols.push("图片");
          imgInserted = true;
        }
      }
      if (checked.has(f.key)) {
        cols.push(f.label);
      }
    }
    if (imgOn && !imgInserted) {
      cols.push("图片");
    }
    $("eoColDesc").textContent = `导出列（顺序固定）＝编号、${cols.join("、")}`;
  };
  const parseEoCodes = (raw) => {
    const valid = [];
    const bad = [];
    String(raw || "")
      .split(/[\s,\t，、]/)
      .forEach((s) => {
        const t = String(s || "").trim();
        if (!t) {
          return;
        }
        const c = canonicalCode(t);
        if (c) {
          valid.push(c);
        } else {
          bad.push(t);
        }
      });
    return { valid, bad };
  };
  const setScope = (val) => {
    mask.querySelectorAll('input[name="eoScope"]').forEach((r) => {
      r.checked = r.value === val;
    });
    renderEo();
  };
  mask.querySelectorAll('input[name="eoScope"]').forEach((r) => {
    r.onchange = () => renderEo();
  });
  $("eoCodes").oninput = () => renderEo();
  setScope(defaultScope);
  renderEoCols();
  mask.querySelectorAll("[data-io-e]").forEach((cb) => {
    cb.onchange = () => {
      if (cb.disabled || cb.dataset.ioE === "code") {
        return;
      }
      cb.checked ? checked.add(cb.dataset.ioE) : checked.delete(cb.dataset.ioE);
      renderEoCols();
    };
  });
  $("eoCancel").onclick = closeModal;
  $("eoDo").onclick = () => {
    if ($("eoDo").disabled) {
      return;
    }
    const scopeVal = (
      [...mask.querySelectorAll('input[name="eoScope"]')].find(
        (r) => r.checked,
      ) || {}
    ).value;
    let codes;
    if (scopeVal === "filtered") {
      codes = list.map((x) => x.code);
    } else if (scopeVal === "selected") {
      codes = state.products
        .filter((p) => state.selectedProducts.has(p.id))
        .map((x) => x.code);
    } else if (scopeVal === "starred") {
      codes = state.products
        .filter((p) => state.liveStars && state.liveStars.has(p.code))
        .map((x) => x.code);
      if (codes.length === 0) {
        toast("没有星标商品");
        return;
      }
    } else if (scopeVal === "manual") {
      const { valid } = parseEoCodes($("eoCodes").value);
      const validCodes = [...new Set(valid)].filter((c) =>
        matchedByCode.has(c),
      );
      if (validCodes.length === 0) {
        toast("没有匹配到任何编号，请检查输入");
        return;
      }
      codes = validCodes;
    } else {
      codes = state.products.map((x) => x.code);
    }
    if (!codes.length) {
      toast("没有可导出的商品");
      return;
    }
    beginExport("eoDo");
    const fields = PRODUCT_FIELDS.map((f) => f.key).filter(
      (k) => k !== "code" && checked.has(k),
    );
    if (checked.has("_image")) {
      fields.push("_image");
    }
    post({
      type: "exportProducts",
      codes,
      filtered: codes.length < state.products.length ? 1 : 0,
      fields,
      withImages: checked.has("_image") ? 1 : 0,
    });
  };
}

function openStockIn(product) {
  const mask = showModal(`
        <h3>📦 补货入库 <span class="muted">${esc(product.code)} ${esc(product.name)}（库存 ${qty(product.stockTotal)}）</span></h3>
        <div class="form-grid">
          <label>数量 *</label><input id="siQty" type="number" min="1" value="1" />
          <label>日期</label><input id="siDate" type="date" value="${nowStr()}" />
          <label>备注</label><input id="siRemark" placeholder="默认：补货入库" />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="siCancel">取消</button>
          <button id="siSave" class="btn-teal">入库</button>
        </div>`);
  $("siCancel").onclick = closeModal;
  $("siSave").onclick = () => {
    post({
      type: "addStockIn",
      productId: product.id,
      qty: Number($("siQty").value || 0),
      date: $("siDate").value || nowStr(),
      remark: $("siRemark").value || "补货入库",
    });
    closeModal();
  };
}

const CS_GROUPS = [
  { title: "① 商品档案", keys: ["code", "name", "category", "series", "grade", "purchase_link", "image"] },
  { title: "② 价格与销售", keys: ["cost_price", "sale_price", "stockTotal", "soldTotal", "netTotal"] },
  { title: "③ 状态与辅助", keys: ["status", "remark"], ops: true },
];

function chipHtml(key, label, prefix, set, locked) {
  return (
    `<label class="io-chip" ${locked ? 'title="编号固定显示"' : ""}>` +
    `<input type="checkbox" data-g="${prefix}" data-cfk="${key}" ${locked || set.has(key) ? "checked" : ""} ${locked ? "disabled" : ""} />${label}</label>`
  );
}

function checkGroupHtml(prefix, set, imgVisible, withOps) {
  const groupChips = (keys) =>
    keys.map((k) => {
      if (k === "image") {
        return (
          `<label class="io-chip" title="商品图片列（列表为整列，画册为卡片主图）">` +
          `<input type="checkbox" data-g="${prefix}" data-cfk="image" ${imgVisible ? "checked" : ""} />图片</label>`
        );
      }
const f = PRODUCT_FIELDS.find((x) => x.key === k);
      return chipHtml(k, f ? f.label : k, prefix, set, k === "code");
    }).join("");
  return (
    CS_GROUPS.map((g) => {
      let chips = groupChips(g.keys);
      if (withOps && g.ops) {
        chips +=
          `<label class="io-chip" title="列表每行的快捷按钮列：星标 / 复制完整名称 / 补货入库 / 删除（仅列表视图）">` +
          `<input type="checkbox" data-g="${prefix}" data-cfk="ops" ${showOpsList ? "checked" : ""} />操作列</label>`;
      }
      return `<div class="cs-group"><div class="cs-group-title">${g.title}</div><div class="io-chips">${chips}</div></div>`;
    }).join("")
  );
}

function openColSet() {
  const isList = viewMode !== "gallery";
  const toggle = isList ? new Set(visList) : new Set(visGallery);
  let imgVisible = isList ? showImageList : showImageGallery;
  const keyName = isList ? "列表视图" : "画册视图（卡片上显示的字段）";
  const mask = showModal(`
        <h3>字段显示 / 隐藏（当前：${keyName}）</h3>
        <p class="muted">这里只调整「${keyName}」的显示；切换到另一个视图后再打开会看到它的配置（两者分开保存）。</p>
        <div style="margin-bottom:6px">
          <button class="mini-btn" id="csListAll">全选</button>
          <button class="mini-btn" id="csListNone">不选</button>
        </div>
        ${checkGroupHtml("cur", toggle, imgVisible, isList)}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="csCancel">取消</button>
          <button id="csSave" class="btn-teal">保存</button>
        </div>`);
  const recalc = () => {
    mask.querySelectorAll('[data-g="cur"]').forEach((cb) => {
      if (cb.dataset.cfk === "image") {
        cb.checked = imgVisible;
      } else if (cb.dataset.cfk === "ops") {
        cb.checked = showOpsList;
      } else {
        cb.checked = toggle.has(cb.dataset.cfk);
      }
    });
  };
  $("csListAll").onclick = () => {
    PRODUCT_FIELDS.forEach((f) => toggle.add(f.key));
    imgVisible = true;
    showOpsList = true;
    recalc();
  };
  $("csListNone").onclick = () => {
    toggle.clear();
    toggle.add("code");
    imgVisible = false;
    showOpsList = false;
    recalc();
  };
  mask.querySelectorAll('[data-g="cur"]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.disabled || cb.dataset.cfk === "code") {
        return;
      }
      if (cb.dataset.cfk === "image") {
        imgVisible = cb.checked;
        return;
      }
      if (cb.dataset.cfk === "ops") {
        showOpsList = cb.checked;
        return;
      }
      cb.checked ? toggle.add(cb.dataset.cfk) : toggle.delete(cb.dataset.cfk);
    };
  });
  $("csCancel").onclick = closeModal;
  $("csSave").onclick = () => {
    toggle.add("code");
    if (isList) {
      visList = new Set(toggle);
      showImageList = imgVisible;
    } else {
      visGallery = new Set(toggle);
      showImageGallery = imgVisible;
    }
    post({
      type: "saveSettings",
      key: isList ? "col_visible_list" : "col_visible_gallery",
      value: JSON.stringify([...toggle]),
    });
    post({
      type: "saveSettings",
      key: isList ? "col_image_list" : "col_image_gallery",
      value: imgVisible ? "1" : "0",
    });
    post({
      type: "saveSettings",
      key: "col_show_ops",
      value: showOpsList ? "1" : "0",
    });
    closeModal();
    renderProducts();
  };
}

// 右键菜单里的「批量操作」二级菜单：勾了商品才出现，作用对象就是当前勾选的那一批
// （右键在哪一行不影响范围，跟批量栏里的按钮一个口径）。
// 刻意不在这里改勾选集：批量菜单该做的是「操作勾选的那些」，顺手把右键那一行也勾上
// 会让人以为菜单上标了数字就是几件，而菜单其实什么都没说。
function attachBatchSubmenu(menu) {
  if (state.selectedProducts.size === 0) {
    return;
  }
  const items = batchOpsItems({ selOnly: false });
  const sub = document.createElement("div");
  sub.className = "ctx-item ctx-sub";
  sub.innerHTML =
    `<span>批量操作</span>` +
    `<div class="ctx-submenu">` +
    items
      .map((it, i) =>
        it.sep
          ? `<div style="border-top:1px solid var(--vscode-panel-border);margin:3px 0"></div>`
          : `<div class="ctx-item${it.danger ? " ctx-danger" : ""}" data-bsub="${i}">${esc(it.label)}</div>`,
      )
      .join("") +
    `</div>`;
  // 插在「复制整行」上面：批量操作是这套菜单里用得最勤的一条（「现在整批改成这样」比
  // 「把这一格/这一行复制走」常见得多），压在分隔线下面那段「针对这一行」的操作里，
  // 等于每次都要越过三行复制项才够得着。代价是「跨行 vs 针对一行」那条视觉分界不再成立，
  // 改用位置本身来区分：批量在上、复制在下。
  const anchor = menu.querySelector('[data-copy="row"]');
  if (anchor) {
    menu.insertBefore(sub, anchor);
  } else {
    menu.appendChild(sub);
  }
  sub.addEventListener("mouseenter", () => {
    // 贴着屏幕右边缘就朝左展开，否则二级菜单会被裁掉
    const r = sub.getBoundingClientRect();
    sub.classList.toggle("ctx-sub-flip", window.innerWidth - r.right < 190);
  });
  sub.querySelectorAll("[data-bsub]").forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const it = items[Number(el.dataset.bsub)];
      // 先关菜单再执行：run 里大多会 renderProducts 重绘列表，菜单留在页面上会显得像没点上
      closeCtxMenu();
      if (it && it.run) {
        it.run();
      }
    };
  });
}

// 菜单关闭只做「把这个 DOM 从页面上摘掉」这一件事。
// 之所以不在这上面挂事件：点子菜单里的项也要先关菜单（run 里往往还会 renderProducts
// 重绘列表），所以关的动作由调用方自己显式做，这里只提供统一的收尾函数。
function closeCtxMenu() {
  document.getElementById("ctxMenu")?.remove();
  window.removeEventListener("mousedown", onCtxMenuDown);
  window.removeEventListener("keydown", onCtxMenuKey);
}

function onCtxMenuDown(ev) {
  const m = document.getElementById("ctxMenu");
  if (m && !m.contains(ev.target)) {
    closeCtxMenu();
  }
}

function onCtxMenuKey(ev) {
  if (ev.key === "Escape") {
    closeCtxMenu();
  }
}

function openContextMenu(e, p, field) {
  e.preventDefault();
  e.stopPropagation();
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.id = "ctxMenu";
  menu.style.cssText =
    "position:fixed;z-index:70;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px 0;min-width:150px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  const editable = EDITABLE_FIELDS.has(field);
  const canPaste =
    !!appClipboard || !!(navigator.clipboard && navigator.clipboard.readText);
  menu.innerHTML =
    `<div class="ctx-cellops">` +
    `<div class="ctx-cellop" data-cellop="copy" title="复制该格 (Ctrl+C)"><span class="cop-icon">📋</span><span>复制</span></div>` +
    `<div class="ctx-cellop${canPaste && editable ? "" : " ctx-disabled"}" data-cellop="paste" title="粘贴到该格 (Ctrl+V)"><span class="cop-icon">📥</span><span>粘贴</span></div>` +
    `<div class="ctx-cellop${CUTTABLE_FIELDS.has(field) ? "" : " ctx-disabled"}" data-cellop="cut" title="剪切该格并立即清空 (Ctrl+X)"><span class="cop-icon">✂</span><span>剪切</span></div>` +
    `</div>` +
    `<div class="ctx-item" data-copy="row">复制整行</div>` +
    `<div class="ctx-item" data-pctx="fullname">复制完整名称</div>` +
    `<div class="ctx-item" data-copy="table">复制整表(筛选后)</div>` +
    `<div style="border-top:1px solid var(--vscode-panel-border);margin:3px 0"></div>` +
    (p.status === 0
      ? `<div class="ctx-item" data-pctx="off">下架</div>`
      : `<div class="ctx-item" data-pctx="on">上架</div>`) +
    `<div class="ctx-item" data-pctx="clearimg">清空图片文件夹</div>` +
    `<div style="border-top:1px solid var(--vscode-panel-border);margin:3px 0"></div>` +
    `<div class="ctx-item ctx-danger" data-pctx="delrow">🗑 删除整行（含记录）</div>`;
  menu.style.left = Math.min(e.clientX, window.innerWidth - 140) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 60) + "px";
  document.body.appendChild(menu);
  attachBatchSubmenu(menu);
  const close = closeCtxMenu;

  const cutBtn = menu.querySelector('[data-cellop="cut"]');
  if (cutBtn) {
    cutBtn.onclick = () => {
      cutCell(p, field);
      close();
    };
  }
  menu.querySelector('[data-cellop="copy"]').onclick = () => {
    copyCell(p, field);
    close();
  };
  const pasteBtn = menu.querySelector('[data-cellop="paste"]');
  if (pasteBtn) {
    pasteBtn.onclick = () => {
      pasteCell(p.id, field);
      close();
    };
  }
  menu.querySelector('[data-copy="row"]').onclick = () => {
    const vis = visList;
    const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => vis.has(k));
    copyText(keys.map((k) => cellValue(p, k)).join("\t"));
    close();
  };
  menu.querySelector('[data-copy="table"]').onclick = () => {
    const list = filteredProducts();
    const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => visList.has(k));
    const lines = [
      keys.map((k) => PRODUCT_FIELDS.find((f) => f.key === k).label).join("\t"),
    ];
    for (const row of list) {
      lines.push(keys.map((k) => cellValue(row, k)).join("\t"));
    }
    copyText(lines.join("\n"));
    close();
  };
  const fullItem = menu.querySelector('[data-pctx="fullname"]');
  if (fullItem) {
    fullItem.onclick = () => {
      copyText(fullName(p));
      close();
    };
  }
  const offBtn = menu.querySelector('[data-pctx="off"]');
  if (offBtn) {
    offBtn.onclick = () => {
      post({ type: "setStatus", id: p.id, status: 1 });
      close();
    };
  }
  const onBtn = menu.querySelector('[data-pctx="on"]');
  if (onBtn) {
    onBtn.onclick = () => {
      post({ type: "setStatus", id: p.id, status: 0 });
      close();
    };
  }
  menu.querySelector('[data-pctx="clearimg"]').onclick = () => {
    confirmBox(`确认清空 ${p.code} 的图片文件夹？（文件会真的删除）`).then(
      (ok) => {
        if (ok) {
          post({ type: "clearImages", code: p.code });
        }
      },
    );
    close();
  };
  menu.querySelector('[data-pctx="delrow"]').onclick = () => {
    confirmBox(
      `确认删除 ${p.code} ${p.name} 这整行？\n将同时删除它的销售记录和入库记录，且不可恢复！`,
    ).then((ok) => {
      if (ok) {
        post({ type: "deleteProduct", id: p.id });
      }
    });
    close();
  };
  setTimeout(() => {
    window.addEventListener("mousedown", onCtxMenuDown);
    window.addEventListener("keydown", onCtxMenuKey);
  }, 0);
}

function onProductCtx(e) {
  const coverEl = e.target.closest("[data-p-act='img']");
  if (coverEl) {
    e.preventDefault();
    e.stopPropagation();
    const p = state.products.find((x) => x.id === Number(coverEl.dataset.id));
    if (p) {
      openCoverMenu(e, p);
    }
    return;
  }
  const td = e.target.closest("td[data-pid]");
  if (!td) {
    return;
  }
  const p = state.products.find((x) => x.id === Number(td.dataset.pid));
  if (!p) {
    return;
  }
  if (td.dataset.f) {
    selectListCell(Number(td.dataset.pid), td.dataset.f);
  }
  openContextMenu(e, p, td.dataset.f);
}

function openCoverMenu(e, p) {
  const coverData = state.coverCache[p.code] || "";
  const items = [];
  if (coverData) {
    items.push({
      label: "📋 复制图片",
      run: () => {
        copyImageFromDataUrl(coverData).then((ok) =>
          ok ? toast("已复制图片") : toast("复制失败"),
        );
      },
    });
  }
  if (navigator.clipboard && navigator.clipboard.read) {
    items.push({
      label: "📥 粘贴图片",
      run: () => {
        readClipboardImageDataURL()
          .then((data) => {
            if (data) {
              post({
                type: "receiveImageData",
                code: p.code,
                items: [{ name: `paste_${Date.now()}`, data }],
              });
            } else {
              toast("剪贴板里没有图片");
            }
          })
          .catch((err) => {
            toast(
              err && err.message === "noimage"
                ? "剪贴板里没有图片"
                : "❌读取剪贴板失败：权限被拒",
            );
          });
      },
    });
  }
  if (!items.length) {
    return;
  }
  showImageCtxMenu(e.clientX, e.clientY, items);
}

// 图片列：支持「拖入图片文件 / 粘贴剪贴板图片」，落到当前商品（表格列 / 卡片 / 灯箱）
var shopImageBindings = null;

function isImageFile(file) {
  return (
    !!file && typeof file.type === "string" && file.type.startsWith("image/")
  );
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read error"));
    reader.readAsDataURL(file);
  });
}

function readBlobAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read error"));
    reader.readAsDataURL(blob);
  });
}

// 菜单触发式「粘贴图片」：主动读剪贴板拿第一张图，与 Ctrl+V/拖入走同一条 receiveImageData 落图链路
function readClipboardImageDataURL() {
  return navigator.clipboard.read().then((cItems) => {
    if (!cItems || !cItems.length) {
      throw new Error("noimage");
    }
    for (const item of cItems) {
      const t = Array.from(item.types || []).find((x) =>
        String(x).toLowerCase().startsWith("image/"),
      );
      if (!t) {
        continue;
      }
      return item.getType(t).then((blob) => {
        if (!blob) {
          throw new Error("noimage");
        }
        return readBlobAsDataURL(blob);
      });
    }
    throw new Error("noimage");
  });
}

async function filesToImageItems(fileList) {
  const files = Array.from(fileList || []).filter(isImageFile);
  const items = [];
  for (const f of files) {
    try {
      const data = await readFileAsDataURL(f);
      if (data) {
        items.push({ name: f.name || "", data });
      }
    } catch {
      /* 忽略单张读取失败 */
    }
  }
  return items;
}

// 从 DataTransfer/ClipboardEvent 里收集文件，items 与 files 会重复，按 name+size+lastModified 去重
function collectFiles(dt) {
  const seen = new Set();
  const out = [];
  const add = (f) => {
    if (!f) {
      return;
    }
    const key = `${f.name || ""}|${f.size}|${f.lastModified}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(f);
  };
  if (dt) {
    if (dt.items) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === "file") {
          add(it.getAsFile());
        }
      }
    }
    if (dt.files) {
      for (const f of Array.from(dt.files)) {
        add(f);
      }
    }
  }
  return out;
}

function productFromCoverTarget(el) {
  if (!el || !el.closest) {
    return null;
  }
  const coverEl = el.closest("[data-p-act='img']");
  if (!coverEl) {
    return null;
  }
  return (
    state.products.find((x) => x.id === Number(coverEl.dataset.id)) || null
  );
}

// 拖放/粘贴的目标定位：图片列 → 任意带 data-pid 的行/单元格 → 灯箱
function productForDropOrPaste(e) {
  if (!document.getElementById("productListView")) {
    return null;
  }
  const t = e.target;
  const el = t && t.closest ? t : document.activeElement;
  let product = null;
  if (el && el.closest) {
    const coverEl = el.closest("[data-p-act='img']");
    const rowEl = coverEl || el.closest("[data-pid]");
    if (rowEl) {
      product =
        state.products.find((x) => x.id === Number(rowEl.dataset.id)) || null;
    }
  }
  const inLb = !!el.closest("#lbBox");
  if (!product && inLb && state.lbCode) {
    product = state.products.find((x) => x.code === state.lbCode) || null;
  }
  return product || null;
}

function onImagePasteCapture(e) {
  if (!document.getElementById("productListView")) {
    return;
  }
  const t = e.target;
  if (
    t &&
    t.closest &&
    t.closest("input,textarea,select,[contenteditable='true']")
  ) {
    return;
  }
  const files = collectFiles(e.clipboardData || window.clipboardData || null);
  if (!files.length) {
    return;
  }
  const product = productForDropOrPaste(e);
  if (!product) {
    toast("先点开某个商品的图片看大图，再把图片 Ctrl+V 粘贴进来");
    return;
  }
  filesToImageItems(files).then((items) => {
    if (items.length) {
      post({ type: "receiveImageData", code: product.code, items });
    } else {
      toast("剪贴板里未检测到图片");
    }
  });
  e.preventDefault();
}

let fileDragHinted = false;

// 拖拽的是画册/灯箱里已经显示出来的图本身：浏览器会把它当成一个文件放进 dataTransfer，
// 一松手就又被 receiveImageData 再写一份副本。在源头取消这次拖拽即可。
function onInternalImgDragStart(e) {
  if (
    e.target &&
    e.target.closest &&
    e.target.closest("img") &&
    document.getElementById("productListView")
  ) {
    e.preventDefault();
    toast("这张图已经在这里了，复制请用右键菜单");
  }
}

function onImageDragOver(e) {
  const t = e.target;
  if (!t || !t.closest) {
    return;
  }
  const coverEl = t.closest("[data-p-act='img']");
  const rowEl = t.closest("[data-pid]");
  const inLb = !!t.closest("#lbBox");
  if (!coverEl && !rowEl && !inLb) {
    return;
  }
  if (!document.getElementById("productListView")) {
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  const target = coverEl || rowEl;
  if (target) {
    target.classList.add("img-drop-hover");
  } else if (inLb) {
    const lb = document.getElementById("lbBox");
    if (lb) {
      lb.classList.add("img-drop-hover");
    }
  }
  const types = (e.dataTransfer && e.dataTransfer.types) || [];
  if (
    !fileDragHinted &&
    Array.from(types).some((x) => String(x).toLowerCase() === "files")
  ) {
    fileDragHinted = true;
    toast(
      "松开鼠标即可把图片加到这里（若弹系统提示没反应，请按住 Shift 拖入）",
    );
  }
}

function onImageDrop(e) {
  if (!document.getElementById("productListView")) {
    return;
  }
  const t = e.target;
  if (!t || !t.closest) {
    return;
  }
  const coverEl = t.closest("[data-p-act='img']");
  const rowEl = t.closest("[data-pid]");
  const inLb = !!t.closest("#lbBox");
  const target = coverEl || rowEl;
  if (target) {
    target.classList.remove("img-drop-hover");
  } else if (inLb) {
    const lb = document.getElementById("lbBox");
    if (lb) {
      lb.classList.remove("img-drop-hover");
    }
  }
  if (!coverEl && !rowEl && !inLb) {
    return;
  }
  const product = productForDropOrPaste(e);
  if (!product) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  filesToImageItems(collectFiles(e.dataTransfer)).then((items) => {
    if (items.length) {
      post({ type: "receiveImageData", code: product.code, items });
    } else {
      toast("未检测到图片文件");
    }
  });
}

function clearImgDropHover() {
  fileDragHinted = false;
  document
    .querySelectorAll(".img-drop-hover")
    .forEach((el) => el.classList.remove("img-drop-hover"));
}

// document 级捕获监听覆盖列表/宫格/灯箱，切走再切回会累积，先解绑旧的再绑新的
function bindImageDropPaste() {
  if (shopImageBindings) {
    document.removeEventListener("paste", shopImageBindings.paste, true);
    document.removeEventListener(
      "dragleave",
      shopImageBindings.dragleave,
      true,
    );
    document.removeEventListener("dragover", shopImageBindings.dragover, true);
    document.removeEventListener("drop", shopImageBindings.drop, true);
    document.removeEventListener(
      "dragstart",
      shopImageBindings.dragstart,
      true,
    );
  }
  shopImageBindings = {
    paste: onImagePasteCapture,
    dragleave: clearImgDropHover,
    dragover: onImageDragOver,
    drop: onImageDrop,
    dragstart: onInternalImgDragStart,
  };
  document.addEventListener("paste", shopImageBindings.paste, true);
  document.addEventListener("dragleave", shopImageBindings.dragleave, true);
  document.addEventListener("dragover", shopImageBindings.dragover, true);
  document.addEventListener("drop", shopImageBindings.drop, true);
  document.addEventListener("dragstart", shopImageBindings.dragstart, true);
}

function onProductAct(e) {
  const cellTd = e.target.closest("td[data-pid][data-f]");
  if (
    cellTd &&
    !e.target.closest("input,select,button,a,.thumb,[data-s-act],[data-p-act]")
  ) {
    selectListCell(Number(cellTd.dataset.pid), cellTd.dataset.f);
  }
  const starBtn = e.target.closest("[data-s-act]");
  if (starBtn) {
    e.stopPropagation();
    const code = starBtn.dataset.code;
    if (code) {
      if (!state.liveStars) {
        state.liveStars = new Set();
      }
      const set = new Set(state.liveStars);
      const adding = !set.has(code);
      if (adding) {
        set.add(code);
      } else {
        set.delete(code);
      }
      state.liveStars = set;
      post({ type: "toggleLiveStar", code });
      renderProducts();
    }
    return;
  }
  // 漏斗要在排序之前拦下来：它跟 .th-label 同在一个 <th> 里，
  // 不先判断的话点漏斗会顺带把这一列的排序也翻一下。
  const fpBtn = e.target.closest("[data-th-filter]");
  if (fpBtn) {
    openFilterPanel(fpBtn.dataset.thFilter, fpBtn);
    return;
  }
  const th = e.target.closest("[data-sort]");
  if (th) {
    const k = th.dataset.sort;
    if (sortKey === k) {
      sortDir = -sortDir;
    } else {
      sortKey = k;
      sortDir = 1;
    }
    renderProducts();
    return;
  }
  const btn = e.target.closest("[data-p-act]");
  if (!btn) {
    return;
  }
  const id = Number(btn.dataset.id);
  const product = state.products.find((x) => x.id === id);
  if (!product) {
    return;
  }
  const act = btn.dataset.pAct;
  if (act === "img") {
    openLightbox(product);
  } else if (act === "edit") {
    openProductDrawer(product);
  } else if (act === "copy") {
    copyText(fullName(product));
  } else if (act === "stockin") {
    openStockIn(product);
  } else if (act === "status") {
    post({ type: "setStatus", id, status: Number(btn.dataset.status) });
  } else if (act === "clearimg") {
    confirmBox(
      `确认清空 ${product.code} 的图片文件夹？（文件会真的删除）`,
    ).then((ok) => {
      if (ok) {
        post({ type: "clearImages", code: product.code });
      }
    });
  } else if (act === "del") {
    confirmBox(
      `确认删除 ${product.code} ${product.name}？\n将同时删除它的销售记录和入库记录，且不可恢复！`,
    ).then((ok) => {
      if (ok) {
        post({ type: "deleteProduct", id });
      }
    });
  }
}
