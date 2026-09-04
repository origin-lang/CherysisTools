// 通用Excel清洗统计绘图工具 - 前端逻辑
// 由 main.html 通过 <script> 注入，注册到 window.toolClients["excelAnalyzeTool"]
(function () {
  const vscode =
    window.__vscode || (window.acquireVsCodeApi ? window.acquireVsCodeApi() : null);

  let state = {
    filePath: "",
    columns: [],
    rowCount: 0,
    outDir: "",
    statRows: [],
    displayRows: [],
    xHeader: "X标签",
    yHeader: "聚合数值",
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
    state.outDir = "";
    state.statRows = [];
    state.xHeader = "X标签";
    state.yHeader = "聚合数值";
    state.chartType = "bar";
    hoverShapes = [];

    document.getElementById("ea_btnSelectFile").onclick = () =>
      post({ type: "selectFile", toolName: "excelAnalyzeTool" });
    document.getElementById("ea_btnRun").onclick = runAnalysis;
    document.getElementById("ea_btnSelectOut").onclick = () =>
      post({ type: "selectOutFolder", toolName: "excelAnalyzeTool" });
    document.getElementById("ea_btnOpenOut").onclick = () => {
      const p = document.getElementById("ea_outDirInput").value.trim();
      if (!p) {
        log("⚠请先选择或在输入框填写导出文件夹");
        return;
      }
      post({ type: "openTargetFolder", toolName: "excelAnalyzeTool", targetPath: p });
    };
    document.getElementById("ea_btnExportExcel").onclick = exportExcel;
    document.getElementById("ea_btnSaveChart").onclick = exportChart;
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

    // 排序表头点击
    document.querySelectorAll("#ea_table th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
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
    });

    // 筛选输入
    const filterXEl = document.getElementById("ea_filterX");
    const filterValueEl = document.getElementById("ea_filterValue");
    if (filterXEl) {
      filterXEl.addEventListener("input", () => {
        state.filterX = filterXEl.value;
        computeDisplayRows();
        renderTable();
        setupCanvas();
      });
    }
    if (filterValueEl) {
      filterValueEl.addEventListener("input", () => {
        state.filterValue = filterValueEl.value;
        computeDisplayRows();
        renderTable();
        setupCanvas();
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
      // 首次布局后按实际宽度设置画布尺寸
      requestAnimationFrame(() => setupCanvas());
    }

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

  // ============ 筛选排序 ============
  function computeDisplayRows() {
    let rows = state.statRows.slice();

    // X标签筛选
    if (state.filterX.trim()) {
      const kw = state.filterX.trim().toLowerCase();
      rows = rows.filter((r) => String(r.xName).toLowerCase().includes(kw));
    }

    // 数值筛选：支持 >N, <N, >=N, <=N, N-M, 或纯文本包含
    if (state.filterValue.trim()) {
      const fv = state.filterValue.trim();
      const rangeMatch = fv.match(/^\s*(>=|<=|>|<)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:-\s*([0-9]+(?:\.[0-9]+)?))?\s*$/);
      if (rangeMatch) {
        const op = rangeMatch[1] || "";
        const a = parseFloat(rangeMatch[2]);
        const b = rangeMatch[3] !== undefined ? parseFloat(rangeMatch[3]) : null;
        rows = rows.filter((r) => {
          const v = r.value;
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
        rows = rows.filter((r) => String(r.value).toLowerCase().includes(kw));
      }
    }

    // 排序
    if (state.sortCol) {
      const dir = state.sortDir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        if (state.sortCol === "x") {
          return dir * String(a.xName).localeCompare(String(b.xName), "zh-CN");
        }
        return dir * (a.value - b.value);
      });
    }

    state.displayRows = rows;
  }

  function updateSortIndicators() {
    const sortX = document.getElementById("ea_sortX");
    const sortVal = document.getElementById("ea_sortValue");
    if (sortX) {
      sortX.textContent = state.sortCol === "x" ? (state.sortDir === "asc" ? "▲" : "▼") : "";
      sortX.className = "sort-indicator" + (state.sortCol === "x" ? " active" : "");
    }
    if (sortVal) {
      sortVal.textContent = state.sortCol === "value" ? (state.sortDir === "asc" ? "▲" : "▼") : "";
      sortVal.className = "sort-indicator" + (state.sortCol === "value" ? " active" : "");
    }
  }

  // ============ 操作 ============
  function runAnalysis() {
    const xCol = document.getElementById("ea_xCol").value;
    const yCol = document.getElementById("ea_yCol").value;
    const rules = collectRules();
    const aggType = document.querySelector('input[name="ea_agg"]:checked').value;
    const chartType = document.querySelector('input[name="ea_chart"]:checked').value;
    const invalidMode = document.querySelector('input[name="ea_invalidMode"]:checked').value;
    post({ type: "runAnalysis", toolName: "excelAnalyzeTool", xCol, yCol, rules, aggType, chartType, invalidMode });
  }

  function exportExcel() {
    if (!state.outDir) { log("⚠请先选择导出保存目录"); return; }
    if (!state.displayRows.length) { log("⚠没有可导出的统计结果，请先执行分析"); return; }
    post({ type: "exportExcel", toolName: "excelAnalyzeTool", outDir: state.outDir, statRows: state.displayRows, xHeader: state.xHeader, yHeader: state.yHeader });
  }

  function exportChart() {
    if (!state.outDir) { log("⚠请先选择导出保存目录"); return; }
    if (!state.displayRows.length || !canvas) { log("⚠请先执行分析生成图表"); return; }
    const exported = document.createElement("canvas");
    exported.width = logicalW;
    exported.height = logicalH;
    const exCtx = exported.getContext("2d");
    exCtx.fillStyle = "#ffffff";
    exCtx.fillRect(0, 0, logicalW, logicalH);
    drawChart(exCtx, logicalW, logicalH, state.chartType);
    const dataUrl = exported.toDataURL("image/png");
    post({ type: "saveChart", toolName: "excelAnalyzeTool", outDir: state.outDir, dataUrl });
  }

  // ============ 表格 ============
  function renderTable() {
    const tbody = document.getElementById("ea_tbody");
    const hint = document.getElementById("ea_tableHint");
    tbody.innerHTML = "";
    document.getElementById("ea_thX").textContent = state.xHeader;
    document.getElementById("ea_thValue").textContent = state.yHeader;
    if (!state.displayRows.length) {
      hint.textContent = state.statRows.length ? "无匹配结果" : "执行分析后显示结果";
      return;
    }
    state.displayRows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const xCell = document.createElement("td");
      xCell.textContent = r.xName;
      xCell.title = r.xName;
      const idxCell = document.createElement("td");
      idxCell.className = "idx";
      idxCell.textContent = String(i + 1);
      const valCell = document.createElement("td");
      valCell.textContent = String(round(r.value));
      tr.appendChild(idxCell);
      tr.appendChild(xCell);
      tr.appendChild(valCell);
      tbody.appendChild(tr);
    });
    const total = state.statRows.length;
    const shown = state.displayRows.length;
    const filtered = shown !== total ? `（筛选后 ${shown}/${total}）` : "";
    hint.textContent = `共 ${shown} 组${filtered}（源数据 ${state.rowCount} 行）`;
  }

  function populateColumns(columns) {
    const xCol = document.getElementById("ea_xCol");
    const yCol = document.getElementById("ea_yCol");
    xCol.innerHTML = '<option value="">— 请选择列 —</option>';
    yCol.innerHTML = '<option value="">— 请选择列 —</option>';
    columns.forEach((c) => {
      xCol.appendChild(new Option(c, c));
      yCol.appendChild(new Option(c, c));
    });
  }

  function resetResult() {
    document.getElementById("ea_tbody").innerHTML = "";
    document.getElementById("ea_thX").textContent = "X标签";
    document.getElementById("ea_thValue").textContent = "聚合数值";
    document.getElementById("ea_tableHint").textContent = "执行分析后显示结果";
    const hint = document.getElementById("ea_chartHint");
    if (hint) {hint.style.display = "block";}
    if (canvas && ctx) {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, logicalW, logicalH);
    }
    hoverShapes = [];
    state.displayRows = [];
    state.sortCol = null;
    state.sortDir = "desc";
    const fx = document.getElementById("ea_filterX");
    const fv = document.getElementById("ea_filterValue");
    if (fx) {fx.value = "";}
    if (fv) {fv.value = "";}
    updateSortIndicators();
  }

  // ============ 画布 & 图表 ============
  function setupCanvas() {
    const wrap = document.getElementById("ea_chartScroll");
    const hint = document.getElementById("ea_chartHint");
    if (!canvas || !ctx || !wrap) {return;}
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    const newW = Math.max(320, Math.round(rect.width) - 2);
    let newH;
    if (state.chartType === "pie") {
      newH = Math.max(240, Math.round(newW * 0.62));
    } else {
      // 柱状/折线：画布高度 = 绘图区(固定) + X轴竖直标签区(随最长标签长度)
      const maxLen = Math.max(1, ...state.displayRows.map((r) => r.xName.length));
      const padB = Math.max(40, maxLen * 12 + 12);
      newH = 30 + 260 + padB; // padT(30) + 绘图高(260) + 标签区(padB)
    }
    logicalW = newW;
    logicalH = newH;
    canvas.style.width = logicalW + "px";
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

  function drawAxesChart(g, W, H, kind) {
    const data = state.displayRows;
    const n = data.length;
    const maxV = Math.max(1, ...data.map((r) => r.value));
    const padL = 52;
    const padR = 16;
    const padT = 30;
    // 竖直 X 标签：底部留白随最长标签高度自适应（不截断，超高时滚动查看）
    const padB = Math.max(40, Math.max(...data.map((r) => r.xName.length)) * 12 + 12);
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const color = axisFg();

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

    const step = plotW / Math.max(1, n);
    const slot = step * 0.7;
    const barColor = "#23a884";
    const lineColor = "#2f81f7";
    hoverShapes = [];

    for (let i = 0; i < n; i++) {
      const r = data[i];
      const cx = padL + step * (i + 0.5);
      const h = (r.value / maxV) * plotH;
      const yTop = padT + plotH - h;

      if (kind === "bar") {
        let x, w;
        if (n === 1) {
          x = padL;
          w = plotW;
        } else {
          x = cx - slot / 2;
          w = slot;
        }
        g.fillStyle = barColor;
        g.fillRect(x, yTop, w, h);
        hoverShapes.push({ type: "rect", x, y: yTop, w, h, label: r.xName, value: r.value, pct: null });

        g.fillStyle = color;
        g.font = "11px sans-serif";
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillText(fmtShort(r.value), cx, yTop - 3);

        // 竖直 X 标签
        drawVerticalXLabel(g, r.xName, cx, padT + plotH + 6);
      } else {
        // line
        g.fillStyle = lineColor;
        g.beginPath();
        g.arc(cx, yTop, 4, 0, Math.PI * 2);
        g.fill();
        hoverShapes.push({ type: "rect", x: cx - 8, y: yTop - 8, w: 16, h: 16, label: r.xName, value: r.value, pct: null });

        if (i > 0) {
          const prev = data[i - 1];
          const prevY = padT + plotH - (prev.value / maxV) * plotH;
          g.strokeStyle = lineColor;
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(cx - step, prevY);
          g.lineTo(cx, yTop);
          g.stroke();
        }

        g.fillStyle = color;
        g.font = "11px sans-serif";
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillText(fmtShort(r.value), cx, yTop - 6);

        g.fillStyle = color;
        g.textAlign = "center";
        g.textBaseline = "top";
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
    const total = data.reduce((s, r) => s + r.value, 0) || 1;
    const cx = W / 2;
    const cy = H / 2 + 6;
    const radius = Math.min(W, H) / 2 - 20;
    const colors = ["#23a884", "#2f81f7", "#e6a23c", "#f56c6c", "#9b59b6", "#1bbc9b", "#f39c12", "#e74c3c", "#3498db", "#7f8c8d"];
    hoverShapes = [];

    let start = -Math.PI / 2;
    for (let i = 0; i < data.length; i++) {
      const v = data[i].value;
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
        value: data[i].value,
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
      g.fillText(`${truncate(data[i].xName, 20)}  ${fmtShort(data[i].value)}`, 26, y + 7);
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
      const pctTxt = hit.pct !== null ? `  (${hit.pct.toFixed(1)}%)` : "";
      tooltipEl.textContent = `${hit.label}\n${fmtShort(hit.value)}${pctTxt}`;
      tooltipEl.style.display = "block";
      tooltipEl.style.left = x + 14 + "px";
      tooltipEl.style.top = y + 14 + "px";
    } else {
      tooltipEl.style.display = "none";
    }
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
      document.getElementById("ea_fileInput").value = msg.filePath;
      document.getElementById("ea_fileStatus").textContent = `已加载 ${msg.rowCount} 行数据，共 ${msg.columns.length} 个字段`;
      populateColumns(msg.columns);
      resetResult();
    } else if (msg.type === "analysisResult") {
      state.statRows = msg.statRows || [];
      state.displayRows = [];
      state.xHeader = msg.xHeader || "X标签";
      state.yHeader = msg.yHeader || "聚合数值";
      state.rowCount = msg.rowCount || 0;
      state.chartType = msg.chartType || "bar";
      state.sortCol = null;
      state.sortDir = "desc";
      if (!state.statRows.length) {
        log("⚠处理后无可用数据，请检查筛选/正则/Y列");
      }
      computeDisplayRows();
      updateSortIndicators();
      renderTable();
      setupCanvas();
    } else if (msg.type === "outFolderSelected") {
      state.outDir = msg.path;
      const el = document.getElementById("ea_outDirInput");
      if (el) {el.value = msg.path;}
      document.getElementById("ea_outStatus").textContent = `导出目录：${msg.path}`;
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
