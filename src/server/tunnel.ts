import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * 外网访问（Cloudflare 快速隧道）——**独立常驻**版。
 *
 * 为什么要有这个文件：手机/外面的电脑想访问，得有一条从公网回到
 * `127.0.0.1:<port>` 的通道。cloudflared 的「quick tunnel」不用注册、不用域名、
 * 不花钱，起完就给一个 `https://xxx.trycloudflare.com`。但它的地址**每次新建隧道都会换**，
 * 所以必须由服务自己起、自己把地址交出来（打印 + /api/ping）。
 *
 * ⭐ 核心设计：隧道**脱钩**（detached + unref），不跟服务同生共死。
 * - 服务重启 / 被关掉 → 隧道继续跑 → **地址不变**，已经发出去的链接还能用；
 * - 服务再起来时先「接管」这条旧隧道，不重起（重起就换地址了）；
 * - 只有电脑重启、隧道真崩了，才会换地址。
 *
 * 代价（明知故犯的取舍）：
 * - 服务关了但隧道还在时，外面打开会得到 **502**（不是打不开）。这是脱钩的必然现象；
 * - 想真正关掉外网访问，要显式写 `tunnel: false` 再启动一次（那时会把遗留隧道杀掉）。
 *
 * ⚠️ 几条踩过的坑，改之前先看完：
 * 1. **二进制不能放在 `.workbuddy` 目录下跑**：Go 运行时读网卡列表时要 load
 *    `iphlpapi.dll`，那个目录被安全策略拦（`winapi error #5` 直接 panic）。
 *    放 `<cacheDir>/bin/` 或临时目录都正常。
 * 2. **别加 `--protocol http2`**：实测国内这个网络 QUIC 1.1~1.5s、http2 2.0s。
 * 3. 地址必须**从进程输出/日志里抓**，不能拼：quick tunnel 的域名是服务端分配的。
 * 4. 脱钩之后**不能再靠 stdout 拿地址**（父进程死了管道就断，cloudflared 会因写失败退出），
 *    所以必须 `--logfile` 让它自己写文件，服务从文件里读。这是脱钩能成立的前提。
 */

export type TunnelState = "off" | "starting" | "up" | "error";

export interface TunnelStatus {
  /** off = 没开；starting = 正在连；up = 有地址了；error = 起不来 */
  state: TunnelState;
  /** state=up 时才有值，形如 https://xxx.trycloudflare.com */
  url: string;
  /** 这次拿到地址的时间（毫秒时间戳） */
  since: number;
  /** 失败原因（给人看的整句，直接显示） */
  error: string;
  /** 自动重起的次数（排查"是不是一直在重启"） */
  restarts: number;
  /** 隧道进程号（0 = 还没起）。排查"它到底在不在"就看这个 */
  pid: number;
}

export interface TunnelOpts {
  port: number;
  /** 二进制、日志、接管信息（meta）的落点，用服务端的 cacheDir */
  cacheDir: string;
  /** 显式关掉（配置里写了 tunnel: false）就整个停掉，连遗留的隧道一起杀 */
  enabled?: boolean;
  /** 状态变了叫一声：横幅靠它打印地址，别在别处再轮询 */
  onChange?: (s: TunnelStatus) => void;
}

export interface TunnelHandle {
  status(): TunnelStatus;
  /** 真停（关外网访问）。⚠️ 服务正常退出时**不要**调它，见文件头的设计说明 */
  stop(): void;
}

/** 每隔多久看一眼隧道还活着没（第一次；失败后会逐步拉长） */
const WATCH_MS = 30000;
/** 退避的上限：再惨也就每 5 分钟试一次，不放弃 */
const SLOW_RETRY_MS = 5 * 60_000;
/** 起完之后多久去日志里找地址（cloudflared 一般 3~8 秒） */
const POLL_MS = 500;

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

/** 接管信息：有了它，服务重启后才能"接着用"同一条隧道（否则地址必换） */
interface TunnelMeta {
  pid: number;
  url: string;
  port: number;
  since: number;
}

export function cloudflaredPath(cacheDir: string): string {
  const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return path.join(cacheDir, "bin", name);
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = 进程在、只是没权限发信号（这里几乎不会出现，但别误判成"死了"）
    return err?.code === "EPERM";
  }
}

function killPid(pid: number): void {
  if (!pid || !isAlive(pid)) return;
  try {
    // Windows 上 child.kill() 对 cloudflared 未必干净，taskkill 带 /T 更稳
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* 杀不掉也别拦着启动 */
  }
}

function readMeta(fp: string): TunnelMeta | null {
  try {
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!j || typeof j.pid !== "number") return null;
    return {
      pid: j.pid,
      url: typeof j.url === "string" ? j.url : "",
      port: Number(j.port) || 0,
      since: Number(j.since) || 0,
    };
  } catch {
    return null; // 没有 / 坏掉 = 没有可接管的
  }
}

function writeMeta(fp: string, m: TunnelMeta): void {
  try {
    fs.writeFileSync(fp, JSON.stringify(m), "utf8");
  } catch {
    /* meta 写不了只影响"下次能不能接管"，不该拦住这次 */
  }
}

/** 从 cloudflared 自己写的日志里捞最后一个地址（日志是追加的，重启后可能有多条） */
function urlFromLog(fp: string): string {
  try {
    const all = fs.readFileSync(fp, "utf8").match(URL_RE);
    return all && all.length ? all[all.length - 1] : "";
  } catch {
    return "";
  }
}

export function startTunnel(opts: TunnelOpts): TunnelHandle {
  const st: TunnelStatus = { state: "off", url: "", since: 0, error: "", restarts: 0, pid: 0 };
  const bin = cloudflaredPath(opts.cacheDir);
  const logPath = path.join(opts.cacheDir, "tunnel.log");
  const metaPath = path.join(opts.cacheDir, "tunnel.meta.json");
  /** 老版本留的 pid 文件：升级后第一次启动要顺手清掉那个孤儿 */
  const legacyPidFile = path.join(opts.cacheDir, "tunnel.pid");

  let disposed = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let watchTimer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    try {
      opts.onChange?.({ ...st });
    } catch {
      /* 打印出问题不许影响隧道本身 */
    }
  };

  const setError = (msg: string): void => {
    st.state = "error";
    st.error = msg;
    st.url = "";
    fire();
  };

  const stopPoll = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  /** 彻底断开：杀进程 + 清 meta/log，下次一定起新的（也就是会换地址） */
  const killAll = (): void => {
    const m = readMeta(metaPath);
    if (m) killPid(m.pid);
    try {
      const old = parseInt(fs.readFileSync(legacyPidFile, "utf8").trim(), 10);
      killPid(old);
    } catch {
      /* 没有老文件 */
    }
    for (const fp of [metaPath, legacyPidFile, logPath]) {
      try {
        fs.unlinkSync(fp);
      } catch {
        /* 没有就算了 */
      }
    }
  };

  /**
   * 轮询日志，等 cloudflared 把地址写进去。
   *
   * ⚠️ **不许"等够 N 次就放弃"**：开机自启时网络往往还没就绪（Wi-Fi 认证、DHCP、
   * 映射盘 z: 要等登录后才出现），cloudflared 卡在握手上几十秒到两分钟是常事。
   * 早期版本 30 秒就 setError 收工，表现是「开机后外网打不开，非得手动重启一次服务」，
   * 而人根本不知道为什么。现在改成：进程还活着就一直等，30 秒时把提示换成"还在连"。
   */
  const waitForUrl = (pid: number): void => {
    stopPoll();
    const started = Date.now();
    let warned = false;
    pollTimer = setInterval(() => {
      if (disposed) {
        stopPoll();
        return;
      }
      const url = urlFromLog(logPath);
      if (url) {
        stopPoll();
        st.state = "up";
        st.url = url;
        st.since = Date.now();
        st.error = "";
        st.pid = pid;
        st.restarts = 0;
        writeMeta(metaPath, { pid, url, port: opts.port, since: st.since });
        fire();
        return;
      }
      if (!isAlive(pid)) {
        stopPoll();
        setError(`隧道进程没能起来（看 ${logPath}）`);
        return;
      }
      if (!warned && Date.now() - started > 30000) {
        warned = true;
        st.state = "starting";
        st.error = "还在连 Cloudflare…（刚开机或网络慢时会久一点，别管它）";
        fire();
      }
    }, POLL_MS);
  };

  const spawnTunnel = (): void => {
    if (disposed) return;
    st.state = "starting";
    st.url = "";
    st.error = "";
    fire();

    try {
      fs.unlinkSync(logPath); // 旧日志里有过期地址，别捞错了
    } catch {
      /* 没有就算了 */
    }

    try {
      const c = spawn(
        bin,
        ["tunnel", "--url", `http://127.0.0.1:${opts.port}`, "--no-autoupdate", "--logfile", logPath],
        {
          cwd: path.dirname(bin),
          detached: true, // 脱钩：服务死了它不走
          stdio: "ignore", // 输出走 --logfile，不要管道（管道断了它会跟着挂）
          windowsHide: true,
        },
      );
      const pid = c.pid || 0;
      c.unref(); // 别让它拖着事件循环
      if (!pid) {
        setError("起不来：拿不到进程号");
        return;
      }
      st.pid = pid;
      writeMeta(metaPath, { pid, url: "", port: opts.port, since: Date.now() });
      waitForUrl(pid);
    } catch (err: any) {
      setError(`起不来：${err?.message ?? err}`);
    }
  };

  /**
   * 看门人：只看它活着没。活着就一根手指都不碰它 —— 碰一下地址就换了。
   *
   * 间隔不是固定的：连续失败逐步拉长（30s → 60s → … → 最长 5 分钟），而且**永不放弃**。
   * 理由是开机那几分钟网络可能还没好；早早放弃就等于"开机后外网一直打不开，
   * 直到有人手动重启一次服务"。退避是为了别在二进制坏掉时每 30 秒狂起一个进程。
   */
  const startWatch = (): void => {
    if (watchTimer) return;
    let delay = WATCH_MS;
    const tick = (): void => {
      watchTimer = null;
      if (disposed) return;
      const m = readMeta(metaPath);
      const pid = m?.pid || 0;
      if (pid && isAlive(pid)) {
        st.restarts = 0;
        delay = WATCH_MS;
      } else {
        st.restarts += 1;
        delay = Math.min(WATCH_MS * st.restarts, SLOW_RETRY_MS);
        st.state = "starting";
        st.error = `隧道断了，${Math.round(delay / 1000)} 秒后重连（第 ${st.restarts} 次）`;
        fire();
        spawnTunnel();
      }
      watchTimer = setTimeout(tick, delay);
    };
    watchTimer = setTimeout(tick, delay);
  };

  const stopAll = (): void => {
    disposed = true;
    stopPoll();
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    killAll();
    st.state = "off";
    st.url = "";
    st.pid = 0;
  };

  // ---------------------------------------------------------------- 启动
  if (opts.enabled === false) {
    killAll();
    st.state = "off";
    st.error = "配置里关掉了（tunnel: false）";
    return { status: () => ({ ...st }), stop: () => void 0 };
  }

  if (!fs.existsSync(bin)) {
    setError(`没找到 ${bin}（把 cloudflared 放到这里，或配 tunnel: false 关掉外网访问）`);
    return { status: () => ({ ...st }), stop: () => void 0 };
  }

  // 1) 先看能不能接管上一次那条隧道 —— 能接管就不重起，地址保持不变
  const meta = readMeta(metaPath);
  if (meta && meta.port === opts.port && isAlive(meta.pid)) {
    st.pid = meta.pid;
    st.since = meta.since || Date.now();
    const url = meta.url || urlFromLog(logPath);
    if (url) {
      st.state = "up";
      st.url = url;
      fire();
    } else {
      st.state = "starting";
      fire();
      waitForUrl(meta.pid); // 上次刚起、地址还没写进日志就被打断了：接着等
    }
    startWatch();
    return { status: () => ({ ...st }), stop: stopAll };
  }

  // 2) 接管不了（没跑 / 端口变了 / 进程死了）→ 清干净再起一条新的
  killAll();
  spawnTunnel();
  startWatch();

  return { status: () => ({ ...st }), stop: stopAll };
}
