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
  // 视图二选一：选中态是 .active，交给工具栏那个连体分段开关（.tb-seg）去画。
  // 原来这里是 add/remove("btn-teal") —— 用品牌绿表示选中，但它跟右上角
  // 「＋ 新建商品」的绿撞在一起，一个颜色两种含义。品牌绿现在只留给主操作。
  $("viewListBtn").onclick = () => {
    viewMode = "list";
    $("viewListBtn").classList.add("active");
    $("viewGalleryBtn").classList.remove("active");
    syncGallerySizeVisibility();
    renderProducts();
  };
  $("viewGalleryBtn").onclick = () => {
    viewMode = "gallery";
    $("viewGalleryBtn").classList.add("active");
    $("viewListBtn").classList.remove("active");
    syncGallerySizeVisibility();
    renderProducts();
  };
  const gsSel = $("gallerySize");
  if (gsSel) {
    gsSel.onchange = () => saveGallerySize(gsSel.value);
  }
  // 鼠标选完下拉就交还焦点：Chromium 只在 <select> **有焦点**时才把滚轮当上下键使，
  // 焦点一直留着 → 鼠标划过它滚一下就把值改了（画册大小「自己变大变小」就是这个），
  // 而且改完还会把误触的值存进本机偏好。走 document 上的 change 委托，
  // 装一次覆盖全部下拉（含各处动态生成的），见 client-core.js。
  installSelectBlurAfterPick();
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
  $("ioBtn").onclick = openIoMenu;
  $("undoBtn").onclick = () => post({ type: "undoRequest" });
  $("redoBtn").onclick = () => post({ type: "redoRequest" });
  $("undoSalesBtn").onclick = () => post({ type: "undoRequest" });
  $("redoSalesBtn").onclick = () => post({ type: "redoRequest" });
  document.querySelectorAll("#tabSales .mini-tab").forEach((t) => {
    t.onclick = () => switchSalesTab(t.dataset.stab);
  });
  // 工具栏全局搜索。跟删掉前那版最大的区别是加了防抖：老版 oninput 直连 renderProducts，
  // 敲一个字就把全表重画一遍，手感发飘。
  const kwInput = $("keywordSearch");
  const kwX = $("keywordSearchX");
  const kwScopeSel = $("keywordScope");
  const kwSelect = $("keywordSelect");
  // 「搜哪一列」选到哪一类，右边就换什么控件。形态与控件值由 client-product.js 的
  // syncSearchRow() 摆（kwScope / filters / 各列选项的出处都在那边），这里只管接线。
  // 状态/品类/等级走下拉那一类：取值封闭，让用户手打中文等于让他去猜系统内部存的是哪两个字，
  // 打错一个就是个空表。选项数据在 client-product.js 的 scopeSelectOptions()。
  const isSelectScope = () => KW_SELECT_SCOPES.has(kwScope);
  /** 生效的搜索词。下拉那几列的条件**不在搜索框里** —— 它们直接写进列筛选
      filters.f_<列>（跟筛选面板同一份），所以这里必须回空串；不然切到「状态」时
      上一段文字还留在 filters.keyword 里继续筛，列表会莫名其妙少一片。 */
  const activeKeywordRaw = () => (isSelectScope() ? "" : kwInput ? kwInput.value.trim() : "");
  // ✕ 有字才出现，空框上摆个清空按钮纯属多余；换了下拉时整块输入框都藏了，✕ 自然也不该露
  const syncKwX = () => {
    if (kwX) {
      kwX.hidden = isSelectScope() || !kwInput.value;
    }
  };
  const applyKeyword = () => {
    const v = activeKeywordRaw();
    if (v) {
      filters.keyword = v;
    } else {
      delete filters.keyword;
    }
    syncKwX();
    syncClearFilterBtn();
    renderProducts();
  };
  const applyKeywordSoon = debounce(applyKeyword, 200);
  kwInput.oninput = () => {
    // ✕ 立刻跟手，只有重画列表才防抖
    syncKwX();
    // 编号模式**不能边打边筛**：区间语法有中间态（A → A1 → A1~），一路筛列表会来回闪，
    // 而且中间态常常被判成"写法有问题"（0 结果 + 红框）。提交走回车 / 失焦 ——
    // 跟手机版和筛选面板同一个口径。
    if (kwScope === "code") {
      return;
    }
    applyKeywordSoon();
  };
  kwInput.onkeydown = (ev) => {
    // Esc 清空并立刻生效，不等那个还在跑的防抖计时器
    if (ev.key === "Escape") {
      ev.preventDefault();
      kwInput.value = "";
      applyKeyword();
      return;
    }
    // 回车不等防抖了，马上生效
    if (ev.key === "Enter") {
      ev.preventDefault();
      kwInput.value = kwInput.value.trim();
      applyKeyword();
    }
  };
  // 电脑上回车是习惯动作，编号模式点别处同样该生效 —— 否则就是当年那条「编号筛选填了没反应」
  kwInput.onblur = () => {
    if (kwScope === "code") {
      applyKeyword();
    }
  };
  // ✕ 走同步路径，不然点了之后还得等 200ms 才变
  if (kwX) {
    kwX.onclick = () => {
      kwInput.value = "";
      applyKeyword();
    };
  }
  if (kwSelect) {
    // 下拉没有「回车才生效」的说法，选完就是选完了（跟手机版一致）。
    // 写进列筛选那一份，所以跟筛选抽屉是同一个条件，天然联动。
    kwSelect.onchange = () => {
      const v = kwSelect.value;
      applyFilterValue(kwScope, v ? [v] : []);
      // 面板开着的话，那一组的勾和摘要跟着走
      renderFilterDrawerIfOpen();
    };
  }
  // 换搜索范围一定要重算一次：进/出「状态」是换了个控件取值（正搜着「香薰」时切到状态列，
  // 它一个都匹配不上），进/出「编号」是换了一套解析（子串 → 区间语法）。
  if (kwScopeSel) {
    kwScopeSel.onchange = () => {
      kwScope = kwScopeSel.value;
      syncSearchRow();
      applyKeyword();
    };
  }
  // 浏览器刷新（F5）会恢复 input/select 的控件值，但 filters 是空的。
  // 以控件当前值为准对齐一次。这里只摆控件与占位符，不调 renderProducts() ——
  // 首刷发生在 initDom 之后。
  if (kwScopeSel) {
    kwScope = kwScopeSel.value;
  }
  syncSearchRow();
  const initKeyword = activeKeywordRaw();
  if (initKeyword) {
    filters.keyword = initKeyword;
    syncClearFilterBtn();
  }
  syncKwX();
  // 「清除全部」在筛选条上（原来在工具栏里）。行为没变：清搜索词 + 所有列筛选。
  $("clearFilterBtn").onclick = () => {
    for (const k of Object.keys(filters)) {
      delete filters[k];
    }
    // 状态在 filters 里、输入框里的字不在，清完状态得把框和 ✕ 也抹平，
    // 否则框里还留着字、列表却是全量，看着像筛选没生效
    kwInput.value = "";
    // 搜索行那个下拉也归位（它就是状态/品类/等级这三列的筛选值，不清就等于没清干净）；
    // 「搜哪一列」那个下拉不复位：它是偏好（和「字段显示」同类）不是筛选条件，
    // 而空框上 placeholder 会一直写着当前搜哪一列，漏不掉。
    syncSearchRow();
    syncKwX();
    syncClearFilterBtn();
    // 面板开着的话，里面的勾/输入框也得跟着归位（否则面板还显示着已经清掉的旧条件）
    renderFilterDrawerIfOpen();
    renderProducts();
  };
  $("starMenuBtn").onclick = (e) => showStarMenu(e.currentTarget);
  const drawerBackdrop = $("drawerBackdrop");
  if (drawerBackdrop) {
    drawerBackdrop.onclick = closeProductDrawer;
  }
  // ===== 筛选条 / 筛选抽屉 =====
  // 胶囊上的 ✕ 用事件委托：胶囊是 renderFilterBar 整块重画的，
  // 逐个绑 onclick 会在每次重画后丢光。
  $("filterChips").addEventListener("click", (e) => {
    const x = e.target.closest("[data-fb-x]");
    if (x) {
      clearOneFilter(x.dataset.fbX);
    }
  });
  $("filterOpenBtn").onclick = openFilterDrawer;
  const filterMask = $("filterDrawerMask");
  if (filterMask) {
    filterMask.onclick = closeFilterDrawer;
  }
  // Esc 关筛选抽屉。关着的时候是空操作，不会去抢别处的 Esc（图片大图、右键菜单那些）。
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && filterDrawerOpen) {
        closeFilterDrawer();
      }
    },
    true,
  );

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
  bindImageDropPaste();
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#productListView td[data-pid]") && selCell) {
      selCell = null;
      document
        .querySelectorAll(".cell-selected")
        .forEach((el) => el.classList.remove("cell-selected"));
    }
  });
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    ) {
      return;
    }
    if (document.getElementById("ctxMenu")) {
      return;
    }
    if (e.key === "Escape") {
      if (selCell) {
        selCell = null;
        document
          .querySelectorAll(".cell-selected")
          .forEach((el) => el.classList.remove("cell-selected"));
      }
      return;
    }
    if ((!e.ctrlKey && !e.metaKey) || !selCell) {
      return;
    }
    const p = state.products.find((x) => x.id === selCell.pid);
    if (!p) {
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "c") {
      e.preventDefault();
      copyCell(p, selCell.field);
    } else if (k === "x") {
      e.preventDefault();
      if (!CUTTABLE_FIELDS.has(selCell.field)) {
        toast("该列不可清空，无法剪切");
        return;
      }
      cutCell(p, selCell.field);
    } else if (k === "v") {
      e.preventDefault();
      if (!EDITABLE_FIELDS.has(selCell.field)) {
        toast("该列不可编辑，无法粘贴");
        return;
      }
      pasteCell(p.id, selCell.field);
    }
  });
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
  if ($("refreshProductsBtn")) {
    $("refreshProductsBtn").onclick = () => post({ type: "loadAll" });
  }
  if ($("readOnlyBtn")) {
    $("readOnlyBtn").onclick = () => {
      // 切到只读前先说一句：真有人开着写的时候锁上，会挡住自己的活
      if (state.readOnly) {
        post({ type: "setReadOnly", value: false });
        return;
      }
      confirmBox("切到只读模式？").then((ok) => {
        if (ok) {
          post({ type: "setReadOnly", value: true });
        }
      });
    };
  }
  if ($("delSelBtn")) {
    $("delSelBtn").onclick = () => {
      if (selSales.size === 0) {
        return;
      }
      confirmBox(`确认删除选中的 ${selSales.size} 条销售记录？`).then((ok) => {
        if (ok) {
          post({
            type: "deleteSales",
            ids: [...selSales],
            date: $("salesDate").value,
          });
          selSales.clear();
          updateSelBtn();
        }
      });
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
  $("salesFrom").value = monthNow() + "-01";
  $("salesTo").value = nowStr();
  if ($("salesPreviewBtn")) {
    $("salesPreviewBtn").onclick = toggleSalesExportPreview;
  }
  if ($("salesFrom")) {
    $("salesFrom").onchange = () => {
      if (salesPreviewOpen) {
        post({
          type: "salesExportPreview",
          dateFrom: $("salesFrom").value,
          dateTo: $("salesTo").value,
        });
      }
    };
  }
  if ($("salesTo")) {
    $("salesTo").onchange = () => {
      if (salesPreviewOpen) {
        post({
          type: "salesExportPreview",
          dateFrom: $("salesFrom").value,
          dateTo: $("salesTo").value,
        });
      }
    };
  }
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
  document.querySelectorAll("#tabMonthly .mini-tab").forEach((t) => {
    t.onclick = () => switchMonthlyTab(t.dataset.ntab);
  });
  const shiftMonth = (month, delta) => {
    const [y, m] = String(month || monthNow()).split("-").map(Number);
    if (!y || !m) {
      return monthNow();
    }
    const total = y * 12 + (m - 1) + delta;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
  };
  const jumpSettleMonth = (month) => {
    $("settleMonth").value = month;
    post({ type: "monthBuild", month });
  };
  $("settlePrevMonth").onclick = () =>
    jumpSettleMonth(shiftMonth($("settleMonth").value, -1));
  $("settleNextMonth").onclick = () =>
    jumpSettleMonth(shiftMonth($("settleMonth").value, 1));
  $("settleThisMonth").onclick = () => jumpSettleMonth(monthNow());
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
  document.querySelector("#rulesTable tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-r-act='del']");
    if (btn) {
      const grade = Number(btn.dataset.grade);
      state.rules = state.rules.filter((r) => r.grade !== grade);
      renderRules();
    }
  });

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
  const setSalesDeductStock = $("setSalesDeductStock");
  if (setSalesDeductStock) {
    setSalesDeductStock.onchange = () =>
      post({
        type: "saveSettings",
        key: "sales_deduct_stock",
        value: setSalesDeductStock.checked ? "1" : "0",
      });
  }
  const rhSel = $("setRowHeight");
  const rhCustom = $("setRowHeightCustom");
  if (rhSel) {
    rhSel.onchange = () => {
      if (rhSel.value === "custom") {
        if (rhCustom) {
          rhCustom.style.display = "";
          rhCustom.focus();
        }
        return;
      }
      if (rhCustom) {
        rhCustom.style.display = "none";
      }
      saveRowHeight(rhSel.value);
    };
  }
  if (rhCustom) {
    rhCustom.onblur = () => {
      saveRowHeight(rhCustom.value || "5");
    };
    rhCustom.onchange = () => {
      saveRowHeight(rhCustom.value || "5");
    };
    rhCustom.onkeydown = (e) => {
      if (e.key === "Enter") {
        rhCustom.blur();
      }
    };
  }
  const fsSel = $("setFontSize");
  if (fsSel) {
    fsSel.onchange = () => saveFontSize(fsSel.value);
  }
  $("dbBackupBtn").onclick = () => post({ type: "exportDB" });
  if ($("buildSharedThumbsBtn")) {
    // 后台跑、日志报进度，点完就能继续用面板；重复点后端会拦（同一时间只跑一个）
    $("buildSharedThumbsBtn").onclick = () => post({ type: "buildSharedThumbs" });
  }
  if ($("dbPathBtn")) {
    // webview 里没有 executeCommand，只能 post 给扩展侧去叫命令。选目录的流程
    // 只有命令里那一份（校验/确认/关连接/清快照），面板不重复实现，免得两处对不上。
    $("dbPathBtn").onclick = () => post({ type: "pickStorageDir" });
  }

  $("dbRestoreBtn").onclick = () =>
    confirmBox(
      "恢复会用所选备份整体替换当前全部数据（商品/库存/销售/月报/排品）。确定继续？",
    ).then((ok) => {
      if (ok) {
        post({ type: "importDB" });
      }
    });
  bindLiveEvents();
}

/** 「画册大小」是画册视图专属的控件：列表视图里它没有作用对象，摆着只会挤工具栏 */
function syncGallerySizeVisibility() {
  const sel = $("gallerySize");
  if (sel) {
    sel.hidden = viewMode !== "gallery";
  }
}

function applyRowHeight(raw) {
  const n = Math.max(0, Math.min(50, parseInt(String(raw || "5"), 10) || 5));
  const tab = $("tabProducts");
  if (tab) {
    tab.style.setProperty("--row-py", n + "px");
    const lines = Math.max(3, Math.min(8, 3 + Math.round((n - 2) / 3)));
    tab.style.setProperty("--row-lines", String(lines));
  }
}

function saveRowHeight(raw) {
  const n = Math.max(0, Math.min(50, parseInt(String(raw || "5"), 10) || 5));
  applyRowHeight(n);
  post({ type: "saveSettings", key: "row_height", value: String(n) });
}

function applyFontSize(raw) {
  const n = Math.max(12, Math.min(16, parseInt(String(raw || "13"), 10) || 13));
  document.body.style.setProperty("--table-font-size", n + "px");
}

function saveFontSize(raw) {
  const n = Math.max(12, Math.min(16, parseInt(String(raw || "13"), 10) || 13));
  applyFontSize(n);
  post({ type: "saveSettings", key: "font_size", value: String(n) });
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

// 封面一批一批到（并发 6），每条都重画一遍直播区 = 一次刷新重画 N 帧。
// 合并到 60ms 后只画一次，里面再按格比对，没变的格不碰 DOM。
// 用 setTimeout 而不是 requestAnimationFrame：webview 所在标签页在后台时 rAF 会被
// 浏览器暂停，那样直播区的封面就一直不更新了；setTimeout 后台只降频、一定会到。
let livePreviewsTimer = null;
function scheduleLivePreviews() {
  if (livePreviewsTimer) {
    return;
  }
  livePreviewsTimer = setTimeout(() => {
    livePreviewsTimer = null;
    renderLivePreviews();
  }, 60);
}

// productsLoaded 原来只换掉 state.products、只重绘详情抽屉，列表 DOM 一直是旧的 ——
// 这是「点刷新没反应」的第三个原因（另两个：后端 aggCache、前端 coverCache 没清）。
// 这里补上列表重绘：300ms 合并连续多次全量推送；光标还在输入框里就等离开输入框再画，不抢焦点。
var productsRerenderTimer = null;
var productsRerenderWaiting = false;
var productsLoadedOnce = false;

function isEditingTextField() {
  const el = document.activeElement;
  if (!el) {
    return false;
  }
  const tag = (el.tagName || "").toLowerCase();
  return (
    tag === "input" || tag === "textarea" || tag === "select"
    || el.isContentEditable === true
  );
}

function applyFreshProducts() {
  // 封面缓存必须连着作废：数据换了、图也可能跟着换了，
  // ensureCovers 见到 coverCache 里有就跳过，不清的话封面停在旧图
  invalidateAllCovers();
  renderProducts();
  if (typeof renderLivePreviews === "function") {
    renderLivePreviews();
  }
}

function scheduleProductsRerender() {
  if (!productsLoadedOnce) {
    // 首次：init() 里已经 renderProducts() 过一次（那时列表还是空的），
    // 这里立刻补画一次，不走 300ms 防抖，免得开面板慢了半拍
    productsLoadedOnce = true;
    applyFreshProducts();
    return;
  }
  if (productsRerenderTimer) {
    return;
  }
  productsRerenderTimer = setTimeout(() => {
    productsRerenderTimer = null;
    if (isEditingTextField()) {
      // 正在打字：这一轮先不画，等 focusout 之后再补一次
      if (!productsRerenderWaiting) {
        productsRerenderWaiting = true;
        document.addEventListener(
          "focusout",
          () => {
            if (productsRerenderWaiting) {
              productsRerenderWaiting = false;
              scheduleProductsRerender();
            }
          },
          { once: true },
        );
      }
      return;
    }
    applyFreshProducts();
  }, 300);
}

/**
 * 焦点是不是停在「有未保存文本」的控件上。
 *
 * ⚠️ **千万别把 `<select>` 算进去**：这个仓库里焦点会一直赖在下拉框上（等级、筛选那一堆），
 * 把 select 算成"正在编辑"，自动刷新就会被**永远**按在等待里 —— 现象是"别人改了数据不刷新，
 * 必须手点 🔄"，人会以为自动刷新根本没做。下拉框没有"没保存的文本"，重读不会丢东西。
 */
function isTypingText() {
  const el = document.activeElement;
  if (!el) {
    return false;
  }
  if (el.isContentEditable === true) {
    return true;
  }
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "textarea") {
    return true;
  }
  if (tag !== "input") {
    return false;
  }
  const type = (el.getAttribute("type") || "text").toLowerCase();
  return ["text", "number", "search", "tel", "url", "password", "email"].indexOf(type) >= 0;
}

function onFocusOutOnce(fn) {
  document.addEventListener("focusout", fn, { once: true });
}

let externalRefreshPending = false;
let externalRefreshWaiting = false;

function runExternalRefresh() {
  if (!externalRefreshPending) {
    return;
  }
  if (isTypingText()) {
    // 正在打字：先不重读（硬刷会把填了一半的表单冲掉），但**要让人知道有事在等** ——
    // 否则用户看到的就是"别人改了没反应"
    if (!externalRefreshWaiting) {
      externalRefreshWaiting = true;
      toast("🔄 有更新：你正在输入，离开输入框后自动刷新");
      onFocusOutOnce(function () {
        externalRefreshWaiting = false;
        runExternalRefresh();
      });
    }
    return;
  }
  externalRefreshPending = false;
  // 封面必须连带重核：ensureCovers 见到 coverCache 里有值就走快路径跳过，不置这个标记的话
  // 别人（网页版 / 另一台电脑）删了图、换了封面，这边列表刷新完**封面还是旧的**。
  // 后端 getCover 会先用「图片夹 mtime」比对一遍，没动过的编号直接回缓存值、不会真去重读
  // 原图，所以这一圈很便宜。
  state.coverRecheck = true;
  state.coverRecheckDone = {};
  toast("🔄 别人改了数据，已自动刷新");
  post({ type: "loadAll" });
  // 详情抽屉（灯箱）里那批图**不在 loadAll 里**：它们是开抽屉时单独 getImages 取回来的。
  // 别人把这个商品的图删光之后，列表自己变了、抽屉里那几张还挂在那儿 ——
  // 看着就像"手机删了图，这边没反应"。开着的抽屉重读一次，只动图片、不碰用户正在填的表单。
  if (state.lbCode) {
    post({ type: "getImages", code: state.lbCode });
  }
}

function onMessage(msg) {
  switch (msg.type) {
    case "externalChanged": {
      // 扩展巡检 data_version 发现「别的连接提交过」（别的电脑的插件 / 网页版服务端）。
      // 自己写不会走到这里：data_version 的语义就是"只有别人提交过才变"。
      externalRefreshPending = true;
      runExternalRefresh();
      break;
    }
    case "productsLoaded": {
      state.products = msg.products || [];
      state.settings.stock_alert = msg.stockAlert || 0;
      // 整库重读之后编号集合可能变了（新建/删除/导入/撤销都走这条路）——
      // 变了就把「每个编号几张图」那份作废重扫；没变（纯手动刷新）不白扫。
      if (typeof invalidateImgStatsIfCodesChanged === "function") {
        invalidateImgStatsIfCodesChanged();
      }
      // ===== 套装（可整体移除）===== 套装的「含 N 件 / 合计进价 / 合计售价」，
      // 后端现算好跟着整库一起下来（见 shopTool/index.ts 的 loadAll）
      state.setSummaries = msg.setSummaries || {};
      populateFilters();
      updateNameTemplatePreview();
      if (typeof renderProductDrawer === "function") {
        renderProductDrawer();
      }
      // ===== 套装（可整体移除）===== 抽屉正开着某个套装时，把它的子商品清单也再要一遍：
      // 刚被别人改过价的子商品，会让我们手里那份"现算的合计"变成旧数 ——
      // 出现"整表都新了、就抽屉里那个合计还是旧的"，比整块都旧更容易骗到人。
      if (typeof refreshDrawerSet === "function") {
        refreshDrawerSet();
      }
      // 整库刷新这条路同样收不到直播区的价格通知（它只跑 renderLivePreviews 刷封面），
      // 不叫一下的话，手动 🔄 之后直播排品里的 ¥售价 还是刷新前的数
      if (typeof refreshLiveMeta === "function") {
        refreshLiveMeta();
      }
      scheduleProductsRerender();
      break;
    }
    case "productsDelta": {
      const removed = new Set(
        Array.isArray(msg.removed) ? msg.removed.map(Number) : [],
      );
      const incoming = Array.isArray(msg.products) ? msg.products : [];
      let changed = false;
      if (removed.size > 0) {
        const kept = state.products.filter((p) => {
          if (removed.has(p.id)) {
            state.selectedProducts.delete(p.id);
            changed = true;
            return false;
          }
          return true;
        });
        if (changed) {
          state.products = kept;
        }
      }
      for (const p of incoming) {
        const idx = state.products.findIndex((x) => x.id === p.id);
        if (idx === -1) {
          state.products.push(p);
          changed = true;
        } else if (JSON.stringify(state.products[idx]) !== JSON.stringify(p)) {
          state.products[idx] = p;
          changed = true;
        }
      }
      if (changed) {
        renderProducts();
        if (typeof renderProductDrawer === "function") {
          renderProductDrawer();
        }
        // 直播排品格里的 ¥售价 是整块重建时画的，改价走增量这条路它收不到通知，
        // 得单独叫一下，否则直播区一直显示改之前的价
        if (typeof refreshLiveMeta === "function") {
          refreshLiveMeta();
        }
      }
      // 增量也会带进新产品（新导入的行是 push 进来的），筛选面板要跟着重建，
      // 否则新分类/新系列在面板里点不出来 —— 以前这条路径只由整库 productsLoaded 兜
      // 图数同理：导入进来的新编号在这份统计里压根没有，集合一变就作废重扫
      if (typeof invalidateImgStatsIfCodesChanged === "function") {
        invalidateImgStatsIfCodesChanged();
      }
      populateFilters();
      break;
    }
    // ===== 套装（可整体移除）=====
    // 打开套装详情抽屉时单独问回来的「子商品清单 + 现算的三个合计」。
    // 加/移出子商品之后后端也回这一条（它是"这个套装现在长什么样"的唯一权威口径），
    // 所以这里除了重画抽屉，还要顺手更新全表那份汇总 ——
    // 列表 / 画册卡片上的「含 N 件 · 合 ¥xx」不给它就不动，界面就开始说谎。
    case "setMembers": {
      state.drawerSet = { code: msg.code, items: msg.items || [] };
      state.setSummaries[msg.code] = {
        count: Number(msg.count || 0),
        sumCost: Number(msg.sumCost || 0),
        sumSale: Number(msg.sumSale || 0),
      };
      renderProducts();
      if (typeof renderProductDrawer === "function") {
        renderProductDrawer();
      }
      break;
    }
    // ===== 套装（可整体移除）=====
    // 这个商品属于哪些套装（打开普通商品的抽屉时问一次）。手机版详情页顶部那一行就是它。
    case "setOfCode": {
      state.drawerSetsOf = msg.sets || [];
      if (typeof renderProductDrawer === "function") {
        renderProductDrawer();
      }
      break;
    }
    case "rulesLoaded": {
      state.rules = msg.rules || [];
      renderRules();
      break;
    }
    case "settingsLoaded":
    // 只改本机偏好时后端只回这一条（不重载整库），走同一套应用逻辑
    case "localPrefsLoaded": {
      state.settings = { ...state.settings, ...(msg.settings || {}) };
      renderSettings();
      applyRowHeight(state.settings.row_height);
      applyFontSize(state.settings.font_size);
      applyGallerySize(state.settings.gallery_size);
      syncGallerySizeUI(state.settings.gallery_size);
      syncGallerySizeVisibility();
      if (typeof updateSalesDeductTip === "function") {
        updateSalesDeductTip();
      }
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
      // 图片列是否显示（独立设置，默认显示；用户可在「字段显示」里关掉）
      showImageList = state.settings.col_image_list !== "0";
      showImageGallery = state.settings.col_image_gallery !== "0";
      showOpsList = state.settings.col_show_ops !== "0";
      renderProducts();
      // localPrefsLoaded 不带 readOnly，只有整份 settingsLoaded 才顺带同步模式
      if (msg.readOnly !== undefined) {
        applyReadOnly(!!msg.readOnly);
      }
      break;
    }
    case "readOnlyChanged": {
      // 后端才是真闸门，这里只负责把界面摆成对的样子
      applyReadOnly(!!msg.readOnly);
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
    case "importPreview": {
      renderImportPreview(msg);
      break;
    }
    case "productsImported": {
      $("pasteHint").textContent = "";
      toast(
        `商品导入完成：新增${msg.created}，更新${msg.updated}${msg.skipped ? `，跳过${msg.skipped}` : ""}`,
      );
      closeImportMask();
      // 有行没进去就得说清楚是哪几行，不然只能去日志面板里翻（提交完预览已经关了）
      const importBad = Array.isArray(msg.bad) ? msg.bad : [];
      const importDups = Array.isArray(msg.duplicateLines) ? msg.duplicateLines : [];
      if (importBad.length || importDups.length) {
        showImportIssues(importBad, importDups);
      }
      break;
    }
    case "undoState": {
      applyUndoState(msg.undoAvailable, msg.redoAvailable);
      // 撤销/重做做了整库恢复：若销售页看的是别的日期，重载当前日期
      if (msg.restored && state.salesDate) {
        post({ type: "loadSales", date: state.salesDate || nowStr() });
      }
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
    case "salesExportPreviewLoaded": {
      renderSalesExportPreview(msg);
      break;
    }
    case "monthBuilt": {
      renderSettlePanel(msg);
      break;
    }
    case "coverLoaded": {
      // 作废缓存之前就发出去的请求，回来的是旧图：只销掉在途计数，不写缓存，
      // 否则这一行会被旧封面钉住，直到下一次改图或手动刷新才变
      if (typeof msg.gen === "number" && msg.gen !== coverGen) {
        delete state.coverPending[msg.code];
        coverInFlight = Math.max(0, coverInFlight - 1);
        pumpCovers();
        break;
      }
      const data = msg.data || "";
      const prev = state.coverCache[msg.code];
      state.coverCache[msg.code] = data;
      delete state.coverPending[msg.code];
      if (state.coverRecheck) {
        // 这一条本轮已校核完：ensureCovers 别再重发，跑完一圈自动收旗
        state.coverRecheckDone[msg.code] = true;
      }
      coverInFlight = Math.max(0, coverInFlight - 1);
      pumpCovers();
      // 增量校核：返回的图和内存一致 = 这段夹子没人动过 → 不用重画（省掉整页重嵌）
      if (prev !== data) {
        if (!patchCoverRow(msg.code, data)) {
          requestCoverRender();
        }
      }
      scheduleLivePreviews();
      // 一轮校核跑完（没有在途、队列也空了）就收掉标记，之后渲染走缓存快路径
      if (
        state.coverRecheck &&
        coverInFlight === 0 &&
        coverQueue.length === 0 &&
        Object.keys(state.coverPending).length === 0
      ) {
        state.coverRecheck = false;
      }
      break;
    }
    case "coverInvalidated": {
      delete state.coverCache[msg.code];
      delete state.coverPending[msg.code];
      // 这一轮的「已校核」标记也要清掉：ensureCovers 在重核状态下见到 done 就跳过，
      // 留着会让下面的重取请求被吞掉，图片行就一直停在「无图」
      if (state.coverRecheckDone) {
        delete state.coverRecheckDone[msg.code];
      }
      if (!patchCoverRow(msg.code, "")) {
        requestCoverRender();
      }
      // 详情抽屉正开着这个商品的话，抽屉里的封面也得跟着变空 —— 否则图片操作不再整库
      // 重推（列表已由 patchCoverRow 更新），抽屉会停在一张已被删掉的旧图上
      refreshDrawerCover(msg.code);
      // 图片操作不再整库重推之后，这条通知就是「该编号封面已变」的唯一入口，必须在这里
      // 主动重取一次：只把格子刷成无图的话，上传/拖入的新图不会再自己回来，得手动刷新。
      // 后台缓存已随 invalidateCover 丢掉，这里取回的是磁盘现状 —— 上传得新图、删除得空，
      // 上传和删除共用这一条自愈路径。
      ensureCovers([{ code: msg.code }]);
      scheduleLivePreviews();
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
    case "liveGridStatus": {
      onLiveGridStatus(msg);
      break;
    }
    case "starOverviewPreview": {
      showStarOverviewPreview(msg);
      break;
    }
    case "starOverviewPagePreview": {
      starOvOnPagePreview(msg);
      break;
    }
    case "starOverviewProgress": {
      starOvOnProgress(msg);
      break;
    }
    case "starOverviewDone": {
      onStarOverviewDone(msg);
      break;
    }
    case "starOverviewCancelled": {
      onStarOverviewCancelled();
      break;
    }
    case "exportDone": {
      endExport();
      const kind = String(msg.kind || "");
      if (kind === "products") {
        closeModal();
      }
      const count = Number(msg.count || 0);
      const path = String(msg.path || "");
      const labels = {
        products: "商品",
        sales: "销售流水",
        settles: "月度结算",
        live: "排品清单",
      };
      const units = {
        products: "条",
        sales: "条",
        settles: "个月",
        live: "款",
      };
      const scope =
        kind === "products"
          ? msg.filtered
            ? `筛选结果 ${count}`
            : `全部 ${count}`
          : String(count);
      const text = `✅ 已导出${labels[kind] || "内容"} ${scope} ${units[kind] || "条"}：${path}`;
      window.showGlobalToast(text, [
        {
          label: "📂 查看文件",
          handler: () => post({ type: "revealFile", path }),
        },
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
    case "alert": {
      showModal(
        `<h3>⚠️${esc(msg.title || "提示")}</h3>` +
          `<p style="white-space:pre-wrap">${esc(String(msg.text ?? ""))}</p>` +
          `<div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn-teal" id="alertOk">知道了</button></div>`,
      );
      const ok = document.getElementById("alertOk");
      if (ok) {
        ok.onclick = closeModal;
      }
      break;
    }
    case "dbOpError": {
      endExport();
      resetImportBtns();
      toast(`❌${String(msg.message ?? "操作失败")}`);
      break;
    }
    // 后端扫完目录回来的「每个编号有几张图」—— 只服务筛选面板里「图片」那一组（有图/无图）。
    case "imageStatsLoaded": {
      state.imgStats = msg.stats || {};
      state.imgStatsLoaded = true;
      state.imgStatsBusy = false; // 请求在路上的标记顺手清掉（post 是单向的，没 promise 可挂）
      // 异步的东西回来了：这一刻筛选抽屉可能正开着（那组要从「正在统计…」变成「有图 N / 无图 M」），
      // 「图片」也可能正筛着（统计到之前那一列是整列跳过的，现在才真正生效）—— 两边都重画。
      if (typeof renderFilterDrawerIfOpen === "function") {
        renderFilterDrawerIfOpen();
      }
      renderProducts();
      break;
    }
    case "imagesLoaded": {
      // 本机刚传 / 删过图，这一格的张数直接按回包的张数改 —— 不必为一张图重扫整个库。
      // 只在已经统计过时改：没统计过就没有这份缓存，别半路塞几个编号进去（会变成半个真相）。
      if (state.imgStatsLoaded) {
        const n = Array.isArray(msg.images) ? msg.images.length : 0;
        // 只在张数真的变了才动界面（打开大图也会回这条，那时数目没变，不该白重画一遍）
        if (state.imgStats[msg.code] !== n) {
          state.imgStats[msg.code] = n;
          // 正筛着「图片」时，这一件的归类可能刚翻了个面（无图 → 有图）——
          // 列表得跟着重算，否则界面在说谎：条件还写着「无图」，它还赖在表里。
          if (filters.f_img) {
            renderProducts();
          }
          if (typeof renderFilterDrawerIfOpen === "function") {
            renderFilterDrawerIfOpen();
          }
        }
      }
      if (msg.images && msg.images.length) {
        state.coverCache[msg.code] = msg.images[0];
      }
      if (state.lbCode !== msg.code) {
        break;
      }
      // 标记「图册清单已到」：黑区右键要靠它区分「还在加载」和「真没有」
      state.lbImagesLoaded = true;
      const thumbs = document.getElementById("lbThumbs");
      const big = document.getElementById("lbBig");
      if (!thumbs || !big) {
        break;
      }
      if (!msg.images.length) {
        state.lbNames = [];
        thumbs.innerHTML = `<span class="muted" style="color:#bbb">（无图片：把图放到「图片根目录/${esc(msg.code)}」文件夹，或点「🖼 上传图片」）</span>`;
        big.style.display = "none";
        return;
      }
      // 文件名才是每张图的身份（与 images 同序）。后端没带 names 时退回序号拼一个，
      // 让老数据也能走通——键错中的后果是显示错图，所以这里只是兜底，正常路径都有名字
      state.lbNames = msg.names || msg.images.map((_, i) => String(i));
      const hadIdx = state.lbIdx || 0;
      const idx = Math.min(hadIdx, msg.images.length - 1);
      state.lbIdx = idx;
      big.style.display = "inline-block";
      // 键用文件名而不是序号：删掉第 1 张后第 2 张顶到序号 0，用序号做键的话这里会命中
      // 「刚被删掉那张」的 base64 —— 大图停在已删除的图上，而缩略图条是重建的、排版看着对的。
      // 键不中的代价只是重新取一次原图，键错中的代价是显示错图，所以宁可多取。
      const key = `${msg.code}:${state.lbNames[idx]}`;
      // lbFullCache 只存 base64（来自兜底/复制通道）；显示优先走 URI，不必也不该缓存
      const cached = state.lbFullCache[key];
      if (cached) {
        big.onerror = null;
        big.src = cached;
      } else if (idx === 0 && msg.big0Uri) {
        setLightboxBig(big, msg.code, state.lbNames[0], msg.big0Uri);
      } else {
        post({ type: "getFullImage", code: msg.code, index: idx, name: state.lbNames[idx] });
      }
      thumbs.innerHTML = msg.images
        .map(
          (u, i) =>
            `<img src="${u}" class="${i === idx ? "active" : ""}" data-i="${i}" />`,
        )
        .join("");
      thumbs.querySelectorAll("img").forEach((img) => {
        img.onclick = () => {
          const idx = Number(img.dataset.i);
          const name = state.lbNames[idx];
          state.lbIdx = idx;
          const key = `${msg.code}:${name}`;
          resetLbZoom();
          thumbs
            .querySelectorAll("img")
            .forEach((x) => x.classList.remove("active"));
          img.classList.add("active");
          const cached = state.lbFullCache[key];
          if (cached) {
            big.onerror = null;
            big.src = cached;
          } else {
            post({ type: "getFullImage", code: msg.code, index: idx, name });
          }
        };
        img.oncontextmenu = (e) => {
          e.preventDefault();
          // 右键哪张就该操作哪张，先把 lbIdx 拨过去再开菜单
          state.lbIdx = Number(img.dataset.i);
          openCurrentLightboxMenu(e);
        };
      });
      // 用 oncontextmenu 赋值而不是 addEventListener：同一张 big 元素会被反复赋值，
      // addEventListener 会越堆越多，且旧闭包里的 code 会导致右键删错商品
      big.oncontextmenu = (e) => {
        e.preventDefault();
        openCurrentLightboxMenu(e);
      };
      break;
    }
    case "fullImageLoaded": {
      if (state.lbCode !== msg.code) {
        break;
      }
      const big = document.getElementById("lbBig");
      if (!big) {
        break;
      }
      // base64 通道：兜底显示 + 右键复制的实际来源，存进 lbFullCache 供本次会话复用
      if (msg.data) {
        // 键用文件名（后端回带的 name），不是序号
        const key = `${msg.code}:${msg.name || msg.index}`;
        state.lbFullCache[key] = msg.data;
        if (state.lbIdx === msg.index) {
          big.onerror = null;
          big.src = msg.data;
        }
        // 图到位了就把还开着的菜单里那一项点亮，**这里一个字都不往剪贴板写**。
        // 以前这里是「pending 就直接复制」：右键弹菜单的同一个 tick 里就置了
        // lbPendingCopy，所以光右键就把图塞进剪贴板了。
        if (state.lbCopyKey === key) {
          enableLbCopyItem();
        }
        break;
      }
      // URI 通道：默认显示路径；加载失败由 setLightboxBig 的 onerror 回退
      if (msg.uri && state.lbIdx === msg.index) {
        setLightboxBig(big, msg.code, msg.name, msg.uri);
      }
      break;
    }
  }
}

function coverRowEl(code) {
  if (viewMode !== "list") {
    return null;
  }
  const p = state.products.find((x) => x.code === code);
  if (!p) {
    return null;
  }
  return document.querySelector(`#productListView tr[data-id="${p.id}"]`);
}

// 封面到达/失效时只替换对应行的图片节点，避免每次重绘整张商品表
function patchCoverRow(code, data) {
  const tr = coverRowEl(code);
  if (!tr) {
    return false;
  }
  const old = tr.querySelector('[data-p-act="img"]');
  if (!old) {
    return false;
  }
  const node = document.createElement(data ? "img" : "span");
  node.className = data ? "thumb" : "thumb placeholder";
  node.setAttribute("data-p-act", "img");
  node.setAttribute("data-id", String(old.dataset.id ?? ""));
  if (data) {
    node.src = data;
  } else {
    node.textContent = "无图";
  }
  old.replaceWith(node);
  return true;
}

// 大图显示：优先用后端给的 webview 资源 URI（0 拷贝、100% 原图）。
// 加载不出来时（图片目录不在面板的 localResourceRoots 白名单里，或 UNC 路径加载不出）
// onerror 自动回退请求 base64 通道；重设 src 前先摘掉 handler，否则兜底再失败会无限打转。
function setLightboxBig(big, code, name, uri) {
  if (!uri) {
    big.onerror = null;
    big.src = "";
    return;
  }
  big.onerror = () => {
    big.onerror = null;
    post({ type: "getFullImage", code, name, base64: true });
  };
  big.src = uri;
}

function openLightboxMenu(e, code, idx) {
  // 这张图叫什么：后端下发的文件名才是身份，序号只是「当前选中第几张」
  const name = state.lbNames[idx] ?? String(idx);
  const key = `${code}:${name}`;
  // 复制只能吃 data URL。base64 不在 cache 里就置灰——**不** arm 什么「载入后自动复制」：
  // 用户只是弹了个菜单，凭什么往剪贴板塞东西。
  const copyItem = {
    // id：让 enableLbCopyItem 能认回这一项。菜单项现在是有条件构造的，
    // 「排在 data-ic=0」不再等价于「就是复制那项」。
    id: "lbCopyImg",
    label: "📋 复制图片",
    disabled: true,
    title: "原图载入中，请稍候再试",
    run: () => {
      // 点击那一刻再查一次：置灰时点不到，但 万一 状态在按下和抬起之间变了 呢
      const d = state.lbFullCache[key] || "";
      if (!d) {
        toast("原图还在载入，请稍后再试");
        return;
      }
      copyImageFromDataUrl(d).then((ok) =>
        ok ? toast("已复制图片") : toast("复制失败"),
      );
    },
  };
  const items = [
    copyItem,
    {
      label: "🗑️ 删除图片",
      danger: true,
      run: () => {
        confirmBox(`确认删除 ${code} 的第 ${idx + 1} 张图片？（文件会被真的删除）`).then(
          (ok) => {
            if (!ok) {
              return;
            }
            // 必须先关图库抽屉再删：抽屉里 #lbBig 是用 webview 资源 URI 直接读原图的
            // （放大走 0 拷贝那条路），Chromium 会一直攥着文件句柄不放，
            // SMB 上 unlink 立刻 EBUSY。而右键菜单只能从抽屉里的缩略图弹出，
            // 也就是说「打开图库 → 右键删图」这条最自然的路径 100% 撞这个错。
            // 关掉抽屉同时也是对的：删完 reloadImages 推回的 imagesLoaded 会被
            // client-main.js 里 `if (!thumbs || !big) break;` 安全挡掉，不用额外适配。
            closeLightbox();
            // 摘掉 DOM 不等于句柄立刻释放，给浏览器一帧
            requestAnimationFrame(() => {
              // 按名字删而不是按序号：关抽屉到请求发出之间，夹子里的文件可能被别人动过，
              // 序号已经指到别的文件上，那样会删掉用户没点的那张
              post({ type: "deleteImageFile", code, index: idx, name });
            });
          },
        );
      },
    },
    {
      label: "📂 打开图片文件夹",
      run: () => post({ type: "openImageFile", code }),
    },
  ];
  // 记住是哪张图的菜单：图载入完只有对得上这张才去点亮那一项
  state.lbCopyItem = copyItem;
  state.lbCopyKey = key;
  showImageCtxMenu(e.clientX, e.clientY, items);
  if (state.lbFullCache[key]) {
    enableLbCopyItem();
  } else {
    // 预热 cache（**不复制**）。少了这一步首次右键必然是灰的，
    // 用户只能关掉菜单再右键一次，很别扭。
    post({ type: "getFullImage", code, index: idx, name, base64: true });
  }
}

// 把还开着的菜单里那一项从灰点亮。菜单已关时查不到节点，直接空转。
function enableLbCopyItem() {
  const el = document.querySelector('#imgCtxMenu [data-ic-id="lbCopyImg"]');
  const it = state.lbCopyItem;
  // 归属校验挡住一种错配：预热请求在途 → 别人把最后一张删了、清单变空 → 用户右键弹出
  // 只有「打开图片文件夹」的菜单 → 预热回复这时才到。原来按 [data-ic="0"] 选会挑中那一项，
  // 把它的文案改写成「复制图片」，而它的 run 仍然打开文件夹
  if (!el || !it || it.id !== "lbCopyImg") {
    return;
  }
  it.disabled = false;
  el.classList.remove("ctx-disabled");
  el.removeAttribute("title");
  el.textContent = it.label;
}

// 黑区（图片以外的空白）右键：以前只有图片和缩略图拦了 contextmenu，
// 黑区漏到 VS Code 宿主菜单去了。这里跟图片右键走同一套菜单。
function openCurrentLightboxMenu(e) {
  if (!state.lbCode) {
    return;
  }
  const thumbs = document.getElementById("lbThumbs");
  if (!thumbs) {
    return;
  }
  // 捕获成局部：菜单点下去之前灯箱可能已经关了或换了商品，
  // 到那时再读 state.lbCode 就会打开别人的图片夹
  const code = state.lbCode;
  if (!thumbs.querySelector("img")) {
    if (!state.lbImagesLoaded) {
      // 灯箱刚开时 thumbs 里是「图片加载中…」，这时候报「该商品还没有图片」是骗人
      toast("图片加载中…");
      return;
    }
    // 清单到了且一张都没有：复制和删除都没有对象可作用，不放这两项。
    // 「打开图片文件夹」照旧给——空状态下这是唯一还能往下走的一步：文件夹可能存在
    // （只是空的），也可能还没建（后端对后者会 reveal 图片根目录）
    showImageCtxMenu(e.clientX, e.clientY, [
      { label: "📂 打开图片文件夹", run: () => post({ type: "openImageFile", code }) },
    ]);
    return;
  }
  openLightboxMenu(e, code, state.lbIdx || 0);
}

window.toolClients.shopTool = {
  init,
  onMessage,
  _state: state,
  _isReady: true,
};
