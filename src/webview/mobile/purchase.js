// 手机版「进货单」（补货单）—— **独立功能文件**，2026-10-15。
//
// 为什么单独一个文件：这块功能（底部「进货」那一格 + 两屏）跟商品那边没有耦合，
// 自己的状态、渲染、事件全在这儿，样式在 purchase.css，骨架在 index.html 里那两屏。
// 想整体摘掉：删本文件 + purchase.css + index.html 里那两屏 / 底部那一格 / 两行引入即可。
// ⚠️ 别再把这些逻辑塞回 app.js —— 它就是靠"只加一个文件"才能随时摘掉的。
//
// 它跟主页面之间只有一条**很窄的缝**：app.js 结尾的 window.Cherysis（取元素 / 发消息 /
// 弹提示 / 切屏 / 查商品 / 图片地址 / 注册屏幕 / 订阅回包）。见那边注释。
//
// 口径（详见 docs/进货单-设计方案.md）：
//   · 整单一个**带年份**的日期 + 一个整单备注；**不碰库存**（老板说库存统计现在不准）
//   · 每行：编号 / 需求数（要补多少，不是"补到多少"）/ 实拿数 / 已办勾 / 备注
//   · 整单状态由行**自动汇总**，不让人手填（手填一定跟数量打架、界面就在说谎）
//   · 改动**边改边存**（跟直播排品那张单一个套路）：整张单一次事务提交，不逐行存
//
// 2026-10-16 界面改版（他挑的档）：
//   · 首页＝**月历**：有单的日子带绿点，点日子出当日统计，再「打开填写」进去（全部单击，不用双击）
//   · 填表页＝**带小图的行**（B 档）：行首常驻 44px 小图（老板嫌"点击才看到图"不直观）、
//     需/拿还在行上直接输；点行展开**全名 / 备注 / 删行**
//   · 拿比需要多 → 拿那一格**自动染绿**（gotCls），缺了染橙，不多不少也是绿
//   · 「待拿 / 缺N / 齐」那颗徽标**撤了**（老板："代拿…很没有必要有点多余"）；
//     顶上"日期 + 保存提示"那行也撤了（标题里已经有日期）；「＋ 加一行」＝**屏幕底部一条浮动条**
//     （2026-10-16 晚从表头挪过去的：挂在上头，列表一长就得滚回顶上找它）；
//     两个出口（复制清单 / 导出 Excel）收进**顶栏一颗图标 + 弹层**（理由见 bind() 那段注释）
(function () {
  "use strict";

  // 主页面（app.js）结尾开的那条缝。拿不到说明脚本顺序不对（purchase.js 必须排在 app.js 之后）
  var API = window.Cherysis;
  if (!API) {
    return;
  }
  var $ = API.$;
  var esc = API.esc;
  var num = API.num;

  /** 打字停多久再整张存一次（毫秒）。手机上后端在共享盘上写，别每敲一键就发一单 */
  var SAVE_DELAY = 600;

  var state = {
    loaded: false, // 拉过一次没有（第一次进「进货」tab 时才拉）
    orders: [], // 后端给的全部单子（含 items），列表屏用
    // 正在编辑的那张单的**本地副本**：{ id, date, note, items:[{code,need,got,done,note}] }。
    // id=0 表示还没落库（第一次存下去之后由 purchaseSaved 回包填上）。
    draft: null,
    dirty: false,
    saving: false,
    pending: false, // 存的过程中又改了 → 存完再存一次
    saveTimer: null,
    // 月历（2026-10-16 改版）：首页是一张月历，calY/calM 是正在看的那个月（calM 从 0 起），
    // selDate 是点选中的那天。不设就默认今天。
    calY: 0,
    calM: 0,
    selDate: "",
    // 填表页（2026-10-16 改版）：行收成紧凑的一格，点行展开图/备注/删除 —— 这是展开中的行号，
    // -1 = 全收着。（一次只摊开一行，摊两行屏幕就又不够用了）
    openRow: -1,
    // 导出（2026-10-16）：电脑那头在压图/建表时置 true —— 顶栏那颗图标变淡 + 转圈、同时禁用，
    // 防连点（后端也有一个同样的闸）
    exportBusy: false,
    // 单内搜索（2026-10-16 晚，老板挑的**甲档**）：searchQ 是搜索词（含匹配编号/名称），
    // searchOpen 是那一行搜索框露没露 —— **默认收起**，顶栏那颗放大镜点开才出（不占内容高度）。
    searchQ: "",
    searchOpen: false,
  };

  // ---------- 小工具 ----------
  /** 本地今天 YYYY-MM-DD（不能用 toISOString：那是 UTC，晚上会差一天） */
  function todayStr() {
    var d = new Date();
    return (
      d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
    );
  }
  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }
  /** 数量显示：整数就不带小数点（0 → "" 让输入框空着，省得先删个 0） */
  function numStr(v) {
    var n = num(v);
    return n ? (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)) : "";
  }
  /** 供显示的数值：同上，但 0 显示成 "0" */
  function fmtNum(v) {
    var n = num(v);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }
  /** 显示宽度：中文/全角算 2 —— 复制出去的清单要在微信里对齐靠这个 */
  function dispWidth(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      w += s.charCodeAt(i) > 255 ? 2 : 1;
    }
    return w;
  }
  function padRight(s, w) {
    return s + " ".repeat(Math.max(1, w - dispWidth(s)));
  }
  /**
   * 编号归一：**纯数字 → 默认前缀 A + 补零到 3 位**。
   *   `6` / `06` / `006` / `a6` / `A6` → `A006`；`T5` → `T005`；`A1044` → `A1044`；
   *   `000`（0 号不存在）/ `XD`（两段都不成形）/ 空 → `null`。
   * ⚠️ 归一不了**不是错**：调用方保留原文照样记，界面上只是提示"没这个编号"
   *   （老板 10-16 拍的口径："归一不了的就记，只不过说没有这个编号罢了"）。
   *
   * ⚠️⚠️ **口径出处 ＝ `src/tools/shopTool/pricing.ts` 的 `canonicalCode()`**，别自己发明规则：
   *   后端 `handlers/purchase.ts` 保存时、桌面端直播排品输编号时、**手机版商品筛选的区间语法**
   *   （`1~33` 当 A1~A33，`app.js parseCodeTok`）用的都是它 —— 也就是说"纯数字算 A 段"
   *   本来就是这系统里既有的口径，进货单这一格当初漏了（界面说"没这个编号"、后端却存成 A006）。
   * 这里抄一份是为了守「独立功能文件」约定（功能自己的逻辑不许进 app.js）。
   * ⚠️ 改这里**必须同步**上面那几处；`check-purchase.cjs` 里有一条拿**后端编译产物**逐例比对的
   *   断言钉着（防两边悄悄漂开）。
   */
  function canonicalCode(raw) {
    var s = String(raw === undefined || raw === null ? "" : raw).trim();
    var m = s.match(/^([A-Za-z])(\d{1,4})$/);
    var prefix = "A";
    var digits;
    if (m) {
      prefix = m[1].toUpperCase();
      digits = m[2];
    } else {
      m = s.match(/^(\d{1,4})$/);
      if (m) {
        prefix = "A";
        digits = m[1];
      } else {
        return null;
      }
    }
    var n = Number(digits);
    if (!Number.isInteger(n) || n < 1 || n > 9999) {
      return null;
    }
    return prefix + String(n).padStart(3, "0");
  }
  function findProduct(code) {
    return API.findProductByCode(code);
  }
  function findOrder(id) {
    for (var i = 0; i < state.orders.length; i++) {
      if (num(state.orders[i].id) === num(id)) {
        return state.orders[i];
      }
    }
    return null;
  }
  /** "2026-10-15" → {y,m,d}；不是这个形状就给 null（别抛，单子数据可能不完整） */
  function dateParts(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s === undefined || s === null ? "" : s));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  var WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  /** 给人看的日期：10月15日 周四（月历/当日卡上用，年份在月历标题里有了就不重复） */
  function dateLabel(s) {
    var p = dateParts(s);
    if (!p) {
      return s || "(没写日期)";
    }
    return p.m + "月" + p.d + "日 周" + WEEK[new Date(p.y, p.m - 1, p.d).getDay()];
  }
  /**
   * 拿比需要多的时候染绿（他要的：多拿了一眼看出来）：over / under / ok。
   * 没需要或没拿就不染 —— 还没填完的行别染色，那是噪音。
   */
  function gotCls(it) {
    var need = num(it.need);
    var got = num(it.got);
    if (!need || !got) {
      return "";
    }
    if (got > need) {
      return "over";
    }
    if (got < need) {
      return "under";
    }
    return "ok";
  }

  /**
   * 行尾那个差额小字（2026-10-16 晚，老板挑的"丙档"）：多拿 `+6`（绿）、缺 `-4`（橙）。
   * 老板原话："填完了拿之后，就比如说加 6 什么显示一下，这样的话我也不用自己去算了。"
   *
   * ⚠️ **放法**：它挂在名称栏**里面**、贴着右端（CSS 的 `.pi-d`），**不是**新开一列 ——
   *   所以名称栏总宽没变，只是这一行的名称文字自己少显示一两个字（老板："名称栏短一点没关系"）。
   *   副作用是好的：**没差额的行 `.pi-d` 根本不渲染**，名称仍是满宽（新开一列的话那 26px 是白留的）。
   * ⚠️ **没拿（got=0）不显示**：那是"还没去拿"，不是"缺" —— 每行挂个橙色的 `-10` 就是当年那个
   *   「待拿」徽标，老板说过多余。正好（差 0）也不显示，那时"拿"格本来就是绿的。
   * 口径跟复制清单、汇总那行的"差"**必须一致**：fmtNum + 正数补 `+`。
   */
  function itemDiff(it) {
    var need = num(it.need);
    var got = num(it.got);
    if (!need || !got || got === need) {
      return null;
    }
    var d = got - need;
    return { txt: (d > 0 ? "+" : "") + fmtNum(d), over: d > 0 };
  }
  /** 展开块第二行的进价/售价（2026-10-17，老板：那句「商品库里有这个编号」没信息量，换成真有用的）。
   *  ⚠️ 跟 app.js 的 `money()` **同一格式**（¥ + 千分位、两位小数以内）—— 界面上同一种数不能两种写法。 */
  function fmtMoney(v) {
    return "¥" + (Math.round(num(v) * 100) / 100).toLocaleString("zh-CN");
  }

  // ---------- 整单汇总（自动算，不让人填）----------
  /**
   * 「这一款拿齐了没」= 需求数 > 0 且 实拿 >= 需求。
   * ⚠️ 这是**全项目唯一口径**（2026-10-16 撤掉人工「已办勾」之后立的）：
   *   整单状态、复制清单里那个 ✓、存库 `done` 那一列**全走它** —— 三处绝不能各写一遍
   *   （口径一漂，界面就在说谎，而这种事没人会当场发现）。
   */
  function isReady(it) {
    var need = num(it.need);
    return need > 0 && num(it.got) >= need;
  }
  /** 整单汇总：需求合计 / 实拿合计 / 差 / 款数 / 拿齐几款 / 整单状态 */
  function calcSummary(items) {
    var need = 0;
    var got = 0;
    var ready = 0; // 拿齐的款数
    var touched = 0; // 动过货的款数（拿 > 0）—— 用来分「还没开始」和「只拿了一部分」
    // ⚠️ **款数 = "有编号的行数"，不是 items.length**：没编号的空行不是一款货
    //    （老板 2026-10-16："这样的话就是一定是到时候共有多少个款对不对？"）。
    //    跟后端导出 Excel 那句"共 N 款"同一口径（那边 normExportItems 先滤掉空行）——
    //    改这里记得两头一起看，别又变成"屏幕上说 4 款、表格里说 3 款"。
    // ⚠️ 这里**不再按编号去重**：重复的编号根本到不了这一步 —— 编号一定稿就**自动并进已有那行**
    //    （见 mergeSameCode()），源头堵住了。真去重反而会算出"共 2 款 · 需 36"这种自相矛盾的数
    //    （款数去重了、数量还是两行相加）。
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].code || "").trim()) {
        n++;
      }
      need += num(items[i].need);
      got += num(items[i].got);
      if (isReady(items[i])) {
        ready++;
      }
      if (num(items[i].got) > 0) {
        touched++;
      }
    }
    var diff = got - need;
    var statusText;
    var cls;
    if (!n) {
      statusText = "空单";
      cls = "";
    } else if (ready === n) {
      statusText = "已完成";
      cls = "ok";
    } else if (touched === 0) {
      // ⚠️ 「还没开始」按"有没有动过货"判，**不按拿齐数** —— 一款款去拿、每款都少拿一点时，
      //    拿齐数是 0，但那明明已经在办了。
      statusText = "未开始";
      cls = "";
    } else {
      statusText = "已齐 " + ready + "/" + n;
      cls = "doing";
    }
    var line = "共 " + n + " 款 · 需 " + fmtNum(need) + " · 拿 " + fmtNum(got);
    if (n) {
      line += " · 差 " + (diff > 0 ? "+" : "") + fmtNum(diff);
    }
    return {
      need: need,
      got: got,
      diff: diff,
      ready: ready,
      total: n,
      statusText: statusText,
      cls: cls,
      line: line,
    };
  }

  // ---------- 列表屏：月历 + 当日卡（2026-10-16 改版） ----------
  // 老板要的：一进来先看日历（哪天补过货一眼扫完），点日子出当日统计，再进去填。
  // ⚠️ 双击不用 —— 手机上双击跟缩放手势打架、换个人也想不到，全部单击。
  /** 按日期把单子分堆（同一天可能不止一张：补了两次货就两张） */
  function ordersByDate() {
    var by = {};
    for (var i = 0; i < state.orders.length; i++) {
      var d = state.orders[i].date;
      if (d) {
        (by[d] = by[d] || []).push(state.orders[i]);
      }
    }
    return by;
  }
  /** 月历那一块（含 ‹ › 换月与"回到本月"） */
  function calHtml(byDate) {
    var y = state.calY;
    var m = state.calM;
    // 周一打头：getDay() 周日=0 → 换算成周一是第 0 格
    var first = (new Date(y, m, 1).getDay() + 6) % 7;
    var days = new Date(y, m + 1, 0).getDate();
    var h =
      '<div class="p-calnav">' +
      '<button class="mini" type="button" data-cal="-1">‹</button>' +
      "<b>" + y + " 年 " + (m + 1) + " 月</b>" +
      '<button class="mini" type="button" data-cal="1">›</button>' +
      "</div>" +
      '<div class="p-cal">';
    var wd = ["一", "二", "三", "四", "五", "六", "日"];
    for (var w = 0; w < wd.length; w++) {
      h += '<span class="p-wd">' + wd[w] + "</span>";
    }
    for (var b = 0; b < first; b++) {
      h += '<span class="p-d p-blank"></span>';
    }
    for (var d = 1; d <= days; d++) {
      var ds = y + "-" + pad2(m + 1) + "-" + pad2(d);
      h +=
        '<button class="p-d' + (ds === state.selDate ? " on" : "") + '" type="button" data-day="' + ds + '">' +
        d +
        (byDate[ds] ? '<span class="p-dot"></span>' : "") +
        "</button>";
    }
    h += "</div>";
    var t = dateParts(todayStr());
    if (t && (t.y !== y || t.m - 1 !== m)) {
      // 翻到别的月了给一条回来的路（顺手把选中日也带回今天）
      h += '<div class="p-todayrow"><button class="mini" type="button" data-cal-today="1">回到本月</button></div>';
    }
    return h;
  }
  /** 选中那天的卡：有单 → 每张一张卡（统计 + 打开填写 + 删除）；没单 → 新建入口 */
  function dayCardHtml(date, list) {
    var head = esc(dateLabel(date));
    if (!list || !list.length) {
      return (
        '<div class="po">' +
        '<div class="po-top"><span class="po-date">' + head + "</span></div>" +
        '<div class="po-sub muted small">这天还没有进货单。</div>' +
        '<div class="po-act"><button class="po-open primary" type="button" data-newday="' + esc(date) + '">新建这天的单</button></div>' +
        "</div>"
      );
    }
    var h = "";
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      var s = calcSummary(o.items || []);
      h +=
        '<div class="po" data-open="' + num(o.id) + '">' +
        '<div class="po-top"><span class="po-date">' + head + '</span><span class="po-st ' + s.cls + '">' + esc(s.statusText) + "</span></div>" +
        '<div class="po-sub muted small">' + esc(s.line) + "</div>" +
        (o.note ? '<div class="po-note muted small">备注：' + esc(o.note) + "</div>" : "") +
        '<div class="po-act">' +
        '<button class="po-del mini" type="button" data-del="' + num(o.id) + '">删除</button>' +
        '<button class="po-open primary" type="button" data-open="' + num(o.id) + '">打开填写</button>' +
        "</div></div>";
    }
    return h;
  }
  function renderList() {
    var box = $("purchaseList");
    if (!box) {
      return;
    }
    var t = dateParts(todayStr());
    if (!state.calY) {
      state.calY = t.y;
      state.calM = t.m - 1;
    }
    if (!state.selDate) {
      state.selDate = todayStr();
    }
    var byDate = ordersByDate();
    var html = calHtml(byDate) + dayCardHtml(state.selDate, byDate[state.selDate] || []);
    if (!state.orders.length) {
      // 空态留一行字：一片白看着像页面坏了
      html += '<p class="muted small p-empty">还没有进货单。挑个日子点「新建这天的单」—— 输编号、填要补多少，' + "攒好点「复制清单」发给去档口的人。</p>";
    }
    box.innerHTML = html;
  }

  // ---------- 详情屏：一张单 ----------
  function renderTitle() {
    var t = $("purchaseTitle");
    if (!t || !state.draft) {
      return;
    }
    t.textContent = state.draft.id ? "进货单 " + (state.draft.date || "") : "新建进货单";
  }
  function renderSummary() {
    var box = $("purchaseSummary");
    if (!box || !state.draft) {
      return;
    }
    var s = calcSummary(state.draft.items);
    // 2026-10-16 压成**一行**（原来是四行 kv 的卡，太占地方 —— 他要看的是商品）：
    // 共 N 款 · 需 x · 拿 y · 差 d · 进行中 1/3。挂在商品列表底下，不顶在最上面。
    box.textContent = s.line + (s.total ? " · " + s.statusText : "");
  }
  /**
   * 一行 = 带小图的一格（2026-10-16 B 档，老板挑的）：
   *   [小图 44] [编号] [名称…(差额小字)] [需] [拿]
   * 图**常驻在行上** —— 老板嫌"点击才看到图"不直观；行高约 56px（比原来紧凑行高一截），
   * 一屏约 11 款（原来 15 款，这是看图的代价）。点行展开**全名 / 备注 / 删行**（一次只摊一行）；
   * 需/拿还是**行上直接输**，录入不变慢。多拿的行：拿那一格自动染绿（gotCls），不用人标。
   * ⚠️ 「待拿 / 缺N / 齐」那颗徽标已撤（老板说多余）—— 缺多缺少看"拿"那格的颜色。
   * ⚠️ 「已办」那个勾 2026-10-16 晚也撤了（老板："勾选那个好没有必要吧"）：
   *    手工勾是一步多余的动作（填了"拿"其实就说明办了），现在**拿齐没拿齐由 isReady() 自动算**，
   *    行上少一格（名称那一栏多出 26px）。连带：整单状态、复制清单的 ✓ 都改走 isReady()。
   * ⚠️ 2026-10-16 晚又加回**差额小字**（`itemDiff()`，老板要的"不用自己算"）：
   *    它挂在名称栏**里面**贴着右端、只在真有差额时才渲染 → 名称栏总宽没变、没差额的行还是满宽。
   */
  function itemHtml(it, i) {
    var p = findProduct(it.code);
    var gc = gotCls(it);
    var df = itemDiff(it);
    var hasCode = !!String(it.code || "").trim();
    // 名称：有编号就现查（图片按编号存在共享盘上）；查不到不是错 —— 单子里的编号
    // 未必都在商品库里，照样记。空行给一句短的（行里放不下长句子）。
    var nameTxt;
    var nameCls;
    if (!hasCode) {
      nameTxt = "（先输编号）";
      nameCls = "muted";
    } else if (p) {
      nameTxt = p.name || "(这个商品没写名称)";
      nameCls = "";
    } else {
      nameTxt = "没这个编号（照样记）";
      nameCls = "warn";
    }
    // 行内小图：**空行不取图**（只出一格「编号」占位，省一次请求）；取不到（404）由 onerror
    // 抹掉 img、露出底下的「无图」占位 —— 不留破图、也不留一片空。
    var thumb = hasCode
      ? '<span class="pi-thumb"><span class="noph">无图</span><img src="' +
        esc(API.imgUrl(it.code, "", "thumb")) +
        '" alt="" loading="lazy" onerror="this.remove()" /></span>'
      : '<span class="pi-thumb"><span class="noph">编号</span></span>';
    var open = state.openRow === i;
    var h =
      // ⭐ 展开与否只体现在这一个 class 上（2026-10-17）：**每行的展开块都画出来**、CSS 默认收着，
      //    点行只是切 .open —— 不再整块重画。整块重画 = 所有 <img> 重新请求+解码 = 整列闪一下。
      '<div class="pit' + (open ? " open" : "") + '" data-i="' + i + '">' +
      '<div class="pit-row">' +
      thumb +
      '<input class="pi-code" type="text" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="编号" value="' +
      esc(it.code) + '" />' +
      '<span class="pit-name ' + nameCls + '"><span class="pit-nm">' + esc(nameTxt) + "</span>" +
      // 差额小字挂在名称栏的**里面**（名称栏总宽不变，名称自己早一点截断）—— 见 itemDiff()
      (df ? '<span class="pi-d ' + (df.over ? "over" : "under") + '">' + esc(df.txt) + "</span>" : "") +
      "</span>" +
      '<input class="pi-need" type="number" inputmode="decimal" min="0" step="1" placeholder="0" value="' +
      esc(numStr(it.need)) + '" />' +
      '<input class="pi-got' + (gc ? " " + gc : "") + '" type="number" inputmode="decimal" min="0" step="1" placeholder="0" value="' +
      esc(numStr(it.got)) + '" />' +
      "</div>";
    // 展开块**每行都有**（CSS 默认 display:none，行带 .open 才露）——
    // 点行展开从此只切 class、不重画列表（原来 `if (open)` 条件渲染是"整列图片闪一下"的根源）。
    h +=
      '<div class="pit-x">' +
      '<div class="pit-xrow">' +
      '<div class="pit-info">' +
      '<div class="pit-full">' + (hasCode ? esc(it.code) + " " + esc(p ? p.name || "(这个商品没写名称)" : "") : "先输编号，名称和图片自动带出来") + "</div>" +
      // 第二行（2026-10-17，老板定的）：库里有 → **进价 / 售价**（档口现场对照着算账，比一句
      // 「商品库里有这个编号」有用得多）；库里没有 → 那句提示**靠右 + 更淡**，别占正位。
      (hasCode
        ? '<div class="pit-sub muted small' + (p ? "" : " pit-sub-r") + '">' +
          (p ? "进价 " + fmtMoney(p.cost_price) + " · 售价 " + fmtMoney(p.sale_price) : "商品库里没有这个编号（照样记进单子）") +
          "</div>"
        : "") +
      "</div>" +
      // 删行＝**垃圾桶图标**（2026-10-17，老板嫌「删这行」太口语化）：
      // 跟顶栏那套同款单色线性 SVG（viewBox 24 + stroke 1.9），CSS 里染危险红。
      // ⚠️ 热区在 CSS 给 44×44（图标本身只画 20px）—— 手指够得着，别为了小图标牺牲可点面积。
      '<button class="pit-del" type="button" aria-label="删除这一行" title="删除这一行">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 6h18" />' +
      '<path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />' +
      '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />' +
      '<path d="M10 11v6" />' +
      '<path d="M14 11v6" />' +
      "</svg></button>" +
      "</div>" +
      '<input class="pi-note" type="text" placeholder="备注（如：档口只剩 6 条）" value="' + esc(it.note) + '" />' +
      "</div>";
    return h + "</div>";
  }
  /** 搜索词（空 = 不筛，整单都显示） */
  function searchKeyword() {
    return String(state.searchQ || "").trim();
  }
  /** 这一行匹配搜索词吗：编号或名称**包含**就行（不区分大小写）。
   *  ⚠️ 故意不做商品列表页那套"区间语法"（`A1~A33`）：那边是"筛商品库"，这边要的是
   *     "这单里有没有它"，包含匹配足够；而且他敲 `006` 照样能命中 `A006`。 */
  function rowMatches(it, kw) {
    if (!kw) {
      return true;
    }
    var k = kw.toLowerCase();
    if (String(it.code || "").toLowerCase().indexOf(k) >= 0) {
      return true;
    }
    var p = findProduct(it.code);
    return String(p && p.name ? p.name : "").toLowerCase().indexOf(k) >= 0;
  }
  /** 搜索行露不露、框里的字跟 state 对齐（只动这两样，不重画列表） */
  function applySearchRow() {
    var row = $("purchaseSearchRow");
    if (row) {
      row.hidden = !state.searchOpen;
    }
    var inp = $("purchaseSearch");
    if (inp && inp.value !== state.searchQ) {
      inp.value = state.searchQ;
    }
  }
  function renderItems() {
    var box = $("purchaseItems");
    if (!box || !state.draft) {
      return;
    }
    if (!state.draft.items.length) {
      box.innerHTML =
        '<p class="muted small">还没有商品。点下面那条「＋ 加一行」，输编号就行（会自动带出名称和图片）。</p>';
      return;
    }
    var items = state.draft.items;
    var kw = searchKeyword();
    // ⚠️ i 是**在 items 里的真实下标**（不是筛完之后的序号）：data-i、改数量、删行、展开全靠它 ——
    //    拿过滤后的序号去标会串到别的商品上（改 A006 的数量结果改到了 A012）。
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      if (rowMatches(items[i], kw)) {
        rows.push(itemHtml(items[i], i));
      }
    }
    // 表头跟着行的列宽走（同一套 flex + gap，对得齐）；himg 那格对齐行内小图
    var head =
      '<div class="pit-head"><span class="himg"></span><span class="hcode">编号</span>' +
      '<span class="hname">名称</span><span class="hnum">需</span><span class="hnum">拿</span></div>';
    // 搜不到不留白屏（跟别处"空态要有一句话"一个规矩）；表头留着，列宽还有个参照
    var body = rows.length
      ? rows.join("")
      : '<p class="muted small">这单里没有编号或名称带「' + esc(kw) + "」的行。</p>";
    box.innerHTML = head + body;
  }
  function renderDetail() {
    if (!state.draft) {
      return;
    }
    $("purchaseNote").value = state.draft.note || "";
    renderTitle();
    renderSummary();
    applySearchRow(); // 搜索行露不露跟着 state（换单时已经清空，见 openOrder）
    renderItems();
  }
  function focusLastCode() {
    var box = $("purchaseItems");
    if (!box) {
      return;
    }
    var els = box.querySelectorAll(".pi-code");
    var el = els[els.length - 1];
    if (el) {
      try {
        el.focus();
      } catch (e) {
        /* 某些 WebView 不让脚本聚焦，忽略 */
      }
    }
  }

  /**
   * 打开一张单（id=0 → 新建）。
   *
   * ⚠️ **同一张单、而且本地还有"没落定的改动"**时保留本地草稿，别拿服务端那份：
   * 存和拉是两条异步路，刚从详情退回列表又马上点回来时，服务端那份可能还是旧的 ——
   * 用它重建就等于把刚打的字吞了。所以除了 dirty，**正在存 / 还攒着一笔**也算"没落定"。
   *
   * ⚠️ forceNew：点「＋ 新建」时必须**换一张新的**，不能因为"当前也是 id=0 的草稿"就复用 ——
   * 那样连点两次新建会看到同一张单（刚打了一半的东西还在），像按钮坏了。
   */
  function openOrder(id, forceNew, date) {
    var same =
      !forceNew &&
      state.draft &&
      num(state.draft.id) === num(id) &&
      (state.dirty || state.saving || state.pending);
    if (same) {
      renderDetail();
    } else {
      var src = id ? findOrder(id) : null;
      state.draft = src
        ? {
            id: num(src.id),
            date: src.date || todayStr(),
            note: src.note || "",
            items: (src.items || []).map(function (it) {
              // ⚠️ 不再读 it.done：库里那一列是"拿齐"的冗余副本，真口径在 isReady()（拿/需一改它自己就变）。
              return {
                code: it.code || "",
                need: num(it.need),
                got: num(it.got),
                note: it.note || "",
              };
            }),
          }
        : { id: 0, date: date || todayStr(), note: "", items: [] };
      state.dirty = false;
      state.openRow = -1; // 换了一张单，展开中的行号没意义了
      state.searchQ = ""; // 搜索也一起清：上一张单筛的词对这张单没意义（搜索行也收起来）
      state.searchOpen = false;
      // 新建时先白送一行空的：进来就能直接输编号，不用再点一次「＋ 加一行」。
      // ⚠️ 这一行**不算改动**（没编号的行后端也不会存）—— 否则"掀开看一眼又退出去"会留下一张空单
      if (!src) {
        state.draft.items.push({ code: "", need: 0, got: 0, note: "" });
      }
      renderDetail();
    }
    API.show("screen-purchase-detail");
    if (!id) {
      focusLastCode();
    }
  }

  // ---------- 边改边存 ----------
  // ⚠️ 2026-10-16：原来顶栏下面有一行「保存中… / 已保存」的小字（#purchaseSaveHint），
  // 跟"日期那一行"一起撤掉了（老板要位置）。现在**只有存失败才弹一句 toast** ——
  // 改动本来就是边改边存，成功不用一次次地打扰。
  function markDirty() {
    if (!state.draft) {
      return;
    }
    state.dirty = true;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
    }
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      save();
    }, SAVE_DELAY);
  }
  function save() {
    var d = state.draft;
    if (!d || !state.dirty) {
      return;
    }
    if (state.saving) {
      state.pending = true; // 上一条还在路上：等它回来说
      return;
    }
    // 行整表替换（跟后端口径一致）：空编号的行在这儿就丢掉
    var items = [];
    for (var i = 0; i < d.items.length; i++) {
      if (String(d.items[i].code || "").trim()) {
        items.push({
          code: d.items[i].code,
          need: num(d.items[i].need),
          got: num(d.items[i].got),
          // 库里那列还在（后端没动，不必为一行 UI 改动去动表结构）；值由 isReady() 算，不是人工勾的
          done: isReady(d.items[i]) ? 1 : 0,
          note: d.items[i].note || "",
        });
      }
    }
    // 还没落库、又是一行都没有 → 什么都不用存（别在库里留一张空单）
    if (!items.length && !d.id) {
      state.dirty = false;
      return;
    }
    state.saving = true;
    state.dirty = false;
    API.invoke("purchaseSaveOrder", { id: d.id || 0, date: d.date, note: d.note, items: items })
      .then(function () {
        state.saving = false;
        if (state.pending) {
          state.pending = false;
          save();
        }
      })
      .catch(function () {
        state.saving = false;
        state.dirty = true; // 没存上：留着，等下一次改动或返回时再试
        API.toast("没存上，退出去之前再试一次", true);
      });
  }
  /** 立刻结算（返回 / 切走 tab / 页面要走了的时候），别等那个 debounce */
  function flush() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    save();
  }

  // ---------- 复制清单 ----------
  /**
   * 拼成给去档口的人看的纯文本（这就是"省掉截图"的那一步）：
   *   【补货单 2026-10-15】
   *   A001 白T中码     需20  拿23  +3
   *   A015 黑裤L       需10  拿6   -4   ｜档口只剩6条
   *   共 2 款 · 需 30 · 拿 29 · 差 -1
   * 拿齐的行前面**自动**加 ✓（2026-10-16 撤掉人工勾之后，这个 ✓ 由 isReady() 算出来，
   * 不再等人去勾 —— 发给别人时对方一眼看出哪几款已经拿齐了）。
   */
  function copyText() {
    var d = state.draft;
    var lines = ["【补货单 " + (d.date || "") + "】"];
    var rows = d.items
      .filter(function (it) {
        return String(it.code || "").trim();
      })
      .map(function (it) {
        var p = findProduct(it.code);
        var nm = p && p.name ? p.name : "";
        var label = (isReady(it) ? "✓ " : "") + it.code + (nm ? " " + nm : "");
        return { it: it, label: label };
      });
    var w = 0;
    for (var i = 0; i < rows.length; i++) {
      w = Math.max(w, dispWidth(rows[i].label));
    }
    for (var j = 0; j < rows.length; j++) {
      var it = rows[j].it;
      var got = num(it.got);
      var d2 = got - num(it.need);
      var seg = "需" + fmtNum(it.need) + " 拿" + fmtNum(got);
      // ⚠️ 差 0 不写：跟行上"正好不显示差额"同一个口径（原来这儿会写成 `需10 拿10 0`，
      //    那个孤零零的 0 看着像乱码；列表里也不该出现"正好"这个信息 —— 对齐的列已经说清了）
      if (got && d2 !== 0) {
        seg += " " + (d2 > 0 ? "+" : "") + fmtNum(d2);
      }
      var line = padRight(rows[j].label, w + 2) + seg;
      if (it.note) {
        line += "  ｜" + it.note;
      }
      lines.push(line);
    }
    if (d.note) {
      lines.push("备注：" + d.note);
    }
    var s = calcSummary(d.items);
    lines.push(
      "共 " + s.total + " 款 · 需 " + fmtNum(s.need) + " · 拿 " + fmtNum(s.got) +
        " · 差 " + (s.diff > 0 ? "+" : "") + fmtNum(s.diff),
    );
    return lines.join("\n");
  }
  function doCopy() {
    if (!state.draft || !state.draft.items.length) {
      API.toast("这张单还没有商品", true);
      return;
    }
    flush(); // 先把这一版存住，免得复制出去的和库里那份对不上
    var text = copyText();
    // ⚠️ 局域网是**纯 HTTP**，navigator.clipboard 在非安全上下文里根本不存在 ——
    //    所以这里真正的常用路径其实是下面那个 execCommand 兜底，别把兜底当"备用"。
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          API.toast("已复制清单，去微信粘贴吧");
        },
        function () {
          legacyCopy(text);
        },
      );
    } else {
      legacyCopy(text);
    }
  }
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    if (ok) {
      API.toast("已复制清单，去微信粘贴吧");
    } else {
      // 真复制不了就摊开给他自己长按复制（总比什么都不做强）
      showCopySheet(text);
    }
  }
  /** 复制不了时的兜底浮层：把清单摊在一个只读框里，长按全选复制 */
  function showCopySheet(text) {
    var wrap = document.createElement("div");
    wrap.className = "p-copysheet";
    wrap.innerHTML =
      '<div class="p-csbox">' +
      '<div class="p-cshead">复制不了，长按选中下面这段再复制</div>' +
      '<textarea class="p-cstext" readonly></textarea>' +
      '<button class="p-csclose primary" type="button">知道了</button>' +
      "</div>";
    wrap.querySelector(".p-cstext").value = text;
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.classList.contains("p-csclose")) {
        wrap.remove();
      }
    });
    document.body.appendChild(wrap);
  }

  // ---------- 导出（2026-10-16 新增；同日砍到只剩 Excel 一条路） ----------
  /**
   * 把屏幕上这份清单交给电脑端出文件。**电脑上不留文件** —— 产物 base64 随回包给过来
   * （老板要用的时候是在手机上，电脑那台不该堆一堆导出的成品），手机端解成 Blob 下载（WPS 打开）。
   * 压图/建表都在电脑那头跑（长任务队列；网页版是"排队立刻返回"，终态只走 SSE）。
   *
   * ⚠️ 「生成 HTML」那条路**已删**（老板拍的板，理由见 handlers/purchase.ts 顶部）——
   * 别再加回来：WPS / 微信都不渲染内嵌 data: 图片，发给别人看它最脆。
   * ⚠️ 微信内置浏览器会拦 a[download]：要用主屏图标（真浏览器）打开才下得动。
   *
   * 入口在**顶栏那颗图标 → 弹层**里（#purchaseSheet 的「导出 Excel」那一项）。
   */
  var EXPORT_MSG = "purchaseExportXlsx";
  /** 忙碌态：置 true 时顶栏那颗图标变淡 + 转圈（图标按钮写不下"生成中…"） */
  function setExportBusy(on) {
    state.exportBusy = !!on;
    var btn = $("purchaseMoreBtn");
    if (btn) {
      btn.disabled = !!on;
      btn.classList[on ? "add" : "remove"]("busy");
    }
  }
  function startExport() {
    if (!state.draft || !state.draft.items.length) {
      API.toast("这张单还没有商品", true);
      return;
    }
    if (state.exportBusy) {
      return;
    }
    flush(); // 先把这一版存住 —— 电脑端压图、查名称，得对着最新这份
    setExportBusy(true);
    // 与后端同口径：滤掉空编号行（没填完的行不进导出）
    var items = [];
    for (var i = 0; i < state.draft.items.length; i++) {
      if (String(state.draft.items[i].code || "").trim()) {
        items.push({
          code: state.draft.items[i].code,
          need: num(state.draft.items[i].need),
          got: num(state.draft.items[i].got),
          // done 跟着一起传：库里那列还在（后端没动），值就是 isReady() 算出来的"拿齐"
          done: isReady(state.draft.items[i]) ? 1 : 0,
          note: state.draft.items[i].note || "",
        });
      }
    }
    API.invoke(EXPORT_MSG, {
      date: state.draft.date,
      note: state.draft.note || "",
      items: items,
    }).catch(function () {
      // invoke 本身挂了（断线等）：复位，让人能再点
      setExportBusy(false);
      API.toast("没连上电脑，等会儿再试", true);
    });
  }
  /** 回包里的 file 是电脑上的文件名（可能带路径）：只取尾段当下载名 */
  function fileNameOf(m, fallback) {
    var name = String((m && m.file) || "").split(/[\\/]/).pop();
    return name || fallback;
  }
  /** 触发浏览器下载（手机上进"下载"目录，电脑上进浏览器的下载目录） */
  function triggerDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 10000);
  }
  /** base64 → 字节 → Blob 下载（xlsx 走这条：二进制不能当字符串塞） */
  function downloadBase64(b64, name, mime) {
    var bin = atob(String(b64 || ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    triggerDownload(new Blob([bytes], { type: mime }), name);
  }

  // ---------- 顶栏那颗图标点开的弹层（复制清单 / 导出 Excel） ----------
  /**
   * 为什么并成一颗图标：老板原话"复制清单和这个两个在一起好别扭…两个图标好丑" ——
   * 文字按钮 + 图标混排最难看。合成一颗后：顶栏只占一格（内容区一行都不花），
   * 而且**顶栏在滚动区之外** → 单子再长它都在，不用翻到底（原先"导出吸底"那个诉求也拿到了）。
   * 代价：每次出口多一步（点图标 → 选一项）。两项都是一单只用一次的动作，值得。
   * 样式复用全局 .sheetbg / .sheet（跟「改一个值」那个 sheet 同款，会从底部滑上来）。
   */
  function openSheet() {
    var s = $("purchaseSheet");
    if (s) {
      s.classList.add("show");
    }
  }
  function closeSheet() {
    var s = $("purchaseSheet");
    if (s) {
      s.classList.remove("show");
    }
  }

  // ---------- 编号定稿那一下：撞车合并 + 自动排序（2026-10-16 晚，老板拍的两条）----------
  /** 编号排序键：字母 + 数字。⚠️ 数字按**数值**比，不能按字面 —— 按字面 "A1044" 会排到 "A999" 前面。
   *  没编号、或归一不了的编号（XD 这种）返回 null → 排序时一律留最后，彼此保持原有先后。 */
  function codeKey(code) {
    var m = String(code || "").match(/^([A-Za-z])(\d{1,4})$/);
    if (!m) {
      return null;
    }
    return { p: m[1].toUpperCase().charCodeAt(0), n: Number(m[2]) };
  }
  /** 编号升序（字母→数字）。⚠️ 依赖 Array#sort 的**稳定性**（ES2019 起规范要求；V8/JSC 早就是了）——
   *  靠它保住"没编号的那几行之间"的原有先后，别改成不稳定算法。 */
  function cmpCode(a, b) {
    var ka = codeKey(a.code);
    var kb = codeKey(b.code);
    if (!ka && !kb) {
      return 0;
    }
    if (!ka) {
      return 1;
    }
    if (!kb) {
      return -1;
    }
    return ka.p === kb.p ? ka.n - kb.n : ka.p - kb.p;
  }
  /** 这单里**别的**行有没有同一个编号（没有 → -1）。只看编号本身，空编号不算撞车。 */
  function findSameCodeAt(idx) {
    var items = state.draft.items;
    var c = String(items[idx].code || "");
    if (!c) {
      return -1;
    }
    for (var i = 0; i < items.length; i++) {
      if (i !== idx && String(items[i].code || "") === c) {
        return i;
      }
    }
    return -1;
  }
  /**
   * 合并的**算法本体**（纯函数，只动传进来的两行）：需相加、拿相加；备注**以已有那行为准**，
   * 新行写了就拼在后面（别丢他刚打的信息）。返回 {before, after} 给提示用。
   * ⚠️ 单独抽出来是为了能单测 —— 合并把数字改错了**没人会当场发现**，这种事必须钉死。
   */
  function mergeItems(from, into) {
    var before = num(into.need);
    into.need = before + num(from.need);
    into.got = num(into.got) + num(from.got);
    var fn = String(from.note || "").trim();
    if (fn) {
      var inNote = String(into.note || "").trim();
      into.note = inNote ? inNote + "；" + fn : fn;
    }
    return { before: before, after: num(into.need) };
  }
  /**
   * 编号撞车 → **自动并进已有的那一行**（老板 2026-10-16 拍的板："首先你得有提示，然后自动编进去"）。
   *
   * ⚠️ 这里**不重建 DOM**（只删掉那一格的节点 + 把后面的行号往前挪）：change（失焦）**早于**他点的那一下，
   *    重建会让他点空（点下去那一格已经被换掉了）→ 手机上表现为"点了一下没反应、得再点一次"。
   * 提示是他要的"你得有提示"：toast 说清并到哪去了、数量从多少变成多少，目标行再闪一下浅绿。
   */
  function mergeSameCode(fromIdx, intoIdx) {
    var items = state.draft.items;
    var into = items[intoIdx];
    var mm = mergeItems(items[fromIdx], into);
    void mm; // 合并（需/拿相加、备注拼接）本身有副作用；返回的 before/after 现在不上提示了
    items.splice(fromIdx, 1);
    // 展开的行跟着走：删掉的正好是它 → 收起；在它后头的 → 往前挪一格
    if (state.openRow === fromIdx) {
      state.openRow = -1;
    } else if (state.openRow > fromIdx) {
      state.openRow--;
    }
    removeRowDom(fromIdx);
    if (!canMoveRows() || !moveRowsInOrder()) {
      renderItems(); // 兜底：DOM 不是"逐行节点"那套形状（理论上不会）→ 只好整块重画
    }
    markRow(into); // 持续高亮那一行（不是闪一下）—— 他不用再去列里找"并到哪去了"
    // ⚠️ 提示就一句话（老板 2026-10-16："你就写已经有过了，已并进那一行就可以了，不用再说其他的了"）。
    //    别再往里塞 `A006` 前缀或"需 20 → 26" —— 那一行本来就在闪绿，位置和数字他自己看得见。
    API.toast("已经有过了，已并进那一行");
  }
  /** 行清单的 DOM 现在是不是"一行一个 .pit 节点、行号 = data-i"那套形状（移动节点的前提） */
  function canMoveRows() {
    var box = $("purchaseItems");
    if (!box || !state.draft || !state.draft.items.length) {
      return false;
    }
    return box.querySelectorAll(".pit").length === state.draft.items.length;
  }
  /** 删掉第 idx 行的节点，并把它后面那些节点的行号往前挪一格（**不动别的节点** → 焦点不丢） */
  function removeRowDom(idx) {
    var box = $("purchaseItems");
    if (!box) {
      return;
    }
    var nodes = box.querySelectorAll(".pit");
    for (var n = 0; n < nodes.length; n++) {
      var el = nodes[n];
      var i = num(el.dataset.i);
      if (i === idx) {
        el.remove();
      } else if (i > idx) {
        el.dataset.i = String(i - 1);
      }
    }
  }
  /** 把现有的行节点按 data-i 的顺序重新挂一遍（appendChild 会把节点从原位置摘走）。
   *  ⚠️ **只挪节点、不重建**：他刚点的那个输入框还是同一个元素，焦点和键盘都不受影响。
   *  用在"删掉了一行"之后（那时 data-i 已经被 removeRowDom 重编好了）。 */
  function moveRowsInOrder() {
    var box = $("purchaseItems");
    if (!box) {
      return false;
    }
    var nodes = box.querySelectorAll(".pit");
    var byIdx = {};
    for (var n = 0; n < nodes.length; n++) {
      byIdx[num(nodes[n].dataset.i)] = nodes[n];
    }
    for (var i = 0; i < state.draft.items.length; i++) {
      if (byIdx[i]) {
        box.appendChild(byIdx[i]);
      }
    }
    return true;
  }
  /**
   * 排序之后：把行节点的**行号重编**、再按新顺序挂好（仍然只挪节点，不重建）。
   * `before` = 排序前的 items 快照 —— 节点上的 data-i 就是那份快照的下标，靠它认"这个节点是谁"。
   * 形状对不上（节点数 ≠ 快照长度）→ 返回 false，让调用方整块重画兜底。
   */
  function reorderRows(before) {
    var box = $("purchaseItems");
    if (!box) {
      return false;
    }
    var items = state.draft.items;
    var nodes = box.querySelectorAll(".pit");
    if (nodes.length !== before.length) {
      return false;
    }
    var byIdx = {};
    for (var n = 0; n < nodes.length; n++) {
      var el = nodes[n];
      var at = items.indexOf(before[num(el.dataset.i)]);
      if (at < 0) {
        return false;
      }
      el.dataset.i = String(at);
      byIdx[at] = el;
    }
    for (var i = 0; i < items.length; i++) {
      if (byIdx[i]) {
        box.appendChild(byIdx[i]);
      }
    }
    return true;
  }
  /** 点行 = 摊开 / 收起这一行：**只切 `.open` 这一个 class，绝不重画列表**。
   *  原来这里是整块 `renderItems()` —— 列表里所有 `<img>` 都重建、重新请求 + 解码，
   *  表现就是"点一个商品，其他商品跟着闪一下"（2026-10-17 老板撞上的），列表越长越明显。
   *  展开块现在**每行都画**（CSS 默认收着，行带 `.open` 才露），所以切 class 就够了。
   *  ⚠️ `state.openRow` 仍要维护：`mergeSameCode` / `sortDraftItems` / 删行都靠它知道"摊开的是哪一行"。 */
  function toggleOpenRow(i, box) {
    var prev = state.openRow;
    var next = prev === i ? -1 : i;
    state.openRow = next;
    if (!box || !box.querySelector) {
      return next;
    }
    // 互斥：同时只摊一行 —— 旧的摘掉、新的挂上（节点找不到就跳过，别抛）
    if (prev >= 0) {
      var p = box.querySelector('.pit[data-i="' + prev + '"]');
      if (p && p.classList) {
        p.classList.remove("open");
      }
    }
    if (next >= 0) {
      var n = box.querySelector('.pit[data-i="' + next + '"]');
      if (n && n.classList) {
        n.classList.add("open");
      }
    }
    return next;
  }
  /** 让某一行闪一下浅绿（CSS 动画 `.pit.fresh`）。
   *  ⚠️ 动画同一个元素上只播一次 —— 所以先摘掉 class、逼一次重排、再加回去，才会重播。 */
  /** 把"刚落位那一行"的持续高亮撤掉（他一动手 / 换单就撤） */
  function clearHit() {
    var box = $("purchaseItems");
    if (!box) {
      return;
    }
    var els = box.querySelectorAll(".pit.hit");
    for (var i = 0; i < els.length; i++) {
      els[i].classList.remove("hit");
    }
  }
  /**
   * 标出"刚落到这儿的那一行"（撞车**并进去**的 / 排序后**挪过去**的）—— **持续高亮**，不是闪一下。
   *
   * 老板 2026-10-16："你先帮我高亮在哪里，难道还要去眼睛找多麻烦呀" ——
   *   原来只有 `flashRow` 那 1.3 秒的浅绿，手机上（键盘一挡、行还可能滚出屏幕）他根本没看见，
   *   于是并进去了还得自己一列列去找。所以现在：一直亮着，直到他**下一次动手**
   *   （打字 / 再定稿一个编号 / 换单），一眼就看得到"它落哪去了"。
   *
   * ⚠️ 手机键盘一挡，光高亮也不行 → 顺手滚一下，但只滚**"看不见才滚"的最小距离**
   *   （`block:"nearest"`：已经在屏幕里就**一点都不滚**，不会把他正看的地方拽走）。
   * ⚠️ 左边那条用 CSS 的 `inset box-shadow` 画，不用 `border-left` —— border 会把整行往右挤、跟表头错位。
   */
  function markRow(item) {
    var box = $("purchaseItems");
    if (!box || !state.draft) {
      return false;
    }
    var i = state.draft.items.indexOf(item);
    if (i < 0) {
      return false;
    }
    var el = box.querySelector('.pit[data-i="' + i + '"]');
    if (!el) {
      return false;
    }
    clearHit(); // 同时只留一行带标记
    el.classList.add("hit");
    // 落位那一下再"弹"一下。⚠️ 动画在同一元素上只播一次 → 摘 class、逼一次重排、再加回
    el.classList.remove("fresh");
    void el.offsetWidth;
    el.classList.add("fresh");
    if (el.scrollIntoView) {
      try {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch (e) {
        try {
          el.scrollIntoView();
        } catch (e2) {
          /* 老 WebView 不认参数就算了 —— 高亮还在，不影响他找 */
        }
      }
    }
    return true;
  }
  /**
   * 按编号给整张单排一次序，返回"刚才那一行"排序后的新下标（-1 = 它没了）。
   * ⚠️ **只在编号定稿时调**：他填「拿」的时候绝不重排 —— 档口现场刚填完一行就换位置，
   *    手就找不着刚才那行了。
   * ⚠️ 展开的行（openRow）要跟着它**自己**走，不能跟着下标走（不然展开块会串到别的商品上）。
   */
  function sortDraftItems(focusItem) {
    var items = state.draft.items;
    var openItem = state.openRow >= 0 ? items[state.openRow] : null;
    items.sort(cmpCode);
    state.openRow = openItem ? items.indexOf(openItem) : -1;
    return focusItem ? items.indexOf(focusItem) : -1;
  }

  // ---------- 行内编辑：只更这一格，不整块重画 ----------
  /** 改完需求/实拿之后，只刷这一行"拿"的染色 + 行尾差额小字 + 顶部汇总（重画整块会把焦点冲掉）
   *  ⚠️ 撤掉「已办勾」之后，这里就只剩"需/拿"两格会触发了（原来还有勾）。
   *  ⚠️ 差额小字是**随着打字长出来/消失**的（边输边算，老板要的就是"不用自己算"）：
   *     所以不只是改文字 —— 没差额要把节点**删掉**（不然名称栏白少一块）。 */
  function updateRowLive(i) {
    var box = $("purchaseItems");
    var row = box ? box.querySelector('.pit[data-i="' + i + '"]') : null;
    if (row) {
      var it = state.draft.items[i];
      var got = row.querySelector(".pi-got");
      if (got) {
        var gc = gotCls(it);
        got.className = "pi-got" + (gc ? " " + gc : "");
      }
      var nmBox = row.querySelector(".pit-name");
      if (nmBox) {
        var df = itemDiff(it);
        var el = nmBox.querySelector(".pi-d");
        if (!df) {
          if (el) {
            el.remove();
          }
        } else {
          if (!el) {
            el = document.createElement("span");
            nmBox.appendChild(el);
          }
          el.className = "pi-d " + (df.over ? "over" : "under");
          el.textContent = df.txt;
        }
      }
    }
    renderSummary();
  }
  /** 编号改了：只刷这一行的名称 + 行内小图（不动输入框，免得手还在那儿） */
  function refreshRowName(i) {
    var box = $("purchaseItems");
    var it = state.draft.items[i];
    var row = box ? box.querySelector('.pit[data-i="' + i + '"]') : null;
    if (!row || !it) {
      return;
    }
    var hasCode = !!String(it.code || "").trim();
    var p = findProduct(it.code);
    var nm = row.querySelector(".pit-nm");
    if (nm) {
      if (!hasCode) {
        nm.textContent = "（先输编号）";
        nm.parentElement.className = "pit-name muted";
      } else if (p) {
        nm.textContent = p.name || "(这个商品没写名称)";
        nm.parentElement.className = "pit-name";
      } else {
        nm.textContent = "没这个编号（照样记）";
        nm.parentElement.className = "pit-name warn";
      }
    }
    // 行内小图：有编号就换成去取图的那版（跟 itemHtml 里那段同一个口径）
    var thumb = row.querySelector(".pi-thumb");
    if (thumb) {
      thumb.innerHTML = hasCode
        ? '<span class="noph">无图</span><img src="' + esc(API.imgUrl(it.code, "", "thumb")) + '" alt="" loading="lazy" onerror="this.remove()" />'
        : '<span class="noph">编号</span>';
    }
    // 展开块里的全名/提示（没展开就没有这些节点，querySelector 找不到就算了）
    var full = row.querySelector(".pit-full");
    if (full) {
      full.textContent = hasCode
        ? it.code + " " + (p ? p.name || "(这个商品没写名称)" : "")
        : "先输编号，名称和图片自动带出来";
    }
    var sub = row.querySelector(".pit-sub");
    if (sub) {
      // 跟 itemHtml 同一套口径（2026-10-17）：有商品 → 进价/售价；没有 → 提示靠右。
      // ⚠️ class 也要跟着切（右不右对齐由它管），光改 textContent 会留上一次的对齐。
      if (!hasCode) {
        sub.textContent = "";
        sub.classList.remove("pit-sub-r");
      } else if (p) {
        sub.textContent = "进价 " + fmtMoney(p.cost_price) + " · 售价 " + fmtMoney(p.sale_price);
        sub.classList.remove("pit-sub-r");
      } else {
        sub.textContent = "商品库里没有这个编号（照样记进单子）";
        sub.classList.add("pit-sub-r");
      }
    }
  }
  /** 索引 = 行在 DOM 里的位置（data-i）。渲染顺序和 state.draft.items 一定一致 */
  function rowIndex(el) {
    var row = el.closest ? el.closest(".pit") : null;
    return row ? num(row.dataset.i) : -1;
  }

  /** 是不是"行上那四格"之一（编号 / 需 / 拿 / 备注） */
  function isRowInput(el) {
    return (
      el.classList.contains("pi-code") ||
      el.classList.contains("pi-need") ||
      el.classList.contains("pi-got") ||
      el.classList.contains("pi-note")
    );
  }
  /**
   * 回车 / 软键盘那颗「完成」键 ＝ **提交这一格**。
   *
   * ⚠️⚠️ 必须显式接 keydown —— **裸 `<input type="text">`（不在 `<form>` 里）按回车不触发 `change`**，
   *   只有"失焦"才触发。老板 2026-10-16 报的"你怎么没做编号排序、我输 361 还在最底层"就是这条：
   *   他输完 361 直接按回车 → 什么都没发生（不补 `A`、不合并、不排序），所以他以为排序压根没做。
   *   （手机端别处早就是显式接回车的：`app.js` 的 `$("q").onkeydown` / `#setAddCode`。）
   *
   * 做法上**不重写一遍提交逻辑**：回车就 `blur()` 一下，浏览器自然把 `change` 补上来，
   *   后面那套（归一 → 撞车合并 → 自动排序）原封不动地复用 —— 不会有第二条口径。
   * ⚠️ 只在 keydown 里做，**绝不能挪去 oninput**（编号归一挂 oninput 会把半成品补零：想敲 336 敲下 3 就变 A003）。
   */
  function commitOnEnter(e) {
    if (!e || !e.target) {
      return false;
    }
    var k = e.key;
    // 软键盘那颗键各家报的名字不一样（安卓 Chrome 常报 Enter，iOS 常见 Go/Done），keyCode 兜底
    var isEnter =
      k === "Enter" || k === "Go" || k === "Done" || k === "Next" || k === "Search" || e.keyCode === 13;
    if (!isEnter) {
      return false;
    }
    var t = e.target;
    if (!t.blur || !t.classList || !isRowInput(t)) {
      return false;
    }
    t.blur(); // → 浏览器补一个 change → 走 bind 里那个 change 分支
    return true;
  }

  // ---------- 接线 ----------
  function bind() {
    // 登记屏幕 → 底部哪一格亮（app.js 靠这个决定高亮，不认这两屏的名字）
    API.registerScreen("screen-purchase", "tabPurchase");
    API.registerScreen("screen-purchase-detail", "tabPurchase");

    // 底部「进货」那一格：进列表屏，顺手拉一遍最新（别人/电脑版加的单子也能看到）
    $("tabPurchase").onclick = function () {
      flush();
      API.show("screen-purchase");
      API.invoke("purchaseList");
    };

    // 列表屏
    $("purchaseNewBtn").onclick = function () {
      openOrder(0, true); // 永远开一张新的（理由见 openOrder 的 forceNew）
    };
    $("purchaseList").onclick = function (e) {
      var del = e.target.closest("[data-del]");
      if (del) {
        var id = num(del.dataset.del);
        // 删整张单是不可逆的，这里必须拦一道
        if (window.confirm("删除这张进货单？删了就找不回来了。")) {
          API.invoke("purchaseDeleteOrder", { id: id });
          if (state.draft && num(state.draft.id) === id) {
            state.draft = null;
          }
        }
        return;
      }
      // 月历：‹ › 换月（只挪看的月份，不动选中的日子）
      var nav = e.target.closest("[data-cal]");
      if (nav) {
        var mm = new Date(state.calY, state.calM + num(nav.dataset.cal), 1);
        state.calY = mm.getFullYear();
        state.calM = mm.getMonth();
        renderList();
        return;
      }
      if (e.target.closest("[data-cal-today]")) {
        var t = dateParts(todayStr());
        state.calY = t.y;
        state.calM = t.m - 1;
        state.selDate = todayStr();
        renderList();
        return;
      }
      // 点日子：只换选中的那天（统计卡跟着换），进单靠卡上的「打开填写」
      var day = e.target.closest("[data-day]");
      if (day) {
        state.selDate = day.dataset.day;
        renderList();
        return;
      }
      // 这天没单：给那天开一张新的（日期落在这天上，不是今天）
      var nd = e.target.closest("[data-newday]");
      if (nd) {
        openOrder(0, true, nd.dataset.newday);
        return;
      }
      var open = e.target.closest("[data-open]");
      if (open) {
        openOrder(num(open.dataset.open));
      }
    };

    // 详情屏
    $("purchaseBack").onclick = function () {
      flush();
      // ⚠️ **故意不清 state.draft**：flush() 里那次保存可能还在路上、而且路上又攒了一笔改动
      //    （state.pending）—— 这时候把草稿置空，回包回来想接着存时就没地方写了（静默丢一笔）。
      //    留着不碍事：再点回同一张单时 openOrder 会自己判断复用还是按服务端重建。
      API.show("screen-purchase");
    };
    $("purchaseAddRow").onclick = function () {
      if (!state.draft) {
        return;
      }
      // 加行前先把搜索清掉：新加的是**空行**（没编号），搜着的时候它不匹配 → 会看不见，
      // 他会以为"点了加号没反应"。清掉搜索就一定是整单，新行稳稳出现在最后。
      if (state.searchQ) {
        state.searchQ = "";
        applySearchRow();
      }
      state.draft.items.push({ code: "", need: 0, got: 0, note: "" });
      renderItems(); // 不算 dirty：没编号的行不会存
      focusLastCode();
    };
    // 单内搜索（甲档：顶栏放大镜点开、默认收起）。⚠️ 放大镜跟右边三颗同一款（44×44、浅灰边）。
    $("purchaseSearchBtn").onclick = function () {
      if (!state.draft) {
        return;
      }
      state.searchOpen = !state.searchOpen;
      if (!state.searchOpen) {
        // 收起＝连搜索词一起清掉：不然列表少了几行、搜索框又看不见，人会以为单子坏了
        state.searchQ = "";
      }
      applySearchRow();
      renderItems();
      if (state.searchOpen) {
        try {
          $("purchaseSearch").focus();
        } catch (e) {
          /* 某些 WebView 不让脚本聚焦，忽略 */
        }
      }
    };
    // ⚠️ 搜索是**边打边筛**的（跟编号不一样 —— 这里没有"补零半成品"那类问题）。
    //    只重画 #purchaseItems，搜索框在它外面 → 焦点和键盘都不受影响。
    $("purchaseSearch").oninput = function () {
      state.searchQ = $("purchaseSearch").value;
      renderItems();
    };
    $("purchaseSearchClear").onclick = function () {
      state.searchQ = "";
      $("purchaseSearch").value = "";
      renderItems();
      try {
        $("purchaseSearch").focus();
      } catch (e) {
        /* 同上 */
      }
    };
    $("purchaseNote").oninput = function () {
      if (!state.draft) {
        return;
      }
      state.draft.note = $("purchaseNote").value;
      markDirty();
    };
    // ⚠️ 原来这里还有一颗 $("#purchaseDate").onchange（改整单日期）—— 2026-10-16 连着那一行一起撤了：
    //    日期由"从月历哪天开的单"决定，不给手改（改了反而容易跟月历上的绿点对不上）。
    // 出口那两颗（复制清单 / 导出 Excel）：都在顶栏图标点开的弹层里
    $("purchaseMoreBtn").onclick = openSheet;
    $("purchaseSheetCopy").onclick = function () {
      closeSheet();
      doCopy();
    };
    $("purchaseSheetXlsx").onclick = function () {
      // 先收起弹层再开工：生成要几秒，弹层杵在那儿挡着看表
      closeSheet();
      startExport();
    };
    $("purchaseSheetCancel").onclick = closeSheet;
    // 点弹层外那层灰底也关（跟其它 sheet 一个手感）
    $("purchaseSheet").onclick = function (e) {
      if (e.target === $("purchaseSheet")) {
        closeSheet();
      }
    };

    // 行清单：整块委托（行是重画的，逐行挂监听会被重画冲掉）
    var items = $("purchaseItems");
    items.addEventListener("input", function (e) {
      if (!state.draft) {
        return;
      }
      clearHit(); // 他又开始打字了 → 上一行的"落位高亮"撤掉（别一直挂着当噪音）
      var t = e.target;
      var i = rowIndex(t);
      var it = state.draft.items[i];
      if (!it) {
        return;
      }
      if (t.classList.contains("pi-need")) {
        it.need = num(t.value);
      } else if (t.classList.contains("pi-got")) {
        it.got = num(t.value);
      } else if (t.classList.contains("pi-note")) {
        it.note = t.value;
      } else {
        return;
      }
      updateRowLive(i);
      markDirty();
    });
    items.addEventListener("change", function (e) {
      if (!state.draft) {
        return;
      }
      var t = e.target;
      var i = rowIndex(t);
      var it = state.draft.items[i];
      if (!it) {
        return;
      }
      if (t.classList.contains("pi-code")) {
        // 编号归一：去空格 + 转大写，再走 canonicalCode（纯数字补成 `A` + 3 位）——
        // 跟**后端保存时**同一套口径（原来这里只做去空格+大写，于是输 `006` 界面说"没这个编号"、
        // 行内小图也取不到，可存进库的却是 `A006`，返回重进才全对 ＝ 界面跟库打架）。
        // ⚠️⚠️ **只能在 change（失焦/回车）里做，绝对不许挪到上面的 oninput**：
        //   `canonicalCode` 对**没输完的内容照样补零** —— 想敲 336、敲下第一个 `3` 的瞬间
        //   就会变成 `A003`（桌面端直播排品栽过，见 `client-live.js:224` 那段注释）。
        var v = String(t.value || "").replace(/\s+/g, "").toUpperCase();
        var cc = canonicalCode(v) || v; // 归一不了就保留原文照样记（老板拍的口径）
        if (t.value !== cc) {
          t.value = cc; // 所见即所存：输 006 当场显示 A006，名称和图立刻出来
        }
        if (cc === it.code) {
          return; // 编号其实没变（比如他把 A006 改成 006）→ 不用排序也不用存
        }
        it.code = cc;
        // 搜索状态下编号一改，匹配的行就不一样了；而且排序要看整单才有意义 —— 所以顺手清掉搜索
        if (state.searchQ) {
          state.searchQ = "";
          applySearchRow();
        }
        // ① 撞车 → **自动并进已有的那一行**（老板拍板："首先你得有提示，然后自动编进去"）。
        //    这一行会被删掉，所以合并里把"删节点 + 重排 + 闪一下 + 弹提示"都做了，这儿直接收工。
        var dup = findSameCodeAt(i);
        if (dup >= 0) {
          mergeSameCode(i, dup);
          renderSummary();
          markDirty();
          return;
        }
        // ② 没撞车 → 按编号排一次（⚠️ 只挪节点、不重建，见 reorderRows 那段注释）。
        var before = state.draft.items.slice(); // 排序前快照：节点上的 data-i 就是这份的下标
        sortDraftItems(it);
        var changed = false;
        for (var k = 0; k < state.draft.items.length; k++) {
          if (state.draft.items[k] !== before[k]) {
            changed = true;
            break;
          }
        }
        if (!reorderRows(before)) {
          renderItems(); // 兜底：节点形状不对（理论上不会）
        } else if (changed) {
          // 位置真变了才闪 —— 他顺着编号往下加时顺序本来就不变，那种情况闪就是纯噪音
          markRow(it); // 挪过去之后**持续高亮**它，别让他一列列去找"刚那个 361 跑哪去了"
        }
        var at = state.draft.items.indexOf(it);
        if (at >= 0) {
          refreshRowName(at); // 只更这一行的名称/小图（不动输入框）
        }
        renderSummary();
        markDirty();
        return;
      }
    });
    // 回车 / 软键盘「完成」＝提交这一格（裸 input 不带 form，回车不触发 change —— 见 commitOnEnter 的注释）
    items.addEventListener("keydown", commitOnEnter);
    items.addEventListener("click", function (e) {
      // 删行：入口在展开块里（紧凑行上没地方放 ✕）
      var del = e.target.closest(".pit-del");
      if (del) {
        if (!state.draft) {
          return;
        }
        var di = rowIndex(del);
        if (di < 0) {
          return;
        }
        state.draft.items.splice(di, 1);
        state.openRow = -1;
        renderItems();
        renderSummary();
        markDirty(); // 删行也算改动（要是一次全删光，库里那份也得跟着清）
        return;
      }
      // 输入框/勾选框/按钮自己管自己 —— 点它们不算"展开这一行"
      if (e.target.closest("input,label,button")) {
        return;
      }
      // 点行的空白处 = 摊开 / 收起这一行（手机上不用双击：想不到也容易跟缩放打架）
      var row = e.target.closest(".pit");
      if (!row) {
        return;
      }
      var i = rowIndex(row);
      if (i < 0) {
        return;
      }
      // ⭐ 摊开 / 收起 = 只切 class（toggleOpenRow），**不重画** —— 重画整列的 <img> 会闪
      toggleOpenRow(i, items);
    });

    // 离开详情屏的几条路都要**先结算**，别让最后那几笔停在 debounce 里
    // （底部 tab 是 app.js 接的，这里用捕获监听抢在它前面，不与它的 onclick 打架）
    document.addEventListener(
      "click",
      function (e) {
        if (!state.dirty) {
          return;
        }
        var t = e.target.closest ? e.target.closest("#tabbar .tb") : null;
        if (t && t.id !== "tabPurchase") {
          flush();
        }
      },
      true,
    );
    // 切到别的 App、或页面要关了：也结算一下（fetch 可能来不及，但尽力而为）
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        flush();
      }
    });

    // 回包
    API.on("purchaseState", function (m) {
      state.loaded = true;
      state.orders = Array.isArray(m.orders) ? m.orders : [];
      // ⚠️ 只重画列表：详情屏那份是**本地草稿**，重画会把正在打的字和焦点一起吞掉
      renderList();
    });
    API.on("purchaseSaved", function (m) {
      // 新建的单第一次存下去，后端把 id 给回来了：记住它，之后就是 UPDATE 而不是再插一张
      if (state.draft && !state.draft.id && num(m.id)) {
        state.draft.id = num(m.id);
        renderTitle();
      }
    });
    // 导出 Excel 的终态（长任务在电脑那头跑，网页版走 SSE 回来；每条退出路径后端都会发）：
    // base64 字节随回包来 → 解成 Blob 下载（WPS 打开就能看）
    API.on("purchaseXlsxDone", function (m) {
      setExportBusy(false);
      if (m.error) {
        API.toast(m.error, true);
        return;
      }
      try {
        downloadBase64(
          m.b64,
          fileNameOf(m, "进货单.xlsx"),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        API.toast("已开始下载");
      } catch (e) {
        API.toast("下载没触发，换个浏览器试试", true);
      }
    });
  }

  // ---------- 起手 ----------
  bind();
  renderList(); // 先把空态摆上（真数据等第一次进 tab 时拉）
})();
