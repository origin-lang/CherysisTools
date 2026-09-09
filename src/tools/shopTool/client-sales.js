// shopTool 前端模块（加载顺序第 4 个）：销售录入（今日销售/快捷录入/批量删除/分析趋势）
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
    var salesSortKey = "";
    var salesSortDir = 1;
    var salesKw = "";

    function salesTableRows() {
      let rows = state.sales;
      const kw = String(salesKw || "").trim().toLowerCase();
      if (kw) {
        const kwDigits = kw.replace(/\D/g, "");
        rows = rows.filter((r) => {
          const hay = `${r.code} ${r.name} ${r.note || ""}`.toLowerCase();
          if (hay.includes(kw)) {
            return true;
          }
          if (kwDigits) {
            const codeDigits = r.code.replace(/\D/g, "");
            if (codeDigits.includes(kwDigits)) {
              return true;
            }
          }
          return false;
        });
      }
      if (salesSortKey) {
        const dir = salesSortDir;
        const key = salesSortKey;
        rows = rows.slice().sort((a, b) => {
          if (key === "code") {
            return (Number(a.code.slice(1)) - Number(b.code.slice(1))) * dir;
          }
          if (key === "name" || key === "note") {
            return (
              String(a[key] ?? "").localeCompare(
                String(b[key] ?? ""),
                "zh-Hans-CN",
              ) * dir
            );
          }
          if (key === "net") {
            return (
              (a.sold_qty - a.refund_qty - (b.sold_qty - b.refund_qty)) * dir
            );
          }
          return (Number(a[key] || 0) - Number(b[key] || 0)) * dir;
        });
      }
      return rows;
    }

    function renderSales() {
      $("salesDate").value = state.salesDate || nowStr();
      $("salesDateLabel").textContent = state.salesDate || "";
      const rows = salesTableRows();
      const kept = new Set();
      rows.forEach((r) => {
        if (selSales.has(r.id)) {
          kept.add(r.id);
        }
      });
      selSales = kept;
      const allSel = rows.length > 0 && rows.every((r) => selSales.has(r.id));
      const arrow = (key) =>
        salesSortKey === key ? (salesSortDir === 1 ? " ▲" : " ▼") : "";
      const th = (label, key) =>
        `<th data-sort="${key}" class="sortable" title="点击排序">${label}${arrow(key)}</th>`;
      $("salesTableWrap").innerHTML =
        state.sales.length === 0
          ? `<p class="muted">（当日暂无销售记录）</p>`
          : rows.length === 0
            ? `<p class="muted">（没有符合筛选的记录）</p>`
            : `<table class="data-table"><thead><tr>
            <th style="width:30px"><input type="checkbox" data-s-act="selAll" ${allSel ? "checked" : ""} title="全选 / 取消全选" /></th>
            ${th("编号", "code")}${th("名称", "name")}${th("卖出数量", "sold_qty")}${th("退款数量", "refund_qty")}${th("净售数量", "net")}${th("进价快照", "cost_price")}${th("备注", "note")}<th></th>
          </tr></thead>
          <tbody>${rows
            .map(
              (r) => `<tr class="${selSales.has(r.id) ? "sel" : ""}">
              <td><input type="checkbox" data-s-act="sel" data-id="${r.id}" ${selSales.has(r.id) ? "checked" : ""} /></td>
              <td><b>${esc(r.code)}</b></td><td>${esc(r.name)}</td>
              <td class="num" data-edit="1" data-f="sold_qty" data-id="${r.id}" title="双击修改卖出数量">${qty(r.sold_qty)}</td>
              <td class="num" data-edit="1" data-f="refund_qty" data-id="${r.id}" title="双击修改退款数量">${qty(r.refund_qty)}</td>
              <td class="num ${r.sold_qty - r.refund_qty < 0 ? "num-neg" : ""}">${qty(r.sold_qty - r.refund_qty)}</td>
              <td class="num" title="当天进价快照">¥${money(r.cost_price)}</td><td>${esc(r.note)}</td>
              <td><button class="mini-btn btn-danger" data-s-act="del" data-id="${r.id}" title="删除当日该条销售记录">🗑</button></td>
            </tr>`,
            )
            .join("")}</tbody>
          <tfoot><tr>
            <td colspan="3">合计 ${rows.length} 条</td>
            <td class="num">${qty(rows.reduce((a, r) => a + r.sold_qty, 0))}</td>
            <td class="num">${qty(rows.reduce((a, r) => a + r.refund_qty, 0))}</td>
            <td class="num ${rows.reduce((a, r) => a + r.sold_qty - r.refund_qty, 0) < 0 ? "num-neg" : ""}">${qty(rows.reduce((a, r) => a + r.sold_qty - r.refund_qty, 0))}</td>
            <td colspan="3"></td>
          </tr></tfoot></table>`;
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

    function openSaleEditor(td) {
      const id = Number(td.dataset.id);
      const field = td.dataset.f;
      const orig = td.innerHTML;
      td.dataset.orig = orig;
      const row = state.sales.find((r) => r.id === id);
      const editor = document.createElement("input");
      editor.type = "number";
      editor.min = "0";
      editor.step = "1";
      editor.value = String(
        field === "sold_qty" ? (row?.sold_qty ?? 0) : (row?.refund_qty ?? 0),
      );
      editor.style.cssText =
        "width:100%;max-width:70px;box-sizing:border-box;padding:2px 5px";
      let done = false;
      const finish = (commit) => {
        if (done) {
          return;
        }
        done = true;
        if (commit) {
          const n = Math.floor(Number(editor.value));
          if (!Number.isFinite(n) || n < 0) {
            toast("必须是 ≥0 的整数");
            td.innerHTML = td.dataset.orig;
            delete td.dataset.orig;
            return;
          }
          post({
            type: "updateSalesField",
            id,
            field,
            value: n,
            date: $("salesDate").value,
          });
          toast("已保存");
        }
        td.innerHTML = td.dataset.orig;
        delete td.dataset.orig;
      };
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
        editor.focus();
        editor.select();
      }, 0);
    }

    function onSalesAct(e) {
      const th = e.target.closest("th[data-sort]");
      if (th) {
        const k = th.dataset.sort;
        if (salesSortKey === k) {
          salesSortDir = -salesSortDir;
        } else {
          salesSortKey = k;
          salesSortDir = 1;
        }
        renderSales();
        return;
      }
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
