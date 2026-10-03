// 网页版服务的关闭器：双击「停止服务.cmd」时干活的就是它，
// 面板上「在终端里关掉」那个按钮走的也是这一条。
//
// 为什么不把逻辑写在 .cmd 里（跟 serve-web.cjs 同一个理由）：
// 批处理文件里的中文会被 cmd 按当前代码页解析，多字节字符能把命令行切坏。
// 所以 .cmd 只留几行 ASCII，中文提示全在这里。
//
// 为什么是"先看清楚再杀"，而不是按进程名（/IM）逮着 node.exe 就杀：
// VS Code 自己的扩展宿主也是 node.exe。那么一下会把整个编辑器带走，
// 而且**连"到底是谁占着端口"都查不出来**。这里走的是 service.js 里那套：
// 端口 → PID → tasklist 核对进程名是 node → 才允许杀；不是 node 根本不动它。
//
// 用法：node scripts/stop-web.cjs [--config=配置文件的绝对路径]
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);

const configFile = path.resolve(args.config || path.join(root, "cherysis-server.config.json"));

/** 出错时别让窗口一闪就没（双击看的是这个窗口；没有 TTY 就不 pause，免得挂住） */
function waitThenExit(code) {
  if (process.stdout.isTTY) {
    try {
      spawnSync("cmd", ["/c", "pause"], { stdio: "inherit" });
    } catch {
      /* 起不来 pause 就算了，别因为提示手段本身再报一次错 */
    }
  }
  process.exit(code);
}

let cfg = {};
try {
  // 去 BOM：记事本「另存为 UTF-8」会写 BOM，JSON.parse 会因此报错
  cfg = JSON.parse(fs.readFileSync(configFile, "utf-8").replace(/^﻿/, ""));
} catch (err) {
  console.error("");
  console.error(`[错误] 配置文件读不出来（${configFile}）：`);
  console.error(`  ${err && err.message ? err.message : err}`);
  console.error("");
  console.error("  用 VS Code 打开它改（右下角编码选 UTF-8），或者先点面板上的「保存配置」。");
  console.error("");
  waitThenExit(1);
}

const port = Number(cfg.port) || 666;
console.log(`配置文件：${configFile}`);
console.log(`要停的是 ${port} 端口上的服务`);
console.log("");

// 停服务的(netstat/tasklist/taskkill 三段)只有一份实现，在 out/tools/webServerTool/service.js 里
// （TS 源码编译产物，跟面板「⏹ 停止」共用一个函数 —— 两份实现早晚会漂）
const svcPath = path.join(root, "out", "tools", "webServerTool", "service.js");
if (!fs.existsSync(svcPath)) {
  console.error("[错误] 还没编译过（找不到 out/tools/webServerTool/service.js）：");
  console.error("    pnpm run compile");
  console.error("");
  waitThenExit(1);
}
const svc = require(svcPath);

const r = svc.stopPort(port);
if (r.ok) {
  console.log(`✅ ${r.detail}`);
  console.log("");
  console.log("手机 / 电脑上网页会立刻连不上 —— 这就是「停掉了」的正常表现。");
} else {
  console.log(`❌ ${r.detail}`);
  console.log("");
  console.error("  端口是被别的程序占着的，我没动它 —— 硬杀可能杀掉别的服务。");
  console.error("  要看清楚到底是哪个进程：右键开始菜单 → 任务管理器 → 详细信息，按 PID 排序找。");
  console.error("  或者先停掉它该停的上游程序（比如 Docker / 另一个开发服务器）再重试。");
  console.error("");
}
waitThenExit(r.ok ? 0 : 1);
