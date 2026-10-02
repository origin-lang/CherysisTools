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
    filters: { enum: { category: {}, series: {}, grade: {}, status: {} }, num: {} },
    settings: {},
    detail: null, // { id, code, idx, orig: {...}, status: 0 }
    logs: [],
  };
  var PAGE_SIZE = 50;
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

  function imgUrl(code, name, size) {
    var u = "/api/image?code=" + encodeURIComponent(code) + "&size=" + (size || "thumb");
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
    var last = state.logs[state.logs.length - 1] || "";
    $("statusText").textContent = last;
    $("statusText").className = /^[❌⚠]/.test(last) ? "low" : "muted";
    var panel = $("logPanel");
    if (panel.classList.contains("show")) {
      renderLogs();
    }
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
    $("codeQ").classList.toggle("bad", !!(cq && cq.bad));
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
              "<div>" +
              money(p.sale_price) +
              ' · <span class="' +
              (isLow(p) ? "low" : "") +
              '">库存 ' +
              num(p.stockTotal) +
              "</span></div>" +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else {
      // 真表格：进价 / 售价 / 等级 / 库存 / 状态各占一列（手机上横向可滑，不再挤成一行）
      $("content").innerHTML =
        warn +
        '<p class="muted small inlinehint">点进价 / 售价 / 库存 / 等级 / 状态可直接改；点<b>编号</b>进详情页（看图、传图）。顶部 pill 是正在生效的筛选，点 ✕ 撤一条。</p>' +
        '<div class="tblwrap"><table class="tbl"><thead><tr>' +
        "<th>编号</th><th>名称</th><th>进价</th><th>售价</th><th>等级</th><th>库存</th><th>状态</th>" +
        "</tr></thead><tbody>" +
        list
          .map(rowHtml)
          .join("") +
        "</tbody></table></div>";
    }
  }

  /**
   * 表格一行。可编辑的格子带 data-ed：进价 / 售价 / 库存 / 状态。
   * 其余格（编号、名称、等级）点了是进详情或只读 —— 列分语义，否则「想看详情该点哪」就没有答案了。
   */
  function rowHtml(p) {
    var off = p.status === 1;
    return (
      '<tr data-id="' +
      p.id +
      '"' +
      (off ? ' class="off"' : "") +
      ">" +
      // 只有编号列进详情：名称列误触率高，点它什么都不做（列头那行提示里写清楚了）
      '<td class="open" data-open="1">' +
      esc(p.code) +
      "</td>" +
      '<td class="nm">' +
      esc(p.name) +
      "</td>" +
      '<td class="num ed" data-ed="cost_price" title="点一下改进价">' +
      money(p.cost_price) +
      "</td>" +
      '<td class="num ed" data-ed="sale_price" title="点一下改售价">' +
      money(p.sale_price) +
      "</td>" +
      // 等级可改：后端改等级会按新规则重算售价（product.ts 的 grade 分支），所以这里改了就生效
      '<td class="num ed" data-ed="grade" title="点一下改等级 → 售价按新等级规则重算">' +
      (num(p.grade) > 0 ? num(p.grade) : "自定义") +
      "</td>" +
      '<td class="num ed' +
      (isLow(p) ? " low" : "") +
      '" data-ed="stock" title="点一下改库存（= 实际清点数）">' +
      num(p.stockTotal) +
      "</td>" +
      '<td class="ed' +
      (off ? " low" : "") +
      '" data-ed="status" title="点一下切换上/下架">' +
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

  // ---------- 表格里就地改（不跳详情页） ----------
  // 只做四个短字段：改一个数不该让人跳一页。写库走的就是详情页那一套消息
  // （updateProductField / setStockQty / setStatus），业务口径一处没动。
  var editing = null; // { row, field, id, orig }

  function startEdit(row, cell) {
    var p = findProduct(num(row.dataset.id));
    if (!p) {
      return;
    }
    var field = cell.dataset.ed;
    if (field === "status") {
      toggleStatus(p, row);
      return;
    }
    var cur = field === "stock" ? num(p.stockTotal) : num(p[field]);
    editing = { row: row, field: field, id: p.id, orig: cur };
    cell.classList.add("editing");
    var inner =
      field === "grade"
        ? "<select class=\"inline\">" + gradeOptions(cur, p) + "</select>"
        : '<input class="inline" type="text" inputmode="decimal" value="' + esc(String(cur)) + '" />';
    cell.innerHTML =
      '<span class="editbox">' +
      inner +
      '<button class="ok" type="button">✓</button><button class="no" type="button">✕</button></span>';
    var input = cell.querySelector(".inline");
    input.focus();
    if (input.tagName !== "SELECT") {
      input.select();
      input.onkeydown = function (ev) {
        if (ev.key === "Enter") {
          ev.preventDefault();
          commitEdit(true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          commitEdit(false);
        }
      };
    }
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
      renderList(); // 编辑期间这条被别人删了：没有可还原的行，整表重画
      return;
    }
    var input = ed.row.querySelector(".inline"); // input 或 select（等级是下拉）
    var raw = input ? String(input.value || "").trim() : "";
    var v = Number(raw);
    var changed = submit && p && raw !== "" && Number.isFinite(v) && v !== num(ed.orig);
    if (!changed) {
      if (submit && p && raw !== "" && !Number.isFinite(v)) {
        pushLog("⚠️「" + raw + "」不是一个数字，没改");
      }
      if (p) {
        ed.row.outerHTML = rowHtml(p);
      }
      return;
    }
    var isStock = ed.field === "stock";
    var before = isStock ? num(p.stockTotal) : num(p[ed.field]);
    // 乐观更新：先让格子显示新值，请求失败再回滚（列表里改一个数还要等网络会显得很卡）
    applyLocal(p, ed.field, v);
    ed.row.outerHTML = rowHtml(p);
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
        var r = $("content").querySelector('tr[data-id="' + p.id + '"]');
        if (r) {
          r.outerHTML = rowHtml(p);
        }
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
    ENUM_COLS.forEach(function (c) {
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

  /** 撤掉一个条件。改完要把输入框/圆片同步回去，不然界面和 state 会各说各话 */
  function clearOne(code) {
    if (code === "all") {
      state.filters = { enum: { category: {}, series: {}, grade: {}, status: {} }, num: {} };
      state.q = "";
      state.codeQ = "";
      $("q").value = "";
      $("codeQ").value = "";
    } else if (code === "q") {
      state.q = "";
      $("q").value = "";
    } else if (code === "code") {
      state.codeQ = "";
      $("codeQ").value = "";
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

  function renderFilter() {
    // 编号范围那一格常驻在搜索行（高频，不该藏进展开区），这里只管离散列和数值区间
    var html = "";
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
    // 默认落在第一个真实等级上：停在「自定义」意味着售价不按规则算，那是少数情况，
    // 而新建时九成是要按规则定价的（之前默认停在自定义，等于每次都得手动改一次）
    var first = null;
    for (var i = 0; i < state.rules.length; i++) {
      if (num(state.rules[i].grade) > 0) {
        first = state.rules[i].grade;
        break;
      }
    }
    sel.value = String(first === null ? 0 : first);
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
            return '<img src="' + imgUrl(code, n, "thumb") + '" data-name="' + esc(n) + '" alt="" />';
          })
          .join("");
      })
      .catch(function () {
        box.innerHTML = '<span class="muted small">图片清单读不到</span>';
      });
  }

  function openViewer(code, name) {
    $("viewerImg").src = imgUrl(code, name, "full");
    $("viewer").classList.add("show");
  }

  function saveDetail() {
    var d = state.detail;
    if (!d) {
      return Promise.resolve();
    }
    var jobs = [];
    var name = $("fName").value.trim();
    var category = $("fCategory").value.trim();
    var series = $("fSeries").value.trim();
    var cost = num($("fCost").value);
    var sale = num($("fSale").value);
    var stock = num($("fStock").value);
    if (name !== d.orig.name) {
      jobs.push(["updateProductField", { id: d.id, field: "name", value: name }]);
    }
    if (category !== d.orig.category) {
      jobs.push(["updateProductField", { id: d.id, field: "category", value: category }]);
    }
    if (series !== d.orig.series) {
      jobs.push(["updateProductField", { id: d.id, field: "series", value: series }]);
    }
    if (cost !== d.orig.cost_price) {
      jobs.push(["updateProductField", { id: d.id, field: "cost_price", value: cost }]);
    }
    if (sale !== d.orig.sale_price) {
      jobs.push(["updateProductField", { id: d.id, field: "sale_price", value: sale }]);
    }
    if (stock !== d.orig.stockTotal) {
      jobs.push(["setStockQty", { id: d.id, qty: stock }]);
    }
    var statusNow = num(
      (function () {
        for (var i = 0; i < state.products.length; i++) {
          if (num(state.products[i].id) === num(d.id)) {
            return state.products[i].status;
          }
        }
        return 0;
      })(),
    );
    if (statusNow !== d.status) {
      jobs.push(["setStatus", { id: d.id, status: d.status }]);
    }
    if (!jobs.length) {
      pushLog("ℹ️没有改动");
      return Promise.resolve();
    }
    // 一条一条发：每条都是独立的业务动作，改动点很少，串行更好排查
    return jobs.reduce(function (chain, job) {
      return chain.then(function () {
        return invoke(job[0], job[1]);
      });
    }, Promise.resolve()).then(function () {
      return invoke("loadAll");
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

  function createProduct() {
    var payload = {
      code: $("nCode").value.trim(),
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
      if (ok) {
        $("nCode").value = "";
        $("nName").value = "";
        $("nCost").value = "";
        $("nSale").value = "";
        $("nStock").value = "0";
        show("screen-list");
      }
    });
  }

  // ---------- 上传（手机拍照 / 相册） ----------
  function uploadFiles(files) {
    var d = state.detail;
    if (!d || !files || !files.length) {
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
        return;
      }
      pushLog("⏳上传 " + items.length + " 张…");
      invoke("receiveImageData", { code: d.code, items: items }).then(function () {
        // 传完图片可能换了封面：把详情和大图缓存都作废再读一次
        $("dCover").innerHTML = '<img src="' + imgUrl(d.code, "", "full") + "&t=" + Date.now() + '" alt="" />';
        loadImages(d.code);
        return invoke("loadAll");
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
      renderList();
    };
    $("viewList").onclick = function () {
      state.view = "list";
      $("viewList").classList.add("on");
      $("viewGallery").classList.remove("on");
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
      }
    };
    $("btnSettings").onclick = function () {
      renderSettings();
      show("screen-settings");
    };
    $("btnSetBack").onclick = function () {
      show("screen-list");
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
      var set = state.filters.enum[chip.dataset.field];
      var v = chip.dataset.v;
      if (set[v]) {
        delete set[v];
      } else {
        set[v] = 1;
      }
      chip.classList.toggle("on");
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
    // 编号范围是常驻输入框（在搜索行里），直接绑
    $("codeQ").oninput = function () {
      state.codeQ = $("codeQ").value;
      state.page = 0;
      renderList();
    };
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
    $("content").onclick = function (e) {
      if (e.target.closest(".ok")) {
        commitEdit(true);
        return;
      }
      if (e.target.closest(".no")) {
        commitEdit(false);
        return;
      }
      // 行不能写死成 tr：画册是 div[data-id]，写死了画册点卡片就不进详情了
      var row = e.target.closest("[data-id]");
      var cell = e.target.closest("td[data-ed]");
      // 点到别的行：当前编辑按「值变了就提交」处理（表格的常规习惯），值没变等于没点
      if (editing && row !== editing.row) {
        commitEdit(true);
      }
      if (!(cell && row)) {
        // 只有带 data-open 的才进详情：表格里是编号列，画册里是整张卡片
        if (e.target.closest("[data-open]")) {
          openDetail(num(row.dataset.id));
        }
        return;
      }
      if (editing && row === editing.row) {
        // 同一行里换一列改（改完售价接着改进价）：先结算上一格，再开新的
        if (cell.dataset.ed !== editing.field) {
          var id = editing.id;
          var f = cell.dataset.ed;
          commitEdit(true);
          var r2 = $("content").querySelector('tr[data-id="' + id + '"]');
          var c2 = r2 && r2.querySelector('td[data-ed="' + f + '"]');
          if (c2) {
            startEdit(r2, c2);
          }
        }
        return; // 点的是正在编辑的那一格（输入框本身）：别重建，否则光标没了
      }
      startEdit(row, cell);
    };
    $("btnBack").onclick = function () {
      show("screen-list");
    };
    $("btnPrevItem").onclick = function () {
      if (state.detail) {
        openDetailAt(state.detail.idx - 1);
      }
    };
    $("btnNextItem").onclick = function () {
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
    $("btnNextCode").onclick = nextFreeCode;
    $("nGrade").onchange = updateRuleHint;
    $("btnSave").onclick = function () {
      saveDetail().catch(function () {
        /* 日志里已经有原因 */
      });
    };
    $("fStatus").onclick = function () {
      if (state.detail) {
        state.detail.status = state.detail.status === 1 ? 0 : 1;
        syncStatusBtn();
      }
    };
    $("dImages").onclick = function (e) {
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
    };
    $("btnUpload").onclick = function () {
      $("filePick").click();
    };
    $("filePick").onchange = function () {
      uploadFiles($("filePick").files);
      $("filePick").value = ""; // 同一个文件连传两次也要能触发 change
    };
    $("status").onclick = function () {
      renderLogs();
      $("logPanel").classList.add("show");
    };
    $("logClose").onclick = function () {
      $("logPanel").classList.remove("show");
    };
  }

  bind();
  pushLog("⏳读取商品…");
  invoke("loadAll").catch(function () {
    $("content").innerHTML =
      '<p class="muted">读不到商品。检查：服务是否在跑、地址里的 token 对不对、服务端有没有配 --image-dir。</p>';
  });
})();
