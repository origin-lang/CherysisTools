// 手机版商品页面：只做四件事 —— 看商品（画册/列表）、看某个商品的图、新建商品、改几个常用字段。
// 与电脑版的区别只在**交互**：不做双击编辑（手机上点一下就该进编辑）、不做右键菜单（改成长按/按钮）、
// 不做拖放（改成相机/相册）。数据与规则全部复用后端那套 handler，页面里不重写任何业务口径。
(function () {
  "use strict";

  var TOKEN_KEY = "cherysis_token";
  var state = {
    products: [],
    rules: [],
    alert: 0,
    view: "gallery",
    q: "",
    detail: null, // { id, code, orig: {...}, status: 0 }
    logs: [],
  };

  var $ = function (id) {
    return document.getElementById(id);
  };
  var esc = function (s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };
  var num = function (v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  var money = function (v) {
    return "¥" + (Math.round(num(v) * 100) / 100).toLocaleString("zh-CN");
  };

  // ---------- 与后端的通道 ----------
  var token = (function () {
    var m = /[?&]token=([^&]+)/.exec(location.search);
    if (m) {
      try {
        localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
      } catch (e) {
        /* 隐私模式下写不了，忽略 */
      }
      return decodeURIComponent(m[1]);
    }
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  })();

  /** 一条消息 = 一次 POST；回包里的 posts 按序喂给 handlePost，logs 进底部状态条 */
  function invoke(type, payload) {
    var msg = Object.assign({ type: type }, payload || {});
    return fetch("/api/invoke", {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { "x-cherysis-token": token } : {},
      ),
      body: JSON.stringify(msg),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) {
            throw new Error(j && j.error ? j.error : "HTTP " + r.status);
          }
          return j;
        });
      })
      .then(function (j) {
        (j.posts || []).forEach(handlePost);
        (j.logs || []).forEach(pushLog);
        if (j.error) {
          pushLog("❌" + j.error);
        }
        return j;
      })
      .catch(function (err) {
        pushLog("❌连不上服务：" + (err && err.message ? err.message : err));
        throw err;
      });
  }

  function imgUrl(code, name, size) {
    var u = "/api/image?code=" + encodeURIComponent(code) + "&size=" + (size || "thumb");
    if (name) {
      u += "&name=" + encodeURIComponent(name);
    }
    if (token) {
      u += "&token=" + encodeURIComponent(token);
    }
    return u;
  }

  // ---------- 收到的消息 ----------
  function handlePost(m) {
    if (!m || !m.type) {
      return;
    }
    if (m.type === "productsLoaded") {
      state.products = m.products || [];
      state.alert = num(m.stockAlert);
      renderList();
      fillCategoryList();
    } else if (m.type === "rulesLoaded") {
      state.rules = m.rules || [];
      fillGradeSelect();
      updateRuleHint();
    } else if (m.type === "toast") {
      pushLog(m.text);
    } else if (m.type === "dbOpError") {
      pushLog("❌" + m.message);
    }
  }

  function pushLog(text) {
    var t = String(text === undefined || text === null ? "" : text);
    // 带换行的多行日志按行拆开，底部条只显示最后一行
    t.split(/\r?\n/).forEach(function (line) {
      if (line.trim()) {
        state.logs.push(line);
      }
    });
    if (state.logs.length > 300) {
      state.logs.splice(0, state.logs.length - 300);
    }
    var last = state.logs[state.logs.length - 1] || "";
    $("statusText").textContent = last;
    $("statusText").className = /^[❌⚠]/.test(last) ? "low" : "muted";
    var panel = $("logPanel");
    if (panel.classList.contains("show")) {
      renderLogs();
    }
  }

  function renderLogs() {
    $("logList").innerHTML = state.logs
      .slice(-200)
      .map(function (l) {
        return '<div class="line">' + esc(l) + "</div>";
      })
      .join("");
  }

  // ---------- 列表 / 画册 ----------
  function filtered() {
    var q = state.q.trim().toLowerCase();
    if (!q) {
      return state.products;
    }
    return state.products.filter(function (p) {
      return (
        String(p.code || "").toLowerCase().indexOf(q) >= 0 ||
        String(p.name || "").toLowerCase().indexOf(q) >= 0 ||
        String(p.category || "").toLowerCase().indexOf(q) >= 0 ||
        String(p.series || "").toLowerCase().indexOf(q) >= 0
      );
    });
  }

  function isLow(p) {
    return state.alert > 0 && p.status !== 1 && num(p.stockTotal) <= state.alert;
  }

  function renderList() {
    var list = filtered();
    $("count").textContent = list.length + " / " + state.products.length;
    if (!list.length) {
      $("content").innerHTML = '<p class="muted">（没有匹配的商品）</p>';
      return;
    }
    if (state.view === "gallery") {
      $("content").innerHTML =
        '<div class="grid">' +
        list
          .map(function (p) {
            var off = p.status === 1;
            return (
              '<div class="card' +
              (off ? " off" : "") +
              '" data-id="' +
              p.id +
              '">' +
              '<img class="thumb" loading="lazy" src="' +
              imgUrl(p.code, "", "thumb") +
              '" alt="" onerror="this.outerHTML=\'<div class=&quot;ph&quot;>暂无图片</div>\'" />' +
              '<div class="body">' +
              '<div><span class="code">' +
              esc(p.code) +
              "</span>" +
              (off ? '<span class="badge">已下架</span>' : "") +
              "</div>" +
              "<div>" +
              esc(p.name) +
              "</div>" +
              "<div>" +
              money(p.sale_price) +
              ' · <span class="' +
              (isLow(p) ? "low" : "") +
              '">库存 ' +
              num(p.stockTotal) +
              "</span></div>" +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else {
      $("content").innerHTML =
        '<div class="rows">' +
        list
          .map(function (p) {
            var off = p.status === 1;
            return (
              '<div class="row" data-id="' +
              p.id +
              '">' +
              '<span class="c">' +
              esc(p.code) +
              "</span>" +
              '<span class="n">' +
              esc(p.name) +
              (off ? ' <span class="badge">下架</span>' : "") +
              "</span>" +
              '<span class="p">' +
              money(p.sale_price) +
              "</span>" +
              '<span class="s' +
              (isLow(p) ? " low" : "") +
              '">库 ' +
              num(p.stockTotal) +
              "</span>" +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }
  }

  function fillCategoryList() {
    var seen = {};
    state.products.forEach(function (p) {
      if (p.category) {
        seen[p.category] = 1;
      }
    });
    $("catList").innerHTML = Object.keys(seen)
      .sort()
      .map(function (c) {
        return "<option value=\"" + esc(c) + '"></option>';
      })
      .join("");
  }

  function fillGradeSelect() {
    var sel = $("nGrade");
    var opts = state.rules
      .map(function (r) {
        return (
          '<option value="' +
          r.grade +
          '">' +
          esc((r.label ? r.label + "（等级 " + r.grade + "）" : "等级 " + r.grade) + "：" + r.expr) +
          "</option>"
        );
      })
      .join("");
    sel.innerHTML = opts + '<option value="0">自定义（售价手动定）</option>';
    updateRuleHint();
  }

  function updateRuleHint() {
    var g = num($("nGrade").value);
    var r = null;
    for (var i = 0; i < state.rules.length; i++) {
      if (num(state.rules[i].grade) === g) {
        r = state.rules[i];
      }
    }
    $("ruleHint").textContent = r
      ? "售价会按等级 " + g + " 的规则自动算：" + r.expr + "（cost = 进价）。填了售价就按你填的算。"
      : "这个等级没有规则，也不会自动算售价：请在「售价」里手填（或去电脑版加一条等级规则）。";
  }

  // ---------- 详情 ----------
  function openDetail(id) {
    var p = null;
    for (var i = 0; i < state.products.length; i++) {
      if (num(state.products[i].id) === num(id)) {
        p = state.products[i];
      }
    }
    if (!p) {
      return;
    }
    state.detail = {
      id: p.id,
      code: p.code,
      status: p.status === 1 ? 1 : 0,
      orig: {
        name: p.name || "",
        cost_price: num(p.cost_price),
        sale_price: num(p.sale_price),
        stockTotal: num(p.stockTotal),
        category: p.category || "",
        series: p.series || "",
      },
    };
    $("dTitle").textContent = p.code + " " + (p.name || "");
    $("fName").value = p.name || "";
    $("fCost").value = num(p.cost_price);
    $("fSale").value = num(p.sale_price);
    $("fStock").value = num(p.stockTotal);
    $("fCategory").value = p.category || "";
    $("fSeries").value = p.series || "";
    syncStatusBtn();
    $("dCover").innerHTML = '<img src="' + imgUrl(p.code, "", "full") + '" alt="" />';
    show("screen-detail");
    loadImages(p.code);
  }

  function syncStatusBtn() {
    var off = state.detail && state.detail.status === 1;
    var b = $("fStatus");
    b.textContent = off ? "已下架（点一下上架）" : "在售（点一下下架）";
    b.className = "toggle" + (off ? " off" : "");
  }

  function loadImages(code) {
    var box = $("dImages");
    box.innerHTML = '<span class="muted small">图片读取中…</span>';
    fetch("/api/images?code=" + encodeURIComponent(code) + (token ? "&token=" + encodeURIComponent(token) : ""))
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var names = (j && j.names) || [];
        if (!names.length) {
          box.innerHTML = '<span class="muted small">这个商品还没有图片，点右上「📷 传图」拍一张。</span>';
          return;
        }
        box.innerHTML = names
          .map(function (n) {
            return '<img src="' + imgUrl(code, n, "thumb") + '" data-name="' + esc(n) + '" alt="" />';
          })
          .join("");
      })
      .catch(function () {
        box.innerHTML = '<span class="muted small">图片清单读不到</span>';
      });
  }

  function openViewer(code, name) {
    $("viewerImg").src = imgUrl(code, name, "full");
    $("viewer").classList.add("show");
  }

  function saveDetail() {
    var d = state.detail;
    if (!d) {
      return Promise.resolve();
    }
    var jobs = [];
    var name = $("fName").value.trim();
    var category = $("fCategory").value.trim();
    var series = $("fSeries").value.trim();
    var cost = num($("fCost").value);
    var sale = num($("fSale").value);
    var stock = num($("fStock").value);
    if (name !== d.orig.name) {
      jobs.push(["updateProductField", { id: d.id, field: "name", value: name }]);
    }
    if (category !== d.orig.category) {
      jobs.push(["updateProductField", { id: d.id, field: "category", value: category }]);
    }
    if (series !== d.orig.series) {
      jobs.push(["updateProductField", { id: d.id, field: "series", value: series }]);
    }
    if (cost !== d.orig.cost_price) {
      jobs.push(["updateProductField", { id: d.id, field: "cost_price", value: cost }]);
    }
    if (sale !== d.orig.sale_price) {
      jobs.push(["updateProductField", { id: d.id, field: "sale_price", value: sale }]);
    }
    if (stock !== d.orig.stockTotal) {
      jobs.push(["setStockQty", { id: d.id, qty: stock }]);
    }
    var statusNow = num(
      (function () {
        for (var i = 0; i < state.products.length; i++) {
          if (num(state.products[i].id) === num(d.id)) {
            return state.products[i].status;
          }
        }
        return 0;
      })(),
    );
    if (statusNow !== d.status) {
      jobs.push(["setStatus", { id: d.id, status: d.status }]);
    }
    if (!jobs.length) {
      pushLog("ℹ️没有改动");
      return Promise.resolve();
    }
    // 一条一条发：每条都是独立的业务动作，改动点很少，串行更好排查
    return jobs.reduce(function (chain, job) {
      return chain.then(function () {
        return invoke(job[0], job[1]);
      });
    }, Promise.resolve()).then(function () {
      return invoke("loadAll");
    });
  }

  // ---------- 新建 ----------
  function nextFreeCode() {
    var raw = String($("nCode").value || "").trim().toUpperCase();
    var m = /^([A-Z])(\d{1,4})$/.exec(raw);
    var prefix = m ? m[1] : "L";
    var used = {};
    state.products.forEach(function (p) {
      used[String(p.code || "").toUpperCase()] = 1;
    });
    for (var n = 1; n <= 9999; n++) {
      var code = prefix + String(n).padStart(3, "0");
      if (!used[code]) {
        $("nCode").value = code;
        return;
      }
    }
    pushLog("❌这个前缀的编号用满了");
  }

  function createProduct() {
    var payload = {
      code: $("nCode").value.trim(),
      name: $("nName").value.trim(),
      category: $("nCategory").value.trim(),
      series: $("nSeries").value.trim(),
      grade: num($("nGrade").value),
      costPrice: num($("nCost").value),
      salePrice: $("nSale").value.trim() === "" ? 0 : num($("nSale").value),
      initialStock: num($("nStock").value),
      purchaseLink: "",
      remark: "",
    };
    return invoke("addProduct", payload).then(function (j) {
      // 成功的判据：handler 会 post 一条 toast「✅已新建 …」，失败只写日志
      var ok = (j.posts || []).some(function (m) {
        return m && m.type === "toast" && String(m.text || "").indexOf("已新建") >= 0;
      });
      if (ok) {
        $("nCode").value = "";
        $("nName").value = "";
        $("nCost").value = "";
        $("nSale").value = "";
        $("nStock").value = "0";
        show("screen-list");
      }
    });
  }

  // ---------- 上传（手机拍照 / 相册） ----------
  function uploadFiles(files) {
    var d = state.detail;
    if (!d || !files || !files.length) {
      return;
    }
    var items = [];
    var reads = Array.prototype.map.call(files, function (f) {
      return new Promise(function (resolve) {
        var fr = new FileReader();
        fr.onload = function () {
          items.push({ name: f.name || "photo.jpg", data: String(fr.result || "") });
          resolve();
        };
        fr.onerror = function () {
          resolve();
        };
        fr.readAsDataURL(f);
      });
    });
    Promise.all(reads).then(function () {
      if (!items.length) {
        pushLog("⚠️没读到图片数据");
        return;
      }
      pushLog("⏳上传 " + items.length + " 张…");
      invoke("receiveImageData", { code: d.code, items: items }).then(function () {
        // 传完图片可能换了封面：把详情和大图缓存都作废再读一次
        $("dCover").innerHTML = '<img src="' + imgUrl(d.code, "", "full") + "&t=" + Date.now() + '" alt="" />';
        loadImages(d.code);
        return invoke("loadAll");
      });
    });
  }

  // ---------- 屏幕切换 ----------
  function show(id) {
    ["screen-list", "screen-detail", "screen-new"].forEach(function (s) {
      $(s).classList.toggle("show", s === id);
    });
    if (id === "screen-list") {
      state.detail = null;
    }
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $("viewGallery").onclick = function () {
      state.view = "gallery";
      $("viewGallery").classList.add("on");
      $("viewList").classList.remove("on");
      renderList();
    };
    $("viewList").onclick = function () {
      state.view = "list";
      $("viewList").classList.add("on");
      $("viewGallery").classList.remove("on");
      renderList();
    };
    $("btnReload").onclick = function () {
      pushLog("⏳重新读取…");
      invoke("loadAll");
    };
    $("q").oninput = function () {
      state.q = $("q").value;
      renderList();
    };
    $("content").onclick = function (e) {
      var el = e.target.closest("[data-id]");
      if (el) {
        openDetail(num(el.dataset.id));
      }
    };
    $("btnBack").onclick = function () {
      show("screen-list");
    };
    $("btnNew").onclick = function () {
      if (!$("nGrade").options.length) {
        fillGradeSelect();
      }
      show("screen-new");
    };
    $("btnNewBack").onclick = function () {
      show("screen-list");
    };
    $("btnCreate").onclick = function () {
      createProduct().catch(function () {
        /* 日志里已经有原因 */
      });
    };
    $("btnNextCode").onclick = nextFreeCode;
    $("nGrade").onchange = updateRuleHint;
    $("btnSave").onclick = function () {
      saveDetail().catch(function () {
        /* 日志里已经有原因 */
      });
    };
    $("fStatus").onclick = function () {
      if (state.detail) {
        state.detail.status = state.detail.status === 1 ? 0 : 1;
        syncStatusBtn();
      }
    };
    $("dImages").onclick = function (e) {
      var img = e.target.closest("img[data-name]");
      if (img && state.detail) {
        openViewer(state.detail.code, img.dataset.name);
      }
    };
    $("dCover").onclick = function () {
      if (state.detail) {
        openViewer(state.detail.code, "");
      }
    };
    $("viewerClose").onclick = function () {
      $("viewer").classList.remove("show");
      $("viewerImg").src = "";
    };
    $("btnUpload").onclick = function () {
      $("filePick").click();
    };
    $("filePick").onchange = function () {
      uploadFiles($("filePick").files);
      $("filePick").value = ""; // 同一个文件连传两次也要能触发 change
    };
    $("status").onclick = function () {
      renderLogs();
      $("logPanel").classList.add("show");
    };
    $("logClose").onclick = function () {
      $("logPanel").classList.remove("show");
    };
  }

  bind();
  pushLog("⏳读取商品…");
  invoke("loadAll").catch(function () {
    $("content").innerHTML =
      '<p class="muted">读不到商品。检查：服务是否在跑、地址里的 token 对不对、服务端有没有配 --image-dir。</p>';
  });
})();
