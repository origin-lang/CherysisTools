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

  var state = { running: false, autostart: false, url: "", tunnelUrl: "" };

  /**
   * 外网地址那一行。
   *
   * ⚠️ 这个地址是 Cloudflare 每次现分配的，**服务一重启就换**，所以：
   * - 只显示服务刚给的那一个（`/api/ping` 里的 tunnel.url），不许自己拼、不许存文件下次用 ——
   *   存下来的那个下次一定是死的，比不显示更坑；
   * - 没拿到地址时不显示空行，直接写清"正在连接"或"没开起来 + 原因"。
   */
  function renderTunnel(t) {
    var row = $("wsTunnelRow");
    var copy = $("wsTunnelCopyBtn");
    var open = $("wsTunnelOpenBtn");
    if (!t || t.state === "off") {
      row.style.display = "none";
      state.tunnelUrl = "";
      return;
    }
    row.style.display = "";
    if (t.state === "up" && t.url) {
      state.tunnelUrl = t.url;
      $("wsTunnelUrl").textContent = t.url;
      copy.style.display = "";
      open.style.display = "";
      return;
    }
    state.tunnelUrl = "";
    $("wsTunnelUrl").textContent =
      t.state === "starting" ? "正在连接…（一般 5~10 秒）" : "没开起来：" + (t.error || "原因不明");
    copy.style.display = "none";
    open.style.display = "none";
  }

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
    renderTunnel(s.tunnel);
    $("wsAutoState").textContent = state.autostart ? "已设置（登录时自动起）" : "未设置";
    $("wsAutoBtn").textContent = state.autostart ? "取消开机自启" : "设为开机自启";
    $("wsCfgPath").textContent = s.configPath ? "配置文件：" + s.configPath : "";
    renderCacheHint(s.fields && s.fields.cacheDir, s.cacheDefault);
    renderCmdList(s.cmdNames);
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

  // 本机缓存这一栏空着才是推荐写法（留空 = 服务端按跑服务那台机器的 %LOCALAPPDATA% 兜底），
  // 但空输入框本身看不出这点 —— 所以把"实际会用哪个目录"摆出来。
  // 反过来填了就提醒一句：写死成某台机器某个用户名，这份配置拷到第二台上会指向不存在的目录。
  function renderCacheHint(value, def) {
    const empty = !String(value || "").trim();
    const hint = $("wsCacheHint");
    const filled = $("wsCacheFilled");
    if (hint) {
      hint.style.display = empty ? "" : "none";
      hint.textContent = def
        ? "留空 = 自动用这台机器的默认目录 " + def + "（推荐：换台机器、换用户名都不用改配置）。"
        : "留空 = 自动用这台机器当前用户的默认目录（推荐）。";
    }
    if (filled) {
      filled.style.display = empty ? "none" : "";
      filled.textContent = "填了这个之后，缩略图缓存和九宫格输出都放这儿；" +
        "换台机器跑这份配置时会指向不存在的目录，留空或重新「选文件夹」更稳。";
    }
  }

  // 起/停/自启/取消自启 四个 cmd 列出来：装了扩展的人大半只用过面板，
  // 而"不开 VS Code 也能操作服务"全靠它们（主机上常是这个场景）。
  function renderCmdList(names) {
    const box = $("wsCmdList");
    if (!box || !Array.isArray(names) || names.length === 0) {return;}
    const desc = {
      "启动网页版.cmd": "起服务（先做体检：库读不到就拒跑）",
      "停止服务.cmd": "关服务（会先说清是谁占着端口再杀）",
      "设置开机自启.cmd": "下次登录时自动起（计划任务）",
      "取消开机自启.cmd": "取消上面那个",
    };
    box.textContent = "";
    names.forEach(function (n) {
      const line = document.createElement("div");
      line.textContent = "· " + n + " —— " + (desc[n] || "");
      box.appendChild(line);
    });
    const tip = document.createElement("div");
    tip.style.marginTop = "4px";
    tip.textContent = "双击哪个就对哪层目录生效（cmd 里是 cd /d \"%~dp0\"），所以「停止服务.cmd」和面板用的是同一份配置。";
    box.appendChild(tip);
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
      // 外网地址：把当前这一串原样发给后端（它只认 trycloudflare 的形状），不在前端拼
      $("wsTunnelCopyBtn").onclick = function () {
        if (state.tunnelUrl) {post({ type: "copyTunnel", value: state.tunnelUrl });}
      };
      $("wsTunnelOpenBtn").onclick = function () {
        if (state.tunnelUrl) {post({ type: "openTunnel", value: state.tunnelUrl });}
      };
      $("wsTunnelUrl").onclick = function () {
        if (state.tunnelUrl) {post({ type: "openTunnel", value: state.tunnelUrl });}
      };
      $("wsStopCmdBtn").onclick = function () {
        post({ type: "stopCmd" });
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
