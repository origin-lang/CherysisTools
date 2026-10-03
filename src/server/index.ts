import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { loadConfig, lanUrls, type ServerConfig } from "./config.js";
import { createHttpHost, makeRequestSink, PrefsStore } from "./httpHost.js";
import { EventHub, shouldAnnounceChange, type SseSink } from "./events.js";
import { SerialQueue } from "./serialQueue.js";
import { TaskQueue } from "./taskQueue.js";
import { shopTool, isWriteAction } from "../tools/shopTool/index.js";
import { initDB, closeDB, getDB, getDBPath } from "../tools/shopTool/db.js";
import { effectiveImageDir, initImageDirConfig, resolveImageDir } from "../tools/shopTool/imageDir.js";
import {
  listImageFiles,
  sharedThumbRoot,
  thumbToCachedBase64,
  midToCachedBase64,
} from "../tools/shopTool/images.js";

/**
 * 网页版服务端。
 *
 * 设计见 docs/网页版方案-设计.md：**业务逻辑一行都不重写**——
 * 这里只做三件事：① 把 HTTP 请求变成 handler 认的 ctx（见 httpHost.ts）；
 * ② 把 handler 的 postToWebview/log 收成 JSON 响应；③ 图片与静态文件。
 *
 * 启动：node out/server/index.js --storage-dir=... --image-dir=... [--port=13800]
 */

const MAX_BODY = 64 * 1024 * 1024; // 手机照片走 base64 上传，给足额度（一张 10MB 的照片 ≈ 13MB base64）

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
};

/**
 * 一次 `/api/invoke` 的结果。
 * `posts`/`logs` 是本次请求期间的回推与日志（前端照旧逐条喂给 onMessage）；
 * `rev` 是库的版本号 —— 现在前端只把它记下来备用，留着做"字段级冲突拦截"那一步
 * （本期明确不做，见 docs/网页版方案-设计.md §M2 的取舍）。
 */
type InvokeResult = {
  ok: boolean;
  posts: any[];
  logs: string[];
  error?: string;
  rev: { seq: number; at: string };
};

/** 单段名字（编号/文件名）：不许路径分隔符、不许以点开头 —— 与服务端图片路由的第一道校验 */
function isPlainName(s: string): boolean {
  return !!s && s !== "." && s !== ".." && !/[\\/]/.test(s) && !s.startsWith(".");
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`请求体太大（>${Math.round(MAX_BODY / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.argv.slice(2));

  for (const [name, dir] of [
    ["数据目录", cfg.storageDir],
    ["本机缓存目录", cfg.cacheDir],
  ] as Array<[string, string]>) {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dir)) {
      throw new Error(`${name}建不出来：${dir}`);
    }
  }

  // 图片根目录由服务端配置提供，注入给 imageDir.ts（那个文件刻意不 import vscode）
  initImageDirConfig({
    read: () => cfg.imageDir,
    scope: () => "user",
    write: async (dir: string) => {
      cfg.imageDir = dir;
    },
    clear: async () => {
      cfg.imageDir = "";
    },
  });

  initDB(cfg.storageDir); // 提前打开，好让「库打不开」在启动时就报出来
  const prefs = new PrefsStore(cfg.prefsFile);

  // 实时推送中枢（SSE /api/events）：整个进程一个，后台任务也往里投
  const hub = new EventHub();

  // 写请求排队：同一时刻只有一个写进 handleMessage。理由见 src/server/serialQueue.ts
  const writeLock = new SerialQueue("写请求");

  // 重活队列（生成共享缩略图 / 生成九宫格）：全组共用一个服务进程、一份共享盘，
  // 同一时刻只跑一个。排队状态走 SSE 的 queue 事件推给手机，别让"点了没反应"。
  const tasks = new TaskQueue((name, err) =>
    hub.publish({ event: "log", data: `❌${name}失败：${(err as any)?.message ?? err}` }),
  );
  tasks.onChange((s) => {
    hub.publish({ event: "queue", data: s });
  });

  /** 库的版本号：每次**真的写成功**（库文件指纹变了）才 +1，随响应和 changed 事件下发 */
  const rev = { seq: 0, at: "" };

  /**
   * 库文件指纹：`大小:毫秒时间戳`。
   * 用它判断"这次写到底动没动库"，比看 handler 有没有报错准 —— handleMessage 把业务错误
   * 吞在内部（只记日志），抛不抛异常跟写没写成功是两回事。
   */
  const dbFingerprint = (): string => {
    try {
      const st = fs.statSync(getDBPath());
      return `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      return "";
    }
  };

  /**
   * 告诉所有人"数据有更新了"，让他们把「🔄 有改动」亮起来。
   * `by` 是发起人：中枢按它跳过发起人自己（他手上已经是最新的了）。
   * `by` 为空串 = 服务端自己发现的（电脑版直接写了同一个库，见下面的巡检）。
   */
  const publishChanged = (by: string): void => {
    hub.publish({ event: "changed", data: { seq: rev.seq, at: rev.at, by }, origin: by });
  };

  /** 请求带来的 clientId（浏览器 localStorage 里生成的一个随机串）：用来做「跳过自己」的去重 */
  const clientOf = (req: http.IncomingMessage): string =>
    String((req.headers["x-cherysis-client"] as string) || "").slice(0, 64);

  /**
   * 别人**不经过这个服务**改了库（电脑版 VS Code 直接写同一个 shop.db）时，服务端收不到任何
   * 消息，只能自己巡检。用 SQLite 的 `data_version`：它的语义是"**别的连接**提交过就变"，
   * 自己写的不会动自己 —— 正好就是我们要的"外面有人改过"。
   *
   * 3 秒一次、每次一个 pragma（本地读，几微秒）。撞上别人的排他锁会抛 SQLITE_BUSY，
   * 那就跳过这一轮（下一轮再看），不能把定时器弄挂。
   */
  let lastDv = 0;
  const readDataVersion = (): number => {
    try {
      return getDB().dataVersion();
    } catch {
      return lastDv;
    }
  };
  /**
   * 图片「心跳」的上一次取值。
   *
   * 光靠 data_version 是不够的，它有两条命门：① 它的语义是"**别的连接**提交过才变"，
   * 这个服务自己写的（手机传图/删图）**自己看不见**，于是浏览器之间永远同步不了图片；
   * ② 图片压根不写库 —— 谁删了图都不改 data_version。
   * 所以图片操作会写一次 `image_stamp`（见 handlers/image.ts 的 bumpImageStamp），
   * 这里比对**值**（谁写的都能看见），两个判据取或。
   */
  let lastImgStamp = "";
  const readImgStamp = (): string => {
    try {
      return String(getDB().getSetting("image_stamp") || "");
    } catch {
      return lastImgStamp;
    }
  };
  lastDv = readDataVersion();
  lastImgStamp = readImgStamp();
  const dvTimer = setInterval(() => {
    const dv = readDataVersion();
    const stamp = readImgStamp();
    if (dv !== lastDv || stamp !== lastImgStamp) {
      lastDv = dv;
      lastImgStamp = stamp;
      publishChanged(""); // by 为空 = 服务端自己发现的，广播给所有人（含发起不了的那种"别人"）
    }
  }, 3000);

  const resolveImgDir = (): string =>
    effectiveImageDir(resolveImageDir(String(getDB().getSetting("image_dir") || "")));

  /**
   * 一次 /api/invoke：新建一个 host（posts/logs 按请求隔离），跑完把那两条数组回给浏览器。
   *
   * 同时把每条回推/日志投进实时推送中枢（makeRequestSink 的 emit）——「跳过发起人自己」
   * 与「回完之后清掉 origin」这两条规则都在那个函数里，理由见它的注释。
   * 请求回完立刻 `detached = true`：后台任务后面那些日志只走推送，
   * 否则它们会一直往一个没人再读的数组里堆。
   */
  async function invoke(msg: any, clientId: string): Promise<InvokeResult> {
    const type = String(msg?.type ?? "");
    // 「哪些消息算写」这份清单只有一处（shopTool/index.ts 的 WRITE_ACTIONS，只读模式用的也是它），
    // 这里只是照着它决定要不要排队 —— 不复制清单，免得两处对不上。
    const isWrite = isWriteAction(type);
    const run = async (): Promise<InvokeResult> => {
      const before = isWrite ? dbFingerprint() : "";
      const sink = makeRequestSink(clientId, (e) => hub.publish(e));
      const host = createHttpHost(cfg, sink, prefs, tasks);
      let out: InvokeResult;
      try {
        await shopTool.handleMessage(msg, host);
        out = { ok: true, posts: sink.posts, logs: sink.logs, rev: { seq: rev.seq, at: rev.at } };
      } catch (err: any) {
        out = {
          ok: false,
          posts: sink.posts,
          logs: sink.logs,
          error: String(err?.message ?? err),
          rev: { seq: rev.seq, at: rev.at },
        };
      }
      sink.detached = true;

      if (isWrite && dbFingerprint() !== before) {
        rev.seq++;
        rev.at = new Date().toISOString();
        // 别人要不要被提醒，只看"这次写有没有顺手回推"：理由写在 shouldAnnounceChange 上
        if (shouldAnnounceChange(true, sink.posts.length)) {
          publishChanged(clientId);
        }
      }
      out.rev = { seq: rev.seq, at: rev.at };
      return out;
    };
    // 写请求排队（并发=1）：两个人同时保存时不再交错着进 handleMessage
    return isWrite ? writeLock.run(run) : run();
  }

  /**
   * GET /api/events —— SSE。
   *
   * 几个必须写对的点：
   * - `no-cache` + `no-transform`：中间设备（代理/杀软）会缓存或改写字流，改了就成"卡住不动"。
   * - 心跳注释行 `: ping`：空闲连接会被路由/手机省电策略掐掉，25 秒一句让它保持"有流量"。
   * - 断线续传：浏览器自带重连并带上 `Last-Event-ID`，交给 hub.replay 补发。
   * - token 只能走 `?token=`：EventSource **不能**带自定义请求头（所以没有 x-cherysis-token 这条路）。
   */
  function openEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // 先把响应头认下来，之后即使一条事件都没有，客户端也知道"连上了"
    res.write(": connected\n\n");
    const sink: SseSink = {
      origin: String(url.searchParams.get("client") || "").slice(0, 64),
      write: (chunk) => res.write(chunk),
      end: () => res.end(),
    };
    const detach = hub.attach(sink);
    hub.replay(sink, Number(req.headers["last-event-id"] || 0) || 0);
    const beat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* 连接已经断了，close 事件里会收尾 */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(beat);
      detach();
    });
  }

  /**
   * 把文件流给响应。**必须**在任一端提前收摊时销毁读流。
   *
   * 为什么不能只写 `createReadStream(fp).pipe(res)`：客户端提前掐断连接（手机切后台、
   * 关掉大图、切页面）时，`pipe` 只会把源流 unpipe，**不会 destroy 它** —— 文件描述符
   * 就这么泄漏了，而且只有进程退出才还回来。Windows 上这个句柄是「不带 FILE_SHARE_DELETE」
   * 打开的，后果非常隐蔽：**这张图连本进程自己都删不掉**，别人（VS Code 那边）更删不掉，
   * 表现就是「封面永远 EBUSY，重启服务就好了」。所以两端都要兜。
   */
  function pipeFile(fp: string, res: http.ServerResponse): void {
    const rs = fs.createReadStream(fp);
    const kill = () => {
      if (!rs.destroyed) {
        rs.destroy();
      }
    };
    // 响应提前结束（客户端断开 / 出错）→ 立刻放掉文件句柄
    res.on("close", kill);
    res.on("error", kill);
    // 读的过程中文件没了/读不了 → 别让请求挂着
    rs.on("error", () => {
      kill();
      if (!res.writableEnded) {
        res.destroy();
      }
    });
    rs.pipe(res);
  }

  /** 图片：size=thumb 走两级缩略图缓存回 webp；size=full 直接流原文件 */
  async function sendImage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const code = url.searchParams.get("code") || "";
    const name = url.searchParams.get("name") || "";
    // thumb = 512 方图（画册卡片），mid = 1024 等比（详情页封面），full = 原图（看细节）
    const rawSize = url.searchParams.get("size");
    const size = rawSize === "full" ? "full" : rawSize === "mid" ? "mid" : "thumb";
    if (!isPlainName(code) || (name && !isPlainName(name))) {
      sendJson(res, 400, { ok: false, error: "编号或文件名不合法" });
      return;
    }
    const dir = resolveImgDir();
    if (!dir) {
      sendJson(res, 404, { ok: false, error: "服务端还没配图片根目录（--image-dir）" });
      return;
    }
    const folder = path.join(dir, code);
    const files = listImageFiles(folder);
    // 不传 name 就是封面（与扩展同一条口径：夹里按加入时间排的第一张）
    const file = name ? (files.includes(name) ? name : null) : files[0] || null;
    if (!file) {
      sendJson(res, 404, { ok: false, error: name ? "这张图不在了" : "该商品没有图片" });
      return;
    }
    const src = path.join(folder, file);
    let st: fs.Stats;
    try {
      st = fs.statSync(src);
    } catch {
      sendJson(res, 404, { ok: false, error: "文件读不到" });
      return;
    }
    // ETag 用「源文件大小 + mtime（毫秒，不取整）」：源图一改指纹就变，浏览器不会再拿旧图。
    //
    // **故意不把 image_stamp 塞进来**：那个心跳是**全局**的（任何商品的任何一张图一改就变），
    // 塞进每张图的 ETag 等于"一张图变了、全站所有图的缓存一起作废"，正好把 304 的意义毁掉。
    // 判断"这张图变没变"就该只看这张图自己的属性 —— size + mtime 已经够：
    // 覆盖写一定会更新 mtime，而"同尺寸 + 同一毫秒内被替换"实际不可能发生。
    const etag = `W/"${st.size}-${st.mtimeMs}-${size}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag }).end();
      return;
    }
    if (size === "full") {
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": st.size,
        ETag: etag,
        // 见 sendImage 上方 sendThumbHeaders 的注释：必须每次回源校验，否则别的端删/换过的图
        // 会被浏览器拿缓存顶着，显示成旧图。
        "Cache-Control": "private, max-age=0, must-revalidate",
      });
      pipeFile(src, res); // 不能裸 pipe：客户端断开会漏掉文件句柄，详见 pipeFile 的注释
      return;
    }
    try {
      const shared = {
        root: sharedThumbRoot(cfg.storageDir, cfg.cacheDir),
        writable: true as const,
      };
      // mid 与 thumb 共用同一套三级缓存，只是尺寸和缓存名不同（见 images.ts 的 MID_SIZE）
      const b64 =
        size === "mid"
          ? await midToCachedBase64(src, cfg.cacheDir, code, name || undefined, shared)
          : await thumbToCachedBase64(src, cfg.cacheDir, code, name || undefined, shared);
      const buf = Buffer.from(String(b64).split(",")[1] || "", "base64");
      if (buf.length === 0) {
        throw new Error("缩图失败");
      }
      res.writeHead(200, {
        "Content-Type": MIME[".webp"],
        "Content-Length": buf.length,
        ETag: etag,
        // 为什么从 max-age=300 改成 0：图片会被「别的端」改掉（同事直接在共享盘删/换图、
        // VS Code 面板删图），那些改动不写数据库，任何版本号/事件都通知不到网页。
        // 让浏览器每次回来校验一次，没变就是 304（只 stat 一下，一个字节都不传，比传几十 KB
        // 缩略图还省）；变没了就 404，前端 onerror 立刻显示「暂无图片」。
        // 这正是 ETag（上面那个 size-mtime-size）存在的意义 —— 之前的 max-age 让它白有。
        "Cache-Control": "private, max-age=0, must-revalidate",
      });
      res.end(buf);
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: `缩图失败：${err?.message ?? err}` });
    }
  }

  /** 静态文件：只认 publicDir 里的文件，`..` 一律挡掉 */
  function sendStatic(res: http.ServerResponse, rel: string): void {
    const fp = path.resolve(cfg.publicDir, rel);
    if (!fp.startsWith(path.resolve(cfg.publicDir))) {
      sendJson(res, 403, { ok: false, error: "越界" });
      return;
    }
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      sendJson(res, 404, { ok: false, error: `没有这个文件：${rel}` });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    pipeFile(fp, res);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const p = url.pathname;

      // 鉴权：配了 token 就要求带上（局域网内可以先不配，见设计稿 §4.4）
      if (cfg.token) {
        const given =
          req.headers["x-cherysis-token"] === cfg.token || url.searchParams.get("token") === cfg.token;
        if (!given && p.startsWith("/api/")) {
          sendJson(res, 401, { ok: false, error: "token 不对（在地址后面加 ?token=... 或填进页面里）" });
          return;
        }
      }

      if (p === "/api/ping") {
        sendJson(res, 200, {
          ok: true,
          storageDir: cfg.storageDir,
          imageDir: cfg.imageDir,
          imageDirReady: !!resolveImgDir(),
          tokenRequired: !!cfg.token,
          // 连着的实时连接数：排查「手机到底连上没有」（0 = 一个都没连，先看手机端报什么错）
          eventClients: hub.clientCount,
          // 库的版本号 + 写队列深度：排查「是不是有人在排队 / 是不是别人刚写过」
          rev: { seq: rev.seq, at: rev.at },
          writeQueue: writeLock.depth,
          // 巡检看到的 SQLite data_version：别人（电脑版）直接写同一个库时它会变。
          // 排查「外面改了但手机没提示」时先看这个：它不动 = 巡检压根没看见变化。
          dataVersion: lastDv,
          // 重活队列：正在跑哪个、还有谁在排队（「点了没反应」多半是这里在排队）
          tasks: tasks.status(),
        });
        return;
      }

      if (p === "/api/events") {
        openEvents(req, res, url);
        return;
      }

      if (p === "/api/invoke") {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "只收 POST" });
          return;
        }
        let msg: any;
        try {
          msg = JSON.parse(await readBody(req));
        } catch (err: any) {
          sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${err?.message ?? err}` });
          return;
        }
        sendJson(res, 200, await invoke(msg, clientOf(req)));
        return;
      }

      if (p === "/api/image") {
        await sendImage(req, res, url);
        return;
      }

      // 某商品的图片文件名清单。用 listImageFiles 这一条**同源**规则（不改业务逻辑），
      // 但只回名字、不回 base64：手机要的是「有多少张、叫什么」，字节走 /api/image 按需拿。
      if (p === "/api/images") {
        const code = url.searchParams.get("code") || "";
        if (!isPlainName(code)) {
          sendJson(res, 400, { ok: false, error: "编号不合法" });
          return;
        }
        const dir = resolveImgDir();
        const names = dir ? listImageFiles(path.join(dir, code)) : [];
        sendJson(res, 200, { ok: true, code, names });
        return;
      }

      // 其余当静态文件；/ 给 index.html
      sendStatic(res, p === "/" ? "index.html" : p.replace(/^\/+/, ""));
    })().catch((err: any) => {
      try {
        sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      } catch {
        /* 响应已经发出去了 */
      }
    });
  });

  server.listen(cfg.port, cfg.host, () => {
    const urls = lanUrls(cfg.port);
    console.log("🔧Cherysis 网页版服务已启动");
    console.log(`   数据目录：${cfg.storageDir}`);
    console.log(`   图片目录：${cfg.imageDir || "（未配置！图片相关的功能会报错）"}`);
    console.log(`   本机缓存：${cfg.cacheDir}`);
    console.log(`   本机访问：http://localhost:${cfg.port}${cfg.token ? `/?token=${cfg.token}` : ""}`);
    for (const u of urls) {
      console.log(`   手机访问：${u}${cfg.token ? `/?token=${cfg.token}` : ""}`);
    }
    if (urls.length === 0) {
      console.log("   （没找到局域网地址：检查网卡/防火墙）");
    }
    if (!cfg.imageDir) {
      console.log("⚠️没配图片根目录：加 --image-dir=D:\\商品图片，或在 cherysis-server.config.json 里写 imageDir");
    }
  });

  const bye = (): void => {
    clearInterval(dvTimer); // 巡检定时器先停，别在关库之后再碰库
    hub.closeAll(); // 再把 SSE 连接收干净：不然手机要一直等到超时才发现服务停了
    try {
      closeDB();
    } catch {
      /* 忽略 */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main().catch((err: any) => {
  console.error(`❌服务启动失败：${err?.message ?? err}`);
  process.exit(1);
});
