// 手机版商品页面：只做四件事 —— 看商品（画册/列表）、看某个商品的图、新建商品、改几个常用字段。
// 与电脑版的区别只在**交互**：不做双击编辑（手机上点一下就该进编辑）、不做右键菜单（改成长按/按钮）、
// 不做拖放（改成相机/相册）。数据与规则全部复用后端那套 handler，页面里不重写任何业务口径。
(function () {
  "use strict";

  var TOKEN_KEY = "cherysis_token";
  var state = {
    products: [],
    rules: [],
    alert: 0,
    view: "gallery",
    q: "",
    scope: "all", // 搜哪一列：all / code / name / category / series
    codeQ: "", // 编号范围（漏斗那套口径，与电脑版编号列筛选一致）
    page: 0,
    sort: "code",
    panelOpen: false, // 筛选展开区是否展开（在当前屏内展开，不切屏）
    // 漏斗筛选：enum 是「勾哪几个看哪几个」，num 是数值区间。空 = 不筛
    filters: { enum: { category: {}, series: {}, grade: {}, status: {}, img: {} }, num: {} },
    // 每个编号有几张图（后端扫目录得来，按需要一次）。图片不在数据库里，只能这么知道
    imgStats: {},
    imgStatsLoaded: false,
    imgStatsBusy: false,
    settings: {},
    detail: null, // { id, code, idx, orig: {...}, status: 0 }
    logs: [],
  };
  var PAGE_SIZE = 50;
  // ---------- 显示大小（只放大表格） ----------
  // 浏览器自带的双指缩放是**整页**缩放：顶栏、筛选、分页条会跟着一起缩小，那不是要的效果。
  // 所以表格里自己接管双指手势，缩放写成一个 CSS 变量 `--zoom`，只挂在 #content 上 ——
  // 顶栏、筛选、分页条、底部状态条都不在这个容器里，天然不会被带到。
  // 画册和详情页都不做这一套：画册里卡片本来就是图，缩放没意义；详情页交还给浏览器自己的
  // 双指缩放（那里就是想让人捏着看）。
  var ZOOM_KEY = "cherysis_zoom";
  var ZOOMS = [0.75, 0.85, 1, 1.15, 1.3, 1.5]; // 走档位：连续缩放会让整张表每帧重排，手机上很卡
  var zoom = 1;

  /** 缩放是否作用在当前视图上：只有表格吃这一套 */
  function zoomActive() {
    return state.view === "list";
  }
  // 画册不给缩放按钮，卡片大小固定：取最小档（一屏放得最多，卡片上就编号 + 图 + 一行价，
  // 小一点也够认）。要改回来只动这一个常量。
  var GALLERY_ZOOM = ZOOMS[0];

  /** 把 zoom 落到 DOM 上。画册里用固定档，否则切过去卡片会跟着表格的档位莫名变大变小 */
  function applyZoom() {
    var c = $("content");
    if (c) {
      c.style.setProperty("--zoom", String(zoomActive() ? zoom : GALLERY_ZOOM));
    }
    var lab = $("zoomLabel"); // 筛选区里那个按钮上的百分比，展开时才在 DOM 里
    if (lab) {
      lab.textContent = Math.round(zoom * 100) + "%";
    }
    var row = $("zoomRow");
    if (row) {
      // 画册里这三个按钮点了也不会变，留着只会让人以为坏了
      row.style.display = zoomActive() ? "" : "none";
    }
  }

  function setZoom(z) {
    z = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], z));
    zoom = z;
    applyZoom();
    try {
      localStorage.setItem(ZOOM_KEY, String(z));
    } catch (e) {
      /* 隐私模式下写不了就算了，不影响用 */
    }
  }
  // 捏合算出来的是连续值：吸附到最近档位，跨档才变，否则手指一抖就重排一次
  function snapZoom(z) {
    var best = ZOOMS[2];
    var bd = Infinity;
    for (var i = 0; i < ZOOMS.length; i++) {
      var d = Math.abs(ZOOMS[i] - z);
      if (d < bd) {
        bd = d;
        best = ZOOMS[i];
      }
    }
    return best;
  }
  function stepZoom(dir) {
    var i = ZOOMS.indexOf(zoom);
    if (i < 0) {
      i = ZOOMS.indexOf(snapZoom(zoom));
    }
    if (i < 0) {
      i = 2;
    }
    i += dir;
    if (i < 0 || i >= ZOOMS.length) {
      return;
    }
    setZoom(ZOOMS[i]);
  }
  // 顶部搜索「全部」时扫这几列（与电脑版 KEYWORD_FIELDS 同一份清单）
  var KEYWORD_FIELDS = ["code", "name", "category", "series"];
  // 离散值列 → 勾选；数值列 → 区间。status 只有两种取值，勾选比写表达式顺手
  var ENUM_COLS = [
    ["category", "品类"],
    ["series", "系列"],
    ["grade", "等级"],
    ["status", "状态"],
  ];
  var NUM_COLS = [
    ["cost_price", "进价"],
    ["sale_price", "售价"],
    ["stock", "库存"],
  ];
  // pill 上怎么称呼每一列（「搜哪一列」的下拉用的是同一批词）
  var SCOPE_LABEL = { all: "关键词", code: "编号", name: "名称", category: "品类", series: "系列" };
  var SORT_LABEL = { code: "编号", stock: "库存少→多", sale: "售价低→高", new: "最近新建" };

  var $ = function (id) {
    return document.getElementById(id);
  };
  var esc = function (s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };
  var num = function (v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  var money = function (v) {
    return "¥" + (Math.round(num(v) * 100) / 100).toLocaleString("zh-CN");
  };

  // ---------- 与后端的通道 ----------
  var token = (function () {
    var m = /[?&]token=([^&]+)/.exec(location.search);
    if (m) {
      try {
        localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
      } catch (e) {
        /* 隐私模式下写不了，忽略 */
      }
      return decodeURIComponent(m[1]);
    }
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  })();

  /** 一条消息 = 一次 POST；回包里的 posts 按序喂给 handlePost，logs 进底部状态条 */
  function invoke(type, payload) {
    var msg = Object.assign({ type: type }, payload || {});
    return fetch("/api/invoke", {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { "x-cherysis-token": token } : {},
      ),
      body: JSON.stringify(msg),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) {
            throw new Error(j && j.error ? j.error : "HTTP " + r.status);
          }
          return j;
        });
      })
      .then(function (j) {
        (j.posts || []).forEach(handlePost);
        (j.logs || []).forEach(pushLog);
        if (j.error) {
          pushLog("❌" + j.error);
        }
        return j;
      })
      .catch(function (err) {
        pushLog("❌连不上服务：" + (err && err.message ? err.message : err));
        throw err;
      });
  }

  // 图片缓存版本号：删图/传图后 +1，让 imgUrl 变出新 URL 绕开浏览器 5 分钟的图片缓存
  var imgVer = 0;
  function bumpImg() {
    imgVer++;
  }

  function imgUrl(code, name, size) {
    // /api/image 带 Cache-Control: private, max-age=300 —— 删掉一张图后如果还用同一个 URL，
    // 浏览器直接拿缓存里的旧图显示出来，看着就像「点了 × 没反应」。所以 URL 上挂一个版本号，
    // 删图/传图后 bumpImg() 让它 +1，URL 变了浏览器才会真去问服务器（那张已经 404 了）。
    var u =
      "/api/image?code=" + encodeURIComponent(code) + "&size=" + (size || "thumb") + "&v=" + imgVer;
    if (name) {
      u += "&name=" + encodeURIComponent(name);
    }
    if (token) {
      u += "&token=" + encodeURIComponent(token);
    }
    return u;
  }

  // ---------- 收到的消息 ----------
  function handlePost(m) {
    if (!m || !m.type) {
      return;
    }
    if (m.type === "productsLoaded") {
      state.products = m.products || [];
      state.alert = num(m.stockAlert);
      renderList();
      resyncDetailPos(); // 正在看详情时，翻页按钮的位置和边界要跟着新数据重算
      fillCategoryList();
    } else if (m.type === "productsDelta") {
      // 后端改完一条只回传这一条（不是整表），详情页失焦即存就靠它同步售价 ——
      // 改进价/等级时后端会按规则重算售价，但不会告诉前端算成了多少，
      // 只有这个 delta 里带。没有它就得整表 loadAll 回读，那会把用户正在填的其它格子冲掉。
      applyDelta(m.products || [], m.removed || []);
    } else if (m.type === "imageStatsLoaded") {
      state.imgStats = m.stats || {};
      state.imgStatsLoaded = true;
      if (state.panelOpen) {
        renderFilter(); // 把「无图 N / 有图 M」填进圆片
      }
      renderList(); // 已经勾了「无图」的话，这一下才筛得出来
    } else if (m.type === "rulesLoaded") {
      state.rules = m.rules || [];
      fillGradeSelect();
      updateRuleHint();
    } else if (m.type === "settingsLoaded") {
      state.settings = m.settings || {};
      if ($("screen-settings").classList.contains("show")) {
        renderSettings();
      }
    } else if (m.type === "toast") {
      pushLog(m.text);
    } else if (m.type === "dbOpError") {
      pushLog("❌" + m.message);
    }
  }

  /** 把后端回传的单条改动并进 state.products，不整表重拉 */
  function applyDelta(products, removed) {
    (removed || []).forEach(function (id) {
      state.products = state.products.filter(function (p) {
        return num(p.id) !== num(id);
      });
    });
    (products || []).forEach(function (up) {
      var hit = false;
      for (var i = 0; i < state.products.length; i++) {
        if (num(state.products[i].id) === num(up.id)) {
          state.products[i] = up;
          hit = true;
          break;
        }
      }
      if (!hit) {
        state.products.push(up);
      }
    });
    renderList();
    resyncDetailPos();
    syncDetailFromDelta(products);
  }

  // 详情页表单 ↔ 商品字段的对应表：[输入框 id, 字段名, 文本/数字/整数]
  var DETAIL_FIELDS = [
    ["fName", "name", "text"],
    ["fCost", "cost_price", "num"],
    ["fSale", "sale_price", "num"],
    ["fStock", "stockTotal", "int"],
    ["fCategory", "category", "text"],
    ["fSeries", "series", "text"],
  ];

  /**
   * delta 回来后把详情页表单同步一遍。
   * 正在编辑的那一格跳过（document.activeElement）—— 否则打字打到一半会被回读冲掉。
   */
  function syncDetailFromDelta(products) {
    var d = state.detail;
    if (!d) {
      return;
    }
    var up = null;
    products.forEach(function (p) {
      if (num(p.id) === num(d.id)) {
        up = p;
      }
    });
    if (!up) {
      return;
    }
    DETAIL_FIELDS.forEach(function (f) {
      var el = $(f[0]);
      if (!el || document.activeElement === el) {
        return;
      }
      var isText = f[2] === "text";
      var v = isText ? String(up[f[1]] === undefined || up[f[1]] === null ? "" : up[f[1]]) : String(num(up[f[1]]));
      if (el.value !== v) {
        el.value = v;
      }
      d.orig[f[1]] = isText ? v : num(up[f[1]]);
    });
    d.status = num(up.status) === 1 ? 1 : 0;
    syncStatusBtn();
  }

  function pushLog(text) {
    var t = String(text === undefined || text === null ? "" : text);
    // 带换行的多行日志按行拆开，底部条只显示最后一行
    t.split(/\r?\n/).forEach(function (line) {
      if (line.trim()) {
        state.logs.push(line);
      }
    });
    if (state.logs.length > 300) {
      state.logs.splice(0, state.logs.length - 300);
    }
    // 底部不再滚日志文字：结果统一走提示浮层，日志是排查时才点开看的东西
    var panel = $("logPanel");
    if (panel.classList.contains("show")) {
      renderLogs();
    }
  }

  // ---------- 给用户看的提示 ----------
  // 日志是排查用的，不该要求普通用户去读它：操作结果（成功/失败/编号重复）一律走这个
  // 浮层，日志照旧写满（想看的人点底部那个「日志」按钮）。
  var toastTimer = null;
  function toast(text, bad) {
    var el = $("toast");
    if (!el) {
      return;
    }
    el.textContent = String(text === undefined || text === null ? "" : text);
    el.className = "toast show" + (bad ? " bad" : "");
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      el.className = "toast";
    }, 2800);
  }

  function renderLogs() {
    $("logList").innerHTML = state.logs
      .slice(-200)
      .map(function (l) {
        return '<div class="line">' + esc(l) + "</div>";
      })
      .join("");
  }

  // ---------- 编号范围筛选 ----------
  // 这一段的口径与电脑版 client-product.js 的「编号列筛选」逐字一致（含补零、裸数字按 A 段、
  // 单值精确匹配、写错时 bad=true 不静默出空表）。两份代码物理分离（手机页是独立静态文件，
  // 引不到 client-product.js），所以改了一边另一边必须跟着改 —— scripts/check-shopTool-parity.cjs
  // 会同时跑两边的 parseCodeQuery 比对输出，只改一处会直接红。
  var CODE_TERM_RE = /^([A-Za-z]?)(\d{1,4})\s*~\s*([A-Za-z]?)(\d{1,4})$/;
  var CODE_LIST_RE = /[,，、;；\n\r]+/;
  var CODE_HAS_RANGE_RE = /~/;
  var CODE_BAD_HINT = {
    mixedPrefix: "两侧字母不一致：请用同一个字母，如 A1~A33",
    halfPrefix: "字母要么两端都写（A1~A33），要么两端都不写（1~33）",
    reversed: "区间反了，请从小到大写，如 A1~A33",
    invalid: "解析不出合法区间：格式为 字母+数字~字母+数字，如 A1~A33",
  };

  /** 单个编号词元 → {p,n}；字母可省（按 A 段）。bareAsA=false 时要求必须带字母。 */
  function parseCodeTok(s, bareAsA) {
    var m = String(s === undefined || s === null ? "" : s)
      .trim()
      .match(/^([A-Za-z]?)(\d{1,4})$/);
    if (!m) {
      return null;
    }
    if (!m[1] && bareAsA === false) {
      return null;
    }
    var n = Number(m[2]);
    if (!Number.isInteger(n) || n < 0 || n > 9999) {
      return null;
    }
    return { p: (m[1] || "A").toUpperCase(), n: n };
  }

  /** 解析编号表达式 → { terms, bad, msg }：逗号分段取并集；含 ~ 走区间，带字母单值走精确，其余走子串。 */
  function parseCodeQuery(raw) {
    var q = { terms: [], bad: false, msg: "" };
    var groups = String(raw === undefined || raw === null ? "" : raw).split(CODE_LIST_RE);
    for (var i = 0; i < groups.length; i++) {
      var s = groups[i].trim();
      if (!s) {
        continue;
      }
      if (!CODE_HAS_RANGE_RE.test(s)) {
        var one = parseCodeTok(s, false);
        q.terms.push(one ? { kind: "range", p: one.p, lo: one.n, hi: one.n } : { kind: "text", s: s.toLowerCase() });
        continue;
      }
      var m = s.match(CODE_TERM_RE);
      if (!m) {
        if (!q.bad) {
          q.bad = true;
          q.msg = "「" + s + "」" + CODE_BAD_HINT.invalid;
        }
        continue;
      }
      var p1 = m[1].toUpperCase();
      var p2 = m[3].toUpperCase();
      var why = "";
      if (p1 && p2 && p1 !== p2) {
        why = CODE_BAD_HINT.mixedPrefix;
      } else if (!!p1 !== !!p2) {
        why = CODE_BAD_HINT.halfPrefix;
      }
      var lo = Number(m[2]);
      var hi = Number(m[4]);
      if (!why && lo > hi) {
        why = CODE_BAD_HINT.reversed;
      }
      if (why) {
        if (!q.bad) {
          q.bad = true;
          q.msg = "「" + s + "」" + why;
        }
        continue;
      }
      q.terms.push({ kind: "range", p: p1 || p2 || "A", lo: lo, hi: hi });
    }
    return q;
  }

  function matchCodeRange(code, t) {
    var c = parseCodeTok(code);
    if (!c || c.p !== t.p) {
      return false;
    }
    return c.n >= t.lo && c.n <= t.hi;
  }

  function matchCodeQuery(code, q) {
    if (!q || q.bad || !q.terms.length) {
      return !q || !q.bad;
    }
    for (var i = 0; i < q.terms.length; i++) {
      var t = q.terms[i];
      if (t.kind === "range") {
        if (matchCodeRange(code, t)) {
          return true;
        }
      } else if (String(code === undefined || code === null ? "" : code).toLowerCase().indexOf(t.s) >= 0) {
        return true;
      }
    }
    return false;
  }

  /** parseCodeQuery 的一格记忆：一次渲染会多次取 filtered()，别重复解析。 */
  var _cqRaw = null;
  var _cqParsed = null;
  function codeQuery() {
    if (state.codeQ !== _cqRaw) {
      _cqRaw = state.codeQ;
      _cqParsed = parseCodeQuery(state.codeQ);
    }
    return _cqParsed;
  }

  // ---------- 列表 / 画册 ----------
  /** 枚举列取值 → 界面上的键；status 转成中文那两个值以外的内部键，避免中英文混着存 */
  function enumKeyOf(field, p) {
    if (field === "status") {
      return num(p.status) === 1 ? "off" : "on";
    }
    if (field === "img") {
      var c = state.imgStats[p.code];
      // 还没统计过就返回空串：这时「无图」不该把人筛掉（否则一开筛选就空表，看着像坏了）
      return c === undefined ? "" : num(c) > 0 ? "1" : "0";
    }
    return String(p[field] === undefined || p[field] === null ? "" : p[field]);
  }

  function matchEnum(p) {
    var e = state.filters.enum;
    for (var field in e) {
      var set = e[field];
      var keys = Object.keys(set);
      if (!keys.length) {
        continue;
      }
      var v = enumKeyOf(field, p);
      if (!set[v]) {
        return false;
      }
    }
    return true;
  }

  function matchNum(p) {
    var n = state.filters.num;
    for (var field in n) {
      var r = n[field];
      if (r.min === "" && r.max === "") {
        continue;
      }
      var v = field === "stock" ? num(p.stockTotal) : num(p[field]);
      if (r.min !== "" && v < Number(r.min)) {
        return false;
      }
      if (r.max !== "" && v > Number(r.max)) {
        return false;
      }
    }
    return true;
  }

  function sortList(list) {
    var s = state.sort;
    var out = list.slice();
    if (s === "stock") {
      out.sort(function (a, b) {
        return num(a.stockTotal) - num(b.stockTotal);
      });
    } else if (s === "sale") {
      out.sort(function (a, b) {
        return num(a.sale_price) - num(b.sale_price);
      });
    } else if (s === "new") {
      out.sort(function (a, b) {
        return num(b.id) - num(a.id);
      });
    } else {
      // 默认按编号：后端 SELECT 已经 ORDER BY code，但位数不一致时（L1 与 L001）
      // 字符串顺序会错，这里按「字母段 + 数字」排，与电脑版排序同一口径
      out.sort(function (a, b) {
        var ca = parseCodeTok(a.code, false);
        var cb = parseCodeTok(b.code, false);
        if (ca && cb) {
          if (ca.p !== cb.p) {
            return ca.p < cb.p ? -1 : 1;
          }
          return ca.n - cb.n;
        }
        return String(a.code || "").localeCompare(String(b.code || ""), "zh-Hans-CN");
      });
    }
    return out;
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var scope = state.scope;
    var cq = codeQuery();
    var out = state.products.filter(function (p) {
      if (!matchCodeQuery(p.code, cq)) {
        return false;
      }
      if (!matchEnum(p) || !matchNum(p)) {
        return false;
      }
      if (!q) {
        return true;
      }
      // 选了列就只搜那一列（子串）；「全部」是跨列 OR。
      // 电脑版「全部」还有「跨字段空格拼接」和「编号去零兜底」两条历史行为，手机上没继承：
      // 手机上手打空格少，去零兜底又容易把「香薰 12」捞出一堆编号，看着像 bug。
      if (scope !== "all") {
        return String(p[scope] === undefined || p[scope] === null ? "" : p[scope]).toLowerCase().indexOf(q) >= 0;
      }
      for (var i = 0; i < KEYWORD_FIELDS.length; i++) {
        var v = String(p[KEYWORD_FIELDS[i]] === undefined || p[KEYWORD_FIELDS[i]] === null ? "" : p[KEYWORD_FIELDS[i]]);
        if (v.toLowerCase().indexOf(q) >= 0) {
          return true;
        }
      }
      return false;
    });
    return sortList(out);
  }

  function isLow(p) {
    return state.alert > 0 && p.status !== 1 && num(p.stockTotal) <= state.alert;
  }

  function renderList() {
    // innerHTML 一换，滚动位置就没了。页面没变时把位置还回去 —— 列表里改一个值就会收到
    // productsDelta → renderList，不还原的话改完一行列表直接跳回顶部（很像是「界面不稳定」）
    var keepScroll = $("content").scrollTop;
    var all = filtered();
    var cq = codeQuery();
    // 一次只渲一页：手机上 DOM 一多就明显卡，画册尤其（每张一张图）
    var pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (state.page >= pages) {
      state.page = pages - 1;
    }
    if (state.page < 0) {
      state.page = 0;
    }
    var list = all.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
    $("count").textContent = all.length + " / " + state.products.length;
    // 编号框在筛选展开区里（动态生成），面板没打开时它不在 DOM 中
    var cqEl = $("codeQ");
    if (cqEl) {
      cqEl.classList.toggle("bad", !!(cq && cq.bad));
    }
    renderActive(); // 条件 pill 条：每次筛选变化都重画，列表页上永远看得见「现在筛了什么」
    renderPager(all.length, pages);
    // 编号表达式写错要明确说出来，不能只给一张空表（与电脑版一致）
    var warn = cq && cq.bad ? '<p class="warn">⚠️' + esc(cq.msg) + "</p>" : "";
    if (!all.length) {
      $("content").innerHTML = warn + '<p class="muted">（没有匹配的商品）</p>';
      return;
    }
    if (state.view === "gallery") {
      $("content").innerHTML =
        warn +
        '<div class="grid">' +
        list
          .map(function (p) {
            var off = p.status === 1;
            return (
              '<div class="card' +
              (off ? " off" : "") +
              '" data-id="' +
              p.id +
              '" data-open="1">' +
              '<img class="thumb" loading="lazy" src="' +
              imgUrl(p.code, "", "thumb") +
              '" alt="" onerror="this.outerHTML=\'<div class=&quot;ph&quot;>暂无图片</div>\'" />' +
              '<div class="body">' +
              '<div><span class="code">' +
              esc(p.code) +
              "</span>" +
              (off ? '<span class="badge">已下架</span>' : "") +
              "</div>" +
              "<div>" +
              esc(p.name) +
              "</div>" +
              // 第一行只放两个价（进多少、卖多少），库存单独一行：挤在一行时小卡片上
              // 三个数会连成一团，库存是另外一件事，换行更好扫
              "<div>" +
              '<span class="cost">进 ' +
              money(p.cost_price) +
              "</span> → " +
              money(p.sale_price) +
              "</div>" +
              '<div class="stk' +
              (isLow(p) ? " low" : "") +
              '">库存 ' +
              num(p.stockTotal) +
              "</div>" +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else {
      // 真表格：进价 / 售价 / 等级 / 库存 / 状态各占一列（手机上横向可滑，不再挤成一行）
      $("content").innerHTML =
        warn +
        '<div class="tblwrap"><table class="tbl"><thead><tr>' +
        "<th>编号</th><th>名称</th><th>进价</th><th>售价</th><th>等级</th><th>库存</th><th>状态</th>" +
        "</tr></thead><tbody>" +
        list
          .map(rowHtml)
          .join("") +
        "</tbody></table></div>";
    }
    $("content").scrollTop = keepScroll;
  }

  /**
   * 表格一行。可编辑的格子带 data-ed：名称 / 进价 / 售价 / 库存 / 状态 / 等级。
   * 名称是文本（不走数字那条路），进价售价等是数字 —— 两类都在这一个属性下，靠 TEXT_FIELDS 区分。
   * 编号列不参与改值：它是「进详情」的入口。
   */
  // 点一下 = 选中这一格，再点一下才弹输入框 —— 手机上误触一下就顶出键盘太烦，中间加一拍确认。
  // 选中态按 {id, field} 记着，表格重画时照它把框补回去（改完一个值整行会重画，框不能丢）。
  var selected = null; // { id, field }

  function selClass(p, field) {
    return selected && num(selected.id) === num(p.id) && selected.field === field ? " sel" : "";
  }

  function clearSelected() {
    var old = $("content").querySelector("td.sel");
    if (old) {
      old.classList.remove("sel");
    }
    selected = null;
  }

  function rowHtml(p) {
    var off = p.status === 1;
    return (
      '<tr data-id="' +
      p.id +
      '"' +
      (off ? ' class="off"' : "") +
      ">" +
      '<td class="open" data-open="1">' +
      esc(p.code) +
      "</td>" +
      '<td class="nm ed' + selClass(p, "name") + '" data-ed="name" title="点一下选中，再点一下改名称">' +
      esc(p.name) +
      "</td>" +
      '<td class="num ed' +
      selClass(p, "cost_price") +
      '" data-ed="cost_price" title="点一下选中，再点一下改进价">' +
      money(p.cost_price) +
      "</td>" +
      '<td class="num ed' +
      selClass(p, "sale_price") +
      '" data-ed="sale_price" title="点一下选中，再点一下改售价">' +
      money(p.sale_price) +
      "</td>" +
      // 等级可改：后端改等级会按新规则重算售价（product.ts 的 grade 分支），所以这里改了就生效
      '<td class="num ed' +
      selClass(p, "grade") +
      '" data-ed="grade" title="点一下选中，再点一下改等级 → 售价按新等级规则重算">' +
      (num(p.grade) > 0 ? num(p.grade) : "自定义") +
      "</td>" +
      '<td class="num ed' +
      (isLow(p) ? " low" : "") +
      selClass(p, "stock") +
      '" data-ed="stock" title="点一下选中，再点一下改库存（= 实际清点数）">' +
      num(p.stockTotal) +
      "</td>" +
      '<td class="ed' +
      (off ? " low" : "") +
      '" data-ed="status" title="点一下直接切换上/下架">' +
      (off ? "已下架" : "在售") +
      "</td>" +
      "</tr>"
    );
  }

  function findProduct(id) {
    for (var i = 0; i < state.products.length; i++) {
      if (num(state.products[i].id) === num(id)) {
        return state.products[i];
      }
    }
    return null;
  }

  // ---------- 表格里改一个值：从底部弹出的 sheet ----------
  // 之前是内联（点一下格子就地变成输入框），手机上有两个绕不过去的坑：
  // ① iOS 的规矩是「聚焦到 font-size < 16px 的输入框就把整页放大」，格子里那个 13px 的框
  //    一聚焦整页就放大；② 我们为了「只缩内容区」在内容区拦了系统缩放手势，于是放大之后捏不回来。
  // 改成底部 sheet：输入框做到 ≥16px（iOS 不再自动放大），键盘正好顶在 sheet 下面、不遮输入框，
  // 顺带解决格子只有 150px、长名称改着憋屈的老问题。
  // 同类以后要加文本列（品类/系列）就往 TEXT_FIELDS 里加，数字列不用登记。
  var TEXT_FIELDS = { name: 1 };
  var FIELD_LABEL = {
    name: "名称",
    cost_price: "进价",
    sale_price: "售价",
    grade: "等级",
    stock: "库存",
    status: "状态",
  };
  // sheet 里那句话：说清楚这一格写的是什么、改了会连带什么（写在格子里没地方放）
  var FIELD_HINT = {
    name: "商品名称，随便写。",
    cost_price: "进价。改完售价会按等级规则重算（自己手填过售价的不动）。",
    sale_price: "售价。填了就固定按这个卖，不再跟着等级规则变。",
    grade: "等级。改完售价按新等级的规则重算。",
    stock: "库存 = 实际清点出来的数，直接写。",
  };

  // 只做几个常用字段：改一个值不该让人跳一页。写库走的就是详情页那一套消息
  // （updateProductField / setStockQty / setStatus），业务口径一处没动。
  var editing = null; // { row, field, id, orig, txt } —— 由 sheet 填写

  /** 按 id 重画一行。比拿着 row 引用稳：提交后可能整表重画过，那个引用早就是孤儿了 */
  function refreshRow(id) {
    var p = findProduct(id);
    var r = $("content").querySelector('tr[data-id="' + id + '"]');
    if (p && r) {
      r.outerHTML = rowHtml(p);
    }
  }

  function openFieldSheet(row, cell) {
    var p = findProduct(num(row.dataset.id));
    if (!p) {
      return;
    }
    var field = cell.dataset.ed;
    if (editing) {
      commitEdit(true); // 换一格改：先结算上一格（值没变等于没改）
    }
    var isTxt = !!TEXT_FIELDS[field];
    var cur = isTxt
      ? String(p[field] === undefined || p[field] === null ? "" : p[field])
      : field === "stock"
        ? num(p.stockTotal)
        : num(p[field]);
    editing = { row: row, field: field, id: p.id, orig: cur, txt: isTxt };
    $("fsTitle").textContent = (FIELD_LABEL[field] || field) + "　" + p.code + "　" + (p.name || "");
    $("fsBody").innerHTML =
      field === "grade"
        ? '<select id="fsInput" class="big">' + gradeOptions(cur, p) + "</select>"
        : '<input id="fsInput" class="big" type="text"' +
          // 名称不该弹数字键盘；数字列要小数键盘（inputmode 在手机上决定了键盘长什么样）
          (isTxt ? "" : ' inputmode="decimal"') +
          ' value="' +
          esc(String(cur)) +
          '" />';
    $("fsHint").textContent = FIELD_HINT[field] || "";
    $("fieldSheet").classList.add("show");
    var input = $("fsInput");
    // 必须在这一个 click 里同步 focus：放到下一拍 iOS 就不弹键盘了
    input.focus();
    if (input.tagName !== "SELECT") {
      input.select();
    }
  }

  function closeFieldSheet() {
    editing = null;
    $("fieldSheet").classList.remove("show");
    $("fsBody").innerHTML = "";
  }

  /** 等级下拉的选项；「自定义」是否选中看 price_manual —— 与电脑版同一口径 */
  function gradeOptions(cur, p) {
    var manual = num(p.price_manual) === 1;
    var opts =
      '<option value="0"' + (manual || num(cur) === 0 ? " selected" : "") + ">自定义</option>" +
      state.rules
        .map(function (r) {
          var sel = !manual && num(r.grade) === num(cur) ? " selected" : "";
          return '<option value="' + r.grade + '"' + sel + ">" + esc(gradeLabel(r.grade)) + "</option>";
        })
        .join("");
    return opts;
  }

  /** submit=false 就是放弃这次改动；值没变则什么都不发（避免误点一下也写库） */
  function commitEdit(submit) {
    var ed = editing;
    if (!ed) {
      return;
    }
    editing = null;
    var p = findProduct(ed.id);
    if (!p) {
      closeFieldSheet();
      renderList(); // 编辑期间这条被别人删了：没有可还原的行，整表重画
      return;
    }
    var input = $("fsInput"); // sheet 里的输入框（等级是下拉）
    var raw = input ? String(input.value || "").trim() : "";
    var v;
    var changed;
    if (ed.txt) {
      // 文本列（名称）：按字符串比较。留空当作「没改」—— 空名称在列表里就是一行没有名字，
      // 找不回来，宁可退回原值
      v = raw;
      changed = submit && raw !== "" && v !== String(ed.orig);
      if (submit && raw === "") {
        pushLog("⚠️名称不能是空的，没改");
      }
    } else {
      v = Number(raw);
      changed = submit && raw !== "" && Number.isFinite(v) && v !== num(ed.orig);
      if (submit && raw !== "" && !Number.isFinite(v)) {
        pushLog("⚠️「" + raw + "」不是一个数字，没改");
      }
    }
    closeFieldSheet(); // 值已经读出来了，先把 sheet 收掉（里面那个输入框马上要被清空）
    if (!changed) {
      refreshRow(ed.id);
      return;
    }
    var isStock = ed.field === "stock";
    var before = isStock ? num(p.stockTotal) : num(p[ed.field]);
    // 乐观更新：先让格子显示新值，请求失败再回滚（列表里改一个数还要等网络会显得很卡）
    applyLocal(p, ed.field, v);
    refreshRow(ed.id);
    // 刻意不 reload：改的就是这一个字段，本地值已经是权威值；整表重绘会让列表闪一下、
    // 滚动位置也可能丢 —— 就地改的意义就是「不跳、不闪」。失败时回滚（下面 catch）
    var msg = isStock ? "setStockQty" : "updateProductField";
    var payload = isStock ? { id: p.id, qty: v } : { id: p.id, field: ed.field, value: v };
    invoke(msg, payload)
      .then(function () {
        // 改进价 / 改等级：后端会把售价按规则重算（product.ts），本地只改了一个字段，
        // 不回读的话这一行会显示旧的售价，看着像没改成功
        if (ed.field === "cost_price" || ed.field === "grade") {
          return invoke("loadAll");
        }
      })
      .catch(function () {
        applyLocal(p, ed.field, before);
        refreshRow(p.id);
      });
  }

  /** 上下架：没有输入框，点一下就切。改完同样走乐观更新 + 失败回滚 */
  function toggleStatus(p, row) {
    var before = p.status;
    var next = p.status === 1 ? 0 : 1;
    p.status = next;
    row.outerHTML = rowHtml(p);
    invoke("setStatus", { id: p.id, status: next }).catch(function () {
      p.status = before;
      var r = $("content").querySelector('tr[data-id="' + p.id + '"]');
      if (r) {
        r.outerHTML = rowHtml(p);
      }
    });
  }

  /** 只改内存里那一条，等 loadAll 回来再被真值覆盖 */
  function applyLocal(p, field, v) {
    if (field === "stock") {
      p.stockTotal = v;
    } else {
      p[field] = v;
    }
  }

  // ---------- 漏斗筛选面板 ----------
  function gradeLabel(g) {
    var r = null;
    for (var i = 0; i < state.rules.length; i++) {
      if (num(state.rules[i].grade) === num(g)) {
        r = state.rules[i];
      }
    }
    if (num(g) === 0) {
      return "自定义（售价手动定）";
    }
    return r && r.label ? "等级 " + g + "：" + r.label : "等级 " + g;
  }

  /** 枚举列的所有取值 + 每个值有多少个（按全量统计，不受当前筛选影响，否则勾一个就看不见别的） */
  function enumValues(field) {
    if (field === "status") {
      return [
        { k: "on", label: "在售" },
        { k: "off", label: "已下架" },
      ];
    }
    var seen = {};
    state.products.forEach(function (p) {
      var v = enumKeyOf(field, p);
      seen[v] = (seen[v] || 0) + 1;
    });
    return Object.keys(seen)
      .sort(function (a, b) {
        return field === "grade" ? num(a) - num(b) : a.localeCompare(b, "zh-Hans-CN");
      })
      .map(function (k) {
        var label = field === "grade" ? gradeLabel(k) : k === "" ? "（空）" : k;
        return { k: k, label: label, n: seen[k] };
      });
  }

  // ---------- 生效中的条件（pill 条） ----------
  // 筛选一旦「进到一个屏里」，回到列表就不知道自己筛了什么、也清不掉。
  // 所以每个条件外显成一个 pill：点单个 ✕ 撤一条，末尾「清除全部」一键回全表。
  function enumLabel(field, v) {
    if (field === "grade") {
      return gradeLabel(v);
    }
    if (field === "status") {
      return v === "off" ? "已下架" : "在售";
    }
    if (field === "img") {
      return v === "0" ? "无图" : "有图";
    }
    return v === "" ? "（空）" : v;
  }

  function activePills() {
    var out = [];
    var q = state.q.trim();
    if (q) {
      out.push({ c: "q", t: (SCOPE_LABEL[state.scope] || "关键词") + "：" + q });
    }
    if (state.codeQ.trim()) {
      out.push({ c: "code", t: "编号 " + state.codeQ.trim() });
    }
    ENUM_COLS.concat([["img", "图片"]]).forEach(function (c) {
      var set = state.filters.enum[c[0]];
      Object.keys(set).forEach(function (v) {
        out.push({ c: "enum:" + c[0] + ":" + v, t: c[1] + "：" + enumLabel(c[0], v) });
      });
    });
    NUM_COLS.forEach(function (c) {
      var r = state.filters.num[c[0]];
      if (!r) {
        return;
      }
      var t = "";
      if (r.min !== "" && r.max !== "") {
        t = c[1] + " " + r.min + "~" + r.max;
      } else if (r.min !== "") {
        t = c[1] + " ≥" + r.min;
      } else if (r.max !== "") {
        t = c[1] + " ≤" + r.max;
      }
      if (t) {
        out.push({ c: "num:" + c[0], t: t });
      }
    });
    return out;
  }

  function renderActive() {
    var pills = activePills();
    // 面板收起时也要知道「现在筛着几条」，所以计数挂在按钮上
    $("btnFilter").textContent = "🔻 筛选" + (pills.length ? " " + pills.length : "");
    var bar = $("activeBar");
    if (!pills.length && state.sort === "code") {
      bar.innerHTML = "";
      bar.classList.remove("show");
      return;
    }
    bar.classList.add("show");
    var html = pills
      .map(function (p) {
        return '<button type="button" class="pill" data-clr="' + esc(p.c) + '"><span>' + esc(p.t) + "</span><b>✕</b></button>";
      })
      .join("");
    if (state.sort !== "code") {
      html += '<button type="button" class="pill soft" data-clr="sort"><span>排序：' + esc(SORT_LABEL[state.sort] || state.sort) + "</span><b>✕</b></button>";
    }
    if (pills.length) {
      html += '<button type="button" class="pill clear" data-clr="all">清除全部</button>';
    }
    bar.innerHTML = html;
  }

  /** 编号框在展开区里动态生成，面板关着时不存在 —— 统一走这里，别直接 $("codeQ").value = */
  function setCodeQ(v) {
    var el = $("codeQ");
    if (el) {
      el.value = v;
    }
  }

  /** 撤掉一个条件。改完要把输入框/圆片同步回去，不然界面和 state 会各说各话 */
  function clearOne(code) {
    if (code === "all") {
      state.filters = { enum: { category: {}, series: {}, grade: {}, status: {}, img: {} }, num: {} };
      state.q = "";
      state.codeQ = "";
      $("q").value = "";
      setCodeQ("");
    } else if (code === "q") {
      state.q = "";
      $("q").value = "";
    } else if (code === "code") {
      state.codeQ = "";
      setCodeQ("");
    } else if (code === "sort") {
      state.sort = "code";
    } else if (code.indexOf("enum:") === 0) {
      var p = code.split(":");
      delete state.filters.enum[p[1]][p[2]];
    } else if (code.indexOf("num:") === 0) {
      delete state.filters.num[code.slice(4)];
    }
    state.page = 0;
    if (state.panelOpen) {
      renderFilter(); // 展开着就把圆片和区间框同步回 state
    } else if ($("sortBy")) {
      $("sortBy").value = state.sort;
    }
    renderList();
  }

  /**
   * 问后端「每个编号有几张图」。图片存在 imageDir 的编号文件夹里、不在数据库里，
   * 要知道有没有图只能扫目录 —— 所以只在这里要一次，不塞进每次的 loadAll。
   */
  function requestImgStats() {
    if (state.imgStatsLoaded || state.imgStatsBusy || !state.products.length) {
      return;
    }
    state.imgStatsBusy = true;
    var codes = state.products.map(function (p) {
      return p.code;
    });
    invoke("loadImageStats", { codes: codes })
      .catch(function () {
        pushLog("⚠️统计图片数量失败，「有无图片」筛不了");
      })
      .then(function () {
        state.imgStatsBusy = false;
      });
  }

  function renderFilter() {
    // 编号范围是一组条件（L1~L33），不是搜索关键词，所以跟其它筛选放在一起
    var html =
      '<div class="fgroup"><div class="ftitle" data-label="编号范围">编号范围</div>' +
      '<input id="codeQ" class="inline wide" type="search" placeholder="L1~L33 / 1~33 / L1" value="' +
      esc(state.codeQ) +
      '" /><p class="muted small">L1~L33 是区间；单写一个 L1 = 精确匹配 L001；多段用逗号：A1~A33,L1~L22。' +
      "想按编号子串找（比如 L007）用顶部搜索框，左边下拉选「编号」。</p></div>";
    ENUM_COLS.forEach(function (c) {
      var field = c[0];
      var set = state.filters.enum[field];
      var n = Object.keys(set).length;
      var chips = enumValues(field)
        .map(function (o) {
          return (
            '<button type="button" class="chip' +
            (set[o.k] ? " on" : "") +
            '" data-field="' +
            field +
            '" data-v="' +
            esc(o.k) +
            '">' +
            esc(o.label) +
            (o.n === undefined ? "" : " " + o.n) +
            "</button>"
          );
        })
        .join("");
      html +=
        '<div class="fgroup"><div class="ftitle" data-label="' +
        esc(c[1]) +
        '">' +
        esc(c[1]) +
        (n ? "（已选 " + n + "）" : "") +
        '</div><div class="chips">' +
        (chips || '<span class="muted small">（没有可选值）</span>') +
        "</div></div>";
    });
    // 「图片」：有图 / 无图 互斥，用来找还没传图的商品去补图。
    // 数量要后端扫目录才知道，扫完之前只给两个不带数字的圆片。
    var imgSet = state.filters.enum.img || {};
    var n0 = 0;
    var n1 = 0;
    if (state.imgStatsLoaded) {
      state.products.forEach(function (p) {
        if (num(state.imgStats[p.code]) > 0) {
          n1++;
        } else {
          n0++;
        }
      });
    }
    html +=
      '<div class="fgroup"><div class="ftitle" data-label="图片">图片</div><div class="chips">' +
      '<button type="button" class="chip' +
      (imgSet["0"] ? " on" : "") +
      '" data-field="img" data-v="0">无图' +
      (state.imgStatsLoaded ? " " + n0 : "") +
      "</button>" +
      '<button type="button" class="chip' +
      (imgSet["1"] ? " on" : "") +
      '" data-field="img" data-v="1">有图' +
      (state.imgStatsLoaded ? " " + n1 : "") +
      "</button>" +
      (state.imgStatsLoaded
        ? ""
        : '<span class="muted small">（打开筛选时正在数图片…）</span>') +
      "</div></div>";
    NUM_COLS.forEach(function (c) {
      var field = c[0];
      var r = state.filters.num[field] || { min: "", max: "" };
      html +=
        '<div class="fgroup"><div class="ftitle" data-label="' +
        esc(c[1]) +
        '">' +
        esc(c[1]) +
        '</div><div class="rng">' +
        '<input class="inline" type="number" inputmode="decimal" data-num="' +
        field +
        '" data-side="min" placeholder="最小" value="' +
        esc(r.min) +
        '" />' +
        '<span class="muted">~</span>' +
        '<input class="inline" type="number" inputmode="decimal" data-num="' +
        field +
        '" data-side="max" placeholder="最大" value="' +
        esc(r.max) +
        '" /></div></div>';
    });
    $("filterBody").innerHTML = html;
    $("sortBy").value = state.sort;
  }

  // ---------- 规则与设置（只读） ----------
  function kvRows(pairs) {
    return pairs
      .map(function (p) {
        return '<div class="kvr"><span class="k">' + esc(p[0]) + '</span><span class="v">' + esc(String(p[1])) + "</span></div>";
      })
      .join("");
  }

  function renderSettings() {
    var rows = state.rules
      .map(function (r) {
        var tail = r.tail_mode && r.tail_mode !== "none" ? " · 尾数 " + r.tail_mode + " " + (r.tail_value === undefined || r.tail_value === null ? "" : r.tail_value) : "";
        return '<div class="kvr"><span class="k">' + esc(gradeLabel(r.grade)) + '</span><span class="v">' + esc(String(r.expr || "（无表达式）")) + esc(tail) + "</span></div>";
      })
      .join("");
    $("ruleTable").innerHTML = rows || '<div class="muted small">（还没有等级规则：去电脑版「规则与设置」里加）</div>';
    $("settingTable").innerHTML = kvRows([
      ["库存预警阈值", state.settings.stock_alert === undefined ? "—" : state.settings.stock_alert],
      ["商品总数", state.products.length],
    ]);
    fetch("/api/ping" + (token ? "?token=" + encodeURIComponent(token) : ""))
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        $("serverTable").innerHTML = kvRows([
          ["数据目录", j.storageDir || "—"],
          ["图片目录", j.imageDir || "—"],
          ["图片目录可用", j.imageDirReady ? "是" : "否"],
          ["需要口令", j.tokenRequired ? "是" : "否（局域网内不校验）"],
        ]);
      })
      .catch(function () {
        $("serverTable").innerHTML = '<div class="muted small">（读不到服务信息）</div>';
      });
  }

  function renderPager(total, pages) {
    var from = total === 0 ? 0 : state.page * PAGE_SIZE + 1;
    var to = Math.min(total, (state.page + 1) * PAGE_SIZE);
    $("pageInfo").textContent =
      total === 0
        ? "共 0 条"
        : "第 " + from + "–" + to + " 条 · 共 " + total + " 条 · " + (state.page + 1) + "/" + pages + " 页";
    $("pagePrev").disabled = state.page <= 0;
    $("pageNext").disabled = state.page >= pages - 1;
    $("pageFirst").disabled = state.page <= 0;
    $("pageLast").disabled = state.page >= pages - 1;
    // 页数变了才重填下拉：每次渲染都重建会把用户刚展开的下拉收回去
    var jump = $("pageJump");
    if (jump.dataset.pages !== String(pages)) {
      jump.dataset.pages = String(pages);
      var opts = "";
      for (var i = 0; i < pages; i++) {
        opts += '<option value="' + i + '">第 ' + (i + 1) + " 页</option>";
      }
      jump.innerHTML = opts;
    }
    jump.value = String(state.page);
    jump.disabled = pages <= 1;
  }

  function fillCategoryList() {
    var seen = {};
    state.products.forEach(function (p) {
      if (p.category) {
        seen[p.category] = 1;
      }
    });
    $("catList").innerHTML = Object.keys(seen)
      .sort()
      .map(function (c) {
        return "<option value=\"" + esc(c) + '"></option>';
      })
      .join("");
  }

  function fillGradeSelect() {
    var sel = $("nGrade");
    var opts = state.rules
      .map(function (r) {
        return (
          '<option value="' +
          r.grade +
          '">' +
          esc((r.label ? r.label + "（等级 " + r.grade + "）" : "等级 " + r.grade) + "：" + r.expr) +
          "</option>"
        );
      })
      .join("");
    sel.innerHTML = opts + '<option value="0">自定义（售价手动定）</option>';
    // 默认「自定义」：售价就按手填的走，不会被规则悄悄改掉。新建时多数是已经知道卖多少，
    // 让它按规则算反而每次都要确认「算出来的对不对」；要用规则定价时自己选等级即可。
    sel.value = "0";
    updateRuleHint();
  }

  function updateRuleHint() {
    var g = num($("nGrade").value);
    var r = null;
    for (var i = 0; i < state.rules.length; i++) {
      if (num(state.rules[i].grade) === g) {
        r = state.rules[i];
      }
    }
    $("ruleHint").textContent = r
      ? "售价会按等级 " + g + " 的规则自动算：" + r.expr + "（cost = 进价）。填了售价就按你填的算。"
      : "这个等级没有规则，也不会自动算售价：请在「售价」里手填（或去电脑版加一条等级规则）。";
  }

  // ---------- 详情 ----------
  /** 从画册/列表点进来：先在**当前筛选结果**里定位 —— 前后翻就按这个顺序走，不是按全库顺序。 */
  function openDetail(id) {
    var all = filtered();
    for (var i = 0; i < all.length; i++) {
      if (num(all[i].id) === num(id)) {
        openDetailAt(i);
        return;
      }
    }
  }

  function openDetailAt(idx) {
    var all = filtered();
    var p = all[idx];
    if (!p) {
      return;
    }
    // 翻过页边界时把列表页也带过去：从详情返回时，列表停在他正在看的位置
    var want = Math.floor(idx / PAGE_SIZE);
    if (want !== state.page) {
      state.page = want;
      renderList();
    }
    state.detail = {
      id: p.id,
      code: p.code,
      idx: idx,
      status: p.status === 1 ? 1 : 0,
      orig: {
        name: p.name || "",
        cost_price: num(p.cost_price),
        sale_price: num(p.sale_price),
        stockTotal: num(p.stockTotal),
        category: p.category || "",
        series: p.series || "",
      },
    };
    $("dTitle").textContent = p.code + " " + (p.name || "");
    $("fName").value = p.name || "";
    $("fCost").value = num(p.cost_price);
    $("fSale").value = num(p.sale_price);
    $("fStock").value = num(p.stockTotal);
    $("fCategory").value = p.category || "";
    $("fSeries").value = p.series || "";
    syncStatusBtn();
    updateDetailNav();
    $("dCover").innerHTML = '<img src="' + imgUrl(p.code, "", "full") + '" alt="" />';
    show("screen-detail");
    loadImages(p.code);
  }

  function updateDetailNav() {
    var d = state.detail;
    if (!d) {
      return;
    }
    var all = filtered();
    $("dPos").textContent = d.idx + 1 + " / " + all.length;
    $("btnPrevItem").disabled = d.idx <= 0;
    $("btnNextItem").disabled = d.idx >= all.length - 1;
  }

  /** loadAll 之后顺序可能变、商品可能被别人删掉：按 id 重新定位，别让「下一个」翻到别的商品 */
  function resyncDetailPos() {
    var d = state.detail;
    if (!d) {
      return;
    }
    var all = filtered();
    for (var i = 0; i < all.length; i++) {
      if (num(all[i].id) === num(d.id)) {
        d.idx = i;
        break;
      }
    }
    updateDetailNav();
  }

  function syncStatusBtn() {
    var off = state.detail && state.detail.status === 1;
    var b = $("fStatus");
    b.textContent = off ? "已下架（点一下上架）" : "在售（点一下下架）";
    b.className = "toggle" + (off ? " off" : "");
  }

  function loadImages(code) {
    var box = $("dImages");
    box.innerHTML = '<span class="muted small">图片读取中…</span>';
    fetch("/api/images?code=" + encodeURIComponent(code) + (token ? "&token=" + encodeURIComponent(token) : ""))
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var names = (j && j.names) || [];
        if (!names.length) {
          box.innerHTML = '<span class="muted small">这个商品还没有图片，点右上「📷 传图」拍一张。</span>';
          return;
        }
        box.innerHTML = names
          .map(function (n) {
            return (
              // 类名不能叫 thumb：画册卡片那张图已经是 .thumb 了，会撞样式
              '<span class="thumbw">' +
              '<img src="' +
              imgUrl(code, n, "thumb") +
              '" data-name="' +
              esc(n) +
              '" alt="" />' +
              // × 跟着缩略图走：不用先点进灯箱再删。按文件名删（不按序号），
              // 别人在这期间删掉前面一张时序号会指到别的文件上
              '<button class="thumb-x" type="button" data-del="' +
              esc(n) +
              '" title="删除这张图">✕</button>' +
              "</span>"
            );
          })
          .join("");
      })
      .catch(function () {
        box.innerHTML = '<span class="muted small">图片清单读不到</span>';
      });
  }

  function openViewer(code, name) {
    viewerImg = { code: code, name: name };
    $("viewerImg").src = imgUrl(code, name, "full");
    // 封面（name 为空）不是具体某张文件，删它等于删整个夹，不给这个按钮
    $("viewerDel").style.display = name ? "" : "none";
    $("viewerRetake").style.display = "none"; // 已上传的图没有「重拍」一说
    $("viewer").classList.add("show");
  }

  /** 新建页看刚拍的照片：还没上传，所以给「重拍」而不是「删除这张」 */
  function openLocalViewer(i) {
    var s = pendingNewShots[i];
    if (!s) {
      return;
    }
    viewerImg = { local: true, shot: i };
    $("viewerImg").src = s.url;
    $("viewerDel").style.display = "none";
    $("viewerRetake").style.display = "";
    $("viewer").classList.add("show");
  }

  /** 重拍 = 丢掉这张 + 把相机重新调起来（省一步「先删再点拍照」） */
  function retakeShot() {
    var v = viewerImg;
    if (!v || !v.local) {
      return;
    }
    var i = v.shot;
    $("viewer").classList.remove("show");
    $("viewerImg").src = "";
    $("viewerRetake").style.display = "none";
    viewerImg = null;
    removeNewShot(i);
    $("newFilePick").click();
  }

  var viewerImg = null; // 灯箱当前这张：{ code, name } 或 { local, shot }
  /** 灯箱里删当前这张：后端走 deleteImageFile（按文件名删，不按序号，避免删错） */
  function deleteViewerImage() {
    var v = viewerImg;
    if (!v || !v.name) {
      return;
    }
    if (!window.confirm("删除「" + v.name + "」这张图？删了就找不回来了。")) {
      return;
    }
    pushLog("⏳删除 " + v.name + "…");
    toast("删除中…");
    invoke("deleteImageFile", { code: v.code, name: v.name })
      .then(function (j) {
        if (imgDeleteFailed(j)) {
          pushLog("❌没删掉，图片还在（原因见上面一行）");
          toast("没删掉，图片还在（多半正被占用，稍等再试）", true);
          return;
        }
        toast("已删除 " + v.name);
        $("viewer").classList.remove("show");
        viewerImg = null;
        state.imgStatsLoaded = false; // 图数变了，下次用「有无图片」筛选时重新统计
        bumpImg(); // 同 deleteThumb：先换 URL 再重读，否则浏览器拿缓存里的旧图顶着
        if (state.detail && state.detail.code === v.code) {
          loadImages(v.code);
          renderList();
          $("dCover").innerHTML = '<img src="' + imgUrl(v.code, "", "full") + '" alt="" />';
        }
        return invoke("loadAll");
      })
      .catch(function () {
        pushLog("❌删除失败（可能被别的机器占用）");
        toast("删除失败（可能被别的机器占用）", true);
      });
  }

  /**
   * 后端删图失败时只打一行日志、不抛错（HTTP 照样 200），所以前端必须自己看日志判成败 ——
   * 否则会打出「🗑已删除」而图还在那儿，看着就像「点了没反应」。
   */
  function imgDeleteFailed(j) {
    var logs = (j && j.logs) || [];
    for (var i = 0; i < logs.length; i++) {
      var t = String(logs[i]);
      if (t.indexOf("删不掉") >= 0 || t.indexOf("没有第") >= 0 || t.indexOf("❌") >= 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 缩略图右上角 ×：直接删，不弹确认（用户明确要求「这样删起来更方便」）。
   * 代价要说清楚 —— 后端 deleteImageFile 是真 unlink，不进回收站也不备份，删了就没了。
   */
  function deleteThumb(name) {
    var d = state.detail;
    if (!d || !name) {
      return;
    }
    pushLog("⏳删除 " + name + "…");
    toast("删除中…");
    invoke("deleteImageFile", { code: d.code, name: name })
      .then(function (j) {
        if (imgDeleteFailed(j)) {
          pushLog("❌没删掉，图片还在（原因见上面一行）");
          toast("没删掉，图片还在（多半正被占用，稍等再试）", true);
          loadImages(d.code); // 清单并没变，重画一遍确认状态
          return;
        }
        pushLog("🗑已删除 " + name);
        toast("已删除 " + name);
        state.imgStatsLoaded = false; // 图数变了，下次用「有无图片」筛选时重新统计
        bumpImg(); // 必须先于 imgUrl：URL 变了才会真去问服务器，否则浏览器继续显示缓存里的旧图
        loadImages(d.code);
        renderList(); // 列表里这张卡片的封面也用旧 URL，一起换掉（此时列表是隐藏的，图不会真去加载）
        $("dCover").innerHTML = '<img src="' + imgUrl(d.code, "", "full") + '" alt="" />';
      })
      .catch(function () {
        pushLog("❌删除失败（可能被别的机器占用）");
        toast("删除失败（可能被别的机器占用）", true);
      });
  }

  /**
   * 详情页改完一格就存一格（失焦即存），不再有「保存修改」按钮。
   * 刻意不 loadAll 整表回读：回读会重填整个表单，把用户正在改、还没保存的其它格子冲掉。
   * 后端改完会回一条 productsDelta，售价被规则重算后的新值从那里拿（见 syncDetailFromDelta）。
   */
  function commitDetailField(cfg) {
    var d = state.detail;
    if (!d) {
      return;
    }
    var el = $(cfg[0]);
    var key = cfg[1];
    var kind = cfg[2];
    var raw = String(el.value || "").trim();
    var cur = d.orig[key];
    var val;
    if (kind === "text") {
      val = raw;
    } else {
      val = Number(raw);
      if (raw === "" || !Number.isFinite(val)) {
        pushLog("⚠️「" + raw + "」不是一个数字，没改");
        el.value = String(cur);
        return;
      }
      if (kind === "int") {
        val = Math.trunc(val);
      }
    }
    if (val === cur) {
      return; // 值没变就不发请求
    }
    d.orig[key] = val; // 乐观更新：delta 回来还会再校准一次
    var msg = key === "stockTotal" ? "setStockQty" : "updateProductField";
    var payload = key === "stockTotal" ? { id: d.id, qty: val } : { id: d.id, field: key, value: val };
    invoke(msg, payload).catch(function () {
      d.orig[key] = cur;
      el.value = String(cur);
      pushLog("❌保存失败，已退回原值");
    });
  }

  /** 离开详情页前把焦点上那一格结算掉：点返回/翻上一个时，输入框的 change 不一定来得及触发 */
  function flushDetailEdits() {
    var a = document.activeElement;
    if (!a || !a.id || !$("screen-detail").classList.contains("show")) {
      return;
    }
    DETAIL_FIELDS.forEach(function (f) {
      if (f[0] === a.id) {
        commitDetailField(f);
        a.blur();
      }
    });
  }

  // ---------- 新建 ----------
  function nextFreeCode() {
    var raw = String($("nCode").value || "").trim().toUpperCase();
    var m = /^([A-Z])(\d{1,4})$/.exec(raw);
    var prefix = m ? m[1] : "L";
    var used = {};
    state.products.forEach(function (p) {
      used[String(p.code || "").toUpperCase()] = 1;
    });
    for (var n = 1; n <= 9999; n++) {
      var code = prefix + String(n).padStart(3, "0");
      if (!used[code]) {
        $("nCode").value = code;
        return;
      }
    }
    pushLog("❌这个前缀的编号用满了");
  }

  /**
   * 建号前先查重：后端当然也会拒（编号唯一），但那是一条日志，用户看不见。
   * 录入到一半才被告知编号冲突很恼人，所以在这一格打完字就立刻说。
   */
  function findCodeOwner(code) {
    var key = String(code || "").trim().toUpperCase();
    if (!key) {
      return null;
    }
    for (var i = 0; i < state.products.length; i++) {
      if (String(state.products[i].code || "").trim().toUpperCase() === key) {
        return state.products[i];
      }
    }
    return null;
  }

  /** 编号框下面那行提示：占号就红字点名是谁，不占号就收起来 */
  function checkNewCode() {
    var el = $("nCodeHint");
    if (!el) {
      return null;
    }
    var owner = findCodeOwner($("nCode").value);
    if (owner) {
      var who = String(owner.name || "").trim();
      el.textContent =
        "⚠️编号已存在：" + String(owner.code) + (who ? "（" + who + "）" : "") + "。换一个，或点「用下一个空号」。";
      el.style.display = "";
    } else {
      el.textContent = "";
      el.style.display = "none";
    }
    return owner;
  }

  // 新建页先选好照片，保存成功后再传（没编号就传不了，图片挂在编号目录下）。
  // 每项 { file, url }：url 是本地预览用的 objectURL —— 拍完当场就能看见效果、能删能重拍，
  // 不用等上传完才知道拍糊了。移除或上传完必须 revoke，否则那张原图一直占着内存。
  var pendingNewShots = [];

  function revokeShots(list) {
    (list || []).forEach(function (s) {
      if (s && s.url) {
        URL.revokeObjectURL(s.url);
      }
    });
  }

  /** 追加一批照片（不是替换：拍完还能接着加） */
  function addNewShots(files) {
    var added = 0;
    Array.prototype.forEach.call(files || [], function (f) {
      pendingNewShots.push({ file: f, url: URL.createObjectURL(f) });
      added++;
    });
    renderNewShots();
    return added;
  }

  function removeNewShot(i) {
    var s = pendingNewShots[i];
    if (!s) {
      return;
    }
    revokeShots([s]);
    pendingNewShots.splice(i, 1);
    renderNewShots();
  }

  /** 拍完立刻能看到的那一排小图：点图看大效果，✕ 删掉 */
  function renderNewShots() {
    var box = $("newShots");
    if (!box) {
      return;
    }
    box.innerHTML = pendingNewShots
      .map(function (s, i) {
        return (
          '<span class="thumbw">' +
          '<img class="shot" src="' +
          s.url +
          '" alt="" data-shot="' +
          i +
          '" />' +
          '<button class="thumb-x" type="button" data-rm="' +
          i +
          '" title="删掉这张">✕</button>' +
          "</span>"
        );
      })
      .join("");
    box.style.display = pendingNewShots.length ? "" : "none";
    var pick = $("btnNewPick");
    if (pick) {
      pick.textContent = pendingNewShots.length ? "📷 再拍 / 加图" : "📷 拍照 / 选图";
    }
    var el = $("newPickInfo");
    if (el) {
      el.textContent = pendingNewShots.length
        ? "已选 " + pendingNewShots.length + " 张，保存后自动上传。点小图看效果，✕ 删掉重拍。"
        : "可以先拍照，建成后自动上传（也可以建成后再去详情页传）。";
    }
  }

  function createProduct() {
    var code = $("nCode").value.trim();
    if (!code) {
      toast("先填编号", true);
      return Promise.resolve();
    }
    if (findCodeOwner(code)) {
      // 输入框下面已经有红字了，这里再弹一次是因为「保存」是明确的动作，得有个回应
      toast("编号 " + code + " 已经有了，换一个", true);
      return Promise.resolve();
    }
    var payload = {
      code: code,
      name: $("nName").value.trim(),
      category: $("nCategory").value.trim(),
      series: $("nSeries").value.trim(),
      grade: num($("nGrade").value),
      costPrice: num($("nCost").value),
      salePrice: $("nSale").value.trim() === "" ? 0 : num($("nSale").value),
      initialStock: num($("nStock").value),
      purchaseLink: "",
      remark: "",
    };
    return invoke("addProduct", payload).then(function (j) {
      // 成功的判据：handler 会 post 一条 toast「✅已新建 …」，失败只写日志
      var ok = (j.posts || []).some(function (m) {
        return m && m.type === "toast" && String(m.text || "").indexOf("已新建") >= 0;
      });
      if (!ok) {
        // 后端拒绝时只写日志（编号格式、名称为空、售价非法都在这里），挑第一条 ❌ 说给用户听
        var why = ((j && j.logs) || []).filter(function (t) {
          return String(t).indexOf("❌") >= 0;
        })[0];
        toast(why ? String(why).replace(/^❌/, "") : "没建成，看看日志里的原因", true);
        return;
      }
      var files = pendingNewShots.map(function (s) {
        return s.file;
      });
      revokeShots(pendingNewShots); // 预览用的 objectURL 到此为止，别一直占着内存
      pendingNewShots = [];
      $("nCode").value = "";
      $("nName").value = "";
      $("nCost").value = "";
      $("nSale").value = "";
      $("nStock").value = "0";
      checkNewCode(); // 清掉编号框下面那行红字
      renderNewShots();
      state.imgStatsLoaded = false; // 新商品还没图，之前统计的不算数
      toast("已新建 " + code);
      show("screen-list");
      // 先让表里真的有这条，否则紧接着建下一个时「编号已存在」查不到它
      return invoke("loadAll").then(function () {
        if (files.length) {
          sendImages(code, files); // 新建完顺手把选好的照片传上去
        }
      });
    });
  }

  // ---------- 上传（手机拍照 / 相册） ----------
  /** 详情页用：传当前这个商品 */
  function uploadFiles(files) {
    var d = state.detail;
    if (!d) {
      return;
    }
    sendImages(d.code, files);
  }

  /** 真正的上传：按编号传（新建页也是这一条路，只是编号是刚建出来的） */
  function sendImages(code, files) {
    if (!code || !files || !files.length) {
      return;
    }
    var items = [];
    var reads = Array.prototype.map.call(files, function (f) {
      return new Promise(function (resolve) {
        var fr = new FileReader();
        fr.onload = function () {
          items.push({ name: f.name || "photo.jpg", data: String(fr.result || "") });
          resolve();
        };
        fr.onerror = function () {
          resolve();
        };
        fr.readAsDataURL(f);
      });
    });
    Promise.all(reads).then(function () {
      if (!items.length) {
        pushLog("⚠️没读到图片数据");
        toast("没读到图片数据", true);
        return;
      }
      pushLog("⏳上传 " + items.length + " 张…");
      toast("上传 " + items.length + " 张…");
      invoke("receiveImageData", { code: code, items: items })
        .then(function () {
          // 传完图片可能换了封面：换 URL 版本号再重读，否则浏览器拿缓存里的旧封面顶着
          bumpImg();
          toast("已上传 " + items.length + " 张");
          state.imgStatsLoaded = false; // 这个编号现在有图了，之前统计的作废
          if (state.detail && state.detail.code === code) {
            $("dCover").innerHTML = '<img src="' + imgUrl(code, "", "full") + '" alt="" />';
            loadImages(code);
          }
          return invoke("loadAll");
        })
        .catch(function () {
          toast("上传失败，请再试一次", true);
        });
    });
  }

  // ---------- 屏幕切换 ----------
  function show(id) {
    ["screen-list", "screen-detail", "screen-new", "screen-settings"].forEach(function (s) {
      $(s).classList.toggle("show", s === id);
    });
    if (id === "screen-list") {
      state.detail = null;
    }
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $("viewGallery").onclick = function () {
      state.view = "gallery";
      $("viewGallery").classList.add("on");
      $("viewList").classList.remove("on");
      applyZoom(); // 画册固定最小档
      renderList();
    };
    $("viewList").onclick = function () {
      state.view = "list";
      $("viewList").classList.add("on");
      $("viewGallery").classList.remove("on");
      applyZoom(); // 回到表格恢复上次的档位
      renderList();
    };
    var reload = function () {
      pushLog("⏳重新读取…");
      invoke("loadAll");
    };
    $("btnReload2").onclick = reload;
    // 筛选不再另起一屏：就在列表页里展开，改的时候下面那张表一直看得见
    $("btnFilter").onclick = function () {
      state.panelOpen = !state.panelOpen;
      $("filterPanel").classList.toggle("show", state.panelOpen);
      $("btnFilter").classList.toggle("on", state.panelOpen);
      if (state.panelOpen) {
        renderFilter();
        requestImgStats(); // 一打开就把「无图 N / 有图 M」数出来，省得用户自己猜
      }
    };
    $("btnSettings").onclick = function () {
      renderSettings();
      show("screen-settings");
    };
    $("btnSetBack").onclick = function () {
      show("screen-list");
    };
    $("zoomOut").onclick = function () {
      stepZoom(-1);
    };
    $("zoomIn").onclick = function () {
      stepZoom(1);
    };
    $("zoomReset").onclick = function () {
      setZoom(1);
    };
    // 双指捏合在这里一律**拦下来自己处理**：浏览器默认的是整页缩放，会把顶栏/搜索/筛选/
    // 分页条一起缩小（那不是要的效果）。但只有表格视图真的改 --zoom；画册里拦了却不做任何
    // 事 —— 用户明确不要画册缩放，那就让双指在画册里彻底没反应，而不是交给浏览器整页放大。
    // 详情页是另一个 <section>，根本不在这个容器里，所以它保留浏览器自己的双指缩放。
    var pinch = null;
    function pinchDist(t) {
      var dx = t[0].clientX - t[1].clientX;
      var dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy) || 1;
    }
    var contentEl = $("content");
    // 保底：万一页面已经被放大了（iOS 会自动放大聚焦的输入框、或者用户在别处捏过），
    // 就放行系统手势让他捏回来 —— 否则「只缩内容区」的拦截会把人困在放大状态里出不来。
    function pageZoomed() {
      return !!(window.visualViewport && window.visualViewport.scale > 1.01);
    }
    contentEl.addEventListener(
      "touchstart",
      function (e) {
        if (e.touches.length === 2) {
          pinch = { d: pinchDist(e.touches), z: zoom };
        }
      },
      { passive: true }
    );
    contentEl.addEventListener(
      "touchmove",
      function (e) {
        if (e.touches.length !== 2 || !pinch || pageZoomed()) {
          return;
        }
        e.preventDefault(); // 单指滚动不受影响（只有两指才拦）
        if (!zoomActive()) {
          return; // 画册：拦下来就行，不改任何东西
        }
        var z = snapZoom(pinch.z * (pinchDist(e.touches) / pinch.d));
        if (z !== zoom) {
          setZoom(z);
        }
      },
      { passive: false }
    );
    contentEl.addEventListener("touchend", function (e) {
      if (e.touches.length < 2) {
        pinch = null;
      }
    });
    // iOS Safari 的双指缩放走的是 gesture 事件（不听 touchmove 的 preventDefault、也不听
    // touch-action），只能靠这里拦。挂在 document 上：详情页、新建页、设置页、大图都不给捏，
    // 全站一致 —— 只有表格用自己的缩放（且是改 --zoom，不是整页放大）。
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (n) {
      document.addEventListener(
        n,
        function (e) {
          if (!pageZoomed()) {
            e.preventDefault();
          }
        },
        { passive: false }
      );
    });
    // 双击放大是另一条路：touch-action 的 pan-* 只管捏合，管不住「连点两下」。
    // 判据是「320ms 内 + 落点几乎没动」，所以快速连点两个不同按钮不受影响；
    // 输入框里不拦 —— 那里双击是选词，是本该保留的手势。
    var lastTap = { t: 0, x: 0, y: 0 };
    document.addEventListener(
      "touchend",
      function (e) {
        var t = e.changedTouches && e.changedTouches[0];
        if (!t) {
          return;
        }
        var el = e.target;
        var tag = el && el.tagName ? String(el.tagName) : "";
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (el && el.isContentEditable)) {
          return;
        }
        var now = Date.now();
        var near = Math.abs(t.clientX - lastTap.x) < 30 && Math.abs(t.clientY - lastTap.y) < 30;
        if (now - lastTap.t < 320 && near) {
          e.preventDefault();
        }
        lastTap = { t: now, x: t.clientX, y: t.clientY };
      },
      { passive: false }
    );
    // ---- 改一个值的 sheet ----
    $("fsSave").onclick = function () {
      commitEdit(true);
    };
    $("fsCancel").onclick = function () {
      commitEdit(false);
    };
    $("fsDetail").onclick = function () {
      var id = editing ? editing.id : 0;
      commitEdit(false); // 顺手结算（值没变等于没改，不会写库）
      if (id) {
        openDetail(id);
      }
    };
    // 输入框是每次重建的，事件走 sheet 这一层的委托
    $("fieldSheet").addEventListener("keydown", function (e) {
      if (!e.target || e.target.id !== "fsInput") {
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commitEdit(false);
      }
    });
    // 等级是下拉，选完就定（没有回车可敲）
    $("fieldSheet").addEventListener("change", function (e) {
      if (e.target && e.target.id === "fsInput" && e.target.tagName === "SELECT") {
        commitEdit(true);
      }
    });
    // iOS 上键盘弹出时 fixed 元素不会被顶起来，底部 sheet 会被键盘整个压住 ——
    // 用 visualViewport 量出键盘占了多少，从 sheet 下面垫上去（Android 会自己 resize，量出来是 0）
    if (window.visualViewport) {
      var vv = window.visualViewport;
      var liftSheet = function () {
        var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        $("fieldSheet").style.setProperty("--kb", kb + "px");
      };
      vv.addEventListener("resize", liftSheet);
      vv.addEventListener("scroll", liftSheet);
    }
    // 点 sheet 外面那层半透明区 = 放弃（宁可没改成，也别把没看清的数写进去）
    $("fieldSheet").onclick = function (e) {
      if (e.target === $("fieldSheet")) {
        commitEdit(false);
      }
    };
    $("sortBy").onchange = function () {
      state.sort = $("sortBy").value;
      state.page = 0;
      renderList();
    };
    $("activeBar").onclick = function (e) {
      var pill = e.target.closest(".pill");
      if (!pill || !pill.dataset.clr) {
        return;
      }
      clearOne(pill.dataset.clr);
    };
    // 面板里的改动立刻生效（背后那张列表跟着变），「完成」只是返回
    $("filterBody").onclick = function (e) {
      var chip = e.target.closest(".chip");
      if (!chip) {
        return;
      }
      var field = chip.dataset.field;
      var set = state.filters.enum[field];
      var v = chip.dataset.v;
      if (set[v]) {
        delete set[v];
      } else {
        set[v] = 1;
        if (field === "img") {
          // 有图 / 无图 是互斥的，别让两个都亮着（那只会筛出空表）
          Object.keys(set).forEach(function (k) {
            if (k !== v) {
              delete set[k];
            }
          });
        }
      }
      chip.classList.toggle("on");
      if (field === "img") {
        // 互斥后另一个圆片要灭掉：整块重画最省事，也顺带刷新「无图 N」那个数字
        renderFilter();
      }
      var g = chip.closest(".fgroup");
      var t = g && g.querySelector(".ftitle");
      if (t) {
        var n = Object.keys(set).length;
        t.textContent = t.dataset.label + (n ? "（已选 " + n + "）" : "");
      }
      state.page = 0;
      renderList();
    };
    $("filterBody").oninput = function (e) {
      var el = e.target;
      if (el.id === "codeQ") {
        state.codeQ = el.value;
        state.page = 0;
        renderList();
        return;
      }
      if (el.dataset && el.dataset.num) {
        var f = el.dataset.num;
        var r = state.filters.num[f] || { min: "", max: "" };
        r[el.dataset.side] = el.value;
        state.filters.num[f] = r;
        state.page = 0;
        renderList();
      }
    };
    $("scope").onchange = function () {
      state.scope = $("scope").value;
      state.page = 0;
      renderList();
    };
    $("q").oninput = function () {
      state.q = $("q").value;
      state.page = 0; // 筛完条数变了，停在第 3 页没有意义
      renderList();
    };
    // 编号框在展开区里是动态生成的，事件走 filterBody 的委托，不能在这里直接绑
    $("pagePrev").onclick = function () {
      if (state.page > 0) {
        state.page--;
        renderList();
        $("content").scrollTop = 0;
      }
    };
    $("pageNext").onclick = function () {
      state.page++;
      renderList();
      $("content").scrollTop = 0;
    };
    $("pageFirst").onclick = function () {
      state.page = 0;
      renderList();
      $("content").scrollTop = 0;
    };
    $("pageLast").onclick = function () {
      state.page = 999999; // renderList 里会夹到最后一页
      renderList();
      $("content").scrollTop = 0;
    };
    $("pageJump").onchange = function () {
      state.page = num($("pageJump").value);
      renderList();
      $("content").scrollTop = 0;
    };
    $("content").onclick = function (e) {
      // 行不能写死成 tr：画册是 div[data-id]，写死了画册点卡片就不进详情了
      var hitRow = e.target.closest("[data-id]");
      var hitCell = e.target.closest("td[data-ed]");
      // 保存后整行会被重画，e.target 上的引用就成了孤儿节点 —— 一律按 id 重新取
      var row = hitRow ? $("content").querySelector('[data-id="' + hitRow.dataset.id + '"]') : null;
      var cell = row && hitCell ? row.querySelector('td[data-ed="' + hitCell.dataset.ed + '"]') : null;
      if (cell && row) {
        // 状态例外：它是二选一，没有输入框也不会顶出键盘，误触了再点一下就换回来，
        // 为它多加一拍不划算
        if (cell.dataset.ed === "status") {
          var sp = findProduct(num(row.dataset.id));
          if (sp) {
            toggleStatus(sp, row);
          }
          return;
        }
        var id = num(row.dataset.id);
        var field = cell.dataset.ed;
        // 同一格点第二下 = 确认要改 → 弹输入框；点别处只是换选中
        if (selected && num(selected.id) === id && selected.field === field) {
          openFieldSheet(row, cell);
          return;
        }
        clearSelected();
        selected = { id: id, field: field };
        cell.classList.add("sel");
        pushLog("已选中 " + (FIELD_LABEL[field] || field) + "，再点一下就能改");
        return;
      }
      // 点到表格里的空白（不在任何一格上）：取消选中
      clearSelected();
      // 只有带 data-open 的才进详情：表格里是编号列，画册里是整张卡片
      if (row && e.target.closest("[data-open]")) {
        openDetail(num(row.dataset.id));
      }
    };
    // 双击进详情已经去掉了：改成「点两下改一个值」之后它就彻底冲突（第二下是弹输入框）。
    // 进详情现在只有三个明确入口：点编号、sheet 里的「详情 ›」、画册点卡片。
    $("btnBack").onclick = function () {
      flushDetailEdits(); // 焦点那格还没结算就返回的话，改动会丢
      show("screen-list");
    };
    $("btnPrevItem").onclick = function () {
      flushDetailEdits();
      if (state.detail) {
        openDetailAt(state.detail.idx - 1);
      }
    };
    $("btnNextItem").onclick = function () {
      flushDetailEdits();
      if (state.detail) {
        openDetailAt(state.detail.idx + 1);
      }
    };
    $("btnNew").onclick = function () {
      if (!$("nGrade").options.length) {
        fillGradeSelect();
      }
      show("screen-new");
    };
    $("btnNewBack").onclick = function () {
      show("screen-list");
    };
    $("btnCreate").onclick = function () {
      createProduct().catch(function () {
        /* 日志里已经有原因 */
      });
    };
    $("nGrade").onchange = updateRuleHint;
    // 失焦即存：change 事件在「值变了且离开这一格」时才触发，正好是想要的时机
    DETAIL_FIELDS.forEach(function (f) {
      $(f[0]).onchange = function () {
        commitDetailField(f);
      };
    });
    $("fStatus").onclick = function () {
      var d = state.detail;
      if (!d) {
        return;
      }
      var next = d.status === 1 ? 0 : 1;
      var before = d.status;
      d.status = next;
      syncStatusBtn();
      // 与列表保持一致：点一下立刻生效，不用等「保存修改」
      invoke("setStatus", { id: d.id, status: next }).catch(function () {
        d.status = before;
        syncStatusBtn();
        pushLog("❌改上下架失败，已退回");
      });
    };
    $("dImages").onclick = function (e) {
      var x = e.target.closest(".thumb-x");
      if (x) {
        deleteThumb(x.dataset.del);
        return;
      }
      var img = e.target.closest("img[data-name]");
      if (img && state.detail) {
        openViewer(state.detail.code, img.dataset.name);
      }
    };
    $("dCover").onclick = function () {
      if (state.detail) {
        openViewer(state.detail.code, "");
      }
    };
    $("viewerClose").onclick = function () {
      $("viewer").classList.remove("show");
      $("viewerImg").src = "";
      $("viewerRetake").style.display = "none";
      viewerImg = null;
    };
    $("viewerDel").onclick = deleteViewerImage;
    $("viewerRetake").onclick = retakeShot;
    $("btnUpload").onclick = function () {
      $("filePick").click();
    };
    $("filePick").onchange = function () {
      uploadFiles($("filePick").files);
      $("filePick").value = ""; // 同一个文件连传两次也要能触发 change
    };
    // 日志改成显式按钮：状态条整条可点的话，手指碰到底部就弹出一大片日志，很烦
    $("btnLog").onclick = function () {
      renderLogs();
      $("logPanel").classList.add("show");
    };
    $("logClose").onclick = function () {
      $("logPanel").classList.remove("show");
    };
    // ---- 新建页 ----
    $("nCode").oninput = checkNewCode;
    $("nCode").onblur = checkNewCode;
    $("btnNextCode").onclick = function () {
      nextFreeCode();
      checkNewCode();
    };
    $("btnNewPick").onclick = function () {
      $("newFilePick").click();
    };
    $("newFilePick").onchange = function () {
      var n = addNewShots($("newFilePick").files);
      $("newFilePick").value = ""; // 不清的话再选同一张照片不会触发 change
      if (n) {
        toast("加了 " + n + " 张，保存后上传");
      }
    };
    // 小图那一排：点图看大效果，✕ 删掉
    $("newShots").onclick = function (e) {
      var rm = e.target.closest("[data-rm]");
      if (rm) {
        removeNewShot(num(rm.dataset.rm));
        return;
      }
      var img = e.target.closest("[data-shot]");
      if (img) {
        openLocalViewer(num(img.dataset.shot));
      }
    };
    renderNewShots();
  }

  // 记住上次的大小：手机上表格字号是要反复调的东西，每次进来都回到 100% 很烦
  try {
    var z0 = Number(localStorage.getItem(ZOOM_KEY));
    if (z0) {
      setZoom(snapZoom(z0)); // 存的可能是旧档位值，吸附一下
    }
  } catch (e) {
    /* 读不到就用默认 1 */
  }
  applyZoom(); // 无论有没有存过：按当前视图决定这三个按钮在不在
  bind();
  pushLog("⏳读取商品…");
  invoke("loadAll").catch(function () {
    $("content").innerHTML =
      '<p class="muted">读不到商品。检查：服务是否在跑、地址里的 token 对不对、服务端有没有配 --image-dir。</p>';
  });
})();
