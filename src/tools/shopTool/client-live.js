// shopTool 前端模块（加载顺序第 6 个）：直播排品（九宫格/加组/生成/预览）
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
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
        label.textContent = state.liveOutDir
          ? `输出：${state.liveOutDir}`
          : "（未选择输出目录）";
      }
      if (!area) {
        return;
      }
      const activeEl = document.activeElement;
      if (activeEl && activeEl.closest && activeEl.closest("[data-ls-cell]")) {
        return;
      }
      const plan = state.livePlan;
      const groupNos = [...new Set(plan.map((r) => r.group_no))].sort(
        (a, b) => a - b,
      );
      if (groupNos.length === 0) {
        area.innerHTML = `<p class="muted">（空：点「＋ 加一组」开始，或从上方备选里填格子）</p>`;
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
          let cells = "";
          for (let s = 1; s <= 9; s++) {
            let code = bySlot.get(s) || "";
            const num = startNum + s - 1;
            let cls = "";
            let placeholder = `填${num}号编码`;
            if (code) {
              const p = stateProduct(code);
              if (!p) {
                cls = "err";
                placeholder = `${num}号 ${esc(code)}（不存在）`;
              } else if (dup.has(code)) {
                cls = "dup";
                placeholder = `${num}号 ${esc(code)}（重复）`;
              } else {
                cls = "ok";
                placeholder = `${num}号 ${esc(code)}`;
              }
            } else {
              cls = "empty";
            }
            cells += `<div class="live-cell" data-g="${g}">
              <div class="live-cover">${coverTile(bySlot, s, startNum)}</div>
              <input data-ls-cell data-g="${g}" data-slot="${s}" data-num="${num}" class="${cls}" value="${esc(code)}" placeholder="${placeholder}" title="${cls === "dup" ? "重复出现的编号，请检查是否填重了" : ""}" />
            </div>`;
          }
          return `<div class="live-group">
            <div class="g-head">
              <b>第 ${g} 组</b>
              <span class="muted">${startNum}号~${startNum + 8}号</span>
              <button class="mini-btn g-gen" data-ls-act="gen" data-g="${g}" title="只生成这一组的九宫格">🖼 生成这组</button>
              <button class="mini-btn btn-danger g-del" data-ls-act="delgroup" data-g="${g}">删组</button>
            </div>
            <div class="live-grid">${cells}</div>
          </div>`;
        })
        .join("");
      area.querySelectorAll("[data-ls-cell]").forEach((inp, i) => {
        const groupNo = Number(inp.dataset.g);
        const slotNo = Number(inp.dataset.slot);
        inp.oninput = () => {
          const raw = inp.value.trim();
          const code = raw ? canonicalCode(raw) : "";
          if (code && stateProduct(code)) {
            inp.classList.add("ok");
          } else {
            inp.classList.remove("ok");
          }
          upsertLiveSlot(groupNo, slotNo, code);
          renderLivePreview(groupNo);
          scheduleLivePlanSave();
        };
        inp.onblur = () => {
          const raw = inp.value.trim();
          const code = raw ? canonicalCode(raw) : "";
          let err = false;
          if (raw && !code) {
            err = true;
          } else if (code && !stateProduct(code)) {
            err = true;
          }
          inp.classList.toggle("err", err);
          if (code) {
            const dupCount = state.livePlan.filter(
              (r) => r.code === code,
            ).length;
            inp.classList.toggle("dup", dupCount > 1);
          } else {
            inp.classList.remove("dup");
          }
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
      post({
        type: "generateLiveGrid",
        plan: state.livePlan.map((r) => ({ ...r })),
        groups: [groupNo],
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
      const gen = $("liveGenerateBtn");
      if (gen) {
        gen.onclick = () => {
          const filled = state.livePlan.filter(
            (r) => r.code && stateProduct(r.code),
          );
          if (filled.length === 0) {
            toast("先往格子里填至少一个有效编号");
            return;
          }
          scheduleLivePlanSave();
          post({
            type: "generateLiveGrid",
            plan: state.livePlan.map((r) => ({ ...r })),
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
          const btn = e.target.closest("[data-ls-act='delgroup']");
          if (btn) {
            removeLiveGroup(Number(btn.dataset.g));
            renderLiveGrid();
          }
        });
      }
    }

    function renderLive() {
      renderLiveStars();
      renderLiveGrid();
    }

    let livePlanSaveTimer = null;
