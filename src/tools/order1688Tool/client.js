// 1688订单提取 - 前端逻辑（粘贴自动解析、可编辑预览、订单记录、导出采集表）
(function () {
  const vscode =
    window.__vscode || (window.acquireVsCodeApi ? window.acquireVsCodeApi() : null);
  const TOOL = "order1688Tool";

  const PREVIEW_COLS = [
    { key: "collectDate", label: "采集日期", w: "100px" },
    { key: "orderNo", label: "订单号", w: "150px" },
    { key: "supplier", label: "供应商", w: "150px" },
    { key: "huohao", label: "货号", w: "90px" },
    { key: "name", label: "货品名称", w: "220px" },
    { key: "spec", label: "规格", w: "140px" },
    { key: "qty", label: "数量", w: "60px" },
    { key: "price", label: "单价(元)", w: "80px" },
    { key: "pay", label: "实付款(元)", w: "90px" },
    { key: "status", label: "状态", w: "100px" },
  ];

  const REC_COLS = [
    { key: "order_no", label: "订单号", w: "150px" },
    { key: "collect_date", label: "采集日期", w: "100px" },
    { key: "supplier", label: "供应商", w: "160px" },
    { key: "pay_amount", label: "实付款(元)", w: "100px", num: true },
    { key: "item_count", label: "明细数", w: "70px", num: true },
  ];

  let state = {
    previewRows: [],
    rowSel: new Set(),
    firstSel: 0,
    orders: [],
    fText: "",
    recSel: new Set(),
    recFirstSel: 0,
    expandedNo: new Set(),
  };
  let toastTimer = null;

  const CLIENT_VERSION = "v8";

  function post(msg) {
    if (vscode) {vscode.postMessage(msg);}
  }
  function warn(text) {
    post({ type: "log", text });
  }

  function init() {
    bindTabs();
    bindPreview();
    bindRecords();
    post({ type: "log", text: `📥1688前端就绪 ${CLIENT_VERSION}` });
    post({ type: "loadOrders", toolName: TOOL });
  }

  function onMessage(msg) {
    if (msg.type === "parsed") {
      let rowsArr = [];
      let src = "";
      if (typeof msg.ordersDump === "string" && msg.ordersDump) {
        try {
          const d = JSON.parse(msg.ordersDump);
          rowsArr = Array.isArray(d) ? d : [];
          src = "dump";
        } catch (e) {
          post({ type: "log", text: `🚨ordersDump JSON 解析失败：${e.message}` });
        }
      }
      if (rowsArr.length === 0 && Array.isArray(msg.orders)) {
        rowsArr = msg.orders;
        src = "array";
      }
      setPreviewRows(rowsArr);
      const n = state.previewRows.length;
      const m = new Set(state.previewRows.map((r) => r.orderNo).filter(Boolean)).size;
      const sample = (rowsArr[0] && rowsArr[0].orderNo) || "";
      post({ type: "log", text: n > 0
        ? `📋parsed=${msg.runId || "?"}（${src}）：${n} 行 · ${m} 单，首行订单号 ${sample}`
        : `🚨parsed=${msg.runId || "?"} 仍为空；orders=${Array.isArray(msg.orders) ? msg.orders.length : "非数组"} dumpLen=${typeof msg.ordersDump === "string" ? msg.ordersDump.length : 0} raw=${JSON.stringify(msg).slice(0, 120)}` });
    } else if (msg.type === "importResult") {
      clearPreview();
    } else if (msg.type === "ordersLoaded") {
      state.orders = msg.orders || [];
      renderRecords();
    }
  }

  const handledMsg = new WeakSet();
  function dispatch(msg) {
    if (msg && typeof msg === "object") {
      if (handledMsg.has(msg)) {return;}
      handledMsg.add(msg);
    }
    onMessage(msg);
  }

  window.toolClients = window.toolClients || {};
  window.toolClients[TOOL] = { init, onMessage: dispatch, _isReady: true };

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") {return;}
    if (d.type === "parsed" || d.type === "ordersLoaded" || d.type === "importResult") {
      dispatch(d);
    }
  });

  function bindTabs() {
    document.querySelectorAll(".sub-tab").forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll(".sub-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".sub-panel").forEach((p) => p.classList.remove("show"));
        tab.classList.add("active");
        const target = document.getElementById(tab.dataset.sub);
        if (target) {target.classList.add("show");}
      };
    });
  }

  // ============ 抓取入库 ============
  function bindPreview() {
    const ta = document.getElementById("o8_text");
    ta.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") {return;}
      e.preventDefault();
      const v = ta.value;
      if (!v.trim()) {
        warn("粘贴区为空");
        return;
      }
      post({ type: "parse", toolName: TOOL, text: v });
    });
    document.getElementById("o8_btnParse").onclick = () => {
      const v = ta.value;
      if (!v.trim()) {
        warn("粘贴区为空");
        return;
      }
      post({ type: "parse", toolName: TOOL, text: v });
    };
    document.getElementById("o8_btnClearText").onclick = () => {
      ta.value = "";
    };
    document.getElementById("o8_btnImport").onclick = () => {
      if (state.previewRows.length === 0) {
        warn("预览区为空，请先粘贴 1688 订单文本");
        return;
      }
      const rows = state.previewRows.map((r) => ({
        collectDate: String(r.collectDate || ""),
        orderNo: String(r.orderNo || "").trim(),
        orderTime: String(r.orderTime || ""),
        supplier: String(r.supplier || ""),
        huohao: String(r.huohao || ""),
        name: String(r.name || ""),
        spec: String(r.spec || ""),
        qty: String(r.qty || ""),
        price: String(r.price || ""),
        pay: String(r.pay || ""),
        status: String(r.status || ""),
      }));
      const valid = rows.filter((r) => r.orderNo);
      if (valid.length !== rows.length) {
        warn(`⚠${rows.length - valid.length} 行缺少订单号，已丢弃这些行`);
      }
      if (valid.length === 0) {
        warn("没有可入库的行（订单号为空）");
        return;
      }
      post({ type: "importOrders", toolName: TOOL, rows: valid });
    };
    document.getElementById("o8_btnDelSel").onclick = () => {
      const idx = Array.from(state.rowSel).sort((a, b) => b - a);
      for (const i of idx) {state.previewRows.splice(i, 1);}
      state.rowSel.clear();
      renderPreview();
    };

    const wrapPv = document.getElementById("o8_previewWrap");
    if (wrapPv) {
      wrapPv.addEventListener("change", (e) => {
        const cb = e.target.closest("input[data-row]");
        if (!cb) {return;}
        if (cb.dataset.row === "all") {
          if (cb.checked) {
            for (let i = 0; i < state.previewRows.length; i++) {state.rowSel.add(i);}
          } else {
            state.rowSel.clear();
          }
        } else {
          const i = Number(cb.dataset.row);
          if (cb.checked) {state.rowSel.add(i);}
          else {state.rowSel.delete(i);}
        }
        renderPreviewCheckboxes();
        updatePreviewSel();
        updatePreviewStats();
      });
      wrapPv.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) {return;}
        const tr = btn.closest("tr[data-row]");
        if (!tr) {return;}
        const i = Number(tr.dataset.row);
        state.previewRows.splice(i, 1);
        state.rowSel.delete(i);
        renderPreview();
      });
      wrapPv.addEventListener("focusout", (e) => {
        const td = e.target.closest("td[data-col]");
        if (!td) {return;}
        const i = Number(td.dataset.row);
        const col = td.dataset.col;
        if (state.previewRows[i]) {
          state.previewRows[i][col] = td.textContent.trim();
        }
      });
    }
  }

  function updatePreviewStats() {
    const rows = state.previewRows.length;
    const sel = state.rowSel.size;
    let text = rows === 0 ? "尚未粘贴" : `已解析 ${rows} 行 · ${new Set(state.previewRows.map((r) => r.orderNo).filter(Boolean)).size} 单`;
    if (sel) {text += ` ｜ 已选 ${sel} 行`;}
    const cnt = document.getElementById("o8_previewStats");
    if (cnt) {cnt.textContent = text;}
  }

  function updatePreviewSel() {
    const n = state.rowSel.size;
    const cnt = document.getElementById("o8_previewCount");
    if (cnt) {cnt.textContent = n ? `已选 ${n} 行` : "";}
    const btn = document.getElementById("o8_btnDelSel");
    if (btn) {btn.style.display = n ? "" : "none";}
  }

  function renderPreviewCheckboxes() {
    const wrap = document.getElementById("o8_previewWrap");
    if (!wrap) {return;}
    wrap.querySelectorAll("input[data-row]").forEach((cb) => {
      if (cb.dataset.row === "all") {
        cb.checked = state.previewRows.length > 0 && state.rowSel.size === state.previewRows.length;
      } else {
        cb.checked = state.rowSel.has(Number(cb.dataset.row));
      }
    });
  }

  function setPreviewRows(rows) {
    state.previewRows = rows;
    state.rowSel.clear();
    renderPreview();
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderPreview() {
    const wrap = document.getElementById("o8_previewWrap");
    if (!wrap) {return;}
    updatePreviewSel();
    const rows = state.previewRows;
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="empty-hint">暂无解析结果。粘贴 1688 订单文本（Ctrl+V 或 右键→粘贴）后，表格会出现在这里。</div>';
      updatePreviewStats();
      return;
    }

    let ok = false;
    try {
      const heads = PREVIEW_COLS
        .map((f) => `<th style="width:${f.w}">${esc(f.label)}</th>`)
        .join("");
      const headChecked = state.rowSel.size === rows.length ? " checked" : "";
      let bodyHtml = "";
      rows.forEach((r, i) => {
        const checked = state.rowSel.has(i) ? " checked" : "";
        const cols = PREVIEW_COLS
          .map((f) => {
            const cls = f.key === "qty" || f.key === "price" || f.key === "pay" ? "editable num" : "editable";
            return `<td class="${cls}" data-row="${i}" data-col="${f.key}" contenteditable="true">${esc(r[f.key])}</td>`;
          })
          .join("");
        bodyHtml +=
          `<tr data-row="${i}">` +
          `<td class="sel-col"><input type="checkbox" data-row="${i}"${checked}></td>` +
          cols +
          `<td class="actions"><button class="btn-danger" title="删除该行">🗑</button></td></tr>`;
      });
      wrap.innerHTML =
        `<table class="data-table"><thead><tr>` +
        `<th class="sel-col"><input type="checkbox" data-row="all"${headChecked} title="全选"></th>` +
        heads +
        `<th style="width:70px">操作</th>` +
        `</tr></thead><tbody id="o8_previewBody">${bodyHtml}</tbody></table>`;

      wrap.scrollIntoView({ block: "nearest" });
      ok = true;
    } catch (err) {
      wrap.innerHTML = `<div class="empty-hint">⚠解析到 ${rows.length} 行，但预览表格渲染出错：${esc(String((err && err.message) || err))}。请清空后重试，或检查粘贴文本格式。</div>`;
    }
    updatePreviewSel();
    updatePreviewStats();
  }

  function clearPreview() {
    setPreviewRows([]);
  }

  // ============ 订单记录 ============
  function bindRecords() {
    document.getElementById("o8_fText").addEventListener("input", (e) => {
      state.fText = e.target.value.trim();
      renderRecords();
    });
    document.getElementById("o8_btnClearFilter").onclick = () => {
      state.fText = "";
      document.getElementById("o8_fText").value = "";
      renderRecords();
    };
    document.getElementById("o8_btnRecDelSel").onclick = () => {
      const ids = Array.from(state.recSel);
      if (ids.length === 0) {return;}
      post({ type: "deleteOrders", toolName: TOOL, ids });
      state.recSel.clear();
      state.recFirstSel = 0;
    };
    document.getElementById("o8_btnExport").onclick = () => {
      post({ type: "exportExcel", toolName: TOOL });
    };
    document.body.addEventListener("contextmenu", (e) => {
      const items = buildCtxMenuFor(e.target);
      if (items) {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, items);
      } else {
        hideCtxMenu();
      }
    });
    document.addEventListener("click", () => hideCtxMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {hideCtxMenu();}
    });
    window.addEventListener("blur", () => hideCtxMenu());
  }

  // 根据右键点击的元素决定菜单内容（textarea 粘贴 / 预览单元格 / 订单记录复制）
  function buildCtxMenuFor(target) {
    if (!target || !target.closest) {return null;}
    const ta = target.closest("#o8_text");
    if (ta) {
      return [
        { label: "📌 粘贴", run: () => pasteIntoTextarea(ta) },
        { label: "📋 复制全部", run: () => copyTextareaAll(ta) },
        { label: "🧹 清空文本", run: () => clearTextAndPreview() },
      ];
    }
    const cell = target.closest("td[data-col]");
    if (cell) {
      return [
        { label: "📌 粘贴到此格", run: () => pasteIntoCell(cell) },
        { label: "📋 复制此格", run: () => copyCell(cell) },
      ];
    }
    const td = target.closest("td[data-recid]");
    const th = target.closest("th[data-key]");
    if (td || th) {
      if (td) {
        return [
          { label: "📋 复制整行", run: () => copyRecRow(String(td.dataset.recid)) },
          { label: "📋 复制整表", run: () => copyRecTable() },
        ];
      }
      return [{ label: "📋 复制整表", run: () => copyRecTable() }];
    }
    return null;
  }

  function pasteIntoTextarea(ta) {
    const commit = (text) => {
      if (!text) {
        showToast("剪贴板为空");
        return;
      }
      const s = ta.selectionStart ?? ta.value.length;
      const e = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      const end = s + text.length;
      ta.setSelectionRange(end, end);
      ta.focus();
      post({ type: "parse", toolName: TOOL, text: ta.value });
      showToast(`已粘贴 ${text.length} 字符，正在解析…`);
    };
    readClipboard().then(commit, () => {
      fallbackPasteViaExec(ta);
    });
  }

  function pasteIntoCell(cell) {
    const commit = (text) => {
      if (!text) {return;}
      cell.textContent = text;
      const i = Number(cell.dataset.row);
      const col = cell.dataset.col;
      if (state.previewRows[i]) {
        state.previewRows[i][col] = text;
      }
      showToast("已粘贴到此格");
    };
    readClipboard().then(commit, () => {
      fallbackPasteViaExec(cell);
    });
  }

  function readClipboard() {
    return new Promise((resolve, reject) => {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(resolve, reject);
      } else {
        reject(new Error("no-api"));
      }
    });
  }

  function fallbackPasteViaExec(el) {
    try {
      el.focus();
      const ok = document.execCommand("paste");
      if (ok) {return;}
    } catch (err) { /* 继续走提示 */ }
    showToast("⚡无法读取剪贴板，请按 Ctrl+V 粘贴");
  }

  function copyTextareaAll(ta) {
    copyToClipboard(ta.value.trim() || "", "已复制文本");
  }

  function copyCell(cell) {
    copyToClipboard((cell.textContent || "").trim(), "已复制此格");
  }

  function clearTextAndPreview() {
    const ta = document.getElementById("o8_text");
    if (ta) {ta.value = "";}
    clearPreview();
  }

  function filteredOrders() {
    const q = state.fText.toLowerCase();
    if (!q) {return state.orders;}
    return state.orders.filter(
      (o) =>
        String(o.order_no).toLowerCase().includes(q) ||
        String(o.supplier).toLowerCase().includes(q) ||
        String(o.collect_date).toLowerCase().includes(q),
    );
  }

  function renderRecords() {
    const head = document.getElementById("o8_recHead");
    const body = document.getElementById("o8_recBody");
    const empty = document.getElementById("o8_recEmpty");
    head.innerHTML = "";
    body.innerHTML = "";
    state.recSel = new Set(Array.from(state.recSel).filter((id) => state.orders.some((o) => o.id === id)));
    const n = state.recSel.size;

    const htr = document.createElement("tr");
    const selTh = document.createElement("th");
    selTh.className = "sel-col";
    const selAll = document.createElement("input");
    selAll.type = "checkbox";
    selAll.checked = n > 0 && n === state.orders.length;
    selAll.onchange = () => {
      if (selAll.checked) {
        state.recSel = new Set(state.orders.map((o) => o.id));
      } else {
        state.recSel.clear();
      }
      renderRecords();
    };
    selTh.appendChild(selAll);
    htr.appendChild(selTh);
    REC_COLS.forEach((f) => {
      const th = document.createElement("th");
      th.style.width = f.w;
      th.dataset.key = f.key;
      th.textContent = f.label;
      htr.appendChild(th);
    });
    const opTh = document.createElement("th");
    opTh.textContent = "明细";
    opTh.style.width = "100px";
    htr.appendChild(opTh);
    head.appendChild(htr);

    const rows = filteredOrders();
    if (rows.length === 0) {
      empty.style.display = "block";
      updateRecSel(n);
      return;
    }
    empty.style.display = "none";

    rows.forEach((o) => {
      const tr = document.createElement("tr");
      tr.dataset.id = o.id;
      const selTd = document.createElement("td");
      selTd.className = "sel-col";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.recSel.has(o.id);
      cb.onchange = () => {
        if (cb.checked) {state.recSel.add(o.id);}
        else {state.recSel.delete(o.id);}
        updateRecSel(state.recSel.size);
      };
      selTd.appendChild(cb);
      tr.appendChild(selTd);

      const values = {
        order_no: o.order_no,
        collect_date: o.collect_date,
        supplier: o.supplier,
        pay_amount: o.pay_amount !== null && o.pay_amount !== undefined ? String(o.pay_amount) : "",
        item_count: o.items ? o.items.length : 0,
      };
      REC_COLS.forEach((f) => {
        const td = document.createElement("td");
        td.dataset.recid = o.id;
        td.className = f.num ? "num" : "";
        td.textContent = values[f.key];
        tr.appendChild(td);
      });

      const op = document.createElement("td");
      op.className = "actions";
      const toggle = document.createElement("button");
      toggle.textContent = state.expandedNo.has(o.order_no) ? "🔼收起" : "🔽明细";
      toggle.onclick = () => {
        if (state.expandedNo.has(o.order_no)) {state.expandedNo.delete(o.order_no);}
        else {state.expandedNo.add(o.order_no);}
        renderRecords();
      };
      op.appendChild(toggle);
      const delBtn = document.createElement("button");
      delBtn.className = "btn-danger";
      delBtn.textContent = "🗑";
      delBtn.title = "删除该订单";
      delBtn.onclick = () => {
        post({ type: "deleteOrders", toolName: TOOL, ids: [o.id] });
      };
      op.appendChild(delBtn);
      tr.appendChild(op);
      body.appendChild(tr);

      if (state.expandedNo.has(o.order_no)) {
        const dtr = document.createElement("tr");
        dtr.className = "detail-row";
        const dtd = document.createElement("td");
        dtd.colSpan = REC_COLS.length + 2;
        const wrap = document.createElement("div");
        wrap.className = "detail-wrap";
        const items = o.items || [];
        if (items.length === 0) {
          const p = document.createElement("p");
          p.className = "empty-hint";
          p.style.padding = "8px";
          p.textContent = "（该订单无商品明细）";
          wrap.appendChild(p);
        } else {
          const it = document.createElement("table");
          const ih = document.createElement("thead");
          const itr = document.createElement("tr");
          ["货号", "货品名称", "规格", "数量", "单价(元)"].forEach((t) => {
            const th = document.createElement("th");
            th.textContent = t;
            itr.appendChild(th);
          });
          ih.appendChild(itr);
          it.appendChild(ih);
          const ib = document.createElement("tbody");
          items.forEach((x) => {
            const r = document.createElement("tr");
            [x.huohao || "", x.name || "", x.spec || "", x.qty ?? "", x.price ?? ""].forEach((v) => {
              const c = document.createElement("td");
              c.textContent = String(v);
              r.appendChild(c);
            });
            ib.appendChild(r);
          });
          it.appendChild(ib);
          wrap.appendChild(it);
        }
        dtd.appendChild(wrap);
        dtr.appendChild(dtd);
        body.appendChild(dtr);
      }
    });
    updateRecSel(n);
  }

  function updateRecSel(n) {
    const cnt = document.getElementById("o8_recCount");
    const btn = document.getElementById("o8_btnRecDelSel");
    cnt.textContent = n ? `已选 ${n} 个订单` : "";
    btn.style.display = n ? "" : "none";
  }

  function copyRecRow(rid) {
    const o = state.orders.find((x) => String(x.id) === rid);
    if (!o) {return;}
    const items = o.items || [];
    if (items.length === 0) {return;}
    const lines = [["采集日期", "订单号", "下单时间", "供应商名称", "货号", "货品名称", "规格", "数量", "单价(元)", "本订单实付款(元)"].join("\t")];
    items.forEach((x) => {
      lines.push(
        [
          o.collect_date,
          o.order_no,
          o.order_time || " ",
          o.supplier || " ",
          x.huohao || " ",
          x.name || " ",
          x.spec || " ",
          x.qty ?? " ",
          x.price ?? " ",
          o.pay_amount ?? " ",
        ]
          .map((v) => (v === "" ? " " : v))
          .join("\t"),
      );
    });
    copyToClipboard(lines.join("\n"), `已复制整行「${o.order_no}」(${items.length} 行)`);
  }

  function copyRecTable() {
    const rows = filteredOrders();
    if (rows.length === 0) {return;}
    const lines = [["订单号", "采集日期", "供应商", "实付款(元)", "明细数"].join("\t")];
    rows.forEach((o) => {
      lines.push([o.order_no, o.collect_date, o.supplier || " ", o.pay_amount ?? " ", o.items ? o.items.length : 0].join("\t"));
    });
    copyToClipboard(lines.join("\n"), `已复制订单列表(${rows.length} 单)`);
  }

  function copyToClipboard(text, msg) {
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:2px;height:2px;opacity:0;";
      document.body.appendChild(ta);
      const active = document.activeElement;
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      ta.remove();
      if (active && active.focus) {active.focus();}
      showToast(ok ? msg : "❌复制失败，请手动 Ctrl+C");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(msg), fallback);
    } else {
      fallback();
    }
  }

  function showToast(text) {
    if (window.showGlobalToast) {
      window.showGlobalToast(text);
      return;
    }
    const t = document.getElementById("o8_toast");
    if (!t) {return;}
    t.textContent = text;
    t.classList.add("show");
    if (toastTimer) {clearTimeout(toastTimer);}
    toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
  }

  function showCtxMenu(x, y, items) {
    const menu = document.getElementById("o8_ctxMenu");
    menu.innerHTML = "";
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      b.onclick = (e) => {
        e.stopPropagation();
        hideCtxMenu();
        it.run();
      };
      menu.appendChild(b);
    });
    menu.style.display = "block";
    menu.style.left = "-9999px";
    menu.style.top = "-9999px";
    const r = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth) {left = window.innerWidth - r.width - 8;}
    if (top + r.height > window.innerHeight) {top = window.innerHeight - r.height - 8;}
    if (left < 0) {left = 4;}
    if (top < 0) {top = 4;}
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  function hideCtxMenu() {
    const menu = document.getElementById("o8_ctxMenu");
    if (menu) {menu.style.display = "none";}
  }
})();