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
        col_visible_list: "",
        col_visible_gallery: "",
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
    };

    var PRESET_CATEGORIES = ["手链", "项链", "耳环", "戒指", "手镯"];
    var PRODUCT_FIELDS = [
      { key: "code", label: "编号" },
      { key: "name", label: "名称" },
      { key: "category", label: "品类" },
      { key: "series", label: "系列" },
      { key: "grade", label: "等级" },
      { key: "cost_price", label: "进价" },
      { key: "sale_price", label: "售价" },
      { key: "stockTotal", label: "库存" },
      { key: "soldTotal", label: "累计售出" },
      { key: "netTotal", label: "累计净售" },
      { key: "status", label: "状态" },
      { key: "purchase_link", label: "采购链接" },
    ];
    var EDITABLE_FIELDS = new Set([
      "code",
      "name",
      "category",
      "series",
      "grade",
      "cost_price",
      "sale_price",
      "purchase_link",
    ]);
    var visList = new Set(PRODUCT_FIELDS.map((f) => f.key));
    var visGallery = new Set(PRODUCT_FIELDS.map((f) => f.key));
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
      return t
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

    function showModal(html) {
      closeModal();
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.id = "dynModalMask";
      mask.innerHTML = `<div class="modal">${html}</div>`;
      mask.addEventListener("click", (e) => {
        if (e.target === mask) {
          closeModal();
        }
      });
      document.body.appendChild(mask);
      return mask;
    }

    function closeModal() {
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
