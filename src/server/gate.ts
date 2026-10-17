import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage } from "http";

/**
 * 外网访问的密码门（2026-10-17）。
 *
 * 为什么要有：隧道一开，谁拿到链接谁就能改库。老板要的不是账号体系，一个密码就够
 * （邮箱验证码那套他明确嫌麻烦）。
 *
 * ⭐ 三个刻意的设计：
 *
 * 1. **只拦从隧道进来的请求**（有 Cloudflare 的 `cf-connecting-ip` / `cf-ray` 头）。
 *    局域网、本机一律放行 —— 你在家/在店里打开不该被拦，弹密码纯属添堵。
 *    ⚠️ 不能靠 `remoteAddress` 判断：请求是 cloudflared 在本机转发的，源地址永远是 127.0.0.1，
 *    按 IP 判会把所有外网来客都当成本机。
 *
 * 2. **Cookie 里存的不是密码**，是「过期时间 + HMAC 签名」。密钥由密码派生：
 *    `sha256("cherysis-gw|" + password)`。好处是改密码以后，所有老 cookie 立刻失效，
 *    不用维护 session 表；服务重启也不会把大家踢下线。
 *
 * 3. **失败限速**（同一 IP 5 分钟里错 10 次，就关 24 小时小黑屋）。密码是日期+1997 这种东西，
 *    不挡爆破等于没设。锁计时**从最后一次试错起算**，不是从第一次 —— 不然慢慢试的人
 *    （4 分钟才凑够 10 次）只需要再等 1 分钟就放出来了，等于没锁。
 *    锁记录**落盘**（`<cacheDir>/gate-locks.json`）：24 小时的锁被"重启一下服务"破解就没意义了。
 *    要放人进来只有一条路：在**局域网**里点「解除」（外网来的请求一律不许解，否则等于没锁）。
 */

export const GATE_COOKIE = "cherysis_gw";
/** 记多久（天）：他这行当，一个月不用重输就够 */
export const GATE_DAYS = 30;
/** 同一 IP 在窗口里最多试错几次 */
export const MAX_FAILS = 10;
/** 计数窗口：5 分钟内的错才算"连着错" */
export const FAIL_WINDOW_MS = 5 * 60_000;
/** 撞线以后关多久（从最后一次试错起算）。他说自己人不可能错 10 次，所以关满一天 */
export const LOCK_MS = 24 * 60 * 60_000;

/** 这次请求是不是从 Cloudflare 隧道进来的（= 外网） */
export function isFromTunnel(req: IncomingMessage): boolean {
  return !!(req.headers["cf-connecting-ip"] || req.headers["cf-ray"]);
}

function secretOf(password: string): Buffer {
  return crypto.createHash("sha256").update("cherysis-gw|" + password).digest();
}

/** 生成一张票：`<过期毫秒>.<base64url 签名>` */
export function makeTicket(password: string, expires: number): string {
  const sig = crypto
    .createHmac("sha256", secretOf(password))
    .update(String(expires))
    .digest("base64url");
  return `${expires}.${sig}`;
}

/** 验票：格式对 + 没过期 + 签名对（签名用定长比较，别给时序留缝） */
export function checkTicket(password: string, ticket: string, now = Date.now()): boolean {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,})$/.exec(ticket || "");
  if (!m) {
    return false;
  }
  const expires = Number(m[1]);
  if (!Number.isFinite(expires) || expires < now) {
    return false;
  }
  const want = makeTicket(password, expires);
  const a = Buffer.from(ticket);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function readCookie(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    if (part.slice(0, eq).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

export function ticketCookie(password: string, now = Date.now()): string {
  const expires = now + GATE_DAYS * 86400_000;
  // Secure 只在 https 下有效 —— 隧道就是 https，所以照写；
  // 万一以后有人用 http 直连（不会有），浏览器丢掉这个 cookie 也不会出事，只是要重登。
  return `${GATE_COOKIE}=${makeTicket(password, expires)}; Path=/; Max-Age=${GATE_DAYS * 86400}; HttpOnly; SameSite=Lax; Secure`;
}

// ---------------------------------------------------------------- 失败限速
// 记录形状：{ n 窗口里错了几次, first 窗口起点, last 最后一次错的时刻 }
// 窗口过期（first 太老）→ 重开一个窗口；撞线以后按 last 起算关 LOCK_MS。
interface FailRec {
  n: number;
  first: number;
  last: number;
}
const fails = new Map<string, FailRec>();

/** 落盘路径（`<cacheDir>/gate-locks.json`）；空 = 不落盘（单元测试里就这样） */
let storePath = "";

/**
 * 从磁盘恢复封禁记录 —— 服务重启**不清零**。
 * 24 小时的锁如果能靠"把服务重启一次"破解，那这道锁就是摆设。
 * 文件坏了/没有 → 当没封过人，别让一个坏文件把服务卡死。
 */
export function loadLocks(file: string): number {
  storePath = file;
  let raw: Record<string, FailRec> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, FailRec>;
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const [ip, v] of Object.entries(raw || {})) {
    if (!v || !Number.isFinite(v.n) || !Number.isFinite(v.first) || !Number.isFinite(v.last)) {
      continue;
    }
    const dead = v.n >= MAX_FAILS ? now - v.last >= LOCK_MS : now - v.first > FAIL_WINDOW_MS;
    if (!dead) {
      fails.set(ip, { n: v.n, first: v.first, last: v.last });
    }
  }
  return fails.size;
}

function persist(): void {
  if (!storePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(Object.fromEntries(fails)), "utf8");
  } catch {
    /* 写不进去就算了：内存里那份还是准的，重启顶多多给几次机会 */
  }
}

/** 还要关多少毫秒；0 = 没关着。登录页/接口都靠它算"还有几分钟" */
export function lockLeftMs(ip: string, now = Date.now()): number {
  const f = fails.get(ip);
  if (!f) {
    return 0;
  }
  if (f.n >= MAX_FAILS) {
    const left = f.last + LOCK_MS - now;
    if (left > 0) {
      return left;
    }
    // 关满了：清掉，给他重新试的机会
    fails.delete(ip);
    return 0;
  }
  if (now - f.first > FAIL_WINDOW_MS) {
    fails.delete(ip);
  }
  return 0;
}

export interface LockInfo {
  ip: string;
  leftMs: number;
  fails: number;
  at: number;
}

/** 当前被封的 IP（后台/局域网里那个「解除」列表就靠它） */
export function listLocks(now = Date.now()): LockInfo[] {
  const out: LockInfo[] = [];
  for (const [ip, f] of fails) {
    const left = lockLeftMs(ip, now);
    if (left > 0) {
      out.push({ ip, leftMs: left, fails: f.n, at: f.last });
    }
  }
  return out.sort((a, b) => b.leftMs - a.leftMs);
}

/** 放一个人进来（只能从后台/局域网触发）；没这个人就返回 false */
export function unlockIp(ip: string): boolean {
  const had = fails.delete(ip);
  if (had) {
    persist();
  }
  return had;
}

/** 全放（换密码、或者自己把自己锁了的时候用）；返回放了几个 */
export function unlockAll(): number {
  const n = fails.size;
  fails.clear();
  if (n) {
    persist();
  }
  return n;
}

export function tooManyFails(ip: string, now = Date.now()): boolean {
  return lockLeftMs(ip, now) > 0;
}

/** 给用户看的一句话（别把毫秒数糊到他脸上）；够一小时就说小时 */
export function lockText(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min >= 60) {
    return `试太多次了，${Math.ceil(min / 60)} 小时后再来`;
  }
  return `试太多次了，${min} 分钟后再来`;
}

export function noteFail(ip: string, now = Date.now()): void {
  const f = fails.get(ip);
  const stale = !f || now - f.first > FAIL_WINDOW_MS || (f.n >= MAX_FAILS && now - f.last >= LOCK_MS);
  if (stale) {
    fails.set(ip, { n: 1, first: now, last: now });
  } else {
    f.n += 1;
    f.last = now;
  }
  // 只在"刚撞线"那一刻落盘：前面几次错了就算重启丢了也无所谓（顶多多试几次），
  // 但**锁一旦成立就必须活过重启**，否则重启一次就白锁了。
  if (fails.get(ip)!.n === MAX_FAILS) {
    persist();
  }
  // 顺手清一下过期条目，别让这个 Map 长成内存泄漏
  if (fails.size > 500) {
    for (const [k, v] of fails) {
      if (now - v.last > FAIL_WINDOW_MS + LOCK_MS) {
        fails.delete(k);
      }
    }
  }
}

export function noteOk(ip: string): void {
  fails.delete(ip);
}

/** 登录后跳回哪儿：只认站内路径，`//evil.com` 这种一律退回首页（防开放重定向） */
export function safeNext(v: unknown): string {
  const s = String(v ?? "");
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) {
    return "/";
  }
  return s;
}

/**
 * 登录页。
 *
 * 刻意内联在这（不放 `src/webview/mobile/`）：门禁要放行它，静态目录里的文件
 * 还得单独列一条白名单；内联进去就只有一个 `/login` 入口，少一处漏配的机会。
 * 手机优先：输入框 16px（iOS 小了会整页放大）、大按钮、错误红字。
 */
export function loginHtml(next: string, notice = ""): string {
  const n = safeNext(next).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  // 已经被关小黑屋的，进来就先告诉他还要等几分钟（省得他在那儿一直点）
  const msg = String(notice || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>输入密码</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f4f5f7; color: #1f2328;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 360px; background: #fff; border-radius: 14px;
    padding: 28px 22px; box-shadow: 0 2px 14px rgba(0,0,0,.07);
  }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p.sub { font-size: 13px; color: #6b7280; margin: 0 0 20px; line-height: 1.6; }
  input {
    width: 100%; height: 46px; font-size: 16px; padding: 0 14px;
    border: 1px solid #d7dbe0; border-radius: 10px; background: #fff; color: #1f2328;
  }
  input:focus { outline: none; border-color: #23a884; }
  button {
    width: 100%; height: 46px; margin-top: 14px; font-size: 15px; font-weight: 600;
    border: 0; border-radius: 10px; background: #23a884; color: #fff;
  }
  button:active { background: #1c8d6e; }
  #err { min-height: 18px; margin-top: 10px; font-size: 13px; color: #d14343; }
</style>
</head>
<body>
  <div class="card">
    <h1>克里希斯 · 商品工具</h1>
    <p class="sub">这是外部访问，需要密码。登录一次记 30 天。</p>
    <form method="post" action="/api/login">
      <input id="pw" name="password" type="password" inputmode="numeric"
             autocomplete="current-password" placeholder="密码" required autofocus />
      <button type="submit">进入</button>
    </form>
    <div id="err">${msg}</div>
  </div>
<script>
(function () {
  var form = document.querySelector("form");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var err = document.getElementById("err");
    err.textContent = "";
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("pw").value })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) { location.replace(${JSON.stringify(n)}); return; }
        err.textContent = j.error || "密码不对";
      });
    }).catch(function () {
      err.textContent = "连不上，检查网络";
    });
  });
})();
</script>
</body>
</html>`;
}
