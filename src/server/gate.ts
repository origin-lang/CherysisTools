import * as crypto from "crypto";
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
 * 3. **失败限速**（同一 IP 每分钟 10 次）。密码是日期+1997 这种东西，不挡爆破等于没设。
 */

export const GATE_COOKIE = "cherysis_gw";
/** 记多久（天）：他这行当，一个月不用重输就够 */
export const GATE_DAYS = 30;
/** 同一 IP 一分钟里最多试错几次 */
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 60_000;

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
const fails = new Map<string, { n: number; at: number }>();

export function tooManyFails(ip: string, now = Date.now()): boolean {
  const f = fails.get(ip);
  if (!f) {
    return false;
  }
  if (now - f.at > FAIL_WINDOW_MS) {
    fails.delete(ip);
    return false;
  }
  return f.n >= MAX_FAILS;
}

export function noteFail(ip: string, now = Date.now()): void {
  const f = fails.get(ip);
  if (!f || now - f.at > FAIL_WINDOW_MS) {
    fails.set(ip, { n: 1, at: now });
    return;
  }
  f.n += 1;
  // 顺手清一下过期条目，别让这个 Map 长成内存泄漏
  if (fails.size > 500) {
    for (const [k, v] of fails) {
      if (now - v.at > FAIL_WINDOW_MS) {
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
export function loginHtml(next: string): string {
  const n = safeNext(next).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
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
    <div id="err"></div>
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
