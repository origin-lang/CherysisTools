import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 网页版服务端的配置。
 *
 * 与 VS Code 版最大的不同：**目录不在面板里选，而是服务端配置**（浏览器列不出服务器上的文件夹）。
 * 三级来源，优先级 命令行 > 环境变量 > 配置文件：
 *   --storage-dir=...   或 CHERYSIS_STORAGE_DIR
 *   --image-dir=...     或 CHERYSIS_IMAGE_DIR
 *   --port / --host / --token / --cache-dir / --live-out-dir / --config
 */
export type ServerConfig = {
  /** shop.db 所在目录（多人共享时就是共享盘上那个） */
  storageDir: string;
  /** 商品图片根目录（每个商品一个子文件夹） */
  imageDir: string;
  /** 服务端自己的本机目录：缩略图缓存 + 偏好文件（**不要**指向共享盘） */
  cacheDir: string;
  /** 九宫格 / 星标总览的输出目录（服务端路径） */
  liveOutDir: string;
  /** 服务端偏好文件（readOnly 等） */
  prefsFile: string;
  host: string;
  port: number;
  /** 空串 = 不校验（局域网内先这样，见 docs/网页版方案-设计.md §4.4） */
  token: string;
  /** 网页静态文件目录（默认 src/webview/mobile，与扩展读 fragment 同一套约定：运行时从 src 读） */
  publicDir: string;
};

type RawArgs = Record<string, string>;

function parseArgs(argv: string[]): RawArgs {
  const out: RawArgs = {};
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a);
    if (m) {
      out[m[1]] = m[2] ?? "1";
    }
  }
  return out;
}

function readConfigFile(fp: string): RawArgs {
  if (!fp || !fs.existsSync(fp)) {
    return {};
  }
  try {
    // 去掉 BOM：Windows 记事本"另存为 UTF-8"会写 BOM，JSON.parse 会因此直接报错，
    // 而这个文件里通常有中文路径（z:\测试商品…），用户很可能就是用记事本改的
    const text = fs.readFileSync(fp, "utf-8").replace(/^\uFEFF/, "");
    const j = JSON.parse(text) as Record<string, unknown>;
    const out: RawArgs = {};
    for (const [k, v] of Object.entries(j)) {
      if (v !== undefined && v !== null) {
        out[k] = String(v);
      }
    }
    return out;
  } catch (err: any) {
    throw new Error(`配置文件读不了（${fp}）：${err?.message ?? err}`);
  }
}

const DEFAULT_STORAGE = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Code",
  "User",
  "globalStorage",
  "faye.cherysis",
);

export function loadConfig(argv: string[]): ServerConfig {
  const args = parseArgs(argv);
  const file = readConfigFile(args["config"] || "cherysis-server.config.json");
  const env = (name: string): string | undefined => process.env[name];

  const pick = (...vals: Array<string | undefined>): string => {
    for (const v of vals) {
      if (v !== undefined && v !== "") {
        return v;
      }
    }
    return "";
  };

  const storageDir = path.resolve(
    pick(args["storage-dir"], env("CHERYSIS_STORAGE_DIR"), file["storageDir"], DEFAULT_STORAGE),
  );
  const imageDirRaw = pick(args["image-dir"], env("CHERYSIS_IMAGE_DIR"), file["imageDir"]);
  const imageDir = imageDirRaw ? path.resolve(imageDirRaw) : "";
  const localBase = pick(
    args["cache-dir"],
    env("CHERYSIS_CACHE_DIR"),
    file["cacheDir"],
    path.join(process.env.LOCALAPPDATA || os.tmpdir(), "cherysis-server"),
  );
  const cacheDir = path.resolve(localBase);
  const liveOutDir = path.resolve(
    pick(args["live-out-dir"], env("CHERYSIS_LIVE_OUT_DIR"), file["liveOutDir"], path.join(cacheDir, "out")),
  );

  const portRaw = pick(args["port"], env("CHERYSIS_PORT"), file["port"], "13800");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口不合法：${portRaw}`);
  }

  return {
    storageDir,
    imageDir,
    cacheDir,
    liveOutDir,
    prefsFile: path.join(cacheDir, "server-prefs.json"),
    host: pick(args["host"], env("CHERYSIS_HOST"), file["host"], "0.0.0.0"),
    port,
    token: pick(args["token"], env("CHERYSIS_TOKEN"), file["token"]),
    publicDir: path.join(__dirname, "..", "..", "src", "webview", "mobile"),
  };
}

/** 给「手机连不上」时看的一行信息：把所有网卡的 IPv4 列出来，方便直接照着敲 */
export function lanUrls(port: number): string[] {
  const out: string[] = [];
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) {
        out.push(`http://${ni.address}:${port}`);
      }
    }
  }
  return out;
}
