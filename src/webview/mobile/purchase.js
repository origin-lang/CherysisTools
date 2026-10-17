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
    // 两段开关（2026-10-17，老板挑的「乙′」）：现在停在**哪一页**。
    // "plan"=要补的（有编号的行） "live"=现场进的（手写名字的新货行）。
    // ⚠️ 这只是**筛**，底层始终是同一批 items（同一张单）→ 汇总/导出不用合并两套数据。
    pTab: "plan",
    // 「缺货」筛选（2026-10-17 晚，老板："我后面拿到这个进货单的人 肯定要看下缺货的是有哪些"）。
    // ⚠️ 它只是**渲染时多筛一层**：不改 items 顺序（老板："不需要按多的排序"）、不动 data-i ——
    //    行序仍是编号顺序，改数量/删行仍走真实下标。
    // ⚠️ 只管「要补的」那页（新货行没有"需"，永远不算缺）。
    onlyShort: false,
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
   * ⚠️ 归一不了**不是错**：调用方保留原文照样记，界面上只是提示"无此编号"
   *   （老板 10-16 拍的口径："归一不了的就记，只不过说没有这个编号罢了"）。
   *
   * ⚠️⚠️ **口径出处 ＝ `src/tools/shopTool/pricing.ts` 的 `canonicalCode()`**，别自己发明规则：
   *   后端 `handlers/purchase.ts` 保存时、桌面端直播排品输编号时、**手机版商品筛选的区间语法**
   *   （`1~33` 当 A1~A33，`app.js parseCodeTok`）用的都是它 —— 也就是说"纯数字算 A 段"
   *   本来就是这系统里既有的口径，进货单这一格当初漏了（界面说"无此编号"、后端却存成 A006）。
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
   * 行尾那个差额小字（2026-10-16 晚，老板挑的"丙档"）：多拿 `+6`（绿）、缺 `-6`（红）。
   * 老板原话："填完了拿之后，就比如说加 6 什么显示一下，这样的话我也不用自己去算了。"
   *
   * ⚠️ **放法**：它挂在名称栏**里面**、贴着右端（CSS 的 `.pi-d`），**不是**新开一列 ——
   *   所以名称栏总宽没变，只是这一行的名称文字自己少显示一两个字（老板："名称栏短一点没关系"）。
   *   副作用是好的：**没差额的行 `.pi-d` 根本不渲染**，名称仍是满宽（新开一列的话那 26px 是白留的）。
   * ⚠️ **拿 0 也要显示 `-6`**（2026-10-17 晚改回来，老板："如果我需要6 但是 拿填了0 怎么不显示-那个数
   *   虽然也在缺货里面 但是不明显"）。原来 got=0 不出，理由是"还没去拿，每行挂个 -10 像当年的待拿徽标"；
   *   但那样跟"缺货"筛选**自相矛盾** —— 列表把它筛出来，行上却一个数都没有
   *   （等于"我告诉你它缺，但不告诉你缺几件"）。
   *   ⭐ **现在的规矩：能进"缺货"列表的行，行上就必须看得见差多少。** `isShort()` 与这里口径一致。
   *   （只有差 0 不显示 —— 那时"拿"格本来就是绿的。）
   * 口径跟复制清单、汇总那行的"差"**必须一致**：fmtNum + 正数补 `+`。
   */
  function itemDiff(it) {
    var need = num(it.need);
    var got = num(it.got);
    // ⚠️ `!need` 仍然要拦：空行（需还没填）谈不上差额，否则会凭空冒出个 +5
    if (!need || got === need) {
      return null;
    }
    var d = got - need;
    return { txt: (d > 0 ? "+" : "") + fmtNum(d), over: d > 0 };
  }
  /**
   * ⭐ 「还缺」的唯一口径（2026-10-17 晚，老板："把紧急缺货的自动筛选出来…只需要看还缺的"）。
   *   需 > 0 且 拿 < 需 → 缺。
   *
   * ⚠️ **拿 0 也算缺**：刚开的单全都没拿，那**整整一单都是缺的** —— 这时候筛出 0 款才是最没用的结果。
   *   2026-10-17 晚老板又提了行上那个 `-6` 也该出（"虽然也在缺货里面 但是不明显"）→
   *   `itemDiff()` 现在也把 got=0 算进去，**两处口径统一**（能进"缺货"列表的行，行上就看得到差多少）。
   * ⚠️ 现场新货行（kind=1）永远不算缺：它没有"需"（老板现场看见了才记，不是计划量）。
   */
  function isShort(it) {
    if (!it || isNewRow(it)) {
      return false;
    }
    var need = num(it.need);
    return need > 0 && num(it.got) < need;
  }
  /** 「还缺」的款数 + 缺口件数（缺口 = Σ(需 − 拿)，正数）—— 开关上的数字和底部汇总都用它 */
  function shortTotals(items) {
    var n = 0;
    var qty = 0;
    for (var i = 0; i < items.length; i++) {
      if (isShort(items[i])) {
        n++;
        qty += num(items[i].need) - num(items[i].got);
      }
    }
    return { n: n, qty: qty };
  }
  /** 「缺货」现在是不是**真在筛**：开关开着 + 停在「要补的」那页。
   *  ⚠️ 「现场进的」那页不算 —— 新货行没有"需"，开关在那页根本不露，
   *    要是开着还把列表筛空，他会以为"现场记的东西全丢了"。 */
  function shortOnly() {
    return !!state.onlyShort && !isLiveTab();
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
    // 现场新货行（2026-10-17）：单独记两款数和花掉多少钱 ——
    // ⚠️ **不进"需/拿/差"那三个数**：现场新货没有"需"，混进去会把"差"算成凭空多拿。
    var newCnt = 0;
    var newAmt = 0;
    for (var i = 0; i < items.length; i++) {
      if (isNewRow(items[i])) {
        newCnt++;
        newAmt += num(items[i].price) * num(items[i].got);
        continue;
      }
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
      // 只有现场新货、还没有补货行时别说"空单"（那明明记了东西）
      statusText = newCnt ? "现场记了 " + newCnt + " 款" : "空单";
      cls = newCnt ? "doing" : "";
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
    var line = "共 " + (n + newCnt) + " 款" + (newCnt ? "（补货 " + n + " · 新货 " + newCnt + "）" : "") +
      " · 需 " + fmtNum(need) + " · 拿 " + fmtNum(got);
    if (n) {
      line += " · 差 " + (diff > 0 ? "+" : "") + fmtNum(diff);
    }
    if (newAmt > 0) {
      line += " · 新货 " + fmtMoney(newAmt);
    }
    return {
      need: need,
      got: got,
      diff: diff,
      ready: ready,
      total: n,
      newCnt: newCnt,
      newAmt: newAmt,
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
    // 「缺货」开着 → 这一行换口径，**只报筛出来的那批**（2026-10-17）。
    // ⚠️ 不换的话，列表 3 行、底下写着"共 12 款 · 需 80"，他只会以为"列表少画了 9 行"。
    if (shortOnly()) {
      var t = shortTotals(state.draft.items);
      box.textContent =
        "缺货 · " + t.n + " 款" + (t.n ? " · 缺口 " + fmtNum(t.qty) + " 件" : "（全拿齐了）");
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
  /** 这一行是不是「现场新货行」（2026-10-17 老板挑的「乙′」里的第二种行）：
   *  kind=1 → **没有"需"、没有编号**，名字是手写的（`it.name`），进价/认货照是这行自己的。
   *  老数据没有 kind 这一列 → 一律当补货行，行为跟以前一模一样。 */
  function isNewRow(it) {
    return !!(it && Number(it.kind));
  }
  /** 新货行的合计（老板 2026-10-17 晚定稿的 B 档）：**第二行右端**就一个 `¥114`。
   *  ⚠️ 别再把「合计」两个字和这串数挂到名称下面 —— 那会让名称格被小字顶满、看着挤
   *     （老板原话："合计写在名称下面 感觉可能一行显得很挤…看着很不美观"）。
   *  没填进价就**什么都不写**（`.pit-amt:empty` 会把那一格收掉，不留一条空白）。 */
  function amtTxt(it) {
    if (!nzNum(it.price)) {
      return "";
    }
    return fmtMoney(num(it.price) * num(it.got));
  }
  /** 数字是不是大于 0（空串/0/NaN 都算"没填"） */
  function nzNum(v) {
    return num(v) > 0;
  }
  /** 认货照的临时号：新货行还没有编号，图先存在 imageDir/<这个号>/ 下。
   *  ⚠️ 只用字母数字和横线（它就是个文件夹名）；一行一个号，重复拍照进同一个夹子。 */
  function tempImgCode() {
    return "_n" + Date.now().toString(36);
  }
  function itemHtml(it, i) {
    // 现场新货行走另一套画法（字段就不一样：没有编号/需，多了进价和照）
    if (isNewRow(it)) {
      return newItemHtml(it, i);
    }
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
      nameTxt = "无此编号";
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
      // 「商品库里有这个编号」有用得多）；库里没有 → 「无此编号」**靠右 + 更淡**（老板 10-17 定的四个字：
      // 原来那句「商品库里没有这个编号（照样记进单子）」太长，而且"照样记进单子"是废话——这里就是单子）。
      (hasCode
        ? '<div class="pit-sub muted small' + (p ? "" : " pit-sub-r") + '">' +
          (p ? "进价 " + fmtMoney(p.cost_price) + " · 售价 " + fmtMoney(p.sale_price) : "无此编号") +
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
  /**
   * 现场新货行（2026-10-17，老板挑的「乙′」；当天晚些时候按他挑的 **B 档**定稿）：
   *   第一行  [照 44][名称][进价][件]
   *   第二行  [备注（可空）][¥114][🗑]
   * ⚠️ **没有「需」这一格**：现场没有"本来该要几件"这回事（那是补货行的事）。
   * ⚠️ 名称/进价都在行上直接改，不弹层 —— 档口一只手拿着货，能少一次点击就少一次。
   * ⚠️⚠️ **不再有展开块**（原来那个抽屉里只剩"一行删除按钮 + 左边一大片空白"，老板：
   *    "详情能点击的地方太小了不好打开" —— 这行四个格子全是输入框/按钮，压根没有能点的空地）。
   *    去掉抽屉后，备注常驻第二行，删除也常驻，点不开/留白两个问题一起没了。
   * ⚠️ 四个输入框**失焦不画框**（CSS `.pit-live` 那段）：四个方框并排是"挤"与"丑"的主因。
   * ⚠️ 认货照是"随手拍一张、下次认得出是它"，不是商品展示图：不摆拍、不强制（`_n` 临时夹子）。
   */
  function newItemHtml(it, i) {
    var gc = gotCls(it);
    var shot = it.img
      ? '<button class="pi-shot has" type="button" data-shot="' + i + '" aria-label="看大图 / 换一张照" title="看大图 / 换一张照">' +
        '<img src="' + esc(API.imgUrl(it.img, "", "thumb")) + '" alt="" loading="lazy" onerror="this.remove()" />' +
        "</button>"
      : '<button class="pi-shot" type="button" data-shot="' + i + '" aria-label="拍张照" title="拍张照">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M4 8h3l1.4-2h7.2L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />' +
        '<circle cx="12" cy="13" r="3.2" />' +
        "</svg></button>";
    return (
      '<div class="pit pit-live" data-i="' + i + '">' +
      // 第一行：照 / 名称 / 进价 / 件（名称单行，合计不在它下面）
      '<div class="pit-row">' +
      shot +
      '<input class="pi-name" type="text" autocomplete="off" spellcheck="false" placeholder="名称" value="' +
      esc(it.name || "") + '" />' +
      '<input class="pi-price" type="number" inputmode="decimal" min="0" step="0.1" placeholder="进价" value="' +
      (nzNum(it.price) ? esc(numStr(it.price)) : "") + '" />' +
      '<input class="pi-got' + (gc ? " " + gc : "") + '" type="number" inputmode="decimal" min="0" step="1" placeholder="件" value="' +
      esc(numStr(it.got)) + '" />' +
      "</div>" +
      // 第二行：备注常驻 + 合计靠右 + 删行（删行跟补货行同一个垃圾桶图标，画法一致才叫"统一"）
      '<div class="pit-row2">' +
      '<input class="pi-note" type="text" placeholder="备注（可空）" value="' + esc(it.note) + '" />' +
      '<span class="pit-amt">' + esc(amtTxt(it)) + "</span>" +
      '<button class="pit-del" type="button" aria-label="删除这一行" title="删除这一行">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 6h18" />' +
      '<path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />' +
      '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />' +
      '<path d="M10 11v6" />' +
      '<path d="M14 11v6" />' +
      "</svg></button>" +
      "</div></div>"
    );
  }
  /**
   * 现场新货行的「认货照」：现造一个 `<input type=file accept=image/*>` 点它 ——
   * 手机系统会自己弹「相机 / 相册」，不用我们分两条路（跟 app.js 详情页上传同一个做法）。
   * ⚠️ 图存在哪：这行还没有编号，所以先用一个**临时号**（`_n` 开头）当文件夹名，
   *    传完把号记在 `it.img` 上，行上按这个号取图；以后转正/有编号了再挪（先不做）。
   * ⚠️ 传完必须 renderItems()：小图那格要从"相机图标"换成照片。
   */
  function pickPhoto(i) {
    var it = state.draft && state.draft.items[i];
    if (!it) {
      return;
    }
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (inp.parentNode) {
        inp.parentNode.removeChild(inp);
      }
      if (!f) {
        return;
      }
      var fr = new FileReader();
      fr.onload = function () {
        var code = it.img || tempImgCode();
        it.img = code;
        API.toast("照片上传中…");
        API.invoke("receiveImageData", {
          code: code,
          items: [{ name: f.name || "photo.jpg", data: String(fr.result || "") }],
        })
          .then(function () {
            API.toast("照片存好了");
            markDirty();
            renderItems();
          })
          .catch(function () {
            API.toast("照片没传上，再试一次", true);
          });
      };
      fr.onerror = function () {
        API.toast("这张读不出来，换一张试试", true);
      };
      fr.readAsDataURL(f);
    };
    inp.click();
  }
  /**
   * 看认货照的大图（2026-10-17 老板："能查看大图就好了，或者小图也行"）。
   * ⚠️ 用 `size=mid`（1024 等比）而不是 `full`：手机原图实测 7.9MB 一张，档口流量/内存都吃不住，
   *    mid 已经足够看清包装上的字。
   * ⚠️ 换图走这里那颗「换一张」—— 点击分给"看"，换是明确动作，不会误触。
   */
  function showShotView(i) {
    var it = state.draft && state.draft.items[i];
    if (!it || !it.img) {
      return;
    }
    var bg = document.createElement("div");
    bg.className = "p-shotview";
    bg.innerHTML =
      '<div class="p-svbox">' +
      '<img src="' + esc(API.imgUrl(it.img, "", "mid")) + '" alt="认货照" />' +
      '<div class="p-svbar">' +
      '<button class="p-svbtn" type="button" data-act="swap">换一张</button>' +
      '<button class="p-svbtn" type="button" data-act="close">关掉</button>' +
      "</div></div>";
    document.body.appendChild(bg);
    bg.onclick = function (e) {
      var btn = e.target.closest("[data-act]");
      var act = btn ? btn.getAttribute("data-act") : "";
      if (act === "swap") {
        close();
        pickPhoto(i);
        return;
      }
      // 点「关掉」、点大图外面、点图片本身都收起来（手机上最顺手的三个动作）
      close();
    };
    function close() {
      if (bg.parentNode) {
        bg.parentNode.removeChild(bg);
      }
    }
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
    // 现场新货行：搜的就是它手写的名字（没有编号可搜）
    if (isNewRow(it)) {
      return String(it.name || "").toLowerCase().indexOf(k) >= 0;
    }
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
      // 整张单还空着：说清"这一页该怎么加东西"（2026-10-17 晚起两页各有各的入口：
      // 要补的＝底栏那颗「快速记」、现场进的＝「＋ 记一笔」）
      box.innerHTML = isLiveTab()
        ? '<p class="muted small">「现场进的」这页还是空的。点下面「＋ 记一笔」写个名字、填件数就行（编号可以先不填）。' +
          "要按编号补的货，切到「要补的」那页。</p>"
        : '<p class="muted small">还没有商品。点下面「快速记」，敲编号和件数就行（会自动带出名称和图片）；' +
          "现场看见库里没有的新货，切到「现场进的」写个名字记一笔。</p>";
      renderPTabs();
      return;
    }
    var items = state.draft.items;
    var kw = searchKeyword();
    var live = isLiveTab();
    // ⚠️ i 是**在 items 里的真实下标**（不是筛完之后的序号）：data-i、改数量、删行、展开全靠它 ——
    //    拿过滤后的序号去标会串到别的商品上（改 A006 的数量结果改到了 A012）。
    // 2026-10-17：先按**当前这一页**（要补的 / 现场进的）筛，再按「缺货」筛，再按搜索词筛。
    // ⚠️ 三层都是"跳过不画"，**没有一处重排 items** —— 所以循环里的 i 永远是真实下标。
    var only = shortOnly();
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      if (isNewRow(items[i]) !== live) {
        continue;
      }
      if (only && !isShort(items[i])) {
        continue;
      }
      if (rowMatches(items[i], kw)) {
        rows.push(itemHtml(items[i], i));
      }
    }
    // 表头跟着行的列宽走（同一套 flex + gap，对得齐）；himg 那格对齐行内小图
    var head = live
      ? '<div class="pit-head pit-head-live"><span class="himg"></span><span class="hname">名称</span><span class="hprice">进价</span><span class="hnum">件</span></div>'
      : '<div class="pit-head"><span class="himg"></span><span class="hcode">编号</span>' +
        '<span class="hname">名称</span><span class="hnum">需</span><span class="hnum">拿</span></div>';
    // 搜不到不留白屏（跟别处"空态要有一句话"一个规矩）；表头留着，列宽还有个参照
    // ⚠️ 「缺货」筛出 0 款是**很常见**的结果（全拿齐了）—— 必须专门说一句，
    //    不然一片空白 + 开关还亮着，他只会觉得"单子坏了"。
    var body = rows.length
      ? rows.join("")
      : '<p class="muted small">' +
        (kw
          ? "这单里没有编号或名称带「" + esc(kw) + "」的行。"
          : only
            ? "这单没有还缺的款 —— 全都拿齐了。点上面那颗「缺货」看整单。"
            : live
              ? "「现场进的」这页还是空的。点下面「＋ 记一笔」写个名字、填件数就行（编号可以先不填）。"
              : "「要补的」这页还是空的。点下面「快速记」敲编号就行。") +
        "</p>";
    box.innerHTML = head + body;
    renderPTabs();
  }
  /** 现在是不是「现场进的」那一页 */
  function isLiveTab() {
    return state.pTab === "live";
  }
  /** 两段开关的高亮 + 两边的款数（只动这一小块，不重画列表） */
  function renderPTabs() {
    var plan = $("purchaseTabPlan");
    var live = $("purchaseTabLive");
    var cPlan = $("pCountPlan");
    var cLive = $("pCountLive");
    if (!plan || !live || !state.draft) {
      return;
    }
    var pn = 0;
    var ln = 0;
    var items = state.draft.items || [];
    for (var i = 0; i < items.length; i++) {
      if (isNewRow(items[i])) {
        ln++; // 新货行只要存在就算一笔（名字还没写也先算着，不然"点完加号没反应"）
      } else if (String(items[i].code || "").trim()) {
        pn++;
      }
    }
    if (cPlan) {
      cPlan.textContent = String(pn);
    }
    if (cLive) {
      cLive.textContent = String(ln);
    }
    // 自检里的 DOM 桩很薄（没有 classList/setAttribute），这几步写成"有就做"
    if (plan.classList && plan.classList.toggle) {
      plan.classList.toggle("on", !isLiveTab());
    }
    if (live.classList && live.classList.toggle) {
      live.classList.toggle("on", isLiveTab());
    }
    // 底部那颗按钮跟着页变称呼：要补的是「加一行」、现场进的是「记一笔」——
    // 同一颗按钮干两件事，名字得跟着变，不然他会以为点错了。
    // ⚠️ 2026-10-17 晚（老板：「加一行不需要了 只需要快速记（纯绿色）」）：
    //    「要补的」那页**只留「快速记」**（纯绿通栏），这颗按页收起来。
    //    **不能删**：现场那页只有它能加新货行（新货没有"需"，快速记管不到）。
    var add = $("purchaseAddRow");
    if (add) {
      var label = isLiveTab() ? "＋ 记一笔" : "＋ 加一行";
      if (add.textContent !== label) {
        add.textContent = label;
      }
      if (add.setAttribute) {
        add.setAttribute("aria-label", isLiveTab() ? "记一笔现场进的货" : "加一行");
      }
      if (add.hidden !== !isLiveTab()) {
        add.hidden = !isLiveTab();
      }
    }
    // 「缺货」那颗（2026-10-17）：数字 = 这单**还缺的款数**，只在「要补的」那页露。
    // ⚠️ 数字算的是**整单的缺**（不是"当前筛完剩几行"）—— 开关上写的是"点下去会剩几款"，
    //    不是"已经筛出几款"，这两者在没开的时候是同一个数、开着的时候才分叉。
    renderShortBtn(items);
    // 底栏那颗「快速记」也只露在「要补的」那页：另一页记的是手写名字的新货，没有"需"这回事
    var qb = $("purchaseQuickBtn");
    if (qb && qb.hidden !== isLiveTab()) {
      qb.hidden = isLiveTab();
    }
  }
  /** 「缺货」那颗开关的外壳：数字 / 露不露 / 亮不亮。
   *  ⚠️ 单独抽出来是因为**打字时要单独刷它**（见 updateRowLive）：他只更新这一行 + 汇总，
   *    不整块重画 —— 填完「拿」那颗数字得当场变小，不然要等下次重画才看得见。 */
  function renderShortBtn(items) {
    var sb = $("purchaseOnlyShort");
    if (!sb) {
      return;
    }
    var sc = $("pCountShort");
    if (sc) {
      sc.textContent = String(shortTotals(items || []).n);
    }
    if (sb.hidden !== isLiveTab()) {
      sb.hidden = isLiveTab();
    }
    if (sb.classList && sb.classList.toggle) {
      sb.classList.toggle("on", !!state.onlyShort);
    }
    if (sb.setAttribute) {
      sb.setAttribute("aria-pressed", state.onlyShort ? "true" : "false");
    }
  }
  /** 切页：只换列表 + 开关高亮，草稿一个字没动（底层是同一张单） */
  function setPTab(t) {
    var next = t === "live" ? "live" : "plan";
    if (state.pTab === next) {
      return;
    }
    state.pTab = next;
    state.openRow = -1; // 摊开的那行在另一页上，别让它串过来
    renderItems();
    // 「缺货」只作用在「要补的」那页（shortOnly() 里判）→ 切到现场那页时
    // 底下那句汇总得**换回整单口径**，不然还挂着"缺货 · 3 款"（2026-10-17）
    renderSummary();
  }
  function renderDetail() {
    if (!state.draft) {
      return;
    }
    $("purchaseNote").value = state.draft.note || "";
    renderTitle();
    renderSummary();
    applySearchRow(); // 搜索行露不露跟着 state（换单时已经清空，见 openOrder）
    renderPTabs(); // 两段开关的款数（列表空的时候 renderItems 会提前返回，这里补一刀）
    renderItems();
  }
  function focusLastCode() {
    var box = $("purchaseItems");
    if (!box) {
      return;
    }
    var els = box.querySelectorAll(".pi-code, .pi-name");
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
                // 现场新货行（2026-10-17）：手写名字 / 进价 / 认货照的临时号 / 行的种类
                name: it.name || "",
                price: num(it.price),
                img: it.img || "",
                kind: Number(it.kind) ? 1 : 0,
              };
            }),
          }
        : { id: 0, date: date || todayStr(), note: "", items: [] };
      state.dirty = false;
      state.openRow = -1; // 换了一张单，展开中的行号没意义了
      state.searchQ = ""; // 搜索也一起清：上一张单筛的词对这张单没意义（搜索行也收起来）
      state.searchOpen = false;
      state.pTab = "plan"; // 换单回到「要补的」那页（现场那页是临时记东西的，不是默认落脚点）
      // 「缺货」也清掉：上一张单筛剩几款，换一张单还筛着 → 一进来就是空列表，像单子没数据
      state.onlyShort = false;
      // 新建时先白送一行空的：进来就能直接在行里输编号，不用先开一次「快速记」。
      // （2026-10-17 晚起底栏在「要补的」那页只有「快速记」，「加一行」收在现场页了）
      // ⚠️ 这一行**不算改动**（没编号的行后端也不会存）—— 否则"掀开看一眼又退出去"会留下一张空单
      if (!src) {
        state.draft.items.push({ code: "", need: 0, got: 0, note: "", name: "", price: 0, img: "", kind: 0 });
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
    // 行整表替换（跟后端口径一致）：空的行在这儿就丢掉。
    // 2026-10-17：现场新货行**可以没有编号**（名字就是它的身份），所以判空看的是"编号和名字都空"。
    var items = [];
    for (var i = 0; i < d.items.length; i++) {
      var it = d.items[i];
      var liveRow = isNewRow(it);
      if (liveRow ? !String(it.name || "").trim() && !String(it.code || "").trim() : !String(it.code || "").trim()) {
        continue;
      }
      items.push({
        code: it.code || "",
        need: liveRow ? 0 : num(it.need),
        got: num(it.got),
        // 库里那列还在（后端没动，不必为一行 UI 改动去动表结构）；值由 isReady() 算，不是人工勾的
        done: liveRow ? 0 : isReady(it) ? 1 : 0,
        note: it.note || "",
        name: liveRow ? String(it.name || "").trim() : "",
        price: liveRow ? num(it.price) : 0,
        img: it.img || "",
        kind: liveRow ? 1 : 0,
      });
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
    // 「缺货」开着时，**复制出去也只有缺的**（2026-10-17）：
    // 这条清单是发给"去拿货的那个人"的 —— 老板的诉求就是"他只看还缺什么"。
    // 整单备注（d.note）照旧带上（那是给人看的说明，不属于某一行）。
    var only = shortOnly();
    var lines = ["【补货单 " + (d.date || "") + "】" + (only ? "（只看还缺的）" : "")];
    // 2026-10-17：现场新货行也跟着走，但**排在补货行后面**（老板："先把补货的读完，再拿那个进货的"）。
    // ⚠️ 筛"还缺"的时候新货行整批不出：它们没有"需"，跟缺不是一件事，混进来反而让人以为新货也算欠的。
    var planRows = d.items
      .filter(function (it) {
        return !isNewRow(it) && String(it.code || "").trim() && (!only || isShort(it));
      })
      .map(function (it) {
        var p = findProduct(it.code);
        var nm = p && p.name ? p.name : "";
        var label = (isReady(it) ? "✓ " : "") + it.code + (nm ? " " + nm : "");
        var got = num(it.got);
        var d2 = got - num(it.need);
        var seg = "需" + fmtNum(it.need) + " 拿" + fmtNum(got);
        // ⚠️ 差 0 不写：跟行上"正好不显示差额"同一个口径（原来这儿会写成 `需10 拿10 0`，
        //    那个孤零零的 0 看着像乱码；列表里也不该出现"正好"这个信息 —— 对齐的列已经说清了）
        // ⚠️ **拿 0 要写**（2026-10-17 晚跟行上一起改的）：`需6 拿0 -6`。
        //    原来 `got &&` 把这一档咽掉了 → 清单里那行看着像"不用买"，跟"缺货"筛选对不上。
        if (num(it.need) && d2 !== 0) {
          seg += " " + (d2 > 0 ? "+" : "") + fmtNum(d2);
        }
        return { it: it, label: label, seg: seg };
      });
    // 新货行：没有需，只有件数；填了进价就顺带把金额写出来（跟行上那句话同口径）
    var liveRows = only
      ? []
      : d.items
          .filter(function (it) {
            return isNewRow(it);
          })
          .map(function (it) {
            var nm = String(it.name || "").trim() || "（没写名称）";
            var seg = "拿" + fmtNum(it.got);
            if (nzNum(it.price)) {
              seg += " ¥" + fmtNum(it.price) + "×" + fmtNum(it.got) + "=¥" + fmtNum(num(it.price) * num(it.got));
            }
            return { it: it, label: "＋" + nm, seg: seg };
          });
    var rows = planRows.concat(liveRows);
    var w = 0;
    for (var i = 0; i < rows.length; i++) {
      w = Math.max(w, dispWidth(rows[i].label));
    }
    for (var j = 0; j < rows.length; j++) {
      var line = padRight(rows[j].label, w + 2) + rows[j].seg;
      if (rows[j].it.note) {
        line += "  ｜" + rows[j].it.note;
      }
      lines.push(line);
    }
    if (d.note) {
      lines.push("备注：" + d.note);
    }
    var s = calcSummary(d.items);
    // 末尾那行跟着筛选换口径（跟屏幕上 #purchaseSummary 同一句话，两个出口不能各说各的）
    if (only) {
      var t = shortTotals(d.items);
      lines.push("缺货 · " + t.n + " 款" + (t.n ? " · 缺口 " + fmtNum(t.qty) + " 件" : "（全拿齐了）"));
    } else {
      lines.push(
        "共 " + (s.total + s.newCnt) + " 款" +
          (s.newCnt ? "（补货 " + s.total + " · 新货 " + s.newCnt + "）" : "") +
          " · 需 " + fmtNum(s.need) + " · 拿 " + fmtNum(s.got) +
          " · 差 " + (s.diff > 0 ? "+" : "") + fmtNum(s.diff) +
          (s.newAmt > 0 ? " · 新货 ¥" + fmtNum(s.newAmt) : ""),
      );
    }
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
    // 与后端同口径：滤掉空编号行（没填完的行不进导出）。
    // 「缺货」开着时**表里也只有缺的**（2026-10-17）—— 跟屏幕、跟复制清单同口径：
    // 三个出口看到的必须是同一批货，否则他会拿着表去问"这 9 款哪来的"。
    var only = shortOnly();
    var items = [];
    for (var i = 0; i < state.draft.items.length; i++) {
      if (only && !isShort(state.draft.items[i])) {
        continue;
      }
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
    // ⚠️ 开着「缺货」又一款都不缺 → 传空数组上去，电脑那头只会生成一张光表头的表（还得压图）
    //    → 直接在这儿拦住，说清为什么（2026-10-17）
    if (only && !items.length) {
      setExportBusy(false);
      API.toast("现在只看缺货，这单没有缺的款", true);
      return;
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

  // ---------- 快速记数面板（2026-10-17 晚，老板："输入 33 然后边上按钮 + 然后我填多少个"）----------
  /**
   * 他要解决的是**档口现场那件事**：缺的货不是一次数完的，是一件一件数出来的
   * （原话："我可能很多缺少是一个个的数出来看订单"）。
   * 而"一行一行加"的每一步是：加一行 → 点编号格 → 敲编号 → 点需格 → 敲数字 → 收起键盘，
   * 一件货四步、还得反复挪手 —— 所以他宁可不记。
   *
   * 这个面板把每一步压到**只敲两下屏幕外的键**：编号 ⏎ 件数 ⏎（回车连跳，手不离软键盘）。
   * 三条口径是这一屏的全部规则：
   *   ① **件数空着＝1** —— 数到一件、顺手补一件，不用先填个 1。
   *   ② **同一个编号再记一次＝累加**（复用 mergeItems 那套"需相加"的意思，不是覆盖）。
   *   ③ **底下留"本次已记"** —— 记错了当场点 × 撤掉，不用回列表里翻那一行（而且知道记到几笔了）。
   * ⚠️ 只服务于「要补的」那页（另一页记的是手写名字的新货，没有"需"这回事）→ 那颗入口在
   *    renderPTabs 里跟着页隐掉。
   */
  // 本次面板里记下的每一笔：{ item: <列表里那一行>, n: 件数, created: 这一行是不是这笔新建的 }
  var qcLog = [];
  // 最后动过的那一行：关面板时高亮它（"我刚记的落哪去了"）
  var qcLast = null;

  /**
   * 记数/撤销的**算法本体**（纯函数：只动传进来的 items，不碰 DOM 和 state）
   * ⚠️ 单独抽出来是为了能单测 —— 累加写成覆盖、件数为空当成 0、编号没归一，
   *    这三种错**在界面上都看不出来**（数字不对也不会报错），只能靠断言钉死。
   * @returns {{item:object, created:boolean, before:number, after:number, n:number}}
   */
  function qcApply(items, code, n) {
    var qty = Math.floor(num(n));
    if (!(qty >= 1)) {
      qty = 1; // 件数空着/敲了 0 → 当 1（老板："输入 33 然后…我填多少个"，空着就是 1 件）
    }
    var hit = null;
    for (var i = 0; i < items.length; i++) {
      // 只在「要补的」那批里找同编号（现场新货行没有编号这回事）
      if (!isNewRow(items[i]) && String(items[i].code || "") === code) {
        hit = items[i];
        break;
      }
    }
    var created = false;
    if (!hit) {
      // 单里还没有这一款 → 新建一行（带编号，名称/图由 renderItems 按编号自动带出来）
      hit = { code: code, need: 0, got: 0, note: "", name: "", price: 0, img: "", kind: 0 };
      items.push(hit);
      created = true;
    }
    var before = num(hit.need);
    hit.need = before + qty;
    return { item: hit, created: created, before: before, after: hit.need, n: qty };
  }
  /**
   * 撤掉一笔（纯函数）。返回被从 items 里删掉的下标（没删就是 -1）。
   * ⚠️ 这一行本来就是**这一笔新建**的、撤完需又归 0 了 → 整行删掉：
   *    留一行"编号有、需是 0"的空壳既不算缺、又会被存进库（save 判空看的是编号和名字都空）。
   */
  function qcUndoApply(items, entry) {
    if (!entry || !entry.item) {
      return -1;
    }
    var it = entry.item;
    it.need = Math.max(0, num(it.need) - num(entry.n));
    if (entry.created && !num(it.need)) {
      var k = items.indexOf(it);
      if (k >= 0) {
        items.splice(k, 1);
        return k;
      }
    }
    return -1;
  }
  /** 这个编号落在哪一行、现在需多少（提示框和撤销都要用；找不到就是 null） */
  function qcFind(code) {
    var items = (state.draft && state.draft.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (!isNewRow(items[i]) && String(items[i].code || "") === code) {
        return items[i];
      }
    }
    return null;
  }
  /** 编号框里那串 → 归一后的编号（跟行内定稿同一个口径；归一不了就保留原文） */
  function qcCode() {
    var el = $("qcCode");
    var raw = String((el && el.value) || "")
      .replace(/\s+/g, "")
      .toUpperCase();
    return raw ? canonicalCode(raw) || raw : "";
  }
  /** 件数框里那串 → 正数（空着/0/负数一律当 1，和 qcApply 同一口径） */
  function qcQty() {
    var el = $("qcNum");
    var n = Math.floor(num(el && el.value));
    return n >= 1 ? n : 1;
  }
  /** 底部那行提示：敲编号的时候就告诉他"会记到哪一行、记完是多少" */
  function qcHint() {
    var el = $("qcHint");
    if (!el) {
      return;
    }
    var code = qcCode();
    if (!code) {
      el.textContent = "";
      return;
    }
    var p = findProduct(code);
    var cur = qcFind(code);
    var have = cur ? num(cur.need) : 0;
    var head = code + " " + (p ? p.name || "(这个商品没写名称)" : "无此编号");
    // 老板要的是"敲之前就知道会记到几" → 后半句写的是**记完**的数（3 → 8），不是当前的 3
    el.textContent = have
      ? head + " · 已有 需 " + fmtNum(have) + " → 加上记 " + fmtNum(have + qcQty())
      : head + " · 还没有这一款，加上会新建";
  }
  /** 底下"本次已记"：一笔一个胶囊（倒序，最新的在左边/最前），点 × 撤掉 */
  function renderQcLog() {
    var stat = $("qcStat");
    var log = $("qcLog");
    var i;
    if (stat) {
      var sum = 0;
      for (i = 0; i < qcLog.length; i++) {
        sum += num(qcLog[i].n);
      }
      stat.textContent = qcLog.length
        ? "本次已记 " + qcLog.length + " 笔 · 共 " + fmtNum(sum) + " 件（点 × 撤掉）"
        : "";
    }
    if (!log) {
      return;
    }
    var h = "";
    for (i = qcLog.length - 1; i >= 0; i--) {
      var e = qcLog[i];
      h +=
        '<span class="qc-chip"><b>' +
        esc(e.item.code || "") +
        "</b>+" +
        fmtNum(e.n) +
        '<button class="qc-x" type="button" data-k="' +
        i +
        '" aria-label="撤掉这一笔">×</button></span>';
    }
    log.innerHTML = h;
  }
  function openQc() {
    if (!state.draft) {
      return;
    }
    // 摊开的那行先收起：面板占掉半屏，而且底下撤销可能删行（openRow 会串位）
    state.openRow = -1;
    qcLog = [];
    qcLast = null;
    var code = $("qcCode");
    var nm = $("qcNum");
    if (code) {
      code.value = "";
    }
    if (nm) {
      nm.value = "";
    }
    var s = $("qcSheet");
    if (s) {
      s.classList.add("show");
    }
    qcHint();
    renderQcLog();
    // ⚠️ 同步聚焦（不要 setTimeout）：这是点按钮那一下的手势上下文里，iOS 才肯弹软键盘。
    //    面板一开键盘就在，他不用再点一下输入框 —— 这一下也是"少一步"。
    if (code && code.focus) {
      code.focus();
    }
  }
  function closeQc() {
    var s = $("qcSheet");
    if (s) {
      s.classList.remove("show");
    }
    qcLog = [];
    renderQcLog();
    if (state.draft) {
      renderItems();
      renderSummary();
      // 关掉之后把最后动过那行点亮（走"编号撞车并进哪一行"同一个 markRow）
      if (qcLast) {
        markRow(qcLast);
      }
    }
    qcLast = null;
  }
  /**
   * 把一整批都撤掉（纯函数：返回撤了几笔）。「取消」和自检都用它。
   * ⚠️ **必须倒着走**：同一行记了三次时，最早那笔才知道"这一行是我建出来的"（`created`），
   *    先撤后面的、最后撤它，`need` 才会正好归 0 → 整行删掉，回到打开面板之前的样子。
   *    正着撤的话，最早那笔先在 need=3 上减到 2（不删行），后面两笔又不是 created（也不删），
   *    最后留一行"编号有、需 0"的空壳 —— 不算缺、还会被存进库，界面上完全看不出来。
   */
  function qcUndoAll(items, log) {
    var n = 0;
    for (var i = log.length - 1; i >= 0; i--) {
      qcUndoApply(items, log[i]);
      n++;
    }
    return n;
  }
  /**
   * 【取消】：把**这次打开面板之后记的那几笔**全部撤回去，再关（2026-10-17 晚，老板挑的「撤掉本次再关」）。
   * ⚠️ 只撤 `qcLog` 里记着的那几笔 —— 打开面板之前这单什么样，撤完就是什么样
   *    （不是删单子，也不碰别人的行：`qcUndoApply` 只会把 `need` 减回去）。
   * ⚠️ 一笔都没记就直接关、不弹提示（弹了等于告诉他"我撤了个寂寞"）。
   */
  function cancelQc() {
    if (!state.draft) {
      closeQc();
      return;
    }
    var n = qcUndoAll(state.draft.items, qcLog);
    qcLast = null; // 撤完了就没有"最后动过的那一行"（closeQc 靠它决定要不要高亮）
    if (n) {
      markDirty(); // 不标脏 = 屏幕上撤了、库里还在
      API.toast("已撤掉本次 " + n + " 笔");
    }
    closeQc();
  }

  /**
   * 【完成】：这一批**留着**（跟「取消」正相反），关面板之前说一句记了什么。
   * 2026-10-17 晚老板：「我点击了完成，也弹出提示呀 我看你取消都有」——
   * 他点完成时其实是在确认"这一批到底进了没有"，一句「已记 3 笔 · 共 8 件」就是那个确认。
   * ⚠️ 必须在 `closeQc()` **之前**算：它会把 `qcLog` 清空。
   * ⚠️ 一笔都没记就直接关、不弹（跟取消同一条规矩，弹了等于说"我记了个寂寞"）。
   */
  function doneQc() {
    var n = qcLog.length;
    var sum = 0;
    for (var i = 0; i < n; i++) {
      sum += num(qcLog[i].n);
    }
    if (n) {
      API.toast("已记 " + n + " 笔 · 共 " + fmtNum(sum) + " 件");
    }
    closeQc();
  }

  /**
   * 【加上】：编号 + 件数 → 累加进单子。回车和「加上」按钮都走这一条。
   * 敲完立刻清空两个框、光标回编号格（连着记下一件，手指不用离开软键盘）。
   */
  function qcCommit() {
    if (!state.draft) {
      return;
    }
    var codeEl = $("qcCode");
    var code = qcCode();
    if (!code) {
      API.toast("先输个编号", true);
      if (codeEl && codeEl.focus) {
        codeEl.focus();
      }
      return;
    }
    var n = qcQty();
    var r = qcApply(state.draft.items, code, n);
    qcLast = r.item;
    qcLog.push({ item: r.item, n: r.n, created: r.created });
    // 按编号排一次（跟行内定稿编号同一个口径）：关掉面板看到的是编号顺序，不会新记的散在最后
    sortDraftItems(null);
    if (codeEl) {
      codeEl.value = "";
    }
    var nm = $("qcNum");
    if (nm) {
      nm.value = "";
    }
    renderQcLog();
    qcHint();
    // ⚠️ 面板开着也要重画列表：顶上那条「缺货 3」和两页款数是**列表算出来的**，
    //   不跟着变的话他记完 20 笔、面板一关才发现数字还是进来时那个。
    renderItems();
    renderSummary();
    markDirty();
    if (codeEl && codeEl.focus) {
      codeEl.focus();
    }
  }
  /** 撤掉第 k 笔（× 那颗） */
  function qcUndo(k) {
    var e = qcLog[k];
    if (!state.draft || !e) {
      return;
    }
    var gone = qcUndoApply(state.draft.items, e);
    qcLog.splice(k, 1);
    if (gone >= 0) {
      state.openRow = -1; // 刚删的正好是摊开那行（理论上 openQc 时已经收了）
    }
    if (qcLast === e.item) {
      qcLast = qcLog.length ? qcLog[qcLog.length - 1].item : null;
    }
    renderQcLog();
    qcHint();
    renderItems();
    renderSummary();
    markDirty();
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
      // 现场新货行：进价/件数一改，展开块那句合计跟着变（2026-10-17）
      var amt = row.querySelector(".pit-amt");
      if (amt) {
        amt.textContent = amtTxt(it);
      }
    }
    renderSummary();
    // 「缺货」上那颗数字得当场跟着变（2026-10-17）：填满一行 → 缺的款数少一款，
    // 不然他要等下次整块重画才看得见，会以为"填了没生效"。
    // ⚠️ 但**这一行不立刻从列表里消失**：跟"填拿不重排"是同一课 —— 手正按在那儿，
    //    行突然没了会串行（下一格就填到别的商品上）。它等下一次重画（切页/再点开关）才走。
    renderShortBtn(state.draft.items);
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
        nm.textContent = "无此编号";
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
        sub.textContent = "无此编号";
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
      // ⚠️ 「缺货」也得先关：新加的是**空行**（没编号、没需）→ 它必然不算缺 → 会被筛掉看不见。
      //    跟上面清搜索是同一个坑（"点了加号没反应"），同一处解决。
      if (state.onlyShort) {
        state.onlyShort = false;
      }
      // 加的是哪一种行，看现在停在哪一页（2026-10-17）
      var fresh = {
        code: "",
        need: 0,
        got: 0,
        note: "",
        name: "",
        price: 0,
        img: "",
        kind: isLiveTab() ? 1 : 0,
      };
      state.draft.items.push(fresh);
      renderItems(); // 不算 dirty：空行不会存
      focusLastCode();
      // ⭐ 加完**自动高亮**这一行（2026-10-17 晚，老板："我添加一行时，自动高亮哪行，
      //    就和那个自动合并一样的主题色处理"）。
      // 走的还是"编号撞车并进哪一行"那个 markRow（`.pit.hit`：品牌绿左侧细条 + 淡绿底 + 弹一下）——
      // 同一件事（"新出现的那行在哪"）就该是同一个标记，别为它再造一套颜色。
      // ⚠️ 放在 focusLastCode **之后**：先聚焦（键盘弹起、视口已经挪过），再按"看不见才滚"补一刀，
      //    不然滚完又被聚焦那一下拽回去。
      markRow(fresh);
    };
    // 两段开关：要补的 / 现场进的（外观分页，底层同一张单 —— 见 index.html 那段注释）
    $("purchaseTabPlan").onclick = function () {
      setPTab("plan");
    };
    $("purchaseTabLive").onclick = function () {
      setPTab("live");
    };
    // 底栏那颗「快速记」→ 底部面板（2026-10-17 晚）
    $("purchaseQuickBtn").onclick = openQc;
    $("qcDone").onclick = doneQc;
    // 「取消」＝撤掉本次记的那几笔再关（老板 2026-10-17 在他给的两个选项里挑的）
    $("qcCancel").onclick = cancelQc;
    $("qcAdd").onclick = qcCommit;
    // 点面板外面那层半透明区：**什么都不做**（2026-10-17 晚，老板："只要显示确认和完成按钮就行，
    // 其他就不能随便点，或者说做成模态窗口"）。
    // ⚠️ 原来是"点外面 = 收起"，看着方便，实际是档口场景里最容易出的错：他一手拿货一手点屏幕，
    //    误触一下面板就没了 —— 而"加上了没有"这件事在面板关掉之后是看不出来的（列表里那行本来就该有），
    //    他只会以为记进去了。所以现在**只有「加上」和「完成」两个出口**。
    // 点外面唯一的反应＝把焦点抢回编号框（刚从键盘收起状态点回来时，能接着敲）。
    $("qcSheet").onclick = function (e) {
      if (e.target !== $("qcSheet")) {
        return;
      }
      var qc = $("qcCode");
      if (qc && qc.focus) {
        qc.focus();
      }
    };
    // 敲编号就实时给提示（⚠️ 这里**只**更提示、绝不提交 —— 跟行内编号那个坑同一条规矩：
    //   `canonicalCode` 对没输完的内容照样补零，边打边归一等于敲一个 3 就变成 A003）
    $("qcCode").oninput = qcHint;
    $("qcNum").oninput = qcHint; // 件数一变，提示里"加上记 8"那个数得跟着变
    // 回车连跳：编号 ⏎ → 件数；件数 ⏎ → 加上（清空、回编号）。
    // ⚠️ 老实说：iPhone/Android 的**数字键盘上没有 Return 键**，所以第二跳实际上是他点旁边那颗
    //    「加上」（就在件数右边 7px，还在键盘上方）。这里照样接上 Enter，是为了外接键盘 / 电脑上
    //    用手机版时也能一路敲到底 —— 不能因为"手机上用不到"就不写。
    $("qcCode").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        $("qcNum").focus();
      }
    });
    $("qcNum").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        qcCommit();
      }
    });
    // 撤掉某一笔（胶囊上的 ×）
    $("qcLog").onclick = function (e) {
      var x = e.target.closest(".qc-x");
      if (!x) {
        return;
      }
      qcUndo(num(x.getAttribute("data-k")));
    };
    // 键盘遮挡：`--kb` 那套原来只接在 #fieldSheet 上（见 app.js 那段），这个面板也得垫 ——
    // 不然底部 sheet 会被键盘整个压住，"加上"那颗根本露不出来。
    // 复用同一个变量名（--kb）和同一套算法：Android 自己会 resize，量出来是 0，垫不垫都一样。
    if (window.visualViewport) {
      var qvv = window.visualViewport;
      var liftQc = function () {
        var kb = Math.max(0, window.innerHeight - qvv.height - qvv.offsetTop);
        var qs = $("qcSheet");
        if (qs) {
          qs.style.setProperty("--kb", kb + "px");
        }
      };
      qvv.addEventListener("resize", liftQc);
      qvv.addEventListener("scroll", liftQc);
    }
    // 「缺货」（2026-10-17 晚，老板："把紧急缺货的自动筛选出来"）：
    // ⚠️ **只切筛选、不排序**（老板原话："不需要按多的排序"）—— 列表顺序还是编号顺序。
    // ⚠️ 也不重排 items / 不改 data-i：只是"不画"，改数量、删行仍按真实下标走。
    // ⚠️ 汇总那句要跟着换（renderSummary 里判断 shortOnly()）：列表剩 3 行、底下写"共 12 款"
    //    会让人以为列表少画了。
    $("purchaseOnlyShort").onclick = function () {
      if (!state.draft) {
        return;
      }
      state.onlyShort = !state.onlyShort;
      state.openRow = -1; // 摊开的那行可能已经被筛掉了，别留个 -1 之外的幽灵
      renderItems();
      renderSummary();
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
      } else if (t.classList.contains("pi-name")) {
        // 现场新货行的名字：**边打边记**（不用等失焦），删行/返回都丢不了
        it.name = t.value;
        markDirty();
        return;
      } else if (t.classList.contains("pi-price")) {
        // 进价一填/一改，第二行右端那个合计就跟着变（updateRowLive 里管 .pit-amt）
        it.price = num(t.value);
        updateRowLive(i);
        markDirty();
        return;
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
        // 跟**后端保存时**同一套口径（原来这里只做去空格+大写，于是输 `006` 界面说"无此编号"、
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
      // 认货照那格：**没图 → 拍照/选图；有图 → 先给看大图**（2026-10-17 老板："能查看大图就好了"）。
      // 换图放进大图里那颗「换一张」，别让"看"和"换"抢同一个点击。
      var shot = e.target.closest(".pi-shot");
      if (shot) {
        if (!state.draft) {
          return;
        }
        var si = rowIndex(shot);
        if (si >= 0) {
          if (shot.classList.contains("has")) {
            showShotView(si);
          } else {
            pickPhoto(si);
          }
        }
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
      // ⭐ 现场新货行**没有抽屉**（2026-10-17 晚 B 档）：备注和删除都常驻在第二行，
      //   再来一次"点行展开"只会把 `.open` 打开一个不存在的 `.pit-x`（什么都不发生，
      //   还会把 state.openRow 指到这一行上）。所以这里直接不管它。
      if (row.classList && row.classList.contains && row.classList.contains("pit-live")) {
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
