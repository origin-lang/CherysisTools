// shopTool 前端模块（加载顺序第 5 个）：月度结算（月报/定价规则/设置）
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
    function switchMonthlyTab(name) {
      document.querySelectorAll("#tabMonthly .mini-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.ntab === name);
      });
      document.querySelectorAll("#tabMonthly .mini-panel").forEach((p) => {
        p.classList.toggle("show", p.id === name + "Panel");
      });
    }

    function renderSettles() {
      const el = $("settlesTableWrap");
      if (!el) {
        return;
      }
      const s = state.settles;
      if (s.length === 0) {
        el.innerHTML = `<p class="muted">（还没有月报，去「📝 本月结算」选月份保存月报）</p>`;
      } else {
        const all = [...s].sort((a, b) => a.month.localeCompare(b.month));
        const byMonth = new Map(all.map((x) => [x.month, x]));
        const years = [...new Set(all.map((x) => x.month.slice(0, 4)))].sort();
        const body = [];
        for (const y of years) {
          const yr = all.filter((x) => x.month.startsWith(y));
          body.push(
            `<tr class="year-row"><td colspan="11">${esc(y)} 年（${yr.length} 个月）</td></tr>`,
          );
          for (const x of yr) {
            const [yy, mm] = x.month.split("-");
            const prev = byMonth.get(`${Number(yy) - 1}-${mm}`);
            const delta = prev ? x.profit - prev.profit : null;
            const yoyCell =
              delta === null
                ? `<td class="num muted" title="无去年同月数据">—</td>`
                : `<td class="num ${delta >= 0 ? "yoy-up" : "yoy-down"}" title="去年同月（${esc(`${Number(yy) - 1}-${mm}`)}）净利润 ¥${money(prev.profit)}">${delta >= 0 ? "▲" : "▼"}¥${money(Math.abs(delta))}</td>`;
            body.push(`<tr>
              <td><b>${esc(x.month)}</b></td>
              <td class="num">¥${money(x.income_amount)}</td>
              <td class="num">¥${money(x.purchase_cost ?? 0)}</td>
              <td class="num">¥${money(x.extra_expense)}</td>
              <td class="num">¥${money(x.start_stock ?? 0)}</td>
              <td class="num">¥${money(x.end_stock ?? 0)}</td>
              <td class="num ${x.profit >= 0 ? "profit-pos" : "profit-neg"}">¥${money(x.profit)}</td>
              ${yoyCell}
              <td class="num">${qty(x.sold_total - x.refund_total)}</td>
              <td>${x.locked === 1 ? '<span class="badge badge-off">已锁定</span>' : '<span class="badge badge-on">草稿</span>'}</td>
              <td>
                <button class="mini-btn" data-m-act="build" data-m="${esc(x.month)}">查看</button>
                ${x.locked === 1 ? `<button class="mini-btn" data-m-act="unlock" data-m="${esc(x.month)}" title="解锁后当月销售可再改">解锁</button>` : `<button class="mini-btn" data-m-act="lock" data-m="${esc(x.month)}" title="锁定后当月销售不能再改（封账）">锁定</button>`}
                <button class="mini-btn btn-danger" data-m-act="del" data-m="${esc(x.month)}" title="删除月报（不影响销售记录）">🗑</button>
              </td>
            </tr>`);
          }
          const sum = (k) => yr.reduce((a, b) => a + Number(b[k] || 0), 0);
          const net = yr.reduce(
            (a, b) =>
              a +
              (Number(b.sold_total || 0) - Number(b.refund_total || 0)),
            0,
          );
          const sumProfit = sum("profit");
          body.push(`<tr class="year-sum">
              <td>${esc(y)} 合计</td>
              <td class="num">¥${money(sum("income_amount"))}</td>
              <td class="num">¥${money(sum("purchase_cost"))}</td>
              <td class="num">¥${money(sum("extra_expense"))}</td>
              <td class="num">—</td>
              <td class="num">—</td>
              <td class="num ${sumProfit >= 0 ? "profit-pos" : "profit-neg"}">¥${money(sumProfit)}</td>
              <td class="num">—</td>
              <td class="num">${qty(net)}</td>
              <td>—</td>
              <td></td>
            </tr>`);
        }
        el.innerHTML = `<table class="data-table"><thead><tr><th>月份</th><th>到账</th><th>进货支出</th><th>杂项</th><th>期初库存</th><th>期末库存</th><th>净利润</th><th>同比</th><th>净售</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${body.join("")}</tbody></table>`;
      }

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
    const { month, snapshot, settle, prevEndStock } = payload;
    if (!$("settleMonth")) {
      return;
    }
    const autoEnd = Number(payload.endStockAuto);
    $("settleMonth").value = month;
    const net = snapshot.sold_total - snapshot.refund_total;
    const locked = !!(settle && settle.locked === 1);
    const startStock =
      settle && settle.start_stock !== null
        ? Number(settle.start_stock)
        : Number(prevEndStock || 0);
    state.settlePrevEnd = startStock;
    $("settleStats").innerHTML =
      `<div class="stat-line">本月销售：卖出 <b>${qty(snapshot.sold_total)}</b> 件，退款 <b>${qty(snapshot.refund_total)}</b> 件，净售 <b>${qty(net)}</b> 件</div>
         <div class="stat-line">期初库存（上月结存，自动）：<b>¥${money(startStock)}</b></div>`;
    const incomeInput = $("settleIncome");
    const purchaseInput = $("settlePurchase");
    const expInput = $("settleExpense");
    const endInput = $("settleEndStock");
    incomeInput.value = settle ? Number(settle.income_amount).toFixed(2) : "";
    purchaseInput.value = settle ? Number(settle.purchase_cost ?? 0).toFixed(2) : "";
    expInput.value = settle ? Number(settle.extra_expense).toFixed(2) : "";
    endInput.value = autoEnd.toFixed(2);
    const upd = () => {
      const income = Number(incomeInput.value || 0);
      const purchase = Number(purchaseInput.value || 0);
      const exp = Number(expInput.value || 0);
      const end = autoEnd;
      const cash = income - purchase - exp;
      const asset = income - purchase + end - exp;
      const profit = income - purchase + end - startStock - exp;
      const cl = profit >= 0 ? "profit-pos" : "profit-neg";
      $("settleProfit").innerHTML =
        `<div class="stat-line muted">现金流（钱袋子）：到账 ¥${money(income)} − 进货 ¥${money(purchase)} − 杂项 ¥${money(exp)} = <b>¥${money(cash)}</b></div>
           <div class="stat-line muted">净资产口径（含库存）：到账 − 进货 + 期末 − 杂项 = <b>¥${money(asset)}</b></div>
           <div class="stat-line">净利润（结转期初）= 到账 − 进货 + 期末 − 期初 − 杂项 = <span class="num-big ${cl}">¥${money(profit)}</span></div>`;
    };
    upd();
    incomeInput.oninput = upd;
    purchaseInput.oninput = upd;
    expInput.oninput = upd;
      $("settleSaveBtn").disabled = locked;
      $("settleSaveBtn").textContent = locked ? "已锁定，不能改" : "保存月报";
      $("settleDeleteBtn").disabled = locked;
      const lockBtn = $("settleLockBtn");
      const unlockBtn = $("settleUnlockBtn");
      const badge = $("settleLockBadge");
      if (locked) {
        lockBtn.style.display = "none";
        unlockBtn.style.display = "";
        badge.style.display = "";
      } else {
        lockBtn.style.display = "";
        unlockBtn.style.display = "none";
        badge.style.display = "none";
        lockBtn.disabled = !settle;
      }
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
      $("setNameTemplate").value =
        state.settings.name_template || "{name}{series}{grade}{code}";
      $("setStockAlert").value = Number(state.settings.stock_alert || 0);
      const rh = String(state.settings.row_height || "5");
      const rhSel = $("setRowHeight");
      const rhCustom = $("setRowHeightCustom");
      if (rhSel) {
        if (["5", "8", "12", "16"].includes(rh)) {
          rhSel.value = rh;
          if (rhCustom) {
            rhCustom.style.display = "none";
          }
        } else {
          rhSel.value = "custom";
          if (rhCustom) {
            rhCustom.value = /^\d+$/.test(rh) ? rh : "12";
            rhCustom.style.display = "";
          }
        }
      }
      const sds = $("setSalesDeductStock");
      if (sds) {
        sds.checked = Number(state.settings.sales_deduct_stock || 1) !== 0;
      }
      const fsSel = $("setFontSize");
      if (fsSel) {
        fsSel.value = /^\d+$/.test(String(state.settings.font_size || "13"))
          ? String(state.settings.font_size)
          : "13";
      }
      updateNameTemplatePreview();
      renderDbPath();
    }

    // 数据库目录那一行：只读展示。路径是环境配置、不是共享设置，给输入框就一定会有人
    // 手滑打成相对路径然后数据「不见了」——要改走旁边的「📁 更换…」。
    function fmtDbSize(n) {
      const b = Number(n);
      if (!Number.isFinite(b) || b < 0) return "（未知）";
      if (b < 1024) return `${b} B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / 1024 / 1024).toFixed(1)} MB`;
    }

    function renderDbPath() {
      const el = $("dbPathText");
      const meta = $("dbPathMeta");
      if (!el) return;
      const dir = String(state.settings.db_path || "");
      el.textContent = dir || "（未设置，用 VS Code 全局存储目录）";
      if (!meta) return;
      const st = state.settings.db_stat;
      if (!st || !Number.isFinite(Number(st.size))) {
        meta.textContent = "shop.db（未创建或读不到——共享盘可能没挂上）";
        meta.style.color = "#e8a33d";
        return;
      }
      const t = new Date(Number(st.mtimeMs));
      const p = (x) => String(x).padStart(2, "0");
      meta.style.color = "";
      meta.textContent = `shop.db · ${fmtDbSize(st.size)} · 最后修改 ${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
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
        switchMonthlyTab("monthlySettle");
      } else if (act === "lock" || act === "unlock") {
        const doPost = () =>
          post({ type: act === "lock" ? "lockSettle" : "unlockSettle", month });
        if (act === "unlock") {
          confirmBox(
            `解锁 ${month} 后，当月销售记录将恢复可修改，已保存的月报会重新变成草稿。确认解锁？`,
          ).then((ok) => {
            if (ok) {
              doPost();
            }
          });
        } else {
          doPost();
        }
      } else if (act === "del") {
        confirmBox(`确认删除 ${month} 月报？`).then((ok) => {
          if (ok) {
            post({ type: "deleteSettle", month });
          }
        });
      }
    }
