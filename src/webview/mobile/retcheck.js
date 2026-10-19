// 手机版「退货核对」—— **独立功能文件**，2026-10-20（工具箱第一个工具）。
//
// 场景（老板原话定稿，见 memory/2026-10-20.md）：
//   粘贴一批**条形码**做退货清单 → 摄像头连续扫 →
//     · 在清单里（要退的） = **红** + 高音 + 尬住，按「知道了」才继续；
//     · 不在清单里         = **绿** + 低音，自动下一个；
//     · 重复扫             = 不重复计数，色和声照旧。
//   统计常驻两个数：已扫 N 件（唯一）+ 红 M 件。没有终态、不管进度。
//   清单一次会话一份，退出工具不落盘（刷新页面自然没）。
//
// ⚠️ 摄像头只在 https（668）能用 —— 不硬拦，CherysisScan.open() 在 http 下
//    自带「复制扫码地址」的降级提示（见 scan.js showCopyChip）。
//
// 模块化：本文件 + retcheck.css + index.html 里 #screen-retcheck 那一屏。
// 想整体摘掉：删这三样 + toolkit.js TOOLS 表里那一行。
(function () {
  "use strict";

  var API = window.Cherysis;
  if (!API) {
    return;
  }
  var $ = API.$;
  var esc = API.esc;
  var SCAN = window.CherysisScan;

  var state = {
    list: null, // Set<string>：退货清单（null = 还没导入过）
    scanned: {}, // 已记过的唯一码 → true（计数口径）
    red: 0, // 其中红色（要退的）件数
  };

  // ---------- 声音：Web Audio 现场合成，不引音频文件 ----------
  // iOS/安卓都能响；AudioContext 必须在用户手势之后才能出声 ——
  // 在「开始扫」那一下创建/恢复，之后连续扫就一路有声音。
  var audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          audioCtx = new AC();
        }
      }
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
      }
    } catch (e) {
      audioCtx = null;
    }
  }
  /**
   * 滴一声。
   * @param high true = 高音（红：命中待退，要叫人停下处理）；false = 低音短促（绿：放行）
   */
  function beep(high) {
    // ⚠️ 每次响之前都试着 resume：iOS 挂后台/锁屏回来 AudioContext 会被压成 suspended，
    //   只在「开始扫」那一下恢复是不够的（老板二轮报"声音好像没有出现"）。
    ensureAudio();
    if (!audioCtx) {
      return;
    }
    try {
      var t = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = high ? 1200 : 600;
      gain.gain.setValueAtTime(0.0001, t);
      // 0.18 → 0.28：手机外放要更响一点（第一轮老板没听到声音，两处一起加固）
      gain.gain.exponentialRampToValueAtTime(0.28, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + (high ? 0.32 : 0.12));
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + (high ? 0.35 : 0.15));
    } catch (e) {
      /* 声音失败不挡扫码 */
    }
  }
  /** 安卓震一下；iOS 网页不支持 vibrate，静默跳过 */
  function buzz(ms) {
    try {
      if (navigator.vibrate) {
        navigator.vibrate(ms);
      }
    } catch (e) {}
  }

  // ---------- 渲染 ----------
  function render() {
    var body = $("retBody");
    if (!body) {
      return;
    }
    if (!state.list) {
      body.innerHTML =
        '<div class="rt-paste">' +
        '<textarea id="retPaste" placeholder="把要退的条形码粘进来，一行一个：&#10;6901234567890&#10;6901234567891&#10;…" ' +
        'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>' +
        '<p class="rt-hint muted small">从微信 / 聊天记录里复制一批条码粘进来就行。粘完点下面开始。</p>' +
        '<div class="rt-act"><button id="retPasteBtn" class="primary" type="button">导入清单</button></div>' +
        "</div>";
      bindPaste();
      return;
    }
    // 已导入：扫描态
    var n = 0;
    for (var k in state.scanned) {
      if (Object.prototype.hasOwnProperty.call(state.scanned, k)) {
        n++;
      }
    }
    body.innerHTML =
      '<div class="rt-stats">' +
      '<div class="rt-stat"><b id="retN">' +
      n +
      '</b><span>已扫（件）</span></div>' +
      '<div class="rt-stat rt-g-red"><b id="retRed">' +
      state.red +
      '</b><span>其中待退（红）</span></div>' +
      "</div>" +
      '<div class="rt-band" id="retBand">还没开始扫</div>' +
      '<div class="rt-act">' +
      '<button id="retStart" class="primary" type="button">📷 开始连续扫</button>' +
      "</div>" +
      '<div class="rt-act">' +
      '<button id="retListBtn" class="mini" type="button">看清单</button>' +
      '<button id="retEditBtn" class="mini" type="button">编辑清单</button>' +
      '<button id="retClear" class="mini" type="button">清空重来</button>' +
      "</div>" +
      '<p class="rt-hint muted small">清单 ' +
      state.list.size +
      " 个条码 · 扫到清单里的会<b style=\"color:var(--danger)\">红</b>住等你按「知道了」，其他绿一下自动下一个。<br>" +
      "⚠️ 摄像头扫码要用<b>扫码地址（https）</b>打开本页；http 下打不开摄像头会给你复制的提示。</p>" +
      '<div id="retListCard" class="rt-paste" hidden></div>';
    bindScan();
  }

  // ---------- 绑定 ----------
  /** 粘贴源五花八门（逗号、分号、Tab 混着来的也兜住）：拆开 + 去空 + 去重 */
  function parseCodes(raw) {
    var seen = {};
    var list = [];
    String(raw || "")
      .split(/[\r\n,;，；\t]+/)
      .map(function (s) {
        return s.trim();
      })
      .forEach(function (s) {
        if (!s || seen[s]) {
          return;
        }
        seen[s] = true;
        list.push(s);
      });
    return list;
  }

  function bindPaste() {
    var btn = $("retPasteBtn");
    if (!btn) {
      return;
    }
    btn.onclick = function () {
      var ta = $("retPaste");
      var list = parseCodes(ta && ta.value);
      if (!list.length) {
        API.toast("先粘几个条码进来", true);
        return;
      }
      ensureAudio(); // 用户手势里建 AudioContext，后面扫到才有声
      state.list = new Set(list);
      state.scanned = {};
      state.red = 0;
      render();
      API.toast("清单 " + list.length + " 个条码");
    };
  }

  /**
   * 编辑清单态（2026-10-20 老板：「只有入口时候才能输入清单，后面就不能编辑了，不太好」）。
   * 预填当前清单，改完保存 —— **已扫的记录不清**：
   *   · 已扫件数（含绿件）照旧 —— 扫都扫过了；
   *   · 红色数 = 新清单 ∩ 已扫 —— 把某个码从清单里删掉，它就不再算"待退"。
   */
  function renderEdit() {
    var body = $("retBody");
    if (!body) {
      return;
    }
    var cur = [];
    state.list.forEach(function (c) {
      cur.push(c);
    });
    body.innerHTML =
      '<div class="rt-paste">' +
      '<textarea id="retPaste" placeholder="一行一个条码">' +
      esc(cur.join("\n")) +
      "</textarea>" +
      '<p class="rt-hint muted small">直接在上面增删改，一行一个；保存后「待退」数按新清单重算（已扫的记录不清）。</p>' +
      '<div class="rt-act">' +
      '<button id="retEditSave" class="primary" type="button">保存清单</button>' +
      '<button id="retEditCancel" class="mini" type="button">取消</button>' +
      "</div></div>";
    var save = $("retEditSave");
    if (save) {
      save.onclick = function () {
        var list = parseCodes($("retPaste") && $("retPaste").value);
        if (!list.length) {
          API.toast("不能删成空清单（要清空用「清空重来」）", true);
          return;
        }
        state.list = new Set(list);
        // 红色数重算：新清单里有哪些已经被扫到过
        state.red = 0;
        list.forEach(function (c) {
          if (state.scanned[c]) {
            state.red++;
          }
        });
        render();
        API.toast("清单已更新：" + list.length + " 个条码");
      };
    }
    var cancel = $("retEditCancel");
    if (cancel) {
      cancel.onclick = render;
    }
  }

  function bindScan() {
    var start = $("retStart");
    if (start) {
      start.onclick = function () {
        ensureAudio(); // 每次点都试着恢复（iOS 挂后台回来可能被压掉）
        if (!SCAN) {
          API.toast("扫码组件没加载上", true);
          return;
        }
        SCAN.open({
          title: "退货核对 · 连续扫",
          continuous: true,
          onCode: onCode,
        });
      };
    }
    var clear = $("retClear");
    if (clear) {
      clear.onclick = function () {
        state.list = null;
        state.scanned = {};
        state.red = 0;
        render();
      };
    }
    var lb = $("retListBtn");
    if (lb) {
      lb.onclick = function () {
        var card = $("retListCard");
        if (!card) {
          return;
        }
        if (!card.hidden) {
          card.hidden = true;
          return;
        }
        var rows = [];
        state.list.forEach(function (c) {
          rows.push(
            '<div style="padding:2px 0;' +
              (state.scanned[c] ? "color:var(--muted);text-decoration:line-through" : "") +
              '">' +
              esc(c) +
              (state.scanned[c] ? " ✓" : "") +
              "</div>",
          );
        });
        card.innerHTML = "<div>" + rows.join("") + "</div>";
        card.hidden = false;
      };
    }
    // 编辑清单：预填当前清单的文本框，改完保存重算「待退」数
    var eb = $("retEditBtn");
    if (eb) {
      eb.onclick = renderEdit;
    }
    // 红色尬住层的「知道了」：收层 → 放行扫码（骨架是静态的，绑一次就够 ——
    // 但 render() 不重建它，这里用 once 语义自己保证）
    var ok = $("retRedOk");
    if (ok && !ok.dataset.bound) {
      ok.dataset.bound = "1";
      ok.onclick = function () {
        var sheet = $("retRedSheet");
        if (sheet) {
          sheet.hidden = true;
        }
        if (SCAN) {
          SCAN.resume();
        }
      };
    }
  }

  // ---------- 扫到一个 ----------
  function onCode(code) {
    var c = String(code || "").trim();
    if (!c || !state.list) {
      return;
    }
    var hit = state.list.has(c);
    var dup = !!state.scanned[c];
    // 重复扫：不重复计数，色和声照旧（老板：重复没关系）
    if (!dup) {
      state.scanned[c] = true;
      if (hit) {
        state.red++;
      }
    }
    if (hit) {
      // 红色尬住：停识别 → 全屏红 + 高音 + 震 → 按「知道了」才回去
      beep(true);
      buzz([80, 60, 80]);
      var sheet = $("retRedSheet");
      var codeEl = $("retRedCode");
      if (codeEl) {
        codeEl.textContent = c;
      }
      if (sheet) {
        sheet.hidden = false;
      }
      if (SCAN) {
        SCAN.pause();
      }
    } else {
      // 绿色放行（二轮改全屏，老板："全屏绿一下…可以停个几秒钟"）：
      // 全屏绿罩 + 低音 + 震，**自动消失**（1 秒，老板嫌 1.6 秒长）回取景，不用点；
      // 罩着的那一会儿先 pause，时间到 resume —— 不然绿罩底下还在连发识别。
      beep(false);
      buzz(60);
      var gEl = $("retGreenCode");
      if (gEl) {
        gEl.textContent = c;
      }
      var gSheet = $("retGreenSheet");
      if (gSheet) {
        gSheet.hidden = false;
      }
      if (SCAN) {
        SCAN.pause();
      }
      clearTimeout(greenTimer);
      greenTimer = setTimeout(function () {
        var s = $("retGreenSheet");
        if (s) {
          s.hidden = true;
        }
        if (SCAN) {
          SCAN.resume();
        }
      }, 1000);
    }
    paintStats(c, hit, dup);
  }

  var greenTimer = 0;

  /** 统计 + 色带就地更新：不整块重画（重画会把「看清单」的展开状态冲掉） */
  function paintStats(code, hit, dup) {
    var n = 0;
    for (var k in state.scanned) {
      if (Object.prototype.hasOwnProperty.call(state.scanned, k)) {
        n++;
      }
    }
    var elN = $("retN");
    var elRed = $("retRed");
    if (elN) {
      elN.textContent = n;
    }
    if (elRed) {
      elRed.textContent = state.red;
    }
    var band = $("retBand");
    if (band) {
      band.className = "rt-band " + (hit ? "r" : "g");
      band.textContent = (hit ? "🔴 待退 · " : "🟢 放行 · ") + code + (dup ? "（重复，没再记）" : "");
    }
  }

  // 本屏也归底部「工具」那格亮（从工具箱点进来的）
  API.registerScreen("screen-retcheck", "tabTools");

  render();
})();
