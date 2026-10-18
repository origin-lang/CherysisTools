// 手机版「补货跟踪」—— **独立功能文件**，2026-10-18。
//
// 干什么的（老板九轮谈下来的需求，别自作聪明改）：
//   客户下单 → 货不够 → 记下"这个快递单号缺哪些编号" → 持续跟踪 → 货真到了才闭环。
//   他原来的土办法是 WPS 四列：① 快递单号 ② 缺的编号/物品 ③ 预期结果 ④ 实际情况。
//   这里就是那四列搬进软件，一行 = 一个快递单号。
//
// 想整体摘掉：删本文件 + restock.css + index.html 里那三处（css 一行、页签+面板那段、脚本一行），
// 后端删 handlers/restock.ts 那一行注册与 WRITE_ACTIONS 三条。**进货单那边一行都不用动。**
//
// ---------- 几条钉死的口径（都是他说过的原话） ----------
// · **due 存真实日期**，不存"明天发/2天后"（"因为你没有初始日期，那这个我后面过几天该还是两天发三天后发"）
// · 三档时间状态：还等着（灰）/ **该确认（橙，仅当天）** / 该催（红，逾期）
// · 一行只要还有一个编号没到，就还是"还等着"；永远不来的他**手动关**（closed）
// · **状态只有三种**：wait / done / closed。"发货了没""催了没"是过程，不进状态
// · 删**只软删**，单条删 + 清空已结束都要二次确认（"你不能够自己直接删，我肯定我要自己去清理的嘛"）
// · 输入 `058` 自动补成 `A058`；没编号的孤品（"四叶草"）直接填名字，可以混写
// · 搜到的结果**只显示匹配的行**（"搜到的结果，是只显示匹配的行看的话我就点开看详情呗"）
// · 搜编号时行上要标「这个编号还有 N 单在等」（"需要在行上标这个编号还有 2 单在等"）
// · 第一版**不做扫码**（苹果手机没有 BarcodeDetector，且摄像头必须 https）—— 他同意先不做
// · **只做手机端**，电脑端暂不做（"我们手机也有浏览器可以访问嘛"）
//
// ---------- 界面为什么长这样 ----------
// 列表用**表格式的行**（不是大卡片）：他一句"一个占这么大…我还不如弄个 Excel 表格一样"，
// 一屏能看 12~15 条才够用；点一行展开成**小卡片**做操作（到了/改期/关了/删）。
// 表格行负责"扫一眼全局"，卡片负责"改这一条"—— 两件事分开，谁也不挤谁。
(function () {
  "use strict";

  var API = window.Cherysis;
  if (!API) {
    return;
  }
  var $ = API.$;
  var esc = API.esc;
  var num = API.num;

  /**
   * 编号归一：纯数字 → 默认前缀 A + 补零到 3 位（`058`/`58`/`A58` → `A058`）。
   * ⚠️ 口径出处＝`src/tools/shopTool/pricing.ts` 的 `canonicalCode()`，抄一份是为了守
   *    「独立功能文件」约定（功能自己的逻辑不进 app.js）。
   * ⚠️ 归一不了（`四叶草`、`XD`）**不是错**：原样留着 —— 孤品本来就没有编号。
   *    这里只处理"整段都是编号"的情况；混写（`A058、四叶草`）在 splitItems 里逐段处理。
   */
  function canonicalCode(raw) {
    var s = String(raw === undefined || raw === null ? "" : raw).trim().toUpperCase();
    if (!s) {
      return null;
    }
    var m = /^([A-Z]*)(\d+)$/.exec(s);
    if (!m) {
      return null;
    }
    var head = m[1] || "A";
    var digits = m[2];
    // A 段补零到 3 位（A006），其他段保持原样 —— 跟后端 canonicalCode 一个规矩
    if (head === "A" && digits.length < 3) {
      digits = ("00" + digits).slice(-3);
    }
    return head + digits;
  }

  /** 分隔符：中英文逗号、顿号、分号、斜杠、空白都算 */
  var SEP = /[,，、;；\/\s]+/;

  /** 把 items 拆成一段一段（显示和搜索都按段走，不按整串走） */
  function splitItems(s) {
    return String(s === undefined || s === null ? "" : s)
      .split(SEP)
      .map(function (x) {
        return x.trim();
      })
      .filter(Boolean);
  }

  /**
   * 输入归一：逐段把纯数字补成编号，其他原样。返回 `{ text, fixed }`。
   * fixed = 有几段被改写过（用来自动替换输入框里的字，让他看得见"058 变 A058 了"）。
   */
  function normItems(raw) {
    var parts = splitItems(raw);
    var fixed = 0;
    var out = parts.map(function (p) {
      var c = canonicalCode(p);
      if (c && c !== p.toUpperCase()) {
        fixed++;
        return c;
      }
      return c || p;
    });
    return { text: out.join("、"), fixed: fixed };
  }

  // ---------- 日期 ----------
  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }
  /** 本地今天（不能用 toISOString：那是 UTC，晚上会差一天） */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  /** 今天往后 n 天 */
  function plusDays(n) {
    var d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  /** 两个 YYYY-MM-DD 差几天（b - a）。用本地零点算，跨月跨年都不会差一小时 */
  function dayDiff(a, b) {
    var pa = splitYmd(a);
    var pb = splitYmd(b);
    if (!pa || !pb) {
      return 0;
    }
    var ta = new Date(pa[0], pa[1] - 1, pa[2]).getTime();
    var tb = new Date(pb[0], pb[1] - 1, pb[2]).getTime();
    return Math.round((tb - ta) / 86400000);
  }
  function splitYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
    return m ? [num(m[1]), num(m[2]), num(m[3])] : null;
  }
  /** 显示成 `MM-DD`（今年的不写年，跨年的写全） */
  function shortDate(s) {
    var p = splitYmd(s);
    if (!p) {
      return s || "";
    }
    var thisYear = new Date().getFullYear();
    return p[0] === thisYear ? pad2(p[1]) + "-" + pad2(p[2]) : s;
  }

  /**
   * 三档时间状态（**只在 status=wait 时算**；done/closed 由状态自己说话）：
   *   约定日 > 今天 → wait（灰，还等着）
   *   约定日 = 今天 → today（**橙，该确认**，仅当天有效，明天自动变红）
   *   约定日 < 今天 → late（红，该催，显示"过期 N 天"）
   * due 空着 → 也当 wait（没填日期就没法催，但也不能让它消失）
   *
   * ⚠️⚠️ `dayDiff(a, b)` 算的是 **b - a**（"从 a 到现在过了几天"），
   *   所以这里必须是 `dayDiff(r.due, 今天)` = 今天 - 约定日：
   *     正数 = 已经过了 n 天（逾期）／0 = 就是今天／负数 = 还没到。
   *   第一版写反了（`dayDiff(todayStr(), r.due)`），结果"还没到"的全部算成逾期、
   *   "逾期 3 天"的算成还等着 —— 四个数全部错位，靠渲染桩跑一遍才发现。
   */
  function timeState(r) {
    if (r.status !== "wait") {
      return r.status;
    }
    if (!r.due) {
      return "wait";
    }
    var over = dayDiff(String(r.due), todayStr()); // 今天 - 约定日
    if (over > 0) {
      return "late";
    }
    if (over === 0) {
      return "today";
    }
    return "wait";
  }
  /** 逾期几天（>0 才有意义）。跟 timeState 同一口径：今天 - 约定日 */
  function lateDays(r) {
    return dayDiff(String(r.due || ""), todayStr());
  }

  // ---------- 状态 ----------
  var state = {
    loaded: false,
    rows: [],
    // 搜索：一个框**同时认单号和编号**（他说"我搜一个编号，看看其他哪些订单是需要这些东西的"）
    q: "",
    // 展开中的行 id（-1 = 全收着）。一次只摊一条 —— 摊两条屏幕就不够用了
    openId: -1,
    // 新建/编辑的草稿：{ id:0|n, waybill, items, due, note }
    draft: null,
    // 三组折叠态：该催 / 该确认都**默认展开**（这两组就是"今天要动手的"）；
    // 还等着折一行、已结束折一行（它们不急，折起来省地方）
    fold: { late: false, today: false, wait: true, done: true },
  };

  var STATUS_TEXT = { wait: "还等着", today: "该确认", late: "该催", done: "到了", closed: "关了" };

  // ---------- 取数 ----------
  function counting() {
    var n = { wait: 0, today: 0, late: 0, done: 0 };
    for (var i = 0; i < state.rows.length; i++) {
      n[timeState(state.rows[i])]++;
    }
    return n;
  }

  /** 顶部页签那颗红点（该催几条）。0 就藏起来 —— 空着挂个"0"像坏了 */
  function paintTabBadge() {
    var badge = $("purchTabRestockBadge");
    if (!badge) {
      return;
    }
    var c = counting();
    var n = c.late + c.today;
    if (!state.loaded || n <= 0) {
      badge.hidden = true;
      badge.textContent = "";
      return;
    }
    badge.hidden = false;
    badge.textContent = String(n);
    // 只该催（有逾期）→ 红；只有"今天该确认"→ 橙（红点会让人以为出事了）
    badge.className = "p-tab-badge" + (c.late > 0 ? "" : " warn");
  }

  // ---------- 搜索 ----------
  /**
   * 这一行是否命中搜索词。**单号和编号都认**：
   *   · 单号：任意位置包含（他可能只记得后几位）
   *   · 编号：按**段**比，`035`/`a35` 都算命中 `A035`（归一之后再比，别让人为了搜一个 035 去补 A）
   */
  function hitRow(r, q) {
    if (!q) {
      return true;
    }
    var raw = String(r.waybill || "").toUpperCase();
    var up = q.toUpperCase();
    if (raw.indexOf(up) >= 0) {
      return true;
    }
    var want = canonicalCode(q);
    var segs = splitItems(r.items);
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (seg.toUpperCase().indexOf(up) >= 0) {
        return true;
      }
      if (want && canonicalCode(seg) === want) {
        return true;
      }
    }
    return false;
  }

  /** 搜的这个词在库里有几个单在等（**跨行**数，含这一行自己）。只对编号有意义 */
  function waitingByCode(code) {
    var want = canonicalCode(code);
    if (!want) {
      return 0;
    }
    var n = 0;
    for (var i = 0; i < state.rows.length; i++) {
      var r = state.rows[i];
      if (r.status !== "wait") {
        continue;
      }
      var segs = splitItems(r.items);
      for (var j = 0; j < segs.length; j++) {
        if (canonicalCode(segs[j]) === want) {
          n++;
          break;
        }
      }
    }
    return n;
  }

  /**
   * 这一行里的编号，别的单还有几个在等（行上那行小字：「A058 还有 2 单在等」）。
   * 只对**编号**统计，汉字孤品不算（没编号就没法归并）。
   */
  function otherWaitText(r) {
    var segs = splitItems(r.items);
    var out = [];
    var seen = {};
    for (var i = 0; i < segs.length; i++) {
      var c = canonicalCode(segs[i]);
      if (!c || seen[c]) {
        continue;
      }
      seen[c] = 1;
      var n = waitingByCode(c) - (r.status === "wait" ? 1 : 0);
      if (n > 0) {
        out.push(c + " 还有 " + n + " 单在等");
      }
    }
    return out.join(" · ");
  }

  // ---------- 渲染 ----------
  function render() {
    var root = $("restockRoot");
    if (!root) {
      return;
    }
    paintTabBadge();
    var c = counting();
    var q = state.q.trim();
    var h = [];

    // ① 搜索行（**常驻一整行**，2026-10-18 晚改的）+ 四个数
    //    为什么不再用"点放大镜才露"：老板说"这个搜索按钮好像点了会没反应，
    //    而且我也不知道点哪里…还会不小心放大" —— 顶栏里挤着放大镜和别的按钮，
    //    44px 的点击区互相压，按偏就打到旁边那颗。常驻一行 = 不用找也不用点。
    //    ⚠️ 搜索**结果**另放在 .rs-results 里 —— 打字时只换那一块，搜索框本身不动
    //       （否则光标丢、中文输入法被打断，打到一半的字会飞）。
    h.push(
      '<div class="rs-searchrow"><div class="rs-searchwrap">' +
        '<input id="rsSearch" class="rs-search" type="search" placeholder="搜单号或编号，如 035" ' +
        'autocomplete="off" autocorrect="off" autocapitalize="off" ' +
        'value="' +
        esc(state.q) +
        '" />' +
        (q ? '<button id="rsSearchClear" class="rs-clear" type="button" aria-label="清空搜索">✕</button>' : "") +
        "</div></div>",
    );
    h.push('<div class="rs-note-host">' + (q ? searchNote(q) : "") + "</div>");
    h.push(
      '<div class="rs-stats">' +
        statCell("等", c.wait, "wait") +
        statCell("待确认", c.today, "today") +
        statCell("该催", c.late, "late") +
        statCell("已结束", c.done, "done") +
        "</div>",
    );

    // ② 结果区（四组 / 搜索命中）
    h.push('<div class="rs-results">' + resultsHtml(q) + "</div>");

    root.innerHTML = h.join("");
    // ③「＋ 记一条」：**底栏通栏绿按钮**，跟进货单底栏那颗「快速记」同款。
    //    2026-10-18 晚二轮老板：「那个点点添加一行那个按钮我感觉不是很灵敏，我不知道为什么…
    //    你可以跟进货单一样的，它下面那个快速记那一栏吧，感觉点那个更好一点」
    //    ⚠️ 不在 render() 的 h 里拼 —— 它是**面板的固定底栏**（.rs-bottombar），
    //       要留在滚动区外面、贴着底部；塞进 #restockRoot（滚动容器）里会跟着列表滚走。
    var bar = $("rsBottombar");
    if (bar) {
      bar.innerHTML = "";
    }
    paintBottomBar();
    bindOnce();
  }

  /**
   * 底栏那颗「＋ 记一条」。
   * ⚠️ 为什么不render 时拼字符串：#rsBottombar 是 index.html 里的**静态节点**，
   *    挂在 `#purchPaneRestock` 里、`#restockRoot` 外面（见 index.html 那段注释）。
   *    每次进来只改它的内容，别整个重建容器。
   */
  function paintBottomBar() {
    var bar = $("rsBottombar");
    if (!bar) {
      return;
    }
    bar.innerHTML =
      '<button id="rsNewBtn" class="rs-newbtn" type="button">＋ 记一条</button>';
    // ⚠️ 点击必须**挂在按钮自己身上**（2026-10-18 晚四轮）：
    //    bindOnce() 的 onclick 挂在 #restockRoot 上，而底栏是它的**兄弟节点** ——
    //    事件冒泡到不了 root，点「记一条」就是没反应（老板真机当场踩到）。
    //    render() 每次都会 innerHTML 清掉重画，onclick 重新赋一遍，不会叠加。
    var btn = $("rsNewBtn");
    if (btn) {
      btn.onclick = function () {
        openDraft(0);
      };
    }
  }

  function statCell(label, n, cls) {
    return (
      '<div class="rs-stat rs-' +
      cls +
      (n ? "" : " zero") +
      '"><b>' +
      n +
      "</b><span>" +
      label +
      "</span></div>"
    );
  }

  /** 搜索框下面那句提示：搜编号时告诉他"这个编号还有 N 单在等" */
  function searchNote(q) {
    var c = canonicalCode(q);
    if (!c) {
      return "";
    }
    var n = waitingByCode(c);
    return n > 0
      ? '<div class="rs-note">编号 ' + esc(c) + " 还有 " + n + " 单在等</div>"
      : "";
  }

  /**
   * 一组。四组的折叠规则：
   *   · 该催（红） / 今天该确认（橙） → **默认展开** —— 这两组就是"今天要动手的"
   *   · 还等着 / 已结束 → 折成一行，右边挂一句摘要（还等着挂"最近 明天到"，已结束挂"清空"）
   * ⚠️「今天该确认」这一组**必须有**：顶部四个数里有它一格，列表里要是没对应的组，
   *   那几条今天就彻底看不见了（第一版就是这样漏的：数字亮着 1，往下翻找不到是哪个单）。
   */
  function groupHtml(key, title, kind) {
    var list = state.rows.filter(function (r) {
      return timeState(r) === key;
    });
    if (list.length === 0) {
      return "";
    }
    // 该催 / 该确认：欠得最久的排前面（该先催的在前）；还等着 / 已结束：最近的排前面
    list.sort(function (a, b) {
      if (kind === "late") {
        return String(a.due).localeCompare(String(b.due));
      }
      return String(b.due).localeCompare(String(a.due));
    });
    var folded = state.fold[key];
    // 组头右侧那一小句摘要（"最近 明天"）。「清空」**不走这里** —— 见下面 done 那一段
    var right = "";
    if (folded && list.length && key !== "done") {
      // 折着的时候给一句摘要：别让他为了看一眼"最近什么时候到"就展开
      var next = key === "wait" ? nearestDue(list) : "";
      if (next) {
        right = '<span class="rs-foldnote">最近 ' + esc(next) + "</span>";
      }
    }
    return (
      '<div class="rs-group rs-g-' +
      key +
      (folded ? " folded" : "") +
      '">' +
      '<div class="rs-ghead">' +
      '<button class="rs-grouphead" type="button" data-fold="' +
      key +
      '">' +
      '<span class="rs-gtitle">' +
      // 圆点由 CSS 按 rs-g-<key> 上色（形状统一、只换颜色），这里只出空壳
      '<i class="rs-gdot"></i>' +
      title +
      '<i class="rs-gcount">' +
      list.length +
      "</i></span>" +
      '<span class="rs-gright">' +
      right +
      '<svg class="rs-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
      "</span></button>" +
      (key === "done"
        ? '<button class="rs-clear-done" type="button" data-clear-done="1">清空</button>'
        : "") +
      "</div>" +
      (folded ? "" : '<div class="rs-rows">' + list.map(rowHtml).join("") + "</div>") +
      "</div>"
    );
  }

  /** 还等着那组里"最近要到的"（写成"明天 / 10-21"这种人话） */
  function nearestDue(list) {
    var best = "";
    for (var i = 0; i < list.length; i++) {
      var d = String(list[i].due || "");
      if (!d) {
        continue;
      }
      if (!best || d < best) {
        best = d;
      }
    }
    if (!best) {
      return "";
    }
    var diff = dayDiff(todayStr(), best);
    if (diff === 0) {
      return "今天";
    }
    if (diff === 1) {
      return "明天";
    }
    if (diff === 2) {
      return "后天";
    }
    return shortDate(best);
  }

  /**
   * 一行（表格式）+ 展开后的小卡片。
   *
   * 表格行三格：单号 / 缺的 / 约定。为什么这么排：
   *   · 单号是身份，最长 → 占最多宽度，**超了截断**（要复制有按钮，见卡片）
   *   · 缺的编号是内容，第二宽
   *   · 约定日期 + 三档颜色放右边一列（扫一眼就知道哪条红了）
   * 点行 = 只切 class 展开卡片（**不重画**，重画会把正在敲的字和焦点吞掉）
   */
  function rowHtml(r) {
    var ts = timeState(r);
    var open = state.openId === r.id;
    var dueTxt = r.due ? shortDate(r.due) : "没定";
    var late = ts === "late" ? lateDays(r) : 0;
    var sub = late > 0 ? "过期 " + late + " 天" : ts === "today" ? "今天该确认" : "";
    var wat = otherWaitText(r);
    return (
      '<div class="rs-row rs-' +
      ts +
      (open ? " open" : "") +
      '" data-id="' +
      r.id +
      '">' +
      '<div class="rs-line">' +
      '<div class="rs-wb" title="' +
      esc(r.waybill) +
      '">' +
      esc(r.waybill || "（没填单号）") +
      "</div>" +
      '<div class="rs-items">' +
      esc(r.items || "—") +
      (wat ? '<i class="rs-wat">' + esc(wat) + "</i>" : "") +
      "</div>" +
      '<div class="rs-due">' +
      '<span class="rs-pill rs-p-' +
      ts +
      '">' +
      STATUS_TEXT[ts] +
      "</span>" +
      '<em class="rs-date">' +
      esc(dueTxt) +
      "</em>" +
      (sub ? '<em class="rs-sub">' + esc(sub) + "</em>" : "") +
      "</div>" +
      "</div>" +
      (open ? cardHtml(r) : "") +
      "</div>"
    );
  }

  /** 展开后的卡片：单号(可复制)/缺的/约定(改期记录)/备注 + 四个动作 */
  function cardHtml(r) {
    var ts = timeState(r);
    var h = [];
    h.push('<div class="rs-card">');
    // 单号 + 复制。⚠️ 用 execCommand 兜底：`navigator.clipboard` **只在 https 存在**，
    // 局域网 http 访问时它是 undefined（进货单那边栽过这跟头）
    h.push(
      '<div class="rs-cl">' +
        '<span class="rs-lb">单号</span>' +
        '<span class="rs-val mono">' +
        esc(r.waybill || "—") +
        "</span>" +
        (r.waybill
          ? '<button class="rs-copy" type="button" data-copy="' + esc(r.waybill) + '">复制</button>'
          : "") +
        "</div>",
    );
    h.push(
      '<div class="rs-cl"><span class="rs-lb">缺的</span><span class="rs-val">' +
        esc(r.items || "—") +
        "</span></div>",
    );
    var dueLine = r.due ? shortDate(r.due) : "没定";
    if (r.due_changes > 0 && r.due_first) {
      dueLine +=
        ' <i class="rs-chg">改过 ' +
        r.due_changes +
        " 次 · 原定 " +
        shortDate(r.due_first) +
        "</i>";
    }
    // ⚠️ dueLine 在上面拼了 <i class="rs-chg">（"改过 N 次"的小灰字），
    //   **不能整段 esc** —— 那会把标签变成字面文字（截图里"改过 1 次"前面露出了 <i> 标签）。
    //   拆开转义：纯文本的两截各自 esc，标签本身不进 esc。
    h.push(
      '<div class="rs-cl"><span class="rs-lb">约定</span><span class="rs-val">' +
        esc(r.due ? shortDate(r.due) : "没定") +
        (r.due_changes > 0 && r.due_first
          ? ' <i class="rs-chg">改过 ' + r.due_changes + " 次 · 原定 " + esc(shortDate(r.due_first)) + "</i>"
          : "") +
        "</span></div>",
    );
    if (r.note) {
      h.push(
        '<div class="rs-cl"><span class="rs-lb">备注</span><span class="rs-val">' +
          esc(r.note) +
          "</span></div>",
      );
    }
    // 动作顺序（2026-10-18 晚五轮老板定的）：到了 / 改期 / 编辑 / 删除。
    // 老板：「把关了变成删除吧，然后放到最右边，编辑放到第三个」——
    //   · 「关了」**撤掉**，它那个位置（第 4 颗）换成「删除」，删除固定占最右一格；
    //   · 「编辑」挪到第 3 位。
    // ⚠️ 语义没丢：「删除」是软删（库里只打标记、删错了捞得回来），
    //    所以"这货不来了"现在就是删掉这条记录 —— 老板明确要这个，别再拿「关了」回来顶。
    h.push('<div class="rs-acts">');
    if (r.status === "wait") {
      h.push('<button class="rs-act ok" type="button" data-act="done">到了</button>');
      h.push('<button class="rs-act" type="button" data-act="due">改期</button>');
    } else if (r.status === "done") {
      // 点到"到了"点错了 → 能退回来。已结束的行也允许重新打开，不让他为一次误点重新录一遍
      h.push('<button class="rs-act" type="button" data-act="reopen">退回等</button>');
    } else {
      h.push('<button class="rs-act" type="button" data-act="reopen">重新打开</button>');
    }
    // ⭐「编辑」第 3 位、且每种状态都长出来：
    //   单号/编号/约定/备注，打错任何一个都得能改；已结束的照样要能改（他常常是回头才发现日期写错了）
    //   ⚠️ 文案就是「编辑」两个字（老板 2026-10-18 晚："有改这条那条那三个字有点多，要不点修改吧。
    //      或者编辑也行啊，这个词汇不太好"）—— 「改这条」三个字太啰嗦，「修改」他又说词汇不好，定「编辑」。
    h.push('<button class="rs-act" type="button" data-act="edit">编辑</button>');
    // ⭐「删除」固定最右一格（`.del` 自带 flex:0 0 auto + 右侧，见 restock.css）
    h.push('<button class="rs-act del" type="button" data-act="del">删除</button>');
    h.push("</div>");
    h.push("</div>");
    return h.join("");
  }

  // ---------- 草稿（记一条 / 编辑） ----------
  function openDraft(id) {
    if (id) {
      var r = state.rows.filter(function (x) {
        return x.id === id;
      })[0];
      if (!r) {
        return;
      }
      state.draft = {
        id: r.id,
        waybill: r.waybill,
        items: r.items,
        due: r.due,
        note: r.note,
      };
    } else {
      state.draft = {
        id: 0,
        waybill: "",
        items: "",
        due: plusDays(2), // 默认 2 天后：他说"有些商家跟我说他有可能要两天或者三天才能发货"
        note: "",
      };
    }
    renderDraft();
  }

  /**
   * 草稿弹层（底部弹起的一张卡）。
   * 只**覆盖**在列表上，不换屏 —— 他习惯"看一眼列表、想起来就补一条"。
   * 日期那一排是**快捷键**（今天/明天/2天后/3天后）：他说"你可以提供我数数字，比如说一天两天三天，
   * 然后我自动写了对应的日期呗"—— 但存进库里的永远是**换出来的真实日期**。
   */
  function renderDraft() {
    var d = state.draft;
    var host = $("rsDraft");
    if (!host) {
      host = document.createElement("div");
      host.id = "rsDraft";
      host.className = "rs-mask";
      document.body.appendChild(host);
    }
    if (!d) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;
    var quick = [
      ["今天", 0],
      ["明天", 1],
      ["2天后", 2],
      ["3天后", 3],
    ];
    var today = todayStr();
    host.innerHTML =
      '<div class="rs-sheet">' +
      '<div class="rs-sheet-h">' +
      (d.id ? "编辑" : "记一条补货") +
      '<button class="rs-sheet-x" type="button" data-draft="cancel">✕</button></div>' +
      '<label class="rs-f"><span>快递单号</span>' +
      '<input id="rsDWb" type="text" inputmode="text" autocomplete="off" placeholder="快递单号（一行一个）" value="' +
      esc(d.waybill) +
      '" /></label>' +
      '<label class="rs-f"><span>缺的编号</span>' +
      '<input id="rsDItems" type="text" inputmode="text" autocomplete="off" placeholder="如 058、四叶草（可填多个）" value="' +
      esc(d.items) +
      '" /></label>' +
      '<div class="rs-f"><span>约定日期</span>' +
      '<div class="rs-quick">' +
      quick
        .map(function (q) {
          var v = plusDays(q[1]);
          return (
            '<button class="rs-q' +
            (d.due === v ? " on" : "") +
            '" type="button" data-q="' +
            v +
            '">' +
            q[0] +
            "</button>"
          );
        })
        .join("") +
      "</div>" +
      '<input id="rsDDue" class="rs-dateinput" type="date" value="' +
      esc(d.due) +
      '" />' +
      "</div>" +
      '<label class="rs-f"><span>备注</span>' +
      '<input id="rsDNote" type="text" autocomplete="off" placeholder="随便写：客户催了、商家说明天发…" value="' +
      esc(d.note) +
      '" /></label>' +
      '<div class="rs-sheet-b">' +
      '<button class="rs-save" type="button" data-draft="save">' +
      (d.id ? "保存" : "记下来") +
      "</button>" +
      "</div>" +
      "</div>";
    // 输入即写回草稿（不重画，重画会把键盘顶掉）
    var wb = $("rsDWb");
    if (wb) {
      wb.oninput = function () {
        d.waybill = this.value;
      };
    }
    var it = $("rsDItems");
    if (it) {
      it.oninput = function () {
        d.items = this.value;
      };
      // 离开这一格时把 `058` 换成 `A058`，**看得见地**替换（他："用户输入 058 你可以自动把 A 写上去嘛"）
      it.onblur = function () {
        var r = normItems(this.value);
        if (r.fixed > 0) {
          this.value = r.text;
          d.items = r.text;
          API.toast("已规范成 " + r.text, false, 1800);
        } else {
          d.items = this.value;
        }
      };
    }
    var due = $("rsDDue");
    if (due) {
      due.onchange = function () {
        d.due = this.value;
        // 日期改了 → 快捷键高亮要跟着变（只动那几颗按钮的 class，不重画整张卡）
        var qs = host.querySelectorAll(".rs-q");
        for (var i = 0; i < qs.length; i++) {
          qs[i].classList.toggle("on", qs[i].dataset.q === d.due);
        }
      };
    }
    var nt = $("rsDNote");
    if (nt) {
      nt.oninput = function () {
        d.note = this.value;
      };
    }
    // 快捷键：点一下写进日期框（**换算成真实日期**再存）
    host.querySelectorAll(".rs-q").forEach(function (b) {
      b.onclick = function () {
        d.due = this.dataset.q;
        var inp = $("rsDDue");
        if (inp) {
          inp.value = d.due;
        }
        host.querySelectorAll(".rs-q").forEach(function (x) {
          x.classList.toggle("on", x.dataset.q === d.due);
        });
      };
    });
    // 新建时把光标落在单号上（他要打/贴单号）；改一条时**不动键盘** —— 可能只是想改个备注
    if (!d.id) {
      var wbEl = $("rsDWb");
      if (wbEl) {
        wbEl.focus();
      }
    }
  }

  function saveDraft() {
    var d = state.draft;
    if (!d) {
      return;
    }
    // 提交前把编号再规范一遍（有人可能没离开那一格就直接点了保存）
    var norm = normItems(d.items);
    d.items = norm.text;
    if (!String(d.waybill).trim() && !String(d.items).trim()) {
      API.toast("单号和缺的编号至少填一个", true);
      return;
    }
    if (d.id) {
      API.invoke("restockUpdate", {
        id: d.id,
        waybill: d.waybill,
        items: d.items,
        due: d.due,
        note: d.note,
      });
    } else {
      API.invoke("restockAdd", {
        waybill: d.waybill,
        items: d.items,
        due: d.due,
        note: d.note,
      });
    }
    state.draft = null;
    renderDraft();
    API.toast(d.id ? "已保存" : "已记下");
  }

  // ---------- 改期 ----------
  /**
   * 改期：弹一个**原生 prompt**（不另做一套日期选择器）。
   * 理由：这是低频动作、一次只改一个日期，`prompt` 在 iOS/安卓上都能直接填；
   *      而自己画一个日历要三十行 CSS + 一堆边界（今天高亮、跨月），收益不成比例。
   * 输入支持 `10-21` / `2026-10-21` / `明天` / `+3` 这几种写法 —— 但**存进去的永远是真实日期**。
   */
  function askDue(r) {
    var raw = window.prompt(
      "新的约定日期（写日期，或 +2 表示 2 天后）\n现在：" + (r.due || "没定"),
      r.due || plusDays(2),
    );
    if (raw === null) {
      return;
    }
    var v = parseDueInput(raw);
    if (!v) {
      API.toast("看不懂这个日期，写成 10-21 或 +2 这样", true);
      return;
    }
    API.invoke("restockUpdate", { id: r.id, due: v });
  }

  /** `10-21` / `2026-10-21` / `+2` / `明天` → YYYY-MM-DD；看不懂回 "" */
  function parseDueInput(raw) {
    var s = String(raw || "").trim();
    if (!s) {
      return "";
    }
    if (/^\+\d+$/.test(s)) {
      return plusDays(num(s.slice(1)));
    }
    if (s === "今天") {
      return todayStr();
    }
    if (s === "明天") {
      return plusDays(1);
    }
    if (s === "后天") {
      return plusDays(2);
    }
    var full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (full) {
      return full[1] + "-" + pad2(num(full[2])) + "-" + pad2(num(full[3]));
    }
    var md = /^(\d{1,2})-(\d{1,2})$/.exec(s);
    if (md) {
      return new Date().getFullYear() + "-" + pad2(num(md[1])) + "-" + pad2(num(md[2]));
    }
    var m2 = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
    if (m2) {
      return new Date().getFullYear() + "-" + pad2(num(m2[1])) + "-" + pad2(num(m2[2]));
    }
    return "";
  }

  // ---------- 行操作 ----------
  function actOn(id, act) {
    var r = state.rows.filter(function (x) {
      return x.id === id;
    })[0];
    if (!r) {
      return;
    }
    if (act === "done") {
      API.invoke("restockUpdate", { id: id, status: "done" });
      return;
    }
    // ⚠️ 这里**没有** act === "close" 了（2026-10-18 晚五轮）：老板要把「关了」换成「删除」，
    //    按钮已经不发了，留着就是永远走不到的死分支（还会骗过"整函数里有没有 close"这类断言）。
    //    后端 status="closed" 字段仍保留（历史数据里还有），只是手机端不再产生它。
    if (act === "reopen") {
      API.invoke("restockUpdate", { id: id, status: "wait" });
      return;
    }
    if (act === "due") {
      askDue(r);
      return;
    }
    // 编辑：打错了字 / 编号写漏了，得能回头改（老板 2026-10-18："万一我确实打错了呢"）。
    // 走的是"记一条"那同一张草稿表单（draft.id != 0 就走更新），不另开一套界面
    if (act === "edit") {
      openDraft(id);
      return;
    }
    if (act === "del") {
      // 二次确认（他明确要求："你不能够自己直接删，我肯定我要自己去清理的嘛"）
      if (window.confirm("删掉这条补货记录？\n（单号 " + (r.waybill || "没填") + "）")) {
        // 软删除：库里只打标记，删错了还能捞回来
        API.invoke("restockDelete", { ids: [id] });
      }
    }
  }

  /** 复制单号：https 上用 clipboard，局域网 http 只有 execCommand 这条路 */
  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(
        function () {
          API.toast("已复制");
        },
        function () {
          copyFallback(txt);
        },
      );
      return;
    }
    copyFallback(txt);
  }
  function copyFallback(txt) {
    try {
      var ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      API.toast("已复制");
    } catch (e) {
      API.toast("复制不了，长按单号手动选吧", true);
    }
  }

  // ---------- 接线 ----------
  /**
   * 重画之后挂一次事件。
   * ⚠️ **每次 render() 之后都要调**（render 是整块 innerHTML 换掉的，旧的监听全没了）：
   *    用「把 root.onclick 重新赋一遍」而不是 addEventListener —— 属性赋值天然只有一份，
   *    调一百次也只会挂一个监听，不会越积越多。
   */
  function bindOnce() {
    var root = $("restockRoot");
    if (!root) {
      return;
    }
    root.onclick = function (e) {
      var t = e.target;
      // ⚠️ 「记一条」（#rsNewBtn）不在这里：它在底栏 #rsBottombar（root 的兄弟节点），
      //    冒泡到不了 root —— 它的点击挂在 paintBottomBar() 里的按钮自己身上。
      if (t.id === "rsSearchClear") {
        state.q = "";
        var box = $("rsSearch");
        if (box) {
          box.value = "";
          box.focus();
        }
        renderResultsOnly();
        return;
      }
      // 折叠 / 清空：这两种会改结构，走整体重画（它们不在"正在打字"的路径上）
      var fold = t.closest("[data-fold]");
      if (fold) {
        var k = fold.dataset.fold;
        state.fold[k] = !state.fold[k];
        // ⚠️ 折/展之后**要把新展开那一组里的行也画出来**，所以走 render()，
        //    但 render 会重建 DOM → 滚动位置会跳回顶部。这里手动把滚动位置还回去。
        var sv = root.parentNode ? root.parentNode.scrollTop : 0;
        render();
        if (root.parentNode) {
          root.parentNode.scrollTop = sv;
        }
        return;
      }
      var clr = t.closest("[data-clear-done]");
      if (clr) {
        var doneIds = state.rows
          .filter(function (r) {
            return r.status !== "wait";
          })
          .map(function (r) {
            return r.id;
          });
        if (doneIds.length === 0) {
          return;
        }
        if (window.confirm("清空全部已结束的 " + doneIds.length + " 条？（不会真删，删错了能找回来）")) {
          API.invoke("restockDelete", { ids: doneIds });
        }
        return;
      }
      var cp = t.closest("[data-copy]");
      if (cp) {
        copyText(cp.dataset.copy);
        return;
      }
      var ac = t.closest("[data-act]");
      if (ac) {
        var rowEl = t.closest("[data-id]");
        actOn(num(rowEl && rowEl.dataset.id), ac.dataset.act);
        return;
      }
      // 点行本身 = 展开/收起卡片。
      // ⭐ 这里**只切 class + 拼/摘卡片**，绝不重画整屏 —— 重画会把它滚回顶部，
      //   他"点开看详情"时整页往上一跳，比不展开还难受。
      var row = t.closest("[data-id]");
      if (row) {
        var id = num(row.dataset.id);
        state.openId = state.openId === id ? -1 : id;
        var all = root.querySelectorAll(".rs-row");
        for (var i = 0; i < all.length; i++) {
          var keep = num(all[i].dataset.id) === state.openId;
          all[i].classList.toggle("open", keep);
          var old = all[i].querySelector(".rs-card");
          if (old) {
            old.parentNode.removeChild(old);
          }
          if (keep) {
            var r2 = state.rows.filter(function (x) {
              return x.id === state.openId;
            })[0];
            if (r2) {
              all[i].insertAdjacentHTML("beforeend", cardHtml(r2));
            }
          }
        }
      }
    };
    // 搜索框：边打边筛。⚠️ **不重画搜索框本身**，只换结果区（否则光标丢、中文输入被打断）
    var search = $("rsSearch");
    if (search) {
      search.oninput = function () {
        state.q = this.value;
        renderResultsOnly();
      };
    }
  }

  /**
   * 只重画"结果区"（三组 / 搜索命中），**不动搜索框和上面那排数**。
   * 为什么要分开：搜索框在 input 事件里重画整屏 → 输入框被换成新的 → 光标丢、中文输入被打断。
   */
  function renderResultsOnly() {
    var root = $("restockRoot");
    if (!root) {
      return;
    }
    var q = state.q.trim();
    var host = root.querySelector(".rs-results");
    if (!host) {
      render();
      return;
    }
    host.innerHTML = resultsHtml(q);
    // 搜索提示（"这个编号还有 N 单在等"）也跟着换
    var noteHost = root.querySelector(".rs-note-host");
    if (noteHost) {
      noteHost.innerHTML = q ? searchNote(q) : "";
    }
    // ✕ 按钮：有字才出现（顺手补齐，省得为它重画整屏）
    paintCopyClear(root, q);
  }

  /** 搜索框右边那颗 ✕：有搜索词就露出来，没有就撤掉 */
  function paintCopyClear(root, q) {
    // ⚠️ ✕ 要挂进 .rs-searchwrap（输入框外面一层），不是 .rs-searchrow ——
    //   CSS 里 ✕ 是**绝对定位**压在输入框右边 34×34 的可点区里，
    //   挂在 row 上会掉到输入框**下面**去，看着像凭空多了一行。
    var row = root.querySelector(".rs-searchwrap");
    if (!row) {
      return;
    }
    var btn = row.querySelector(".rs-clear");
    if (q && !btn) {
      var b = document.createElement("button");
      b.className = "rs-clear";
      b.id = "rsSearchClear";
      b.type = "button";
      b.textContent = "✕";
      row.appendChild(b);
    } else if (!q && btn) {
      row.removeChild(btn);
    }
  }

  /** 结果区（三组 or 搜索命中）：抽出来是为了搜索时能只换这一块 */
  function resultsHtml(q) {
    if (!state.loaded) {
      return '<p class="rs-empty">读不到补货记录…</p>';
    }
    if (q) {
      var hits = state.rows.filter(function (r) {
        return hitRow(r, q);
      });
      return (
        '<div class="rs-grouphead">搜到 ' + hits.length + " 条</div>" +
        (hits.length ? hits.map(rowHtml).join("") : '<p class="rs-empty">没有匹配的单号或编号</p>')
      );
    }
    if (state.rows.length === 0) {
      return '<p class="rs-empty">还没有补货记录。<br />客户下单缺了货，点上面的「＋ 记一条」记下来。</p>';
    }
    // ⚠️「待确认」（今天到期）必须**单独成一组**：顶部四个数里有它一格，
    //   列表里要是没有对应的组，那几条今天就彻底看不见了（第一版就是这样漏的 ——
    //   "待确认 1" 亮着、往下翻却找不到那条是哪个单）。它默认**展开**，跟该催一样是"今天要动手"的。
    //
    // 四个标题**统一用一颗圆点**，只有颜色不同（老板 2026-10-18 晚："该催了、今天该催的都是用圆
    // 圆一个颜色，那为什么还等着已结束用图标呢？你有什么设计在里面吗"——没设计，就是我先用 🔴🟠
    // 后补 ⏳✅ 拼出来的，四行里两行 emoji 两行符号，看着就是没想好）。
    // 现在：红实心=该催 / 橙实心=今天该确认 / 灰空心=还等着（不急，等你关注而已）/
    //       灰实心=已结束（走完了，收掉了）。**形状不变、只换颜色**，一眼横向比得出来谁更急。
    return (
      groupHtml("late", "该催了", "late") +
      groupHtml("today", "今天该确认", "today") +
      groupHtml("wait", "还等着", "wait") +
      groupHtml("done", "已结束", "done")
    );
  }

  // ---------- 页签切换 ----------
  /** "order" 进进货单那块 / "restock" 进补货跟踪那块。两块各管自己，谁也不认对方的内容 */
  var TAB_KEY = "cherysisPurchTab";

  function paintTabs() {
    var isRestock = !$("purchPaneRestock").hidden;
    $("purchTabOrder").classList.toggle("on", !isRestock);
    $("purchTabRestock").classList.toggle("on", isRestock);
    $("purchPaneOrder").hidden = isRestock;
    $("purchPaneRestock").hidden = !isRestock;
    // 顶栏标题跟着走。⚠️ 顶栏右侧那颗「＋ 新建」已经删了（2026-10-18 晚），
    //    所以这里**没有**要显隐的按钮；别再把 purchaseNewBtn 接回来。
    $("purchaseHeadTitle").textContent = isRestock ? "📦 补货跟踪" : "🧾 进货单";
  }

  function switchTab(which) {
    var toRestock = which === "restock";
    if (toRestock === !$("purchPaneRestock").hidden) {
      return;
    }
    $("purchPaneRestock").hidden = !toRestock;
    try {
      localStorage.setItem(TAB_KEY, which);
    } catch (e) {
      /* 存不了就每次从进货单进 */
    }
    paintTabs();
    if (toRestock) {
      API.invoke("restockList");
    }
  }

  function bind() {
    // ⚠️ 这两屏都算「进货」那一格（底部高亮由 app.js 的 registerScreen 决定）
    API.registerScreen("screen-purchase", "tabPurchase");
    API.registerScreen("screen-purchase-detail", "tabPurchase");

    $("purchTabOrder").onclick = function () {
      switchTab("order");
    };
    $("purchTabRestock").onclick = function () {
      switchTab("restock");
    };
    // 点底部「进货」那一格：回到上次停的页签（他天天看补货，别每次都点两下）
    var tabBtn = $("tabPurchase");
    if (tabBtn) {
      // ⚠️ purchase.js 也挂了 onclick 去切屏 + 拉单子，这里是**追加**，不能覆盖
      var prev = tabBtn.onclick;
      tabBtn.onclick = function (e) {
        if (prev) {
          prev.call(this, e);
        }
        if (!$("purchPaneRestock").hidden) {
          API.invoke("restockList");
        }
      };
    }

    // 草稿弹层：点遮罩空白处 = 取消（点卡片内部不取消）
    document.addEventListener(
      "click",
      function (e) {
        var t = e.target;
        if (t && t.id === "rsDraft") {
          state.draft = null;
          renderDraft();
          return;
        }
        var d = t && t.closest ? t.closest("[data-draft]") : null;
        if (d) {
          if (d.dataset.draft === "cancel") {
            state.draft = null;
            renderDraft();
          } else if (d.dataset.draft === "save") {
            saveDraft();
          }
        }
      },
      true,
    );

    // 回包
    API.on("restockState", function (m) {
      state.loaded = true;
      state.rows = Array.isArray(m.rows) ? m.rows : [];
      paintTabBadge();
      if (!$("purchPaneRestock").hidden) {
        render();
      }
    });
    API.on("restockSaved", function (m) {
      // 新建成功：把草稿关掉、列表等 restockState 来了再画（那份是权威）
      if (m && m.created) {
        state.openId = -1;
      }
    });
  }

  // ---------- 起手 ----------
  bind();
  paintTabs();
  // 恢复上次停的页签（只在**第一次**进页面时恢复；不给内存里存一个"用户的选择"，
  // 免得电脑上也跟着手机走）
  try {
    if (localStorage.getItem(TAB_KEY) === "restock") {
      switchTab("restock");
    }
  } catch (e) {
    /* 读不到就从进货单开始 */
  }
  render();
})();
