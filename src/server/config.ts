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
  /**
   * 外网访问的密码。**只拦从隧道进来的请求**，局域网与本机不受影响。
   * 空串 = 不设门禁（谁拿到链接谁能改库，只在完全信任的环境里这样用）。
   * 改了密码，所有人之前的 cookie 立刻失效（签名密钥是从密码派生的）。
   */
  password: string;
  /**
   * 要不要开「外网访问」（cloudflared 快速隧道）。
   * 默认开：外面的人拿一个 https 地址就能开，不用装东西。
   * 想关：配置里写 `tunnel: false`，或 `--tunnel=0`，或环境变量 `CHERYSIS_TUNNEL=0`。
   * ⚠️ 开了等于把库暴露到公网（现在没有门禁），只在需要时开。
   */
  tunnel: boolean;
  /**
   * 内网 https 端口（方案 B，2026-10-19）：自签证书 + 另开一个端口，手机在这个端口上
   * 浏览器才肯给摄像头（扫码）。667 的 http **原样保留**，其他功能不受影响。
   * 0 = 关掉。默认 668。
   */
  httpsPort: number;
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

  // 外网访问默认开（他要的是"不用每次找人问地址"）；三种关法都认
  const tunnelRaw = pick(args["tunnel"], env("CHERYSIS_TUNNEL"), file["tunnel"], "1").toLowerCase();
  const tunnelOn = !["0", "false", "off", "no"].includes(tunnelRaw);

  // 内网 https 端口：默认 668（方案 B）；写 0 / --https-port=0 关掉
  const httpsPortRaw = pick(args["https-port"], env("CHERYSIS_HTTPS_PORT"), file["httpsPort"], "668");
  const httpsPort = Number(httpsPortRaw);
  if (!Number.isInteger(httpsPort) || httpsPort < 0 || httpsPort > 65535) {
    throw new Error(`https 端口不合法：${httpsPortRaw}`);
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
    password: pick(args["password"], env("CHERYSIS_PASSWORD"), file["password"]),
    tunnel: tunnelOn,
    httpsPort,
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
        // 169.254.x.x = APIPA：网卡**没拿到 DHCP 地址**时的自分配地址，只有本机自己能用，
        // 手机/别的电脑都连不上。典型来源：没插网线的有线网卡、装了却没连上的虚拟网卡
        // （各种 VPN / 虚拟机工具都会建一块）—— 打出来只会让人拿着一个连不通的地址去试
        // （2026-10-17 老板："那个169感觉没啥用，是不是可以删了"）。
        // 网卡真连上之后这里会变成它真正的地址，那时照常打印。
        if (ni.address.startsWith("169.254.")) {
          continue;
        }
        out.push(`http://${ni.address}:${port}`);
      }
    }
  }
  return out;
}
