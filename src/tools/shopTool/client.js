(function () {
  window.toolClients = window.toolClients || {};
  window.toolClients.shopTool = (() => {
    const vs = window.__vscode;

    const state = {
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

    const PRESET_CATEGORIES = ["手链", "项链", "耳环", "戒指", "手镯"];
    const PRODUCT_FIELDS = [
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
    const EDITABLE_FIELDS = new Set([
      "code",
      "name",
      "category",
      "series",
      "grade",
      "cost_price",
      "sale_price",
      "purchase_link",
    ]);
    const FILTER_FIELDS = [
      "code",
      "name",
      "category",
      "series",
      "grade",
      "cost_price",
      "sale_price",
      "stockTotal",
    ];

    let visList = new Set(PRODUCT_FIELDS.map((f) => f.key));
    let visGallery = new Set(PRODUCT_FIELDS.map((f) => f.key));
    let viewMode = "list";
    let listPage = 1;
    let pageSize = 200;
    let lastFilterSig = "";
    let selSales = new Set();
    let sortKey = "code";
    let sortDir = 1;
    let filtersSig = "";
    const filters = {};
    const COVER_CONCURRENCY = 6;
    let coverQueue = [];
    let coverInFlight = 0;

    const $ = (id) => document.getElementById(id);
    const post = (msg) => vs.postMessage({ toolName: "shopTool", ...msg });
    const esc = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const money = (n) =>
      (Math.round(Number(n || 0) * 100) / 100).toLocaleString("zh-CN");
    const qty = (n) => String(Math.floor(Number(n || 0)));

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
    let toastTimer = null;
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

    function cellValue(p, key) {
      switch (key) {
        case "code":
          return p.code;
        case "grade":
          return displayGrade(p);
        case "status":
          return p.status === 1 ? "已下架" : "在售";
        case "netTotal":
          return String(p.soldTotal - p.refundTotal);
        case "cost_price":
          return String(p.cost_price);
        case "sale_price":
          return String(p.sale_price);
        case "stockTotal":
          return String(p.stockTotal || 0);
        case "soldTotal":
          return String(p.soldTotal || 0);
        case "purchase_link":
          return p.purchase_link || "";
        default:
          return String(p[key] ?? "");
      }
    }

    function filteredProducts() {
      const status = $("filterStatus")?.value || "all";
      const series = $("filterSeries")?.value || "";
      const category = $("filterCategory")?.value || "";
      return state.products
        .filter((p) =>
          status === "all"
            ? true
            : status === "on"
              ? p.status === 0
              : p.status === 1,
        )
        .filter((p) => (series ? p.series === series : true))
        .filter((p) => (category ? p.category === category : true))
        .filter((p) => {
          for (const k of FILTER_FIELDS) {
            const f = (filters[k] || "").trim();
            if (f && !cellValue(p, k).toLowerCase().includes(f.toLowerCase())) {
              return false;
            }
          }
          return true;
        })
        .sort((a, b) => {
          let r = 0;
          if (sortKey === "code") {
            r = Number(a.code.slice(1)) - Number(b.code.slice(1));
          } else {
            const va = a[sortKey];
            const vb = b[sortKey];
            if (typeof va === "number" && typeof vb === "number") {
              r = va - vb;
            } else {
              r = cellValue(a, sortKey).localeCompare(
                cellValue(b, sortKey),
                "zh-Hans-CN",
              );
            }
          }
          return r * sortDir;
        });
    }

    function lowStock(p) {
      return (
        state.settings.stock_alert > 0 &&
        p.status === 0 &&
        p.stockTotal <= state.settings.stock_alert
      );
    }

    function fillCatList() {
      const dl = $("shopCatList");
      if (!dl) {
        return;
      }
      const set = new Set(PRESET_CATEGORIES);
      for (const p of state.products) {
        if (p.category) {
          set.add(p.category);
        }
      }
      dl.innerHTML = [...set]
        .map((c) => `<option value="${esc(c)}"></option>`)
        .join("");
    }

    function openLightbox(product) {
      if (state.lbCode !== product.code) {
        state.lbFullCache = {};
      }
      state.lbCode = product.code;
      const mask = showModal(`
        <div class="lightbox" id="lbBox">
          <div class="lb-head">
            <span><b>${esc(product.code)}</b> ${esc(product.name)} <span class="muted" style="color:#aaa">（${esc(displayGrade(product))}・售价 ¥${money(product.sale_price)}）</span></span>
            <span style="display:flex;gap:8px;align-items:center">
              <button id="lbCopy">📋 复制完整名称</button>
              <button id="lbUpload">🖼 上传图片</button>
              <button id="lbClearImg" class="btn-danger">清空图片夹</button>
              <button class="lb-cls" id="lbClose">✕</button>
            </span>
          </div>
          <img class="big" id="lbBig" style="display:none" />
          <div class="thumbs" id="lbThumbs"><span class="muted" style="color:#aaa">图片加载中…</span></div>
        </div>`);
      mask.querySelector("#lbClose").onclick = closeModal;
      mask.querySelector("#lbCopy").onclick = () => copyText(fullName(product));
      mask.querySelector("#lbUpload").onclick = () =>
        post({ type: "uploadImages", code: product.code });
      mask.querySelector("#lbClearImg").onclick = async () => {
        if (
          await confirmBox(
            `确认清空 ${product.code} 的图片文件夹？（文件会真的删除）`,
          )
        ) {
          post({ type: "clearImages", code: product.code });
        }
      };
      post({ type: "getImages", code: product.code });
    }

    function filterSig(list) {
      return JSON.stringify({
        len: list.length,
        status: $("filterStatus")?.value || "all",
        series: $("filterSeries")?.value || "",
        category: $("filterCategory")?.value || "",
        filters,
        sortKey,
        sortDir,
      });
    }

    function paginate(list) {
      const total = list.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (listPage > pages) {
        listPage = pages;
      }
      if (listPage < 1) {
        listPage = 1;
      }
      const start = (listPage - 1) * pageSize;
      return { total, pages, page: list.slice(start, start + pageSize) };
    }

    function renderPager(pd) {
      const el = $("productPager");
      if (!el) {
        return;
      }
      if (pd.total === 0) {
        el.innerHTML = `<span class="muted">共 0 条</span>`;
        return;
      }
      el.innerHTML = `
        <span class="muted">共 ${pd.total} 条　每页</span>
        <select id="pageSizeSel">
          ${[50, 100, 200, 500].map((n) => `<option value="${n}"${n === pageSize ? " selected" : ""}>${n}</option>`).join("")}
        </select>
        <button class="mini-btn" data-pg="prev"${listPage <= 1 ? " disabled" : ""}>‹ 上一页</button>
        <span class="muted">第 <b>${listPage}</b> / ${pd.pages} 页</span>
        <button class="mini-btn" data-pg="next"${listPage >= pd.pages ? " disabled" : ""}>下一页 ›</button>
        <input id="pageJump" type="number" min="1" max="${pd.pages}" placeholder="跳页" style="width:56px" />
      `;
    }

    function renderProducts() {
      const list = filteredProducts();
      const sig = filterSig(list);
      if (sig !== lastFilterSig) {
        lastFilterSig = sig;
        listPage = 1;
      }
      const pd = paginate(list);
      renderPager(pd);
      if (viewMode === "gallery") {
        $("productListView").style.display = "none";
        $("productGalleryView").style.display = "block";
        renderGallery(pd.page);
      } else {
        $("productListView").style.display = "block";
        $("productGalleryView").style.display = "none";
        renderList(pd.page);
      }
      ensureCovers(pd.page);
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

    function renderList(list) {
      const vis = PRODUCT_FIELDS.filter((f) => visList.has(f.key));
      const plIdx = vis.findIndex((f) => f.key === "purchase_link");
      const imgAt = plIdx >= 0 ? plIdx : vis.length;
      const headCols = [];
      const filterCols = [];
      filterCols.push(`<td></td>`);
      for (let i = 0; i < vis.length; i++) {
        if (i === imgAt) {
          headCols.push(`<th>图片</th>`);
          filterCols.push(`<td></td>`);
        }
        const f = vis[i];
        headCols.push(
          `<th data-sort="${f.key}">${f.label}${sortKey === f.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}</th>`,
        );
        filterCols.push(
          FILTER_FIELDS.includes(f.key)
            ? `<td><input data-fkey="${f.key}" value="${esc(filters[f.key] || "")}" placeholder="筛选${f.label}" style="width:100%;min-width:52px;padding:2px 4px;font-size:11px" /></td>`
            : `<td></td>`,
        );
      }
      if (imgAt >= vis.length) {
        headCols.push(`<th>图片</th>`);
        filterCols.push(`<td></td>`);
      }
      headCols.push(`<th>操作</th>`);
      filterCols.push(`<td></td>`);
      const body = list
        .map((p) => {
          const net = p.soldTotal - p.refundTotal;
          const off = p.status === 1;
          const low = lowStock(p);
          const coverData = state.coverCache[p.code] || "";
          const cover = coverData
            ? `<img class="thumb" data-p-act="img" data-id="${p.id}" src="${coverData}" />`
            : `<span class="thumb placeholder" data-p-act="img" data-id="${p.id}">无图</span>`;
          const starred = state.liveStars && state.liveStars.has(p.code);
          const tds = [];
          const isSelected = state.selectedProducts.has(p.id);
          tds.push(`<td><input type="checkbox" class="product-checkbox" data-id="${p.id}" ${isSelected ? "checked" : ""} title="选择 #${p.code}" /></td>`);
          for (let i = 0; i < vis.length; i++) {
            if (i === imgAt) {
              tds.push(`<td>${cover}</td>`);
            }
            const f = vis[i];
            let v = "";
            let cls = "";
            const editable = EDITABLE_FIELDS.has(f.key) ? 'data-edit="1"' : "";
            switch (f.key) {
              case "code":
                v = `<b>${esc(p.code)}</b>`;
                cls = "cell-code";
                break;
              case "name":
                v = esc(p.name);
                break;
              case "category":
                v = esc(p.category);
                break;
              case "series":
                v = esc(p.series);
                break;
              case "grade":
                v = esc(displayGrade(p));
                break;
              case "cost_price":
                v = money(p.cost_price);
                cls = "num";
                break;
              case "sale_price":
                v = money(p.sale_price);
                cls = "num";
                break;
              case "stockTotal":
                v = qty(p.stockTotal || 0);
                cls = "num cell-stock";
                break;
              case "soldTotal":
                v = qty(p.soldTotal || 0);
                cls = "num";
                break;
              case "netTotal":
                v = qty(net);
                cls = "num";
                break;
              case "status":
                v = `<span class="badge ${off ? "badge-off" : "badge-on"}">${off ? "已下架" : "在售"}</span>`;
                break;
              case "purchase_link":
                v = p.purchase_link
                  ? `<a href="${esc(p.purchase_link)}" target="_blank">打开</a>`
                  : "";
                break;
            }
            tds.push(
              `<td class="${cls}" data-f="${f.key}" data-pid="${p.id}" ${editable}>${v}</td>`,
            );
          }
          if (imgAt >= vis.length) {
            tds.push(`<td>${cover}</td>`);
          }
          tds.push(`<td>
              <button class="mini-btn" data-s-act="toggle" data-code="${esc(p.code)}" data-id="${p.id}" title="${starred ? "取消星标" : "加入直播排品备选"}">${starred ? "★" : "☆"}</button>
              <button class="mini-btn" data-p-act="copy" data-id="${p.id}" title="复制完整名称">📋</button>
              <button class="mini-btn" data-p-act="stockin" data-id="${p.id}" title="补货入库">📦</button>
              ${off ? `<button class="mini-btn" data-p-act="status" data-id="${p.id}" data-status="0" title="上架恢复出售">🔺</button>` : `<button class="mini-btn" data-p-act="status" data-id="${p.id}" data-status="1" title="下架（置灰不删除，可随时上架）">🔻</button>`}
              <button class="mini-btn" data-p-act="clearimg" data-id="${p.id}" title="清空图片文件夹">🌫</button>
              <button class="mini-btn btn-danger" data-p-act="del" data-id="${p.id}" title="删除(含记录)">🗑</button>
            </td>`);
          return `<tr class="${off ? "off" : ""} ${low ? "lowstock" : ""}">${tds.join("")}</tr>`;
        })
        .join("");
      const selectedCount = state.selectedProducts.size;
      const allSelected = list.length > 0 && list.every((p) => state.selectedProducts.has(p.id));
      $("productListView").innerHTML =
        list.length === 0 && !hasFilter()
          ? `<p class="muted">（无商品，点「＋ 新建商品」添加；也支持「导入商品」批量粘贴）</p>`
          : `${selectedCount > 0
               ? `<div class="batch-ops" id="batchOpsBar" style="margin-bottom:8px;padding:8px;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);border-radius:4px;display:flex;gap:8px;align-items:center">
                    <span>已选 <b data-sel-count>${selectedCount}</b> 个商品</span>
                    <button class="mini-btn" id="batchOn" title="上架选中的商品">🔺 上架</button>
                    <button class="mini-btn" id="batchOff" title="下架选中的商品">🔻 下架</button>
                    <button class="mini-btn btn-danger" id="batchDel" title="删除选中的商品（含记录，不可恢复）">🗑 删除</button>
                    <button class="mini-btn" id="batchClear" title="取消全部选择">✕ 取消</button>
                  </div>`
               : ""}
             <div class="table-wrap"><table class="data-table"><thead><tr>
               <th style="width:30px"><input type="checkbox" id="selectAllProducts" ${list.length === 0 ? "disabled" : ""} ${allSelected ? "checked" : ""} title="全选 / 取消全选" /></th>
               ${headCols.join("")}
             </tr><tr class="filter-row">${filterCols.join("")}</tr></thead><tbody>${body}</tbody></table></div>
             <div class="muted" style="margin-top:4px">双击单元格编辑（回车或点击别处即保存）；右键行/表格复制</div>`;
      bindFilterRow();
      bindBatchOps();
    }

    function hasFilter() {
      return Object.values(filters).some((v) => String(v).trim().length > 0);
    }

    function bindFilterRow() {
      document
        .querySelectorAll(".filter-row input[data-fkey]")
        .forEach((inp) => {
          inp.oninput = () => {
            filters[inp.dataset.fkey] = inp.value;
            const el = $("clearFilterBtn");
            if (el) {
              el.style.visibility = hasFilter() ? "visible" : "hidden";
            }
          };
          inp.onkeydown = (e) => {
            if (e.key === "Enter") {
              renderProducts();
            }
          };
        });
    }

    function updateSelectionUI() {
      const selAll = $("selectAllProducts");
      if (selAll) {
        const cbs = document.querySelectorAll(".product-checkbox");
        selAll.checked =
          cbs.length > 0 && Array.from(cbs).every((c) => c.checked);
      }
      const count = state.selectedProducts.size;
      const bar = $("batchOpsBar");
      if (count === 0) {
        if (bar) {
          bar.remove();
        }
        return;
      }
      if (!bar) {
        renderProducts();
        return;
      }
      const countEl = bar.querySelector("[data-sel-count]");
      if (countEl) {
        countEl.textContent = String(count);
      }
    }

    function bindBatchOps() {
      const selectAll = $("selectAllProducts");
      if (selectAll) {
        selectAll.onchange = () => {
          const checked = selectAll.checked;
          document.querySelectorAll(".product-checkbox").forEach((cb) => {
            const id = Number(cb.dataset.id);
            if (checked) {
              state.selectedProducts.add(id);
            } else {
              state.selectedProducts.delete(id);
            }
          });
          renderProducts();
        };
      }

      document.querySelectorAll(".product-checkbox").forEach((cb) => {
        cb.onchange = () => {
          const id = Number(cb.dataset.id);
          if (cb.checked) {
            state.selectedProducts.add(id);
          } else {
            state.selectedProducts.delete(id);
          }
          updateSelectionUI();
        };
      });

      const batchOn = $("batchOn");
      const batchOff = $("batchOff");
      const batchDel = $("batchDel");
      const batchClear = $("batchClear");

      if (batchOn) {
        batchOn.onclick = () => {
          if (state.selectedProducts.size === 0) { return; }
          post({ type: "setProductsStatus", ids: [...state.selectedProducts], status: 0 });
          state.selectedProducts.clear();
        };
      }
      if (batchOff) {
        batchOff.onclick = () => {
          if (state.selectedProducts.size === 0) { return; }
          post({ type: "setProductsStatus", ids: [...state.selectedProducts], status: 1 });
          state.selectedProducts.clear();
        };
      }
      if (batchDel) {
        batchDel.onclick = () => {
          if (state.selectedProducts.size === 0) { return; }
          confirmBox(
            `确认删除选中的 ${state.selectedProducts.size} 个商品？\n将同时删除它们的销售记录和入库记录，且不可恢复！`,
          ).then((ok) => {
            if (ok) {
              post({ type: "deleteProducts", ids: [...state.selectedProducts] });
              state.selectedProducts.clear();
            }
          });
        };
      }
      if (batchClear) {
        batchClear.onclick = () => {
          state.selectedProducts.clear();
          renderProducts();
        };
      }
    }

    function renderGallery(list) {
      $("productGalleryView").innerHTML =
        list.length === 0
          ? `<p class="muted">（无商品）</p>`
          : `<div class="card-grid">${list
              .map((p) => {
                const off = p.status === 1;
                const low = lowStock(p);
                const fields = PRODUCT_FIELDS.filter(
                  (f) => f.key !== "purchase_link" && visGallery.has(f.key),
                );
                const lines = fields
                  .map((f) => {
                    let v = "";
                    if (f.key === "grade") {
                      v = esc(displayGrade(p));
                    } else if (f.key === "status") {
                      v = "";
                    } else if (f.key === "netTotal") {
                      v = qty(p.soldTotal - p.refundTotal);
                    } else {
                      v = esc(p[f.key] ?? "");
                    }
                    if (v === "") {
                      return "";
                    }
                    if (f.key === "code") {
                      return `<div class="code">${v}</div>`;
                    }
                    if (f.key === "stockTotal") {
                      return `<div class="${low ? "low-stock-tag" : ""}">${f.label}：${qty(p.stockTotal || 0)}</div>`;
                    }
                    if (f.key === "cost_price" || f.key === "sale_price") {
                      return `<div>${f.label}：¥${money(v)}</div>`;
                    }
                    return `<div>${f.label}：${v}</div>`;
                  })
                  .filter((x) => x !== "")
                  .join("");
                const coverData = state.coverCache[p.code] || "";
                const starred = state.liveStars && state.liveStars.has(p.code);
                return `<div class="card ${off ? "off" : ""}" data-p-act="img" data-id="${p.id}">
                  <button class="star ${starred ? "on" : ""}" data-s-act="toggle" data-code="${esc(p.code)}" data-id="${p.id}" title="${starred ? "取消星标" : "加入直播排品备选"}">${starred ? "★" : "☆"}</button>
                  <span class="card-badge ${off ? "off" : ""}">${off ? "已下架" : p.code}</span>
                  ${coverData ? `<img src="${coverData}" />` : `<div class="ph">无图（双击表格行可改）</div>`}
                  <div class="card-body">${lines}</div>
                </div>`;
              })
              .join("")}</div>`;
    }

    function stateProduct(code) {
      return state.products.find((p) => p.code === code);
    }

    function renderLiveStars() {
      const wrap = $("liveStarWrap");
      if (!wrap) {
        return;
      }
      const codes = state.liveStars ? [...state.liveStars].sort() : [];
      if (codes.length === 0) {
        wrap.innerHTML = `<p class="muted">（还没选商品：去「商品管理 → 画册」点卡片 ⭐）</p>`;
        return;
      }
      wrap.innerHTML = codes
        .map((c) => {
          const p = stateProduct(c);
          return `<span class="live-star-chip" data-ls-act="fill" data-code="${esc(c)}" title="点击填入下一个空格">
            <span class="code">${esc(c)}</span>
            <span>${p ? esc(p.name) : "（已删除）"}</span>
            <button class="mini-btn btn-danger" data-ls-act="rm" data-code="${esc(c)}" title="移出备选">🗑</button>
          </span>`;
        })
        .join("");
    }

    function renderLiveGrid() {
      const area = $("liveGridArea");
      const label = $("liveOutLabel");
      if (label) {
        label.textContent = state.liveOutDir
          ? `输出：${state.liveOutDir}`
          : "（未选择输出目录）";
      }
      if (!area) {
        return;
      }
      const activeEl = document.activeElement;
      if (activeEl && activeEl.closest && activeEl.closest("[data-ls-cell]")) {
        return;
      }
      const plan = state.livePlan;
      const groupNos = [...new Set(plan.map((r) => r.group_no))].sort(
        (a, b) => a - b,
      );
      if (groupNos.length === 0) {
        area.innerHTML = `<p class="muted">（空：点「＋ 加一组」开始，或从上方备选里填格子）</p>`;
        return;
      }
      const seen = new Set();
      const dup = new Set();
      for (const r of plan) {
        if (r.code) {
          if (seen.has(r.code)) {
            dup.add(r.code);
          } else {
            seen.add(r.code);
          }
        }
      }
      area.innerHTML = groupNos
        .map((g) => {
          const slots = plan.filter((r) => r.group_no === g);
          const bySlot = new Map(slots.map((r) => [r.slot_no, r.code]));
          const startNum = (g - 1) * 9 + 1;
          let cells = "";
          for (let s = 1; s <= 9; s++) {
            let code = bySlot.get(s) || "";
            const num = startNum + s - 1;
            let cls = "";
            let placeholder = `填${num}号编码`;
            if (code) {
              const p = stateProduct(code);
              if (!p) {
                cls = "err";
                placeholder = `${num}号 ${esc(code)}（不存在）`;
              } else if (dup.has(code)) {
                cls = "dup";
                placeholder = `${num}号 ${esc(code)}（重复）`;
              } else {
                cls = "ok";
                placeholder = `${num}号 ${esc(code)}`;
              }
            } else {
              cls = "empty";
            }
            cells += `<div class="live-cell">
              <input data-ls-cell data-g="${g}" data-slot="${s}" data-num="${num}" class="${cls}" value="${esc(code)}" placeholder="${placeholder}" title="${cls === "dup" ? "重复出现的编号，请检查是否填重了" : ""}" />
              <div class="cell-code">${num}号</div>
            </div>`;
          }
          return `<div class="live-group">
            <div class="g-head">
              <b>第 ${g} 组</b>
              <span class="muted">${startNum}号~${startNum + 8}号</span>
              <button class="mini-btn g-gen" data-ls-act="gen" data-g="${g}" title="只生成这一组的九宫格并复制这组清单">🖼 生成这组</button>
              <button class="mini-btn btn-danger g-del" data-ls-act="delgroup" data-g="${g}">删组</button>
            </div>
            <div class="live-grid">${cells}</div>
          </div>`;
        })
        .join("");
      area.querySelectorAll("[data-ls-cell]").forEach((inp, i) => {
        const groupNo = Number(inp.dataset.g);
        const slotNo = Number(inp.dataset.slot);
        inp.oninput = () => {
          const raw = inp.value.trim();
          const code = raw ? canonicalCode(raw) : "";
          if (code && stateProduct(code)) {
            inp.classList.add("ok");
          } else {
            inp.classList.remove("ok");
          }
          upsertLiveSlot(groupNo, slotNo, code);
          scheduleLivePlanSave();
        };
        inp.onblur = () => {
          const raw = inp.value.trim();
          const code = raw ? canonicalCode(raw) : "";
          let err = false;
          if (raw && !code) {
            err = true;
          } else if (code && !stateProduct(code)) {
            err = true;
          }
          inp.classList.toggle("err", err);
          if (code) {
            const dupCount = state.livePlan.filter(
              (r) => r.code === code,
            ).length;
            inp.classList.toggle("dup", dupCount > 1);
          } else {
            inp.classList.remove("dup");
          }
        };
        inp.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const next = area.querySelectorAll("[data-ls-cell]")[i + 1];
            if (next) {
              next.focus();
            }
          }
        };
      });
    }

    function upsertLiveSlot(groupNo, slotNo, code) {
      let plan = state.livePlan.filter(
        (r) => !(r.group_no === groupNo && r.slot_no === slotNo),
      );
      if (code) {
        plan.push({ group_no: groupNo, slot_no: slotNo, code });
      }
      state.livePlan = plan;
    }

    let livePlanSaveTimer = null;
    function scheduleLivePlanSave() {
      clearTimeout(livePlanSaveTimer);
      livePlanSaveTimer = setTimeout(() => {
        post({
          type: "saveLivePlan",
          plan: state.livePlan
            .filter((r) => r.code)
            .map((r) => ({
              group_no: r.group_no,
              slot_no: r.slot_no,
              code: r.code,
            })),
        });
      }, 350);
    }

    function buildLiveListText() {
      const lines = [];
      const rows = state.livePlan
        .filter((r) => r.code)
        .sort((a, b) => a.group_no - b.group_no || a.slot_no - b.slot_no);
      for (const r of rows) {
        const p = stateProduct(r.code);
        if (!p) {
          continue;
        }
        const num = (r.group_no - 1) * 9 + r.slot_no;
        const price =
          p.sale_price !== null && p.sale_price !== undefined
            ? Number(p.sale_price).toFixed(2)
            : "0.00";
        lines.push(
          `${num}号 ${p.code} ${p.name} ¥${price} ${p.purchase_link || ""}`.trim(),
        );
      }
      return lines.join("\n");
    }

    function removeLiveGroup(groupNo) {
      state.livePlan = state.livePlan.filter((r) => r.group_no !== groupNo);
      scheduleLivePlanSave();
    }

    function findNextEmptySlot() {
      const occupied = new Set();
      let maxG = 0;
      for (const r of state.livePlan) {
        occupied.add(`${r.group_no}-${r.slot_no}`);
        if (r.group_no > maxG) {
          maxG = r.group_no;
        }
      }
      for (let g = 1; g <= maxG + 1; g++) {
        for (let s = 1; s <= 9; s++) {
          if (!occupied.has(`${g}-${s}`)) {
            return { group_no: g, slot_no: s };
          }
        }
      }
      return { group_no: maxG + 1, slot_no: 1 };
    }

    function fillNextEmptySlot(code) {
      const slot = findNextEmptySlot();
      upsertLiveSlot(slot.group_no, slot.slot_no, code);
      scheduleLivePlanSave();
      renderLiveGrid();
      const num = (slot.group_no - 1) * 9 + slot.slot_no;
      toast(`${code} → ${num}号`);
    }

    function generateGroup(groupNo) {
      const filled = state.livePlan.filter(
        (r) => r.group_no === groupNo && r.code && stateProduct(r.code),
      );
      if (filled.length === 0) {
        toast(`第 ${groupNo} 组没有可生成的商品`);
        return;
      }
      scheduleLivePlanSave();
      post({
        type: "generateLiveGrid",
        plan: state.livePlan.map((r) => ({ ...r })),
        groups: [groupNo],
      });
    }

    function bindLiveEvents() {
      const add = $("liveAddGroupBtn");
      if (add) {
        add.onclick = () => {
          const newest = state.livePlan.length
            ? Math.max(...state.livePlan.map((r) => r.group_no))
            : 0;
          const groupNo = newest + 1;
          for (let s = 1; s <= 9; s++) {
            state.livePlan.push({ group_no: groupNo, slot_no: s, code: "" });
          }
          renderLiveGrid();
        };
      }
      const clr = $("liveClearBtn");
      if (clr) {
        clr.onclick = () => {
          confirmBox("确认清空所有排品格子？（已选商品保留）").then((ok) => {
            if (ok) {
              state.livePlan = [];
              post({ type: "clearLivePlan" });
              renderLiveGrid();
            }
          });
        };
      }
      const pick = $("livePickOutBtn");
      if (pick) {
        pick.onclick = () => post({ type: "pickLiveOutDir" });
      }
      const gen = $("liveGenerateBtn");
      if (gen) {
        gen.onclick = () => {
          const filled = state.livePlan.filter(
            (r) => r.code && stateProduct(r.code),
          );
          if (filled.length === 0) {
            toast("先往格子里填至少一个有效编号");
            return;
          }
          scheduleLivePlanSave();
          post({
            type: "generateLiveGrid",
            plan: state.livePlan.map((r) => ({ ...r })),
          });
        };
      }
      const cpy = $("liveCopyListBtn");
      if (cpy) {
        cpy.onclick = () => {
          const text = buildLiveListText();
          if (!text) {
            toast("没有可复制的排品");
            return;
          }
          copyText(text, "清单已复制 ✅");
        };
      }
      const wrap = $("liveStarWrap");
      if (wrap) {
        wrap.addEventListener("click", (e) => {
          const rmBtn = e.target.closest("[data-ls-act='rm']");
          if (rmBtn) {
            const c = rmBtn.dataset.code;
            const set = new Set(state.liveStars || []);
            set.delete(c);
            state.liveStars = set;
            post({ type: "setLiveStars", codes: [...set] });
            return;
          }
          const chip = e.target.closest("[data-ls-act='fill']");
          if (chip) {
            fillNextEmptySlot(chip.dataset.code);
          }
        });
      }
      const area = $("liveGridArea");
      if (area) {
        area.addEventListener("click", (e) => {
          const genBtn = e.target.closest("[data-ls-act='gen']");
          if (genBtn) {
            generateGroup(Number(genBtn.dataset.g));
            return;
          }
          const btn = e.target.closest("[data-ls-act='delgroup']");
          if (btn) {
            removeLiveGroup(Number(btn.dataset.g));
            renderLiveGrid();
          }
        });
      }
    }

    function renderLive() {
      renderLiveStars();
      renderLiveGrid();
    }

    function openInlineEditor(td) {
      const pid = Number(td.dataset.pid);
      const field = td.dataset.f;
      const orig = td.innerHTML;
      td.dataset.orig = orig;
      const product = state.products.find((x) => x.id === pid);
      if (!product) {
        return;
      }
      let editor;
      let done = false;
      const finish = (commit) => {
        if (done) {
          return;
        }
        done = true;
        if (commit) {
          let val;
          if (field === "grade") {
            val = editor.value;
          } else {
            val = editor.value;
          }
          if (field === "cost_price" || field === "sale_price") {
            const n = Number(val);
            if (val !== "" && (!Number.isFinite(n) || n < 0)) {
              toast("必须是 ≥0 的数字");
              td.innerHTML = td.dataset.orig;
              return;
            }
            val = Number(val);
          }
          post({
            type: "updateProductField",
            id: pid,
            field,
            value: field === "grade" ? Number(val) : val,
          });
        }
        td.innerHTML = td.dataset.orig;
        delete td.dataset.orig;
      };
      if (field === "grade") {
        editor = document.createElement("select");
        editor.innerHTML =
          `<option value="0" ${product.price_manual === 1 ? "selected" : ""}>自定义（不按公式自动算）</option>` +
          state.rules
            .map(
              (r) =>
                `<option value="${r.grade}" ${product.price_manual !== 1 && r.grade === product.grade ? "selected" : ""}>${esc(gradeLabel(r.grade))}</option>`,
            )
            .join("");
        editor.onchange = () => finish(true);
      } else if (field === "cost_price" || field === "sale_price") {
        editor = document.createElement("input");
        editor.type = "number";
        editor.min = "0";
        editor.step = "0.01";
        editor.value = product[field];
      } else {
        editor = document.createElement("input");
        editor.value = cellValue(product, field);
        if (field === "category") {
          editor.setAttribute("list", "shopCatList");
        }
      }
      editor.style.cssText =
        "width:100%;min-width:70px;box-sizing:border-box;padding:2px 5px";
      td.innerHTML = "";
      td.appendChild(editor);
      editor.onblur = () => finish(true);
      editor.onkeydown = (e) => {
        if (e.key === "Enter") {
          finish(true);
        } else if (e.key === "Escape") {
          finish(false);
        }
        e.stopPropagation();
      };
      setTimeout(() => {
        if (Array.isArray(editor) ? false : editor.focus) {
          editor.focus();
          if (editor.select) {
            editor.select();
          }
        }
      }, 0);
    }

    function renderSales() {
      $("salesDate").value = state.salesDate || nowStr();
      $("salesDateLabel").textContent = state.salesDate || "";
      const rows = state.sales;
      const kept = new Set();
      rows.forEach((r) => {
        if (selSales.has(r.id)) {
          kept.add(r.id);
        }
      });
      selSales = kept;
      const allSel = rows.length > 0 && rows.every((r) => selSales.has(r.id));
      $("salesTableWrap").innerHTML =
        rows.length === 0
          ? `<p class="muted">（当日暂无销售记录）</p>`
          : `<table class="data-table"><thead><tr>
            <th style="width:30px"><input type="checkbox" data-s-act="selAll" ${allSel ? "checked" : ""} title="全选 / 取消全选" /></th>
            <th>编号</th><th>名称</th><th>卖出数量</th><th>退款数量</th><th>净售数量</th>
            <th title="记录当天成交时刻的进价快照；之后改进价不影响历史记录与月报">进价快照</th><th>备注</th><th></th>
          </tr></thead>
          <tbody>${rows
            .map(
              (r) => `<tr class="${selSales.has(r.id) ? "sel" : ""}">
              <td><input type="checkbox" data-s-act="sel" data-id="${r.id}" ${selSales.has(r.id) ? "checked" : ""} /></td>
              <td><b>${esc(r.code)}</b></td><td>${esc(r.name)}</td>
              <td class="num">${qty(r.sold_qty)}</td><td class="num">${qty(r.refund_qty)}</td>
              <td class="num">${qty(r.sold_qty - r.refund_qty)}</td>
              <td class="num" title="当天进价快照">¥${money(r.cost_price)}</td><td>${esc(r.note)}</td>
              <td><button class="mini-btn btn-danger" data-s-act="del" data-id="${r.id}" title="删除当日该条销售记录">🗑</button></td>
            </tr>`,
            )
            .join("")}</tbody></table>`;
      updateSelBtn();
    }

    function updateSelBtn() {
      const el = $("delSelBtn");
      if (!el) {
        return;
      }
      el.disabled = selSales.size === 0;
      el.textContent =
        selSales.size > 0 ? `删除选中 (${selSales.size})` : "删除选中";
    }

    function updateQuickLog() {
      const el = $("quickLog");
      if (!el) {
        return;
      }
      const code = canonicalCode($("quickCode").value);
      const date = $("salesDate").value;
      if (!code || !date || state.salesDate !== date) {
        el.textContent = "";
        return;
      }
      const rows = state.sales.filter((s) => s.code === code);
      if (rows.length === 0) {
        el.textContent = `${code}：今日暂无记录`;
        return;
      }
      const sold = rows.reduce((a, s) => a + s.sold_qty, 0);
      const refund = rows.reduce((a, s) => a + s.refund_qty, 0);
      el.textContent = `${code}：今日共 ${rows.length} 条记录，卖出 ${qty(sold)} 件，退款 ${qty(refund)} 件`;
    }

    function renderTrend() {
      const rows = state.trend.rows || [];
      const el = $("trendChart");
      if (!el) {
        return;
      }
      if (rows.length === 0) {
        el.innerHTML = `<p class="muted">（暂无销售数据）</p>`;
        return;
      }
      const data = rows.map((r) => ({
        period: r.period,
        sold: r.sold,
        refund: r.refund,
        net: r.net ?? Number(r.sold || 0) - Number(r.refund || 0),
      }));
      const width = Math.max(620, data.length * 44);
      const height = 190;
      const pad = { t: 16, r: 8, b: 26, l: 40 };
      const max = Math.max(1, ...data.map((r) => r.net));
      const min = Math.min(0, ...data.map((r) => r.net));
      const span = max - min || 1;
      const bw = width / Math.max(data.length, 1);
      const y = (v) => pad.t + ((max - v) / span) * (height - pad.t - pad.b);
      const bars = data
        .map((r, i) => {
          const bh = Math.abs((r.net / span) * (height - pad.t - pad.b));
          const top = r.net >= 0 ? y(r.net) : y(0);
          const color = r.net >= 0 ? "#23a884" : "#e0404b";
          let label = r.period;
          if (label.length > 7) {
            label = label.slice(5);
          }
          const tick =
            i % Math.max(1, Math.ceil(data.length / 8)) === 0 ? label : "";
          return `<rect x="${i * bw + 3}" y="${top}" width="${bw - 6}" height="${Math.max(bh, 1)}" fill="${color}">
              <title>${r.period}：售${r.sold} 退${r.refund} 净${r.net}</title>
            </rect>
            <text x="${i * bw + bw / 2}" y="${height - 8}" fill="var(--vscode-foreground)" font-size="10" text-anchor="middle">${tick}</text>`;
        })
        .join("");
      el.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <line x1="0" x2="${width}" y1="${y(0)}" y2="${y(0)}" stroke="var(--vscode-panel-border)" stroke-width="1"/>
        <text x="4" y="${y(0) - 4}" fill="var(--vscode-descriptionForeground)" font-size="10">净售${qty(max)}</text>
        ${bars}
      </svg><div class="muted">净售 = 卖出 − 退款；鼠标悬停柱子看当日明细</div>`;
    }

    function renderSettles() {
      const el = $("settlesTableWrap");
      if (!el) {
        return;
      }
      const s = state.settles;
      el.innerHTML =
        s.length === 0
          ? `<p class="muted">（还没有月报，去上面输入月份点「生成/刷新月报」）</p>`
          : `<table class="data-table"><thead><tr><th>月份</th><th>到账收入</th><th>货成本</th><th>其他支出</th><th>利润</th><th>净售</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${s
            .map(
              (x) => `<tr>
              <td><b>${esc(x.month)}</b></td>
              <td class="num">¥${money(x.income_amount)}</td>
              <td class="num">¥${money(x.goods_cost)}</td>
              <td class="num">¥${money(x.extra_expense)}</td>
              <td class="num ${x.profit >= 0 ? "profit-pos" : "profit-neg"}">¥${money(x.profit)}</td>
              <td class="num">${qty(x.sold_total - x.refund_total)}</td>
              <td>${x.locked === 1 ? '<span class="badge badge-off">已锁定</span>' : '<span class="badge badge-on">草稿</span>'}</td>
              <td>
                <button class="mini-btn" data-m-act="build" data-m="${esc(x.month)}">查看</button>
                ${x.locked === 1 ? `<button class="mini-btn" data-m-act="unlock" data-m="${esc(x.month)}">解锁</button>` : `<button class="mini-btn" data-m-act="lock" data-m="${esc(x.month)}">锁定</button>`}
                <button class="mini-btn btn-danger" data-m-act="del" data-m="${esc(x.month)}" title="删除月报（不影响销售记录）">🗑</button>
              </td>
            </tr>`,
            )
            .join("")}</tbody></table>`;

      const rows = [...s].sort((a, b) => a.month.localeCompare(b.month));
      const chart = $("profitChart");
      if (!chart) {
        return;
      }
      if (rows.length === 0) {
        chart.innerHTML = `<p class="muted">（保存/锁定月报后出现净利润柱状图）</p>`;
        return;
      }
      const width = Math.max(620, rows.length * 60);
      const height = 190;
      const pad = { t: 16, r: 8, b: 26, l: 44 };
      const max = Math.max(1, ...rows.map((r) => r.profit));
      const min = Math.min(0, ...rows.map((r) => r.profit));
      const span = max - min || 1;
      const bw = width / rows.length;
      const y = (v) => pad.t + ((max - v) / span) * (height - pad.t - pad.b);
      const bars = rows
        .map((r, i) => {
          const bh = Math.abs((r.profit / span) * (height - pad.t - pad.b));
          const top = r.profit >= 0 ? y(r.profit) : y(0);
          const color = r.profit >= 0 ? "#23a884" : "#e0404b";
          return `<rect x="${i * bw + 4}" y="${top}" width="${bw - 8}" height="${Math.max(bh, 1)}" fill="${color}">
              <title>${r.month}：¥${money(r.profit)}</title></rect>
            <text x="${i * bw + bw / 2}" y="${height - 8}" fill="var(--vscode-foreground)" font-size="10" text-anchor="middle">${r.month.slice(2)}</text>`;
        })
        .join("");
      chart.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <line x1="0" x2="${width}" y1="${y(0)}" y2="${y(0)}" stroke="var(--vscode-panel-border)" stroke-width="1"/>
        ${bars}
      </svg>`;
    }

    function renderSettlePanel(payload) {
      const { month, snapshot, settle } = payload;
      if (!$("settleMonth")) {
        return;
      }
      $("settleMonth").value = month;
      const net = snapshot.sold_total - snapshot.refund_total;
      const locked = !!(settle && settle.locked === 1);
      $("settleStats").innerHTML =
        `<div class="stat-line">本月销售：卖出 <b>${qty(snapshot.sold_total)}</b> 件，退款 <b>${qty(snapshot.refund_total)}</b> 件，净售 <b>${qty(net)}</b> 件</div>
         <div class="stat-line">货成本（Σ净售 × 进价快照）：<b>¥${money(snapshot.goods_cost)}</b></div>`;
      const incomeInput = $("settleIncome");
      const expInput = $("settleExpense");
      incomeInput.value = settle ? Number(settle.income_amount).toFixed(2) : "";
      expInput.value = settle ? Number(settle.extra_expense).toFixed(2) : "";
      const upd = () => {
        const income = Number(incomeInput.value || 0);
        const exp = Number(expInput.value || 0);
        const profit = income - snapshot.goods_cost - exp;
        const cl = profit >= 0 ? "profit-pos" : "profit-neg";
        $("settleProfit").innerHTML =
          `<div class="stat-line">本月利润 = 到账 ¥${money(income)} − 货成本 ¥${money(snapshot.goods_cost)} − 支出 ¥${money(exp)} = <span class="num-big ${cl}">¥${money(profit)}</span></div>`;
      };
      upd();
      incomeInput.oninput = upd;
      expInput.oninput = upd;
      $("settleSaveBtn").disabled = locked;
      $("settleLockBtn").disabled = locked || !settle;
      $("settleUnlockBtn").disabled = !locked;
      $("settleDeleteBtn").disabled = locked;
      $("settleSaveBtn").textContent = locked ? "已锁定" : "保存月报";
    }

    function renderRules() {
      const tb = document.querySelector("#rulesTable tbody");
      if (!tb) {
        return;
      }
      tb.innerHTML = state.rules
        .map((r) => {
          const ex = calcPrice(10, r);
          const customVis =
            r.tail_mode === "custom" ? "" : 'style="display:none"';
          return `<tr data-grade="${r.grade}">
            <td><input name="grade" type="number" min="1" max="99" value="${r.grade}" style="width:56px" /></td>
            <td><input name="label" value="${esc(r.label)}" placeholder="等级名" /></td>
            <td><input name="expr" value="${esc(r.expr)}" placeholder="cost+10 / cost*1.5" /></td>
            <td><select name="tail_mode">
              <option value="raw" ${r.tail_mode === "raw" ? "selected" : ""}>保留原数</option>
              <option value="round" ${r.tail_mode === "round" ? "selected" : ""}>取整</option>
              <option value="p99" ${r.tail_mode === "p99" ? "selected" : ""}>.99 尾数</option>
              <option value="p88" ${r.tail_mode === "p88" ? "selected" : ""}>.88 尾数</option>
              <option value="custom" ${r.tail_mode === "custom" ? "selected" : ""}>自定义</option>
            </select></td>
            <td><input name="tail_value" type="number" min="0" max="99" value="${esc(r.tail_value)}" style="width:64px" ${customVis} /></td>
            <td class="computed">¥${money(ex)}</td>
            <td><button class="mini-btn btn-danger" data-r-act="del" data-grade="${r.grade}" title="删除该等级规则">删</button></td>
          </tr>`;
        })
        .join("");
      tb.querySelectorAll("select[name='tail_mode']").forEach((sel) => {
        sel.onchange = () => {
          const row = sel.closest("tr");
          row.querySelector('input[name="tail_value"]').style.display =
            sel.value === "custom" ? "" : "none";
        };
      });
    }

    function renderSettings() {
      state.settings.image_dir = state.settings.image_dir || "";
      $("setImageDir").value = state.settings.image_dir;
      $("setNameTemplate").value =
        state.settings.name_template || "{name}{series}{grade}{code}";
      $("setStockAlert").value = Number(state.settings.stock_alert || 0);
      $("clearFilterBtn").style.visibility = hasFilter() ? "visible" : "hidden";
    }

    function populateFilters() {
      const seriesAll = [
        ...new Set(state.products.map((p) => p.series).filter(Boolean)),
      ].sort();
      const catsAll = [
        ...new Set(state.products.map((p) => p.category).filter(Boolean)),
      ].sort();
      const trendAll = state.products.map(
        (p) => `${p.id}|${p.code}|${p.name}`,
      );
      const sig = JSON.stringify([seriesAll, catsAll, trendAll]);
      if (sig === filtersSig) {
        return;
      }
      filtersSig = sig;
      const series = seriesAll;
      const cats = catsAll;
      const fillSel = (el, vals, emptyLabel) => {
        const cur = el.value;
        el.innerHTML =
          `<option value="">${emptyLabel}</option>` +
          vals
            .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)
            .join("");
        el.value = cur;
      };
      fillSel($("filterSeries"), series, "全部系列");
      fillSel($("filterCategory"), cats, "全部品类");
      const trendSel = $("trendProduct");
      const curP = trendSel.value;
      trendSel.innerHTML =
        `<option value="">全部商品（按月）</option>` +
        state.products
          .map(
            (p) =>
              `<option value="${p.id}">${esc(p.code)} ${esc(p.name)}</option>`,
          )
          .join("");
      trendSel.value = curP;
      fillCatList();
    }

    function openNewProduct() {
      const grades = state.rules.map((r) => r.grade);
      const selGrades = grades.length ? grades.join(",") : "1";
      const mask = showModal(`
        <h3>＋ 新建商品</h3>
        <div class="form-grid">
          <label>编号 *</label><input id="npCode" placeholder="L001 或 L076，自动补零到 3 位" />
          <label>名称 *</label><input id="npName" placeholder="如：铜合金锆石手链 四叶花" />
          <label>品类</label><input id="npCategory" list="shopCatList" placeholder="手链 / 项链 / 耳环 / 戒指 / 手镯…可自定义" />
          <label>系列</label><input id="npSeries" placeholder="A类 / B类 / C类…（平台链接系列，可空）" />
          <label>等级</label><select id="npGrade"><option value="0">自定义（售价手动定）</option>${selGrades
            .split(",")
            .map(
              (g) =>
                `<option value="${g}">${gradeLabel(g)}</option>`,
            )
            .join("")}</select>
          <label>进价 ¥</label><input id="npCost" type="number" min="0" step="0.01" value="0" />
          <label>售价 ¥（留空=按等级自动算）</label><input id="npSale" type="number" min="0" step="0.01" />
          <label></label><span class="computed" id="npPreview">售价将自动计算</span>
          <label>期初库存</label><input id="npStock" type="number" min="0" value="0" />
          <label>采购链接</label><input id="npLink" placeholder="下次进货去这里" />
          <label>备注</label><input id="npRemark" />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="npCancel">取消</button>
          <button id="npSave" class="btn-teal">保存</button>
        </div>`);
      const upd = () => {
        const cost = Number($("npCost").value || 0);
        const grade = Number($("npGrade").value);
        const rule = state.rules.find((r) => r.grade === grade);
        const manual = Number($("npSale").value || 0);
        $("npPreview").textContent =
          manual > 0
            ? `手动售价 ¥${money(manual)}`
            : grade === 0
              ? `自定义售价：请填「售价」`
              : `将按规则自动算：进价 ¥${money(cost)} → ¥${money(calcPrice(cost, rule))}`;
      };
      $("npGrade").onchange = upd;
      $("npCost").oninput = upd;
      $("npSale").oninput = upd;
      upd();
      $("npCancel").onclick = closeModal;
      $("npSave").onclick = () => {
        if (!$("npCode").value.trim() || !$("npName").value.trim()) {
          toast("编号和名称必填");
          return;
        }
        const npGrade = Number($("npGrade").value);
        if (npGrade === 0 && !(Number($("npSale").value || 0) > 0)) {
          toast("自定义等级需要填写售价");
          return;
        }
        post({
          type: "addProduct",
          code: $("npCode").value,
          name: $("npName").value,
          category: $("npCategory").value,
          series: $("npSeries").value,
          grade: npGrade,
          costPrice: Number($("npCost").value || 0),
          salePrice: Number($("npSale").value || 0),
          initialStock: Number($("npStock").value || 0),
          purchaseLink: $("npLink").value,
          remark: $("npRemark").value,
        });
        closeModal();
      };
    }

    function openImportProducts() {
      const mask = showModal(`
        <h3>📥 导入商品</h3>
        <p class="muted">每行一商品，列顺序：<b>编号, 名称, 品类, 系列, 等级, 进价, 售价, 采购链接</b>；Tab 或空格或逗号分隔；只要「编号」也能建（其余走默认）。已有编号跳过。</p>
        <textarea id="ipText" placeholder="示例：
L001&#9;铜合金锆石手链四叶花&#9;手链&#9;C类&#9;2&#9;12&#9;&#9;
L002 合金项链十字架 项链 A类 1 8.5"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button id="ipCancel">取消</button>
          <button id="ipDo" class="btn-teal">导入</button>
        </div>`);
      $("ipCancel").onclick = closeModal;
      $("ipDo").onclick = () => {
        if (!$("ipText").value.trim()) {
          toast("先粘贴内容");
          return;
        }
        post({ type: "importProducts", text: $("ipText").value });
        closeModal();
      };
    }

    function openStockIn(product) {
      const mask = showModal(`
        <h3>📦 补货入库 <span class="muted">${esc(product.code)} ${esc(product.name)}（库存 ${qty(product.stockTotal)}）</span></h3>
        <div class="form-grid">
          <label>数量 *</label><input id="siQty" type="number" min="1" value="1" />
          <label>日期</label><input id="siDate" type="date" value="${nowStr()}" />
          <label>备注</label><input id="siRemark" placeholder="默认：补货入库" />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="siCancel">取消</button>
          <button id="siSave" class="btn-teal">入库</button>
        </div>`);
      $("siCancel").onclick = closeModal;
      $("siSave").onclick = () => {
        post({
          type: "addStockIn",
          productId: product.id,
          qty: Number($("siQty").value || 0),
          date: $("siDate").value || nowStr(),
          remark: $("siRemark").value || "补货入库",
        });
        closeModal();
      };
    }

    function checkGroupHtml(prefix, set) {
      return PRODUCT_FIELDS.map(
        (f) =>
          `<label>${f.label}</label><input type="checkbox" data-g="${prefix}" data-cfk="${f.key}" ${set.has(f.key) ? "checked" : ""} />`,
      ).join("");
    }

    function openColSet() {
      const isList = viewMode !== "gallery";
      const toggle = isList ? new Set(visList) : new Set(visGallery);
      const keyName = isList ? "列表视图" : "画册视图（卡片上显示的字段）";
      const mask = showModal(`
        <h3>字段显示 / 隐藏（当前：${keyName}）</h3>
        <p class="muted">这里只调整「${keyName}」的显示；切换到另一个视图后再打开会看到它的配置（两者分开保存）。</p>
        <div style="margin-bottom:6px">
          <button class="mini-btn" id="csListAll">全选</button>
          <button class="mini-btn" id="csListNone">不选</button>
        </div>
        <div class="form-grid">${checkGroupHtml("cur", toggle)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="csReset">复原默认（全部显示）</button>
          <button id="csCancel">取消</button>
          <button id="csSave" class="btn-teal">保存</button>
        </div>`);
      const recalc = () => {
        mask
          .querySelectorAll('[data-g="cur"]')
          .forEach((cb) => (cb.checked = toggle.has(cb.dataset.cfk)));
      };
      $("csListAll").onclick = () => {
        PRODUCT_FIELDS.forEach((f) => toggle.add(f.key));
        recalc();
      };
      $("csListNone").onclick = () => {
        toggle.clear();
        recalc();
      };
      mask.querySelectorAll('[data-g="cur"]').forEach((cb) => {
        cb.onchange = () =>
          cb.checked
            ? toggle.add(cb.dataset.cfk)
            : toggle.delete(cb.dataset.cfk);
      });
      $("csReset").onclick = async () => {
        if (await confirmBox(`复原默认：${keyName}显示全部字段？`)) {
          PRODUCT_FIELDS.forEach((f) => toggle.add(f.key));
          recalc();
        }
      };
      $("csCancel").onclick = closeModal;
      $("csSave").onclick = () => {
        if (isList) {
          visList = new Set(toggle);
        } else {
          visGallery = new Set(toggle);
        }
        post({
          type: "saveSettings",
          key: isList ? "col_visible_list" : "col_visible_gallery",
          value: JSON.stringify([...toggle]),
        });
        closeModal();
        renderProducts();
      };
    }

    function openContextMenu(e, p) {
      e.preventDefault();
      e.stopPropagation();
      const old = document.getElementById("ctxMenu");
      if (old) {
        old.remove();
      }
      const menu = document.createElement("div");
      menu.id = "ctxMenu";
      menu.style.cssText =
        "position:fixed;z-index:70;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px 0;min-width:130px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      menu.innerHTML = `<div class="ctx-item" data-copy="row">复制整行</div><div class="ctx-item" data-copy="table">复制整表(筛选后)</div>`;
      menu.style.left = Math.min(e.clientX, window.innerWidth - 140) + "px";
      menu.style.top = Math.min(e.clientY, window.innerHeight - 60) + "px";
      document.body.appendChild(menu);
      const close = () => menu.remove();
      menu.addEventListener("click", () => close());
      menu.querySelector('[data-copy="row"]').onclick = () => {
        const vis = visList;
        const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => vis.has(k));
        copyText(keys.map((k) => cellValue(p, k)).join("\t"));
        close();
      };
      menu.querySelector('[data-copy="table"]').onclick = () => {
        const list = filteredProducts();
        const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) =>
          visList.has(k),
        );
        const lines = [
          keys
            .map((k) => PRODUCT_FIELDS.find((f) => f.key === k).label)
            .join("\t"),
        ];
        for (const row of list) {
          lines.push(keys.map((k) => cellValue(row, k)).join("\t"));
        }
        copyText(lines.join("\n"));
        close();
      };
      setTimeout(() => {
        const onDown = (ev) => {
          if (!menu.contains(ev.target)) {
            close();
            window.removeEventListener("mousedown", onDown);
          }
        };
        window.addEventListener("mousedown", onDown);
      }, 0);
    }

    function bindEvents() {
      $("viewListBtn").onclick = () => {
        viewMode = "list";
        $("viewListBtn").classList.add("btn-teal");
        $("viewGalleryBtn").classList.remove("btn-teal");
        renderProducts();
      };
      $("viewGalleryBtn").onclick = () => {
        viewMode = "gallery";
        $("viewGalleryBtn").classList.add("btn-teal");
        $("viewListBtn").classList.remove("btn-teal");
        renderProducts();
      };
      const pgr = $("productPager");
      if (pgr) {
        pgr.addEventListener("click", (e) => {
          const b = e.target.closest("[data-pg]");
          if (!b) {
            return;
          }
          const total = filteredProducts().length;
          const pages = Math.max(1, Math.ceil(total / pageSize));
          if (b.dataset.pg === "prev") {
            if (listPage > 1) {
              listPage--;
            }
          } else if (b.dataset.pg === "next") {
            if (listPage < pages) {
              listPage++;
            }
          }
          renderProducts();
        });
        pgr.addEventListener("change", (e) => {
          if (e.target && e.target.id === "pageSizeSel") {
            pageSize = Math.max(1, Math.floor(Number(e.target.value || "200")));
            listPage = 1;
            renderProducts();
          }
        });
        pgr.addEventListener("keydown", (e) => {
          if (e.target && e.target.id === "pageJump" && e.key === "Enter") {
            const n = Math.floor(Number(e.target.value || "1"));
            if (Number.isFinite(n) && n > 0) {
              const total = filteredProducts().length;
              const pages = Math.max(1, Math.ceil(total / pageSize));
              listPage = Math.min(n, pages);
              renderProducts();
            }
          }
        });
      }
      $("filterStatus").onchange = renderProducts;
      $("filterSeries").onchange = renderProducts;
      $("filterCategory").onchange = renderProducts;
      $("newProductBtn").onclick = openNewProduct;
      $("colSetBtn").onclick = openColSet;
      $("importProductBtn").onclick = openImportProducts;
      $("clearFilterBtn").onclick = () => {
        for (const k of Object.keys(filters)) {
          delete filters[k];
        }
        $("clearFilterBtn").style.visibility = "hidden";
        renderProducts();
      };

      $("productListView").addEventListener("dblclick", (e) => {
        const td = e.target.closest("td[data-edit]");
        if (td) {
          openInlineEditor(td);
          return;
        }
      });
      $("productListView").addEventListener("click", onProductAct);
      $("productListView").addEventListener("contextmenu", onProductCtx);
      $("productGalleryView").addEventListener("click", onProductAct);
      $("salesTableWrap").addEventListener("click", onSalesAct);
      $("settlesTableWrap").addEventListener("click", onSettleAct);

      $("salesDate").onchange = () =>
        post({ type: "loadSales", date: $("salesDate").value });
      if ($("salesRefreshBtn")) {
        $("salesRefreshBtn").onclick = () =>
          post({ type: "loadSales", date: $("salesDate").value });
      }
      if ($("delSelBtn")) {
        $("delSelBtn").onclick = () => {
          if (selSales.size === 0) {
            return;
          }
          confirmBox(`确认删除选中的 ${selSales.size} 条销售记录？`).then(
            (ok) => {
              if (ok) {
                post({
                  type: "deleteSales",
                  ids: [...selSales],
                  date: $("salesDate").value,
                });
                selSales.clear();
                updateSelBtn();
              }
            },
          );
        };
      }
      $("quickCode").oninput = updateQuickLog;
      $("quickCode").onchange = updateQuickLog;
      $("quickSaveBtn").onclick = () => {
        const code = canonicalCode($("quickCode").value);
        if (!code) {
          toast("编号格式不对");
          return;
        }
        const p = state.products.find((x) => x.code === code);
        if (!p) {
          toast("编号 " + code + " 不在商品档案里，先去「商品管理」新建");
          return;
        }
        post({
          type: "saveSale",
          date: $("salesDate").value || nowStr(),
          productId: p.id,
          sold: Number($("quickSold").value || 0),
          refund: Number($("quickRefund").value || 0),
          note: $("quickNote").value,
          mode: $("dupMode").value,
        });
        $("quickSold").value = "0";
        $("quickRefund").value = "0";
        $("quickNote").value = "";
      };
      $("pasteBtn").onclick = () => {
        const text = $("pasteArea").value;
        if (!text.trim()) {
          toast("先粘贴内容");
          return;
        }
        post({
          type: "pasteSales",
          date: $("salesDate").value || nowStr(),
          text,
          mode: $("dupMode").value,
        });
      };
      $("pasteArea").value = "";
      $("trendBtn").onclick = requestTrend;
      $("trendProduct").onchange = requestTrend;
      $("trendGroup").onchange = requestTrend;
      $("trendMonth").onchange = requestTrend;

      $("settleBuildBtn").onclick = () =>
        post({
          type: "monthBuild",
          month: $("settleMonth").value || monthNow(),
        });
      $("settleSaveBtn").onclick = () =>
        post({
          type: "saveSettle",
          month: $("settleMonth").value || monthNow(),
          incomeAmount: Number($("settleIncome").value || 0),
          extraExpense: Number($("settleExpense").value || 0),
        });
      $("settleLockBtn").onclick = () =>
        post({ type: "lockSettle", month: $("settleMonth").value });
      $("settleUnlockBtn").onclick = () =>
        post({ type: "unlockSettle", month: $("settleMonth").value });
      $("settleDeleteBtn").onclick = async () => {
        if (await confirmBox("确认删除该月报？（不会删销售记录）")) {
          post({ type: "deleteSettle", month: $("settleMonth").value });
        }
      };

      $("addRuleBtn").onclick = () => {
        const maxG = state.rules.length
          ? Math.max(...state.rules.map((r) => r.grade))
          : 0;
        state.rules.push({
          grade: maxG + 1,
          label: "等级" + (maxG + 1),
          expr: "cost*1.2",
          tail_mode: "raw",
          tail_value: "",
        });
        renderRules();
      };
      $("saveRulesBtn").onclick = () => {
        const rows = [...document.querySelectorAll("#rulesTable tbody tr")].map(
          (tr) => ({
            grade: Number(tr.querySelector('input[name="grade"]').value),
            label: tr.querySelector('input[name="label"]').value,
            expr: tr.querySelector('input[name="expr"]').value,
            tail_mode: tr.querySelector('select[name="tail_mode"]').value,
            tail_value: tr.querySelector('input[name="tail_value"]').value,
          }),
        );
        post({ type: "saveRules", rules: rows });
      };
      document
        .querySelector("#rulesTable tbody")
        .addEventListener("click", (e) => {
          const btn = e.target.closest("[data-r-act='del']");
          if (btn) {
            const grade = Number(btn.dataset.grade);
            state.rules = state.rules.filter((r) => r.grade !== grade);
            renderRules();
          }
        });

      $("pickImageDirBtn").onclick = () => post({ type: "pickImageDir" });
      $("saveNameTemplateBtn").onclick = () =>
        post({
          type: "saveSettings",
          key: "name_template",
          value: $("setNameTemplate").value,
        });
      $("saveStockAlertBtn").onclick = () =>
        post({
          type: "saveSettings",
          key: "stock_alert",
          value: String(Number($("setStockAlert").value || 0)),
        });
      bindLiveEvents();
    }

    function onProductCtx(e) {
      const td = e.target.closest("td[data-pid]");
      if (!td) {
        return;
      }
      const p = state.products.find((x) => x.id === Number(td.dataset.pid));
      if (!p) {
        return;
      }
      openContextMenu(e, p);
    }

    function onProductAct(e) {
      const starBtn = e.target.closest("[data-s-act]");
      if (starBtn) {
        e.stopPropagation();
        const code = starBtn.dataset.code;
        if (code) {
          if (!state.liveStars) {
            state.liveStars = new Set();
          }
          const set = new Set(state.liveStars);
          const adding = !set.has(code);
          if (adding) {
            set.add(code);
          } else {
            set.delete(code);
          }
          state.liveStars = set;
          post({ type: "toggleLiveStar", code });
          renderProducts();
        }
        return;
      }
      const th = e.target.closest("th[data-sort]");
      if (th) {
        const k = th.dataset.sort;
        if (sortKey === k) {
          sortDir = -sortDir;
        } else {
          sortKey = k;
          sortDir = 1;
        }
        renderProducts();
        return;
      }
      const btn = e.target.closest("[data-p-act]");
      if (!btn) {
        return;
      }
      const id = Number(btn.dataset.id);
      const product = state.products.find((x) => x.id === id);
      if (!product) {
        return;
      }
      const act = btn.dataset.pAct;
      if (act === "img") {
        openLightbox(product);
      } else if (act === "copy") {
        copyText(fullName(product));
      } else if (act === "stockin") {
        openStockIn(product);
      } else if (act === "status") {
        post({ type: "setStatus", id, status: Number(btn.dataset.status) });
      } else if (act === "clearimg") {
        confirmBox(
          `确认清空 ${product.code} 的图片文件夹？（文件会真的删除）`,
        ).then((ok) => {
          if (ok) {
            post({ type: "clearImages", code: product.code });
          }
        });
      } else if (act === "del") {
        confirmBox(
          `确认删除 ${product.code} ${product.name}？\n将同时删除它的销售记录和入库记录，且不可恢复！`,
        ).then((ok) => {
          if (ok) {
            post({ type: "deleteProduct", id });
          }
        });
      }
    }

    function onSalesAct(e) {
      const btn = e.target.closest("[data-s-act]");
      if (!btn) {
        return;
      }
      if (btn.dataset.sAct === "del") {
        confirmBox("确认删除这条销售记录？").then((ok) => {
          if (ok) {
            post({
              type: "deleteSales",
              ids: [Number(btn.dataset.id)],
              date: $("salesDate").value,
            });
          }
        });
      } else if (btn.dataset.sAct === "sel") {
        const id = Number(btn.dataset.id);
        if (btn.checked) {
          selSales.add(id);
        } else {
          selSales.delete(id);
        }
        const tr = btn.closest("tr");
        if (tr) {
          tr.classList.toggle("sel", btn.checked);
        }
        updateSelBtn();
      } else if (btn.dataset.sAct === "selAll") {
        if (btn.checked) {
          state.sales.forEach((r) => selSales.add(r.id));
        } else {
          selSales.clear();
        }
        renderSales();
      }
    }

    function onSettleAct(e) {
      const btn = e.target.closest("[data-m-act]");
      if (!btn) {
        return;
      }
      const month = btn.dataset.m;
      const act = btn.dataset.mAct;
      if (act === "build") {
        post({ type: "monthBuild", month });
      } else if (act === "lock" || act === "unlock") {
        post({ type: act === "lock" ? "lockSettle" : "unlockSettle", month });
      } else if (act === "del") {
        confirmBox(`确认删除 ${month} 月报？`).then((ok) => {
          if (ok) {
            post({ type: "deleteSettle", month });
          }
        });
      }
    }

    function requestTrend() {
      const by = $("trendGroup").value;
      const productId = $("trendProduct").value
        ? Number($("trendProduct").value)
        : undefined;
      if (by === "day") {
        const month = $("trendMonth").value || monthNow();
        $("trendMonth").value = month;
        post({ type: "salesTrend", by, month, productId });
      } else {
        post({ type: "salesTrend", by, productId });
      }
    }

    function init() {
      $("salesDate").value = nowStr();
      $("trendMonth").value = monthNow();
      $("settleMonth").value = monthNow();
      bindEvents();
      renderProducts();
      renderLive();
      post({ type: "loadAll" });
      requestTrend();
    }

    function onMessage(msg) {
      switch (msg.type) {
        case "productsLoaded": {
          state.products = msg.products || [];
          state.settings.stock_alert = msg.stockAlert || 0;
          populateFilters();
          break;
        }
        case "rulesLoaded": {
          state.rules = msg.rules || [];
          renderRules();
          break;
        }
        case "settingsLoaded": {
          state.settings = { ...state.settings, ...(msg.settings || {}) };
          renderSettings();
          try {
            const arr = JSON.parse(state.settings.col_visible_list || "[]");
            if (Array.isArray(arr) && arr.length) {
              visList = new Set(arr);
            }
          } catch {
            /* 保持默认 */
          }
          try {
            const arr = JSON.parse(state.settings.col_visible_gallery || "[]");
            if (Array.isArray(arr) && arr.length) {
              visGallery = new Set(arr);
            }
          } catch {
            /* 保持默认 */
          }
          renderProducts();
          break;
        }
        case "salesLoaded": {
          state.salesDate = msg.date;
          state.sales = msg.sales || [];
          renderSales();
          updateQuickLog();
          break;
        }
        case "pasteResult": {
          const parts = [
            `新增${msg.created} 更新${msg.updated} 跳过${msg.skipped}`,
          ];
          if (msg.missing && msg.missing.length) {
            parts.push(`未匹配：${msg.missing.join(" ")}`);
          }
          if (msg.badLines && msg.badLines.length) {
            parts.push(
              `无法解析 ${msg.badLines.length} 行：${msg.badLines.join("；")}`,
            );
          }
          $("pasteHint").textContent = parts.join("，");
          break;
        }
        case "productsImported": {
          $("pasteHint").textContent = "";
          toast(`商品导入完成：新增${msg.created}，跳过${msg.skipped}`);
          break;
        }
        case "settlesLoaded": {
          state.settles = msg.settles || [];
          renderSettles();
          break;
        }
        case "trendLoaded": {
          state.trend = {
            by: msg.by,
            rows: msg.rows || [],
            productId: msg.productId,
          };
          renderTrend();
          break;
        }
        case "monthBuilt": {
          renderSettlePanel(msg);
          break;
        }
        case "coverLoaded": {
          state.coverCache[msg.code] = msg.data || "";
          delete state.coverPending[msg.code];
          coverInFlight = Math.max(0, coverInFlight - 1);
          pumpCovers();
          requestCoverRender();
          break;
        }
        case "coverInvalidated": {
          delete state.coverCache[msg.code];
          delete state.coverPending[msg.code];
          requestCoverRender();
          break;
        }
        case "liveState": {
          const stars = Array.isArray(msg.stars) ? msg.stars : [];
          const starCodes = stars.map((s) => String(s).trim()).filter(Boolean);
          state.liveStars = new Set(starCodes);
          const plan = Array.isArray(msg.plan) ? msg.plan : [];
          state.livePlan = plan.map((r) => ({
            group_no: Number(r.group_no),
            slot_no: Number(r.slot_no),
            code: String(r.code ?? ""),
          }));
          state.liveOutDir = String(msg.outDir || "");
          renderLive();
          break;
        }
        case "liveGenerated": {
          toast(
            `已生成 ${msg.count || 0} 张九宫格 → ${msg.dir || ""}` +
              (msg.count ? "；清单已复制" : ""),
          );
          break;
        }
        case "imagesLoaded": {
          if (state.lbCode !== msg.code) {
            break;
          }
          if (msg.images && msg.images.length) {
            state.coverCache[msg.code] = msg.images[0];
          }
          const thumbs = document.getElementById("lbThumbs");
          const big = document.getElementById("lbBig");
          if (!thumbs || !big) {
            break;
          }
          if (!msg.images.length) {
            thumbs.innerHTML = `<span class="muted" style="color:#bbb">（无图片：把图放到「图片根目录/${esc(msg.code)}」文件夹，或点「🖼 上传图片」）</span>`;
            big.style.display = "none";
            return;
          }
          const big0 = msg.big0 || "";
          big.src = big0;
          big.style.display = "inline-block";
          thumbs.innerHTML = msg.images
            .map(
              (u, i) =>
                `<img src="${u}" class="${i === 0 ? "active" : ""}" data-i="${i}" />`,
            )
            .join("");
          thumbs.querySelectorAll("img").forEach((img) => {
            img.onclick = () => {
              const idx = Number(img.dataset.i);
              const key = `${msg.code}:${idx}`;
              thumbs
                .querySelectorAll("img")
                .forEach((x) => x.classList.remove("active"));
              img.classList.add("active");
              const cached = state.lbFullCache[key];
              if (cached) {
                big.src = cached;
              } else if (idx === 0 && big0) {
                state.lbFullCache[key] = big0;
                big.src = big0;
              } else {
                post({ type: "getFullImage", code: msg.code, index: idx });
              }
            };
          });
          break;
        }
        case "fullImageLoaded": {
          if (state.lbCode !== msg.code) {
            break;
          }
          const big = document.getElementById("lbBig");
          if (!big || !msg.data) {
            break;
          }
          state.lbFullCache[`${msg.code}:${msg.index}`] = msg.data;
          big.src = msg.data;
          break;
        }
      }
    }

    return {
      init,
      onMessage,
      _state: state,
      _isReady: true,
    };
  })();
})();
