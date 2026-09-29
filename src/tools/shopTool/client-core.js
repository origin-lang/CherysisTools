// shopTool 前端模块（加载顺序第 1 个：共享状态/工具函数）：共享状态、常量与通用工具
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
window.toolClients = window.toolClients || {};
    var vs = window.__vscode;

    var state = {
      products: [],
      rules: [],
      // 个人偏好（行高/字号/字段显隐/导入导出勾选/九宫格输出目录/星标排版与标注）
      // 由后端从本机 globalState 下发，不来自共享库 shop.db
      settings: {
        // 全组共享的业务规则
        name_template: "",
        stock_alert: 0,
        sales_deduct_stock: "1",
        // 本机偏好
        row_height: "8",
        font_size: "13",
        col_visible_list: "",
        col_visible_gallery: "",
        col_image_list: "",
        col_image_gallery: "",
        col_show_ops: "1",
        live_grid_label: "",
        star_label_options: "",
        import_fields: "",
        import_mode: "",
        export_fields: "",
      },
      // 本机只读开关（存 globalState，别的机器看不见）
      readOnly: false,
      settles: [],
      sales: [],
      salesDate: "",
      trend: { by: "month", rows: [], productId: null },
      lbCode: null,
      // 灯箱当前清单的文件名，与后端 imagesLoaded.names 同序。
      // 每张图的身份用它，不用序号：删掉前面一张会让后面几张的序号全部前移。
      lbNames: [],
      coverCache: {},
      coverPending: {},
      coverRenderQueued: false,
      // 大图 base64 缓存，键 = `${code}:${文件名}`。键不中的代价只是重新取一次图，
      // 键错中的代价是显示成别的图，所以宁可多取。
      lbFullCache: {},
      liveStars: null,
      livePlan: [],
      liveOutDir: "",
      // 九宫格生成中的加载态：{phase, groups, done, total, text}，null = 空闲
      liveGridBusy: null,
      selectedProducts: new Set(),
      canUndo: false,
      canRedo: false,
    };

    // 撤销/重做可用性回推：控制各页面的撤销/重做按钮灰显
    function applyUndoState(avail, redoAvail) {
      state.canUndo = !!avail;
      state.canRedo = !!redoAvail;
      // 只读模式下恒为灰：撤销/重做是整库回退，必然被后端那道闸拦下，亮着也是白亮
      var off = state.readOnly;
      ["undoBtn", "undoSalesBtn", "drawerUndoBtn"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) {
          b.disabled = off || !state.canUndo;
        }
      });
      ["redoBtn", "redoSalesBtn", "drawerRedoBtn"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) {
          b.disabled = off || !state.canRedo;
        }
      });
    }

    // 只读模式：把界面摆成「看得了、但别改」的样子。
    // 注意这只是给人看的提示——真正拦住写的是后端 WRITE_ACTIONS 那道闸，
    // 所以就算某个按钮忘了灰显，点下去也只会收到一句「🔒 只读模式」。
    function applyReadOnly(on) {
      state.readOnly = !!on;
      var btn = document.getElementById("readOnlyBtn");
      if (btn) {
        btn.textContent = on ? "🔒 只读" : "🔓 可写";
        btn.classList.toggle("btn-danger", !!on);
        btn.title = on
          ? "当前只读：不会写共享库。点一下解除，可以改数据（同一时间只让一台机器写）"
          : "当前可写：会改共享库。点一下锁上，只看不动最稳";
      }
      var hint = document.getElementById("readOnlyHint");
      if (hint) {
        hint.style.display = on ? "" : "none";
      }
      // 撤销/重做交给 applyUndoState 统一管（它也看 state.readOnly），这里只管新建
      var nb = document.getElementById("newProductBtn");
      if (nb) {
        nb.disabled = state.readOnly;
      }
      applyUndoState(state.canUndo, state.canRedo);
    }

    var PRESET_CATEGORIES = ["手链", "项链", "耳环", "戒指", "手镯"];
    // 商品字段规格主表：顺序/标签/文本长度/空格/必填/数值类型，一处定义。
    // 与后端 src/tools/shopTool/productFields.ts 保持一致。
    var FIELD_SPECS = [
      { key: "code", label: "编号", required: true },
      { key: "name", label: "名称", max: 100, noSpace: true },
      { key: "category", label: "品类", max: 50, noSpace: true },
      { key: "series", label: "系列", max: 50, noSpace: true },
      { key: "grade", label: "等级", kind: "grade" },
      { key: "cost_price", label: "进价", kind: "money" },
      { key: "sale_price", label: "售价", kind: "money" },
      { key: "stockTotal", label: "库存", kind: "int" },
      { key: "soldTotal", label: "累计售出", kind: "int" },
      { key: "netTotal", label: "累计净售", kind: "int" },
      { key: "status", label: "状态" },
      { key: "purchase_link", label: "采购链接", max: 500, noSpace: true },
      { key: "remark", label: "备注", max: 200 },
    ];
    // 列显示字段（隐藏列不参与渲染）
    var PRODUCT_FIELDS = FIELD_SPECS.filter((f) => !f.hidden).map((f) => ({
      key: f.key,
      label: f.label,
    }));
    var EDITABLE_FIELDS = new Set([
      "code",
      "name",
      "category",
      "series",
      "grade",
      "cost_price",
      "sale_price",
      "purchase_link",
      "stockTotal",
      "remark",
    ]);
    var CUTTABLE_FIELDS = new Set(EDITABLE_FIELDS);
    CUTTABLE_FIELDS.delete("code");
    CUTTABLE_FIELDS.delete("name");
    var visList = new Set(PRODUCT_FIELDS.map((f) => f.key));
    var visGallery = new Set(PRODUCT_FIELDS.map((f) => f.key));
    // 图片列是否显示（与「字段显示」分开存储，独立开关，默认显示）
    var showImageList = true;
    var showImageGallery = true;
    // 列表「操作」列（星标/复制/入库/删除快捷按钮）是否显示，默认显示、可关
    var showOpsList = true;
    var viewMode = "list";
    var listPage = 1;
    // 每页 50：每次渲染列表都会 ensureCovers(当前页)，页越大首屏要发的封面 base64 越多
    // （每张一条 postMessage），在共享盘上还要为每个编号 stat 一次图片夹。
    // 200 的时候光打开面板第一秒就要发 200 条消息、浏览器解码 200 张图。
    var pageSize = 50;
    var lastFilterSig = "";
    // 表头（含筛选行）的重建判据。表头和表体分开重画，见 client-product.js 的 headSig
    var lastHeadSig = "";
    var selSales = new Set();
    var sortKey = "code";
    var sortDir = 1;
    var filtersSig = "";
    var filters = {};
    var COVER_CONCURRENCY = 6;
    var coverQueue = [];
    var coverInFlight = 0;
    // 封面请求的代次。整批作废缓存时 +1，用来认出台账里「作废之前就发出去的请求」，
    // 它们的响应是旧图，回来后不能写进缓存，否则那一行的旧封面会一直留着
    var coverGen = 0;

    var $ = (id) => document.getElementById(id);
    var post = (msg) => vs.postMessage({ toolName: "shopTool", ...msg });
    var esc = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    var money = (n) =>
      (Math.round(Number(n || 0) * 100) / 100).toLocaleString("zh-CN");
    var qty = (n) => String(Math.floor(Number(n || 0)));
    var parseMoneyInput = (raw) =>
      Number(String(raw ?? "").trim().replace(/^[¥￥]\s*/, ""));

    var sanitizeProductField = (field, raw) => {
      const spec = FIELD_SPECS.find((f) => f.key === field);
      if (!spec) {
        return { ok: true, value: raw };
      }
      if (spec.kind === "grade") {
        // 缺省 0（自定义），与后端 normGrade 同步；别再往 1 上靠
        const n = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
        if (n === 0) {
          return { ok: true, value: 0 };
        }
        if (!Number.isInteger(n) || n < 1 || n > 99) {
          return { ok: false, msg: "等级需为 0（自定义）或 1-99 的整数" };
        }
        return { ok: true, value: n };
      }
      if (spec.kind === "money") {
        if (raw === "" || raw === null || raw === undefined) {
          return { ok: true, value: 0 };
        }
        const n = parseMoneyInput(raw);
        if (!Number.isFinite(n) || n < 0) {
          return { ok: false, msg: `${spec.label}需为 ≥0 的数字` };
        }
        return { ok: true, value: Math.round(n * 100) / 100 };
      }
      if (spec.kind === "int") {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          return { ok: false, msg: `${spec.label}需为非负整数` };
        }
        return { ok: true, value: n };
      }
      if (spec.max !== undefined || spec.noSpace || spec.required) {
        let s = String(raw ?? "").trim();
        if (spec.required && !s) {
          return { ok: false, msg: `${spec.label}不能为空` };
        }
        if (spec.noSpace && /\s/.test(s)) {
          return { ok: false, msg: `${spec.label}不能包含空格` };
        }
        const truncated = s.length > spec.max;
        if (truncated) {
          s = s.slice(0, spec.max);
        }
        return { ok: true, value: s, truncated };
      }
      return { ok: true, value: raw };
    };

    function nowStr() {
      const d = new Date();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${d.getFullYear()}-${mm}-${dd}`;
    }

    function monthNow() {
      return nowStr().slice(0, 7);
    }

    function canonicalCode(raw) {
      const s = String(raw ?? "").trim();
      let m = s.match(/^([A-Za-z])(\d{1,4})$/);
      let prefix = "A";
      let digits;
      if (m) {
        prefix = m[1].toUpperCase();
        digits = m[2];
      } else {
        m = s.match(/^(\d{1,4})$/);
        if (!m) {
          return null;
        }
        digits = m[1];
      }
      const n = Number(digits);
      if (!Number.isInteger(n) || n < 1 || n > 9999) {
        return null;
      }
      return prefix + String(n).padStart(3, "0");
    }

    /** 某个前缀下最小的未用编号（填空号；1~9999），已用完返回 null。仅前端扫描 state.products。 */
    function nextAvailableCode(rawPrefix) {
      const prefix = String(rawPrefix || "A").toUpperCase();
      const used = new Set();
      for (const p of state.products || []) {
        const mm = String(p.code || "").match(/^([A-Za-z])(\d{1,4})$/);
        if (mm && mm[1].toUpperCase() === prefix) {
          used.add(Number(mm[2]));
        }
      }
      for (let n = 1; n <= 9999; n++) {
        if (!used.has(n)) {
          return prefix + String(n).padStart(3, "0");
        }
      }
      return null;
    }

    function gradeLabel(grade) {
      const r = state.rules.find((x) => x.grade === Number(grade));
      return r ? r.label || "等级" + grade : "等级" + grade;
    }

    function displayGrade(p) {
      return p && p.price_manual === 1 ? "自定义" : gradeLabel(p && p.grade);
    }

    function applyExpr(cost, expr) {
      const e = String(expr ?? "").replace(/cost/gi, `(${cost})`);
      if (!/^[0-9+\-*/().\s]+$/.test(e)) {
        return null;
      }
      try {
        const v = new Function(`return (${e});`)();
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      } catch {
        return null;
      }
    }

    function calcPrice(cost, rule) {
      let v = rule ? applyExpr(cost, rule.expr) : null;
      if (v === null) {
        v = cost;
      }
      v = Math.round(v * 100) / 100;
      const mode = rule ? rule.tail_mode || "raw" : "raw";
      const tail = String(rule ? rule.tail_value || "" : "").trim();
      switch (mode) {
        case "round":
          return Math.round(v);
        case "p99":
          return Math.floor(v) + 0.99;
        case "p88":
          return Math.floor(v) + 0.88;
        case "custom": {
          if (!tail || !/^\d{1,2}$/.test(tail)) {
            return v;
          }
          const dec = Number(tail) / Math.pow(10, tail.length);
          return Math.round((Math.floor(v) + dec) * 100) / 100;
        }
        default:
          return v;
      }
    }

    function fullName(p) {
      const t = state.settings.name_template || "{name}{series}{grade}{code}";
      return previewNameTemplate(t, p);
    }

    function previewNameTemplate(tpl, p) {
      return String(tpl || "{name}{series}{grade}{code}")
        .replace(/\{name\}/g, p.name || "")
        .replace(/\{category\}/g, p.category || "")
        .replace(/\{series\}/g, p.series || "")
        .replace(/\{grade\}/g, displayGrade(p))
        .replace(/\{code\}/g, p.code);
    }

    function copyText(text, toastMsg) {
      const done = () => toast(toastMsg || "已复制到剪贴板 ✅");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(done)
          .catch(() => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    }

    function fallbackCopy(text, done) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch {
        toast("复制失败");
      }
      document.body.removeChild(ta);
    }

    function toast(text) {
      if (window.showGlobalToast) {
        window.showGlobalToast(text);
        return;
      }
      let el = document.querySelector(".toast");
      if (!el) {
        el = document.createElement("div");
        el.className = "toast";
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.style.display = "none"), 1800);
    }

    let _modalEscHandler = null;

    function showModal(html) {
      closeModal();
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.id = "dynModalMask";
      mask.innerHTML = `<div class="modal">${html}</div>`;
      _modalEscHandler = (ev) => {
        if (ev.key === "Escape") {
          closeModal();
        }
      };
      document.addEventListener("keydown", _modalEscHandler);
      document.body.appendChild(mask);
      return mask;
    }

    function closeModal() {
      if (_modalEscHandler) {
        document.removeEventListener("keydown", _modalEscHandler);
        _modalEscHandler = null;
      }
      const m = document.getElementById("dynModalMask");
      if (m) {
        m.remove();
      }
    }

    function confirmBox(message) {
      return new Promise((resolve) => {
        const mask = showModal(`
          <h3>确认</h3>
          <p class="muted" style="white-space:pre-wrap">${esc(message)}</p>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
            <button data-cb="no">取消</button>
            <button data-cb="yes" class="btn-teal">确定</button>
          </div>`);
        mask.querySelector('[data-cb="yes"]').onclick = () => {
          closeModal();
          resolve(true);
        };
        mask.querySelector('[data-cb="no"]').onclick = () => {
          closeModal();
          resolve(false);
        };
      });
    }

    function debounce(fn, ms) {
      let t = null;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
      };
    }

    function pumpCovers() {
      while (coverInFlight < COVER_CONCURRENCY && coverQueue.length > 0) {
        const code = coverQueue.shift();
        coverInFlight++;
        post({ type: "getCover", code, gen: coverGen });
      }
    }

    /**
     * 整批校核封面缓存（手动 🔄 或轮询发现别人改了库时）。现在是增量式：
     * base64 留在内存里不整批丢，只标 coverRecheck，让 ensureCovers 把当前页的封面
     * 重新向后台发一次请求；后台按文件夹 mtime 判断——图没变原图退回，前端比对一致就不
     * 重画；真变了的才替换。效果：刷新后没动的商品不再整批重嵌/重画，别人换的图照样刷得出来。
     * gen +1 仍是必须的：刷新前已发出去的在途请求，回来是旧图，靠 gen 认出并丢弃。
     */
    function invalidateAllCovers() {
      coverGen++;
      state.coverRecheck = true;
      state.coverRecheckDone = {};
      state.coverPending = {};
      coverQueue.length = 0;
    }

    function ensureCovers(list) {
      const recheck = !!state.coverRecheck;
      for (const p of list) {
        if (!recheck && state.coverCache[p.code] !== undefined) {
          continue;
        }
        // 本轮校核已经重取过的（coverLoaded 里登记过），不重复发：
        // 否则 renderLivePreviews→ensureCovers→coverLoaded 会形成无穷请求循环
        if (recheck && state.coverRecheckDone[p.code]) {
          continue;
        }
        if (state.coverPending[p.code]) {
          continue;
        }
        state.coverPending[p.code] = true;
        coverQueue.push(p.code);
      }
      pumpCovers();
    }

    function requestCoverRender() {
      if (state.coverRenderQueued) {
        return;
      }
      state.coverRenderQueued = true;
      setTimeout(() => {
        state.coverRenderQueued = false;
        renderProducts();
      }, 16);
    }

    function loadImageFromDataUrl(dataUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
      });
    }

    async function copyImageFromDataUrl(dataUrl) {
      try {
        const img = await loadImageFromDataUrl(dataUrl);
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width || 1;
        canvas.height = img.naturalHeight || img.height || 1;
        canvas.getContext("2d").drawImage(img, 0, 0);
        const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
        if (!blob) {
          return false;
        }
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": blob }),
          ]);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }

    function showImageCtxMenu(x, y, items) {
      const old = document.getElementById("imgCtxMenu");
      if (old) {
        old.remove();
      }
      const menu = document.createElement("div");
      menu.id = "imgCtxMenu";
      menu.style.cssText =
        "position:fixed;z-index:80;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px 0;min-width:160px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      menu.innerHTML = items
        .map((it, i) => {
          if (it.sep) {
            return `<div style="border-top:1px solid var(--vscode-panel-border);margin:3px 0"></div>`;
          }
          // disabled 走 .ctx-item.ctx-disabled（那套样式 fragment.html 里已经有了），
          // title 用来讲清「为什么灰着」，否则用户只看到一项灰的、不知道在等什么。
          // id 可选：菜单项构造变成有条件之后，data-ic 那个下标就不再是稳定身份了
          // （灯箱要按 id 找回「复制图片」那一项，不能靠它排在第几个）。
          return (
            `<div class="ctx-item${it.danger ? " ctx-danger" : ""}` +
            `${it.disabled ? " ctx-disabled" : ""}"` +
            ` data-ic="${i}"${it.id ? ` data-ic-id="${esc(it.id)}"` : ""}` +
            `${it.title ? ` title="${esc(it.title)}"` : ""}>` +
            `${esc(it.label)}</div>`
          );
        })
        .join("");
      menu.style.left = Math.min(x, window.innerWidth - 180) + "px";
      menu.style.top =
        Math.min(y, window.innerHeight - items.length * 30 - 20) + "px";
      document.body.appendChild(menu);
      const close = () => {
        menu.remove();
        window.removeEventListener("mousedown", onDown);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("resize", onResize);
      };
      const onDown = (ev) => {
        if (!menu.contains(ev.target)) {
          close();
        }
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") {
          close();
        }
      };
      const onBlur = () => close();
      const onResize = () => close();
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("blur", onBlur);
      window.addEventListener("resize", onResize);
      menu.querySelectorAll("[data-ic]").forEach((el) => {
        el.onclick = () => {
          const it = items[Number(el.dataset.ic)];
          // 在**点击那一刻**读 it.disabled，而不是建菜单时算好的闭包值：
          // 菜单开着的时候图可能正好载入完、调用方把 it.disabled 改成 false 并摘掉
          // ctx-disabled 类，那样同一张菜单就能自己从灰变亮，不用重开一次。
          // ctx-disabled 带 pointer-events:none，理论上点不到，这里再挡一道兜底。
          if (it.disabled) {
            return;
          }
          close();
          if (it.run) {
            it.run();
          }
        };
      });
      // 菜单元素交回给调用方：灯箱那边要在图载入完时把复制项点亮，只能拿到 DOM
      return menu;
    }
