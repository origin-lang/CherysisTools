// shopTool 前端模块（加载顺序第 3 个）：商品管理（列表/画册/筛选/内联编辑/批量/新建/导入/入库/列设置/右键菜单）
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
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

var selCell = null; // { pid, field } 列表视图当前选中的单元格
var appClipboard = null; // { value } 内部单元格剪贴板内容 | null
var pendingImportToken = ""; // 商品导入「解析预览→确认提交」的令牌
var ipMask = null; // 当前商品导入弹窗遮罩（提交成功/取消后复位）

const TEXT_FILTER_FIELDS = new Set([
  "code",
  "name",
  "series",
  "soldTotal",
  "netTotal",
  "remark",
]);
const RANGE_FILTER_FIELDS = new Set(["cost_price", "sale_price", "stockTotal"]);

function saveFieldValue(pid, field, raw) {
  const res = sanitizeProductField(field, raw);
  if (!res.ok) {
    toast(res.msg);
    return false;
  }
  if (field === "stockTotal") {
    post({ type: "setStockQty", id: pid, qty: res.value });
  } else {
    post({
      type: "updateProductField",
      id: pid,
      field,
      value: field === "grade" ? Number(res.value) : res.value,
    });
    if (res.truncated) {
      toast("已保存（超出长度已截断）");
      return "truncated";
    }
  }
  toast("已保存");
  return true;
}

function selectListCell(pid, field) {
  selCell = { pid: Number(pid), field: String(field) };
  syncListCellState();
}

function copyCell(p, field) {
  const value = field ? cellValue(p, field) : "";
  copyText(value, "已复制该格 ✅");
  appClipboard = value;
}

function cutCell(p, field) {
  if (!CUTTABLE_FIELDS.has(field)) {
    toast("该列不可清空，无法剪切");
    return;
  }
  const value = field ? cellValue(p, field) : "";
  copyText(value);
  appClipboard = value;
  const r = saveFieldValue(p.id, field, "");
  toast(r === false ? "已复制，但源格清空失败" : `已剪切并清空源格 ✅`);
  if (selCell && selCell.pid === p.id && selCell.field === field) {
    selectListCell(p.id, field);
  }
}

function pasteCell(pid, field) {
  const doPaste = (val) => {
    const v = String(val ?? "").trim();
    if (!v) {
      toast("剪贴板无内容");
      return;
    }
    saveFieldValue(pid, field, v);
    syncListCellState();
  };
  if (appClipboard) {
    doPaste(appClipboard);
  } else if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard
      .readText()
      .then(doPaste)
      .catch(() => toast("无法读取系统剪贴板"));
  } else {
    toast("剪贴板为空：请先右击「复制」或「剪切」");
  }
}

function syncListCellState() {
  document
    .querySelectorAll("#productListView td.cell-selected")
    .forEach((el) => el.classList.remove("cell-selected"));
  if (selCell) {
    const td = document.querySelector(
      `#productListView td[data-pid="${selCell.pid}"][data-f="${selCell.field}"]`,
    );
    if (td) {
      td.classList.add("cell-selected");
    }
  }
}

function filteredProducts() {
  const st = filters.f_status || "";
  return state.products
    .filter((p) => {
      if (st === "on") {
        return p.status === 0;
      }
      if (st === "off") {
        return p.status === 1;
      }
      return true;
    })
    .filter((p) => {
      for (const key of ["category", "series", "grade"]) {
        const v = filters["f_" + key];
        if (v && cellValue(p, key) !== v) {
          return false;
        }
      }
      return true;
    })
    .filter((p) => {
      for (const key of TEXT_FILTER_FIELDS) {
        const v = filters["f_" + key];
        if (
          v &&
          !cellValue(p, key).toLowerCase().includes(String(v).toLowerCase())
        ) {
          return false;
        }
      }
      return true;
    })
    .filter((p) => {
      for (const key of RANGE_FILTER_FIELDS) {
        const raw = filters["f_" + key];
        if (!raw) {
          continue;
        }
        const [mn, mx] = splitRangeValue(raw);
        if (mn && Number(p[key]) < Number(mn)) {
          return false;
        }
        if (mx && Number(p[key]) > Number(mx)) {
          return false;
        }
      }
      return true;
    })
    .filter((p) => {
      if (
        filters.f_stared &&
        !(state.liveStars && state.liveStars.has(p.code))
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      let r = 0;
      if (sortKey === "code") {
        const ca = String(a.code || "").match(/^([A-Za-z])(\d{1,4})$/);
        const cb = String(b.code || "").match(/^([A-Za-z])(\d{1,4})$/);
        if (ca && cb) {
          const pa = ca[1].toUpperCase();
          const pb = cb[1].toUpperCase();
          r = pa < pb ? -1 : pa > pb ? 1 : Number(ca[2]) - Number(cb[2]);
        } else {
          r = String(a.code || "").localeCompare(String(b.code || ""));
        }
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
  state.lbIdx = 0;
  state.lbPendingCopy = null;
  closeLightbox();
  const lb = document.createElement("div");
  lb.id = "lbBox";
  lb.className = "lightbox";
  lb.innerHTML = `
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
          <div class="thumbs" id="lbThumbs"><span class="muted" style="color:#aaa">图片加载中…</span></div>`;
  lb.addEventListener("click", (e) => {
    if (e.target === lb) {
      closeLightbox();
    }
  });
  document.body.appendChild(lb);
  lb.querySelector("#lbClose").onclick = closeLightbox;
  lb.querySelector("#lbCopy").onclick = () => copyText(fullName(product));
  lb.querySelector("#lbUpload").onclick = () =>
    post({ type: "uploadImages", code: product.code });
  lb.querySelector("#lbClearImg").onclick = async () => {
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

function closeLightbox() {
  const lb = document.getElementById("lbBox");
  if (lb) {
    lb.remove();
  }
}

function filterSig(list) {
  return JSON.stringify({
    len: list.length,
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
  const show = pd.total > 0;
  el.style.display = show ? "" : "none";
  if (!show) {
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

function tableScrollTop() {
  const wrap = document.querySelector("#productListView .table-wrap");
  return wrap ? wrap.scrollTop : 0;
}

function renderProducts() {
  // 列表重渲染前记住内部滚动偏移，渲染后还原——改格子/星标/库存等操作不再被弹回顶部
  const prevScroll = viewMode === "list" ? tableScrollTop() : 0;
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
    $("productGalleryView").style.display = "";
    renderGallery(pd.page);
  } else {
    $("productListView").style.display = "";
    $("productGalleryView").style.display = "none";
    renderList(pd.page);
    const wrap = document.querySelector("#productListView .table-wrap");
    if (wrap) {
      wrap.scrollTop = prevScroll;
    }
  }
  ensureCovers(pd.page);
}

function distinctOptions(key, display) {
  const seen = new Set();
  const opts = [];
  for (const p of state.products) {
    const v = display ? display(p) : p[key];
    if (v && !seen.has(v)) {
      seen.add(v);
      opts.push(v);
    }
  }
  return opts.sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));
}

const NO_FILTER_FIELDS = new Set([
  "soldTotal",
  "netTotal",
  "status",
  "purchase_link",
]);

function filterControl(key) {
  if (NO_FILTER_FIELDS.has(key)) {
    return "";
  }
  const cur = filters["f_" + key] || "";
  const opts = (items) =>
    items
      .map(
        (v) =>
          `<option value="${esc(String(v))}" ${cur === v ? "selected" : ""}>${esc(String(v))}</option>`,
      )
      .join("");
  switch (key) {
    case "category":
    case "grade":
      return `<select class="filter-cell" data-col-f="${key}" title="筛选${key === "grade" ? "等级" : "品类"}"><option value="">全部</option>${opts(
        distinctOptions(key, key === "grade" ? displayGrade : undefined),
      )}</select>`;
    case "cost_price":
    case "sale_price":
    case "stockTotal": {
      const label =
        key === "cost_price" ? "进价" : key === "sale_price" ? "售价" : "库存";
      return `<input class="filter-cell" type="text" data-col-f="${key}" data-fr="range" title="筛选${label}：输入 10~30 表示 10 到 30，也可直接输 10 或 >10 / <30" placeholder="范围" value="${esc(String(filters["f_" + key] || ""))}" />`;
    }
    default:
      return `<input class="filter-cell" data-col-f="${key}" title="筛选${key}" placeholder="筛选" value="${esc(String(cur))}" />`;
  }
}

function renderList(list) {
  const vis = PRODUCT_FIELDS.filter((f) => visList.has(f.key));
  const showImg = showImageList;
  const plIdx = vis.findIndex((f) => f.key === "purchase_link");
  const stIdx = vis.findIndex((f) => f.key === "status");
  const imgAt = showImg
    ? stIdx >= 0
      ? stIdx
      : plIdx >= 0
        ? plIdx
        : vis.length
    : -1;
  const headCols = [];
  const filterCells = [];
  for (let i = 0; i < vis.length; i++) {
    if (i === imgAt) {
      headCols.push(`<th><span class="th-label">图片</span></th>`);
      filterCells.push(`<td></td>`);
    }
    const f = vis[i];
    headCols.push(
      `<th><span class="th-label" data-sort="${f.key}">${f.label}${sortKey === f.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}</span></th>`,
    );
    filterCells.push(`<td>${filterControl(f.key)}</td>`);
  }
  if (imgAt >= vis.length) {
    headCols.push(`<th><span class="th-label">图片</span></th>`);
    filterCells.push(`<td></td>`);
  }
  if (showOpsList) {
    headCols.push(`<th><span class="th-label">操作</span></th>`);
    filterCells.push(`<td></td>`);
  }
  const body = list
    .map((p) => {
      const net = p.soldTotal - p.refundTotal;
      const off = p.status === 1;
      const low = lowStock(p);
      const coverData = state.coverCache[p.code] || "";
      const cover = coverData
        ? `<img class="thumb" data-p-act="img" data-id="${p.id}" src="${coverData}" title="查看大图 · 可拖入或粘贴图片到此" />`
        : `<span class="thumb placeholder" data-p-act="img" data-id="${p.id}" title="查看大图 · 可拖入或粘贴图片到此">无图</span>`;
      const starred = state.liveStars && state.liveStars.has(p.code);
      const tds = [];
      const isSelected = state.selectedProducts.has(p.id);
      tds.push(
        `<td><input type="checkbox" class="product-checkbox" data-id="${p.id}" ${isSelected ? "checked" : ""} title="选择 #${p.code}" /></td>`,
      );
      for (let i = 0; i < vis.length; i++) {
        if (i === imgAt) {
          tds.push(`<td>${cover}</td>`);
        }
        const f = vis[i];
        let v = "";
        let cls = "";
        let tip = "";
        const editable = EDITABLE_FIELDS.has(f.key) ? 'data-edit="1"' : "";
        switch (f.key) {
          case "code":
            v = `<div class="clip-cell" data-p-act="edit" data-id="${p.id}" title="点击打开详情 / 编辑：${esc(p.code)}"><b>${esc(p.code)}</b></div>`;
            cls = "cell-code";
            break;
          case "name":
            v = `<div class="clip-cell" title="${esc(p.name)}">${esc(p.name)}</div>`;
            break;
          case "category":
            v = `<div class="clip-cell" title="${esc(p.category || "")}">${esc(p.category || "")}</div>`;
            break;
          case "series":
            v = `<div class="clip-cell" title="${esc(p.series || "")}">${esc(p.series || "")}</div>`;
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
          case "remark":
            v = esc(p.remark);
            if (p.remark) {
              tip = ` title="${esc(p.remark)}"`;
            }
            break;
        }
        tds.push(
          `<td class="${cls}" data-f="${f.key}" data-pid="${p.id}" ${editable}${tip}>${v}</td>`,
        );
      }
      if (imgAt >= vis.length) {
        tds.push(`<td>${cover}</td>`);
      }
      if (showOpsList) {
        tds.push(`<td>
              <button class="mini-btn" data-s-act="toggle" data-code="${esc(p.code)}" data-id="${p.id}" title="${starred ? "取消星标" : "标记星标（直播排品备选同用）"}">${starred ? "★" : "☆"}</button>
              <button class="mini-btn" data-p-act="copy" data-id="${p.id}" title="复制完整名称">📋</button>
              <button class="mini-btn" data-p-act="stockin" data-id="${p.id}" title="补货入库">📦</button>
              <button class="mini-btn btn-danger" data-p-act="del" data-id="${p.id}" title="删除(含记录)">🗑</button>
            </td>`);
      }
      return `<tr class="${off ? "off " : ""}${low ? "lowstock " : ""}" data-id="${p.id}">${tds.join("")}</tr>`;
    })
    .join("");
  const selectedCount = state.selectedProducts.size;
  const allSelected =
    list.length > 0 && list.every((p) => state.selectedProducts.has(p.id));
  $("productListView").innerHTML =
    list.length === 0 && !hasFilter()
      ? `<p class="muted">（无商品，点「＋ 新建商品」添加；也支持「导入商品」批量粘贴）</p>`
      : `${
          selectedCount > 0
            ? (() => {
                return `<div class="batch-ops" id="batchOpsBar">
<span>已选 <b data-sel-count>${selectedCount}</b> 个商品</span>
<button class="mini-btn" id="batchCopy" title="把选中的商品按当前可见列复制到剪贴板（带表头）">📋 复制选中</button>
<button class="mini-btn batch-menu-btn" id="batchMenuBtn">批量操作 ▾</button>
<button class="mini-btn" id="batchClear" title="取消全部选择">✕ 取消</button>
</div>`;
              })()
            : ""
        }
             <div class="table-wrap"><table class="data-table"><thead><tr>
               <th style="width:30px"><input type="checkbox" id="selectAllProducts" ${list.length === 0 ? "disabled" : ""} ${allSelected ? "checked" : ""} title="全选 / 取消全选" /></th>
               ${headCols.join("")}
             </tr><tr class="filter-row">
               <td></td>
               ${filterCells.join("")}
             </tr></thead><tbody>${body}</tbody></table></div>`;
  bindBatchOps();
  bindColFilters();
  syncListCellState();
}

function splitRangeValue(raw) {
  const s = String(raw || "").trim();
  if (!s) {
    return ["", ""];
  }
  if (s.startsWith(">")) {
    return [s.slice(1).trim(), ""];
  }
  if (s.startsWith("<")) {
    return ["", s.slice(1).trim()];
  }
  const parts = s
    .split(/[~～\-—到,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return [parts[0] || "", parts[1] || ""];
}

function bindColFilters() {
  document.querySelectorAll("[data-col-f]").forEach((el) => {
    const key = el.dataset.colF;
    const fr = el.dataset.fr;
    const apply = () => {
      const v = el.value;
      const fieldKey = fr === "range" ? key : fr ? key + "_" + fr : key;
      if (String(v).trim()) {
        filters["f_" + fieldKey] = v;
      } else {
        delete filters["f_" + fieldKey];
      }
      syncClearFilterBtn();
      if (el.tagName === "SELECT") {
        renderProducts();
        return;
      }
      const pos =
        typeof el.selectionStart === "number"
          ? el.selectionStart
          : el.value.length;
      renderProducts();
      const nf = document.querySelector(
        `[data-col-f="${key}"]${fr ? `[data-fr="${fr}"]` : ""}`,
      );
      if (nf) {
        nf.focus();
        try {
          nf.setSelectionRange(pos, pos);
        } catch {
          /* 忽略 */
        }
      }
    };
    if (el.tagName === "SELECT") {
      el.onchange = apply;
    } else {
      el.oninput = debounce(apply, 150);
    }
  });
}

function hasFilter() {
  return Object.values(filters).some((v) => String(v).trim().length > 0);
}

function syncClearFilterBtn() {
  const clear = $("clearFilterBtn");
  if (clear) {
    clear.style.display = hasFilter() ? "" : "none";
  }
}

function updateSelectionUI() {
  const selAll = $("selectAllProducts");
  if (selAll) {
    const cbs = document.querySelectorAll(".product-checkbox");
    selAll.checked = cbs.length > 0 && Array.from(cbs).every((c) => c.checked);
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

  const batchCopy = $("batchCopy");
  if (batchCopy) {
    batchCopy.onclick = copySelectedProducts;
  }

  const batchClear = $("batchClear");
  if (batchClear) {
    batchClear.onclick = () => {
      state.selectedProducts.clear();
      renderProducts();
    };
  }

  const batchMenuBtn = $("batchMenuBtn");
  if (batchMenuBtn) {
    batchMenuBtn.onclick = (ev) => {
      ev.stopPropagation();
      const old = document.getElementById("batchDropdown");
      if (old) { old.remove(); return; }
      const items = [
        { label: "上架", run: () => batchSetStatus(0) },
        { label: "下架", run: () => batchSetStatus(1) },
        { label: "标星", run: () => setStarsForSelected(true) },
        { label: "取消星标", run: () => setStarsForSelected(false) },
        { sep: true },
        { label: "改等级", run: batchSetGrade },
        { label: "改采购链接", run: batchSetLink },
        { label: "改库存", run: batchSetStock },
        { label: "删除", danger: true, run: batchDelete },
      ];
      const rect = batchMenuBtn.getBoundingClientRect();
      const menu = document.createElement("div");
      menu.id = "batchDropdown";
      menu.className = "batch-dropdown";
      menu.innerHTML = items.map((it, i) => {
        if (it.sep) return '<div class="batch-dd-sep"></div>';
        return '<div class="batch-dd-item' + (it.danger ? ' batch-dd-danger' : '') + '" data-bi="' + i + '">' + it.label + '</div>';
      }).join("");
      menu.style.left = rect.left + "px";
      menu.style.top = rect.bottom + 4 + "px";
      document.body.appendChild(menu);
      const close = () => { menu.remove(); window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
      const onDown = (ev) => { if (!menu.contains(ev.target)) close(); };
      const onKey = (ev) => { if (ev.key === "Escape") close(); };
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      menu.querySelectorAll("[data-bi]").forEach((el) => {
        el.onclick = () => { close(); items[Number(el.dataset.bi)].run(); };
      });
    };
  }

  const batchSetStatus = (status) => {
    if (state.selectedProducts.size === 0) return;
    const n = state.selectedProducts.size;
    post({ type: "setProductsStatus", ids: [...state.selectedProducts], status });
    const hiddenVal = status === 0 ? "off" : "on";
    if (filters.f_status === hiddenVal) {
      delete filters.f_status;
      const fs = $("filterStatus");
      if (fs) fs.value = "";
    }
    toast("✅已" + (status === 0 ? "上架" : "下架") + " " + n + " 个商品");
    renderProducts();
  };

  const batchDelete = () => {
    if (state.selectedProducts.size === 0) return;
    confirmBox("确认删除选中的 " + state.selectedProducts.size + " 个商品？\n将同时删除它们的销售记录和入库记录，且不可恢复！").then((ok) => {
      if (ok) {
        post({ type: "deleteProducts", ids: [...state.selectedProducts] });
        state.selectedProducts.clear();
      }
    });
  };

  const batchSetStock = () => {
    const n = state.selectedProducts.size;
    if (n === 0) return;
    const mask = showModal(`
      <h3>批量改库存</h3>
      <p class="muted">将修改选中的 <b>${n}</b> 个商品（可用 ↩ 撤销）。</p>
      <div class="rows" style="margin-top:12px">
        <div class="field">
          <label>方式</label>
          <select id="bssMode">
            <option value="set">设为固定值</option>
            <option value="add">在现有基础上增加</option>
            <option value="sub">在现有基础上减少</option>
          </select>
        </div>
        <div class="field">
          <label>数量</label>
          <input id="bssQty" type="number" min="0" step="1" value="0" style="width:120px" />
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button data-bss="cancel">取消</button>
        <button data-bss="ok" class="btn-teal">确定</button>
      </div>`);
    const qtyInput = mask.querySelector("#bssQty");
    qtyInput.focus();
    qtyInput.select();
    const submit = () => {
      const mode = mask.querySelector("#bssMode").value;
      const q = Math.floor(Number(qtyInput.value || 0));
      if (!Number.isInteger(q) || q < 0) {
        toast("数量需为非负整数");
        return;
      }
      closeModal();
      post({ type: "setProductsStock", ids: [...state.selectedProducts], mode, qty: q });
      const label = mode === "add" ? `增加 ${q}` : mode === "sub" ? `减少 ${q}` : `设为 ${q}`;
      toast(`✅已提交批量改库存（${label}）× ${n}`);
    };
    mask.querySelector('[data-bss="ok"]').onclick = submit;
    mask.querySelector('[data-bss="cancel"]').onclick = closeModal;
    qtyInput.onkeydown = (ev) => {
      if (ev.key === "Enter") submit();
    };
  };

  const batchSetGrade = () => {
    const n = state.selectedProducts.size;
    if (n === 0) return;
    const mask = showModal(`
      <h3>批量改等级（${n} 个商品）</h3>
      <p class="muted">将修改选中的 <b>${n}</b> 个商品，售价按所选等级规则重算（可用 ↩ 撤销）。</p>
      <div class="rows" style="margin-top:12px">
        <div class="field">
          <label>等级</label>
          <select id="bsgGrade">
            <option value="0">自定义（不按公式自动算）</option>
            ${state.rules.map((r) => `<option value="${r.grade}">${esc(gradeLabel(r.grade))}</option>`).join("")}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button data-bsg="cancel">取消</button>
        <button data-bsg="ok" class="btn-teal">确定</button>
      </div>`);
    const submit = () => {
      const grade = Number(mask.querySelector("#bsgGrade").value);
      closeModal();
      post({ type: "setProductsField", ids: [...state.selectedProducts], field: "grade", value: grade });
      toast(`✅已提交批量改等级 × ${n}`);
    };
    mask.querySelector('[data-bsg="ok"]').onclick = submit;
    mask.querySelector('[data-bsg="cancel"]').onclick = closeModal;
  };

  const batchSetLink = () => {
    const n = state.selectedProducts.size;
    if (n === 0) return;
    const mask = showModal(`
      <h3>批量改采购链接（${n} 个商品）</h3>
      <p class="muted">将写入所选商品的「采购链接」（可用 ↩ 撤销）；<br>留空提交 = 清空所有选中商品的链接。</p>
      <input id="bslLink" type="text" placeholder="https://…" style="width:100%;box-sizing:border-box;margin-top:8px" />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button data-bsl="cancel">取消</button>
        <button data-bsl="ok" class="btn-teal">确定</button>
      </div>`);
    const input = mask.querySelector("#bslLink");
    input.focus();
    const submit = () => {
      const res = sanitizeProductField("purchase_link", input.value);
      if (!res.ok) {
        toast(res.msg);
        return;
      }
      closeModal();
      post({ type: "setProductsField", ids: [...state.selectedProducts], field: "purchase_link", value: res.value });
      toast(`✅已提交批量改采购链接 × ${n}`);
    };
    mask.querySelector('[data-bsl="ok"]').onclick = submit;
    mask.querySelector('[data-bsl="cancel"]').onclick = closeModal;
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") submit();
    };
  };
}

function copySelectedProducts() {
  const rows = state.products.filter((p) => state.selectedProducts.has(p.id));
  if (rows.length === 0) {
    toast("先勾选要复制的商品");
    return;
  }
  const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => visList.has(k));
  const lines = [
    keys.map((k) => PRODUCT_FIELDS.find((f) => f.key === k).label).join("\t"),
  ];
  for (const row of rows) {
    lines.push(keys.map((k) => cellValue(row, k)).join("\t"));
  }
  copyText(lines.join("\n"), `已复制 ${rows.length} 行到剪贴板 ✅`);
}

// 复制全部星标商品（不依赖当前勾选/筛选），列跟随列表可见列
function copyStarList() {
  const stars = state.liveStars ? [...state.liveStars] : [];
  const rows = state.products
    .filter((p) => stars.includes(p.code))
    .sort(
      (a, b) =>
        Number(a.code.replace(/^\D+/, "")) - Number(b.code.replace(/^\D+/, "")),
    );
  if (rows.length === 0) {
    toast("还没有打星标的商品（列表/画册点 ⭐ 标记）");
    return;
  }
  const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => visList.has(k));
  const lines = [
    keys.map((k) => PRODUCT_FIELDS.find((f) => f.key === k).label).join("\t"),
  ];
  for (const row of rows) {
    lines.push(keys.map((k) => cellValue(row, k)).join("\t"));
  }
  copyText(lines.join("\n"), `已复制 ${rows.length} 个星标商品到剪贴板 ✅`);
}

// 显式把某商品设为/取消星标（右键菜单用；按钮点按仍走 toggleLiveStar 翻转）
// 取消全部星标（列表右键、⭐ 星标 ▾ 子菜单共用）
function clearAllStars() {
  confirmBox("确认取消全部商品的星标？").then((ok) => {
    if (!ok) {
      return;
    }
    if (state.liveStars) {
      state.liveStars = new Set();
    }
    delete filters.f_stared;
    syncClearFilterBtn();
    post({ type: "clearLiveStars" });
    renderProducts();
  });
}

// ⭐ 星标 ▾ 下拉：工具栏只保留一个入口（复用图片右键菜单组件）
function showStarMenu(btn) {
  const rect = btn.getBoundingClientRect();
  const starOnlyOn = !!filters.f_stared;
  const starCount = state.liveStars ? state.liveStars.size : 0;
  showImageCtxMenu(rect.left, rect.bottom, [
    {
      label: `${starOnlyOn ? "✓ " : ""}只看星标（${starCount} 个）`,
      run: toggleStarOnly,
    },
    { label: "复制星标清单", run: () => copyStarList() },
    { label: "生成星标总览图", run: () => post({ type: "previewStarOverview" }) },
    { sep: true },
    { label: "取消全部星标", run: () => clearAllStars(), danger: true },
  ]);
}

function toggleStarOnly() {
  if (filters.f_stared) {
    delete filters.f_stared;
  } else {
    filters.f_stared = "1";
  }
  syncClearFilterBtn();
  renderProducts();
}

// 批量栏：把勾选商品全部标记/取消星标（本地 Set + setLiveStars 持久化）
function setStarsForSelected(on) {
  const codes = state.products
    .filter((p) => state.selectedProducts.has(p.id))
    .map((p) => p.code);
  if (codes.length === 0) {
    toast("先勾选要操作的商品");
    return;
  }
  if (!state.liveStars) {
    state.liveStars = new Set();
  }
  const set = new Set(state.liveStars);
  for (const c of codes) {
    if (on) {
      set.add(c);
    } else {
      set.delete(c);
    }
  }
  state.liveStars = set;
  post({ type: "setLiveStars", codes: [...set] });
  renderProducts();
  toast(
    on
      ? `已标记 ${codes.length} 个商品星标 ✅`
      : `已取消 ${codes.length} 个商品星标`,
  );
}

// ===== 星标总览图「先预览，点生成才落盘」 =====
var starOv = {
  mask: null,
  idx: 0,
  previews: [],
  pageCount: 1,
  total: 0,
  generating: false,
  reloading: false,
  pending: -1,
  token: 0,
  cols: 0,
  rows: 0,
  lastDir: "",
  labels: { code: true, costPrice: false, salePrice: true, fontSize: 0 },
  _fsTimer: null,
};

const STAR_GRID_PRESETS = [
  ["0", "自动（智能）"],
  ["3x3", "3 × 3"],
  ["4x3", "4 × 3"],
  ["3x4", "3 × 4"],
  ["4x4", "4 × 4"],
  ["5x5", "5 × 5"],
];

// 星标图上标注的字号预设：0＝随格子自动（推荐）；其余为格子坐标系固定像素
const STAR_FONT_PRESETS = [
  ["0", "自动（推荐）"],
  ["9", "9%"],
  ["12", "12%"],
  ["16", "16%"],
  ["20", "20%"],
  ["24", "24%"],
];

function starOvDims() {
  const sel = starOv.mask.querySelector("[data-so-grid]");
  if (sel && sel.value === "custom") {
    const c = parseInt(starOv.mask.querySelector("[data-so-cc]").value || "0", 10);
    const r = parseInt(starOv.mask.querySelector("[data-so-cr]").value || "0", 10);
    return {
      cols: Number.isFinite(c) ? Math.min(10, Math.max(1, c)) : 0,
      rows: Number.isFinite(r) ? Math.min(10, Math.max(1, r)) : 0,
    };
  }
  if (sel && sel.value && sel.value !== "0") {
    const [c, r] = sel.value.split("x").map((x) => parseInt(x, 10));
    return { cols: c || 0, rows: r || 0 };
  }
  return { cols: 0, rows: 0 };
}

function starOvDimsLabel(d) {
  if (!d || !d.cols || !d.rows) {
    return "自动方阵";
  }
  return `${d.rows} 行 × ${d.cols} 列`;
}

function starOvSyncGrid() {
  const mask = starOv.mask;
  const sel = mask.querySelector("[data-so-grid]");
  const cc = mask.querySelector("[data-so-cc]");
  const cr = mask.querySelector("[data-so-cr]");
  const cust = mask.querySelector("[data-so-cust]");
  const key = starOv.cols && starOv.rows ? `${starOv.cols}x${starOv.rows}` : "0";
  const preset = sel.querySelector(`option[value="${key}"]`);
  if (preset) {
    sel.value = key;
    cust.style.display = "none";
  } else {
    sel.value = "custom";
    cr.value = starOv.rows || 1;
    cc.value = starOv.cols || 1;
    cust.style.display = "inline-flex";
  }
}

function starOvSetEnabled(on) {
  if (!starOv.mask) {
    return;
  }
  const q = (s) => starOv.mask.querySelector(s);
  ["[data-so-grid]", "[data-so-cc]", "[data-so-cr]", "[data-so-prev]", "[data-so-next]", "[data-so-gen]"].forEach((s) => {
    const el = q(s);
    if (el) {
      el.disabled = !on;
    }
  });
}

// 图片区遮罩：半透明 + 转圈 + 文案，渲染期间盖住旧图
function starOvLoading(msg) {
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const lo = starOv.mask.querySelector("[data-so-loading]");
  const txt = starOv.mask.querySelector("[data-so-msg]");
  if (lo) {
    lo.style.display = "flex";
  }
  if (txt) {
    txt.textContent = msg || "正在渲染预览…";
  }
}

function starOvUnloading() {
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const lo = starOv.mask.querySelector("[data-so-loading]");
  if (lo) {
    lo.style.display = "none";
  }
}

// 改排版/标注/字号后自动重预览（防抖 700ms）
function starOvScheduleRefresh() {
  if (starOv._fsTimer) {
    clearTimeout(starOv._fsTimer);
  }
  starOv._fsTimer = setTimeout(() => {
    if (!starOv.mask || !starOv.mask.isConnected) {
      return;
    }
    if (starOv.generating || starOv.reloading) {
      return;
    }
    starOvRequestPreview();
  }, 700);
}

function starOvRequestPreview() {
  if (starOv.generating || starOv.reloading) {
    return;
  }
  const d = starOvDims();
  if ((d.cols && !d.rows) || (!d.cols && d.rows)) {
    toast("自定义排版要同时填「行」和「列」");
    return;
  }
  starOv.reloading = true;
  starOv.pending = -1;
  starOv.previews = [];
  starOvSetEnabled(false);
  // 第一次打开：先弹窗占位（遮罩可见），出图后再填；已开弹窗：遮罩盖旧图
  if (!starOv.mask || !starOv.mask.isConnected) {
    starOvOpenMask("⭐ 星标总览图（加载中…）");
  }
  starOvLoading(`正在按「${starOvDimsLabel(d)}」排版第 1 张…`);
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    status.style.display = "none";
  }
  post({ type: "previewStarOverview", cols: d.cols || 0, rows: d.rows || 0, labels: starOv.labels });
}

function starOvFrame() {
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const n = Math.max(1, starOv.pageCount);
  const img = starOv.mask.querySelector("[data-so-img]");
  const cap = starOv.mask.querySelector("[data-so-cap]");
  const ctr = starOv.mask.querySelector("[data-so-ctr]");
  const prev = starOv.mask.querySelector("[data-so-prev]");
  const next = starOv.mask.querySelector("[data-so-next]");
  if (ctr) {
    ctr.textContent = `${starOv.idx + 1} / ${n}`;
  }
  if (prev) {
    prev.disabled = starOv.idx === 0;
  }
  if (next) {
    next.disabled = starOv.idx >= n - 1;
  }
  const p = starOv.previews[starOv.idx];
  if (p) {
    starOvUnloading();
    if (img) {
      img.src = p.data;
    }
    if (cap) {
      cap.textContent = p.name;
    }
  } else {
    img.removeAttribute("src");
    if (cap) {
      cap.textContent = "";
    }
    starOvLoadPage(starOv.idx);
  }
}

// 按需渲染某一页：翻页到没出过的页才请求，回来后缓存；陈旧响应按 token 丢弃
function starOvLoadPage(idx) {
  if (starOv.reloading || starOv.generating || starOv.pending === idx) {
    return;
  }
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  starOv.pending = idx;
  const token = ++starOv.token;
  starOvLoading(`正在出第 ${idx + 1} 张预览…`);
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    status.style.display = "none";
  }
  const d = starOvDims();
  post({
    type: "renderStarOverviewPage",
    page: idx,
    cols: d.cols || 0,
    rows: d.rows || 0,
    labels: starOv.labels,
    token,
  });
}

function starOvOnPagePreview(msg) {
  if (starOv.reloading || starOv.generating) {
    return;
  }
  const token = Number(msg.token ?? -1);
  if (token !== starOv.token) {
    return; // 陈旧响应（换排版/标注后翻页的旧图）
  }
  const page = Number(msg.page ?? starOv.pending);
  if (starOv.pending === page) {
    starOv.pending = -1;
  }
  if (msg.error) {
    starOvUnloading();
    const img = starOv.mask.querySelector("[data-so-img]");
    if (img) {
      img.removeAttribute("src");
    }
    const cap = starOv.mask.querySelector("[data-so-cap]");
    if (cap) {
      cap.textContent = `第 ${page + 1} 张渲染失败：${msg.error}（再点「下一张/上一张」可重试）`;
    }
    starOvSetEnabled(true);
    return;
  }
  if (msg.preview) {
    starOv.previews[page] = { name: String(msg.preview.name || ""), data: String(msg.preview.data || "") };
  }
  starOvFrame();
}

function starOvOpenMask(title) {
  closeModal();
  // 加载保存的标注选项
  try {
    const saved = JSON.parse(state.settings.star_label_options || "{}");
    if (saved.code !== undefined) starOv.labels.code = saved.code;
    if (saved.costPrice !== undefined) starOv.labels.costPrice = saved.costPrice;
    if (saved.salePrice !== undefined) starOv.labels.salePrice = saved.salePrice;
    if (saved.fontSize !== undefined) starOv.labels.fontSize = Number(saved.fontSize) || 0;
  } catch { /* 忽略 */ }
  const L = starOv.labels;
  const mask = showModal(`
    <h3 data-so-title>${title || `⭐ 星标总览图（${starOv.total} 款 · ${starOv.pageCount} 张 · ${starOvDimsLabel(starOv)}）`}</h3>
    <div class="muted" style="margin-bottom:6px">预览未落盘——满意后点「✅ 生成」才写入输出目录。</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
      <span class="muted">每张排版</span>
      <select data-so-grid style="min-width:110px">
        ${STAR_GRID_PRESETS.map(
          ([v, t]) => `<option value="${v}">${t}</option>`,
        ).join("")}
        <option value="custom">自定义…</option>
      </select>
      <span data-so-cust style="display:none;align-items:center;gap:4px" class="muted">
        <input data-so-cr type="number" min="1" max="10" style="width:56px" title="行数" />行
        × <input data-so-cc type="number" min="1" max="10" style="width:56px" title="列数" />列
      </span>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
      <span class="muted">图上标注</span>
      <label class="io-chip"><input type="checkbox" data-so-lbl="code" ${L.code ? "checked" : ""} />编号</label>
      <label class="io-chip"><input type="checkbox" data-so-lbl="costPrice" ${L.costPrice ? "checked" : ""} />进价</label>
      <label class="io-chip"><input type="checkbox" data-so-lbl="salePrice" ${L.salePrice ? "checked" : ""} />售价</label>
      <span class="muted" style="margin-left:8px">字号</span>
      <select data-so-fs title="标注文字大小＝占格子边长的百分比；预览与生成相对比例一致（推荐「自动」）">
        ${STAR_FONT_PRESETS.map(
          ([v, t]) => `<option value="${v}">${t}</option>`,
        ).join("")}
      </select>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <button data-so-prev class="mini-btn">‹ 上一张</button>
      <span data-so-ctr style="min-width:44px;text-align:center"></span>
      <button data-so-next class="mini-btn">下一张 ›</button>
    </div>
    <div data-so-status class="muted" style="display:none;margin-bottom:4px"></div>
    <div style="text-align:center">
      <div data-so-imgwrap style="position:relative;display:inline-block;line-height:0">
        <div data-so-loading style="display:none;position:absolute;inset:0;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(0,0,0,.35);z-index:5;border:1px solid var(--vscode-panel-border);border-radius:4px;min-width:320px;min-height:120px">
          <div class="so-spinner"></div>
          <div data-so-msg class="muted" style="color:#fff"></div>
        </div>
        <img data-so-img style="max-width:min(720px,86vw);max-height:62vh;border:1px solid var(--vscode-panel-border);border-radius:4px" />
      </div>
      <div data-so-cap class="muted" style="margin-top:4px;font-size:12px"></div>
    </div>
    <div data-so-footer style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button data-so-close>关闭</button>
      <button data-so-gen class="btn-teal">✅ 生成</button>
    </div>`);
  starOv.mask = mask;
  starOvSyncGrid();
  mask.querySelector("[data-so-grid]").onchange = () => {
    const cust = mask.querySelector("[data-so-cust]");
    if (mask.querySelector("[data-so-grid]").value === "custom") {
      cust.style.display = "inline-flex";
    } else {
      cust.style.display = "none";
    }
    starOvScheduleRefresh();
  };
  mask.querySelector("[data-so-cr]").onchange = () => {
    starOvScheduleRefresh();
  };
  mask.querySelector("[data-so-cc]").onchange = () => {
    starOvScheduleRefresh();
  };
  mask.querySelectorAll("[data-so-lbl]").forEach((el) => {
    el.onchange = () => {
      starOv.labels.code = mask.querySelector("[data-so-lbl='code']").checked;
      starOv.labels.costPrice = mask.querySelector("[data-so-lbl='costPrice']").checked;
      starOv.labels.salePrice = mask.querySelector("[data-so-lbl='salePrice']").checked;
      starOvScheduleRefresh();
    };
  });
  const fsSel = mask.querySelector("[data-so-fs]");
  fsSel.value = String(starOv.labels.fontSize || 0);
  if (fsSel.selectedIndex === -1) {
    // 旧版本保存的固定像素值已不适用百分比预设 → 回退自动
    starOv.labels.fontSize = 0;
    fsSel.value = "0";
  }
  fsSel.onchange = () => {
    starOv.labels.fontSize = parseInt(fsSel.value || "0", 10) || 0;
    starOvScheduleRefresh();
  };
  mask.querySelector("[data-so-prev]").onclick = () => {
    if (starOv.generating || starOv.reloading) {
      return;
    }
    starOv.idx = Math.max(0, starOv.idx - 1);
    starOvFrame();
  };
  mask.querySelector("[data-so-next]").onclick = () => {
    if (starOv.generating || starOv.reloading) {
      return;
    }
    starOv.idx = Math.min(starOv.pageCount - 1, starOv.idx + 1);
    starOvFrame();
  };
  mask.querySelector("[data-so-close]").onclick = () => closeModal();
  starOvShowFooter(mask);
  starOvFrame();
}

function showStarOverviewPreview(msg) {
  const previews = Array.isArray(msg.previews) ? msg.previews : [];
  const total = Number(msg.total || 0);
  const pageCount = Math.max(1, Number(msg.pageCount ?? 0));
  // 换排版/标注：作废所有在途翻页响应
  starOv.token++;
  starOv.reloading = false;
  starOv.pending = -1;
  starOv.generating = false;
  starOv.total = total;
  starOv.pageCount = pageCount;
  starOv.cols = Number(msg.cols || 0);
  starOv.rows = Number(msg.rows || 0);
  starOv.previews = new Array(pageCount);
  starOv.idx = Math.min(starOv.idx, pageCount - 1);
  if (!starOv.mask || !starOv.mask.isConnected) {
    starOv.idx = 0;
    starOvOpenMask(`⭐ 星标总览图（${total} 款 · ${pageCount} 张 · ${starOvDimsLabel(msg)}）`);
  }
  const h3 = starOv.mask.querySelector("[data-so-title]");
  if (h3) {
    h3.textContent = `⭐ 星标总览图（${total} 款 · ${pageCount} 张 · ${starOvDimsLabel(msg)}）`;
  }
  starOvSyncGrid();
  starOvSetEnabled(true);
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    status.style.display = "none";
  }
  const img = starOv.mask.querySelector("[data-so-img]");
  const cap = starOv.mask.querySelector("[data-so-cap]");
  starOvUnloading();
  if (total === 0) {
    if (img) {
      img.removeAttribute("src");
    }
    if (cap) {
      cap.textContent = "当前没有星标商品，去商品列表 ⭐ 标记后再来";
    }
    toast("没有星标商品可预览（先去 ⭐ 标记）");
    return;
  }
  if (previews.length === 0) {
    // 第 1 张渲染失败（同排版其余页大概率一样）
    if (img) {
      img.removeAttribute("src");
    }
    if (cap) {
      cap.textContent = "第 1 张预览失败，可调整排版/标注后自动重试";
    }
    return;
  }
  starOv.previews[0] = previews[0];
  starOvFrame();
}

function starOvGenerate() {
  if (starOv.generating || starOv.reloading) {
    return;
  }
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const d = starOvDims();
  if ((d.cols && !d.rows) || (!d.cols && d.rows)) {
    toast("自定义排版要同时填「行」和「列」");
    return;
  }
  starOv.generating = true;
  const footer = starOv.mask.querySelector("[data-so-footer]");
  footer.innerHTML =
    `<div class="muted" style="align-self:center;margin-right:auto">正在生成…（请选择输出目录）</div>` +
    `<button data-so-close>取消</button>`;
  footer.querySelector("[data-so-close]").onclick = () => closeModal();
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    status.style.display = "none";
  }
  post({ type: "generateStarOverview", cols: d.cols || 0, rows: d.rows || 0, labels: starOv.labels });
}

function starOvShowFooter(mask) {
  const footer = mask.querySelector("[data-so-footer]");
  footer.innerHTML =
    `<button data-so-close>关闭</button>` +
    `<button data-so-gen class="btn-teal">✅ 生成</button>`;
  footer.querySelector("[data-so-close]").onclick = () => closeModal();
  footer.querySelector("[data-so-gen]").onclick = starOvGenerate;
}

function onStarOverviewCancelled() {
  starOv.generating = false;
  starOv.reloading = false;
  if (starOv.mask && starOv.mask.isConnected) {
    const status = starOv.mask.querySelector("[data-so-status]");
    if (status) {
      status.textContent = "已取消生成，可再次生成";
      status.style.display = "";
    }
    starOvShowFooter(starOv.mask);
  }
}

// 生成进度：服务端每张写消息时回发一条，界面实时显示，避免误以为卡死
function starOvOnProgress(msg) {
  if (!starOv.mask || !starOv.mask.isConnected) {
    return;
  }
  const status = starOv.mask.querySelector("[data-so-status]");
  if (status) {
    const total = Number(msg.total || 0);
    const page = Number(msg.page || 0);
    const name = String(msg.name || "");
    const ok = msg.ok !== false;
    if (!ok) {
      status.textContent = `第 ${page} / ${total} 张生成失败已跳过（${name}）`;
    } else if (page <= 0) {
      status.textContent = total > 0 ? `正在生成…共 ${total} 张` : "正在生成…";
    } else {
      status.textContent = `正在生成第 ${page} / ${total} 张…`;
    }
    status.style.display = "";
  }
  const footer = starOv.mask.querySelector("[data-so-footer]");
  if (footer) {
    const div = footer.querySelector('[style*="align-self:center"]');
    if (div && div.textContent.indexOf("请选择输出目录") !== -1) {
      div.textContent = "正在生成…";
    }
  }
}

function onStarOverviewDone(msg) {
  const dir = String(msg.dir || "");
  const count = Number(msg.count || 0);
  starOv.lastDir = dir;
  if (starOv.mask && starOv.mask.isConnected) {
    starOv.generating = false;
    starOv.reloading = false;
    const footer = starOv.mask.querySelector("[data-so-footer]");
    if (footer) {
      footer.innerHTML =
        `<div class="muted" style="align-self:center;margin-right:auto">已生成 ${count} 张 → ${esc(dir)}</div>` +
        `<button data-so-open title="在系统文件管理器中打开输出目录">📂 打开文件夹</button>` +
        `<button data-so-close class="btn-teal">完成</button>`;
      footer.querySelector("[data-so-open]").onclick = () =>
        post({ type: "openStarOutDir", dir: starOv.lastDir });
      footer.querySelector("[data-so-close]").onclick = () => closeModal();
    }
  } else {
    toast(`已生成 ${count} 张星标总览图 → ${dir}`);
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
                  <button class="star ${starred ? "on" : ""}" data-s-act="toggle" data-code="${esc(p.code)}" data-id="${p.id}" title="${starred ? "取消星标" : "标记星标（直播排品备选同用）"}">${starred ? "★" : "☆"}</button>
                  <span class="card-badge ${off ? "off" : ""}">${off ? "已下架" : p.code}</span>
                  ${showImageGallery ? (coverData ? `<img src="${coverData}" />` : `<div class="ph">暂无图片</div>`) : ""}
                  <div class="card-body">${lines}</div>
                  <button class="edit-btn" data-p-act="edit" data-id="${p.id}" title="打开详情 / 编辑">编辑</button>
                </div>`;
          })
          .join("")}</div>`;
}

function stateProduct(code) {
  return state.products.find((p) => p.code === code);
}

// ─── 商品详情抽屉（画册「编辑」按钮 / 列表点名称共用）作者：字段改动即存 ───
const DRAWER_GROUPS = [
  { title: "① 商品档案", keys: ["code", "name", "category", "series", "grade"] },
  { title: "② 价格与销售", keys: ["cost_price", "sale_price", "stockTotal", "soldTotal", "netTotal"] },
  { title: "③ 状态与辅助", keys: ["status", "purchase_link", "remark"] },
];
// 抽屉里可编辑的字段（status 走 setStatus，其余走 saveFieldValue）
const DRAWER_EDITABLE = new Set([...EDITABLE_FIELDS, "status"]);
let drawerPid = 0;
let drawerKeyHandler = null;

function fieldLabel(key) {
  const f = PRODUCT_FIELDS.find((x) => x.key === key);
  return f ? f.label : key;
}

function openProductDrawer(product) {
  if (!product) {
    return;
  }
  drawerPid = product.id;
  const mask = $("drawerBackdrop");
  const box = $("productDrawer");
  if (mask) {
    mask.style.display = "";
  }
  if (box) {
    box.style.display = "";
  }
  if (!drawerKeyHandler) {
    drawerKeyHandler = (e) => {
      if (e.key !== "Escape" || !drawerPid) {
        return;
      }
      // 有模态框/大图灯箱时，先让它们各自处理 Esc，不连带关掉抽屉
      if (document.getElementById("dynModalMask") || document.getElementById("lbBox")) {
        return;
      }
      closeProductDrawer();
    };
    document.addEventListener("keydown", drawerKeyHandler);
  }
  renderProductDrawer();
}

function closeProductDrawer() {
  drawerPid = 0;
  const mask = $("drawerBackdrop");
  const box = $("productDrawer");
  if (mask) {
    mask.style.display = "none";
  }
  if (box) {
    box.style.display = "none";
    box.innerHTML = "";
  }
}

function drawerFieldValue(p, key) {
  switch (key) {
    case "grade":
      return esc(displayGrade(p));
    case "cost_price":
    case "sale_price":
      return `¥${money(p[key])}`;
    case "stockTotal":
      return qty(p.stockTotal || 0);
    case "soldTotal":
      return qty(p.soldTotal || 0);
    case "netTotal":
      return qty(p.soldTotal - p.refundTotal);
    case "purchase_link":
      return p.purchase_link
        ? `<a href="${esc(p.purchase_link)}" target="_blank">打开</a>`
        : "";
    case "status":
      return `<span class="badge ${p.status === 1 ? "badge-off" : "badge-on"}">${p.status === 1 ? "已下架" : "在售"}</span>`;
    default:
      return esc(p[key] ?? "");
  }
}

function drawerControl(p, key) {
  if (key === "grade") {
    return `<select class="d-field" data-d-f="grade" data-id="${p.id}">
      <option value="0" ${p.price_manual === 1 ? "selected" : ""}>自定义（不按公式自动算）</option>
      ${state.rules
        .map(
          (r) =>
            `<option value="${r.grade}" ${p.price_manual !== 1 && r.grade === p.grade ? "selected" : ""}>${esc(gradeLabel(r.grade))}</option>`,
        )
        .join("")}
    </select>`;
  }
  if (key === "status") {
    return `<select class="d-field" data-d-f="status" data-id="${p.id}">
      <option value="0" ${p.status === 0 ? "selected" : ""}>在售</option>
      <option value="1" ${p.status === 1 ? "selected" : ""}>已下架</option>
    </select>`;
  }
  if (key === "cost_price" || key === "sale_price") {
    return `<input class="d-field" data-d-f="${key}" data-id="${p.id}" type="text" inputmode="decimal" value="${esc(String(p[key] ?? ""))}" />`;
  }
  if (key === "stockTotal") {
    return `<input class="d-field" data-d-f="stockTotal" data-id="${p.id}" type="number" min="0" step="1" value="${p.stockTotal || 0}" />`;
  }
  if (key === "remark") {
    return `<textarea class="d-field" data-d-f="remark" data-id="${p.id}" rows="2" spellcheck="false">${esc(p.remark || "")}</textarea>`;
  }
  const attrs =
    key === "category"
      ? ` list="shopCatList" maxlength="50"`
      : key === "name"
        ? ` maxlength="100"`
        : key === "series"
          ? ` maxlength="50"`
          : key === "purchase_link"
            ? ` maxlength="500"`
            : "";
  return `<input class="d-field" data-d-f="${key}" data-id="${p.id}"${attrs} value="${esc(String(p[key] ?? ""))}" />`;
}

function renderProductDrawer() {
  const box = $("productDrawer");
  if (!box || !drawerPid) {
    return;
  }
  const p = state.products.find((x) => x.id === drawerPid);
  if (!p) {
    closeProductDrawer();
    return;
  }
  // 重绘前记住焦点字段，重绘后恢复：避免「改一个存一个」数据回推时抢走焦点
  const active = document.activeElement;
  const activeKey =
    active && box.contains(active) ? active.dataset.dF || null : null;
  const off = p.status === 1;
  const groups = DRAWER_GROUPS.map(
    (g) =>
      `<div class="d-group-title">${g.title}</div><div class="d-form">` +
      g.keys
        .map((k) =>
          DRAWER_EDITABLE.has(k)
            ? `<label>${fieldLabel(k)}</label>${drawerControl(p, k)}`
            : `<label>${fieldLabel(k)}</label><div class="d-f-val">${drawerFieldValue(p, k)}</div>`,
        )
        .join("") +
      `</div>`,
  ).join("");
  box.innerHTML = `
    <div class="d-head">
      <div>
        <div class="d-title"><b>${esc(p.code)}</b>${esc(p.name)}</div>
        <div class="d-sub">
          <span>${esc(displayGrade(p))} · 售价 ¥${money(p.sale_price)}</span>
          <span class="badge ${off ? "badge-off" : "badge-on"}">${off ? "已下架" : "在售"}</span>
        </div>
      </div>
      <button class="d-close" data-d-act="close" title="关闭（Esc）">✕</button>
    </div>
    <div class="d-body">
      ${groups}
    </div>
    <div class="d-foot">
      <button class="mini-btn" id="drawerUndoBtn" ${state.canUndo ? "" : "disabled"} title="撤销上一步修改">↩ 撤销</button>
      <button class="mini-btn" id="drawerRedoBtn" ${state.canRedo ? "" : "disabled"} title="重做上一步">↪ 重做</button>
      <span class="d-fill"></span>
      <button class="mini-btn" data-d-act="stockin" title="补货入库">📦 补货</button>
      <button class="mini-btn btn-danger" data-d-act="del" title="删除(含记录)">🗑 删除</button>
    </div>`;
  box.querySelectorAll("[data-d-act]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onDrawerAct(e, p);
    });
  });
  const undo = $("drawerUndoBtn");
  const redo = $("drawerRedoBtn");
  if (undo) {
    undo.onclick = () => post({ type: "undoRequest" });
  }
  if (redo) {
    redo.onclick = () => post({ type: "redoRequest" });
  }
  bindDrawerFields(box, p);
  if (activeKey) {
    const again = box.querySelector(`.d-field[data-d-f="${activeKey}"]`);
    if (again) {
      again.focus();
      if (again.setSelectionRange && typeof again.value === "string") {
        try {
          again.setSelectionRange(again.value.length, again.value.length);
        } catch {
          /* number 输入不支持 setSelectionRange，忽略 */
        }
      }
    }
  }
}

function bindDrawerFields(box, p) {
  box.querySelectorAll(".d-field").forEach((el) => {
    const key = el.dataset.dF;
    const commit = () => commitDrawerField(p.id, key, el.value);
    if (el.tagName === "SELECT") {
      el.onchange = commit;
      return;
    }
    el.onblur = commit;
    el.onkeydown = (e) => {
      if (e.key === "Enter" && el.tagName !== "TEXTAREA") {
        e.preventDefault();
        el.blur();
      }
    };
  });
}

function commitDrawerField(pid, field, raw) {
  if (field === "status") {
    post({ type: "setStatus", id: pid, status: Number(raw) === 1 ? 1 : 0 });
    return;
  }
  if (saveFieldValue(pid, field, raw) === false) {
    // 校验失败：重绘回显原值
    renderProductDrawer();
  }
}

function onDrawerAct(e, p) {
  const el = e.target.closest("[data-d-act]");
  if (!el) {
    return;
  }
  const act = el.dataset.dAct;
  if (act === "close") {
    closeProductDrawer();
  } else if (act === "stockin") {
    openStockIn(p);
  } else if (act === "del") {
    confirmBox(
      `确认删除 ${p.code} ${p.name}？\n将同时删除它的销售记录和入库记录，且不可恢复！`,
    ).then((ok) => {
      if (ok) {
        post({ type: "deleteProduct", id: p.id });
      }
    });
  }
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
      const r = saveFieldValue(pid, field, editor.value);
      if (r === false) {
        td.innerHTML = td.dataset.orig;
        return;
      }
      if (r === "truncated") {
        return;
      }
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
    editor.type = "text";
    editor.inputMode = "decimal";
    editor.min = "0";
    editor.value = product[field];
  } else if (field === "stockTotal") {
    editor = document.createElement("input");
    editor.type = "number";
    editor.min = "0";
    editor.step = "1";
    editor.value = product.stockTotal || 0;
  } else {
    if (field === "category") {
      editor = document.createElement("input");
      editor.setAttribute("list", "shopCatList");
    } else {
      editor = document.createElement("textarea");
      editor.setAttribute("rows", "1");
      editor.spellcheck = false;
    }
    editor.value = cellValue(product, field);
  }
  editor.style.cssText =
    "width:100%;min-width:70px;box-sizing:border-box;padding:2px 5px";
  const isTextarea = editor.tagName === "TEXTAREA";
  if (isTextarea) {
    editor.style.resize = "vertical";
    editor.style.maxHeight = "160px";
    editor.style.overflow = "auto";
    editor.style.lineHeight = "1.4";
  }
  const autosize = () => {
    editor.style.height = "auto";
    editor.style.height = Math.min(160, editor.scrollHeight) + "px";
  };
  td.innerHTML = "";
  td.appendChild(editor);
  editor.onblur = () => finish(true);
  editor.onkeydown = (e) => {
    if (e.key === "Enter") {
      if (isTextarea && e.shiftKey) {
        return;
      }
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
    e.stopPropagation();
  };
  if (isTextarea) {
    editor.oninput = autosize;
    autosize();
  }
  setTimeout(() => {
    if (Array.isArray(editor) ? false : editor.focus) {
      editor.focus();
      if (editor.select) {
        editor.select();
      }
    }
  }, 0);
}

function populateFilters() {
  const trendAll = state.products.map((p) => `${p.id}|${p.code}|${p.name}`);
  const sig = JSON.stringify(trendAll);
  if (sig === filtersSig) {
    return;
  }
  filtersSig = sig;
  const trendSel = $("trendProduct");
  const curP = trendSel.value;
  trendSel.innerHTML =
    `<option value="">全部商品（按月）</option>` +
    state.products
      .map(
        (p) => `<option value="${p.id}">${esc(p.code)} ${esc(p.name)}</option>`,
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
          <label>编号 *</label><div><input id="npCode" placeholder="如 A001 / L007，1 个字母 + 数字，自动补零到 3 位" /><span id="npCodeHint" class="muted" style="display:block;font-size:11px;margin-top:2px"></span></div>
          <label>名称</label><input id="npName" maxlength="100" placeholder="如：铜合金锆石手链 四叶花" />
          <label>品类</label><input id="npCategory" list="shopCatList" maxlength="50" placeholder="手链 / 项链 / 耳环 / 戒指 / 手镯…可自定义" />
          <label>系列</label><input id="npSeries" maxlength="50" placeholder="A类 / B类 / C类…（平台链接系列，可空）" />
          <label>等级</label><select id="npGrade"><option value="0">自定义（售价手动定）</option>${selGrades
            .split(",")
            .map((g) => `<option value="${g}">${gradeLabel(g)}</option>`)
            .join("")}</select>
          <label>进价 ¥</label><input id="npCost" type="number" min="0" step="0.01" value="0" />
          <label>售价 ¥（留空=按等级自动算）</label><input id="npSale" type="number" min="0" step="0.01" />
          <label></label><span class="computed" id="npPreview">售价将自动计算</span>
          <label>期初库存</label><input id="npStock" type="number" min="0" step="1" value="0" />
          <label>采购链接</label><input id="npLink" maxlength="500" placeholder="下次进货去这里" />
          <label>备注</label><input id="npRemark" maxlength="200" />
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
  $("npCode").value = nextAvailableCode("A") || "";
  $("npCode").oninput = () => {
    const el = $("npCodeHint");
    if (!el) {
      return;
    }
    const v = String($("npCode").value || "").trim();
    const mm = v.match(/^([A-Za-z])/);
    const prefix = mm ? mm[1].toUpperCase() : "A";
    const next = nextAvailableCode(prefix);
    el.textContent = `前缀 ${prefix} · 当前最小未用：${next || "已用完（9999 满，请换一个前缀）"}`;
  };
  $("npCode").oninput();
  $("npCancel").onclick = closeModal;
  $("npSave").onclick = () => {
    const codeRaw = canonicalCode($("npCode").value);
    if (!codeRaw) {
      toast("编号格式不对（1 个字母 + 数字，最多 4 位，如 A001 / L007）");
      $("npCode").focus();
      return;
    }
    const name = sanitizeProductField("name", $("npName").value);
    if (!name.ok) {
      toast(name.msg);
      $("npName").focus();
      return;
    }
    const category = sanitizeProductField("category", $("npCategory").value);
    if (!category.ok) {
      toast(category.msg);
      $("npCategory").focus();
      return;
    }
    const series = sanitizeProductField("series", $("npSeries").value);
    if (!series.ok) {
      toast(series.msg);
      $("npSeries").focus();
      return;
    }
    const link = sanitizeProductField("purchase_link", $("npLink").value);
    if (!link.ok) {
      toast(link.msg);
      $("npLink").focus();
      return;
    }
    const remark = sanitizeProductField("remark", $("npRemark").value);
    const cost = sanitizeProductField("cost_price", $("npCost").value);
    if (!cost.ok) {
      toast(cost.msg);
      $("npCost").focus();
      return;
    }
    const sale = sanitizeProductField("sale_price", $("npSale").value);
    if (!sale.ok) {
      toast(sale.msg);
      $("npSale").focus();
      return;
    }
    const stock = sanitizeProductField("stockTotal", $("npStock").value);
    if (!stock.ok) {
      toast(stock.msg);
      $("npStock").focus();
      return;
    }
    const npGrade = Number($("npGrade").value);
    if (npGrade === 0 && !(Number($("npSale").value || 0) > 0)) {
      toast("自定义等级需要填写售价");
      return;
    }
    post({
      type: "addProduct",
      code: codeRaw,
      name: name.value,
      category: category.value,
      series: series.value,
      grade: npGrade,
      costPrice: cost.value,
      salePrice: sale.value,
      initialStock: stock.value,
      purchaseLink: link.value,
      remark: remark.value,
    });
    closeModal();
  };
}

// 「导入/导出」合并下拉：点按钮出菜单，两项分别开导入/导出弹窗
function openIoMenu() {
  const old = document.getElementById("ioMenu");
  if (old) {
    if (old._ioClose) {
      old._ioClose();
    }
    return;
  }
  const btn = $("ioBtn");
  const r = btn.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.id = "ioMenu";
  menu.style.cssText =
    "position:fixed;z-index:70;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px 0;min-width:150px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  menu.innerHTML =
    `<div class="ctx-item" data-io="import">导入商品</div>` +
    `<div class="ctx-item" data-io="export">导出Excel</div>`;
  menu.style.left = Math.min(r.left, window.innerWidth - 160) + "px";
  menu.style.top = r.bottom + 4 + "px";
  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    window.removeEventListener("mousedown", onDown);
    window.removeEventListener("keydown", onKey);
  };
  menu._ioClose = close;
  const onDown = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== btn) {
      close();
    }
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      close();
    }
  };
  window.addEventListener("mousedown", onDown);
  window.addEventListener("keydown", onKey);
  menu.addEventListener("click", () => close());
  menu.querySelector('[data-io="import"]').onclick = openImportProducts;
  menu.querySelector('[data-io="export"]').onclick = openExportProducts;
}

// 可导入字段（编号固定第 1 列）：与后端 IMPORTABLE_FIELD_ORDER 保持一致
const IMPORT_WRITABLE_KEYS = [
  "name",
  "category",
  "series",
  "grade",
  "cost_price",
  "sale_price",
  "status",
  "purchase_link",
];
const IMPORT_SAMPLES = {
  name: "铜合金锆石手链四叶花",
  category: "手链",
  series: "C类",
  grade: "2",
  cost_price: "12",
  sale_price: "",
  status: "在售",
  purchase_link: "",
};

function savedFieldSet(settingKey) {
  const s = new Set();
  try {
    const arr = JSON.parse(state.settings[settingKey] || "[]");
    if (Array.isArray(arr)) {
      arr.forEach((k) => s.add(String(k)));
    }
  } catch {
    /* 忽略 */
  }
  return s;
}

function renderImportPreview(msg) {
  pendingImportToken = String(msg.token || "");
  const el = document.getElementById("ipPreview");
  if (!el) {
    return;
  }
  const rows = Array.isArray(msg.rows) ? msg.rows : [];
  const rowHtml = rows
    .map(
      (r) =>
        `<tr><td>${r.kind === "new" ? "新增" : "更新"}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="muted">${esc(r.detail)}</td></tr>`,
    )
    .join("");
  const badHtml =
    msg.bad && msg.bad.length
      ? `<details style="margin:6px 0"><summary class="muted">无法解析 ${msg.bad.length} 行（点击展开）</summary><div class="pre-blocks">${msg.bad.map(esc).join("<br>")}</div></details>`
      : "";
  el.innerHTML =
    `<div class="ip-summ">将<span class="ip-ok">新增 ${msg.created}</span> · 将<span class="ip-upd">更新 ${msg.updated}</span> · 将跳过 ${msg.skipped}` +
    (msg.duplicates
      ? ` · <span class="muted">重复编号 ${msg.duplicates} 行已忽略</span>`
      : "") +
    `</div>` +
    badHtml +
    (rows.length
      ? `<div class="ip-table-wrap"><table class="data-table"><thead><tr><th>类型</th><th>编号</th><th>名称</th><th>变更</th></tr></thead><tbody>${rowHtml}</tbody></table>` +
        (msg.truncated
          ? `<p class="muted">不止这些：共 ${msg.total} 行（预览最多显示 ${rows.length} 行）</p>`
          : "") +
        `</div>`
      : `<p class="muted">没有可新增或更新的行</p>`);
  el.style.display = "";
  const commitBtn = document.getElementById("ipCommit");
  if (commitBtn) {
    commitBtn.style.display = "";
    commitBtn.disabled = false;
    commitBtn.textContent = "确认导入";
  }
  const doBtn = document.getElementById("ipDo");
  if (doBtn) {
    doBtn.disabled = false;
    doBtn.textContent = "重新解析";
  }
}

function closeImportMask() {
  pendingImportToken = "";
  if (ipMask) {
    closeModal();
    ipMask = null;
  }
}

function resetImportBtns() {
  const doBtn = document.getElementById("ipDo");
  if (doBtn) {
    doBtn.disabled = false;
    doBtn.textContent = "解析预览";
  }
  const commitBtn = document.getElementById("ipCommit");
  if (commitBtn) {
    commitBtn.disabled = false;
    commitBtn.textContent = "确认导入";
  }
  const prev = document.getElementById("ipPreview");
  if (prev) {
    prev.innerHTML = "";
    prev.style.display = "none";
  }
  pendingImportToken = "";
}

function openImportProducts() {
  let sel = savedFieldSet("import_fields");
  if (sel.size === 0) {
    // 兜底：当前「字段显示」勾出的可写列
    PRODUCT_FIELDS.forEach((f) => {
      if (IMPORT_WRITABLE_KEYS.includes(f.key) && visList.has(f.key)) {
        sel.add(f.key);
      }
    });
  }
  let mode =
    state.settings.import_mode === "add" ||
    state.settings.import_mode === "update"
      ? state.settings.import_mode
      : "both";
  const impKeys = () =>
    PRODUCT_FIELDS.filter(
      (f) =>
        f.key !== "code" &&
        IMPORT_WRITABLE_KEYS.includes(f.key) &&
        sel.has(f.key),
    );
  const hiHint = {
    both: "符合的行：已有编号＝更新，新编号＝新建；",
    add: "只新增：已有编号的行跳过（不更新）；",
    update: "只修改：不存在的编号跳过（不新建）；",
  };
  const MODE_TABS = [
    { v: "both", t: "新增＋修改" },
    { v: "add", t: "只新增" },
    { v: "update", t: "只修改" },
  ];
  const mask = showModal(`
    <h3>📥 导入商品</h3>
    <div class="mode-tabs">
      ${MODE_TABS.map(
        (m) =>
          `<button type="button" class="mode-tab${m.v === mode ? " active" : ""}" data-tab="${m.v}">${m.t}</button>`,
      ).join("")}
    </div>
    <div style="margin-bottom:8px">
      <div class="muted" style="margin-bottom:4px">导入字段（编号固定第 1 列，其余按勾选、顺序固定）</div>
      <div style="margin-bottom:4px">
        <button class="mini-btn" id="ipAll">全选</button>
        <button class="mini-btn" id="ipNone">不选</button>
      </div>
      <div class="io-chips">
        <label class="io-chip" title="编号固定第 1 列"><input type="checkbox" data-ip-k="code" checked disabled />编号</label>
        ${PRODUCT_FIELDS.filter((f) => IMPORT_WRITABLE_KEYS.includes(f.key))
          .map(
            (f) =>
              `<label class="io-chip"><input type="checkbox" data-ip-k="${f.key}" ${sel.has(f.key) ? "checked" : ""} />${f.label}</label>`,
          )
          .join("")}
      </div>
    </div>
    <p class="muted" id="ipColDesc"></p>
    <p class="muted" id="ipModeHint"></p>
    <textarea id="ipText"></textarea>
    <div id="ipPreview" style="display:none"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button id="ipCancel">取消</button>
      <button id="ipDo" class="btn-teal">解析预览</button>
      <button id="ipCommit" class="btn-teal" style="display:none">确认导入</button>
    </div>`);
  ipMask = mask;
  // 预览已存在时改了内容/字段/方式 → 作废旧预览，避免「确认导入」用了旧的计划
  const invalidatePreview = () => {
    if (!pendingImportToken) {
      return;
    }
    pendingImportToken = "";
    const prev = document.getElementById("ipPreview");
    if (prev) {
      prev.innerHTML = "";
      prev.style.display = "none";
    }
    const commitBtn = document.getElementById("ipCommit");
    if (commitBtn) {
      commitBtn.style.display = "none";
      commitBtn.disabled = false;
      commitBtn.textContent = "确认导入";
    }
    const doBtn = document.getElementById("ipDo");
    if (doBtn) {
      doBtn.disabled = false;
      doBtn.textContent = "解析预览";
    }
  };
  const doPreview = () => {
    const text = document.getElementById("ipText").value;
    if (!text.trim()) {
      toast("先粘贴内容");
      return;
    }
    const b = document.getElementById("ipDo");
    b.disabled = true;
    b.textContent = "解析中…";
    const commitBtn = document.getElementById("ipCommit");
    if (commitBtn) {
      commitBtn.disabled = true;
    }
    post({ type: "previewImportProducts", text, mode, fields: [...sel] });
  };
  const renderIp = () => {
    const cols = ["编号"].concat(impKeys().map((f) => f.label));
    document.getElementById("ipColDesc").innerHTML =
      `列顺序＝<b>${cols.join("、")}</b><br />` +
      "· 分隔：Tab / 空格 / 逗号；名称里不要带空格（空格按列分隔）<br />" +
      "· 库存/累计售出/累计净售是自动统计列，导入不参与；状态列可导入（填 在售/已下架 或 0/1）；备注不导入" +
      (cols.length <= 2 ? "<br />· 只贴编号也能建（其余走默认）" : "");
    document.getElementById("ipModeHint").textContent = hiHint[mode] || "";
    document.getElementById("ipText").placeholder =
      "示例：\n" +
      "A001\t" +
      impKeys()
        .map((f) => IMPORT_SAMPLES[f.key] ?? "")
        .join("\t");
  };
  renderIp();
  // 导入方式 = 分段 Tab
  mask.querySelectorAll(".mode-tab").forEach((tb) => {
    tb.onclick = () => {
      if (tb.dataset.tab === mode) {
        return;
      }
      mode = tb.dataset.tab;
      mask
        .querySelectorAll(".mode-tab")
        .forEach((x) => x.classList.toggle("active", x.dataset.tab === mode));
      renderIp();
      // 切方式＝结果会变：已有预览则按新方式自动重解析
      if (pendingImportToken) {
        doPreview();
      }
    };
  });
  mask.querySelectorAll("[data-ip-k]").forEach((cb) => {
    cb.onchange = () => {
      if (cb.disabled || cb.dataset.ipK === "code") {
        return;
      }
      cb.checked ? sel.add(cb.dataset.ipK) : sel.delete(cb.dataset.ipK);
      renderIp();
      invalidatePreview();
    };
  });
  document.getElementById("ipAll").onclick = () => {
    IMPORT_WRITABLE_KEYS.forEach((k) => sel.add(k));
    mask.querySelectorAll("[data-ip-k]").forEach((cb) => {
      if (!cb.disabled) {
        cb.checked = sel.has(cb.dataset.ipK);
      }
    });
    renderIp();
    invalidatePreview();
  };
  document.getElementById("ipNone").onclick = () => {
    sel.clear();
    mask.querySelectorAll("[data-ip-k]").forEach((cb) => {
      if (!cb.disabled) {
        cb.checked = sel.has(cb.dataset.ipK);
      }
    });
    renderIp();
    invalidatePreview();
  };
  document.getElementById("ipText").oninput = invalidatePreview;
  document.getElementById("ipCancel").onclick = () => {
    pendingImportToken = "";
    ipMask = null;
    closeModal();
  };
  document.getElementById("ipDo").onclick = doPreview;
  document.getElementById("ipCommit").onclick = () => {
    if (!pendingImportToken) {
      return;
    }
    const b = document.getElementById("ipCommit");
    b.disabled = true;
    b.textContent = "导入中…";
    post({ type: "commitImportProducts", token: pendingImportToken });
  };
}

function exportGroupHtml(checked, withImageChip) {
  const exChip = (key) => {
    if (key === "code") {
      return `<label class="io-chip" title="编号固定第 1 列"><input type="checkbox" data-io-e="code" checked disabled />编号</label>`;
    }
    if (key === "_image") {
      return withImageChip
        ? `<label class="io-chip" title="图片列：插在状态列前；状态与采购链接都取消时在末列"><input type="checkbox" data-io-e="_image" ${checked.has("_image") ? "checked" : ""} />图片</label>`
        : "";
    }
    const f = PRODUCT_FIELDS.find((x) => x.key === key);
    return `<label class="io-chip" title=""><input type="checkbox" data-io-e="${key}" ${checked.has(key) ? "checked" : ""} />${f ? f.label : key}</label>`;
  };
  return (
    CS_GROUPS.map((g) => {
      const chips = g.keys.map((k) => (k === "image" ? "_image" : k)).map(exChip).join("");
      return `<div class="cs-group"><div class="cs-group-title">${g.title}</div><div class="io-chips">${chips}</div></div>`;
    }).join("")
  );
}

function openExportProducts() {
  const checked = new Set();
  visList.forEach((k) => {
    if (k !== "code" && PRODUCT_FIELDS.some((f) => f.key === k)) {
      checked.add(k);
    }
  });
  const saved = savedFieldSet("export_fields");
  if (saved.size > 0) {
    checked.clear();
    saved.forEach((k) => checked.add(k));
  }
  checked.add("code");
  const total = state.products.length;
  const list = filteredProducts();
  const hasFilter = list.length < total;
  const selCount = state.selectedProducts.size;
  const starCount = state.liveStars ? state.liveStars.size : 0;
  const radio = (val, label, disabled) =>
    `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;cursor:${disabled ? "not-allowed" : "pointer"}"><input type="radio" name="eoScope" value="${val}" ${disabled ? "disabled" : ""}/>${label}</label>`;
  const defaultScope =
    selCount > 0 ? "selected" : hasFilter ? "filtered" : "all";
  const mask = showModal(`
    <h3>📤 导出商品 Excel</h3>
    <p class="muted" style="margin-bottom:6px">导出范围：</p>
    <div style="margin-bottom:8px">
      ${radio("all", `全部商品（${total} 条）`)}
      ${hasFilter ? radio("filtered", `当前筛选结果（${list.length} 条）`) : radio("filtered", "当前筛选结果", true)}
      ${selCount > 0 ? radio("selected", `勾选的 ${selCount} 个`) : ""}
      ${starCount > 0 ? radio("starred", `星标商品（${starCount} 条）`) : ""}
      ${radio("manual", "指定编号")}
    </div>
    <textarea id="eoCodes" placeholder="示例：L001，A007  L003、L005；逗号/空格/Tab/换行分隔，编号可省略字母前缀（如 7 默认补 A）" style="display:none;width:100%;box-sizing:border-box;min-height:72px;margin-bottom:6px"></textarea>
    <div id="eoBadWrap" style="display:none;max-height:88px;overflow:auto;margin-bottom:6px;padding:6px 8px;border:1px solid var(--vscode-inputValidation-warningBorder);border-radius:3px;background:var(--vscode-inputValidation-warningBackground);font-size:12px"></div>
    <p class="muted" id="eoScopeDesc" style="margin-bottom:8px"></p>
    ${exportGroupHtml(checked, true)}
    <p class="muted" id="eoColDesc"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button id="eoCancel">取消</button>
      <button id="eoDo" class="btn-teal">导出</button>
    </div>`);
  const scopeLabels = {
    all: `全部商品（${total} 条）`,
    filtered: `当前筛选结果（${list.length} 条）`,
    selected: `勾选的 ${selCount} 个`,
    manual: "指定编号",
  };
  const matchedByCode = new Map(state.products.map((p) => [p.code, p]));
  const renderEo = () => {
    const scope = [...mask.querySelectorAll('input[name="eoScope"]')].find(
      (r) => r.checked,
    );
    const scopeVal = scope ? scope.value : defaultScope;
    const isManual = scopeVal === "manual";
    $("eoCodes").style.display = isManual ? "" : "none";
    if (isManual) {
      const { valid, bad } = parseEoCodes($("eoCodes").value);
      const uniq = [...new Set(valid)];
      const matched = uniq.filter((c) => matchedByCode.has(c));
      const missing = uniq.filter((c) => !matchedByCode.has(c));
      const badUniq = [...new Set(bad)];
      $("eoScopeDesc").textContent =
        `识别 ${valid.length} 个编号 → 匹配到 ${matched.length} 条商品`;
      const lines = [];
      if (badUniq.length) {
        lines.push(`无法解析 ${badUniq.length} 个：${badUniq.join("、")}`);
      }
      if (missing.length) {
        lines.push(`不存在 ${missing.length} 个：${missing.join("、")}`);
      }
      const wrap = $("eoBadWrap");
      wrap.style.display = lines.length ? "" : "none";
      wrap.innerHTML = lines.map((l) => esc(l)).join("<br>");
    } else {
      $("eoScopeDesc").textContent =
        scopeLabels[scopeVal] === undefined
          ? ""
          : `范围：${scopeLabels[scopeVal]}`;
    }
    renderEoCols();
  };
  const renderEoCols = () => {
    const imgOn = checked.has("_image");
    const cols = [];
    let imgInserted = false;
    for (const f of PRODUCT_FIELDS) {
      if (f.key === "code") {
        continue;
      }
      if (!imgInserted && (f.key === "status" || f.key === "purchase_link")) {
        if (imgOn) {
          cols.push("图片");
          imgInserted = true;
        }
      }
      if (checked.has(f.key)) {
        cols.push(f.label);
      }
    }
    if (imgOn && !imgInserted) {
      cols.push("图片");
    }
    $("eoColDesc").textContent = `导出列（顺序固定）＝编号、${cols.join("、")}`;
  };
  const parseEoCodes = (raw) => {
    const valid = [];
    const bad = [];
    String(raw || "")
      .split(/[\s,\t，、]/)
      .forEach((s) => {
        const t = String(s || "").trim();
        if (!t) {
          return;
        }
        const c = canonicalCode(t);
        if (c) {
          valid.push(c);
        } else {
          bad.push(t);
        }
      });
    return { valid, bad };
  };
  const setScope = (val) => {
    mask.querySelectorAll('input[name="eoScope"]').forEach((r) => {
      r.checked = r.value === val;
    });
    renderEo();
  };
  mask.querySelectorAll('input[name="eoScope"]').forEach((r) => {
    r.onchange = () => renderEo();
  });
  $("eoCodes").oninput = () => renderEo();
  setScope(defaultScope);
  renderEoCols();
  mask.querySelectorAll("[data-io-e]").forEach((cb) => {
    cb.onchange = () => {
      if (cb.disabled || cb.dataset.ioE === "code") {
        return;
      }
      cb.checked ? checked.add(cb.dataset.ioE) : checked.delete(cb.dataset.ioE);
      renderEoCols();
    };
  });
  $("eoCancel").onclick = closeModal;
  $("eoDo").onclick = () => {
    if ($("eoDo").disabled) {
      return;
    }
    const scopeVal = (
      [...mask.querySelectorAll('input[name="eoScope"]')].find(
        (r) => r.checked,
      ) || {}
    ).value;
    let codes;
    if (scopeVal === "filtered") {
      codes = list.map((x) => x.code);
    } else if (scopeVal === "selected") {
      codes = state.products
        .filter((p) => state.selectedProducts.has(p.id))
        .map((x) => x.code);
    } else if (scopeVal === "starred") {
      codes = state.products
        .filter((p) => state.liveStars && state.liveStars.has(p.code))
        .map((x) => x.code);
      if (codes.length === 0) {
        toast("没有星标商品");
        return;
      }
    } else if (scopeVal === "manual") {
      const { valid } = parseEoCodes($("eoCodes").value);
      const validCodes = [...new Set(valid)].filter((c) =>
        matchedByCode.has(c),
      );
      if (validCodes.length === 0) {
        toast("没有匹配到任何编号，请检查输入");
        return;
      }
      codes = validCodes;
    } else {
      codes = state.products.map((x) => x.code);
    }
    if (!codes.length) {
      toast("没有可导出的商品");
      return;
    }
    beginExport("eoDo");
    const fields = PRODUCT_FIELDS.map((f) => f.key).filter(
      (k) => k !== "code" && checked.has(k),
    );
    if (checked.has("_image")) {
      fields.push("_image");
    }
    post({
      type: "exportProducts",
      codes,
      filtered: codes.length < state.products.length ? 1 : 0,
      fields,
      withImages: checked.has("_image") ? 1 : 0,
    });
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

const CS_GROUPS = [
  { title: "① 商品档案", keys: ["code", "name", "category", "series", "grade", "purchase_link", "image"] },
  { title: "② 价格与销售", keys: ["cost_price", "sale_price", "stockTotal", "soldTotal", "netTotal"] },
  { title: "③ 状态与辅助", keys: ["status", "remark"], ops: true },
];

function chipHtml(key, label, prefix, set, locked) {
  return (
    `<label class="io-chip" ${locked ? 'title="编号固定显示"' : ""}>` +
    `<input type="checkbox" data-g="${prefix}" data-cfk="${key}" ${locked || set.has(key) ? "checked" : ""} ${locked ? "disabled" : ""} />${label}</label>`
  );
}

function checkGroupHtml(prefix, set, imgVisible, withOps) {
  const groupChips = (keys) =>
    keys.map((k) => {
      if (k === "image") {
        return (
          `<label class="io-chip" title="商品图片列（列表为整列，画册为卡片主图）">` +
          `<input type="checkbox" data-g="${prefix}" data-cfk="image" ${imgVisible ? "checked" : ""} />图片</label>`
        );
      }
const f = PRODUCT_FIELDS.find((x) => x.key === k);
      return chipHtml(k, f ? f.label : k, prefix, set, k === "code");
    }).join("");
  return (
    CS_GROUPS.map((g) => {
      let chips = groupChips(g.keys);
      if (withOps && g.ops) {
        chips +=
          `<label class="io-chip" title="列表每行的快捷按钮列：星标 / 复制完整名称 / 补货入库 / 删除（仅列表视图）">` +
          `<input type="checkbox" data-g="${prefix}" data-cfk="ops" ${showOpsList ? "checked" : ""} />操作列</label>`;
      }
      return `<div class="cs-group"><div class="cs-group-title">${g.title}</div><div class="io-chips">${chips}</div></div>`;
    }).join("")
  );
}

function openColSet() {
  const isList = viewMode !== "gallery";
  const toggle = isList ? new Set(visList) : new Set(visGallery);
  let imgVisible = isList ? showImageList : showImageGallery;
  const keyName = isList ? "列表视图" : "画册视图（卡片上显示的字段）";
  const mask = showModal(`
        <h3>字段显示 / 隐藏（当前：${keyName}）</h3>
        <p class="muted">这里只调整「${keyName}」的显示；切换到另一个视图后再打开会看到它的配置（两者分开保存）。</p>
        <div style="margin-bottom:6px">
          <button class="mini-btn" id="csListAll">全选</button>
          <button class="mini-btn" id="csListNone">不选</button>
        </div>
        ${checkGroupHtml("cur", toggle, imgVisible, isList)}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="csCancel">取消</button>
          <button id="csSave" class="btn-teal">保存</button>
        </div>`);
  const recalc = () => {
    mask.querySelectorAll('[data-g="cur"]').forEach((cb) => {
      if (cb.dataset.cfk === "image") {
        cb.checked = imgVisible;
      } else if (cb.dataset.cfk === "ops") {
        cb.checked = showOpsList;
      } else {
        cb.checked = toggle.has(cb.dataset.cfk);
      }
    });
  };
  $("csListAll").onclick = () => {
    PRODUCT_FIELDS.forEach((f) => toggle.add(f.key));
    imgVisible = true;
    showOpsList = true;
    recalc();
  };
  $("csListNone").onclick = () => {
    toggle.clear();
    toggle.add("code");
    imgVisible = false;
    showOpsList = false;
    recalc();
  };
  mask.querySelectorAll('[data-g="cur"]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.disabled || cb.dataset.cfk === "code") {
        return;
      }
      if (cb.dataset.cfk === "image") {
        imgVisible = cb.checked;
        return;
      }
      if (cb.dataset.cfk === "ops") {
        showOpsList = cb.checked;
        return;
      }
      cb.checked ? toggle.add(cb.dataset.cfk) : toggle.delete(cb.dataset.cfk);
    };
  });
  $("csCancel").onclick = closeModal;
  $("csSave").onclick = () => {
    toggle.add("code");
    if (isList) {
      visList = new Set(toggle);
      showImageList = imgVisible;
    } else {
      visGallery = new Set(toggle);
      showImageGallery = imgVisible;
    }
    post({
      type: "saveSettings",
      key: isList ? "col_visible_list" : "col_visible_gallery",
      value: JSON.stringify([...toggle]),
    });
    post({
      type: "saveSettings",
      key: isList ? "col_image_list" : "col_image_gallery",
      value: imgVisible ? "1" : "0",
    });
    post({
      type: "saveSettings",
      key: "col_show_ops",
      value: showOpsList ? "1" : "0",
    });
    closeModal();
    renderProducts();
  };
}

function openContextMenu(e, p, field) {
  e.preventDefault();
  e.stopPropagation();
  const old = document.getElementById("ctxMenu");
  if (old) {
    old.remove();
  }
  const menu = document.createElement("div");
  menu.id = "ctxMenu";
  menu.style.cssText =
    "position:fixed;z-index:70;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px 0;min-width:150px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  const editable = EDITABLE_FIELDS.has(field);
  const canPaste =
    !!appClipboard || !!(navigator.clipboard && navigator.clipboard.readText);
  menu.innerHTML =
    `<div class="ctx-cellops">` +
    `<div class="ctx-cellop" data-cellop="copy" title="复制该格 (Ctrl+C)"><span class="cop-icon">📋</span><span>复制</span></div>` +
    `<div class="ctx-cellop${canPaste && editable ? "" : " ctx-disabled"}" data-cellop="paste" title="粘贴到该格 (Ctrl+V)"><span class="cop-icon">📥</span><span>粘贴</span></div>` +
    `<div class="ctx-cellop${CUTTABLE_FIELDS.has(field) ? "" : " ctx-disabled"}" data-cellop="cut" title="剪切该格并立即清空 (Ctrl+X)"><span class="cop-icon">✂</span><span>剪切</span></div>` +
    `</div>` +
    `<div class="ctx-item" data-copy="row">复制整行</div>` +
    `<div class="ctx-item" data-copy="table">复制整表(筛选后)</div>` +
    `<div style="border-top:1px solid var(--vscode-panel-border);margin:3px 0"></div>` +
    (p.status === 0
      ? `<div class="ctx-item" data-pctx="off">下架</div>`
      : `<div class="ctx-item" data-pctx="on">上架</div>`) +
    `<div class="ctx-item" data-pctx="clearimg">清空图片文件夹…</div>` +
    `<div style="border-top:1px solid var(--vscode-panel-border);margin:3px 0"></div>` +
    `<div class="ctx-item ctx-danger" data-pctx="delrow">🗑 删除整行（含记录）…</div>`;
  menu.style.left = Math.min(e.clientX, window.innerWidth - 140) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 60) + "px";
  document.body.appendChild(menu);
  const close = () => menu.remove();
  menu.addEventListener("click", () => close());
  const cutBtn = menu.querySelector('[data-cellop="cut"]');
  if (cutBtn) {
    cutBtn.onclick = () => {
      cutCell(p, field);
      close();
    };
  }
  menu.querySelector('[data-cellop="copy"]').onclick = () => {
    copyCell(p, field);
    close();
  };
  const pasteBtn = menu.querySelector('[data-cellop="paste"]');
  if (pasteBtn) {
    pasteBtn.onclick = () => {
      pasteCell(p.id, field);
      close();
    };
  }
  menu.querySelector('[data-copy="row"]').onclick = () => {
    const vis = visList;
    const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => vis.has(k));
    copyText(keys.map((k) => cellValue(p, k)).join("\t"));
    close();
  };
  menu.querySelector('[data-copy="table"]').onclick = () => {
    const list = filteredProducts();
    const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) => visList.has(k));
    const lines = [
      keys.map((k) => PRODUCT_FIELDS.find((f) => f.key === k).label).join("\t"),
    ];
    for (const row of list) {
      lines.push(keys.map((k) => cellValue(row, k)).join("\t"));
    }
    copyText(lines.join("\n"));
    close();
  };
  const offBtn = menu.querySelector('[data-pctx="off"]');
  if (offBtn) {
    offBtn.onclick = () => {
      post({ type: "setStatus", id: p.id, status: 1 });
      close();
    };
  }
  const onBtn = menu.querySelector('[data-pctx="on"]');
  if (onBtn) {
    onBtn.onclick = () => {
      post({ type: "setStatus", id: p.id, status: 0 });
      close();
    };
  }
  menu.querySelector('[data-pctx="clearimg"]').onclick = () => {
    confirmBox(`确认清空 ${p.code} 的图片文件夹？（文件会真的删除）`).then(
      (ok) => {
        if (ok) {
          post({ type: "clearImages", code: p.code });
        }
      },
    );
    close();
  };
  menu.querySelector('[data-pctx="delrow"]').onclick = () => {
    confirmBox(
      `确认删除 ${p.code} ${p.name} 这整行？\n将同时删除它的销售记录和入库记录，且不可恢复！`,
    ).then((ok) => {
      if (ok) {
        post({ type: "deleteProduct", id: p.id });
      }
    });
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

function onProductCtx(e) {
  const coverEl = e.target.closest("[data-p-act='img']");
  if (coverEl) {
    e.preventDefault();
    e.stopPropagation();
    const p = state.products.find((x) => x.id === Number(coverEl.dataset.id));
    if (p) {
      openCoverMenu(e, p);
    }
    return;
  }
  const td = e.target.closest("td[data-pid]");
  if (!td) {
    return;
  }
  const p = state.products.find((x) => x.id === Number(td.dataset.pid));
  if (!p) {
    return;
  }
  if (td.dataset.f) {
    selectListCell(Number(td.dataset.pid), td.dataset.f);
  }
  openContextMenu(e, p, td.dataset.f);
}

function openCoverMenu(e, p) {
  const coverData = state.coverCache[p.code] || "";
  const items = [];
  if (coverData) {
    items.push({
      label: "📋 复制图片",
      run: () => {
        copyImageFromDataUrl(coverData).then((ok) =>
          ok ? toast("已复制图片") : toast("复制失败"),
        );
      },
    });
  }
  if (navigator.clipboard && navigator.clipboard.read) {
    items.push({
      label: "📥 粘贴图片",
      run: () => {
        readClipboardImageDataURL()
          .then((data) => {
            if (data) {
              post({
                type: "receiveImageData",
                code: p.code,
                items: [{ name: `paste_${Date.now()}`, data }],
              });
            } else {
              toast("剪贴板里没有图片");
            }
          })
          .catch((err) => {
            toast(
              err && err.message === "noimage"
                ? "剪贴板里没有图片"
                : "❌读取剪贴板失败：权限被拒",
            );
          });
      },
    });
  }
  items.push({ label: "🔍 查看大图", run: () => openLightbox(p) });
  showImageCtxMenu(e.clientX, e.clientY, items);
}

// 图片列：支持「拖入图片文件 / 粘贴剪贴板图片」，落到当前商品（表格列 / 卡片 / 灯箱）
var shopImageBindings = null;

function isImageFile(file) {
  return (
    !!file && typeof file.type === "string" && file.type.startsWith("image/")
  );
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read error"));
    reader.readAsDataURL(file);
  });
}

function readBlobAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read error"));
    reader.readAsDataURL(blob);
  });
}

// 菜单触发式「粘贴图片」：主动读剪贴板拿第一张图，与 Ctrl+V/拖入走同一条 receiveImageData 落图链路
function readClipboardImageDataURL() {
  return navigator.clipboard.read().then((cItems) => {
    if (!cItems || !cItems.length) {
      throw new Error("noimage");
    }
    for (const item of cItems) {
      const t = Array.from(item.types || []).find((x) =>
        String(x).toLowerCase().startsWith("image/"),
      );
      if (!t) {
        continue;
      }
      return item.getType(t).then((blob) => {
        if (!blob) {
          throw new Error("noimage");
        }
        return readBlobAsDataURL(blob);
      });
    }
    throw new Error("noimage");
  });
}

async function filesToImageItems(fileList) {
  const files = Array.from(fileList || []).filter(isImageFile);
  const items = [];
  for (const f of files) {
    try {
      const data = await readFileAsDataURL(f);
      if (data) {
        items.push({ name: f.name || "", data });
      }
    } catch {
      /* 忽略单张读取失败 */
    }
  }
  return items;
}

// 从 DataTransfer/ClipboardEvent 里收集文件，items 与 files 会重复，按 name+size+lastModified 去重
function collectFiles(dt) {
  const seen = new Set();
  const out = [];
  const add = (f) => {
    if (!f) {
      return;
    }
    const key = `${f.name || ""}|${f.size}|${f.lastModified}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(f);
  };
  if (dt) {
    if (dt.items) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === "file") {
          add(it.getAsFile());
        }
      }
    }
    if (dt.files) {
      for (const f of Array.from(dt.files)) {
        add(f);
      }
    }
  }
  return out;
}

function productFromCoverTarget(el) {
  if (!el || !el.closest) {
    return null;
  }
  const coverEl = el.closest("[data-p-act='img']");
  if (!coverEl) {
    return null;
  }
  return (
    state.products.find((x) => x.id === Number(coverEl.dataset.id)) || null
  );
}

// 拖放/粘贴的目标定位：图片列 → 任意带 data-pid 的行/单元格 → 灯箱
function productForDropOrPaste(e) {
  if (!document.getElementById("productListView")) {
    return null;
  }
  const t = e.target;
  const el = t && t.closest ? t : document.activeElement;
  let product = null;
  if (el && el.closest) {
    const coverEl = el.closest("[data-p-act='img']");
    const rowEl = coverEl || el.closest("[data-pid]");
    if (rowEl) {
      product =
        state.products.find((x) => x.id === Number(rowEl.dataset.id)) || null;
    }
  }
  const inLb = !!el.closest("#lbBox");
  if (!product && inLb && state.lbCode) {
    product = state.products.find((x) => x.code === state.lbCode) || null;
  }
  return product || null;
}

function onImagePasteCapture(e) {
  if (!document.getElementById("productListView")) {
    return;
  }
  const t = e.target;
  if (
    t &&
    t.closest &&
    t.closest("input,textarea,select,[contenteditable='true']")
  ) {
    return;
  }
  const files = collectFiles(e.clipboardData || window.clipboardData || null);
  if (!files.length) {
    return;
  }
  const product = productForDropOrPaste(e);
  if (!product) {
    toast("先点开某个商品的图片看大图，再把图片 Ctrl+V 粘贴进来");
    return;
  }
  filesToImageItems(files).then((items) => {
    if (items.length) {
      post({ type: "receiveImageData", code: product.code, items });
    } else {
      toast("剪贴板里未检测到图片");
    }
  });
  e.preventDefault();
}

let fileDragHinted = false;

// 拖拽的是画册/灯箱里已经显示出来的图本身：浏览器会把它当成一个文件放进 dataTransfer，
// 一松手就又被 receiveImageData 再写一份副本。在源头取消这次拖拽即可。
function onInternalImgDragStart(e) {
  if (
    e.target &&
    e.target.closest &&
    e.target.closest("img") &&
    document.getElementById("productListView")
  ) {
    e.preventDefault();
    toast("这张图已经在这里了，复制请用右键菜单");
  }
}

function onImageDragOver(e) {
  const t = e.target;
  if (!t || !t.closest) {
    return;
  }
  const coverEl = t.closest("[data-p-act='img']");
  const rowEl = t.closest("[data-pid]");
  const inLb = !!t.closest("#lbBox");
  if (!coverEl && !rowEl && !inLb) {
    return;
  }
  if (!document.getElementById("productListView")) {
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  const target = coverEl || rowEl;
  if (target) {
    target.classList.add("img-drop-hover");
  } else if (inLb) {
    const lb = document.getElementById("lbBox");
    if (lb) {
      lb.classList.add("img-drop-hover");
    }
  }
  const types = (e.dataTransfer && e.dataTransfer.types) || [];
  if (
    !fileDragHinted &&
    Array.from(types).some((x) => String(x).toLowerCase() === "files")
  ) {
    fileDragHinted = true;
    toast(
      "松开鼠标即可把图片加到这里（若弹系统提示没反应，请按住 Shift 拖入）",
    );
  }
}

function onImageDrop(e) {
  if (!document.getElementById("productListView")) {
    return;
  }
  const t = e.target;
  if (!t || !t.closest) {
    return;
  }
  const coverEl = t.closest("[data-p-act='img']");
  const rowEl = t.closest("[data-pid]");
  const inLb = !!t.closest("#lbBox");
  const target = coverEl || rowEl;
  if (target) {
    target.classList.remove("img-drop-hover");
  } else if (inLb) {
    const lb = document.getElementById("lbBox");
    if (lb) {
      lb.classList.remove("img-drop-hover");
    }
  }
  if (!coverEl && !rowEl && !inLb) {
    return;
  }
  const product = productForDropOrPaste(e);
  if (!product) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  filesToImageItems(collectFiles(e.dataTransfer)).then((items) => {
    if (items.length) {
      post({ type: "receiveImageData", code: product.code, items });
    } else {
      toast("未检测到图片文件");
    }
  });
}

function clearImgDropHover() {
  fileDragHinted = false;
  document
    .querySelectorAll(".img-drop-hover")
    .forEach((el) => el.classList.remove("img-drop-hover"));
}

// document 级捕获监听覆盖列表/宫格/灯箱，切走再切回会累积，先解绑旧的再绑新的
function bindImageDropPaste() {
  if (shopImageBindings) {
    document.removeEventListener("paste", shopImageBindings.paste, true);
    document.removeEventListener(
      "dragleave",
      shopImageBindings.dragleave,
      true,
    );
    document.removeEventListener("dragover", shopImageBindings.dragover, true);
    document.removeEventListener("drop", shopImageBindings.drop, true);
    document.removeEventListener(
      "dragstart",
      shopImageBindings.dragstart,
      true,
    );
  }
  shopImageBindings = {
    paste: onImagePasteCapture,
    dragleave: clearImgDropHover,
    dragover: onImageDragOver,
    drop: onImageDrop,
    dragstart: onInternalImgDragStart,
  };
  document.addEventListener("paste", shopImageBindings.paste, true);
  document.addEventListener("dragleave", shopImageBindings.dragleave, true);
  document.addEventListener("dragover", shopImageBindings.dragover, true);
  document.addEventListener("drop", shopImageBindings.drop, true);
  document.addEventListener("dragstart", shopImageBindings.dragstart, true);
}

function onProductAct(e) {
  const cellTd = e.target.closest("td[data-pid][data-f]");
  if (
    cellTd &&
    !e.target.closest("input,select,button,a,.thumb,[data-s-act],[data-p-act]")
  ) {
    selectListCell(Number(cellTd.dataset.pid), cellTd.dataset.f);
  }
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
  const th = e.target.closest("[data-sort]");
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
  } else if (act === "edit") {
    openProductDrawer(product);
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
