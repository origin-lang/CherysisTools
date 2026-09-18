// shopTool 前端模块（加载顺序第 1 个：共享状态/工具函数）：共享状态、常量与通用工具
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
window.toolClients = window.toolClients || {};
    var vs = window.__vscode;

    var state = {
      products: [],
      rules: [],
      settings: {
        image_dir: "",
        name_template: "",
        stock_alert: 0,
        row_height: "8",
        font_size: "13",
        col_visible_list: "",
        col_visible_gallery: "",
        col_show_ops: "1",
        import_fields: "",
        import_mode: "",
        export_fields: "",
      },
      settles: [],
      sales: [],
      salesDate: "",
      trend: { by: "month", rows: [], productId: null },
      lbCode: null,
      coverCache: {},
      coverPending: {},
      coverRenderQueued: false,
      lbFullCache: {},
      liveStars: null,
      livePlan: [],
      liveOutDir: "",
      selectedProducts: new Set(),
      canUndo: false,
      canRedo: false,
    };

    // 撤销/重做可用性回推：控制各页面的撤销/重做按钮灰显
    function applyUndoState(avail, redoAvail) {
      state.canUndo = !!avail;
      state.canRedo = !!redoAvail;
      ["undoBtn", "undoSalesBtn"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) {
          b.disabled = !state.canUndo;
        }
      });
      ["redoBtn", "redoSalesBtn"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) {
          b.disabled = !state.canRedo;
        }
      });
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
    var pageSize = 200;
    var lastFilterSig = "";
    var selSales = new Set();
    var sortKey = "code";
    var sortDir = 1;
    var filtersSig = "";
    var filters = {};
    var COVER_CONCURRENCY = 6;
    var coverQueue = [];
    var coverInFlight = 0;

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
        const n = Number(raw);
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
      const s = String(raw ?? "")
        .trim()
        .replace(/[【】\[\]（）()#\s_\-\u3000]/g, "");
      let m = s.match(/^[Ll](\d{1,4})$/);
      if (!m) {
        m = s.match(/^(\d{1,4})$/);
      }
      if (!m) {
        return null;
      }
      const n = Number(m[1]);
      if (!Number.isInteger(n) || n < 1 || n > 9999) {
        return null;
      }
      return "L" + String(n).padStart(3, "0");
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
        post({ type: "getCover", code });
      }
    }

    function ensureCovers(list) {
      for (const p of list) {
        if (state.coverCache[p.code] !== undefined) {
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
          return `<div class="ctx-item${it.danger ? " ctx-danger" : ""}" data-ic="${i}">${esc(it.label)}</div>`;
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
          close();
          if (it.run) {
            it.run();
          }
        };
      });
    }
