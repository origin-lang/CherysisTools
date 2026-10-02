// 手机版「接线」核对：两件在真机上才暴露、而且都不报错的事。
//
// ① DOM id：app.js 里 `$("xxx")` 用到的每个 id，必须在 index.html 里真的存在。
//    前端三件套是静态直出、不编译也不打包：改 HTML 时把 id 改了名、或者 app.js 里手滑写错
//    一个字母，**不会报任何错** —— 表现是"这个按钮点了没反应"。
// ② SSE 事件名：服务端发的事件名与前端监听的事件名必须完全对上。写错一个字母（"change" vs
//    "changed"）同样是静默失效 —— 界面上那个「有改动」永远不亮，而日志里什么都没有。
//
// 用法：node scripts/check-mobile-wiring.cjs
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const mobileDir = path.join(root, "src", "webview", "mobile");
const serverDir = path.join(root, "src", "server");
const jsFile = path.join(mobileDir, "app.js");
const htmlFile = path.join(mobileDir, "index.html");

/** JS 动态创建、HTML 里本来就没有的 id */
const DYNAMIC_IDS = new Set(["codeQ", "fsInput"]);

/**
 * 服务端能发的事件名（唯一出处：events.ts 的 HubEvent 注释 + index.ts 的 publish 调用 +
 * httpHost.ts 的 sinkPost/sinkLog）。逐个都要能在 src/server 里找到，防止这里凭记忆写。
 */
const SERVER_EVENTS = ["post", "log", "changed", "reset", "queue"];

/** EventSource 自带的事件（浏览器发的，不是服务端发的）：别当成"拼错了" */
const BROWSER_EVENTS = new Set(["open", "error", "message"]);

const fails = [];
const js = fs.readFileSync(jsFile, "utf8");
const html = fs.readFileSync(htmlFile, "utf8");
const serverSrc = fs
  .readdirSync(serverDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => fs.readFileSync(path.join(serverDir, f), "utf8"))
  .join("\n");

// ---------- ① DOM id ----------
const used = new Set();
for (const m of js.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) {
  used.add(m[1]);
}
const have = new Set();
for (const m of html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)) {
  have.add(m[1]);
}
if (used.size < 20) {
  fails.push(`app.js 里只认出 ${used.size} 个 $("...")（正常应有 80 多个）：写法变了？这条闸门就失效了`);
}
for (const id of [...used].filter((i) => !have.has(i) && !DYNAMIC_IDS.has(i)).sort()) {
  fails.push(`app.js 用了 $("#${id}")，但 index.html 里没有 id="${id}" —— 点了没反应就是这么来的`);
}

// ---------- ② SSE 事件名 ----------
for (const name of SERVER_EVENTS) {
  if (!new RegExp(`"${name}"`).test(serverSrc)) {
    fails.push(`服务端源码里找不到事件名 "${name}"：清单该更新了（别凭记忆写在这里）`);
  }
  if (!js.includes(`addEventListener("${name}"`)) {
    fails.push(`app.js 没有监听 SSE 的 "${name}" 事件 —— 服务端发了没人接，等于没做`);
  }
}
// 反向：前端监听了服务端根本不会发的名字（十有八九是拼错）
const listened = new Set();
for (const m of js.matchAll(/es\.addEventListener\("([A-Za-z0-9_-]+)"/g)) {
  listened.add(m[1]);
}
for (const name of [...listened]) {
  if (!SERVER_EVENTS.includes(name) && !BROWSER_EVENTS.has(name)) {
    fails.push(`app.js 监听了 SSE 的 "${name}"，但服务端不会发这个事件（拼错了？）`);
  }
}
// 也不许漏接：服务端会发的几个，前端必须都接着（漏一个就少一块功能）
for (const name of SERVER_EVENTS) {
  if (!listened.has(name)) {
    fails.push(`服务端会发 "${name}"，但 app.js 里搜不到对应的监听`);
  }
}

// ---------- ③ 宽屏抽屉的断点：JS 与 CSS 必须用同一个宽度 ----------
// JS 里 isWide() 决定"进不进抽屉模式"（要不要把列表留着、给 body 加 drawer 类），
// CSS 里 @media 决定"抽屉长什么样"。两边写岔了就是一个**半坏**的界面：
// JS 以为进了抽屉（列表留着），CSS 没生效（详情还是整屏盖上去）→ 列表白留在下面。
const css = fs.readFileSync(path.join(mobileDir, "style.css"), "utf8");
const jsBreak = /function isWide\(\)[\s\S]{0,220}?min-width:\s*(\d+)px/.exec(js);
const cssBreak = /@media \(min-width:\s*(\d+)px\)\s*\{\s*:root\s*\{\s*\/\*[^*]*\*\/\s*--drawer/.exec(css);
if (!jsBreak) {
  fails.push("app.js 的 isWide() 里找不到断点宽度（写法变了？这条闸门就失效了）");
} else if (!cssBreak) {
  fails.push("style.css 里找不到定义 --drawer 的那个 @media 断点（抽屉样式被改名/挪走了？）");
} else if (jsBreak[1] !== cssBreak[1]) {
  fails.push(
    `抽屉断点两边不一致：app.js 用 ${jsBreak[1]}px，style.css 用 ${cssBreak[1]}px —— 会得到一个半坏的界面`,
  );
}
if (jsBreak && cssBreak && jsBreak[1] === cssBreak[1]) {
  for (const need of ["body.drawer #screen-list", "body.drawer #status", "body.drawer #toast"]) {
    if (!css.includes(need)) {
      fails.push(`style.css 里缺少 "${need}"：抽屉会盖住那一块（分页按钮/状态条/提示浮层）`);
    }
  }
  // 抽屉样式必须**同时**覆盖详情与新建两屏：JS 的 keepList 里两个都有，
  // CSS 少一个就是"列表留在下面、面板整屏盖上去"的半坏界面
  if (!/#screen-detail,\s*#screen-new\s*\{/.test(css)) {
    fails.push("style.css 的抽屉规则里应同时有 #screen-detail 与 #screen-new（两屏都要走抽屉）");
  }
  if (!/id === "screen-detail" \|\| id === "screen-new"/.test(js.replace(/\s+/g, " "))) {
    fails.push("app.js 的 keepList 里应同时包含 screen-detail 与 screen-new（两屏都要走抽屉）");
  }
}

if (fails.length > 0) {
  console.error(`❌ check-mobile-wiring：${fails.length} 项不通过`);
  for (const f of fails) {
    console.error(`   - ${f}`);
  }
  process.exit(1);
}
console.log(
  `✅ check-mobile-wiring：app.js 引用的 ${used.size} 个 id 在 index.html 里全部存在` +
    `（豁免 ${DYNAMIC_IDS.size} 个 JS 动态生成的：${[...DYNAMIC_IDS].join(" / ")}）；` +
    `SSE 事件名 ${SERVER_EVENTS.length} 个（${SERVER_EVENTS.join(" / ")}）与服务端一致；` +
    `宽屏抽屉断点前后端一致（${cssBreak ? cssBreak[1] : "?"}px）`,
);
