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

  /**
   * 这个**页面**的身份：每次打开页面现算一个随机串，不落盘。
   *
   * 干什么用：实时推送是"广播给所有连着的页面"的，而我自己那次操作的结果已经随
   * `/api/invoke` 的响应回来了 —— 服务端按这个身份把我自己发的事件跳过，避免同一件事
   * 被应用两遍（比如刚改完的售价又被广播回来覆盖一次正在编辑的格子）。
   *
   * 为什么**故意不存 localStorage**（早先存过，是个坑）：存了就是"一台设备一个身份"，
   * 于是同一个浏览器开两个标签页 = 两个连接同一个身份 → 我自己发的广播把**另一个标签页
   * 也跳过了**，看起来就是"另一个窗口不跟着变"（而那正是要测的跨端同步）。
   * 每次打开算新的才是对的：身份只需要在**这一个页面的生命周期**里稳定，
   * 不该跨页面、更不该跨标签页。顺带也不用管隐私模式写不了 storage 这件事。
   */
  var clientId = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /** 一条消息 = 一次 POST；回包里的 posts 按序喂给 handlePost，logs 进底部状态条 */
  function invoke(type, payload) {
    var msg = Object.assign({ type: type }, payload || {});
    return fetch("/api/invoke", {
      method: "POST",
      headers: Object.assign(
        {
          "Content-Type": "application/json",
          "x-cherysis-client": clientId,
        },
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

  // ---------- 实时推送（SSE，设计稿 §4.2） ----------
  // 为什么要有它：`/api/invoke` 是"一问一答"。别人（或电脑版）改了数据、或者服务端那边
  // 有个要跑几分钟的后台任务在报进度，这些事都不会出现在**我这次请求**的响应里。
  //
  // 这里只做"接线"，一行业务判断都不加：
  //   post   → 直接喂给**已有的** handlePost（和响应里那些 posts 走同一条路，所以零改动）
  //   log    → 进日志区（排查时才看）
  //   changed→ 别人改过数据了：冒一个「🔄 有改动」按钮，不自动刷新（正在填表时被冲掉更糟）
  //   reset  → 断线太久、中间那段补不齐了：整表重读一次，免得拿着一份缺一段的数据继续用
  //
  // 断线重连**不用自己写**：EventSource 自带重试，而且重连时会带 Last-Event-ID，
  // 服务端按环形缓冲把断点之后的事件补发过来。所以这里只负责把状态显示出来。
  var es = null;
  var stale = false; // 「别人改过」角标：亮着就一直亮，直到用户自己重读一遍

  /** 底部那盏灯：on=连着、""=重连中、down=断了 */
  function setConn(kind) {
    var el = $("conn");
    if (!el) {
      return;
    }
    el.className = "conn" + (kind ? " " + kind : "");
    var t = $("connText");
    if (t) {
      t.textContent = kind === "on" ? "已连接" : kind === "down" ? "已断开" : "重连中…";
    }
  }

  /** 有改动：只亮按钮，不动数据（用户正在填的那一格不能被别人的广播冲掉） */
  function markStale() {
    if (stale) {
      return;
    }
    stale = true;
    var b = $("btnStale");
    if (b) {
      b.style.display = "";
    }
  }

  /** 用户点了「🔄 有改动」（或自己点了别处的重读）→ 角标收起来 */
  function clearStale() {
    stale = false;
    var b = $("btnStale");
    if (b) {
      b.style.display = "none";
    }
  }

  function connectEvents() {
    if (typeof EventSource === "undefined") {
      // 老浏览器：退回"手动刷新"那套，功能不少，只是别人改了不会提示
      setConn("");
      pushLog("ℹ️这个浏览器不支持实时推送：别人改了数据，点「🔄 重新从数据库读一遍」");
      return;
    }
    var url =
      "/api/events?client=" +
      encodeURIComponent(clientId) +
      (token ? "&token=" + encodeURIComponent(token) : "");
    es = new EventSource(url);
    es.addEventListener("open", function () {
      setConn("on");
    });
    es.addEventListener("error", function () {
      // 断线（EventSource 自己会重连）；它彻底放弃时 readyState 是 CLOSED，
      // 那种情况基本只有两种：服务停了、token 不对。
      var dead = es && es.readyState === 2;
      setConn(dead ? "down" : "");
      if (dead) {
        pushLog(
          "❌实时推送连不上了（服务停了？地址里的 token 不对？）。别人改了数据不会自动提示，" +
            "点「🔄 重新从数据库读一遍」手动拿最新。",
        );
      }
    });
    es.addEventListener("post", function (e) {
      var m = null;
      try {
        m = JSON.parse(e.data);
      } catch (err) {
        return; // 半截 JSON：丢掉这一条，不值得把页面弄崩
      }
      handlePost(m);
    });
    es.addEventListener("log", function (e) {
      pushLog(e.data);
    });
    es.addEventListener("changed", function () {
      markStale();
    });
    // 重活排队（生成共享缩略图 / 九宫格）：手机端目前还没有触发这些活儿的入口，
    // 所以先只把它写进日志 —— 将来在手机上开出图按钮时，直接用这个事件显示
    // 「正在生成 X / 前面还有 N 个」，不用再改服务端。
    es.addEventListener("queue", function (e) {
      var s = null;
      try {
        s = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (s && s.running) {
        pushLog(
          "⏳正在" + s.running + (s.waiting && s.waiting.length ? "（后面还排着 " + s.waiting.length + " 个）" : ""),
        );
      }
    });
    es.addEventListener("reset", function () {
      pushLog("ℹ️断线太久，中间的变化补不齐了，重新整表读一遍");
      invoke("loadAll");
    });
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
      // 手里已经是全表最新的一份了，「有改动」角标就该收起来。
      // 不管是"我自己点的重读"还是"别人重读时广播给我的" —— 两种情况数据都新了。
      clearStale();
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
    // 等级也放进来：后端改等级会按新规则重算售价（product.ts 的 grade 分支），
    // 与列表里改等级同一口径。选项是下拉，所以 syncDetailFromDelta 里单独处理
    ["fGrade", "grade", "int"],
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
      if (f[1] === "grade") {
        // 等级是下拉：得先把选项补齐（这个商品可能挂着一个"规则已经没了"的等级，
        // 不补的话 select.value 会设不进去、显示成空白，用户一碰就把等级改掉了）
        fillDetailGradeSelect(num(up.grade), num(up.price_manual));
        d.orig.grade = num(up.price_manual) === 1 ? 0 : num(up.grade);
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
    // productsDelta → renderList，不还原的话改完一行列表直接跳回顶部（很像是「界面不稳定」）。
    // 表格有两个滚动容器：#content（纵向）和 .tblwrap（纵向+横向，为了表头能吸顶），
    // 所以三个位置都要记：少记一个，改完一个值就往回跳一下。
    var content = $("content");
    var keepScroll = content.scrollTop;
    var oldWrap = content.querySelector(".tblwrap");
    var keepWrapTop = oldWrap ? oldWrap.scrollTop : 0;
    var keepWrapLeft = oldWrap ? oldWrap.scrollLeft : 0;
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
    content.scrollTop = keepScroll;
    // 表格自己那份滚动位置：改完一个值整表重画，横着滑到「状态」列的人不能被拽回左边
    var newWrap = content.querySelector(".tblwrap");
    if (newWrap) {
      newWrap.scrollTop = keepWrapTop;
      newWrap.scrollLeft = keepWrapLeft;
    }
  }

  /**
   * 表格一行。可编辑的格子带 data-ed：名称 / 进价 / 售价 / 库存 / 状态 / 等级。
   * 名称是文本（不走数字那条路），进价售价等是数字 —— 两类都在这一个属性下，靠 TEXT_FIELDS 区分。
   * 编号列不参与改值：它是「进详情」的入口。
   *
   * 悬浮提示写**这一格的内容**（不是字段名）：名称那一列窄，长名字会被省略号截掉，
   * 鼠标停一下能看到全称才是真有用的；数字列的内容本来就在眼前，重复一遍也无害。
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

  /** 等级这一格显示什么：**与下拉和电脑版同一口径** ——
   * price_manual=1 就是「自定义」（售价手动定），不显示那个数字。
   * 以前这里只看 grade，于是"自定义"的商品在手机列表上显示成一个数字、双击后下拉里却写着「自定义」，
   * 两边对不上，人就以为改不动（这是 user 报的第 2 条）。
   */
  function gradeText(p) {
    if (num(p.price_manual) === 1) {
      return "自定义";
    }
    return num(p.grade) > 0 ? String(num(p.grade)) : "自定义";
  }

  /** 等级这一格的"当前值"（数值形态）：自定义就是 0，与 gradeText 说的是同一件事 */
  function gradeCur(p) {
    return num(p.price_manual) === 1 ? 0 : num(p.grade);
  }

  function rowHtml(p) {
    var off = p.status === 1;
    return (
      '<tr data-id="' +
      p.id +
      '"' +
      (off ? ' class="off"' : "") +
      ">" +
      '<td class="open" data-open="1" title="' + esc(p.code) + '">' +
      esc(p.code) +
      "</td>" +
      '<td class="nm ed' + selClass(p, "name") + '" data-ed="name" title="' + esc(p.name || "") + '">' +
      esc(p.name) +
      "</td>" +
      '<td class="num ed' +
      selClass(p, "cost_price") +
      '" data-ed="cost_price" title="' +
      esc(money(p.cost_price)) +
      '">' +
      money(p.cost_price) +
      "</td>" +
      '<td class="num ed' +
      selClass(p, "sale_price") +
      '" data-ed="sale_price" title="' +
      esc(money(p.sale_price)) +
      '">' +
      money(p.sale_price) +
      "</td>" +
      // 等级可改：后端改等级会按新规则重算售价（product.ts 的 grade 分支），所以这里改了就生效
      '<td class="num ed' +
      selClass(p, "grade") +
      '" data-ed="grade" title="' +
      esc(gradeText(p)) +
      '">' +
      esc(gradeText(p)) +
      "</td>" +
      '<td class="num ed' +
      (isLow(p) ? " low" : "") +
      selClass(p, "stock") +
      '" data-ed="stock" title="库存 ' +
      num(p.stockTotal) +
      '">' +
      num(p.stockTotal) +
      "</td>" +
      '<td class="ed' +
      (off ? " low" : "") +
      '" data-ed="status" title="' +
      (off ? "已下架" : "在售") +
      '">' +
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
    // 等级的"当前值"要看 price_manual：自定义（手动定价）就是 0 —— 与下拉里选中的那一项、
    // 与格子上显示的字保持完全一致（三处对不上时，用户选了"看着一样"的项会被判成"没改"，
    // 表现就是"动不了"）
    var cur = isTxt
      ? String(p[field] === undefined || p[field] === null ? "" : p[field])
      : field === "stock"
        ? num(p.stockTotal)
        : field === "grade"
          ? gradeCur(p)
          : num(p[field]);
    editing = { row: row, field: field, id: p.id, orig: cur, txt: isTxt };
    $("fsTitle").textContent = (FIELD_LABEL[field] || field) + "　" + p.code + "　" + (p.name || "");
    $("fsBody").innerHTML =
      field === "grade"
        ? // 等级：**不用原生 <select>**，改成一列可点的选项。
          // 踩过两次的坑：手机上进编辑弹的是底部 sheet，原生下拉被我们 focus 过之后
          // 会出现"点了没反应"（Android 上 focus 一个 select 会立刻弹选择器，和刚结束的
          // 触摸序列打架；focus 也可能在触摸结束时被收回，于是它就一直不响应）。
          // 一列 48px 高的按钮没有这个问题，手机上还比原生选择器好点得多。
          // 仍然留一个隐藏的 #fsInput 存当前值 —— commitEdit 那条路一个字都不用改。
          '<div class="opts">' +
          gradeOptionButtons(cur, p) +
          '</div><input id="fsInput" type="hidden" value="' +
          esc(String(cur)) +
          '" />'
        : '<input id="fsInput" class="big" type="text"' +
          // 名称不该弹数字键盘；数字列要小数键盘（inputmode 在手机上决定了键盘长什么样）
          (isTxt ? "" : ' inputmode="decimal"') +
          ' value="' +
          esc(String(cur)) +
          '" />';
    $("fsHint").textContent = FIELD_HINT[field] || "";
    $("fieldSheet").classList.add("show");
    // 等级那条路没有输入框可聚焦（也不该聚焦：手机上一聚焦就可能弹键盘/选择器）
    if (field !== "grade") {
      var input = $("fsInput");
      // 必须在这一个 click 里同步 focus：放到下一拍 iOS 就不弹键盘了
      input.focus();
      input.select();
    }
  }

  function closeFieldSheet() {
    editing = null;
    $("fieldSheet").classList.remove("show");
    $("fsBody").innerHTML = "";
  }

  /**
   * 等级的可点选项（一列按钮）。当前那一项给 .on 高亮。
   * 口径与下拉时代一致：「自定义」看 price_manual；商品挂着一个"规则已经没了"的等级时
   * 也把它列出来（不列的话用户会以为等级丢了、或者一改就换成别的）。
   */
  function gradeOptionButtons(cur, p) {
    var manual = num(p.price_manual) === 1;
    var now = manual ? 0 : num(cur);
    var items = [{ v: 0, label: "自定义（售价手动定）" }];
    if (num(cur) > 0 && !manual) {
      var known = false;
      for (var i = 0; i < state.rules.length; i++) {
        if (num(state.rules[i].grade) === num(cur)) {
          known = true;
        }
      }
      if (!known) {
        items.push({ v: num(cur), label: "等级 " + num(cur) + "（没有规则，售价不会被自动算）" });
      }
    }
    state.rules.forEach(function (r) {
      items.push({ v: num(r.grade), label: gradeLabel(num(r.grade)) });
    });
    return items
      .map(function (it) {
        return (
          '<button type="button" class="opt' +
          (num(it.v) === now ? " on" : "") +
          '" data-v="' +
          it.v +
          '">' +
          esc(it.label) +
          "</button>"
        );
      })
      .join("");
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
      // 「没改」也要说一声：等级那种下拉最容易撞上（格子上写着"自定义"、下拉里也选着"自定义"，
      // 再点一次它真的就是没改）—— 一声不响地关掉，人只会以为"这东西坏了/动不了"
      if (submit && !ed.txt) {
        pushLog("ℹ️" + (FIELD_LABEL[ed.field] || ed.field) + "没变，没有提交");
      }
      refreshRow(ed.id);
      return;
    }
    var isStock = ed.field === "stock";
    var before = isStock ? num(p.stockTotal) : num(p[ed.field]);
    var beforeManual = num(p.price_manual); // 等级那一格的回滚要连 price_manual 一起还原
    // 乐观更新：先让格子显示新值，请求失败再回滚（列表里改一个数还要等网络会显得很卡）
    applyLocal(p, ed.field, v);
    refreshRow(ed.id);
    // 刻意不 reload：改的就是这一个字段，本地值已经是权威值；整表重绘会让列表闪一下、
    // 滚动位置也可能丢 —— 就地改的意义就是「不跳、不闪」。失败时回滚（下面 catch）
    var msg = isStock ? "setStockQty" : "updateProductField";
    var payload = isStock ? { id: p.id, qty: v } : { id: p.id, field: ed.field, value: v };
    invoke(msg, payload)
      .then(function (j) {
        // 业务层的失败（handler 里 log 一句 ❌ 就 return 了）走的是 ok:false —— 请求本身是 200，
        // 所以不会进 catch。这里必须自己当失败处理，否则表现就是"格子闪一下又变回去，
        // 什么提示都没有"（user 报的"动不了"有一半是这个）
        if (j && j.ok === false) {
          throw new Error(j.error || "写入失败");
        }
        // 改进价 / 改等级：后端会把售价按规则重算（product.ts），本地只改了一个字段，
        // 不回读的话这一行会显示旧的售价，看着像没改成功
        if (ed.field === "cost_price" || ed.field === "grade") {
          return invoke("loadAll");
        }
      })
      .catch(function (err) {
        applyLocal(p, ed.field, before);
        if (ed.field === "grade") {
          p.price_manual = beforeManual;
        }
        refreshRow(p.id);
        var why = err && err.message ? err.message : "网络或服务端出错";
        pushLog("❌改" + (FIELD_LABEL[ed.field] || ed.field) + "失败：" + why);
        toast("没改成：" + why, true);
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
      return;
    }
    p[field] = v;
    // 改等级时后端会**同时**改 price_manual（product.ts 的 grade 分支：选具体等级就归 0、
    // 选自定义就置 1）。本地不跟着改的话，格子上那个"自定义/数字"要等 loadAll 回来才对
    if (field === "grade") {
      p.price_manual = num(v) === 0 ? 1 : 0;
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
    // 面板收起时也要知道「现在筛着几条」，所以计数挂在按钮上。
    // 按钮里现在是"漏斗图标 + 一个空 span"：有条数就显示条数（当徽标用），没有就纯图标 ——
    // 这样它和旁边的 ⚙ 一样大（用户要的），有筛选时又能一眼看出来
    $("btnFilterText").textContent = pills.length ? String(pills.length) : "";
    $("btnFilter").classList.toggle("has", pills.length > 0);
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

  /**
   * 详情页的等级下拉。与新建页同源（选项都来自 state.rules），但有三处不一样：
   *  ① 选中这个商品**当前**的等级；
   *  ② `price_manual=1`（售价手动定）时选中的是「自定义」—— 与列表那一格、与电脑版同一口径，
   *     否则格子上写着"自定义"、下拉里却选着"等级 1"，人就会以为改不动；
   *  ③ 商品挂着一个"规则已经没了"的等级时临时补一个选项 —— 否则 select 显示空白，
   *     用户随手一存就把等级改成了别的东西。
   */
  function fillDetailGradeSelect(cur, manual) {
    var sel = $("fGrade");
    if (!sel) {
      return;
    }
    var g = num(manual) === 1 ? 0 : num(cur);
    var has = false;
    var opts = state.rules
      .map(function (r) {
        if (num(r.grade) === g) {
          has = true;
        }
        return (
          '<option value="' +
          r.grade +
          '">' +
          esc((r.label ? r.label + "（等级 " + r.grade + "）" : "等级 " + r.grade) + "：" + r.expr) +
          "</option>"
        );
      })
      .join("");
    if (g > 0 && !has) {
      opts = '<option value="' + g + '">等级 ' + g + "（没有规则，售价不会被自动算）</option>" + opts;
    }
    sel.innerHTML = opts + '<option value="0">自定义（售价手动定）</option>';
    sel.value = String(g);
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
      imgs: [], // 这个商品的图片文件名（loadImages 填），灯箱左右切换要用
      orig: {
        name: p.name || "",
        cost_price: num(p.cost_price),
        sale_price: num(p.sale_price),
        // 等级按"显示出来的那个值"记：售价手动定就是 0（自定义），与下拉里选中的一致
        grade: gradeCur(p),
        stockTotal: num(p.stockTotal),
        category: p.category || "",
        series: p.series || "",
      },
    };
    $("dTitle").textContent = p.code + " " + (p.name || "");
    $("fName").value = p.name || "";
    $("fCost").value = num(p.cost_price);
    $("fSale").value = num(p.sale_price);
    fillDetailGradeSelect(p.grade, p.price_manual);
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
        // 灯箱左右切换要用这份清单（打开某张图时按它算"上一张/下一张"）
        if (state.detail && state.detail.code === code) {
          state.detail.imgs = names;
        }
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
    // name 为空 = 看封面（夹里第一张）。切到具体某张时用文件名，删图才不会删错
    var names = (state.detail && state.detail.code === code && state.detail.imgs) || [];
    var idx = name ? names.indexOf(name) : 0;
    if (idx < 0) {
      idx = 0;
    }
    showViewerImage({ code: code, names: names, idx: idx, cover: !name });
  }

  /**
   * 灯箱里显示第 idx 张。多张时给左右箭头（手机上滑来滑去容易误触，按钮更明确）；
   * 只有一张就藏起来 —— 摆两个按不动的箭头比没有更让人困惑。
   * 桌面浏览器上还能用 ← → 翻、Esc 关（见 bind 里的 keydown）。
   */
  function showViewerImage(v) {
    viewerImg = v;
    var total = v.names.length;
    var name = total ? v.names[v.idx] : "";
    $("viewerImg").src = imgUrl(v.code, name, "full");
    // 封面那一张（打开时 name 为空）不给删：与原来的口径一致 —— 从封面进来的删除入口在缩略图上
    var deletable = !!name && !(v.cover && v.idx === 0);
    $("viewerDel").style.display = deletable ? "" : "none";
    $("viewerRetake").style.display = "none"; // 已上传的图没有「重拍」一说
    var multi = total > 1;
    $("viewerPrev").style.display = multi ? "" : "none";
    $("viewerNext").style.display = multi ? "" : "none";
    $("viewerPos").textContent = multi ? v.idx + 1 + " / " + total : "";
    $("viewer").classList.add("show");
  }

  /** 灯箱左右翻：到头就绕回去（九张图来回看时不用退出来重点） */
  function stepViewer(dir) {
    var v = viewerImg;
    if (!v || !v.names || v.names.length < 2) {
      return;
    }
    var n = v.names.length;
    var idx = ((v.idx + dir) % n + n) % n;
    showViewerImage({ code: v.code, names: v.names, idx: idx, cover: false });
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
    // 还没上传的照片：左右切换先不给（下面那排小图本来就能直接点），但把序号显示出来
    $("viewerPrev").style.display = "none";
    $("viewerNext").style.display = "none";
    $("viewerPos").textContent = i + 1 + " / " + pendingNewShots.length;
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

  var viewerImg = null; // 灯箱当前这张：{ code, names, idx, cover } 或 { local, shot }
  /** 灯箱里删当前这张：后端走 deleteImageFile（按文件名删，不按序号，避免删错） */
  function deleteViewerImage() {
    var v = viewerImg;
    var name = v && v.names ? v.names[v.idx] : "";
    if (!v || !name) {
      return;
    }
    if (!window.confirm("删除「" + name + "」这张图？删了就找不回来了。")) {
      return;
    }
    pushLog("⏳删除 " + name + "…");
    toast("删除中…");
    invoke("deleteImageFile", { code: v.code, name: name })
      .then(function (j) {
        if (imgDeleteFailed(j)) {
          pushLog("❌没删掉，图片还在（原因见上面一行）");
          toast("没删掉，图片还在（多半正被占用，稍等再试）", true);
          return;
        }
        toast("已删除 " + name);
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
    invoke(msg, payload)
      .then(function (j) {
        // 同列表那条路：业务层的失败是 ok:false（HTTP 还是 200），不当失败处理就会静默退回原值
        if (j && j.ok === false) {
          throw new Error(j.error || "写入失败");
        }
      })
      .catch(function (err) {
        d.orig[key] = cur;
        el.value = String(cur);
        var why = err && err.message ? err.message : "网络或服务端出错";
        pushLog("❌保存失败，已退回原值：" + why);
        toast("没改成：" + why, true);
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
  /**
   * 宽屏（≥820px）= 详情走右侧抽屉，列表留在左边；窄屏（手机）= 详情整屏。
   *
   * 判断用**宽度**，不判断"是不是电脑"：这件事说的是"有没有地方并排显示"。
   * 平板横屏、电脑上把窗口拉宽，都该享受抽屉；手机竖屏自然落到全屏那一支。
   * （别用 navigator.userAgent 猜设备：iPad 会把自己报成 Mac，最不可靠。）
   */
  function isWide() {
    return !!(window.matchMedia && window.matchMedia("(min-width: 820px)").matches);
  }

  function show(id) {
    // 宽屏看详情/新建时列表**不关**：面板从右边滑出来，左边那份列表还在
    // （挑下一件、边看边建都不用退出去）
    var keepList = (id === "screen-detail" || id === "screen-new") && isWide();
    ["screen-list", "screen-detail", "screen-new", "screen-settings"].forEach(function (s) {
      $(s).classList.toggle("show", s === id || (s === "screen-list" && keepList));
    });
    document.body.classList.toggle("drawer", keepList);
    if (id === "screen-list") {
      state.detail = null;
    }
  }

  /** 关掉右侧面板（详情 / 新建）：抽屉模式和整屏模式都走这一条 */
  function closePanel() {
    if ($("screen-detail").classList.contains("show")) {
      flushDetailEdits(); // 详情是"失焦即存"，关之前先把焦点那一格结算掉
    }
    show("screen-list");
  }

  // 窗口从宽变窄（或反过来）时，按当前宽度重新决定"抽屉 or 整屏"。
  // addEventListener 在旧 Safari 上没有，退回 addListener。
  (function watchWidth() {
    if (!window.matchMedia) {
      return;
    }
    var mq = window.matchMedia("(min-width: 820px)");
    var onChange = function () {
      // 哪个面板开着就按新宽度重排哪一个
      if (document.body.classList.contains("drawer") || state.detail) {
        show($("screen-new").classList.contains("show") ? "screen-new" : "screen-detail");
      }
    };
    if (mq.addEventListener) {
      mq.addEventListener("change", onChange);
    } else if (mq.addListener) {
      mq.addListener(onChange);
    }
  })();

  /** 开/收筛选面板。抽出来是因为现在有两个入口：顶栏那个按钮，和"点面板外面自动收起" */
  function setFilterOpen(open) {
    state.panelOpen = open;
    $("filterPanel").classList.toggle("show", open);
    $("btnFilter").classList.toggle("on", open);
    if (open) {
      renderFilter();
      requestImgStats(); // 一打开就把「无图 N / 有图 M」数出来，省得用户自己猜
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
    // 「有改动」那个角标本身就是个按钮：点它 = 重读一遍（角标在 productsLoaded 里收起来）
    $("btnStale").onclick = reload;
    // 筛选不再另起一屏：就在列表页里展开，改的时候下面那张表一直看得见
    $("btnFilter").onclick = function () {
      setFilterOpen(!state.panelOpen);
    };
    // 点面板外面就收起来：面板一展开会占掉半屏，看完/点完条件想收起来时
    // 不该再要求用户回顶栏点一次那个按钮（手机上拇指够不着）
    document.addEventListener("click", function (e) {
      if (!state.panelOpen) {
        return;
      }
      if (e.target.closest("#filterPanel") || e.target.closest("#btnFilter")) {
        return;
      }
      setFilterOpen(false);
    });
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
    //
    // ⚠️ 这一下 preventDefault 会把第二拍的 click **一起吃掉**，而"点第二下弹 sheet"
    // 正是靠那次 click —— 于是手机上只有**慢慢点两下**（间隔 >320ms）才能进编辑，
    // 快速双击什么都没发生（电脑上没有 touchend，两次 click 都发得出去，所以一直是好的）。
    // 所以：吃掉 click 的同时，把"第二拍该做的事"顺手自己做掉。
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
          // 状态列除外：它点一下直接切上下架，双击会被切两下 = 等于没切
          var cell = el && el.closest ? el.closest("td[data-ed]") : null;
          if (cell && cell.dataset.ed !== "status") {
            tapCell(el);
          }
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
    // 改值的 sheet：输入框是每次重建的，事件走 sheet 这一层的委托。
    // 等级那一列选项点了就定（写进隐藏的 #fsInput 再走 commitEdit，与输入框同一条路）
    $("fieldSheet").addEventListener("click", function (e) {
      var opt = e.target && e.target.closest ? e.target.closest(".opt") : null;
      if (!opt) {
        return;
      }
      var input = $("fsInput");
      if (input) {
        input.value = String(opt.dataset.v);
      }
      commitEdit(true);
    });
    $("fieldSheet").addEventListener("keydown", function (e) {
      // Esc 什么时候都能放弃（等级那条路没有输入框可聚焦，所以不能只看 e.target）
      if (e.key === "Escape") {
        e.preventDefault();
        commitEdit(false);
        return;
      }
      if (!e.target || e.target.id !== "fsInput") {
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
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
    /**
     * 表格里"点一格"的全部逻辑。**两个入口共用**：普通的 click，和手机上双击的第二拍
     * （那一拍的 click 被"禁双击放大"吃掉了，见 touchend 那段——所以这里必须能被直接调用，
     * 否则手机上只有慢慢点两下才能进编辑）。
     * 返回 true = 这一下已经被处理掉了。
     */
    function tapCell(target) {
      // 行不能写死成 tr：画册是 div[data-id]，写死了画册点卡片就不进详情了
      var hitRow = target.closest("[data-id]");
      var hitCell = target.closest("td[data-ed]");
      // 保存后整行会被重画，e.target 上的引用就成了孤儿节点 —— 一律按 id 重新取
      var row = hitRow ? $("content").querySelector('[data-id="' + hitRow.dataset.id + '"]') : null;
      var cell = row && hitCell ? row.querySelector('td[data-ed="' + hitCell.dataset.ed + '"]') : null;
      if (!cell || !row) {
        return false;
      }
      // 状态例外：它是二选一，没有输入框也不会顶出键盘，误触了再点一下就换回来，
      // 为它多加一拍不划算
      if (cell.dataset.ed === "status") {
        var sp = findProduct(num(row.dataset.id));
        if (sp) {
          toggleStatus(sp, row);
        }
        return true;
      }
      var id = num(row.dataset.id);
      var field = cell.dataset.ed;
      // 同一格点第二下 = 确认要改 → 弹输入框；点别处只是换选中
      if (selected && num(selected.id) === id && selected.field === field) {
        openFieldSheet(row, cell);
        return true;
      }
      clearSelected();
      selected = { id: id, field: field };
      cell.classList.add("sel");
      pushLog("已选中 " + (FIELD_LABEL[field] || field) + "，再点一下就能改");
      return true;
    }

    $("content").onclick = function (e) {
      // 宽屏下"新建"面板正开着：列表里的点击先别当交易 ——
      // 不然点一下商品就把填了一半的新建表单换成那个商品的详情，输入全丢
      if (document.body.classList.contains("drawer") && $("screen-new").classList.contains("show")) {
        return; // 交给 document 那层的"点面板外面就收起"
      }
      if (tapCell(e.target)) {
        return;
      }
      // 点到表格里的空白（不在任何一格上）：取消选中
      clearSelected();
      // 只有带 data-open 的才进详情：表格里是编号列，画册里是整张卡片
      var row = e.target.closest("[data-id]");
      if (row && e.target.closest("[data-open]")) {
        openDetail(num(row.dataset.id));
      }
    };
    // 双击进详情已经去掉了：改成「点两下改一个值」之后它就彻底冲突（第二下是弹输入框）。
    // 进详情现在只有三个明确入口：点编号、sheet 里的「详情 ›」、画册点卡片。
    //
    // 但**双击进编辑**要留着，而且写成显式的：电脑上"双击某一格 → 直接改"是本能动作
    // （原来只是"两下 click"顺带产生的效果，不稳定也不明显）。
    // 手机上不需要判断：双击已经被"禁双击放大"那段 touchend preventDefault 拦掉了，
    // 所以这个监听实际只服务鼠标。
    $("content").addEventListener("dblclick", function (e) {
      var hitCell = e.target.closest("td[data-ed]");
      if (!hitCell || hitCell.dataset.ed === "status") {
        return; // 状态是点一下直接切，没有输入框
      }
      var hitRow = e.target.closest("[data-id]");
      var row = hitRow ? $("content").querySelector('[data-id="' + hitRow.dataset.id + '"]') : null;
      var cell = row ? row.querySelector('td[data-ed="' + hitCell.dataset.ed + '"]') : null;
      if (!row || !cell) {
        return;
      }
      var id = num(row.dataset.id);
      var field = cell.dataset.ed;
      // 第一下 click 已经把 sheet 弹出来了（选中 → 再点一下）：那就什么都不用做，
      // 否则 openFieldSheet 会先把刚打开的那个结算掉再重开一遍（白闪一下 + 多一条日志）
      if (editing && editing.id === id && editing.field === field) {
        return;
      }
      clearSelected();
      selected = { id: id, field: field };
      cell.classList.add("sel");
      openFieldSheet(row, cell);
    });
    $("btnBack").onclick = function () {
      closePanel();
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
      closePanel();
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
    // 左右切图：多张图时不用退出来再点下一张
    $("viewerPrev").onclick = function () {
      stepViewer(-1);
    };
    $("viewerNext").onclick = function () {
      stepViewer(1);
    };
    // 桌面浏览器上用键盘看更顺：← → 翻图、Esc 关掉。Esc 在抽屉模式下还负责关抽屉。
    // 只在灯箱/抽屉开着时管这几个键，别影响列表里打字
    document.addEventListener("keydown", function (e) {
      if ($("viewer").classList.contains("show")) {
        if (e.key === "ArrowLeft") {
          stepViewer(-1);
        } else if (e.key === "ArrowRight") {
          stepViewer(1);
        } else if (e.key === "Escape") {
          $("viewerClose").onclick();
        }
        return;
      }
      if (e.key !== "Escape") {
        return;
      }
      // 改值的 sheet 开着时 Esc 归它（放弃这次改动），别顺手把抽屉也关了
      if ($("fieldSheet").classList.contains("show")) {
        return;
      }
      if (document.body.classList.contains("drawer")) {
        closePanel();
      }
    });
    // 宽屏抽屉（详情 / 新建）：点列表里的空白处就收起来
    // （点商品卡片 = 换成那一件、点在格子上 = 就地改，都不关）。
    // 只认 #content 里的点击：分页/搜索/筛选这些操作不该把面板关掉。
    document.addEventListener("click", function (e) {
      if (!document.body.classList.contains("drawer")) {
        return;
      }
      if (e.target.closest("#screen-detail") || e.target.closest("#screen-new")) {
        return;
      }
      if (!e.target.closest("#content")) {
        return;
      }
      // 新建面板开着时，列表里点哪儿都只是"收起面板"（点商品也一样：
      // 免得填了一半的表单被换成那个商品的详情、输入全丢）
      if (!$("screen-new").classList.contains("show")) {
        if (e.target.closest("[data-open]") || e.target.closest("[data-ed]")) {
          return;
        }
      }
      closePanel();
    });
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
  // 实时推送在读完第一遍之后再连：先让页面有数据可看，连不上也不耽误用
  connectEvents();
  pushLog("⏳读取商品…");
  invoke("loadAll").catch(function () {
    $("content").innerHTML =
      '<p class="muted">读不到商品。检查：服务是否在跑、地址里的 token 对不对、服务端有没有配 --image-dir。</p>';
  });
})();
