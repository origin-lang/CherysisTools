// shopTool 前端模块（加载顺序第 5 个）：月度结算（月报/定价规则/设置）
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
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
                ${x.locked === 1 ? `<button class="mini-btn" data-m-act="unlock" data-m="${esc(x.month)}" title="解锁后当月销售可再改">解锁</button>` : `<button class="mini-btn" data-m-act="lock" data-m="${esc(x.month)}" title="锁定后当月销售不能再改（封账）">锁定</button>`}
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
      state.settings.image_dir = state.settings.image_dir || "";
      $("setImageDir").value = state.settings.image_dir;
      $("setNameTemplate").value =
        state.settings.name_template || "{name}{series}{grade}{code}";
      $("setStockAlert").value = Number(state.settings.stock_alert || 0);
      updateNameTemplatePreview();
      $("clearFilterBtn").style.visibility = hasFilter() ? "visible" : "hidden";
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
