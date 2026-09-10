// shopTool 前端模块（加载顺序最后 1 个：装配 window.toolClients.shopTool，全部模块已就绪）：事件绑定、初始化与消息分发
// 拆分自原 src/tools/shopTool/client.js，逻辑未改动
    function syncTrendMonthField() {
      const el = $("trendMonthField");
      if (!el) {
        return;
      }
      const isDay = $("trendGroup").value === "day";
      el.style.display = isDay ? "" : "none";
      if (isDay && !$("trendMonth").value) {
        $("trendMonth").value = monthNow();
      }
    }

    function updateNameTemplatePreview() {
      const el = $("nameTemplatePreview");
      if (!el) {
        return;
      }
      const p = state.products[0];
      if (!p) {
        el.textContent = "（暂无商品可预览）";
        return;
      }
      el.textContent = previewNameTemplate($("setNameTemplate").value, p);
    }

    function bindEvents() {
      $("viewListBtn").onclick = () => {
        viewMode = "list";
        $("viewListBtn").classList.add("btn-teal");
        $("viewGalleryBtn").classList.remove("btn-teal");
        renderProducts();
      };
      $("viewGalleryBtn").onclick = () => {
        viewMode = "gallery";
        $("viewGalleryBtn").classList.add("btn-teal");
        $("viewListBtn").classList.remove("btn-teal");
        renderProducts();
      };
      const pgr = $("productPager");
      if (pgr) {
        pgr.addEventListener("click", (e) => {
          const b = e.target.closest("[data-pg]");
          if (!b) {
            return;
          }
          const total = filteredProducts().length;
          const pages = Math.max(1, Math.ceil(total / pageSize));
          if (b.dataset.pg === "prev") {
            if (listPage > 1) {
              listPage--;
            }
          } else if (b.dataset.pg === "next") {
            if (listPage < pages) {
              listPage++;
            }
          }
          renderProducts();
        });
        pgr.addEventListener("change", (e) => {
          if (e.target && e.target.id === "pageSizeSel") {
            pageSize = Math.max(1, Math.floor(Number(e.target.value || "200")));
            listPage = 1;
            renderProducts();
          }
        });
        pgr.addEventListener("keydown", (e) => {
          if (e.target && e.target.id === "pageJump" && e.key === "Enter") {
            const n = Math.floor(Number(e.target.value || "1"));
            if (Number.isFinite(n) && n > 0) {
              const total = filteredProducts().length;
              const pages = Math.max(1, Math.ceil(total / pageSize));
              listPage = Math.min(n, pages);
              renderProducts();
            }
          }
        });
      }
      $("newProductBtn").onclick = openNewProduct;
      $("colSetBtn").onclick = openColSet;
      $("importProductBtn").onclick = openImportProducts;
      $("filterStatus").onchange = () => {
        const v = $("filterStatus").value;
        if (v) {
          filters.f_status = v;
        } else {
          delete filters.f_status;
        }
        syncClearFilterBtn();
        renderProducts();
      };
      $("clearFilterBtn").onclick = () => {
        for (const k of Object.keys(filters)) {
          delete filters[k];
        }
        const fs = $("filterStatus");
        if (fs) {
          fs.value = "";
        }
        syncClearFilterBtn();
        renderProducts();
      };

      $("productListView").addEventListener("dblclick", (e) => {
        const td = e.target.closest("td[data-edit]");
        if (td) {
          openInlineEditor(td);
          return;
        }
      });
      $("productListView").addEventListener("click", onProductAct);
      $("productListView").addEventListener("contextmenu", onProductCtx);
      $("productGalleryView").addEventListener("click", onProductAct);
      $("productGalleryView").addEventListener("contextmenu", onProductCtx);
      $("salesTableWrap").addEventListener("click", onSalesAct);
      if ($("salesKwInput")) {
        $("salesKwInput").oninput = () => {
          salesKw = $("salesKwInput").value;
          renderSales();
        };
      }
      $("salesTableWrap").addEventListener("dblclick", (e) => {
        const td = e.target.closest("td[data-edit]");
        if (td) {
          openSaleEditor(td);
        }
      });
      $("settlesTableWrap").addEventListener("click", onSettleAct);

      $("salesDate").onchange = () =>
        post({ type: "loadSales", date: $("salesDate").value });
      if ($("salesRefreshBtn")) {
        $("salesRefreshBtn").onclick = () =>
          post({ type: "loadSales", date: $("salesDate").value });
      }
      if ($("delSelBtn")) {
        $("delSelBtn").onclick = () => {
          if (selSales.size === 0) {
            return;
          }
          confirmBox(`确认删除选中的 ${selSales.size} 条销售记录？`).then(
            (ok) => {
              if (ok) {
                post({
                  type: "deleteSales",
                  ids: [...selSales],
                  date: $("salesDate").value,
                });
                selSales.clear();
                updateSelBtn();
              }
            },
          );
        };
      }
      $("quickCode").oninput = updateQuickLog;
      $("quickCode").onchange = updateQuickLog;
      const submitQuick = () => {
        const code = canonicalCode($("quickCode").value);
        if (!code) {
          toast("编号格式不对");
          $("quickCode").select();
          return;
        }
        const p = state.products.find((x) => x.code === code);
        if (!p) {
          toast("编号 " + code + " 不在商品档案里，先去「商品管理」新建");
          $("quickCode").select();
          return;
        }
        const sold = Number($("quickSold").value || 0);
        const refund = Number($("quickRefund").value || 0);
        if (
          !Number.isInteger(sold) ||
          !Number.isInteger(refund) ||
          sold < 0 ||
          refund < 0 ||
          (sold === 0 && refund === 0)
        ) {
          toast("卖出/退款需为非负整数，且至少一个 > 0");
          return;
        }
        post({
          type: "saveSale",
          date: $("salesDate").value || nowStr(),
          productId: p.id,
          sold,
          refund,
          note: $("quickNote").value,
          mode: $("dupMode").value,
        });
        $("quickSold").value = "0";
        $("quickRefund").value = "0";
        $("quickNote").value = "";
        $("quickCode").value = "";
        $("quickCode").focus();
        $("quickCode").select();
      };
      $("quickSaveBtn").onclick = submitQuick;
      ["quickCode", "quickSold", "quickRefund", "quickNote"].forEach((id) => {
        const inp = $(id);
        inp.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitQuick();
          }
        };
      });
      $("pasteBtn").onclick = () => {
        const text = $("pasteArea").value;
        if (!text.trim()) {
          toast("先粘贴内容");
          return;
        }
        post({
          type: "pasteSales",
          date: $("salesDate").value || nowStr(),
          text,
          mode: $("dupMode").value,
        });
      };
      $("pasteArea").value = "";
      $("exportProductBtn").onclick = () => {
        const list = filteredProducts();
        if (!list.length) {
          toast("没有可导出的商品");
          return;
        }
        beginExport("exportProductBtn");
        post({
          type: "exportProducts",
          codes: list.map((x) => x.code),
          filtered: list.length < state.products.length ? 1 : 0,
        });
      };
      $("salesFrom").value = monthNow() + "-01";
      $("salesTo").value = nowStr();
      $("exportSalesBtn").onclick = () => {
        beginExport("exportSalesBtn");
        post({
          type: "exportSales",
          dateFrom: $("salesFrom").value,
          dateTo: $("salesTo").value,
        });
      };
      $("exportSettlesBtn").onclick = () => {
        beginExport("exportSettlesBtn");
        post({ type: "exportSettles" });
      };
      $("exportLiveBtn").onclick = () => {
        beginExport("exportLiveBtn");
        post({ type: "exportLivePlan" });
      };
      $("trendBtn").onclick = requestTrend;
      $("trendProduct").onchange = requestTrend;
      $("trendGroup").onchange = () => {
        syncTrendMonthField();
        requestTrend();
      };
      $("trendMonth").onchange = requestTrend;

      $("settleMonth").onchange = () =>
        post({ type: "monthBuild", month: $("settleMonth").value || monthNow() });
      const buildSettle = () =>
        post({ type: "monthBuild", month: $("settleMonth").value || monthNow() });
      const mtTab = document.querySelector('.sub-tab[data-sub="tabMonthly"]');
      if (mtTab) {
        mtTab.addEventListener("click", buildSettle);
      }
      $("settleSaveBtn").onclick = () =>
        post({
          type: "saveSettle",
          month: $("settleMonth").value || monthNow(),
          incomeAmount: Number($("settleIncome").value || 0),
          purchaseCost: Number($("settlePurchase").value || 0),
          extraExpense: Number($("settleExpense").value || 0),
          endStock: Number($("settleEndStock").value || 0),
          startStock: Number(state.settlePrevEnd || 0),
        });
      $("settleLockBtn").onclick = () =>
        post({ type: "lockSettle", month: $("settleMonth").value });
      $("settleUnlockBtn").onclick = async () => {
        if (
          await confirmBox(
            "解锁后，当月销售记录恢复可修改，已保存的月报会重新变为草稿。确认解锁？",
          )
        ) {
          post({ type: "unlockSettle", month: $("settleMonth").value });
        }
      };
      $("settleDeleteBtn").onclick = async () => {
        if (await confirmBox("确认删除该月报？（不会删销售记录）")) {
          post({ type: "deleteSettle", month: $("settleMonth").value });
        }
      };

      $("addRuleBtn").onclick = () => {
        const maxG = state.rules.length
          ? Math.max(...state.rules.map((r) => r.grade))
          : 0;
        state.rules.push({
          grade: maxG + 1,
          label: "等级" + (maxG + 1),
          expr: "cost*1.2",
          tail_mode: "raw",
          tail_value: "",
        });
        renderRules();
      };
      $("saveRulesBtn").onclick = () => {
        const rows = [...document.querySelectorAll("#rulesTable tbody tr")].map(
          (tr) => ({
            grade: Number(tr.querySelector('input[name="grade"]').value),
            label: tr.querySelector('input[name="label"]').value,
            expr: tr.querySelector('input[name="expr"]').value,
            tail_mode: tr.querySelector('select[name="tail_mode"]').value,
            tail_value: tr.querySelector('input[name="tail_value"]').value,
          }),
        );
        post({ type: "saveRules", rules: rows });
      };
      document
        .querySelector("#rulesTable tbody")
        .addEventListener("click", (e) => {
          const btn = e.target.closest("[data-r-act='del']");
          if (btn) {
            const grade = Number(btn.dataset.grade);
            state.rules = state.rules.filter((r) => r.grade !== grade);
            renderRules();
          }
        });

      $("pickImageDirBtn").onclick = () => post({ type: "pickImageDir" });
      $("saveNameTemplateBtn").onclick = () =>
        post({
          type: "saveSettings",
          key: "name_template",
          value: $("setNameTemplate").value,
        });
      $("setNameTemplate").oninput = updateNameTemplatePreview;
      $("saveStockAlertBtn").onclick = () =>
        post({
          type: "saveSettings",
          key: "stock_alert",
          value: String(Number($("setStockAlert").value || 0)),
        });
      $("dbBackupBtn").onclick = () => post({ type: "exportDB" });
      $("dbRestoreBtn").onclick = () =>
        confirmBox("恢复会用所选备份整体替换当前全部数据（商品/库存/销售/月报/排品）。确定继续？").then(
          (ok) => {
            if (ok) {
              post({ type: "importDB" });
            }
          },
        );
      if ($("onboardGoSettings")) {
        $("onboardGoSettings").onclick = () => {
          const tab = document.querySelector('.sub-tab[data-sub="tabSettings"]');
          if (tab) {
            tab.click();
          }
        };
      }
      if ($("onboardDismiss")) {
        $("onboardDismiss").onclick = () => {
          try {
            localStorage.setItem("shopOnboardHidden", "1");
          } catch {
            /* 忽略 */
          }
          const p = $("onboardPanel");
          if (p) {
            p.style.display = "none";
          }
        };
      }
      bindLiveEvents();
    }

    let exportingBtn = null;
    function beginExport(btnId) {
      const btn = $(btnId);
      if (!btn) {
        return;
      }
      btn.dataset.label = btn.dataset.label || btn.textContent;
      exportingBtn = btnId;
      btn.disabled = true;
      btn.textContent = "⏳ 生成中…";
    }
    function endExport() {
      if (exportingBtn) {
        const btn = $(exportingBtn);
        if (btn) {
          btn.disabled = false;
          btn.textContent = btn.dataset.label || "导出";
        }
        exportingBtn = null;
      }
    }

    function maybeShowOnboard() {
      const p = $("onboardPanel");
      if (!p) {
        return;
      }
      let hidden = false;
      try {
        hidden = localStorage.getItem("shopOnboardHidden") === "1";
      } catch {
        /* 忽略 */
      }
      p.style.display = !hidden && state.products.length === 0 ? "" : "none";
    }

    function init() {
      $("salesDate").value = nowStr();
      $("trendMonth").value = monthNow();
      $("settleMonth").value = monthNow();
      syncTrendMonthField();
      bindEvents();
      renderProducts();
      renderLive();
      post({ type: "loadAll" });
      requestTrend();
      post({ type: "monthBuild", month: monthNow() });
    }

    function onMessage(msg) {
      switch (msg.type) {
        case "productsLoaded": {
          state.products = msg.products || [];
          state.settings.stock_alert = msg.stockAlert || 0;
          populateFilters();
          maybeShowOnboard();
          updateNameTemplatePreview();
          break;
        }
        case "rulesLoaded": {
          state.rules = msg.rules || [];
          renderRules();
          break;
        }
        case "settingsLoaded": {
          state.settings = { ...state.settings, ...(msg.settings || {}) };
          renderSettings();
          try {
            const arr = JSON.parse(state.settings.col_visible_list || "[]");
            if (Array.isArray(arr) && arr.length) {
              visList = new Set(arr);
            }
            visList.add("code");
          } catch {
            /* 保持默认 */
          }
          try {
            const arr = JSON.parse(state.settings.col_visible_gallery || "[]");
            if (Array.isArray(arr) && arr.length) {
              visGallery = new Set(arr);
            }
            visGallery.add("code");
          } catch {
            /* 保持默认 */
          }
          renderProducts();
          break;
        }
        case "salesLoaded": {
          state.salesDate = msg.date;
          state.sales = msg.sales || [];
          renderSales();
          updateQuickLog();
          break;
        }
        case "pasteResult": {
          const parts = [
            `新增${msg.created} 更新${msg.updated} 跳过${msg.skipped}`,
          ];
          if (msg.missing && msg.missing.length) {
            parts.push(`未匹配：${msg.missing.join(" ")}`);
          }
          if (msg.badLines && msg.badLines.length) {
            parts.push(
              `无法解析 ${msg.badLines.length} 行：${msg.badLines.join("；")}`,
            );
          }
          $("pasteHint").textContent = parts.join("，");
          break;
        }
        case "productsImported": {
          $("pasteHint").textContent = "";
          toast(`商品导入完成：新增${msg.created}，更新${msg.updated}${msg.skipped ? `，无变更${msg.skipped}` : ""}`);
          maybeShowOnboard();
          break;
        }
        case "settlesLoaded": {
          state.settles = msg.settles || [];
          renderSettles();
          break;
        }
        case "trendLoaded": {
          state.trend = {
            by: msg.by,
            rows: msg.rows || [],
            productId: msg.productId,
          };
          renderTrend();
          break;
        }
        case "monthBuilt": {
          renderSettlePanel(msg);
          break;
        }
        case "coverLoaded": {
          state.coverCache[msg.code] = msg.data || "";
          delete state.coverPending[msg.code];
          coverInFlight = Math.max(0, coverInFlight - 1);
          pumpCovers();
          requestCoverRender();
          renderLivePreviews();
          break;
        }
        case "coverInvalidated": {
          delete state.coverCache[msg.code];
          delete state.coverPending[msg.code];
          requestCoverRender();
          renderLivePreviews();
          break;
        }
        case "liveState": {
          const stars = Array.isArray(msg.stars) ? msg.stars : [];
          const starCodes = stars.map((s) => String(s).trim()).filter(Boolean);
          state.liveStars = new Set(starCodes);
          const plan = Array.isArray(msg.plan) ? msg.plan : [];
          state.livePlan = plan.map((r) => ({
            group_no: Number(r.group_no),
            slot_no: Number(r.slot_no),
            code: String(r.code ?? ""),
          }));
          state.liveOutDir = String(msg.outDir || "");
          renderLive();
          break;
        }
        case "liveGenerated": {
          toast(`已生成 ${msg.count || 0} 张九宫格 → ${msg.dir || ""}`);
          break;
        }
        case "exportDone": {
          endExport();
          const kind = String(msg.kind || "");
          const count = Number(msg.count || 0);
          const path = String(msg.path || "");
          const labels = { products: "商品", sales: "销售流水", settles: "月度结算", live: "排品清单" };
          const units = { products: "条", sales: "条", settles: "个月", live: "款" };
          const scope =
            kind === "products"
              ? msg.filtered
                ? `筛选结果 ${count}`
                : `全部 ${count}`
              : String(count);
          const text = `✅ 已导出${labels[kind] || "内容"} ${scope} ${units[kind] || "条"}：${path}`;
          window.showGlobalToast(text, [
            { label: "📂 查看文件", handler: () => post({ type: "revealFile", path }) },
          ]);
          break;
        }
        case "exportCancelled": {
          endExport();
          break;
        }
        case "toast": {
          toast(String(msg.text ?? ""));
          break;
        }
        case "dbOpError": {
          endExport();
          toast(`❌${String(msg.message ?? "操作失败")}`);
          break;
        }
        case "imagesLoaded": {
          if (state.lbCode !== msg.code) {
            break;
          }
          if (msg.images && msg.images.length) {
            state.coverCache[msg.code] = msg.images[0];
          }
          const thumbs = document.getElementById("lbThumbs");
          const big = document.getElementById("lbBig");
          if (!thumbs || !big) {
            break;
          }
          if (!msg.images.length) {
            thumbs.innerHTML = `<span class="muted" style="color:#bbb">（无图片：把图放到「图片根目录/${esc(msg.code)}」文件夹，或点「🖼 上传图片」）</span>`;
            big.style.display = "none";
            return;
          }
          const big0 = msg.big0 || "";
          big.src = big0;
          big.style.display = "inline-block";
          state.lbIdx = 0;
          thumbs.innerHTML = msg.images
            .map(
              (u, i) =>
                `<img src="${u}" class="${i === 0 ? "active" : ""}" data-i="${i}" />`,
            )
            .join("");
          thumbs.querySelectorAll("img").forEach((img) => {
            img.onclick = () => {
              const idx = Number(img.dataset.i);
              state.lbIdx = idx;
              const key = `${msg.code}:${idx}`;
              thumbs
                .querySelectorAll("img")
                .forEach((x) => x.classList.remove("active"));
              img.classList.add("active");
              const cached = state.lbFullCache[key];
              if (cached) {
                big.src = cached;
              } else if (idx === 0 && big0) {
                state.lbFullCache[key] = big0;
                big.src = big0;
              } else {
                post({ type: "getFullImage", code: msg.code, index: idx });
              }
            };
            img.oncontextmenu = (e) => {
              e.preventDefault();
              const idx = Number(img.dataset.i);
              const key = `${msg.code}:${idx}`;
              let data = state.lbFullCache[key] || "";
              if (!data && idx === 0) {
                data = big0;
              }
              let loading = !data;
              if (loading) {
                state.lbPendingCopy = { code: msg.code, idx };
                post({ type: "getFullImage", code: msg.code, index: idx });
              }
              openLightboxMenu(e, msg.code, idx, data, loading);
            };
          });
          big.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            openLightboxMenu(e, msg.code, state.lbIdx || 0, big.src || "", false);
          });
          break;
        }
        case "fullImageLoaded": {
          if (state.lbCode !== msg.code) {
            break;
          }
          const big = document.getElementById("lbBig");
          if (!big || !msg.data) {
            break;
          }
          state.lbFullCache[`${msg.code}:${msg.index}`] = msg.data;
          big.src = msg.data;
          if (
            state.lbPendingCopy &&
            state.lbPendingCopy.code === msg.code &&
            state.lbPendingCopy.idx === msg.index
          ) {
            const pc = state.lbPendingCopy;
            state.lbPendingCopy = null;
            copyImageFromDataUrl(msg.data).then((ok) =>
              ok ? toast("已复制图片") : toast("复制失败"),
            );
          }
          break;
        }
      }
    }

    function openLightboxMenu(e, code, idx, dataUrl, loading) {
      const items = [
        {
          label: loading ? "📋 复制这张图片（载入中…）" : "📋 复制这张图片",
          run: () => {
            if (loading) {
              toast("原图载入后会自动复制");
              return;
            }
            copyImageFromDataUrl(dataUrl).then((ok) =>
              ok ? toast("已复制图片") : toast("复制失败"),
            );
          },
        },
        { sep: true },
        {
          label: "📂 打开图片文件夹",
          run: () => post({ type: "openImageFile", code }),
        },
        {
          label: "🗑 删除这张图片…",
          danger: true,
          run: () => {
            confirmBox(
              `确认删除 ${code} 的第 ${idx + 1} 张图片？（删除前先自动备份数据目录）`,
            ).then((ok) => {
              if (ok) {
                post({ type: "deleteImageFile", code, index: idx });
              }
            });
          },
        },
      ];
      showImageCtxMenu(e.clientX, e.clientY, items);
    }

window.toolClients.shopTool = {
  init,
  onMessage,
  _state: state,
  _isReady: true,
};
