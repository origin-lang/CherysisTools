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
        if (v && !cellValue(p, key).toLowerCase().includes(String(v).toLowerCase())) {
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
  state.lbIdx = 0;
  state.lbPendingCopy = null;
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
        distinctOptions(
          key,
          key === "grade" ? displayGrade : undefined,
        ),
      )}</select>`;
    case "cost_price":
    case "sale_price":
    case "stockTotal": {
      const label =
        key === "cost_price"
          ? "进价"
          : key === "sale_price"
            ? "售价"
            : "库存";
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
  const imgAt = showImg ? (plIdx >= 0 ? plIdx : vis.length) : -1;
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
  headCols.push(`<th><span class="th-label">操作</span></th>`);
  filterCells.push(`<td></td>`);
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
            v = `<b>${esc(p.code)}</b>`;
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
      tds.push(`<td>
              <button class="mini-btn" data-s-act="toggle" data-code="${esc(p.code)}" data-id="${p.id}" title="${starred ? "取消星标" : "加入直播排品备选"}">${starred ? "★" : "☆"}</button>
              <button class="mini-btn" data-p-act="copy" data-id="${p.id}" title="复制完整名称">📋</button>
              <button class="mini-btn" data-p-act="stockin" data-id="${p.id}" title="补货入库">📦</button>
              <button class="mini-btn btn-danger" data-p-act="del" data-id="${p.id}" title="删除(含记录)">🗑</button>
            </td>`);
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
            ? `<div class="batch-ops" id="batchOpsBar" style="margin-bottom:8px;padding:8px;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);border-radius:4px;display:flex;gap:8px;align-items:center">
<span>已选 <b data-sel-count>${selectedCount}</b> 个商品</span>
                     <button class="mini-btn" id="batchCopy" title="把选中的商品按当前可见列复制到剪贴板（带表头）">📋 复制选中</button>
                     <button class="mini-btn" id="batchOn" title="上架选中的商品">🔺 上架</button>
                    <button class="mini-btn" id="batchOff" title="下架选中的商品">🔻 下架</button>
                    <button class="mini-btn btn-danger" id="batchDel" title="删除选中的商品（含记录，不可恢复）">🗑 删除</button>
                    <button class="mini-btn" id="batchClear" title="取消全部选择">✕ 取消</button>
                  </div>`
            : ""
        }
             <div class="table-wrap"><table class="data-table"><thead><tr>
               <th style="width:30px"><input type="checkbox" id="selectAllProducts" ${list.length === 0 ? "disabled" : ""} ${allSelected ? "checked" : ""} title="全选 / 取消全选" /></th>
               ${headCols.join("")}
             </tr><tr class="filter-row">
               <td></td>
               ${filterCells.join("")}
             </tr></thead><tbody>${body}</tbody></table></div>
             <div class="muted" style="margin-top:4px">表头下小框可筛选对应列；单击单元格框选，Ctrl+C/X/V 复制/剪切/粘贴该格、Esc 取消框选；双击单元格编辑（回车或点击别处即保存）；右键可剪切/复制/粘贴、复制整行/删除整行</div>`;
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
        typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
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
    clear.style.visibility = hasFilter() ? "visible" : "hidden";
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

  const batchOn = $("batchOn");
  const batchOff = $("batchOff");
  const batchDel = $("batchDel");
  const batchClear = $("batchClear");
  const batchCopy = $("batchCopy");

  if (batchCopy) {
    batchCopy.onclick = copySelectedProducts;
  }

  const batchSetStatus = (status) => {
    if (state.selectedProducts.size === 0) {
      return;
    }
    const n = state.selectedProducts.size;
    post({
      type: "setProductsStatus",
      ids: [...state.selectedProducts],
      status,
    });
    // 动作完成后保留勾选：可连续上架↔下架（批量删除才清勾选）
    // 若当前“状态筛选”会让这批商品从列表消失，自动切回“全部”让结果可见
    const hiddenVal = status === 0 ? "off" : "on";
    if (filters.f_status === hiddenVal) {
      delete filters.f_status;
      const fs = $("filterStatus");
      if (fs) {
        fs.value = "";
      }
    }
    toast(`✅已${status === 0 ? "上架" : "下架"} ${n} 个商品`);
    renderProducts();
  };

  if (batchOn) {
    batchOn.onclick = () => batchSetStatus(0);
  }
  if (batchOff) {
    batchOff.onclick = () => batchSetStatus(1);
  }
  if (batchDel) {
    batchDel.onclick = () => {
      if (state.selectedProducts.size === 0) {
        return;
      }
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
                  ${showImageGallery ? (coverData ? `<img src="${coverData}" />` : `<div class="ph">暂无图片</div>`) : ""}
                  <div class="card-body">${lines}</div>
                </div>`;
          })
          .join("")}</div>`;
}

function stateProduct(code) {
  return state.products.find((p) => p.code === code);
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
    editor.type = "number";
    editor.min = "0";
    editor.step = "0.01";
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
          <label>编号 *</label><input id="npCode" placeholder="L001 或 L076，自动补零到 3 位" />
          <label>名称 *</label><input id="npName" maxlength="100" placeholder="如：铜合金锆石手链 四叶花" />
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
  $("npCancel").onclick = closeModal;
  $("npSave").onclick = () => {
    const codeRaw = canonicalCode($("npCode").value);
    if (!codeRaw) {
      toast("编号格式不对（L+数字，最多 4 位）");
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
    state.settings.import_mode === "add" || state.settings.import_mode === "update"
      ? state.settings.import_mode
      : "both";
  const impKeys = () =>
    PRODUCT_FIELDS.filter(
      (f) => f.key !== "code" && IMPORT_WRITABLE_KEYS.includes(f.key) && sel.has(f.key),
    );
  const hiHint = {
    both: "符合的行：已有编号＝更新，新编号＝新建；",
    add: "只新增：已有编号的行跳过（不更新）；",
    update: "只修改：不存在的编号跳过（不新建）；",
  };
  const mask = showModal(`
    <h3>📥 导入商品</h3>
    <div style="margin-bottom:8px">
      <div class="muted" style="margin-bottom:4px">导入方式</div>
      <label style="margin-right:10px"><input type="radio" name="ipMode" value="both" ${mode === "both" ? "checked" : ""} />新增＋修改</label>
      <label style="margin-right:10px"><input type="radio" name="ipMode" value="add" ${mode === "add" ? "checked" : ""} />只新增</label>
      <label><input type="radio" name="ipMode" value="update" ${mode === "update" ? "checked" : ""} />只修改</label>
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
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button id="ipCancel">取消</button>
      <button id="ipDo" class="btn-teal">导入</button>
    </div>`);
  const renderIp = () => {
    const cols = ["编号"].concat(impKeys().map((f) => f.label));
    $("ipColDesc").innerHTML = `列顺序＝<b>${cols.join("、")}</b><br />` +
      "· 分隔：Tab / 空格 / 逗号；名称里不要带空格（空格按列分隔）<br />" +
      "· 库存/累计售出/累计净售是自动统计列，导入不参与；状态列可导入（填 在售/已下架 或 1/0）；备注不导入" +
      (cols.length <= 2 ? "<br />· 只贴编号也能建（其余走默认）" : "");
    $("ipModeHint").textContent = hiHint[mode] || "";
    $("ipText").placeholder =
      "示例：\n" +
      "L001\t" +
      impKeys().map((f) => IMPORT_SAMPLES[f.key] ?? "").join("\t");
  };
  renderIp();
  mask.querySelectorAll('input[name="ipMode"]').forEach((rb) => {
    rb.onchange = () => {
      mode = rb.value;
      renderIp();
    };
  });
  mask.querySelectorAll('[data-ip-k]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.disabled || cb.dataset.ipK === "code") {
        return;
      }
      cb.checked ? sel.add(cb.dataset.ipK) : sel.delete(cb.dataset.ipK);
      renderIp();
    };
  });
  $("ipAll").onclick = () => {
    IMPORT_WRITABLE_KEYS.forEach((k) => sel.add(k));
    mask.querySelectorAll("[data-ip-k]").forEach((cb) => {
      if (!cb.disabled) {
        cb.checked = sel.has(cb.dataset.ipK);
      }
    });
    renderIp();
  };
  $("ipNone").onclick = () => {
    sel.clear();
    mask.querySelectorAll("[data-ip-k]").forEach((cb) => {
      if (!cb.disabled) {
        cb.checked = sel.has(cb.dataset.ipK);
      }
    });
    renderIp();
  };
  $("ipCancel").onclick = closeModal;
  $("ipDo").onclick = () => {
    const text = $("ipText").value;
    if (!text.trim()) {
      toast("先粘贴内容");
      return;
    }
    post({
      type: "importProducts",
      text,
      mode,
      fields: [...sel],
    });
    closeModal();
  };
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
  const radio = (val, label, disabled) =>
    `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;cursor:${disabled ? "not-allowed" : "pointer"}"><input type="radio" name="eoScope" value="${val}" ${disabled ? "disabled" : ""}/>${label}</label>`;
  const defaultScope = selCount > 0 ? "selected" : hasFilter ? "filtered" : "all";
  const mask = showModal(`
    <h3>📤 导出商品 Excel</h3>
    <p class="muted" style="margin-bottom:6px">导出范围：</p>
    <div style="margin-bottom:8px">
      ${radio("all", `全部商品（${total} 条）`)}
      ${hasFilter ? radio("filtered", `当前筛选结果（${list.length} 条）`) : radio("filtered", "当前筛选结果", true)}
      ${selCount > 0 ? radio("selected", `勾选的 ${selCount} 个`) : ""}
      ${radio("manual", "指定编号")}
    </div>
    <textarea id="eoCodes" placeholder="示例：L001，L002  L003、L005；逗号/空格/Tab/换行分隔，编号可省略 L（如 7）" style="display:none;width:100%;box-sizing:border-box;min-height:72px;margin-bottom:6px"></textarea>
    <div id="eoBadWrap" style="display:none;max-height:88px;overflow:auto;margin-bottom:6px;padding:6px 8px;border:1px solid var(--vscode-inputValidation-warningBorder);border-radius:3px;background:var(--vscode-inputValidation-warningBackground);font-size:12px"></div>
    <p class="muted" id="eoScopeDesc" style="margin-bottom:8px"></p>
    <div class="io-chips">
      ${(() => {
        const chip = (key, label, title, on, disabled) =>
          `<label class="io-chip" title="${esc(title)}"><input type="checkbox" data-io-e="${key}" ${on ? "checked" : ""} ${disabled ? "disabled" : ""} />${label}</label>`;
        const parts = [chip("code", "编号", "编号固定第 1 列", true, true)];
        for (const f of PRODUCT_FIELDS) {
          if (f.key === "code") {
            continue;
          }
          if (f.key === "purchase_link") {
            parts.push(chip("_image", "图片", "图片列：在采购链接前插入每行首张图", checked.has("_image"), false));
          }
          parts.push(chip(f.key, f.label, "", checked.has(f.key), false));
        }
        return parts.join("");
      })()}
    </div>
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
        scopeLabels[scopeVal] === undefined ? "" : `范围：${scopeLabels[scopeVal]}`;
    }
    renderEoCols();
  };
  const renderEoCols = () => {
    const imgOn = checked.has("_image");
    const linkOn = checked.has("purchase_link");
    const cols = [];
    for (const f of PRODUCT_FIELDS) {
      if (f.key === "code") {
        continue;
      }
      if (f.key === "purchase_link") {
        if (imgOn) {
          cols.push("图片");
        }
        if (linkOn) {
          cols.push(f.label);
        }
        continue;
      }
      if (checked.has(f.key)) {
        cols.push(f.label);
      }
    }
    if (imgOn && !linkOn) {
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
  mask.querySelectorAll('[data-io-e]').forEach((cb) => {
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
      [...mask.querySelectorAll('input[name="eoScope"]')].find((r) => r.checked) ||
      {}
    ).value;
    let codes;
    if (scopeVal === "filtered") {
      codes = list.map((x) => x.code);
    } else if (scopeVal === "selected") {
      codes = state.products
        .filter((p) => state.selectedProducts.has(p.id))
        .map((x) => x.code);
    } else if (scopeVal === "manual") {
      const { valid } = parseEoCodes($("eoCodes").value);
      const validCodes = [...new Set(valid)].filter((c) => matchedByCode.has(c));
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

function checkGroupHtml(prefix, set, imgVisible) {
  return (
    PRODUCT_FIELDS.map((f) => {
      const locked = f.key === "code";
      return (
        `<label class="io-chip" ${locked ? 'title="编号固定显示"' : ""}>` +
        `<input type="checkbox" data-g="${prefix}" data-cfk="${f.key}" ${locked || set.has(f.key) ? "checked" : ""} ${locked ? "disabled" : ""} />${f.label}</label>`
      );
    }).join("") +
    `<label class="io-chip" title="商品图片列（列表为整列，画册为卡片主图）">` +
    `<input type="checkbox" data-g="${prefix}" data-cfk="image" ${imgVisible ? "checked" : ""} />图片</label>`
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
        <div class="io-chips">${checkGroupHtml("cur", toggle, imgVisible)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="csReset">复原默认（全部显示）</button>
          <button id="csCancel">取消</button>
          <button id="csSave" class="btn-teal">保存</button>
        </div>`);
  const recalc = () => {
    mask
      .querySelectorAll('[data-g="cur"]')
      .forEach((cb) => {
        if (cb.dataset.cfk === "image") {
          cb.checked = imgVisible;
        } else {
          cb.checked = toggle.has(cb.dataset.cfk);
        }
      });
  };
  $("csListAll").onclick = () => {
    PRODUCT_FIELDS.forEach((f) => toggle.add(f.key));
    imgVisible = true;
    recalc();
  };
  $("csListNone").onclick = () => {
    toggle.clear();
    toggle.add("code");
    imgVisible = false;
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
      cb.checked ? toggle.add(cb.dataset.cfk) : toggle.delete(cb.dataset.cfk);
    };
  });
  $("csReset").onclick = async () => {
    if (await confirmBox(`复原默认：${keyName}显示全部字段？`)) {
      PRODUCT_FIELDS.forEach((f) => toggle.add(f.key));
      imgVisible = true;
      recalc();
    }
  };
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
  const canPaste = !!appClipboard || !!(navigator.clipboard && navigator.clipboard.readText);
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
      ? `<div class="ctx-item" data-pctx="off">下架（置灰不删除）</div>`
      : `<div class="ctx-item" data-pctx="on">上架恢复出售</div>`) +
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
      label: "📋 复制封面图",
      run: () => {
        copyImageFromDataUrl(coverData).then((ok) =>
          ok ? toast("已复制封面图") : toast("复制失败"),
        );
      },
    });
  }
  items.push({ label: "🔍 查看大图", run: () => openLightbox(p) });
  showImageCtxMenu(e.clientX, e.clientY, items);
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
