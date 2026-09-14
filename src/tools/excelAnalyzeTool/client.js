// 通用Excel清洗统计绘图工具 - 前端逻辑
// 由 main.html 通过 <script> 注入，注册到 window.toolClients["excelAnalyzeTool"]
(function () {
  const vscode =
    window.__vscode || (window.acquireVsCodeApi ? window.acquireVsCodeApi() : null);

  let state = {
    filePath: "",
    columns: [],
    rowCount: 0,
    statRows: [],
    displayRows: [],
    tableVisible: true,
    chartVisible: true,
    xHeader: "X标签",
    yHeaders: ["聚合数值"],
    yCols: [],
    seriesVisible: [],
    filterCol: 0,
    chartType: "bar",
    sortCol: null,
    sortDir: "desc",
    filterX: "",
    filterValue: "",
  };
  let pendingMessages = [];

  let canvas = null;
  let ctx = null;
  let logicalW = 560;
  let logicalH = 320;
  let hoverShapes = [];
  let tooltipEl = null;

  function post(msg) {
    if (vscode) {vscode.postMessage(msg);}
  }

  function log(text) {
    if (vscode) {vscode.postMessage({ type: "log", text });}
  }

  function init() {
    canvas = document.getElementById("ea_canvas");
    state.filePath = "";
    state.columns = [];
    state.rowCount = 0;
    state.statRows = [];
    state.xHeader = "X标签";
    state.yHeaders = ["聚合数值"];
    state.yCols = [];
    state.seriesVisible = [];
    state.filterCol = 0;
    state.chartType = "bar";
    hoverShapes = [];

    document.getElementById("ea_btnSelectFile").onclick = () =>
      post({ type: "selectFile", toolName: "excelAnalyzeTool" });
    document.getElementById("ea_btnRun").onclick = runAnalysis;
    document.getElementById("ea_btnExportTable").onclick = exportExcel;
    document.getElementById("ea_btnExportChart").onclick = exportChart;
    document.getElementById("ea_btnAddRule").onclick = () => addRuleRow();

    // 初始化分组规则列表：默认一条空规则
    const ruleList = document.getElementById("ea_ruleList");
    ruleList.innerHTML = "";
    addRuleRow();

    document.querySelectorAll('input[name="ea_chart"]').forEach((r) => {
      r.addEventListener("change", () => {
        if (state.displayRows.length) {
          state.chartType = document.querySelector('input[name="ea_chart"]:checked').value;
          setupCanvas();
        }
      });
    });

    // 聚合方式：计数不需要选 Y 列，置灰勾选列表
    document.querySelectorAll('input[name="ea_agg"]').forEach((r) => {
      r.addEventListener("change", updateAggModeUI);
    });

    // 排序 / 筛选统一走事件委托（表头与筛选行由 renderThead 动态生成）
    const eaTable = document.getElementById("ea_table");
    if (eaTable) {
      eaTable.addEventListener("click", (e) => {
        const th = e.target.closest("th.sortable");
        if (!th) {
          return;
        }
        const col = th.dataset.col;
        if (state.sortCol === col) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortCol = col;
          state.sortDir = col === "x" ? "asc" : "desc";
        }
        computeDisplayRows();
        renderTable();
        setupCanvas();
        updateSortIndicators();
      });
      eaTable.addEventListener("input", (e) => {
        if (e.target.id === "ea_filterX") {
          state.filterX = e.target.value;
          computeDisplayRows();
          renderTable();
          setupCanvas();
        } else if (e.target.id === "ea_filterValue") {
          state.filterValue = e.target.value;
          computeDisplayRows();
          renderTable();
          setupCanvas();
        }
      });
      eaTable.addEventListener("change", (e) => {
        if (e.target.id === "ea_filterCol") {
          state.filterCol = Number(e.target.value || 0);
          computeDisplayRows();
          renderTable();
          setupCanvas();
        }
      });
    }

    if (canvas) {
      ctx = canvas.getContext("2d");
      const wrap = document.getElementById("ea_chartBox");
      wrap.style.position = "relative";
      if (tooltipEl) {tooltipEl.remove();}
      tooltipEl = document.createElement("div");
      tooltipEl.style.cssText =
        "position:absolute;z-index:999;padding:5px 8px;background:" +
        "var(--vscode-editorWidget-background,#333);color:" +
        "var(--vscode-editorWidget-foreground,#fff);border:1px solid " +
        "var(--vscode-panel-border);border-radius:3px;font-size:12px;" +
        "pointer-events:none;display:none;white-space:pre;line-height:1.5;";
      wrap.appendChild(tooltipEl);
      canvas.style.cursor = "crosshair";
      canvas.addEventListener("mousemove", onCanvasMove);
      canvas.addEventListener("mouseleave", () => {
        if (tooltipEl) {tooltipEl.style.display = "none";}
      });
      // 图例点击：切换某个 Y 系列显隐（饼图单系列不支持）
      canvas.addEventListener("click", (e) => {
        if (state.chartType === "pie" || !hoverShapes.length || state.yHeaders.length < 2) {
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        for (const s of hoverShapes) {
          if (
            s.type === "legend" &&
            x >= s.x &&
            x <= s.x + s.w &&
            y >= s.y &&
            y <= s.y + s.h
          ) {
            state.seriesVisible[s.col] = !state.seriesVisible[s.col];
            setupCanvas();
            return;
          }
        }
      });
      // 首次布局后按实际宽度设置画布尺寸
      requestAnimationFrame(() => setupCanvas());
    }
    renderThead();

    // 表格 / 图表 显示与隐藏开关
    const resultGrid = document.getElementById("ea_resultGrid");
    const syncVisibility = () => {
      const tWrap = document.getElementById("ea_tableWrap");
      const cBox = document.getElementById("ea_chartBox");
      const tBtn = document.getElementById("ez_tableToggle");
      const cBtn = document.getElementById("ez_chartToggle");
      if (tWrap) {tWrap.classList.toggle("hidden", !state.tableVisible);}
      if (cBox) {cBox.classList.toggle("hidden", !state.chartVisible);}
      if (tBtn) {tBtn.textContent = state.tableVisible ? "隐藏表格" : "显示表格";}
      if (cBtn) {cBtn.textContent = state.chartVisible ? "隐藏图表" : "显示图表";}
      // 只显示一边时占满整行
      if (resultGrid) {
        resultGrid.style.gridTemplateColumns =
          state.tableVisible && state.chartVisible ? "1fr 1fr" : "1fr";
      }
      // 单列布局后画布按新宽度重排
      setupCanvas();
    };
    const bindToggle = (id, key) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("click", () => {
          state[key] = !state[key];
          syncVisibility();
        });
      }
    };
    bindToggle("ez_tableToggle", "tableVisible");
    bindToggle("ez_chartToggle", "chartVisible");
    syncVisibility();

    while (pendingMessages.length > 0) {
      onMessage(pendingMessages.shift());
    }
  }

  // ============ 分组规则列表 ============
  function addRuleRow(regexValue) {
    const list = document.getElementById("ea_ruleList");
    if (!list) {return;}
    const row = document.createElement("div");
    row.className = "rule-row";
    const idx = list.children.length + 1;
    const idxSpan = document.createElement("span");
    idxSpan.className = "rule-idx";
    idxSpan.textContent = "规则" + idx;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ea_rule_regex";
    input.placeholder = "正则表达式，如 ^([A-Z])-";
    input.value = regexValue || "";
    const del = document.createElement("button");
    del.className = "btn-del";
    del.textContent = "✕";
    del.onclick = () => {
      row.remove();
      refreshRuleIdx();
    };
    row.appendChild(idxSpan);
    row.appendChild(input);
    row.appendChild(del);
    list.appendChild(row);
  }

  function refreshRuleIdx() {
    const list = document.getElementById("ea_ruleList");
    if (!list) {return;}
    Array.from(list.children).forEach((row, i) => {
      const s = row.querySelector(".rule-idx");
      if (s) {s.textContent = "规则" + (i + 1);}
    });
  }

  function collectRules() {
    const list = document.getElementById("ea_ruleList");
    const rules = [];
    if (list) {
      Array.from(list.querySelectorAll(".ea_rule_regex")).forEach((inp) => {
        const v = inp.value.trim();
        if (v !== "") {
          rules.push({ name: "", regex: v });
        }
      });
    }
    return rules;
  }

  // ============ Y 列勾选与计数模式 ============
  function updateAggModeUI() {
    const yList = document.getElementById("ea_yColList");
    const hint = document.getElementById("ea_yHint");
    const aggInput = document.querySelector('input[name="ea_agg"]:checked');
    const aggType = aggInput ? aggInput.value : "sum";
    const isCount = aggType === "count";
    if (yList) {yList.classList.toggle("disabled", isCount);}
    if (hint) {
      hint.textContent = isCount
        ? "计数只统计每个分组的行数，不需要选 Y 列；选好 X 列后直接执行即可。"
        : "勾选一个或多个数值列：结果表每列一列、柱状/折线图每列一个系列（饼图只画第一列）；多列时图表顶部出现图例，点击色块可隐藏/显示对应系列。";
    }
  }

  // ============ 筛选排序 ============
  function computeDisplayRows() {
    let rows = state.statRows.slice();

    // X标签筛选
    if (state.filterX.trim()) {
      const kw = state.filterX.trim().toLowerCase();
      rows = rows.filter((r) => String(r.xName).toLowerCase().includes(kw));
    }

    // 数值筛选：作用在 filterCol 指定的 Y 列上；支持 >N, <N, >=N, <=N, N-M, 或纯文本包含
    const cols = state.yHeaders.length || 1;
    const col = Math.min(state.filterCol, cols - 1);
    if (state.filterValue.trim()) {
      const fv = state.filterValue.trim();
      const rangeMatch = fv.match(/^\s*(>=|<=|>|<)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:-\s*([0-9]+(?:\.[0-9]+)?))?\s*$/);
      if (rangeMatch) {
        const op = rangeMatch[1] || "";
        const a = parseFloat(rangeMatch[2]);
        const b = rangeMatch[3] !== undefined ? parseFloat(rangeMatch[3]) : null;
        rows = rows.filter((r) => {
          const v = r.data[col];
          if (b !== null) {
            return v >= a && v <= b;
          }
          if (op === ">") return v > a;
          if (op === ">=") return v >= a;
          if (op === "<") return v < a;
          if (op === "<=") return v <= a;
          return v === a;
        });
      } else {
        // 纯文本包含
        const kw = fv.toLowerCase();
        rows = rows.filter((r) => String(r.data[col]).toLowerCase().includes(kw));
      }
    }

    // 排序：按 X 标签或某个 Y 列数值
    if (state.sortCol) {
      const dir = state.sortDir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        if (state.sortCol === "x") {
          return dir * String(a.xName).localeCompare(String(b.xName), "zh-CN");
        }
        const ci = Number(state.sortCol);
        return dir * ((a.data[ci] || 0) - (b.data[ci] || 0));
      });
    }

    state.displayRows = rows;
  }

  function renderThead() {
    const thead = document.getElementById("ea_thead");
    if (!thead) {
      return;
    }
    const arrow = (col) =>
      state.sortCol === col ? (state.sortDir === "asc" ? "▲" : "▼") : "";
    const cols = state.yHeaders.length || 1;
    const headCells = [
      `<th style="width:60px">序号</th>`,
      `<th class="sortable" data-col="x" title="点击排序"><span id="ea_thX">X标签</span> <span class="sort-indicator">${arrow("x")}</span></th>`,
    ];
    state.yHeaders.forEach((h, i) => {
      headCells.push(
        `<th class="sortable" data-col="${i}" style="min-width:120px" title="点击按该列排序">${esc(h)} <span class="sort-indicator">${arrow(i)}</span></th>`,
      );
    });
    const filterOpts = [`<option value="0">${esc(state.yHeaders[0] || "数值")}</option>`];
    for (let i = 1; i < cols; i++) {
      filterOpts.push(`<option value="${i}">${esc(state.yHeaders[i] || "")}</option>`);
    }
    thead.innerHTML =
      `<tr>${headCells.join("")}</tr>
       <tr class="filter-row">
         <td></td>
         <td><input id="ea_filterX" type="text" placeholder="筛选 X 标签..." /></td>
         <td colspan="${cols}" style="padding:3px 6px">
           <div style="display:flex; gap:4px; align-items:center">
             <select id="ea_filterCol" style="width:150px; flex:none; padding:3px 4px" title="数值筛选作用的列">${filterOpts.join("")}</select>
             <input id="ea_filterValue" type="text" placeholder="如 >100 或 10-50" style="flex:1" />
           </div>
         </td>
       </tr>`;
    const fX = thead.querySelector("#ea_filterX");
    const fV = thead.querySelector("#ea_filterValue");
    const fC = thead.querySelector("#ea_filterCol");
    if (fX) { fX.value = state.filterX; }
    if (fV) { fV.value = state.filterValue; }
    if (fC) { fC.value = String(Math.min(state.filterCol, cols - 1)); }
  }

  function updateSortIndicators() {
    const thead = document.getElementById("ea_thead");
    if (!thead) {
      return;
    }
    thead.querySelectorAll("th.sortable[data-col]").forEach((th) => {
      const col = th.dataset.col;
      const active = state.sortCol === col;
      const sp = th.querySelector(".sort-indicator");
      if (sp) {
        sp.textContent = active ? (state.sortDir === "asc" ? "▲" : "▼") : "";
        sp.className = "sort-indicator" + (active ? " active" : "");
      }
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[m]));
  }

  // ============ 操作 ============
  function runAnalysis() {
    const xCol = document.getElementById("ea_xCol").value;
    const yCols = Array.from(
      document.querySelectorAll("#ea_yColList .ea_ycol:checked"),
    ).map((cb) => cb.value);
    const rules = collectRules();
    const aggType = document.querySelector('input[name="ea_agg"]:checked').value;
    const chartType = document.querySelector('input[name="ea_chart"]:checked').value;
    const invalidMode = document.querySelector('input[name="ea_invalidMode"]:checked').value;
    if (!xCol) { log("⚠请选择【X轴原始列】"); return; }
    // 计数与 Y 列无关；其余聚合方式必须勾选至少一个 Y 列
    if (aggType !== "count" && !yCols.length) { log("⚠请至少勾选一个【Y轴数值列】"); return; }
    post({ type: "runAnalysis", toolName: "excelAnalyzeTool", xCol, yCols, rules, aggType, chartType, invalidMode });
  }

  function exportExcel() {
    if (!state.displayRows.length) { log("⚠没有可导出的统计结果，请先执行分析"); return; }
    post({ type: "exportExcel", toolName: "excelAnalyzeTool", statRows: state.displayRows, xHeader: state.xHeader, yHeaders: state.yHeaders });
  }

  function exportChart() {
    if (!state.displayRows.length || !canvas) { log("⚠请先执行分析生成图表"); return; }
    const exported = document.createElement("canvas");
    exported.width = logicalW;
    exported.height = logicalH;
    const exCtx = exported.getContext("2d");
    exCtx.fillStyle = "#ffffff";
    exCtx.fillRect(0, 0, logicalW, logicalH);
    drawChart(exCtx, logicalW, logicalH, state.chartType);
    const dataUrl = exported.toDataURL("image/png");
    post({ type: "saveChart", toolName: "excelAnalyzeTool", dataUrl });
  }

  // ============ 表格 ============
  function renderTable() {
    const tbody = document.getElementById("ea_tbody");
    const hint = document.getElementById("ea_tableHint");
    const thX = document.getElementById("ea_thX");
    if (thX) {
      thX.textContent = state.xHeader;
    }
    tbody.innerHTML = "";
    if (!state.displayRows.length) {
      hint.textContent = state.statRows.length ? "无匹配结果" : "执行分析后显示结果";
      return;
    }
    state.displayRows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const idxCell = document.createElement("td");
      idxCell.className = "idx";
      idxCell.textContent = String(i + 1);
      tr.appendChild(idxCell);
      const xCell = document.createElement("td");
      xCell.textContent = r.xName;
      xCell.title = r.xName;
      tr.appendChild(xCell);
      r.data.forEach((v, c) => {
        const valCell = document.createElement("td");
        valCell.textContent = String(round(v));
        valCell.title = `${state.yHeaders[c] || ""} = ${round(v)}`;
        tr.appendChild(valCell);
      });
      tbody.appendChild(tr);
    });
    const total = state.statRows.length;
    const shown = state.displayRows.length;
    const filtered = shown !== total ? `（筛选后 ${shown}/${total}）` : "";
    hint.textContent = `共 ${shown} 组${filtered}（源数据 ${state.rowCount} 行）`;
  }

  function populateColumns(columns) {
    const xCol = document.getElementById("ea_xCol");
    xCol.innerHTML = '<option value="">— 请选择列 —</option>';
    columns.forEach((c) => {
      xCol.appendChild(new Option(c, c));
    });
    const yList = document.getElementById("ea_yColList");
    if (yList) {
      yList.innerHTML = "";
      columns.forEach((c, idx) => {
        const lbl = document.createElement("label");
        lbl.className = "ycol-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = c;
        cb.className = "ea_ycol";
        cb.checked = idx === 0; // 默认勾选第一列，加载后可直接执行
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(c));
        yList.appendChild(lbl);
      });
    }
    updateAggModeUI();
  }

  function resetResult() {
    state.displayRows = [];
    state.sortCol = null;
    state.sortDir = "desc";
    state.filterX = "";
    state.filterValue = "";
    state.filterCol = 0;
    state.seriesVisible = state.yHeaders.map(() => true);
    renderThead();
    renderTable();
    document.getElementById("ea_tableHint").textContent = "执行分析后显示结果";
    const hint = document.getElementById("ea_chartHint");
    if (hint) {hint.style.display = "block";}
    if (canvas && ctx) {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, logicalW, logicalH);
    }
    hoverShapes = [];
    updateSortIndicators();
  }

  // ============ 画布 & 图表 ============
  function setupCanvas() {
    const wrap = document.getElementById("ea_chartScroll");
    const inner = document.getElementById("ea_chartInner");
    const hint = document.getElementById("ea_chartHint");
    if (!canvas || !ctx || !wrap) {return;}
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    let newW;
    let newH;
    if (state.chartType === "pie") {
      newW = Math.max(320, Math.round(rect.width) - 2);
      newH = Math.max(240, Math.round(newW * 0.62));
    } else {
      const n = state.displayRows.length;
      const needW = Math.round(n * 48 + 68);
      newW = Math.max(320, Math.round(rect.width) - 2, n > 0 ? needW : 0);
      const maxLen = Math.max(1, ...state.displayRows.map((r) => r.xName.length));
      const padB = Math.max(40, maxLen * 12 + 12);
      const legendTop = state.yHeaders.length > 1 ? 20 : 0;
      newH = 30 + legendTop + 380 + padB;
    }
    logicalW = newW;
    logicalH = newH;
    // 内层容器宽度按组数撑开：组多时超出滚动容器宽度 → 出现横向滚动条，左右滑看后面的组
    if (inner) {inner.style.width = logicalW + "px";}
    canvas.style.height = logicalH + "px";
    canvas.width = Math.round(logicalW * dpr);
    canvas.height = Math.round(logicalH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state.displayRows.length) {
      hint.style.display = "none";
      drawChart(ctx, logicalW, logicalH, state.chartType);
    } else {
      hint.style.display = "block";
    }
  }

  function drawChart(g, W, H, kind) {
    g.clearRect(0, 0, W, H);
    g.fillStyle = getCss("--vscode-editor-background", "#ffffff");
    g.fillRect(0, 0, W, H);
    hoverShapes = [];
    if (!state.displayRows.length) {return;}
    if (kind === "pie") {
      drawPie(g, W, H);
    } else {
      drawAxesChart(g, W, H, kind);
    }
  }

  function getCss(varName, fallback) {
    const v = window.getComputedStyle(document.body).getPropertyValue(varName).trim();
    return v || fallback;
  }

  function axisFg() {
    return getCss("--vscode-foreground", "#333333");
  }
  function axisBg() {
    return getCss("--vscode-editor-background", "#ffffff");
  }

  const PALETTE = ["#23a884", "#2f81f7", "#e6a23c", "#f56c6c", "#9b59b6", "#1bbc9b", "#f39c12", "#e74c3c", "#3498db", "#7f8c8d"];

  function visibleCols() {
    return state.yHeaders.map((_, i) => i).filter((i) => !!state.seriesVisible[i]);
  }

  function drawLegend(g, padL, topY) {
    g.font = "11px sans-serif";
    let x = padL;
    const y = topY;
    for (let c = 0; c < state.yHeaders.length; c++) {
      const header = truncate(state.yHeaders[c] || "", 9);
      const hidden = !state.seriesVisible[c];
      g.fillStyle = PALETTE[c % PALETTE.length];
      g.fillRect(x, y, 10, 10);
      if (hidden) {
        g.fillStyle = axisFg();
        g.fillRect(x, y + 4, 10, 2);
      }
      g.fillStyle = axisFg();
      g.globalAlpha = hidden ? 0.35 : 1;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(header, x + 14, y + 5);
      g.globalAlpha = 1;
      const tw = g.measureText(header).width;
      const w = 14 + tw + 2;
      hoverShapes.push({ type: "legend", col: c, x, y: y - 2, w, h: 16, label: header });
      x += w + 14;
    }
  }

  function drawAxesChart(g, W, H, kind) {
    const data = state.displayRows;
    const n = data.length;
    const vis = visibleCols();
    if (n === 0) {
      return;
    }
    const showLegend = state.yHeaders.length > 1;
    const padL = 52;
    const padR = 16;
    const padT = 30 + (showLegend ? 20 : 0);
    // 竖直 X 标签：底部留白随最长标签高度自适应（不截断，超高时滚动查看）
    const padB = Math.max(40, Math.max(...data.map((r) => r.xName.length)) * 12 + 12);
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const color = axisFg();

    let maxV = 1;
    for (const r of data) {
      for (const c of vis) {
        const v = Number(r.data[c] || 0);
        if (v > maxV) {
          maxV = v;
        }
      }
    }
    // Y 轴上限留出 ~10% 余量并取整齐刻度，避免最高柱顶死到绘图区上沿
    maxV = niceCeil(maxV * 1.1);

    // Y 刻度 + 网格
    g.font = "11px sans-serif";
    g.strokeStyle = "rgba(128,128,128,0.25)";
    g.fillStyle = color;
    g.textAlign = "right";
    g.textBaseline = "middle";
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const vy = padT + plotH - (i / ticks) * plotH;
      const val = (maxV * i) / ticks;
      g.beginPath();
      g.moveTo(padL, vy);
      g.lineTo(W - padR, vy);
      g.stroke();
      g.fillText(fmtShort(val), padL - 6, vy);
    }

    // 图例（可点击切换某列显隐）——即使全部系列隐藏也始终绘制，保证能再点回来
    if (showLegend) {
      drawLegend(g, padL, padT - 16);
    }

    // 全部系列已隐藏：只画坐标框 + 提示，等待用户通过图例恢复
    if (vis.length === 0) {
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(padL, padT);
      g.lineTo(padL, padT + plotH);
      g.lineTo(W - padR, padT + plotH);
      g.stroke();
      g.fillStyle = "rgba(128,128,128,0.8)";
      g.font = "12px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("全部系列已隐藏：点击上方图例色块恢复显示",
        padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const step = plotW / Math.max(1, n);
    const slot = step * 0.7;

    if (kind === "bar") {
      const gap = 2;
      const barW = Math.max(2, (slot - gap * (vis.length - 1)) / vis.length);
      const labelFit = barW >= 26;
      for (let i = 0; i < n; i++) {
        const r = data[i];
        const cx = padL + step * (i + 0.5);
        const startX = cx - slot / 2;
        vis.forEach((c, j) => {
          const x = startX + j * (barW + gap);
          const h = (r.data[c] / maxV) * plotH;
          const yTop = padT + plotH - h;
          g.fillStyle = PALETTE[c % PALETTE.length];
          g.fillRect(x, yTop, barW, h);
          hoverShapes.push({
            type: "rect",
            row: i,
            col: c,
            x,
            y: yTop,
            w: barW,
            h,
            label: r.xName,
            value: r.data[c],
            pct: null,
          });
          if (labelFit) {
            g.fillStyle = color;
            g.font = "10px sans-serif";
            g.textAlign = "center";
            g.textBaseline = "bottom";
            g.fillText(fmtShort(r.data[c]), x + barW / 2, yTop - 2);
          }
        });
        drawVerticalXLabel(g, r.xName, cx, padT + plotH + 6);
      }
    } else {
      // line：每个可见列一条折线
      for (const c of vis) {
        g.strokeStyle = PALETTE[c % PALETTE.length];
        g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const cx = padL + step * (i + 0.5);
          const yTop = padT + plotH - (data[i].data[c] / maxV) * plotH;
          if (i === 0) {
            g.moveTo(cx, yTop);
          } else {
            g.lineTo(cx, yTop);
          }
        }
        g.stroke();
      }
      for (let i = 0; i < n; i++) {
        const r = data[i];
        const cx = padL + step * (i + 0.5);
        vis.forEach((c) => {
          const yTop = padT + plotH - (r.data[c] / maxV) * plotH;
          g.fillStyle = PALETTE[c % PALETTE.length];
          g.beginPath();
          g.arc(cx, yTop, 3.5, 0, Math.PI * 2);
          g.fill();
          hoverShapes.push({
            type: "rect",
            row: i,
            col: c,
            x: cx - 8,
            y: yTop - 8,
            w: 16,
            h: 16,
            label: r.xName,
            value: r.data[c],
            pct: null,
          });
          if (vis.length === 1) {
            g.fillStyle = color;
            g.font = "10px sans-serif";
            g.textAlign = "center";
            g.textBaseline = "bottom";
            g.fillText(fmtShort(r.data[c]), cx, yTop - 6);
          }
        });
        drawVerticalXLabel(g, r.xName, cx, padT + plotH + 6);
      }
    }

    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(padL, padT);
    g.lineTo(padL, padT + plotH);
    g.lineTo(W - padR, padT + plotH);
    g.stroke();
  }

  function drawVerticalXLabel(g, text, cx, baseY) {
    // 完整显示，不截断（长标签通过外层滚动条查看全文）
    g.save();
    g.translate(cx, baseY + 6);
    g.fillStyle = axisFg();
    g.font = "11px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const lineHeight = 12;
    for (let i = 0; i < text.length; i++) {
      g.fillText(text[i], 0, i * lineHeight);
    }
    g.restore();
  }

  function drawPie(g, W, H) {
    const data = state.displayRows;
    // 饼图单维度：只用第一个 Y 列
    const total = data.reduce((s, r) => s + (r.data[0] || 0), 0) || 1;
    const cx = W / 2;
    const cy = H / 2 + 6;
    const radius = Math.min(W, H) / 2 - 20;
    const colors = PALETTE;
    hoverShapes = [];

    let start = -Math.PI / 2;
    for (let i = 0; i < data.length; i++) {
      const v = data[i].data[0];
      const frac = v / total;
      const sweep = frac * Math.PI * 2;
      const end = start + sweep;
      const mid = start + sweep / 2;
      const color = colors[i % colors.length];

      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, radius, start, end);
      g.closePath();
      g.fillStyle = color;
      g.fill();
      g.strokeStyle = axisBg();
      g.lineWidth = 1.5;
      g.stroke();

      if (frac > 0.045) {
        const lx = cx + Math.cos(mid) * radius * 0.62;
        const ly = cy + Math.sin(mid) * radius * 0.62;
        g.fillStyle = "#ffffff";
        g.font = "12px sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText((frac * 100).toFixed(1) + "%", lx, ly);
      }

      // 命中检测：存归一化到 [0,2PI) 的角度
      hoverShapes.push({
        type: "pie",
        start: normAngle(start),
        end: normAngle(end),
        cx,
        cy,
        radius,
        label: data[i].xName,
        value: data[i].data[0],
        pct: frac * 100,
      });
      start = end;
    }

    // 图例
    const lh = 16;
    let y = H - data.length * lh;
    if (y < 6) {y = 6;}
    g.font = "12px sans-serif";
    for (let i = 0; i < data.length; i++) {
      const color = colors[i % colors.length];
      g.fillStyle = color;
      g.fillRect(10, y + 2, 10, 10);
      g.fillStyle = axisFg();
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(`${truncate(data[i].xName, 20)}  ${fmtShort(data[i].data[0])}`, 26, y + 7);
      y += lh;
    }
  }

  function normAngle(a) {
    let n = a % (Math.PI * 2);
    if (n < 0) {n += Math.PI * 2;}
    return n;
  }

  function onCanvasMove(ev) {
    if (!canvas || !hoverShapes.length || !tooltipEl) {return;}
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    let hit = null;
    for (const s of hoverShapes) {
      if (s.type === "pie") {
        const dx = x - s.cx;
        const dy = y - s.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= s.radius + 0.5) {
          const ang = normAngle(Math.atan2(dy, dx));
          if (ang >= s.start - 0.001 && ang <= s.end + 0.001) {
            hit = s;
            break;
          }
        }
      } else if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        hit = s;
        break;
      }
    }
    if (hit) {
      let text;
      if (hit.type === "legend") {
        text = `${hit.label}：点击${state.seriesVisible[hit.col] ? "隐藏" : "显示"}该系列`;
      } else if (hit.type === "pie") {
        text = `${hit.label}\n${fmtShort(hit.value)}  (${hit.pct.toFixed(1)}%)`;
      } else if (hit.row !== undefined) {
        const row = state.displayRows[hit.row];
        text = row.xName;
        state.yHeaders.forEach((h, ci) => {
          if (state.seriesVisible[ci]) {
            text += `\n${h}: ${fmtShort(row.data[ci])}`;
          }
        });
      } else {
        const pctTxt = hit.pct !== null ? `  (${hit.pct.toFixed(1)}%)` : "";
        text = `${hit.label}\n${fmtShort(hit.value)}${pctTxt}`;
      }
      tooltipEl.textContent = text;
      tooltipEl.style.display = "block";
      tooltipEl.style.left = x + 14 + "px";
      tooltipEl.style.top = y + 14 + "px";
    } else {
      tooltipEl.style.display = "none";
    }
  }

  function niceCeil(v) {
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / pow;
    if (m <= 1) {return 1 * pow;}
    if (m <= 1.2) {return 1.2 * pow;}
    if (m <= 1.5) {return 1.5 * pow;}
    if (m <= 2) {return 2 * pow;}
    if (m <= 2.5) {return 2.5 * pow;}
    if (m <= 3) {return 3 * pow;}
    if (m <= 4) {return 4 * pow;}
    if (m <= 5) {return 5 * pow;}
    if (m <= 6) {return 6 * pow;}
    if (m <= 8) {return 8 * pow;}
    return 10 * pow;
  }

  function fmtShort(v) {
    const n = round(v);
    if (Math.abs(n) >= 10000) {return n.toLocaleString();}
    if (Math.abs(n) >= 1000) {return n.toLocaleString();}
    return String(n);
  }

  function round(v) {
    return Math.round(v * 100) / 100;
  }

  function truncate(s, max) {
    s = String(s);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  // ============ 消息 ============
  function onMessage(msg) {
    if (msg.type === "fileLoaded") {
      state.filePath = msg.filePath;
      state.columns = msg.columns;
      state.rowCount = msg.rowCount;
      state.statRows = [];
      state.yHeaders = ["聚合数值"];
      state.yCols = [];
      state.seriesVisible = [];
      document.getElementById("ea_fileInput").value = msg.filePath;
      document.getElementById("ea_fileStatus").textContent = `已加载 ${msg.rowCount} 行数据，共 ${msg.columns.length} 个字段`;
      populateColumns(msg.columns);
      resetResult();
    } else if (msg.type === "analysisResult") {
      state.statRows = msg.statRows || [];
      state.xHeader = msg.xHeader || "X标签";
      state.yHeaders = Array.isArray(msg.yHeaders) && msg.yHeaders.length
        ? msg.yHeaders
        : ["聚合数值"];
      state.yCols = Array.isArray(msg.yCols) ? msg.yCols : state.yHeaders;
      state.rowCount = msg.rowCount || 0;
      state.chartType = msg.chartType || "bar";
      state.sortCol = null;
      state.sortDir = "desc";
      if (!state.statRows.length) {
        log("⚠处理后无可用数据，请检查筛选/正则/Y列");
      }
      resetResult();
      computeDisplayRows();
      updateSortIndicators();
      renderTable();
      setupCanvas();
    }
  }

  window.toolClients = window.toolClients || {};
  window.toolClients["excelAnalyzeTool"] = {
    init,
    onMessage,
    _state: state,
    _isReady: function () {
      return document.getElementById("ea_canvas") !== null;
    },
  };
})();