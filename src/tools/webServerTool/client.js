/**
 * 「网页版服务」面板的前端。
 *
 * 状态不靠后端推，靠**前端每 5 秒问一次**：起/停/自启都可能从别处发生（双击 cmd、
 * 计划任务、另一个 VS Code 窗口），只有轮询能保证这一屏永远是真的，
 * 问一次的成本是一次本机 TCP 连接（连不上 = 没跑，亚毫秒级）。
 */
(function () {
  const TOOL = "webServer";
  const $ = (id) => document.getElementById(id);

  function post(msg) {
    vscode.postMessage(Object.assign({ toolName: TOOL }, msg));
  }

  var state = { running: false, autostart: false, url: "" };

  function renderStatus(s) {
    state.running = !!s.running;
    state.autostart = !!s.autostart;
    state.url = s.url || "";
    const card = $("wsCard");
    card.classList.toggle("on", state.running);
    card.classList.toggle("off", !state.running);
    $("wsState").textContent = state.running ? "服务已启动" : "服务未启动";
    const btn = $("wsMainBtn");
    btn.textContent = state.running ? "⏹ 停止网页版服务" : "▶ 启动网页版服务";
    btn.title = state.running ? "停掉监听这个端口的服务进程" : "在 VS Code 里开一个终端跑服务";
    $("wsUrlRow").style.display = state.running ? "" : "none";
    $("wsUrl").textContent = state.url;
    $("wsAutoState").textContent = state.autostart ? "已设置（登录时自动起）" : "未设置";
    $("wsAutoBtn").textContent = state.autostart ? "取消开机自启" : "设为开机自启";
    $("wsCfgPath").textContent = s.configPath ? "配置文件：" + s.configPath : "";
    if (s.configError) {
      $("wsCfgPath").textContent = "⚠️ 配置文件不是合法 JSON：" + s.configError;
    }
    // 没配置文件时给个"按 VS Code 设置生成"的出口（点「生成」会写盘，别让它悄悄发生）
    const noCfgRow = $("wsNoCfgRow");
    noCfgRow.style.display = s.configOk ? "none" : "";
    $("wsNoCfgText").textContent = s.configError
      ? "配置文件不是合法 JSON"
      : "网页版的配置文件还不存在";
    $("wsGenBtn").style.display = s.canGen ? "" : "none";
    renderSync(s.sync);
    fillForm(s.fields);
  }

  var SYNC_TEXT = { same: "一致", diff: "不一样", empty: "有一边没填", na: "网页版专用" };

  // 两边各存各的，摆成一行行对照 —— 不摆出来就只能靠"手机图片全挂"这种间接症状去猜
  function renderSync(rows) {
    const box = $("wsSyncList");
    if (!box) {return;}
    box.textContent = "";
    if (!Array.isArray(rows) || rows.length === 0) {return;}
    var diffCount = 0;
    rows.forEach(function (r) {
      var item = document.createElement("div");
      item.className = "ws-sync-item " + r.status;

      var head = document.createElement("div");
      head.className = "ws-sync-head";
      var name = document.createElement("span");
      name.textContent = r.label;
      var badge = document.createElement("span");
      badge.className = "ws-badge";
      badge.textContent = SYNC_TEXT[r.status] || r.status;
      head.appendChild(name);
      head.appendChild(badge);
      item.appendChild(head);

      [["VS Code", r.vscode], ["网页版", r.server]].forEach(function (pair) {
        const v = String(pair[1] || "");
        if (!v && r.vscode === null) {return;} // 没有可比项的那一项不画空格子
        var line = document.createElement("div");
        line.className = "ws-sync-v";
        var k = document.createElement("span");
        k.className = "ws-sync-k";
        k.textContent = pair[0];
        var val = document.createElement("span");
        val.textContent = v || "（没填）";
        line.appendChild(k);
        line.appendChild(val);
        item.appendChild(line);
      });
      box.appendChild(item);
      if (r.status === "diff") {diffCount += 1;}
    });
    const sum = $("wsSyncSummary");
    if (sum) {
      sum.textContent =
        diffCount > 0
          ? "有 " + diffCount + " 处两边指向的不是同一个目录：网页版这边改完「保存配置」，" +
            "面板那侧去 VS Code 设置里也改一下。"
          : "两边当前指向的是同一份目录。改任意一边都不会同步到另一边，以后换目录记得两边都改。";
    }
  }

  // 表单只填一次（轮询回来的每次都一样，反复写会打断用户正在输入的光标）
  var formFilled = false;
  function fillForm(fields) {
    if (!fields || formFilled) {return;}
    const map = {
      storageDir: "ws_storage",
      imageDir: "ws_image",
      cacheDir: "ws_cache",
      port: "ws_port",
    };
    for (const k in map) {
      const el = $(map[k]);
      if (el && fields[k] !== undefined && fields[k] !== null) {
        el.value = fields[k];
      }
    }
    formFilled = true;
  }

  function askStatus() {
    post({ type: "status" });
  }

  window.toolClients = window.toolClients || {};
  window.toolClients[TOOL] = {
    init() {
      $("wsMainBtn").onclick = function () {
        post({ type: state.running ? "stop" : "start" });
      };
      $("wsCopyBtn").onclick = function () {
        if (state.url) {post({ type: "copyUrl" });}
      };
      $("wsOpenBtn").onclick = function () {
        if (state.url) {post({ type: "openUrl" });}
      };
      // 点地址本身也能直接跳浏览器（要复制地址才点「复制」）
      $("wsUrl").onclick = function () {
        if (state.url) {post({ type: "openUrl" });}
      };
      $("wsAutoBtn").onclick = function () {
        post({ type: "autostart", value: !state.autostart });
      };
      $("wsSaveBtn").onclick = function () {
        post({
          type: "saveConfig",
          fields: {
            storageDir: $("ws_storage").value,
            imageDir: $("ws_image").value,
            cacheDir: $("ws_cache").value,
            port: $("ws_port").value,
          },
        });
      };
      $("wsOpenCfgBtn").onclick = function () {
        post({ type: "openConfig" });
      };
      $("wsGenBtn").onclick = function () {
        post({ type: "genConfig" });
      };
      document.querySelectorAll("[data-ws-pick]").forEach(function (btn) {
        btn.onclick = function () {
          post({ type: "pickFolder", target: btn.dataset.wsPick });
        };
      });
      askStatus();
      setInterval(askStatus, 5000);
    },
    onMessage(msg) {
      if (msg.type === "wsStatus") {
        renderStatus(msg);
      } else if (msg.type === "wsFill") {
        const map = {
          storageDir: "ws_storage",
          imageDir: "ws_image",
          cacheDir: "ws_cache",
          port: "ws_port",
        };
        const el = $(map[msg.target]);
        if (el) {el.value = msg.path;}
      } else if (msg.type === "wsPicked") {
        // 选完目录顺手刷一次状态（保存按钮的可用性/地址行没问题，但至少让页面有反应）
        askStatus();
      }
    },
  };
})();
