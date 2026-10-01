import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { loadConfig, lanUrls, type ServerConfig } from "./config.js";
import { createHttpHost, PrefsStore, type HostSink } from "./httpHost.js";
import { shopTool } from "../tools/shopTool/index.js";
import { initDB, closeDB, getDB } from "../tools/shopTool/db.js";
import { effectiveImageDir, initImageDirConfig, resolveImageDir } from "../tools/shopTool/imageDir.js";
import { listImageFiles, sharedThumbRoot, thumbToCachedBase64 } from "../tools/shopTool/images.js";

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

  const resolveImgDir = (): string =>
    effectiveImageDir(resolveImageDir(String(getDB().getSetting("image_dir") || "")));

  /** 一次 /api/invoke：新建一个 host（posts/logs 按请求隔离），跑完把那两条数组回给浏览器 */
  async function invoke(msg: any): Promise<{ ok: boolean; posts: any[]; logs: string[]; error?: string }> {
    const sink: HostSink = { posts: [], logs: [] };
    const host = createHttpHost(cfg, sink, prefs);
    try {
      await shopTool.handleMessage(msg, host);
      return { ok: true, posts: sink.posts, logs: sink.logs };
    } catch (err: any) {
      return { ok: false, posts: sink.posts, logs: sink.logs, error: String(err?.message ?? err) };
    }
  }

  /** 图片：size=thumb 走两级缩略图缓存回 webp；size=full 直接流原文件 */
  async function sendImage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const code = url.searchParams.get("code") || "";
    const name = url.searchParams.get("name") || "";
    const size = url.searchParams.get("size") === "full" ? "full" : "thumb";
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
    // ETag 用「源文件大小 + mtime」：源图一改指纹就变，浏览器不会再拿旧图
    const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}-${size}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag }).end();
      return;
    }
    if (size === "full") {
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": st.size,
        ETag: etag,
        "Cache-Control": "private, max-age=60",
      });
      fs.createReadStream(src).pipe(res);
      return;
    }
    try {
      const b64 = await thumbToCachedBase64(src, cfg.cacheDir, code, name || undefined, {
        root: sharedThumbRoot(cfg.storageDir, cfg.cacheDir),
        writable: true,
      });
      const buf = Buffer.from(String(b64).split(",")[1] || "", "base64");
      if (buf.length === 0) {
        throw new Error("缩图失败");
      }
      res.writeHead(200, {
        "Content-Type": MIME[".webp"],
        "Content-Length": buf.length,
        ETag: etag,
        "Cache-Control": "private, max-age=300",
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
    fs.createReadStream(fp).pipe(res);
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
        });
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
        sendJson(res, 200, await invoke(msg));
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
