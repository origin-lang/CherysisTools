// 供应商采购管理 - 前端逻辑（行内编辑 + 列头筛选 + 批量删除 + 分析视图）
(function () {
  const vscode =
    window.__vscode || (window.acquireVsCodeApi ? window.acquireVsCodeApi() : null);

  const RELATIONSHIPS = ["待评估", "进行中", "已终止"];
  const ORDER_STATUSES = ["已下单", "已签收", "待退款", "待退货", "已结束"];

  let state = {
    suppliers: [],
    orders: [],
    // 排序
    sSortCol: null,
    sSortDir: "asc",
    oSortCol: null,
    oSortDir: "desc",
    // 筛选
    sFilters: { name: "", free_shipping: "", relationship: "", quality_desc: "" },
    oFilters: {
      order_no: "",
      supplier_id: "",
      pay_min: "",
      pay_max: "",
      receive_from: "",
      receive_to: "",
      deadline_from: "",
      deadline_to: "",
      paid_min: "",
      paid_max: "",
      status: "",
    },
    // 选择（批量删除）
    sSel: new Set(),
    oSel: new Set(),
    sSelAll: false,
    oSelAll: false,
    // 撤销/重做是否可用（后端回包带 undoAvailable / redoAvailable）
    canUndo: false,
    canRedo: false,
  };
  let pendingMessages = [];
  let currentTab = "supplier";
  let activeEditor = null;

  // 列定义：显示顺序；filter 描述列头筛选控件
  const SUPPLIER_FIELDS = [
    { key: "name", label: "厂商", w: "200px", type: "text", required: true, filter: "text", fKeys: ["name"] },
    { key: "free_shipping", label: "是否包邮", w: "90px", type: "bool", filter: "boolSel" },
    { key: "relationship", label: "合作关系", w: "100px", type: "select", options: RELATIONSHIPS, filter: "sel", fOptions: RELATIONSHIPS },
    { key: "quality_desc", label: "产品质量", w: "260px", type: "text", ellipsis: 120, filter: "text", fKeys: ["quality_desc"] },
  ];
  const ORDER_FIELDS = [
    { key: "order_no", label: "订单编号", w: "110px", type: "text", filter: "text", fKeys: ["order_no"] },
    { key: "supplier_id", label: "供应商", w: "140px", type: "supplierSelect", filter: "supplierSel" },
    { key: "pay_amount", label: "付款金额", w: "132px", type: "number", numeric: true, filter: "numRange", minKey: "pay_min", maxKey: "pay_max" },
    { key: "receive_time", label: "签收时间", w: "150px", type: "date", filter: "dateRange", fromKey: "receive_from", toKey: "receive_to" },
    { key: "deadline", label: "截止时间", w: "150px", type: "date", filter: "dateRange", fromKey: "deadline_from", toKey: "deadline_to" },
    { key: "paid_amount", label: "实付金额", w: "132px", type: "number", numeric: true, filter: "numRange", minKey: "paid_min", maxKey: "paid_max" },
    { key: "status", label: "状态", w: "100px", type: "select", options: ORDER_STATUSES, filter: "sel", fOptions: ORDER_STATUSES },
  ];

  function post(msg) {
    if (vscode) {vscode.postMessage(msg);}
  }

  function postUndo() {
    post({ type: "undoRequest", toolName: "procurementTool" });
  }

  function postRedo() {
    post({ type: "redoRequest", toolName: "procurementTool" });
  }

  function applyUndoState(avail, redoAvail) {
    state.canUndo = !!avail;
    state.canRedo = !!redoAvail;
    ["pm_btnUndo", "pm_btnUndoOrders"].forEach((id) => {
      const b = document.getElementById(id);
      if (b) {b.disabled = !state.canUndo;}
    });
    ["pm_btnRedo", "pm_btnRedoOrders"].forEach((id) => {
      const b = document.getElementById(id);
      if (b) {b.disabled = !state.canRedo;}
    });
  }

  function init() {
    bindTabs();
    bindSupplierActions();
    bindOrderActions();
    bindAnalysis();
    attachTableEvents();
    attachFilterEvents();
    attachContextMenu();
    post({ type: "loadSuppliers", toolName: "procurementTool" });
    post({ type: "loadOrders", toolName: "procurementTool" });
    while (pendingMessages.length > 0) {
      onMessage(pendingMessages.shift());
    }
  }

  function bindTabs() {
    document.querySelectorAll(".sub-tab").forEach((tab) => {
      tab.onclick = () => {
        const sub = tab.dataset.sub;
        document.querySelectorAll(".sub-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".sub-panel").forEach((p) => p.classList.remove("show"));
        tab.classList.add("active");
        const target = document.getElementById(sub);
        if (target) {target.classList.add("show");}
        currentTab = sub === "tabSupplier" ? "supplier" : sub === "tabOrder" ? "order" : "analysis";
        if (currentTab === "analysis") {renderAnalysis();}
      };
    });
  }

  // ============ 工具栏 ============
  function bindSupplierActions() {
    document.getElementById("pm_btnAddSupplier").onclick = () => startAddRow("supplier");
    document.getElementById("pm_btnUndo").onclick = () => postUndo();
    document.getElementById("pm_btnRedo").onclick = () => postRedo();
    document.getElementById("pm_btnImportSuppliers").onclick = () =>
      post({ type: "importSuppliers", toolName: "procurementTool" });
    document.getElementById("pm_btnExportSuppliers").onclick = () =>
      post({ type: "exportSuppliers", toolName: "procurementTool" });
    document.getElementById("pm_btnExportDB").onclick = () =>
      post({ type: "exportDB", toolName: "procurementTool" });
    document.getElementById("pm_btnImportDB").onclick = () =>
      post({ type: "importDB", toolName: "procurementTool" });
    document.getElementById("pm_btnClearSupplierFilter").onclick = () => {
      state.sFilters = { name: "", free_shipping: "", relationship: "", quality_desc: "" };
      renderSuppliers();
    };
    document.getElementById("pm_btnSupplierDelSel").onclick = () => {
      const ids = Array.from(state.sSel);
      post({ type: "deleteSuppliers", toolName: "procurementTool", ids });
      state.sSel.clear();
      updateSSelUI();
    };
  }

  function bindOrderActions() {
    document.getElementById("pm_btnAddOrder").onclick = () => startAddRow("order");
    document.getElementById("pm_btnUndoOrders").onclick = () => postUndo();
    document.getElementById("pm_btnRedoOrders").onclick = () => postRedo();
    document.getElementById("pm_btnImportOrders").onclick = () =>
      post({ type: "importOrders", toolName: "procurementTool" });
    document.getElementById("pm_btnExportOrders").onclick = () =>
      post({ type: "exportOrders", toolName: "procurementTool" });
    document.getElementById("pm_btnClearOrderFilter").onclick = () => {
      state.oFilters = {
        order_no: "",
        supplier_id: "",
        pay_min: "",
        pay_max: "",
        receive_from: "",
        receive_to: "",
        deadline_from: "",
        deadline_to: "",
        paid_min: "",
        paid_max: "",
        status: "",
      };
      renderOrders();
    };
    document.getElementById("pm_btnOrderDelSel").onclick = () => {
      const ids = Array.from(state.oSel);
      post({ type: "deleteOrders", toolName: "procurementTool", ids });
      state.oSel.clear();
      updateOSelUI();
    };
  }

  // ============ 表格事件（双击编辑 + 选择） ============
  function attachTableEvents() {
    document.getElementById("pm_supplierBody").addEventListener("dblclick", (e) => {
      const td = e.target.closest("td[data-field]");
      if (!td) {return;}
      if (td.dataset.addRow === "1") {return;}
      const record = state.suppliers.find((s) => s.id === Number(td.dataset.id));
      if (!record) {return;}
      cancelActiveEditor();
      const field = td.dataset.field;
      const def = SUPPLIER_FIELDS.find((f) => f.key === field);
      const editor = buildEditor(td, record, "supplier", field, def);
      startEditor(editor);
    });
    document.getElementById("pm_orderBody").addEventListener("dblclick", (e) => {
      const td = e.target.closest("td[data-field]");
      if (!td) {return;}
      if (td.dataset.addRow === "1") {return;}
      const record = state.orders.find((o) => o.id === Number(td.dataset.id));
      if (!record) {return;}
      cancelActiveEditor();
      const field = td.dataset.field;
      const def = ORDER_FIELDS.find((f) => f.key === field);
      const editor = buildEditor(td, record, "order", field, def);
      startEditor(editor);
    });
    // 选择复选框（事件委托）
    document.getElementById("pm_supplierBody").addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-sel]");
      if (cb) {
        const id = Number(cb.dataset.id);
        if (cb.checked) {state.sSel.add(id);}
        else {state.sSel.delete(id);}
        updateSSelUI();
      }
    });
    document.getElementById("pm_orderBody").addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-sel]");
      if (cb) {
        const id = Number(cb.dataset.id);
        if (cb.checked) {state.oSel.add(id);}
        else {state.oSel.delete(id);}
        updateOSelUI();
      }
    });
  }

  function attachFilterEvents() {
    document.getElementById("pm_supplierFilter").addEventListener("input", (e) => {
      const el = e.target;
      if (!el.dataset.f) {return;}
      state.sFilters[el.dataset.f] = el.value;
      refreshSupplierBody();
    });
    document.getElementById("pm_orderFilter").addEventListener("input", (e) => {
      const el = e.target;
      if (!el.dataset.f) {return;}
      state.oFilters[el.dataset.f] = el.value;
      refreshOrderBody();
    });
    document.getElementById("pm_supplierFilter").addEventListener("change", (e) => {
      const el = e.target;
      if (el.dataset.f && el.tagName === "SELECT") {
        state.sFilters[el.dataset.f] = el.value;
        refreshSupplierBody();
      }
    });
    document.getElementById("pm_orderFilter").addEventListener("change", (e) => {
      const el = e.target;
      if (el.dataset.f && el.tagName === "SELECT") {
        state.oFilters[el.dataset.f] = el.value;
        refreshOrderBody();
      }
    });
  }

  // ============ 右键复制（整行 / 整列 / 整表） ============
  function attachContextMenu() {
    const menu = document.getElementById("pm_ctxMenu");
    if (!menu) {return;}
    const kindOfTable = (el) => {
      const table = el.closest("table");
      if (!table) {return null;}
      return table.id === "pm_orderTable" ? "order" : table.id === "pm_supplierTable" ? "supplier" : null;
    };
    const kindLabel = (kind) => (kind === "supplier" ? "供应商" : "订单");

    document.addEventListener("contextmenu", (e) => {
      let items = null;
      const td = e.target.closest("td[data-field]");
      const th = e.target.closest("th[data-key]");
      if (td && !td.dataset.addRow) {
        const kind = kindOfTable(td);
        if (kind) {
          const id = td.dataset.id;
          const key = td.dataset.field;
          items = [
            { label: "📋 复制整行", run: () => copyRowAsTsv(kind, id) },
            { label: "📋 复制整列", run: () => copyColumnAsTsv(kind, key) },
            { label: "📋 复制整表", run: () => copyTableAsTsv(kind) },
          ];
        }
      } else if (th) {
        const kind = kindOfTable(th);
        if (kind) {
          const key = th.dataset.key;
          items = [
            { label: "📋 复制整列", run: () => copyColumnAsTsv(kind, key) },
            { label: "📋 复制整表", run: () => copyTableAsTsv(kind) },
          ];
        }
      }
      if (items) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, items);
      } else {
        hideContextMenu();
      }
    });

    document.addEventListener("click", () => hideContextMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {hideContextMenu();}
    });
    window.addEventListener("blur", () => hideContextMenu());
    // 表格滚动时收起，避免菜单飘在原位
    ["pm_supplierTable", "pm_orderTable"].forEach((id) => {
      const wrap = document.getElementById(id);
      if (wrap) {wrap.addEventListener("scroll", () => hideContextMenu(), true);}
    });
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  function showContextMenu(x, y, items) {
    const menu = document.getElementById("pm_ctxMenu");
    menu.innerHTML = "";
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      b.onclick = (e) => {
        e.stopPropagation();
        hideContextMenu();
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

  function hideContextMenu() {
    const menu = document.getElementById("pm_ctxMenu");
    if (menu) {menu.style.display = "none";}
  }

  // 取该行的数据字段显示值数组（跳过复选框列/操作列）
  function rowValues(kind, record) {
    const fields = kind === "supplier" ? SUPPLIER_FIELDS : ORDER_FIELDS;
    return fields.map((f) => cellDisplayText(kind, f, record));
  }

  function copyRowAsTsv(kind, id) {
    const rec = (kind === "supplier" ? state.suppliers : state.orders)
      .find((x) => String(x.id) === String(id));
    if (!rec) {return;}
    const rows = currentRows(kind);
    const preview = rowValues(kind, rec).join(" ");
    copyToClipboard(rowValues(kind, rec).join("\t"), `已复制整行「${trimPreview(preview)}」`);
  }

  function copyColumnAsTsv(kind, key) {
    const fields = kind === "supplier" ? SUPPLIER_FIELDS : ORDER_FIELDS;
    const def = fields.find((f) => f.key === key);
    if (!def) {return;}
    const rows = currentRows(kind);
    const lines = [def.label];
    rows.forEach((r) => lines.push(cellDisplayText(kind, def, r)));
    copyToClipboard(lines.join("\n"), `已复制整列「${def.label}」(${rows.length} 行)`);
  }

  function copyTableAsTsv(kind) {
    const fields = kind === "supplier" ? SUPPLIER_FIELDS : ORDER_FIELDS;
    const rows = currentRows(kind);
    const lines = [fields.map((f) => f.label).join("\t")];
    rows.forEach((r) => lines.push(rowValues(kind, r).join("\t")));
    copyToClipboard(lines.join("\n"), `已复制整表(${rows.length} 行)`);
  }

  function trimPreview(s) {
    return s.length > 40 ? s.slice(0, 40) + "…" : s;
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
      try {ok = document.execCommand("copy");} catch (err) {ok = false;}
      ta.remove();
      if (active && active.focus) {active.focus();}
      showToast(ok ? msg : "❌复制失败，请手动 Ctrl+C");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast(msg),
        fallback,
      );
    } else {
      fallback();
    }
  }

  let toastTimer = null;
  function showToast(text) {
    if (window.showGlobalToast) {
      window.showGlobalToast(text);
      return;
    }
    const t = document.getElementById("pm_toast");
    if (!t) {return;}
    t.textContent = text;
    t.classList.add("show");
    if (toastTimer) {clearTimeout(toastTimer);}
    toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
  }

  // ============ 筛选逻辑 ============
  function matchSupplier(s) {
    const f = state.sFilters;
    if (f.name && !String(s.name).toLowerCase().includes(f.name.toLowerCase())) {return false;}
    if (f.free_shipping !== "" && (s.free_shipping ? 1 : 0) !== Number(f.free_shipping)) {return false;}
    if (f.relationship && s.relationship !== f.relationship) {return false;}
    if (f.quality_desc && !String(s.quality_desc).toLowerCase().includes(f.quality_desc.toLowerCase())) {return false;}
    return true;
  }

  function matchOrder(o) {
    const f = state.oFilters;
    if (f.order_no && !String(o.order_no).toLowerCase().includes(f.order_no.toLowerCase())) {return false;}
    if (f.supplier_id && o.supplier_id !== Number(f.supplier_id)) {return false;}
    if (f.pay_min !== "" && !(o.pay_amount !== null && o.pay_amount >= Number(f.pay_min))) {return false;}
    if (f.pay_max !== "" && !(o.pay_amount !== null && o.pay_amount <= Number(f.pay_max))) {return false;}
    if (f.receive_from && !(o.receive_time && o.receive_time >= f.receive_from)) {return false;}
    if (f.receive_to && !(o.receive_time && o.receive_time <= f.receive_to)) {return false;}
    if (f.deadline_from && !(o.deadline && o.deadline >= f.deadline_from)) {return false;}
    if (f.deadline_to && !(o.deadline && o.deadline <= f.deadline_to)) {return false;}
    if (f.paid_min !== "" && !(o.paid_amount !== null && o.paid_amount >= Number(f.paid_min))) {return false;}
    if (f.paid_max !== "" && !(o.paid_amount !== null && o.paid_amount <= Number(f.paid_max))) {return false;}
    if (f.status && o.status !== f.status) {return false;}
    return true;
  }

  // ============ 选择 UI ============
  function updateSSelUI() {
    const c = state.sSel.size;
    const cnt = document.getElementById("pm_sSelCount");
    const btn = document.getElementById("pm_btnSupplierDelSel");
    cnt.textContent = c ? `已选 ${c} 项` : "";
    btn.style.display = c ? "" : "none";
  }

  function updateOSelUI() {
    const c = state.oSel.size;
    const cnt = document.getElementById("pm_oSelCount");
    const btn = document.getElementById("pm_btnOrderDelSel");
    cnt.textContent = c ? `已选 ${c} 项` : "";
    btn.style.display = c ? "" : "none";
  }

  // ============ 内联编辑器 ============
  function supplierNameOf(o) {
    const sup = state.suppliers.find((s) => s.id === o.supplier_id);
    return sup ? sup.name : "";
  }

  function cellDisplayText(kind, def, record) {
    const key = def.key;
    if (kind === "supplier") {
      if (key === "free_shipping") {return record.free_shipping ? "是" : "否";}
      return record[key] !== null && record[key] !== "" ? String(record[key]) : "";
    } else {
      if (key === "supplier_id") {return supplierNameOf(record);}
      return record[key] !== null && record[key] !== "" ? String(record[key]) : "";
    }
  }

  // 厂商组合框：文本框 + 自定义下拉候选。
  // 支持 ↑/↓ 键切换高亮、Enter 选中并提交、单击选中、输入即按子串匹配。
  // 返回 { el, setValue, focus, getValue }，el 带 value 访问器（取内层 input 的值）。
  function buildSupplierCombo(commit, cancel, blurCommit) {
    const wrap = document.createElement("div");
    wrap.className = "pm-sup-combo";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "cell-input";
    inp.placeholder = "输入厂商名自动匹配";
    const list = document.createElement("div");
    list.className = "pm-sup-list";
    list.hidden = true;
    wrap.appendChild(inp);
    wrap.appendChild(list);

    let items = [];
    let highlight = -1;

    const matches = (s) => {
      const q = inp.value.trim().toLowerCase();
      return !q || s.name.toLowerCase().includes(q);
    };

    const shown = () => !list.hidden && items.length > 0;

    const setHighlight = (i) => {
      highlight = (i + items.length) % items.length;
      [...list.children].forEach((el, idx) => el.classList.toggle("active", idx === highlight));
      const active = list.children[highlight];
      if (active) {active.scrollIntoView({ block: "nearest" });}
    };

    const choose = (i) => {
      const s = items[i];
      if (s) {inp.value = s.name;}
      list.hidden = true;
    };

    const render = () => {
      items = state.suppliers.filter(matches);
      list.innerHTML = "";
      highlight = -1;
      if (items.length === 0) {
        list.hidden = true;
        return;
      }
      items.forEach((s, i) => {
        const div = document.createElement("div");
        div.className = "pm-sup-opt";
        div.textContent = s.name;
        div.onmousedown = (e) => {
          e.preventDefault();
          choose(i);
        };
        div.onmouseenter = () => { if (shown()) {setHighlight(i);} };
        list.appendChild(div);
      });
      list.hidden = false;
      setHighlight(0);
    };

    inp.addEventListener("input", render);
    inp.addEventListener("focus", render);
    inp.addEventListener("blur", () => {
      setTimeout(() => {
        list.hidden = true;
        if (blurCommit && commit) {
          commit();
        }
      }, 150);
    });
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length) {setHighlight(highlight + 1);}
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length) {setHighlight(highlight - 1);}
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (shown()) {choose(highlight);}
        if (commit) {commit();}
      } else if (e.key === "Escape") {
        list.hidden = true;
        if (cancel) {cancel();}
      } else if (e.key === "Tab") {
        list.hidden = true;
      }
    });

    Object.defineProperty(wrap, "value", {
      configurable: true,
      get: () => inp.value,
      set: (v) => { inp.value = v || ""; },
    });
    wrap.setValue = (v) => { inp.value = v || ""; };
    wrap.focus = () => inp.focus();
    wrap.getValue = () => inp.value;
    return wrap;
  }

  function buildEditor(td, record, kind, key, def) {
    const original = cellDisplayText(kind, def, record);
    let control;
    const wrap = document.createElement("div");
    const commit = () => commitInlineEdit(kind, def, record, control, original);
    const cancel = () => clearEditor();
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {commit();}
      else if (e.key === "Escape") {cancel();}
    };

    if (def.type === "select") {
      const sel = document.createElement("select");
      sel.className = "cell-select";
      def.options.forEach((o) => sel.appendChild(new Option(o, o)));
      sel.value = record[key] !== null ? String(record[key]) : (def.options[0] || "");
      sel.onchange = () => commit();
      sel.onkeydown = onKey;
      control = sel;
    } else if (def.type === "supplierSelect") {
      const combo = buildSupplierCombo(commit, cancel, true);
      combo.setValue(supplierNameOf(record));
      control = combo;
    } else if (def.type === "bool") {
      const sel = document.createElement("select");
      sel.className = "cell-select";
      sel.appendChild(new Option("是", "1"));
      sel.appendChild(new Option("否", "0"));
      sel.value = record.free_shipping ? "1" : "0";
      sel.onchange = () => commit();
      sel.onkeydown = onKey;
      control = sel;
    } else if (def.type === "number") {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "0.01";
      inp.className = "cell-input";
      inp.value = record[key] !== null ? record[key] : "";
      inp.onblur = () => commit();
      inp.onkeydown = onKey;
      control = inp;
    } else if (def.type === "date") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cell-input";
      inp.value = parseDateInput(record[key]) || today();
      inp.placeholder = "2026-08-14 或 2026/8/13";
      inp.onblur = () => commit();
      inp.onkeydown = onKey;
      control = inp;
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cell-input";
      inp.value = record[key] !== null ? String(record[key]) : "";
      inp.onblur = () => commit();
      inp.onkeydown = onKey;
      control = inp;
    }

    wrap.appendChild(control);
    td.innerHTML = "";
    td.appendChild(wrap);
    activeEditor = { td, kind, def, record, control, original };
    control.focus();
    if (control.select) {control.select();}
    return activeEditor;
  }

  function startEditor() {}

  function cancelActiveEditor() {
    if (activeEditor) {clearEditor();}
  }

  function clearEditor() {
    if (!activeEditor) {return;}
    const def = activeEditor.def;
    const text = cellDisplayText(activeEditor.kind, def, activeEditor.record);
    activeEditor.td.textContent = text;
    if (def.ellipsis) {
      activeEditor.td.title = text;
      applyEllipsis(activeEditor.td, text, def.ellipsis);
    }
    activeEditor = null;
  }

  function commitInlineEdit(kind, def, record, control, original) {
    if (!activeEditor) {return;}
    let value;
    let resolvedName = null;
    if (def.type === "select" || def.type === "bool") {
      value = control.value;
    } else if (def.type === "supplierSelect") {
      const typed = String(control.value).trim();
      const sup = state.suppliers.find((s) => s.name === typed);
      if (!sup) {
        post({ type: "log", text: `⚠厂商「${typed}」不存在，请从提示列表中选择` });
        clearEditor();
        return;
      }
      value = sup.id;
      resolvedName = sup.name;
    } else if (def.type === "number") {
      value = control.value === "" ? "" : Number(control.value);
    } else if (def.type === "date") {
      if (String(control.value).trim() === "") {
        value = "";
      } else {
        const parsed = parseDateInput(control.value);
        if (parsed) {
          value = parsed;
        } else {
          post({ type: "log", text: `⚠日期格式无效：${control.value}（示例：2026-08-14 或 2026/8/13）` });
          clearEditor();
          return;
        }
      }
    } else {
      value = control.value;
    }
    const newText = resolvedName !== null
      ? resolvedName
      : (kind === "supplier" && def.key === "free_shipping"
          ? (value === "1" ? "是" : "否")
          : String(value ?? ""));
    activeEditor = null;
    redrawCell(kind, def, record, newText);
    if (newText !== original) {
      post({
        type: kind === "supplier" ? "updateSupplierField" : "updateOrderField",
        toolName: "procurementTool",
        id: record.id,
        field: def.key,
        value,
      });
    }
  }

  function redrawCell(kind, def, record, text) {
    const body = kind === "supplier"
      ? document.getElementById("pm_supplierBody")
      : document.getElementById("pm_orderBody");
    const tr = backtrackRow(body, record.id);
    if (!tr) {return;}
    const td = tr.querySelector(`td[data-field="${def.key}"]`);
    if (!td) {return;}
    if (kind === "order" && def.key === "status") {
      td.innerHTML = `<span class="status status-${text}">${text}</span>`;
    } else {
      td.textContent = text;
      if (def.ellipsis) {
        td.title = text;
        applyEllipsis(td, text, def.ellipsis);
      }
    }
  }

  function backtrackRow(body, id) {
    const trs = body.querySelectorAll("tr");
    for (const tr of trs) {
      if (Number(tr.dataset.id) === id) {return tr;}
    }
    return null;
  }

  function applyEllipsis(td, text, max) {
    td.textContent = text.length > max ? text.slice(0, max) + "…" : text;
    td.title = text.length ? text : undefined;
  }

  function today() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  // 单元格/新增行中录入日期：支持 Excel 序列号(46267)、2026-08-14、2026/8/13、2026年8月13日
  function parseDateInput(v) {
    if (v === undefined || v === null || String(v).trim() === "") {return null;}
    const s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      const serial = Number(s);
      if (!isFinite(serial) || serial < 59) {return null;}
      return toDateStr(new Date(Math.round((serial - 25569) * 86400 * 1000)));
    }
    let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) {return buildDateStr(Number(m[1]), Number(m[2]), Number(m[3]));}
    m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
    if (m) {return buildDateStr(Number(m[1]), Number(m[2]), Number(m[3]));}
    return null;
  }

  function buildDateStr(y, mo, d) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) {return null;}
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d) {
      const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(date.getUTCDate()).padStart(2, "0");
      return `${y}-${mm}-${dd}`;
    }
    return null;
  }

  function toDateStr(d) {
    if (isNaN(d.getTime())) {return null;}
    const y = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }

  // ============ 底部新增行 ============
  function startAddRow(kind) {
    cancelActiveEditor();
    cancelExistingAddRow();
    const fields = kind === "supplier" ? SUPPLIER_FIELDS : ORDER_FIELDS;
    const tr = document.createElement("tr");
    tr.className = "new-row";
    tr.dataset.addRow = "1";
    // 复选框占位列
    const selTd = document.createElement("td");
    selTd.className = "sel-col";
    selTd.dataset.addRow = "1";
    tr.appendChild(selTd);
    fields.forEach((def) => {
      const td = document.createElement("td");
      td.dataset.addRow = "1";
      td.appendChild(makeAddRowControl(kind, def));
      tr.appendChild(td);
    });
    const op = document.createElement("td");
    op.dataset.addRow = "1";
    const saveBtn = makeBtn("保存", () => saveAddRow(kind));
    saveBtn.className = "btn-primary-teal";
    const cancelBtn = makeBtn("取消", cancelExistingAddRow);
    op.appendChild(saveBtn);
    op.appendChild(cancelBtn);
    tr.appendChild(op);
    const body = kind === "supplier"
      ? document.getElementById("pm_supplierBody")
      : document.getElementById("pm_orderBody");
    body.appendChild(tr);
    body.scrollTop = body.scrollHeight;
    const first = tr.querySelector("input.cell-input, select.cell-select");
    if (first) {first.focus();}
  }

  function makeAddRowControl(kind, def) {
    if (def.type === "select") {
      const sel = document.createElement("select");
      sel.className = "cell-select";
      sel.dataset.f = def.key;
      def.options.forEach((o) => sel.appendChild(new Option(o, o)));
      return sel;
    }
    if (def.type === "supplierSelect") {
      const combo = buildSupplierCombo(null, null);
      combo.dataset.f = def.key;
      if (state.suppliers.length === 0) {
        combo.querySelector("input").placeholder = "请先添加厂商";
      }
      return combo;
    }
    if (def.type === "bool") {
      const sel = document.createElement("select");
      sel.className = "cell-select";
      sel.dataset.f = def.key;
      sel.appendChild(new Option("是", "1"));
      sel.appendChild(new Option("否", "0"));
      return sel;
    }
    if (def.type === "date") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cell-input";
      inp.dataset.f = def.key;
      inp.placeholder = "2026-08-14 或 2026/8/13";
      inp.value = def.key === "receive_time" ? today() : "";
      return inp;
    }
    if (def.type === "number") {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "0.01";
      inp.className = "cell-input";
      inp.dataset.f = def.key;
      return inp;
    }
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "cell-input";
    inp.dataset.f = def.key;
    return inp;
  }

  function cancelExistingAddRow() {
    ["pm_supplierBody", "pm_orderBody"].forEach((id) => {
      const body = document.getElementById(id);
      if (!body) {return;}
      body.querySelectorAll('tr[data-add-row="1"]').forEach((r) => r.remove());
    });
  }

  function saveAddRow(kind) {
    const body = kind === "supplier"
      ? document.getElementById("pm_supplierBody")
      : document.getElementById("pm_orderBody");
    const tr = body.querySelector('tr[data-add-row="1"]');
    if (!tr) {return;}
    const read = (key) => {
      const el = tr.querySelector(`[data-f="${key}"]`);
      return el ? el.value : "";
    };
    if (kind === "supplier") {
      const name = read("name").trim();
      if (!name) {
        post({ type: "log", text: "⚠厂商不能为空" });
        return;
      }
      post({
        type: "addSupplier",
        toolName: "procurementTool",
        name,
        freeShipping: read("free_shipping") === "1",
        relationship: read("relationship") || "待评估",
        qualityDesc: read("quality_desc"),
      });
    } else {
      const supplierName = read("supplier_id").trim();
      if (!supplierName) {
        post({ type: "log", text: "⚠请选择供应商" });
        return;
      }
      const sup = state.suppliers.find((s) => s.name === supplierName);
      if (!sup) {
        post({ type: "log", text: `⚠厂商「${supplierName}」不存在，请从提示列表中选择` });
        return;
      }
      const receiveTime = read("receive_time");
      const deadline = read("deadline");
      const parsedReceive = receiveTime ? parseDateInput(receiveTime) : null;
      const parsedDeadline = deadline ? parseDateInput(deadline) : null;
      if ((receiveTime && !parsedReceive) || (deadline && !parsedDeadline)) {
        post({ type: "log", text: `⚠日期格式无效：${receiveTime || deadline}（示例：2026-08-14）` });
        return;
      }
      post({
        type: "addOrder",
        toolName: "procurementTool",
        orderNo: read("order_no").trim(),
        supplierId: sup.id,
        payAmount: read("pay_amount"),
        receiveTime: parsedReceive || today(),
        deadline: parsedDeadline,
        paidAmount: read("paid_amount"),
        status: read("status") || "已下单",
      });
    }
    tr.remove();
  }

  // ============ 表头（排序 + 筛选行） ============
  function buildSupplierHeaders() {
    const head = document.getElementById("pm_supplierHead");
    const filter = document.getElementById("pm_supplierFilter");
    head.innerHTML = "";
    filter.innerHTML = "";
    // 复选框列
    const selTh = document.createElement("th");
    selTh.className = "sel-col";
    const selAll = document.createElement("input");
    selAll.type = "checkbox";
    selAll.dataset.selAll = "1";
    selAll.checked = !!state.sSelAll;
    selAll.onchange = () => {
      state.sSelAll = selAll.checked;
      state.sSel = selAll.checked
        ? new Set(currentRows("supplier").map((r) => r.id))
        : new Set();
      renderSuppliers();
    };
    selTh.appendChild(selAll);
    head.appendChild(selTh);
    const selTdFilter = document.createElement("td");
    selTdFilter.className = "sel-col filter-row";
    filter.appendChild(selTdFilter);

    SUPPLIER_FIELDS.forEach((f) => {
      const th = document.createElement("th");
      th.style.width = f.w;
      th.classList.add("sortable");
      th.dataset.key = f.key;
      th.innerHTML = `${f.label} <span class="sort-indicator" data-ind="${f.key}"></span>`;
      th.onclick = () => {
        if (state.sSortCol === f.key) {
          state.sSortDir = state.sSortDir === "asc" ? "desc" : "asc";
        } else {
          state.sSortCol = f.key;
          state.sSortDir = f.key === "free_shipping" ? "desc" : "asc";
        }
        renderSuppliers();
      };
      head.appendChild(th);
      const td = document.createElement("td");
      td.className = "filter-row";
      td.appendChild(makeFilterControl(f));
      filter.appendChild(td);
    });
    const opTh = document.createElement("th");
    opTh.style.width = "90px";
    opTh.textContent = "操作";
    head.appendChild(opTh);
    const opTd = document.createElement("td");
    opTd.className = "filter-row";
    opTd.innerHTML = '<span class="f-help"></span>';
    filter.appendChild(opTd);
    updateSortInd("pm_supplierHead", state.sSortCol, state.sSortDir);
  }

  function buildOrderHeaders() {
    const head = document.getElementById("pm_orderHead");
    const filter = document.getElementById("pm_orderFilter");
    head.innerHTML = "";
    filter.innerHTML = "";
    const selTh = document.createElement("th");
    selTh.className = "sel-col";
    const selAll = document.createElement("input");
    selAll.type = "checkbox";
    selAll.dataset.selAll = "1";
    selAll.checked = !!state.oSelAll;
    selAll.onchange = () => {
      state.oSelAll = selAll.checked;
      state.oSel = selAll.checked
        ? new Set(currentRows("order").map((r) => r.id))
        : new Set();
      renderOrders();
    };
    selTh.appendChild(selAll);
    head.appendChild(selTh);
    const selTdFilter = document.createElement("td");
    selTdFilter.className = "sel-col filter-row";
    filter.appendChild(selTdFilter);

    ORDER_FIELDS.forEach((f) => {
      const th = document.createElement("th");
      th.style.width = f.w;
      th.classList.add("sortable");
      th.dataset.key = f.key;
      th.innerHTML = `${f.label} <span class="sort-indicator" data-ind="${f.key}"></span>`;
      th.onclick = () => {
        if (state.oSortCol === f.key) {
          state.oSortDir = state.oSortDir === "asc" ? "desc" : "asc";
        } else {
          state.oSortCol = f.key;
          state.oSortDir = f.numeric ? "desc" : "asc";
        }
        renderOrders();
      };
      head.appendChild(th);
      const td = document.createElement("td");
      td.className = "filter-row";
      td.appendChild(makeFilterControl(f));
      filter.appendChild(td);
    });
    const opTh = document.createElement("th");
    opTh.style.width = "130px";
    opTh.textContent = "操作";
    head.appendChild(opTh);
    const opTd = document.createElement("td");
    opTd.className = "filter-row";
    opTd.innerHTML = '<span class="f-help"></span>';
    filter.appendChild(opTd);
    updateSortInd("pm_orderHead", state.oSortCol, state.oSortDir);
  }

  function makeFilterControl(f) {
    const filter = f.filter;
    if (filter === "sel") {
      const sel = document.createElement("select");
      sel.className = "f-control";
      sel.dataset.f = f.key;
      sel.appendChild(new Option("全部", ""));
      f.fOptions.forEach((o) => sel.appendChild(new Option(o, o)));
      return sel;
    }
    if (filter === "boolSel") {
      const sel = document.createElement("select");
      sel.className = "f-control";
      sel.dataset.f = "free_shipping";
      sel.appendChild(new Option("全部", ""));
      sel.appendChild(new Option("是", "1"));
      sel.appendChild(new Option("否", "0"));
      return sel;
    }
    if (filter === "supplierSel") {
      const sel = document.createElement("select");
      sel.className = "f-control";
      sel.dataset.f = "supplier_id";
      sel.appendChild(new Option("全部", ""));
      state.suppliers.forEach((s) => sel.appendChild(new Option(s.name, s.id)));
      return sel;
    }
    if (filter === "numRange") {
      const wrap = document.createElement("div");
      wrap.className = "f-range";
      const min = document.createElement("input");
      min.type = "number";
      min.step = "0.01";
      min.dataset.f = f.minKey;
      min.placeholder = "最小";
      const sep = document.createTextNode("~");
      const max = document.createElement("input");
      max.type = "number";
      max.step = "0.01";
      max.dataset.f = f.maxKey;
      max.placeholder = "最大";
      wrap.appendChild(min);
      wrap.appendChild(sep);
      wrap.appendChild(max);
      return wrap;
    }
    if (filter === "dateRange") {
      const wrap = document.createElement("div");
      wrap.className = "f-range";
      const from = document.createElement("input");
      from.type = "date";
      from.dataset.f = f.fromKey;
      const sep = document.createTextNode("~");
      const to = document.createElement("input");
      to.type = "date";
      to.dataset.f = f.toKey;
      wrap.appendChild(from);
      wrap.appendChild(sep);
      wrap.appendChild(to);
      return wrap;
    }
    // text
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "f-control";
    inp.dataset.f = f.fKeys ? f.fKeys[0] : f.key;
    inp.placeholder = "筛选";
    return inp;
  }

  // ============ 渲染 ============
  function currentRows(kind) {
    const all = kind === "supplier" ? state.suppliers : state.orders;
    let rows = all.filter(kind === "supplier" ? matchSupplier : matchOrder);
    const col = kind === "supplier" ? state.sSortCol : state.oSortCol;
    const dir = (kind === "supplier" ? state.sSortDir : state.oSortDir) === "asc" ? 1 : -1;
    if (col) {
      rows = rows.slice().sort((a, b) => {
        if (kind === "order" && (col === "pay_amount" || col === "paid_amount")) {
          return dir * ((a[col] ?? 0) - (b[col] ?? 0));
        }
        let av, bv;
        if (kind === "supplier" && col === "free_shipping") {
          av = a.free_shipping ? 1 : 0;
          bv = b.free_shipping ? 1 : 0;
        } else if (kind === "order" && col === "supplier_id") {
          av = supplierNameOf(a);
          bv = supplierNameOf(b);
        } else {
          av = String(a[col] ?? "");
          bv = String(b[col] ?? "");
        }
        if (typeof av === "number") {return dir * (av - bv);}
        return dir * String(av).localeCompare(String(bv), "zh-CN");
      });
    }
    return rows;
  }

  function refreshSupplierBody() {
    const body = document.getElementById("pm_supplierBody");
    const empty = document.getElementById("pm_supplierEmpty");
    const rows = currentRows("supplier");
    body.innerHTML = "";
    rows.forEach((s) => {
      const tr = document.createElement("tr");
      tr.dataset.id = s.id;
      const selTd = document.createElement("td");
      selTd.className = "sel-col";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.sel = "1";
      cb.dataset.id = s.id;
      cb.checked = state.sSel.has(s.id);
      selTd.appendChild(cb);
      tr.appendChild(selTd);
      SUPPLIER_FIELDS.forEach((f) => {
        const td = document.createElement("td");
        td.dataset.id = s.id;
        td.dataset.field = f.key;
        td.className = "editable";
        const text = cellDisplayText("supplier", f, s);
        td.textContent = text;
        if (f.ellipsis) {applyEllipsis(td, text, f.ellipsis);}
        tr.appendChild(td);
      });
      const op = document.createElement("td");
      op.className = "actions";
      const delBtn = makeBtn("🗑", () => deleteSupplier(s));
      delBtn.className = "btn-danger";
      delBtn.title = "删除";
      op.appendChild(delBtn);
      tr.appendChild(op);
      body.appendChild(tr);
    });
    empty.style.display = rows.length ? "none" : "block";
  }

  function refreshOrderBody() {
    const body = document.getElementById("pm_orderBody");
    const empty = document.getElementById("pm_orderEmpty");
    const rows = currentRows("order");
    body.innerHTML = "";
    rows.forEach((o) => {
      const tr = document.createElement("tr");
      tr.dataset.id = o.id;
      const selTd = document.createElement("td");
      selTd.className = "sel-col";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.sel = "1";
      cb.dataset.id = o.id;
      cb.checked = state.oSel.has(o.id);
      selTd.appendChild(cb);
      tr.appendChild(selTd);
      ORDER_FIELDS.forEach((f) => {
        const td = document.createElement("td");
        td.dataset.id = o.id;
        td.dataset.field = f.key;
        td.className = "editable";
        if (f.key === "status") {
          const text = o.status || "";
          td.innerHTML = `<span class="status status-${text}">${text}</span>`;
        } else if (f.numeric) {
          td.className = "editable num";
          td.textContent = o[f.key] !== null ? String(o[f.key]) : "";
        } else {
          const text = cellDisplayText("order", f, o);
          td.textContent = text;
          if (f.ellipsis) {applyEllipsis(td, text, f.ellipsis);}
        }
        tr.appendChild(td);
      });
      const op = document.createElement("td");
      op.className = "actions";
      const delBtn = makeBtn("🗑", () => deleteOrder(o));
      delBtn.className = "btn-danger";
      op.appendChild(delBtn);
      if (o.status === "已下单") {
        op.appendChild(makeBtn("📦签收", () => autoReceipt(o)));
      }
      tr.appendChild(op);
      body.appendChild(tr);
    });
    empty.style.display = rows.length ? "none" : "block";
  }

  function renderSuppliers() {
    buildSupplierHeaders();
    refreshSupplierBody();
    updateSSelUI();
  }

  function renderOrders() {
    buildOrderHeaders();
    refreshOrderBody();
    updateOSelUI();
  }

  function makeBtn(text, cb) {
    const b = document.createElement("button");
    b.textContent = text;
    b.onclick = cb;
    return b;
  }

  function updateSortInd(headId, col, dir) {
    const head = document.getElementById(headId);
    if (!head) {return;}
    head.querySelectorAll(".sort-indicator").forEach((el) => {
      if (el.dataset.ind === col) {
        el.textContent = dir === "asc" ? "▲" : "▼";
        el.className = "sort-indicator active";
      } else {
        el.textContent = "";
        el.className = "sort-indicator";
      }
    });
  }

  // ============ 操作 ============
  function deleteSupplier(s) {
    post({ type: "deleteSupplier", toolName: "procurementTool", id: s.id });
  }
  function deleteOrder(o) {
    post({ type: "deleteOrder", toolName: "procurementTool", id: o.id });
  }
  function autoReceipt(o) {
    post({ type: "autoReceipt", toolName: "procurementTool", id: o.id, name: o.order_no });
  }

  // ============ 分析视图 ============
  const ANA_X = {
    order: [
      { v: "supplier", t: "供应商" },
      { v: "status", t: "订单状态" },
      { v: "month", t: "签收月份" },
      { v: "deadline_month", t: "截止月份" },
    ],
    supplier: [
      { v: "relationship", t: "合作关系" },
      { v: "free_shipping", t: "是否包邮" },
    ],
  };
  const ANA_Y = {
    order: [
      { v: "count", t: "订单数量" },
      { v: "pay_sum", t: "付款总额" },
      { v: "paid_sum", t: "实付总额" },
      { v: "pay_avg", t: "平均付款" },
    ],
    supplier: [{ v: "count", t: "数量" }],
  };

  function bindAnalysis() {
    const src = document.getElementById("pm_anaSource");
    const xSel = document.getElementById("pm_anaX");
    const ySel = document.getElementById("pm_anaY");
    const sync = () => {
      xSel.innerHTML = "";
      ANA_X[src.value].forEach((o) => xSel.appendChild(new Option(o.t, o.v)));
      ySel.innerHTML = "";
      ANA_Y[src.value].forEach((o) => ySel.appendChild(new Option(o.t, o.v)));
    };
    src.onchange = sync;
    document.getElementById("pm_anaRender").onclick = () => renderAnalysis();
    sync();
  }

  function renderAnalysis() {
    const x = document.getElementById("pm_anaX").value;
    const y = document.getElementById("pm_anaY").value;
    const src = document.getElementById("pm_anaSource").value;
    const map = new Map();

    const push = (label, order) => {
      const k = label || "未知";
      if (!map.has(k)) {map.set(k, { label: k, count: 0, pay_sum: 0, paid_sum: 0 });}
      const g = map.get(k);
      g.count += 1;
      g.pay_sum += order.pay_amount ?? 0;
      g.paid_sum += order.paid_amount ?? 0;
    };

    if (src === "supplier") {
      state.suppliers.forEach((s) => {
        let label;
        if (x === "free_shipping") {label = s.free_shipping ? "是" : "否";}
        else {label = s.relationship;}
        if (!map.has(label)) {map.set(label, { label, count: 0, pay_sum: 0, paid_sum: 0 });}
        map.get(label).count += 1;
      });
    } else {
      state.orders.forEach((o) => {
        if (x === "supplier") {push(supplierNameOf(o), o);}
        else if (x === "status") {push(o.status, o);}
        else if (x === "month") {push(o.receive_time ? o.receive_time.slice(0, 7) : "", o);}
        else if (x === "deadline_month") {push(o.deadline ? o.deadline.slice(0, 7) : "", o);}
      });
    }

    const groups = Array.from(map.values());
    const valueFor = (g) => {
      if (y === "count") {return g.count;}
      if (y === "pay_sum") {return g.pay_sum;}
      if (y === "paid_sum") {return g.paid_sum;}
      if (y === "pay_avg") {return g.count ? g.pay_sum / g.count : 0;}
      return g.count;
    };
    groups.forEach((g) => { g.val = valueFor(g); });
    groups.sort((a, b) => b.val - a.val);

    const wrap = document.getElementById("pm_chartWrap");
    const note = document.getElementById("pm_chartNote");
    if (groups.length === 0) {
      wrap.innerHTML = '<p class="empty-hint">暂无数据</p>';
      note.textContent = "";
      return;
    }
    renderBarChart(wrap, groups, y);
    note.textContent = `共 ${groups.length} 个分组；(x=${x}, y=${y})`;
  }

  function renderBarChart(wrap, groups, y) {
    const barW = 54;
    const gap = 16;
    const padL = 48;
    const padB = 46;
    const chartW = padL + groups.length * (barW + gap) + 20;
    const chartH = 320;
    const plotH = chartH - padB - 24;
    const max = Math.max(...groups.map((g) => g.val)) || 1;
    const fmt = (v) => {
      if (y === "count") {return String(v);}
      return Number(v.toFixed(2)).toLocaleString();
    };
    const fg = "var(--vscode-foreground)";
    const barColor = "#23a884";

    let svg = `<svg width="${chartW}" height="${chartH}" xmlns="http://www.w3.org/2000/svg" style="display:block">`;
    // 网格横线 + y 刻度
    for (let i = 0; i <= 4; i++) {
      const yy = 20 + (plotH / 4) * i;
      const val = max * (1 - i / 4);
      svg += `<line x1="${padL}" y1="${yy}" x2="${chartW - 10}" y2="${yy}" stroke="var(--vscode-panel-border)" stroke-width="1"/>`;
      svg += `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="${fg}">${fmt(val)}</text>`;
    }
    // 柱
    groups.forEach((g, i) => {
      const x = padL + i * (barW + gap);
      const h = (g.val / max) * plotH;
      const y = 20 + plotH - h;
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h, 1)}" rx="3" fill="${barColor}"><title>${escapeXml(String(g.label))}：${fmt(g.val)}</title></rect>`;
      svg += `<text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="${fg}">${fmt(g.val)}</text>`;
      // x 轴标签（截断）
      const label = g.label.length > 6 ? g.label.slice(0, 6) + "…" : g.label;
      svg += `<text x="${x + barW / 2}" y="${chartH - padB + 14}" text-anchor="middle" font-size="10" fill="${fg}">${escapeXml(label)}</text>`;
    });
    svg += "</svg>";
    wrap.innerHTML = svg;
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
  }

  // ============ 消息 ============
  function onMessage(msg) {
    if (msg.undoAvailable !== undefined || msg.redoAvailable !== undefined) {
      applyUndoState(
        msg.undoAvailable === undefined ? state.canUndo : !!msg.undoAvailable,
        msg.redoAvailable === undefined ? state.canRedo : !!msg.redoAvailable,
      );
    }
    if (msg.type === "suppliersLoaded") {
      state.suppliers = msg.suppliers || [];
      state.sSel = new Set(
        Array.from(state.sSel).filter((id) => state.suppliers.some((s) => s.id === id)),
      );
      renderSuppliers();
    } else if (msg.type === "ordersLoaded") {
      state.orders = msg.orders || [];
      if (msg.suppliers) {state.suppliers = msg.suppliers;}
      state.oSel = new Set(
        Array.from(state.oSel).filter((id) => state.orders.some((o) => o.id === id)),
      );
      renderOrders();
    }
  }

  window.toolClients = window.toolClients || {};
  window.toolClients["procurementTool"] = {
    init,
    onMessage,
    _state: state,
    _isReady: function () {
      return document.getElementById("pm_orderTable") !== null;
    },
  };
})();
