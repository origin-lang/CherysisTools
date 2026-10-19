/* 手机版「扫条码」—— 独立一份（2026-10-18 晚）。
   想整体摘掉：删本文件 + scan.js + index.html 里那两行（这一行 link、末尾的 script），
   再把 restock.js 里调 CherysisScan.open() 的两处去掉即可。

   ===== 为什么是这么做的 =====
   · 老板要的是**对着快递单上的条纹码扫**（顺丰/圆通/中通全是 Code128），不是二维码。
   · iPhone Safari **没有** BarcodeDetector（只有安卓 Chrome 有）→ 必须自带解码库。
     用的是 @zxing/library 的 UMD 单文件（zxing.min.js，336KB，已随包发），
     它自带的 BrowserMultiFormatReader 直接吃 getUserMedia 的视频流，Code128/QR 都认。
   · ⚠️⚠️ **摄像头只在 https 或 localhost 下可用**：手机用局域网地址
     （http://192.168.x.x:667）打开时，浏览器**直接不给摄像头**。
     这不是我们的 bug，是浏览器安全策略，绕不过去 —— 所以：
       · 能用摄像头 → 开摄像头扫；
       · 不能用（http / 用户拒了权限）→ 退成「拍张照选图识别」：
         用 <input type=file accept=image/* capture=environment> 调起系统相机，
         拍完的图在本机 canvas 上解码，**不上传**（局域网 http 下连文件都不用发）。
   · 两种路兜底后，局域网 http 下也能用，只是要手点一下拍照。

   ===== 对外接口（唯一入口，别在别处再写一套扫码） =====
     CherysisScan.open({ title, onCode })   → 打开扫码遮罩，解出字符串后回调一次并自动关
     CherysisScan.available()               → { camera: bool, reason: string }
   ======================================================== */

(function () {
  var API = window.Cherysis || {};
  var $ = API.$ || function (id) { return document.getElementById(id); };

  var state = {
    onCode: null,
    reader: null,      // ZXing BrowserMultiFormatReader
    stream: null,      // 是不是"我们开的"摄像头（必须自己关，否则偷跑）
    running: false,
    got: false,        // 已经解出来了 → 忽略后面的帧
    lastErr: "",
  };

  /** 摄像头到底能不能用：https / localhost 才算安全上下文；有 BarcodeDetector 不是必要条件 */
  function available() {
    var secure = false;
    try {
      secure = window.isSecureContext === true;
    } catch (e) {
      secure = false;
    }
    var hasMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!secure) {
      return { camera: false, reason: "这是局域网地址（http），浏览器不给用摄像头" };
    }
    if (!hasMedia) {
      return { camera: false, reason: "这个浏览器不支持调摄像头" };
    }
    return { camera: true, reason: "" };
  }

  // ---------- 遮罩 DOM（一次建好，反复开合只切 hidden） ----------
  function ensureDom() {
    var box = $("scanMask");
    if (box) {
      return box;
    }
    box = document.createElement("div");
    box.id = "scanMask";
    box.className = "scan-mask";
    box.hidden = true;
    box.innerHTML =
      '<div class="scan-panel">' +
      '<div class="scan-h"><span id="scanTitle">扫条码</span>' +
      '<button class="scan-x" type="button" data-scan="close">✕</button></div>' +
      '<div class="scan-stage">' +
      '<video id="scanVideo" class="scan-video" playsinline muted></video>' +
      '<div class="scan-frame"></div>' +
      '<div class="scan-tip" id="scanTip">把条码对到屏幕中间的绿线附近</div>' +
      // 局域网 http 下才亮出来（见 open() 的 else 分支）：一键复制内网 https 地址
      '<button class="scan-copy" id="scanCopy" type="button" data-scan="copy" hidden></button>' +
      "</div>" +
      '<div class="scan-acts">' +
      // 局域网 http 下摄像头不可用 → 这颗是**主力**；能用摄像头时它也在（有人就是更习惯拍照）
      '<button class="scan-btn" type="button" data-scan="photo">📷 拍张照识别</button>' +
      '<button class="scan-btn ghost" type="button" data-scan="close">取消</button>' +
      "</div>" +
      '<input id="scanFile" type="file" accept="image/*" capture="environment" hidden />' +
      "</div>";
    document.body.appendChild(box);
    return box;
  }

  function setTip(txt, bad) {
    var t = $("scanTip");
    if (!t) {
      return;
    }
    t.textContent = txt || "";
    t.classList.toggle("bad", !!bad);
  }

  /** 解出结果 → 回调 + 关掉（只触发一次） */
  function finish(code) {
    if (state.got) {
      return;
    }
    var s = String(code == null ? "" : code).trim();
    if (!s) {
      return;
    }
    state.got = true;
    var cb = state.onCode;
    close();
    if (typeof cb === "function") {
      // 推一拍再回调：close() 里刚停了摄像头，iOS 上同一拍里开弹层会卡
      setTimeout(function () {
        cb(s);
      }, 30);
    }
  }

  function close() {
    state.got = true; // 关的时候也让后面的帧失效
    state.running = false;
    state.onCode = null;
    // ① 停 zxing 的解码循环 + 关流（BrowserMultiFormatReader 会自己关它开的流，
    //    但我们兜底再过一遍：iOS 上偶尔留一条活着的轨道，摄像头灯不灭）
    try {
      if (state.reader && state.reader.reset) {
        state.reader.reset();
      }
    } catch (e) {}
    try {
      if (state.stream) {
        state.stream.getTracks().forEach(function (t) {
          t.stop();
        });
      }
    } catch (e) {}
    state.stream = null;
    var v = $("scanVideo");
    if (v) {
      try {
        v.pause();
        v.srcObject = null;
      } catch (e) {}
    }
    var box = $("scanMask");
    if (box) {
      box.hidden = true;
    }
  }

  // ---------- 路 1：摄像头实时扫 ----------
  function startCamera() {
    if (!window.ZXing || !window.ZXing.BrowserMultiFormatReader) {
      setTip("扫码组件没加载上，换个方式拍照识别吧", true);
      return;
    }
    var v = $("scanVideo");
    if (!v) {
      return;
    }
    state.got = false;
    state.running = true;
    setTip("把条码对到屏幕中间的绿线附近");
    var hints = new Map();
    // 只认这几种：快递单上最常见的一维码 + 二维码（有人拿二维码贴纸）
    hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      window.ZXing.BarcodeFormat.CODE_128,
      window.ZXing.BarcodeFormat.CODE_39,
      window.ZXing.BarcodeFormat.EAN_13,
      window.ZXing.BarcodeFormat.ITF,
      window.ZXing.BarcodeFormat.QR_CODE,
    ]);
    try {
      state.reader = new window.ZXing.BrowserMultiFormatReader(hints, {
        delayBetweenScanSuccess: 400,
        delayBetweenScanAttempts: 120,
      });
      state.reader.decodeFromConstraints(
        // 后置 + 尽量高分辨率（条码细，低了解不出）
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        v,
        function (result) {
          if (result && result.getText && !state.got) {
            finish(result.getText());
          }
        },
      );
    } catch (e) {
      setTip("摄像头打不开，换「拍张照识别」吧", true);
      return;
    }
    // 顺手记一下我们拿到的流：close() 关灯用
    setTimeout(function () {
      if (v.srcObject) {
        state.stream = v.srcObject;
      }
    }, 300);
  }

  // ---------- 路 2：拍张照 → 本机解码（不上传） ----------
  function pickPhoto() {
    var f = $("scanFile");
    if (!f) {
      return;
    }
    f.value = ""; // 同一张图能反复选
    f.click();
  }

  /**
   * 图片 → 条码内容。全在本机做：createImageBitmap / Image → canvas → zxing 读像素。
   * ⚠️ 不发给服务端：局域网 http 下本来就没有摄像头，拍照这条要是还上传，
   *    等于绕远路还多一次传输 —— 而且隐私上不干净（快递单上啥都有）。
   */
  function decodeImageFile(file) {
    if (!file) {
      return;
    }
    if (!window.ZXing) {
      setTip("扫码组件没加载上", true);
      return;
    }
    setTip("正在识别…");
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        // 长边压到 1600：条码解码不需要原图，太大反而慢
        var maxSide = 1600;
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        var ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        var data = ctx.getImageData(0, 0, w, h);

        // ⚠️⚠️ 必须**先转成单通道灰度**再交给 zxing（2026-10-18 实测挖出来的坑）：
        //   canvas.getImageData() 给的是 RGBA 四通道，直接 new RGBLuminanceSource(data, w, h)
        //   看起来"应该"也行（库文档说它接受 RGB），但这一版**解不出来**——
        //   同一张条码图，4 通道传进去 ❌「No MultiFormat Readers were able to detect the code」，
        //   转成单通道灰度 ✅ 立刻解出。浏览器里只有 RGBA 这一种来源，所以不转就是 100% 失败。
        var gray = new Uint8ClampedArray(w * h);
        for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
          // 加权灰度（人眼对绿最敏感）：跟浏览器/图像库的标准公式一致
          gray[i] = (data.data[p] * 0.299 + data.data[p + 1] * 0.587 + data.data[p + 2] * 0.114) | 0;
        }

        var lum = new window.ZXing.RGBLuminanceSource(gray, w, h);
        var bmp = new window.ZXing.BinaryBitmap(new window.ZXing.HybridBinarizer(lum));
        var reader = new window.ZXing.MultiFormatReader();
        var hints = new Map();
        hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
          window.ZXing.BarcodeFormat.CODE_128,
          window.ZXing.BarcodeFormat.CODE_39,
          window.ZXing.BarcodeFormat.EAN_13,
          window.ZXing.BarcodeFormat.ITF,
          window.ZXing.BarcodeFormat.QR_CODE,
        ]);
        reader.setHints(hints);
        var r = reader.decode(bmp);
        URL.revokeObjectURL(url);
        finish(r.getText());
      } catch (e) {
        URL.revokeObjectURL(url);
        setTip("这张图里没认出条码，凑近点、让条纹占满画面再拍一张", true);
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setTip("这张图打不开，重拍一张吧", true);
    };
    img.src = url;
  }

  // ---------- 接线 ----------
  function bindOnce() {
    var box = $("scanMask");
    if (!box || box.dataset.bound === "1") {
      return;
    }
    box.dataset.bound = "1";
    box.onclick = function (e) {
      var t = e.target;
      var act = t && t.closest ? t.closest("[data-scan]") : null;
      if (act) {
        var k = act.dataset.scan;
        if (k === "close") {
          close();
        } else if (k === "photo") {
          pickPhoto();
        } else if (k === "retry") {
          startCamera();
        } else if (k === "copy") {
          // 把拼好的 https 地址复制到剪贴板（局域网 http 没有 navigator.clipboard，
          // 走 textarea + execCommand 老路，见 copyText）
          var chip = $("scanCopy");
          var port = Number((chip && chip.textContent.match(/:(\d+)/) || [])[1] || 0);
          if (port > 0) {
            copyText("https://" + location.hostname + ":" + port, function (ok) {
              if (chip) {
                chip.textContent = ok ? "✓ 已复制，去浏览器地址栏粘贴打开" : "复制失败，手抄：" + location.hostname + ":" + port;
              }
            });
          }
          return;
        }
        return;
      }
      if (t && t.id === "scanMask") {
        close(); // 点遮罩空白 = 关
      }
    };
    var f = $("scanFile");
    if (f) {
      f.onchange = function () {
        decodeImageFile(this.files && this.files[0]);
      };
    }
  }

  /** 对外唯一入口 */
  function open(opts) {
    var o = opts || {};
    var box = ensureDom();
    bindOnce();
    state.onCode = o.onCode;
    state.got = false;
    var title = $("scanTitle");
    if (title) {
      title.textContent = o.title || "扫条码";
    }
    box.hidden = false;

    var av = available();
    if (av.camera) {
      hideCopyChip();
      startCamera();
    } else {
      // 摄像头用不了：不硬试（iOS 上会直接抛 NotAllowedError，弹个看不懂的提示），
      // 直接把"为什么会这样 + 怎么办"写在框里，人一看就知道该点拍照。
      setTip(av.reason + " → 点下面「拍张照识别」", true);
      // 2026-10-19：内网上了 https（方案 B）之后，http 页面上点扫码不该让人自己记住
      // 第二个网址 —— 服务端把端口报出来（/api/ping 的 httpsPort），这里拼好地址
      // 放一颗"点此复制"的按钮，别人照着贴到浏览器地址栏就行。
      showCopyChip();
    }
  }

  // ---------- 内网 https 地址提示（http 页面上才有用） ----------
  var httpsPortCache = -1; // -1 = 还没问过；0 = 服务端没开 https

  /** 问服务端 https 端口（同一个源，/api/ping 不用鉴权拿这一项就够了） */
  function fetchHttpsPort(cb) {
    if (httpsPortCache >= 0) {
      cb(httpsPortCache);
      return;
    }
    try {
      fetch("api/ping")
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          var p = Number(j && j.httpsPort);
          httpsPortCache = p >= 0 && p <= 65535 ? p : 0;
          cb(httpsPortCache);
        })
        .catch(function () {
          httpsPortCache = 0;
          cb(0);
        });
    } catch (e) {
      httpsPortCache = 0;
      cb(0);
    }
  }

  /** http 页面上点亮"复制 https 地址"按钮；服务端没开 https（0）就不亮，别给一个死地址 */
  function showCopyChip() {
    fetchHttpsPort(function (port) {
      var chip = $("scanCopy");
      if (!chip || port <= 0) {
        return;
      }
      chip.textContent = "📷 摄像头扫码请用 https://" + location.hostname + ":" + port + "（点此复制）";
      chip.hidden = false;
    });
  }

  function hideCopyChip() {
    var chip = $("scanCopy");
    if (chip) {
      chip.hidden = true;
    }
  }

  /**
   * 局域网是 http → navigator.clipboard 不存在（内存里的老规矩），复制必须走
   * textarea + execCommand 这条老路。
   */
  function copyText(s, done) {
    var ta = document.createElement("textarea");
    ta.value = s;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    done(!!ok);
  }

  window.CherysisScan = {
    open: open,
    close: close,
    available: available,
  };
})();
