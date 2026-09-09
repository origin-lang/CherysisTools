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

    function filteredProducts() {
      const status = $("filterStatus")?.value || "all";
      const cat = $("filterCat")?.value || "";
      const series = $("filterSeries")?.value || "";
      return state.products
        .filter((p) =>
          status === "all"
            ? true
            : status === "on"
              ? p.status === 0
              : p.status === 1,
        )
        .filter((p) => !cat || p.category === cat)
        .filter((p) => !series || p.series === series)
        .filter((p) => {
          const kw = String(filters.keyword || "").trim().toLowerCase();
          if (!kw) {
            return true;
          }
          const kwDigits = kw.replace(/\D/g, "");
          const codeDigits = p.code.replace(/\D/g, "");
          const hay = `${p.code} ${p.name} ${p.category} ${p.series}`.toLowerCase();
          return (
            hay.includes(kw) ||
            (kwDigits.length > 0 && codeDigits.includes(kwDigits))
          );
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
        status: $("filterStatus")?.value || "all",
        cat: $("filterCat")?.value || "",
        series: $("filterSeries")?.value || "",
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

    function renderList(list) {
      const vis = PRODUCT_FIELDS.filter((f) => visList.has(f.key));
      const plIdx = vis.findIndex((f) => f.key === "purchase_link");
      const imgAt = plIdx >= 0 ? plIdx : vis.length;
      const headCols = [];
      for (let i = 0; i < vis.length; i++) {
        if (i === imgAt) {
          headCols.push(`<th>图片</th>`);
        }
        const f = vis[i];
        headCols.push(
          `<th data-sort="${f.key}">${f.label}${sortKey === f.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}</th>`,
        );
      }
      if (imgAt >= vis.length) {
        headCols.push(`<th>图片</th>`);
      }
      headCols.push(`<th>操作</th>`);
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
                     <button class="mini-btn" id="batchCopy" title="把选中的商品按当前可见列复制到剪贴板（带表头）">📋 复制选中</button>
                     <button class="mini-btn" id="batchOn" title="上架选中的商品">🔺 上架</button>
                    <button class="mini-btn" id="batchOff" title="下架选中的商品">🔻 下架</button>
                    <button class="mini-btn btn-danger" id="batchDel" title="删除选中的商品（含记录，不可恢复）">🗑 删除</button>
                    <button class="mini-btn" id="batchClear" title="取消全部选择">✕ 取消</button>
                  </div>`
               : ""}
             <div class="table-wrap"><table class="data-table"><thead><tr>
               <th style="width:30px"><input type="checkbox" id="selectAllProducts" ${list.length === 0 ? "disabled" : ""} ${allSelected ? "checked" : ""} title="全选 / 取消全选" /></th>
               ${headCols.join("")}
             </tr></thead><tbody>${body}</tbody></table></div>
             <div class="muted" style="margin-top:4px">双击单元格编辑（回车或点击别处即保存）；右键行/表格复制</div>`;
      bindBatchOps();
    }

    function hasFilter() {
      return (
        Object.values(filters).some((v) => String(v).trim().length > 0) ||
        ($("filterStatus")?.value || "all") !== "all" ||
        !!($("filterCat")?.value || "") ||
        !!($("filterSeries")?.value || "")
      );
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
      const batchCopy = $("batchCopy");

      if (batchCopy) {
        batchCopy.onclick = copySelectedProducts;
      }

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

    function copySelectedProducts() {
      const rows = state.products.filter((p) =>
        state.selectedProducts.has(p.id),
      );
      if (rows.length === 0) {
        toast("先勾选要复制的商品");
        return;
      }
      const keys = PRODUCT_FIELDS.map((f) => f.key).filter((k) =>
        visList.has(k),
      );
      const lines = [
        keys
          .map((k) => PRODUCT_FIELDS.find((f) => f.key === k).label)
          .join("\t"),
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
                  ${coverData ? `<img src="${coverData}" />` : `<div class="ph">暂无图片</div>`}
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
          toast("已保存");
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

    function populateFilters() {
      const trendAll = state.products.map(
        (p) => `${p.id}|${p.code}|${p.name}`,
      );
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
            (p) =>
              `<option value="${p.id}">${esc(p.code)} ${esc(p.name)}</option>`,
          )
          .join("");
      trendSel.value = curP;
      fillCatList();
      const fillSel = (selId, valOf) => {
        const sel = $(selId);
        if (!sel) {
          return;
        }
        const cur = sel.value;
        const opts = [
          ...new Set(
            state.products.map((p) => p[valOf]).filter((v) => v && String(v).trim()),
          ),
        ].sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));
        sel.innerHTML =
          `<option value="">${selId === "filterCat" ? "全部品类" : "全部系列"}</option>` +
          opts
            .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)
            .join("");
        sel.value = cur;
      };
      fillSel("filterCat", "category");
      fillSel("filterSeries", "series");
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
        <p class="muted">每行一商品，列顺序：<b>编号, 名称, 品类, 系列, 等级, 进价, 售价, 采购链接</b>；Tab 或空格或逗号分隔；只要「编号」也能建（其余走默认）。名称内不要用空格（空格=列分隔符）。已有编号跳过；原名称空缺时会补填名称。</p>
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
      menu.innerHTML =
        `<div class="ctx-item" data-copy="row">复制整行</div>` +
        `<div class="ctx-item" data-copy="table">复制整表(筛选后)</div>` +
        `<div style="border-top:1px solid var(--vscode-panel-border);margin:3px 0"></div>` +
        (p.status === 0
          ? `<div class="ctx-item" data-pctx="off">下架（置灰不删除）</div>`
          : `<div class="ctx-item" data-pctx="on">上架恢复出售</div>`) +
        `<div class="ctx-item" data-pctx="clearimg">清空图片文件夹…</div>`;
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
        confirmBox(
          `确认清空 ${p.code} 的图片文件夹？（文件会真的删除）`,
        ).then((ok) => {
          if (ok) {
            post({ type: "clearImages", code: p.code });
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
        const p = state.products.find(
          (x) => x.id === Number(coverEl.dataset.id),
        );
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
      openContextMenu(e, p);
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
