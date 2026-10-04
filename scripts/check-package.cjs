// 打包前体检：判断"这个 vsix 能不能发给别人"。
//
// 为什么需要它（都是真踩过的）：
//   ① vsce 默认把**仓库根的所有文件**都打进 vsix。开发文档（测试清单、docs/ 里的设计稿与
//      测试数据说明）夹带本机绝对路径与用户名（C:\Users\<你>\...、\\<NAS 名>\...），
//      一发给别人就泄露了 —— 而且从包里看不出来，除非专门去翻。
//   ② 前端是**静态直出**（fragment.html + client-*.js 从 src/ 读，见 toolRegistry 的 resolveSrc），
//      被 .vscodeignore 误排除一个，扩展装上去就是"点了没反应"，而且**不报任何错**。
//
// 用法：node scripts/check-package.cjs
//   退出码 0 = 可以发；1 = 有必须先处理的问题。
// 依赖 vsce（devDependency）。若 vsce 跑不起来（没装依赖 / 环境异常），脚本会**明确报错**，
// 不会假装通过 —— 这道闸门宁可红也不要假绿。
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const fails = [];
const warns = [];

// ---------- 1) 拿真实文件清单 ----------
// 不捕获子进程输出：某些受限环境里 piped stdio 会 EPERM。让 vsce 自己写文件再读。
const listFile = path.join(root, "tmp-vsce-ls.txt");
try {
  fs.unlinkSync(listFile);
} catch {
  /* 不存在就算了 */
}
const r = spawnSync(`npx vsce ls --no-dependencies > "${listFile}" 2>nul`, {
  cwd: root,
  shell: true,
  stdio: "inherit",
});
if (!fs.existsSync(listFile)) {
  console.error(
    `❌ check-package：拿不到文件清单（vsce 退出码 ${r.status}）。` +
      `先确认依赖装好了（pnpm install）、且 npx vsce 能跑。`,
  );
  process.exit(1);
}
const files = fs
  .readFileSync(listFile, "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && !/^npm warn/.test(s) && !s.startsWith(">"));
fs.unlinkSync(listFile);

if (files.length < 50) {
  fails.push(`清单只有 ${files.length} 条（正常 100 条上下）：vsce 输出格式变了？这道闸门已失效`);
}

// ---------- 2) 必需文件必须在包里 ----------
// 前端静态资源缺一个 = 功能静默失效（见文件头 ②）
const forward = files.map((f) => f.replace(/\\/g, "/"));
const REQUIRED = [
  "package.json",
  "out/extension.js",
  "src/webview/main.html",
  "src/webview/mobile/index.html",
  "src/webview/mobile/app.js",
  "src/webview/mobile/style.css",
  "src/tools/shopTool/fragment.html",
  "src/tools/shopTool/client-core.js",
  "src/tools/shopTool/client-product.js",
  "src/tools/shopTool/client-sales.js",
  "src/tools/shopTool/client-report.js",
  "src/tools/shopTool/client-live.js",
  "src/tools/shopTool/client-main.js",
  // 网页版服务的**运行时**入口：四个 .cmd 与面板的「▶ 启动」按钮最终都跑它们。
  // 0.0.30 第一次打包时被 .vscodeignore 的 scripts/** 一并排除，装上点启动直接
  // MODULE_NOT_FOUND —— 这类"包里缺了但不报错"的失效正是这道闸门的活儿。
  "scripts/serve-web.cjs",
  "scripts/stop-web.cjs",
  "scripts/autostart.ps1",
  "启动网页版.cmd",
  "停止服务.cmd",
  "设置开机自启.cmd",
  "取消开机自启.cmd",
];
for (const f of REQUIRED) {
  if (!forward.includes(f)) {
    fails.push(`包里缺 ${f} —— 扩展装上去这个功能会静默失效（前端是静态直出，缺了不报错）`);
  }
}

// 每个工具的 fragment.html 都要在（工具列表从注册表来，缺一个就是那个工具空白）
const toolDirs = fs
  .readdirSync(path.join(root, "src", "tools"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
for (const t of toolDirs) {
  const frag = `src/tools/${t}/fragment.html`;
  if (fs.existsSync(path.join(root, frag)) && !forward.includes(frag)) {
    fails.push(`包里缺 ${frag} —— 工具「${t}」会渲染成空白`);
  }
}

// ---------- 3) 不该进包的东西 ----------
const FORBIDDEN = [
  ["cherysis-server.config.json", "本机真实路径（还可能有 token）"],
  ["cherysis-server.config.demo.json", "本机真实路径"],
  ["tmp-web-test/", "网页版演示/测试数据（18MB，夹着演示 shop.db）"],
  [".pnpm-store/", "vsce-pnpm 的临时 store"],
  [".workbuddy/", "AI 工具工作数据（夹带本机路径与内部笔记）"],
  [".agents/", "AI 技能目录"],
  ["测试清单-本轮改造.md", "内部测试清单"],
  ["patches/", "pnpm patch 文件（装在依赖里了，不需要进包）"],
];
for (const [needle, why] of FORBIDDEN) {
  if (forward.some((f) => f === needle || f.startsWith(needle))) {
    fails.push(`包里混进了 ${needle}（${why}）—— 发给别人之前必须挡在 .vscodeignore 里`);
  }
}
// scripts/ 是**白名单**：只允许那三个运行时入口，其它（check-*/seed-*/e2e-*）一律不许进包。
// （不能写死成"整个 scripts/ 都不许有"，因为那三个就在里头）
const ALLOWED_SCRIPTS = ["scripts/serve-web.cjs", "scripts/stop-web.cjs", "scripts/autostart.ps1"];
const strayScripts = forward.filter((f) => f.startsWith("scripts/") && !ALLOWED_SCRIPTS.includes(f));
if (strayScripts.length) {
  fails.push(
    `包里混进了不该带的开发脚本：${strayScripts.slice(0, 8).join(", ")}` +
      ` —— scripts/ 只允许 ${ALLOWED_SCRIPTS.join(" / ")} 这三项`,
  );
}
// vsix 本身绝不能进包
if (forward.some((f) => f.toLowerCase().endsWith(".vsix"))) {
  fails.push("包里混进了 .vsix 文件");
}

// ---------- 4) 内容扫描：本机绝对路径 / 用户名 ----------
// 只扫文本；二进制跳过（含 NUL）。
//
// ⚠️ 判定要准，否则要么放过真泄露、要么天天误报（写这条时两种都踩过）：
//   · 误报样本：package.json 里 `%APPDATA%\\Code\\User\\globalStorage\\...` 被 UNC 正则命中；
//     `cherysis-server.config.example.json` 里的 `C:\Users\你的用户名\...` 是**故意写的占位示例**。
//   · 真泄露样本：CHANGELOG.md 里 `C:\Users\YFF\AppData\Local\...` —— 真实用户名。
//   所以：占位符（你的用户名/<某人>/<user>/%VAR%）放行；真实用户名会**真的失败**，
//   并且文档不做整体豁免（文档照样会泄露）。
const LEAK = [
  // 写死的 C:\Users\<真实用户名>\...（占位符不算）
  [/C:\\+Users\\+(?!你的用户名|<|%|\$|xxx|XXX)[A-Za-z0-9_.-]{2,}\\/, "写死的 C:\\Users\\<某人>\\...（真实用户名）"],
  // UNC 共享路径 \\<机器名>\<共享名>\...（排除 %APPDATA%\Code\User 这类被转义的环境变量路径）
  [/\\\\[A-Za-z][A-Za-z0-9_-]{2,}\\(?!Code\\|User\\|globalStorage)[A-Za-z0-9_.-]{2,}\\/, "UNC 共享路径 \\\\<机器名>\\<共享名>\\..."],
];
let scanned = 0;
for (const rel of forward) {
  const abs = path.join(root, rel);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    continue;
  }
  if (buf.includes(0)) continue; // 二进制
  if (buf.length > 4 * 1024 * 1024) continue;
  const text = buf.toString("utf8");
  scanned++;
  for (const [re, why] of LEAK) {
    const m = text.match(re);
    if (!m) continue;
    const ctx = text.slice(Math.max(0, m.index - 30), m.index + 50).replace(/\s+/g, " ");
    fails.push(`${rel}：出现 ${why} —— 会泄露本机信息：…${ctx}…`);
  }
}
if (scanned < 20) {
  fails.push(`只扫到 ${scanned} 个文本文件（正常几十个）：内容扫描这道闸门可能已失效`);
}

// ---------- 输出 ----------
if (fails.length > 0) {
  console.error(`❌ check-package：${fails.length} 项必须先处理`);
  for (const f of fails) {
    console.error(`   - ${f}`);
  }
  if (warns.length) {
    console.error(`\n（另有 ${warns.length} 条提示）`);
    for (const w of warns) console.error(`   · ${w}`);
  }
  process.exit(1);
}

console.log(`✅ check-package：清单 ${files.length} 条，必需资源齐全，禁入项 0，内容扫描 ${scanned} 个文本文件`);
if (warns.length) {
  console.log(`   提示 ${warns.length} 条（文档/示例里的路径字样，确认非真实路径即可）：`);
  for (const w of warns) console.log(`     · ${w}`);
}
