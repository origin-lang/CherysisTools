// shopTool 前端模块（加载顺序第 6 个）：直播排品（九宫格/加组/生成/预览）
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
    function liveLabelMode() {
      const v = String(state.settings.live_grid_label || "num");
      return v === "code" || v === "none" ? v : "num";
    }

    // ===== 九宫格生成的加载态 =====
    // 存在 state 里而不是只改 DOM：renderLiveGrid 会整块重建分组区的 innerHTML，
    // 只改按钮的话，用户中途改一格编号，忙碌提示就被冲掉了。
    // 一次只允许一个生成任务在跑（所有生成按钮共用这一份忙碌态）。
    function liveGridBusyText(busy) {
      if (busy.phase === "dialog") {
        return busy.text ? `生成中…（${busy.text}）` : "生成中…（选目录中）";
      }
      if (busy.phase === "running") {
        return busy.total > 0
          ? `生成中…（第 ${busy.done}/${busy.total} 组）`
          : "生成中…";
      }
      return "生成中…（准备中）";
    }

    function setLiveGridBusy(busy) {
      state.liveGridBusy = busy || null;
      applyLiveGridBusy();
    }

    function applyLiveGridBusy() {
      const busy = state.liveGridBusy;
      const text = busy ? liveGridBusyText(busy) : "";
      const gen = $("liveGenerateBtn");
      if (gen) {
        gen.disabled = !!busy;
        gen.textContent = busy ? "⏳ 生成中…" : "生成全部九宫格";
      }
      const bar = $("liveGenStatus");
      if (bar) {
        bar.textContent = text;
        bar.style.display = busy ? "" : "none";
      }
      const area = $("liveGridArea");
      if (area) {
        // busy 存在但 groups 丢了也要顶住：这里抛错会把 apply 打断，按钮就再也恢复不了
        const groups = (busy && busy.groups) || [];
        area.querySelectorAll("[data-ls-act='gen']").forEach((b) => {
          const mine = !!busy && groups.indexOf(Number(b.dataset.g)) >= 0;
          b.disabled = !!busy;
          b.textContent = mine ? `⏳ ${text}` : "🖼 生成这组";
        });
      }
    }

    // 后端进度回传：start/dialog/running 续上，done/error/cancelled 一律收工
    function onLiveGridStatus(msg) {
      const phase = String(msg.phase || "");
      if (phase === "done" || phase === "error" || phase === "cancelled") {
        setLiveGridBusy(null);
        return;
      }
      const cur = state.liveGridBusy || { groups: [], done: 0, total: 0 };
      setLiveGridBusy({
        ...cur,
        phase,
        text: String(msg.text || ""),
        done: Number(msg.done ?? cur.done),
        total: Number(msg.total ?? cur.total),
      });
    }

    // 可生成的组（有有效编号的那些）
    function liveGeneratableGroups() {
      return [
        ...new Set(
          state.livePlan
            .filter((r) => r.code && stateProduct(r.code))
            .map((r) => r.group_no),
        ),
      ].sort((a, b) => a - b);
    }

    function renderLiveStars() {
      const wrap = $("liveStarWrap");
      if (!wrap) {
        return;
      }
      const codes = state.liveStars ? [...state.liveStars].sort() : [];
      if (codes.length === 0) {
        wrap.innerHTML = `<p class="muted">（还没选商品：去「商品管理 → 画册」点卡片 ⭐）</p>`;
        return;
      }
      wrap.innerHTML = codes
        .map((c) => {
          const p = stateProduct(c);
          return `<span class="live-star-chip" data-ls-act="fill" data-code="${esc(c)}" title="点击填入下一个空格">
            <span class="code">${esc(c)}</span>
            <span>${p ? esc(p.name) : "（已删除）"}</span>
            <button class="mini-btn btn-danger" data-ls-act="rm" data-code="${esc(c)}" title="移出备选">🗑</button>
          </span>`;
        })
        .join("");
    }

    function renderLiveGrid() {
      const area = $("liveGridArea");
      const label = $("liveOutLabel");
      if (label) {
        label.textContent = state.liveOutDir ? state.liveOutDir : "未选择";
        label.classList.toggle("live-out-unset", !state.liveOutDir);
      }
      if (!area) {
        return;
      }
      // innerHTML 会把所有格子连同 value、光标、焦点一起冲掉，所以重建前先把「用户
      // 正敲着的那个格子」摘出来，末尾再原样还回去。
      // 原先的做法是「焦点在格子里就整个 return」，看着省事实则盖不住焦点正在两格
      // 之间切换的那一瞬——漏过去一次，那个格子就被 value="${code}" 回填成上一次确
      // 认的值，用户敲到一半的内容当场丢掉。改成「照常重绘、保住正在编辑的那一个」。
      const activeEl = document.activeElement;
      const editing =
        activeEl && activeEl.dataset && activeEl.dataset.lsCell !== undefined
          ? {
              g: activeEl.dataset.g,
              slot: activeEl.dataset.slot,
              value: activeEl.value,
              start: activeEl.selectionStart,
              end: activeEl.selectionEnd,
            }
          : null;
      const plan = state.livePlan;
      const groupNos = [...new Set(plan.map((r) => r.group_no))].sort(
        (a, b) => a - b,
      );
      if (groupNos.length === 0) {
        area.innerHTML = `<p class="muted">（空：点「＋ 加一组」开始，或从上方备选里填格子）</p>`;
        applyLiveGridBusy();
        return;
      }
      const seen = new Set();
      const dup = new Set();
      for (const r of plan) {
        if (r.code) {
          if (seen.has(r.code)) {
            dup.add(r.code);
          } else {
            seen.add(r.code);
          }
        }
      }
      area.innerHTML = groupNos
        .map((g) => {
          const slots = plan.filter((r) => r.group_no === g);
          const bySlot = new Map(slots.map((r) => [r.slot_no, r.code]));
          const startNum = (g - 1) * 9 + 1;
          const filled = slots.filter((r) => r.code).length;
          let cells = "";
          for (let s = 1; s <= 9; s++) {
            const code = bySlot.get(s) || "";
            const num = startNum + s - 1;
            const p = code ? stateProduct(code) : null;
            let cls = p
              ? dup.has(code)
                ? "dup"
                : "ok"
              : code
                ? "err"
                : "empty";
            let placeholder = `填${num}号编码`;
            if (code && !p) {
              placeholder = `${num}号 ${esc(code)}（不存在）`;
            } else if (code && dup.has(code)) {
              placeholder = `${num}号 ${esc(code)}（重复）`;
            } else {
              placeholder = `${num}号 ${esc(code)}`;
            }
            const meta = p
              ? `<div class="live-meta"><span class="price">¥${money(p.sale_price)}</span></div>`
              : `<div class="live-meta">&nbsp;</div>`;
            cells += `<div class="live-cell" data-g="${g}">
              <div class="live-cover">${coverTile(bySlot, s, startNum)}</div>
              <input data-ls-cell data-g="${g}" data-slot="${s}" data-num="${num}" class="${cls}" value="${esc(code)}" placeholder="${placeholder}" title="${cls === "dup" ? "重复出现的编号，请检查是否填重了" : ""}" />
              ${meta}
            </div>`;
          }
          // 组头只留两个按钮：绿底的「生成这组」是每组唯一的主操作（排完一组点一次），
          // 必须一直在外面；导入本组/清空本组/删组三个低频或破坏性的收进 ⋯ 下拉。
          // 之前四个肩并肩排着，凑一起约 430px，侧栏那点宽度（组卡片约 338px）根本
          // 放不下，是靠 .g-head 的 flex-wrap 换行才没挤爆；而「删组」紧挨着唯一那个
          // 绿底按钮，误点成本太高。
          return `<div class="live-group">
            <div class="g-head">
              <b>第 ${g} 组</b>
              <span class="muted">${startNum}号~${startNum + 8}号 · ${filled}/9</span>
              <button class="mini-btn g-gen" data-ls-act="gen" data-g="${g}" title="只生成这一组的九宫格">🖼 生成这组</button>
              <button class="mini-btn g-more" data-ls-act="gmore" data-g="${g}" title="更多：导入本组 / 清空本组 / 删组">⋯</button>
            </div>
            <div class="live-grid">${cells}</div>
          </div>`;
        })
        .join("");
      area.querySelectorAll("[data-ls-cell]").forEach((inp, i) => {
        const groupNo = Number(inp.dataset.g);
        const slotNo = Number(inp.dataset.slot);
        // 输入过程中只改本格的样子，一件事都不往外传。
        // 因为 canonicalCode 对没输完的内容照样补零：想敲 336，敲下第一个 3 的瞬间
        // 它得到的就是 A003。此刻若把半成品写进 state.livePlan，一来会被别处触发的
        // 重绘回填给用户（看到的正是那个 003），二来会被 debounce 后的保存写进共享
        // 库，别人打开面板看到一串 A003/A033。真正的落地放到 onblur——那才代表用户
        // 认为这个格子输完了。
        const commitCell = () => {
          const raw = inp.value.trim();
          const code = raw ? canonicalCode(raw) : "";
          let err = false;
          if (raw && !code) {
            err = true;
          } else if (code && !stateProduct(code)) {
            err = true;
          }
          inp.classList.toggle("err", err);
          // 把用户输的 335 显示成规范形式 A335，所见即所存
          if (code && inp.value !== code) {
            inp.value = code;
          }
          const prev = state.livePlan.find(
            (r) => r.group_no === groupNo && r.slot_no === slotNo,
          );
          if ((prev ? prev.code : "") !== code) {
            upsertLiveSlot(groupNo, slotNo, code);
            renderLivePreview(groupNo);
            scheduleLivePlanSave();
          }
          if (code) {
            const dupCount = state.livePlan.filter(
              (r) => r.code === code,
            ).length;
            inp.classList.toggle("dup", dupCount > 1);
          } else {
            inp.classList.remove("dup");
          }
        };

        // 真正的落地放在「用户不再动这个格子」的时候：失焦（点别处、Tab、点生成按钮
        // 都算，blur 早于 click），或者停手满 1.5 秒。
        // 第二档是为了兜住「输完不失焦直接切走面板」——那种情况 blur 不一定来得及
        // 触发，少了它最后一个格子的输入会丢。
        let idleTimer = null;
        inp.oninput = () => {
          const raw = inp.value.trim();
          const code = raw ? canonicalCode(raw) : "";
          const p = code ? stateProduct(code) : null;
          inp.classList.toggle("ok", !!p);
          // 没输完不急着标红（刚敲个 3 就红太吵），等落地那一刻再判
          inp.classList.remove("err", "dup");
          const meta = inp.parentElement
            ? inp.parentElement.querySelector(".live-meta")
            : null;
          if (meta) {
            meta.innerHTML = p
              ? `<span class="price">¥${money(p.sale_price)}</span>`
              : "&nbsp;";
          }
          // 停手兜底，但只兜「已经查得到商品」的那些：还是半成品（刚敲了 3 得到的
          // A003）就不写，让它在 plan 外面待着，省得重绘时冒出来
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (p) {
              commitCell();
            }
          }, 1500);
        };
        inp.onblur = () => {
          clearTimeout(idleTimer);
          commitCell();
        };
        inp.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const next = area.querySelectorAll("[data-ls-cell]")[i + 1];
            if (next) {
              next.focus();
            }
          }
        };
      });
      ensureCovers(
        plan.filter((r) => r.code).map((r) => ({ code: r.code })),
      );
      renderLivePreviews();
      // 分组区刚被 innerHTML 重建，忙碌态要重新贴回按钮上
      applyLiveGridBusy();
      // 把用户正敲着的那个格子的 value、焦点、光标原位放回去。
      // 顺序有讲究：focus() 会把光标推到末尾，所以选定范围必须在 focus 之后。
      // 少了这一段，「重绘」就等于「把人刚敲的半句话擦掉」。
      if (editing) {
        const back = area.querySelector(
          `[data-ls-cell][data-g="${editing.g}"][data-slot="${editing.slot}"]`,
        );
        if (back) {
          back.value = editing.value;
          back.focus();
          try {
            back.setSelectionRange(editing.start, editing.end);
          } catch {
            /* 少数输入控件不支持选区，能保住值和焦点已经够 */
          }
        }
      }
    }

    function coverTile(bySlot, s, startNum) {
      const code = bySlot.get(s) || "";
      const num = startNum + s - 1;
      const numBadge = `<span class="lp-num">${num}号</span>`;
      if (!code) {
        return `<div class="cover-ph">空</div>${numBadge}`;
      }
      const p = stateProduct(code);
      const cover = state.coverCache[code] || "";
      if (cover) {
        return `<img src="${cover}" alt="" />${numBadge}`;
      }
      let cls = "";
      let text = esc(code);
      if (!p) {
        cls = "err";
        text = `${esc(code)}（不存在）`;
      } else {
        const dupCount = state.livePlan.filter((r) => r.code === code).length;
        if (dupCount > 1) {
          cls = "dup";
          text = `${esc(code)}（重复）`;
        }
      }
      return `<div class="cover-ph ${cls}">${text}</div>${numBadge}`;
    }

    function renderLivePreview(groupNo) {
      const area = $("liveGridArea");
      if (!area) {
        return;
      }
      const slots = state.livePlan.filter((r) => r.group_no === groupNo);
      const bySlot = new Map(slots.map((r) => [r.slot_no, r.code]));
      const startNum = (groupNo - 1) * 9 + 1;
      const covers = area.querySelectorAll(
        `.live-cell[data-g="${groupNo}"] .live-cover`,
      );
      covers.forEach((el, i) => {
        el.innerHTML = coverTile(bySlot, i + 1, startNum);
      });
      ensureCovers(
        state.livePlan.filter((r) => r.code).map((r) => ({ code: r.code })),
      );
    }

    function renderLivePreviews() {
      const groupNos = [
        ...new Set(state.livePlan.map((r) => r.group_no)),
      ].sort((a, b) => a - b);
      for (const g of groupNos) {
        renderLivePreview(g);
      }
    }

    function upsertLiveSlot(groupNo, slotNo, code) {
      let plan = state.livePlan.filter(
        (r) => !(r.group_no === groupNo && r.slot_no === slotNo),
      );
      if (code) {
        plan.push({ group_no: groupNo, slot_no: slotNo, code });
      }
      state.livePlan = plan;
    }

    function scheduleLivePlanSave() {
      // 只读模式下压根不发：后端那道闸本来也会拦，发过去只会让日志区每隔 350ms
      // 冒一句「🔒 只读模式」。排品格子在本机照样能拖着改、照样能生成九宫格
      // （生成走 generateLiveGrid，只读时不落库、用前端这份 plan 直接出图），
      // 只是这一次的排布不会存进共享库。
      if (state.readOnly) {
        return;
      }
      clearTimeout(livePlanSaveTimer);
      livePlanSaveTimer = setTimeout(() => {
        post({
          type: "saveLivePlan",
          plan: state.livePlan
            .filter((r) => r.code || r.slot_no === 0)
            .map((r) => ({
              group_no: r.group_no,
              slot_no: r.slot_no,
              code: r.code,
            })),
        });
      }, 350);
    }

    function buildLiveListText() {
      const rows = state.livePlan
        .filter((r) => r.code && stateProduct(r.code))
        .sort((a, b) => a.group_no - b.group_no || a.slot_no - b.slot_no);
      const lines = [];
      let curGroup = 0;
      for (const r of rows) {
        if (r.group_no !== curGroup) {
          if (lines.length) {
            lines.push("");
          }
          curGroup = r.group_no;
          lines.push(`第${curGroup}组`);
        }
        const num = (r.group_no - 1) * 9 + r.slot_no;
        lines.push(`${num}号 ${r.code}`);
      }
      return lines.join("\n");
    }

    function removeLiveGroup(groupNo) {
      state.livePlan = state.livePlan.filter((r) => r.group_no !== groupNo);
      scheduleLivePlanSave();
    }

    function clearLiveGroup(groupNo) {
      const rest = state.livePlan.filter(
        (r) => !(r.group_no === groupNo && r.slot_no !== 0),
      );
      if (!rest.some((r) => r.group_no === groupNo && r.slot_no === 0)) {
        rest.push({ group_no: groupNo, slot_no: 0, code: "" });
      }
      state.livePlan = rest;
      scheduleLivePlanSave();
      renderLiveGrid();
    }

    function findNextLiveGroupNo() {
      const existing = new Set(state.livePlan.map((r) => r.group_no));
      let g = 1;
      while (existing.has(g)) {
        g++;
      }
      return g;
    }

    function findNextEmptySlot() {
      const occupied = new Set();
      let maxG = 0;
      for (const r of state.livePlan) {
        occupied.add(`${r.group_no}-${r.slot_no}`);
        if (r.group_no > maxG) {
          maxG = r.group_no;
        }
      }
      for (let g = 1; g <= maxG + 1; g++) {
        for (let s = 1; s <= 9; s++) {
          if (!occupied.has(`${g}-${s}`)) {
            return { group_no: g, slot_no: s };
          }
        }
      }
      return { group_no: maxG + 1, slot_no: 1 };
    }

    function fillNextEmptySlot(code) {
      const slot = findNextEmptySlot();
      upsertLiveSlot(slot.group_no, slot.slot_no, code);
      scheduleLivePlanSave();
      renderLiveGrid();
      const num = (slot.group_no - 1) * 9 + slot.slot_no;
      toast(`${code} → ${num}号`);
    }

    function generateGroup(groupNo) {
      const filled = state.livePlan.filter(
        (r) => r.group_no === groupNo && r.code && stateProduct(r.code),
      );
      if (filled.length === 0) {
        toast(`第 ${groupNo} 组没有可生成的商品`);
        return;
      }
      scheduleLivePlanSave();
      // 先置「生成中」再发请求：后端要弹原生目录/确认框，网页这边不先动一下看着像没点上
      setLiveGridBusy({ phase: "start", groups: [groupNo], done: 0, total: 1 });
      post({
        type: "generateLiveGrid",
        plan: state.livePlan.map((r) => ({ ...r })),
        groups: [groupNo],
        labelMode: liveLabelMode(),
      });
    }

    function openImportLiveGroup(groupNo) {
      const radio = (val, label, checked) =>
        `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;cursor:pointer"><input type="radio" name="liSep" value="${val}"${checked ? " checked" : ""}/>${label}</label>`;
      const mask = showModal(`
        <h3>导入本组（第 ${groupNo} 组）清单</h3>
        <p class="muted" style="margin-bottom:6px">分隔符（只能选一种，不可混用）：</p>
        <div style="margin-bottom:8px">
          ${radio("space", "空格", true)}
          ${radio("tab", "Tab")}
          ${radio("comma", "逗号")}
          ${radio("line", "换行")}
        </div>
        <textarea id="liText" placeholder="粘贴本组最多 9 个编号，每项必须是真实存在的编号（如 A001 / L007）。导入会先清空本组再按顺序填入。" style="display:block;width:100%;box-sizing:border-box;min-height:96px;margin-bottom:6px"></textarea>
        <p class="muted" id="liDesc" style="margin-bottom:8px"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="liCancel">取消</button>
          <button id="liDo" class="btn-teal">导入</button>
        </div>`);
      const splitTokens = (sep, text) => {
        const s = String(text || "").trim();
        if (!s) {
          return [];
        }
        return s
          .split(
            sep === "space"
              ? /[ \u3000]+/
              : sep === "tab"
                ? /\t+/
                : sep === "comma"
                  ? /[,，]+/
                  : /\r?\n+/,
          )
          .map((t) => t.trim())
          .filter(Boolean)
          // 纯数字（如 332）自动规范成真实编号 A332；无法规范的原样保留以便标「不合法」
          .map((t) => canonicalCode(t) ?? t);
      };
      const curSep = () => {
        const r = [...mask.querySelectorAll('input[name="liSep"]')].find(
          (x) => x.checked,
        );
        return r ? r.value : "space";
      };
      const renderLi = () => {
        const tokens = splitTokens(curSep(), $("liText").value);
        const invalid = tokens.filter((t) => !stateProduct(t));
        $("liDesc").textContent =
          tokens.length === 0
            ? "等待输入…"
            : `识别 ${tokens.length} 个编号 → 有效 ${tokens.length - invalid.length} 个${
                invalid.length > 0
                  ? `，不合法：${invalid.slice(0, 5).join("、")}${
                      invalid.length > 5 ? ` 等${invalid.length}个` : ""
                    }`
                  : "，全部合法"
              }`;
      };
      mask.querySelectorAll('input[name="liSep"]').forEach((r) => {
        r.onchange = () => renderLi();
      });
      $("liText").oninput = renderLi;
      $("liCancel").onclick = closeModal;
      $("liDo").onclick = () => {
        const tokens = splitTokens(curSep(), $("liText").value);
        if (tokens.length === 0) {
          toast("没有可导入的编号");
          return;
        }
        const invalid = tokens.filter((t) => !stateProduct(t));
        if (invalid.length > 0) {
          toast(
            `已拒绝导入：不合法编号 ${invalid.slice(0, 5).join("、")}${
              invalid.length > 5 ? ` 等${invalid.length}个` : ""
            }`,
          );
          return;
        }
        if (tokens.length > 9) {
          toast(`本组最多 9 个，当前 ${tokens.length} 个`);
          return;
        }
        let plan = state.livePlan.filter((r) => r.group_no !== groupNo);
        plan.push({ group_no: groupNo, slot_no: 0, code: "" });
        tokens.forEach((code, i) => {
          plan.push({ group_no: groupNo, slot_no: i + 1, code });
        });
        state.livePlan = plan;
        scheduleLivePlanSave();
        renderLiveGrid();
        toast(`第 ${groupNo} 组已导入 ${tokens.length} 个`);
      };
      renderLi();
    }

    // 组头「⋯」下拉：导入本组 / 清空本组 / 删组。复用图片右键菜单那个通用组件
    // （client-core.js 的 showImageCtxMenu），自带点外面关 / Esc / 贴右缘翻转。
    // 菜单项一律用短名（4 个字内）：菜单宽由 min-width:160px 兜着，而组件贴右缘
    // 时按 180px 估算位置，标签一长右边就会被裁掉。
    function showGroupMenu(btn) {
      const g = Number(btn.dataset.g);
      const rect = btn.getBoundingClientRect();
      showImageCtxMenu(rect.left, rect.bottom, [
        { label: "导入本组", run: () => openImportLiveGroup(g) },
        { label: "清空本组", run: () => confirmClearGroup(g) },
        { sep: true },
        { label: "删组", run: () => confirmDeleteGroup(g), danger: true },
      ]);
    }

    function confirmClearGroup(groupNo) {
      confirmBox(`确认清空第 ${groupNo} 组的全部格子？`).then((ok) => {
        if (ok) {
          clearLiveGroup(groupNo);
        }
      });
    }

    function confirmDeleteGroup(groupNo) {
      const n = state.livePlan.filter(
        (r) => r.group_no === groupNo && r.code,
      ).length;
      // 删组会把这一组的排品从共享库里抹掉、别人那边也会消失，属于不可逆操作
      confirmBox(
        n > 0
          ? `确认删除第 ${groupNo} 组？（该组的 ${n} 个排品格子会被清空，商品本身不受影响）`
          : `确认删除第 ${groupNo} 组？`,
      ).then((ok) => {
        if (ok) {
          removeLiveGroup(groupNo);
          renderLiveGrid();
          toast(`已删除第 ${groupNo} 组`);
        }
      });
    }

    function bindLiveEvents() {
      const add = $("liveAddGroupBtn");
      if (add) {
        add.onclick = () => {
          const groupNo = findNextLiveGroupNo();
          state.livePlan.push({ group_no: groupNo, slot_no: 0, code: "" });
          scheduleLivePlanSave();
          renderLiveGrid();
        };
      }
      const clr = $("liveClearBtn");
      if (clr) {
        clr.onclick = () => {
          confirmBox("确认清空所有排品格子？（已选商品保留）").then((ok) => {
            if (ok) {
              state.livePlan = [];
              post({ type: "clearLivePlan" });
              renderLiveGrid();
            }
          });
        };
      }
      const pick = $("livePickOutBtn");
      if (pick) {
        pick.onclick = () => post({ type: "pickLiveOutDir" });
      }
      const labelSel = $("liveGridLabel");
      if (labelSel) {
        const saved = String(state.settings.live_grid_label || "num");
        labelSel.value = saved === "code" || saved === "none" ? saved : "num";
        labelSel.onchange = () => {
          state.settings.live_grid_label = labelSel.value;
          post({ type: "saveSettings", key: "live_grid_label", value: labelSel.value });
        };
      }
      const gen = $("liveGenerateBtn");
      if (gen) {
        gen.onclick = () => {
          const groupNos = liveGeneratableGroups();
          if (groupNos.length === 0) {
            toast("先往格子里填至少一个有效编号");
            return;
          }
          scheduleLivePlanSave();
          setLiveGridBusy({ phase: "start", groups: groupNos, done: 0, total: groupNos.length });
          post({
            type: "generateLiveGrid",
            plan: state.livePlan.map((r) => ({ ...r })),
            labelMode: liveLabelMode(),
          });
        };
      }
      const cpy = $("liveCopyListBtn");
      if (cpy) {
        cpy.onclick = () => {
          const text = buildLiveListText();
          if (!text) {
            toast("没有可复制的排品");
            return;
          }
          copyText(text, "清单已复制 ✅");
        };
      }
      const wrap = $("liveStarWrap");
      if (wrap) {
        wrap.addEventListener("click", (e) => {
          const rmBtn = e.target.closest("[data-ls-act='rm']");
          if (rmBtn) {
            const c = rmBtn.dataset.code;
            const set = new Set(state.liveStars || []);
            set.delete(c);
            state.liveStars = set;
            post({ type: "setLiveStars", codes: [...set] });
            return;
          }
          const chip = e.target.closest("[data-ls-act='fill']");
          if (chip) {
            fillNextEmptySlot(chip.dataset.code);
          }
        });
      }
      const area = $("liveGridArea");
      if (area) {
        area.addEventListener("click", (e) => {
          const genBtn = e.target.closest("[data-ls-act='gen']");
          if (genBtn) {
            generateGroup(Number(genBtn.dataset.g));
            return;
          }
          // 菜单本体挂在 document.body 上、不在 #liveGridArea 里，所以点菜单项
          // 不会再冒回来触发这条委托，三个动作只有 showGroupMenu 里那一份实现。
          const moreBtn = e.target.closest("[data-ls-act='gmore']");
          if (moreBtn) {
            showGroupMenu(moreBtn);
          }
        });
      }
    }

    function renderLive() {
      renderLiveStars();
      renderLiveGrid();
    }

    let livePlanSaveTimer = null;
