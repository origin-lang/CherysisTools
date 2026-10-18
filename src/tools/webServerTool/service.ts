/**
 * 网页版服务的本地「生命周期」：探活、启停、开机自启、配置文件读写。
 *
 * 这一层刻意不 import vscode —— 它只跟操作系统打交道，这样服务端将来复用同一份
 * 口径时不会拖进 VS Code；启停里真正需要宿主的两件事（开终端、写剪贴板）留在 index.ts。
 *
 * 所有操作都围绕**扩展目录里那份** cherysis-server.config.json（就是双击「启动网页版.cmd」
 * 时读的那份）：cmd 里是 cd /d "%~dp0"，所以「双击哪一层的 cmd 就用哪一层的配置」，
 * 面板里的按钮沿用同一条规则，别另立一个默认路径 —— 两份配置各有各的数据，指错就是对着空库录数据。
 */
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

/** autostart.ps1 里注册的那个计划任务名，两边必须同一个字符串 */
export const SERVER_TASK_NAME = "CherysisWebServer";

export const DEFAULT_PORT = 666;

export interface ServerConfig {
  storageDir?: string;
  imageDir?: string;
  cacheDir?: string;
  port?: string | number;
  host?: string;
  token?: string;
  [k: string]: unknown;
}

export function serverConfigPath(extDir: string): string {
  return path.join(extDir, "cherysis-server.config.json");
}

/** 读配置：去 BOM（记事本「另存为 UTF-8」会写 BOM，JSON.parse 会因此报错） */
export function readServerConfig(p: string): ServerConfig | null {
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, "")) as ServerConfig;
  } catch {
    // 内容坏掉时交给调用方去提示，这里不猜着返回 {} —— 那会让人对着一份没读出来的配置改半天
    return null;
  }
}

/** 写配置：不带 BOM，缩进 2 空格，末尾换行 */
export function writeServerConfig(p: string, cfg: ServerConfig): void {
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

/**
 * 本机缓存的默认位置：%LOCALAPPDATA%\cherysis-server。
 *
 * 跟 src/server/config.ts 里 loadConfig 的兜底一模一样（那边 pick 到最后一级就是这个），
 * 两边必须同口径 —— 自动生成配置时写的就是这个，别在这儿另立一个默认。
 */
export function defaultCacheDir(): string {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "cherysis-server");
}

/**
 * 一份「最小可用」的网页版配置：只写面板那三项 + 端口。
 *
 * 每一项"不写"都是有意的，全都是"服务端自己有默认值"的字段，多写一份就等于把两份实现
 * 钉死在两处，改了一处忘另一处就是手机连不上 / 九宫格跑到别处去：
 *
 * · host（0.0.0.0）、liveOutDir（cacheDir/out）—— src/server/config.ts 的 loadConfig 自己有默认。
 * · cacheDir —— **最不能写死的一项**。%LOCALAPPDATA% 是"跑服务那台机器的当前用户"，
 *   一旦把 `C:\Users\<某个人>\…` 写进配置，这份文件拷到第二台机器上就会指向一个不存在的目录，
 *   表现是缩略图缓存每次重建、prefs 重置、九宫格 out 错位 —— 不报错，但绕很久。
 *   留空则 loadConfig 自己兜底成本机默认，换机器、换用户名天然都对。
 *   （面板在 cacheDir 空时会显示那条默认值，看得见就不算盲填。）
 */
export function buildDefaultConfig(storageDir: string, imageDir = ""): ServerConfig {
  const cfg: ServerConfig = {
    storageDir: String(storageDir || "").trim(),
    imageDir: String(imageDir || "").trim(),
    port: DEFAULT_PORT,
    // 2026-10-18：`password` 和 `tunnel` 这两项**必须显式写出来给空/默认值**，
    // 不是为了功能（loadConfig 本来就有默认），是为了**让人看得见它存在**。
    // 老板把服务交给别人用时发现"别人那边没有密码"：他手里那份是自己手写的配置，
    // 有 password 那一行；同事那边是自动生成的 —— 只有三项，压根不知道还有密码这回事，
    // 于是开了外网隧道、门禁是空的。JSON 里加注释不合法，所以注释只能靠 `//xxx` 这种键
    // （服务端 readConfigFile 会把它当普通键读进去、没人用，无害；示例文件里一直是这么写的）。
    password: "",
    tunnel: true,
    "//password":
      "外网密码。留空 = 不开门禁（谁拿到隧道链接谁就能改库）；填了只拦从 Cloudflare 隧道进来的请求，" +
      "同一局域网扫码/输 IP 进来的不弹密码。改完要重启服务才生效；启动窗口会打成「🔒 密码：xxx」",
  };
  return cfg;
}

export function portOf(cfg: ServerConfig | null): number {
  const v = Number((cfg && cfg.port) ?? DEFAULT_PORT);
  return Number.isFinite(v) && v > 0 && v < 65536 ? v : DEFAULT_PORT;
}

/** 端口有没有东西在听（本机回环探一下就够，不关心是谁） */
export function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(800);
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}

/**
 * 这台机器在局域网里的可用 IPv4（给「手机访问地址」用）。
 * 排除回环、链路本地（169.254，没拿到 DHCP 时才会有的那个）和 0.0.0.0。
 */
export function localIps(): string[] {
  const out: string[] = [];
  const nis = os.networkInterfaces();
  for (const name of Object.keys(nis)) {
    for (const a of nis[name] || []) {
      if (a.family !== "IPv4" || a.internal) {continue;}
      const ip = a.address;
      if (ip.startsWith("127.") || ip.startsWith("169.254.")) {continue;}
      out.push(ip);
    }
  }
  // 常用的私有网段排前面：手机连的是办公室 Wi-Fi，命中率最高
  const rank = (ip: string): number => {
    if (ip.startsWith("192.168.")) {return 0;}
    if (ip.startsWith("10.")) {return 1;}
    const m = /^172\.(1[6-9]|2\d|3[01])\./.exec(ip);
    return m ? 2 : 3;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

/** 挑一个「手机大概率连得上」的地址：192.168 优先，实在没有就退第一个 */
export function lanIp(): string {
  const ips = localIps();
  if (ips.length === 0) {
    // 连着 VPN/只有一块虚拟网卡时常见：退到 127.0.0.1，至少让用户看到该去哪查
    return "127.0.0.1";
  }
  return ips[0];
}

export interface StopResult {
  ok: boolean;
  detail: string;
}

/**
 * 停掉监听某个端口的那个进程。
 *
 * 为什么不能 `taskkill /IM node.exe /F`：VS Code 自己的扩展宿主就是 node.exe，
 * 这么一下整个编辑器一起崩。所以必须**先按端口定位 PID**，再核对进程名是 node 才允许杀。
 */
export function stopPort(port: number): StopResult {
  const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf-8" });
  const stdout = netstat.stdout || "";
  let pid = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && Number(m[2]) === port) {
      pid = Number(m[3]);
      break;
    }
  }
  if (!pid) {
    return { ok: true, detail: `没有进程在监听 ${port}，本来就没跑着。` };
  }
  const tl = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf-8",
  });
  const name = /"([^"]+)"/.exec(tl.stdout || "")?.[1] || "";
  if (name && !/^node\.exe$/i.test(name)) {
    return { ok: false, detail: `:${port} 被 ${name}（PID ${pid}）占着，不是本服务，我没动它。` };
  }
  const kill = spawnSync("taskkill", ["/F", "/PID", String(pid)], { encoding: "utf-8" });
  const killed = kill.stdout || "";
  if (!/SUCCESS/i.test(killed)) {
    return { ok: false, detail: `杀不掉 PID ${pid}：${(kill.stderr || killed).trim() || "未知原因"}` };
  }
  return { ok: true, detail: `已停止（PID ${pid}）。` };
}

/**
 * 开机自启设没设（查计划任务）。
 *
 * 刻意用 schtasks 而不是 powershell -Command：前者是原生 exe，起得快（毫秒级，
 * 面板每 5 秒轮询一次状态，每次都拉起 powershell 太重），也不会被 PowerShell
 * 执行策略 / 公司镜像的策略挡一下。autostart.ps1 建出来的任务 schtasks 查得到，
 * 口径一致。
 */
export function autostartStatus(): { on: boolean; detail: string } {
  const r = spawnSync("schtasks", ["/query", "/tn", SERVER_TASK_NAME], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    return { on: false, detail: "查不到计划任务（可能没设过，或本机没有 schtasks）" };
  }
  const lines = (r.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes(SERVER_TASK_NAME));
  return { on: true, detail: lines.join(" ") || "已设置（登录时自动起）" };
}

/** 装 / 卸开机自启；脚本自己会把报错原因打全，这里原样透出 */
export function runAutostart(extDir: string, on: boolean): { ok: boolean; detail: string } {
  const ps1 = path.join(extDir, "scripts", "autostart.ps1");
  if (!fs.existsSync(ps1)) {
    return { ok: false, detail: `找不到脚本：${ps1}` };
  }
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, on ? "install" : "remove"],
    { cwd: extDir, encoding: "utf-8" },
  );
  const detail = `${(r.stdout || "").trim()}\n${(r.stderr || "").trim()}`.trim();
  return { ok: r.status === 0, detail: detail || "(无输出)" };
}

/** 服务是否已经能连上 + 该把哪个地址给用户 */
export interface ServerStatus {
  port: number;
  running: boolean;
  autostart: boolean;
  configPath: string;
  configOk: boolean;
  configError?: string;
  cfg: ServerConfig | null;
  ip: string;
  /** 外网访问的状态（服务没跑 / 没开隧道时为 null） */
  tunnel?: TunnelBrief | null;
}

/** 外网地址那点信息：面板只需要"能不能给地址、给的哪个、为什么没有" */
export interface TunnelBrief {
  state: "off" | "starting" | "up" | "error";
  url: string;
  error: string;
}

/**
 * 去问正在跑的服务：外网地址拿到没有。
 *
 * 为什么不直接读文件/自己起隧道：地址由**服务进程**从 cloudflared 的输出里抓，
 * 只有它知道当前这一个是哪个；面板再去猜就会出现"面板显示的和真的不一样"。
 * 服务没跑 / 没开隧道时返回 null，面板就那行不显示。
 */
export function pingTunnel(port: number, token: string): Promise<TunnelBrief | null> {
  return new Promise((resolve) => {
    if (!port) {
      resolve(null);
      return;
    }
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/ping",
        timeout: 1500,
        headers: token ? { "x-cherysis-token": token } : {},
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buf += c;
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            const t = j && j.tunnel;
            if (!t) {
              resolve(null);
              return;
            }
            resolve({
              state: t.state === "up" || t.state === "starting" || t.state === "error" ? t.state : "off",
              url: typeof t.url === "string" ? t.url : "",
              error: typeof t.error === "string" ? t.error : "",
            });
          } catch {
            resolve(null); // 回的不是 JSON（多半是别的程序占着端口）
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

export function serverStatus(extDir: string): ServerStatus {
  const cfgPath = serverConfigPath(extDir);
  const cfg = readServerConfig(cfgPath);
  const port = portOf(cfg);
  const autostart = autostartStatus();
  return {
    port,
    running: false, // 异步探活在调用处填，这里先给个占位避免面板显示成"没跑"
    autostart: autostart.on,
    configPath: cfgPath,
    configOk: !!cfg,
    configError: cfg ? undefined : fs.existsSync(cfgPath) ? "不是合法 JSON" : undefined,
    cfg,
    ip: lanIp(),
  };
}

/** 组装给面板的完整状态（探活是异步的，放这里收口，面板就不用自己拼） */
export async function serverStatusAsync(extDir: string): Promise<ServerStatus & { running: boolean }> {
  const s = serverStatus(extDir);
  s.running = await portInUse(s.port);
  // 只有服务真在跑才问隧道：没跑时这一问必然超时，白等 1.5 秒
  s.tunnel = s.running ? await pingTunnel(s.port, s.cfg?.token || "") : null;
  return s;
}

export function serverUrl(cfg: ServerConfig | null): string {
  return `http://${lanIp()}:${portOf(cfg)}`;
}

/**
 * 路径比对用的归一化：Windows 上 `z:\data` / `z:/data` / `Z:\data\` / 尾斜杠都指同一处，
 * 直接字符串比会把「明明是同一个目录」判成不一致，然后让人对着两行长得很路径改半天。
 */
export function normPathKey(p: unknown): string {
  return String(p ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** 一行「两边对一对」的结果 */
export interface ConfigSyncRow {
  key: "storageDir" | "imageDir" | "cacheDir";
  label: string;
  /** VS Code 里那一项填的值；null = 这项在 VS Code 里根本没有对应设置（只能比网页版一边） */
  vscode: string | null;
  /** 网页版配置里填的值（还没配就是空串） */
  server: string;
  /** same=一致；diff=不一致；empty=有一边没填；na=没有可比项 */
  status: "same" | "diff" | "empty" | "na";
}

/**
 * 把「网页版配置」和「VS Code 设置」摆到一行行比。
 *
 * 为什么要比：这两边**各存各的、互不相读**（网页服务端压根不读 VS Code 的设置），
 * 在 VS Code 里改了图片目录网页版不会跟着变 —— 界面上不摆出来，用户只会看到手机上图片全挂，
 * 然后花半天怀疑是共享盘 / 缓存的问题。
 */
export function configSyncRows(
  vscodePaths: { storageDir?: string; imageDir?: string },
  cfg: ServerConfig | null,
): ConfigSyncRow[] {
  const ofCfg = (k: string): string => String((cfg && cfg[k]) ?? "").trim();
  const row = (
    key: ConfigSyncRow["key"],
    label: string,
    vscode: string | null,
  ): ConfigSyncRow => {
    const server = ofCfg(key);
    let status: ConfigSyncRow["status"];
    if (vscode === null) {
      status = "na"; // 没有可比项，不算不一致
    } else if (!vscode || !server) {
      status = "empty"; // 一边空，比对不出来
    } else {
      status = normPathKey(vscode) === normPathKey(server) ? "same" : "diff";
    }
    return { key, label, vscode, server, status };
  };
  return [
    row("storageDir", "数据目录", (vscodePaths.storageDir || "").trim()),
    row("imageDir", "图片目录", (vscodePaths.imageDir || "").trim()),
    row("cacheDir", "本机缓存", null),
  ];
}
