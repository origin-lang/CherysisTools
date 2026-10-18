// 手机版「直播排品」—— **独立功能文件**，2026-10-17 第二版。
//
// 为什么单独一个文件：跟商品 / 进货单没有耦合，状态、渲染、事件全在这儿，样式在 live.css，
// 骨架是 index.html 里的 #screen-live 一屏 + 底部 #tabLive 那一格。
// 想整体摘掉：删本文件 + live.css + 那一屏 + 那一格 + 两行引入，app.js 不用动。
//
// ⚠️⚠️ 第一版做错了一次：做成了"成品文件墙"（把生成好的九宫格图 / HTML 列出来看），
//    老板当场否掉 ——「我以为是类似于现在的九宫格排品那样的呢」。
//    他要的是**排品表本身**：每组 3×3 格子，格子里是编号，能改、能存回库。
//    所以这个文件现在干的事跟电脑端 client-live.js 是**同一套业务**，只是长在手机上。
//
// ⭐ 口径以电脑端 `src/tools/shopTool/client-live.js` 为准，改这边先去那边对一遍：
//   · 每组固定 9 格；**序号跨组连续**（第 N 组第 s 格 = (N-1)*9+s 号）
//   · `slot_no: 0` 是「这一组存在但全是空格」的占位行 —— 保存时**要带着它**
//     （不然加了一组空组，存下去就没了）；删组 = 把这些行整组去掉（组号不重排，后面的组不变）
//   · 同一个编号在**整份排品里**出现两次就算重复（跨组也算），格子标橙
//   · 编号库里没有 → 标红，但**照样存**（电脑端就是这口径：先排上，回头补商品）
//   · 存的是**整张表**（后端 replaceLivePlan，一次事务），所以节流后整表发一次
//
// ⭐ 手机上跟电脑端**不一样**的两处（都是有意的）：
//   1. 格子输入不做"边打边存"：打字只改外观，**失焦或停手 800ms** 才落位 + 排保存
//      （电脑端是 350ms 节流；手机走 HTTP，太密了等于每敲一个字发一单）
//   2. 落位后**绝不整块重绘**（只改那一格的封面和组头计数）—— 手机上重绘一次，
//      正在输入的格子会被冲掉，键盘也会跳。只有加组/删组/清空组才整块重画。
//
// ⚠️ 2026-10-17 晚删掉了「星标备选」那一排（老板：「手机浏览器那边 画册星标选品那个不需要显示」）：
//    连同它「点一下填到下一个空格」的 fillNext() 一起去掉了。手机屏就这么宽，排品时那一排
//    只是占掉一行高度；电脑端画册的 ⭐ 本身没动（那边的星标总览出图照常用）。

(function () {
  "use strict";

  // 主页面（app.js）结尾那条缝。拿不到说明脚本顺序不对（本文件必须排在 app.js 之后）
  var API = window.Cherysis;
  if (!API) {
    return;
  }
  var $ = API.$;
  var esc = API.esc;

  /** 整表保存的节流（毫秒）。连着改几格只发一次 saveLivePlan */
  var SAVE_DELAY = 800;
  /** 每组固定 9 格 */
  var SLOTS = 9;

  var state = {
    loaded: false, // 拉过一次没有
    plan: [], // [{group_no, slot_no, code}]（slot_no=0 = 空组占位，跟库里一致）
    hint: "", // 顶上一行提示（空态 / 保存中 / 读不到）
    saving: false, // 有 saveLivePlan 在飞
    dirty: false, // 本地改过还没存下去
    saveTimer: null,
    savedEcho: false, // 下一次 liveState 大概率是我们自己刚存完的回包（吃掉一次，不重画）
    sheetGroup: 0, // 「⋯」正在操作哪一组（0 = 没开）
    labelMode: "num", // 生成时编号怎么标（四态，跟桌面端 live_grid_label 一套）
    genBusy: false, // 有生成任务在跑（服务端同一时刻只准一个）
  };

  // ---------- 工具 ----------
  /**
   * 编号归一。⚠️⚠️ **口径出处 ＝ `src/tools/shopTool/pricing.ts` 的 `canonicalCode()`**，别自己发明：
   * 后端保存、桌面端排品输编号、手机版商品筛选的区间语法用的都是它（"纯数字算 A 段"）。
   * 这里抄一份是为了守「独立功能文件」约定（功能自己的逻辑不进 app.js）；
   * `purchase.js` 里也有一份同样的抄本。改这里**必须同步**那两处 —— 自检里有一条拿
   * 后端编译产物逐例比对的断言钉着。
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

  function productOf(code) {
    return code ? API.findProductByCode(code) : null;
  }

  /** 整份排品里每个编号出现几次（跨组也算，跟电脑端 liveDupCounts 一条口径） */
  function dupCounts() {
    var m = {};
    for (var i = 0; i < state.plan.length; i++) {
      var c = state.plan[i].code;
      if (c) {
        m[c] = (m[c] || 0) + 1;
      }
    }
    return m;
  }

  function groupNos() {
    var seen = {};
    var out = [];
    for (var i = 0; i < state.plan.length; i++) {
      var g = Number(state.plan[i].group_no);
      if (!seen[g]) {
        seen[g] = 1;
        out.push(g);
      }
    }
    return out.sort(function (a, b) {
      return a - b;
    });
  }

  function codeAt(g, s) {
    for (var i = 0; i < state.plan.length; i++) {
      if (Number(state.plan[i].group_no) === g && Number(state.plan[i].slot_no) === s) {
        return state.plan[i].code || "";
      }
    }
    return "";
  }

  /** 这一组里填了几格（slot_no=0 的占位行不算） */
  function filledOf(g) {
    var n = 0;
    for (var i = 0; i < state.plan.length; i++) {
      var r = state.plan[i];
      if (Number(r.group_no) === g && Number(r.slot_no) > 0 && r.code) {
        n++;
      }
    }
    return n;
  }

  /** 改一格：code 空 = 把这格删掉（跟电脑端 upsertLiveSlot 一样） */
  function upsert(g, s, code) {
    var next = [];
    for (var i = 0; i < state.plan.length; i++) {
      var r = state.plan[i];
      if (Number(r.group_no) === g && Number(r.slot_no) === s) {
        continue;
      }
      next.push(r);
    }
    if (code) {
      next.push({ group_no: g, slot_no: s, code: code });
    }
    state.plan = next;
    state.dirty = true;
  }

  /** 发给后端的那份：空格子不发，但 `slot_no:0` 的空组占位要发（跟电脑端一致） */
  function planForSave() {
    var out = [];
    for (var i = 0; i < state.plan.length; i++) {
      var r = state.plan[i];
      if (r.code || Number(r.slot_no) === 0) {
        out.push({ group_no: Number(r.group_no), slot_no: Number(r.slot_no), code: r.code || "" });
      }
    }
    return out;
  }

  // ---------- 保存 ----------
  function scheduleSave() {
    state.dirty = true;
    setLiveHint(state.saving ? "保存中…" : "有改动，马上存…");
    // 2026-10-18：「有改动」小红点（原来挂在列表页，直播屏也一直在改数据，照样该亮）
    if (API.markStale) {
      API.markStale();
    }
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(doSave, SAVE_DELAY);
  }

  function doSave() {
    if (!state.dirty) {
      return;
    }
    state.dirty = false;
    state.saving = true;
    setLiveHint("保存中…");
    API.invoke("saveLivePlan", { plan: planForSave() })
      .then(function (j) {
        // ⚠️ 业务失败（只读模式、库被锁）不会 reject，只会带一条红 toast 回来 ——
        //    不认这个标记就会一边写着「已保存」一边什么都没存进去。
        if (j && j.__opFailed) {
          throw new Error("被拒了（只读模式开着？）");
        }
        state.saving = false;
        // 刚存成功 → 紧接着那条 liveState 多半就是这次的回包（内容跟本地一模一样），
        // 让它别触发 render()（见 bind() 里那条监听）
        state.savedEcho = true;
        // 保存期间又改了 → 再排一次（别把这几秒里敲的东西丢了）
        if (state.dirty) {
          scheduleSave();
        } else {
          setLiveHint("已保存");
        }
      })
      .catch(function (err) {
        state.saving = false;
        state.dirty = true;
        setLiveHint("没存下去：" + ((err && err.message) || err));
        API.toast("排品没存下去，检查一下服务", true);
      });
  }

  // ---------- 画 ----------
  function setLiveHint(text) {
    state.hint = text || "";
    var el = $("liveHint");
    if (el) {
      el.textContent = state.hint;
    }
  }

  /** 一格的 HTML。cls：ok / err（库里没有）/ dup（重复）/ empty */
  function cellHtml(g, s, dups) {
    var code = codeAt(g, s);
    var num = (g - 1) * SLOTS + s;
    var p = productOf(code);
    var cls = !code ? "empty" : !p ? "err" : dups[code] > 1 ? "dup" : "ok";
    var cover = p ? '<img src="' + esc(API.imgUrl(code)) + '" alt="" loading="lazy" />' : "";
    return (
      '<div class="lv-cell ' +
      cls +
      '" data-g="' +
      g +
      '" data-s="' +
      s +
      '">' +
      '<span class="lv-num">' +
      num +
      "号</span>" +
      '<div class="lv-cover">' +
      cover +
      "</div>" +
      '<input class="lv-inp" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" ' +
      'spellcheck="false" maxlength="5" data-g="' +
      g +
      '" data-s="' +
      s +
      '" value="' +
      esc(code) +
      '" placeholder="' +
      esc(num + "号") +
      '" aria-label="' +
      num +
      '号，第' +
      g +
      "组第" +
      s +
      '格" />' +
      "</div>"
    );
  }

  function groupHtml(g, dups) {
    var startNum = (g - 1) * SLOTS + 1;
    var cells = "";
    for (var s = 1; s <= SLOTS; s++) {
      cells += cellHtml(g, s, dups);
    }
    return (
      '<section class="lv-group">' +
      '<div class="lv-ghead">' +
      "<b>第 " +
      g +
      " 组</b>" +
      '<span class="muted">' +
      startNum +
      "号~" +
      (startNum + 8) +
      '号 · <i class="lv-filled">' +
      filledOf(g) +
      "</i>/9</span>" +
      // 只出这一组（老板要的「生成本组」）：跟电脑端 client-live.js 组头那颗同一件事，
      // 发的是同一个 generateLiveGrid，只是多带一个 groups:[g]。
      '<button class="lv-gen" type="button" data-g="' +
      g +
      '" title="只生成这一组的九宫格">生成这组</button>' +
      '<button class="lv-more" type="button" data-g="' +
      g +
      '" title="清空本组 / 删组" aria-label="第' +
      g +
      '组的更多操作">⋯</button>' +
      "</div>" +
      '<div class="lv-9">' +
      cells +
      "</div>" +
      "</section>"
    );
  }

  function render() {
    var box = $("liveGroups");
    if (!box) {
      return;
    }
    var gs = groupNos();
    if (!gs.length) {
      // 空态要指路，别留一片白（一片白看着像页面坏了）
      box.innerHTML =
        '<p class="muted lv-empty">还没开始排品。<br />点下面「＋ 加一组」开一组，' +
        "再往格子里填编号（输 335 也行，会变成 A335）。</p>";
      setLiveHint(state.loaded ? "" : "读取中…");
      return;
    }
    var dups = dupCounts();
    var html = "";
    for (var i = 0; i < gs.length; i++) {
      html += groupHtml(gs[i], dups);
    }
    box.innerHTML = html;
  }

  /** 只刷新一格的外观（封面 + 边框色）：落位后绝不整块重绘，否则输入和键盘都会被冲掉 */
  function paintCell(g, s) {
    var cell = document.querySelector('.lv-cell[data-g="' + g + '"][data-s="' + s + '"]');
    if (!cell) {
      return;
    }
    var code = codeAt(g, s);
    var p = productOf(code);
    var dups = dupCounts();
    var cls = !code ? "empty" : !p ? "err" : dups[code] > 1 ? "dup" : "ok";
    cell.className = "lv-cell " + cls;
    var cover = cell.querySelector(".lv-cover");
    if (cover) {
      cover.innerHTML = p ? '<img src="' + esc(API.imgUrl(code)) + '" alt="" loading="lazy" />' : "";
    }
  }

  /**
   * 把每一格的颜色和组头的「N/9」重刷一遍（**不重建 DOM**）。
   * 改一格会影响别格的"重复"判定（跨组也算重复），所以改完要整体刷色。
   */
  function repaintAll() {
    var cells = document.querySelectorAll(".lv-cell");
    for (var i = 0; i < cells.length; i++) {
      paintCell(Number(cells[i].getAttribute("data-g")), Number(cells[i].getAttribute("data-s")));
    }
    var groups = document.querySelectorAll(".lv-group");
    for (var j = 0; j < groups.length; j++) {
      var more = groups[j].querySelector(".lv-more");
      var fill = groups[j].querySelector(".lv-filled");
      if (more && fill) {
        fill.textContent = String(filledOf(Number(more.getAttribute("data-g"))));
      }
    }
  }

  // ---------- 一格落位 ----------
  function commitCell(inp, e) {
    var g = Number(inp.getAttribute("data-g"));
    var s = Number(inp.getAttribute("data-s"));
    var raw = String(inp.value || "").trim();
    var code = raw ? canonicalCode(raw) : "";
    if (raw && !code) {
      // 压根不像编号（比如 "abc"）：不落库、标红、留着让他改
      inp.classList.add("err");
      API.toast("「" + raw + "」不是编号", true);
      return;
    }
    // 把 335 显示成 A335，所见即所存（跟电脑端一样）
    if (code && inp.value !== code) {
      inp.value = code;
    }
    if (codeAt(g, s) === code) {
      paintCell(g, s); // 没变也要把颜色对一遍（可能刚被别格的改动带着变）
      if (!code) {
        blurNow(inp);
      } else if (e && e.type === "focusout") {
        blurIfKeyboardGone(inp);
      }
      return;
    }
    upsert(g, s, code);
    paintCell(g, s);
    repaintAll();
    scheduleSave();
    // ⭐⭐ 2026-10-18（老板：「我发现手机排品那边 每修改一个编号 感觉全刷新」）：
    //    重绘不是元凶（repaintAll 只改 class/边框，DOM 不动），**键盘赖着不走**才是。
    //    回车 → 焦点跳到下一格，那是他要的「接着填」；但换格 / 点封面 / 点组头 / 按「完成」
    //    都会走 focusout，光标留在这一格就等于键盘不收 —— 一整屏格子被键盘顶上去/退回来，
    //    看着就是「页面重来了一遍」，还容易把那一行的位置记错。
    //    所以两种情形主动放掉焦点（让键盘收起来）：
    //      ① 这一格被改成了**空**（清掉一个编号，接着往下敲的概率最低）
    //      ② 键盘是让系统收掉才触发的失焦（按「完成」/点空白 —— 他已经想收了）
    //    ⚠️ 不能当场判 `document.activeElement`：focusout 派发那一瞬焦点**还没落到新目标**
    //    （还是 body），「点下一格」跟「按完成收键盘」当场长得一模一样 →
    //    交给 blurIfKeyboardGone 推到下一拍再判。
    if (!code) {
      blurNow(inp);
    } else if (e && e.type === "focusout") {
      blurIfKeyboardGone(inp);
    }
    // 被按住的那次「别人改过 → 自动刷新」：离开输入框后补上（跟 app.js 里那条一样）
    if (API.refreshIfStale) {
      setTimeout(API.refreshIfStale, 60);
    }
  }

  /**
   * 键盘是被系统收掉才走的这一趟吗？是就把焦点也放掉（否则在某些机器上键盘会"弹回来"）。
   *
   * ⚠️ 为什么不能当场判 `document.activeElement`：focusout 派发的那一瞬焦点**还没落到新目标**，
   *    activeElement 还是 body —— 「点了另一格」和「按完成收键盘」在这一刻长得一模一样，
   *    当场判就会把「点下一格」当成收键盘，用户正要点着填就突然没键盘了。
   *    所以推到下一拍（focusin 已经来过）：焦点落在别的格子上 → 什么都不做。
   */
  function blurIfKeyboardGone(inp) {
    var target = inp;
    setTimeout(function () {
      var a = document.activeElement;
      if (!a || a === document.body) {
        blurNow(target);
      }
    }, 0);
  }

  function blurNow(inp) {
    if (inp && inp.blur) {
      inp.blur();
    }
  }

  // ---------- 组操作 ----------
  function nextGroupNo() {
    var used = {};
    var gs = groupNos();
    for (var i = 0; i < gs.length; i++) {
      used[gs[i]] = 1;
    }
    var g = 1;
    while (used[g]) {
      g++;
    }
    return g;
  }

  function addGroup() {
    var g = nextGroupNo();
    // slot_no:0 是"空组"的占位行：不加它，存下去这个组就消失了
    state.plan.push({ group_no: g, slot_no: 0, code: "" });
    state.dirty = true;
    render();
    scheduleSave();
    var groups = document.querySelectorAll(".lv-group");
    var last = groups.length ? groups[groups.length - 1] : null;
    if (last && last.scrollIntoView) {
      last.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    var first = document.querySelector('.lv-cell[data-g="' + g + '"][data-s="1"] .lv-inp');
    if (first && first.focus) {
      first.focus();
    }
  }

  function clearGroup(g) {
    var next = [{ group_no: g, slot_no: 0, code: "" }];
    for (var i = 0; i < state.plan.length; i++) {
      var r = state.plan[i];
      if (Number(r.group_no) !== g) {
        next.push(r);
      }
    }
    state.plan = next;
    state.dirty = true;
    render();
    scheduleSave();
    API.toast("第 " + g + " 组清空了");
  }

  function removeGroup(g) {
    var next = [];
    for (var i = 0; i < state.plan.length; i++) {
      if (Number(state.plan[i].group_no) !== g) {
        next.push(state.plan[i]);
      }
    }
    state.plan = next;
    state.dirty = true;
    render();
    scheduleSave();
    API.toast("第 " + g + " 组删了");
  }

  // ---------- 读 ----------
  /**
   * 后端回推的那份排品 → 本地。
   *
   * ⭐⭐ 2026-10-18（老板：「我发现手机排品那边 每修改一个编号 感觉全刷新」）：
   * **光标还在某一格里时绝不重建 DOM**。以前这里无条件是 `render()`（innerHTML 整块换掉），
   * 只要后端回一条 `liveState`（自己保存的回包、别人改完的广播、点一次「直播」页签的 getLiveState），
   * 正在编辑的那一格连同输入法状态一起被换掉了 —— 键盘还在、字没了、格子还跳了一下。
   * 现在：有格子在编辑 → 把数据收下、只重挑颜色（repaintAll 不碰 DOM 结构），
   * 等真正需要重建时（离开输入框 / 那一格失焦后）再说。
   */
  function applyLiveState(m) {
    state.plan = Array.isArray(m.plan)
      ? m.plan.map(function (r) {
          return {
            group_no: Number(r.group_no),
            slot_no: Number(r.slot_no),
            code: String(r.code || ""),
          };
        })
      : [];
    state.loaded = true;
    if (editingCell()) {
      repaintAll(); // 数据变了，但结构不动：正在敲的那一格不能被换掉
      return;
    }
    render();
  }

  /** 此刻有没有格子正在编辑（有 = 不能整块重画） */
  function editingCell() {
    var a = document.activeElement;
    return !!(a && a.classList && a.classList.contains("lv-inp"));
  }

  function load() {
    setLiveHint("读取中…");
    return API.invoke("getLiveState").catch(function (err) {
      setLiveHint("读不到排品：" + ((err && err.message) || err));
    });
  }

  // ---------- 生成 ----------
  /**
   * 三个出口 ↔ 后端消息名。加第四个产物时只动这张表 + index.html 里那一项。
   * ⚠️ 三条都是**同一份排品数据**（直接把当前 plan 发过去，不等保存落库 ——
   *    后端本来就用 msg.plan 渲染，落库那一步只是顺手）；
   *    所以刚改完一格马上点生成，出去的就是刚改的那一版。
   */
  var GEN_MSG = {
    grid: "generateLiveGrid",
    long: "generateLiveLong",
  };

  /**
   * 发给服务端的请求地址（配了 token 时都要带上）。
   * ⚠️ `/api/` 下一律校验 token，而 live.js 自己的 fetch 不经过 app.js 的 invoke，
   *    漏了就是 403 —— 表现是「成品列表一直空着」，看不出是权限问题。
   */
  function apiUrl(p) {
    if (!API.token) {
      return p;
    }
    return p + (p.indexOf("?") < 0 ? "?" : "&") + "token=" + encodeURIComponent(API.token);
  }

  /**
   * 编号标注：桌面端叫 live_grid_label，四态 num/code/both/none。
   * 存在本机 localStorage（它只是**这一次生成**的参数，不是全局配置），默认跟桌面端一样是 num。
   */
  var LABEL_KEY = "cherysis_live_label";

  function labelMode() {
    var v = "";
    try {
      v = String(localStorage.getItem(LABEL_KEY) || "");
    } catch (e) {
      v = "";
    }
    return v === "code" || v === "both" || v === "none" ? v : "num";
  }

  function setLabelMode(v) {
    try {
      localStorage.setItem(LABEL_KEY, v);
    } catch (e) {
      /* 隐私模式写不进去：这一次照样生效（state 里记着），下次回到默认 */
    }
    state.labelMode = v;
    paintLabelSeg();
  }

  function paintLabelSeg() {
    var seg = $("liveLabelSeg");
    if (!seg) {
      return;
    }
    var btns = seg.querySelectorAll("button[data-mode]");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute("data-mode") === labelMode();
      btns[i].className = on ? "on" : "";
    }
    var hint = $("liveCfgHint");
    if (hint) {
      var m = labelMode();
      hint.textContent =
        m === "none"
          ? "格子上不写字。"
          : "例：" + (m === "code" ? "A001" : m === "both" ? "1号 A001" : "1号");
    }
  }

  /** 有没有东西可生成：至少一格是有编号的（跟电脑端 liveGeneratableGroups 一个门槛） */
  function filledCount() {
    var n = 0;
    for (var i = 0; i < state.plan.length; i++) {
      if (state.plan[i].code) {
        n++;
      }
    }
    return n;
  }

  function setGenBusy(on) {
    state.genBusy = !!on;
    var btn = $("liveGenLong");
    if (btn) {
      btn.disabled = !!on;
      btn.textContent = on ? "生成中…" : "生成长图";
    }
    var box = $("liveGroups");
    if (box) {
      // 只切一个 class，不重画（重画会把正在输入的格子冲掉）
      box.className = on ? "lv-groups busy" : "lv-groups";
    }
  }

  /**
   * 发一次生成。groups 为空 = 全部可生成的组。
   * ⚠️ skipConfirm 是**手机端专有**的：网页版宿主没有对话框通道，后端那条
   *    「确认输出目录」会一路走到「已取消生成」，表现就是点了没反应。
   */
  function genStart(kind, groups) {
    var msgType = GEN_MSG[kind] || GEN_MSG.grid;
    if (state.genBusy) {
      API.toast("正在生成，等这一批出完再点", true);
      return;
    }
    // 落位只在失焦/回车 —— 点按钮时输入框会先失焦（focusout 已经把它提交了），
    // 但手机上点浮动条不一定触发失焦，这里再兜一次，免得"刚敲的那格没进图"
    var act = document.activeElement;
    if (act && act.classList && act.classList.contains("lv-inp")) {
      commitCell(act, null);
    }
    if (!filledCount()) {
      API.toast("先往格子里填至少一个有效编号", true);
      return;
    }
    setGenBusy(true);
    setLiveHint("生成中…");
    // 顺手把当前这份排品落库（后端只用 msg.plan 渲染，这一步是给电脑端/下次进来的自己看）
    if (state.dirty) {
      scheduleSave();
    }
    var payload = {
      plan: planForSave(),
      labelMode: labelMode(),
      skipConfirm: true,
      // ⚠️⚠️ inline：**别让后端往电脑目录写文件**（老板：「和进货单那样子，就是生成直接出来显示嘛，
      //    为什么写的电脑上的目录里呢？我不想这样」）。后端收到它就只在内存里出图，
      //    把 base64 直接推回这台手机；目录相关的确认/选择整块跳过。
      inline: true,
    };
    if (groups && groups.length) {
      payload.groups = groups;
    }
    API.invoke(msgType, payload)
      .then(function (j) {
        // 业务失败不 reject（只回一条红 toast）—— 那种情况忙碌态交给 catch 之外收尾
        if (j && j.__opFailed) {
          setGenBusy(false);
          setLiveHint("");
        }
      })
      .catch(function (err) {
        setGenBusy(false);
        setLiveHint("");
        API.toast("发不出去：" + ((err && err.message) || err), true);
      });
    // 成功这条路不等回包：真正的结束看下面 liveGridStatus 的 done/error/cancelled
  }

  /**
   * 进度：后端每条退出路径都会发一条终态（done/error/cancelled）。
   * ⚠️ 没有这一条，按钮会永远停在「生成中」—— 桌面上栽过，手机上（没有日志面板）更看不出来。
   */
  function bindGenStatus() {
    API.on("liveGridStatus", function (m) {
      var ph = m && m.phase;
      if (ph === "start") {
        setGenBusy(true);
        setLiveHint("生成中…");
        return;
      }
      if (ph === "dialog") {
        // 正常走不到（我们带 skipConfirm）：只有「目录不可用」那条会来，说明白了别让人干等
        setLiveHint(m.text || "等电脑上选一下目录…");
        return;
      }
      if (ph === "running") {
        var done = Number(m.done || 0);
        var total = Number(m.total || 0);
        setLiveHint(
          total ? "生成中 " + done + "/" + total + (m.group ? "（第 " + m.group + " 组）" : "") : "生成中…",
        );
        return;
      }
      if (ph === "done") {
        setGenBusy(false);
        if (m.inline) {
          // 图已经在弹层里了（liveInlineImage 先到）：这里只收忙碌态 + 改一句提示。
          setLiveHint(
            "生成好了 · 长按图能存进相册" + (m.skipped ? "（" + m.skipped + " 组没图，跳过了）" : ""),
          );
          return;
        }
        // 手机上发出去的永远带 inline:true，图已经当场弹过了；
        // 这条分支只剩"电脑端触发生成"时才会走到（手机收不到落盘那套）。
        setLiveHint("已在电脑上生成 " + Number(m.count || 0) + " 张（手机上不弹）");
        return;
      }
      if (ph === "error" || ph === "cancelled") {
        setGenBusy(false);
        setLiveHint("");
        API.toast((m && m.text) || (ph === "error" ? "生成出错" : "已取消"), true);
      }
    });
  }

  // ---------- 生成完直接显示（手机出图不落电脑目录，2026-10-18） ----------
  // 后端把 jpg 字节 base64 直接推回这台手机（跟进货单导出 xlsx 同一个套路），
  // 这里解成 Blob 塞进同一个大图弹层：长按能存相册，底部「存这张」走 a[download]。
  // ⚠️ 微信内置浏览器会拦 a[download]：要用主屏图标（真浏览器）打开才下得动。
  var inlineUrl = "";
  function blobUrlOf(b64) {
    var bin = atob(b64);
    var n = bin.length;
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  }

  /** 上一张的 blob 到下一次生成才释放（关掉弹层还留着，方便回头看/再存） */
  function showInline(m) {
    var b64 = String((m && m.b64) || "");
    if (!b64) {
      return;
    }
    var view = $("liveArtView");
    var img = $("liveArtImg");
    var dl = $("liveArtDl");
    if (!view || !img) {
      return;
    }
    if (inlineUrl) {
      URL.revokeObjectURL(inlineUrl);
      inlineUrl = "";
    }
    inlineUrl = blobUrlOf(b64);
    img.src = inlineUrl;
    if (dl) {
      dl.setAttribute("href", inlineUrl);
      dl.setAttribute("download", String(m.file || "九宫格.jpg"));
    }
    view.hidden = false;
    setLiveHint("生成好了 · 长按图能存进相册");
  }

  function bindInline() {
    API.on("liveInlineImage", function (m) {
      showInline(m);
    });
  }

  // ---------- 大图弹层（生成完直接显示 / 关闭） ----------
  // ⚠️ 2026-10-18 老板：「已生成这个入口我不需要」→ 原来的成品列表层（/api/live/list|thumb|file|delete
  //    那一整套 loadArts/renderArts/deleteArt/openArt）整块撤了，只剩这个弹层给"生成完直接显示"用。
  //    后端那几个接口没删（电脑端产物还在用它那套白名单，动它们要另开一轮）。
  function closeArt() {
    var view = $("liveArtView");
    if (view) {
      view.hidden = true;
    }
    var img = $("liveArtImg");
    if (img) {
      img.removeAttribute("src"); // 关掉就把大图放下（手机内存紧）
    }
  }

  // ---------- 接线 ----------
  function openSheet(g) {
    state.sheetGroup = g;
    var bg = $("liveSheet");
    if (!bg) {
      return;
    }
    var t = $("liveSheetTitle");
    if (t) {
      t.textContent = "第 " + g + " 组 · " + filledOf(g) + "/9 已填";
    }
    bg.hidden = false;
  }

  function closeSheet() {
    state.sheetGroup = 0;
    var bg = $("liveSheet");
    if (bg) {
      bg.hidden = true;
    }
  }

  function bind() {
    var tab = $("tabLive");
    if (tab) {
      tab.onclick = function () {
        API.show("screen-live");
        // 每次进来重读一遍：电脑版刚排的、另一台手机刚改的，都要看见
        load();
      };
    }
    // ⚠️ 2026-10-18 老板：「刷新是啥意思，感觉没啥用」→ 原来那颗 ↻（#liveRefreshBtn，手动重读库）撤了。
    //    进屏本来就会 load() 一遍，多设备同步靠保存广播，没有"要手动拉"的场景。
    var groups = $("liveGroups");
    if (groups) {
      // ⚠️ 2026-10-18 凌晨（老板：「我感觉编号好像是实时变化的…实时刷新太不稳定了，为啥不能我失焦后再刷新」）：
      // 原来这里有个「停手 800ms 就自动落位」的定时器（COMMIT_DELAY），已经整段删掉。
      // 现在**打字什么都不发生**：只有失焦（点别处 / 收键盘 / 点生成）或回车才算这一格填完。
      // 为什么必须这样：一落位就要 upsert + repaintAll（重复判定是跨组的），
      // 别的格子的边框会在你还在敲的时候变色，看着像"自己在变"；而且半成品 "A01" 一旦被
      // 别处的重绘带出来，会当场改掉正在敲的字。
      // 失焦 = 这一格输完了（点别处、收键盘、滚走都算）→ 落位
      groups.addEventListener(
        "focusout",
        function (e) {
          var inp = e.target;
          if (!inp || !inp.classList || !inp.classList.contains("lv-inp")) {
            return;
          }
          commitCell(inp, e);
        },
        true,
      );
      // 回车 = 下一格（手机上"下一格"比"完成"有用，跟电脑端一条口径）
      groups.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") {
          return;
        }
        var inp = e.target;
        if (!inp || !inp.classList || !inp.classList.contains("lv-inp")) {
          return;
        }
        e.preventDefault();
        var all = document.querySelectorAll(".lv-inp");
        for (var i = 0; i < all.length; i++) {
          if (all[i] === inp) {
            var next = all[i + 1];
            if (next && next.focus) {
              next.focus();
              if (next.select) {
                next.select();
              }
            }
            return;
          }
        }
      });
      // 组头「⋯」：组是重画出来的，走委托
      groups.addEventListener("click", function (e) {
        var gen = e.target && e.target.closest ? e.target.closest(".lv-gen") : null;
        if (gen) {
          genStart("grid", [Number(gen.getAttribute("data-g"))]);
          return;
        }
        var more = e.target && e.target.closest ? e.target.closest(".lv-more") : null;
        if (more) {
          openSheet(Number(more.getAttribute("data-g")));
          return;
        }
        // 点封面 = 聚焦那一格的输入（手机上小格子不好点，整块都能点）
        var cover = e.target && e.target.closest ? e.target.closest(".lv-cover") : null;
        if (cover) {
          var cell = cover.closest(".lv-cell");
          var inp = cell ? cell.querySelector(".lv-inp") : null;
          if (inp && inp.focus) {
            inp.focus();
          }
        }
      });
    }
    var add = $("liveAddGroup");
    if (add) {
      add.onclick = addGroup;
    }
    var sheet = $("liveSheet");
    if (sheet) {
      sheet.onclick = function (e) {
        if (e.target === sheet) {
          closeSheet();
        }
      };
    }
    var cancel = $("liveSheetCancel");
    if (cancel) {
      cancel.onclick = closeSheet;
    }
    var clear = $("liveSheetClear");
    if (clear) {
      clear.onclick = function () {
        var g = state.sheetGroup;
        closeSheet();
        if (g) {
          clearGroup(g);
        }
      };
    }
    var del = $("liveSheetDel");
    if (del) {
      del.onclick = function () {
        var g = state.sheetGroup;
        closeSheet();
        if (g) {
          removeGroup(g);
        }
      };
    }
    // ---- 生成：底栏那颗「生成长图」----
    // ⚠️ 2026-10-18 凌晨（老板：「手机上不需要支持生成全部九宫格（多张的），电脑更快；
    //    但可以暴露生成长图」）→ 原来那个三出口下拉（全部九宫格 / HTML 样品 / 一张长图）
    //    收成一颗按钮，只剩长图。每组那颗「生成这组」留着（单张、够快）。
    var genLong = $("liveGenLong");
    if (genLong) {
      genLong.onclick = function () {
        genStart("long", null);
      };
    }
    // ---- 清空所有格子（老板：「也没有全部清除格子的功能」）----
    // 口径跟电脑端 clearLivePlan 一致：**组留着**，9 格全清 —— 不是把组也删掉。
    var cfgClear = $("liveCfgClear");
    if (cfgClear) {
      cfgClear.onclick = function () {
        if (!filledCount()) {
          API.toast("格子本来就是空的");
          return;
        }
        if (!window.confirm("清空所有格子的编号？（组会留着，商品本身不动）")) {
          return;
        }
        var b = $("liveCfg");
        if (b) {
          b.hidden = true;
        }
        // ⚠️ 不能写成 `state.plan = []`：组的存在靠的就是 plan 里的行（slot_no:0 占位），
        //    清成空数组等于**连组一起删**，跟他要的「清除格子」不是一回事。
        //    这里给每组留一行空占位 → 组还在、号还在、9 格全空（跟 clearGroup 同一个形状）。
        var nos = groupNos();
        var next = [];
        for (var i = 0; i < nos.length; i++) {
          next.push({ group_no: nos[i], slot_no: 0, code: "" });
        }
        state.plan = next;
        state.dirty = true;
        render();
        scheduleSave();
        API.toast("格子清空了（" + nos.length + " 组都留着）");
      };
    }
    // ---- 配置（编号怎么标）----
    var cfgBtn = $("liveCfgBtn");
    if (cfgBtn) {
      cfgBtn.onclick = function () {
        paintLabelSeg();
        var b = $("liveCfg");
        if (b) {
          b.hidden = false;
        }
      };
    }
    var cfg = $("liveCfg");
    if (cfg) {
      cfg.onclick = function (e) {
        if (e.target === cfg) {
          cfg.hidden = true;
        }
      };
    }
    var cfgClose = $("liveCfgClose");
    if (cfgClose) {
      cfgClose.onclick = function () {
        var b = $("liveCfg");
        if (b) {
          b.hidden = true;
        }
      };
    }
    var labelSeg = $("liveLabelSeg");
    if (labelSeg) {
      labelSeg.onclick = function (e) {
        var b = e.target && e.target.closest ? e.target.closest("button[data-mode]") : null;
        if (b) {
          setLabelMode(b.getAttribute("data-mode"));
        }
      };
    }
    // ---- 大图弹层：关掉 / 点黑边收起（生成完直接显示用，2026-10-18） ----
    var artCloseBtn = $("liveArtClose");
    if (artCloseBtn) {
      artCloseBtn.onclick = closeArt;
    }
    var artView = $("liveArtView");
    if (artView) {
      artView.onclick = function (e) {
        if (e.target === artView) {
          closeArt();
        }
      };
    }
    // 后端回推的 liveState（自己保存的回包、别人改完的广播都走这条）
    API.on("liveState", function (m) {
      // 自己刚发的保存还在飞 / 本地还有没存的改动 → **不拿回包覆盖本地**
      // （覆盖了会把用户刚敲的那一格冲掉；服务端那份反正马上被我们自己的保存盖上）
      if (state.saving || state.dirty) {
        return;
      }
      // ⭐ 2026-10-18：**刚存完那一下的回包不重建 DOM**（老板：「每修改一个编号 感觉全刷新」）。
      //    这条几乎都是我们自己刚才那次 saveLivePlan 的回包，而本地那份就是源头、
      //    格子刚刚已经逐格刷过色了。整块重画 = 正在打字的那一格被换掉、键盘一抖。
      //    `savedEcho` 在 doSave 成功那一刻立起来，这里吃掉一次就落下 ——
      //    别人改完广播过来的那条没这个标记，照样走 applyLiveState（那条该更新）。
      if (state.savedEcho) {
        state.savedEcho = false;
        return;
      }
      applyLiveState(m);
    });
  }

  // 登记这一屏归底部哪一格亮（app.js 只认它自己那几屏，新屏要自己登记）
  API.registerScreen("screen-live", "tabLive");
  paintLabelSeg(); // 配置弹层里的四态先按本机记住的那个点亮
  bindGenStatus(); // 生成进度（后端每条退出路径都会发终态）
  bindInline(); // 生成结果直接推回来 → 当场显示
  bind();
})();
