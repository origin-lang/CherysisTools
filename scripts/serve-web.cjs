// 网页版服务的启动器：双击「启动网页版.cmd」时真正干活的就是它。
// 开机自启的计划任务也指向这里 —— **同一个入口**，所以"体检"对两条路都生效。
//
// 为什么不把逻辑写在 .cmd 里：批处理文件里的中文会被 cmd 按当前代码页解析，
// 多字节字符能把命令行切坏（实测：注释里的中文让后面的命令整段错位）。
// 所以 .cmd 只留几行 ASCII（切目录 + 调本文件 + pause），中文提示与检查都在这里 ——
// node 在 chcp 65001 下输出中文是稳的。
//
// 用法：node scripts/serve-web.cjs [--config=配置文件的绝对路径] [--allow-new-db]
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);

const configFile = path.resolve(args.config || path.join(root, "cherysis-server.config.json"));

/**
 * 出错时别让窗口一闪就没。
 * 双击启动时这是个可见的控制台，用户需要看到原因；开机自启的任务也走这个入口，
 * 同样需要（否则失败时窗口瞬间消失，只剩「服务没起来」这一个现象可猜）。
 * 没有 TTY（比如被当成后台任务跑）就不 pause，免得挂住。
 */
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

if (!fs.existsSync(configFile)) {
  console.error("");
  console.error("[错误] 没找到配置文件：");
  console.error(`  ${configFile}`);
  console.error("");
  console.error("  把 cherysis-server.config.example.json 复制一份、改名成 cherysis-server.config.json，");
  console.error("  再把里面的 storageDir / imageDir / cacheDir 改成这台机器上的真实路径。");
  console.error("  说明见 docs/网页版-上手与自测.md 第四节。");
  console.error("");
  waitThenExit(1);
}

const entry = path.join(root, "out", "server", "index.js");
if (!fs.existsSync(entry)) {
  console.error("");
  console.error("[错误] 还没编译过（找不到 out/server/index.js）。先在项目目录里跑：");
  console.error("");
  console.error("    pnpm install     （只第一次需要）");
  console.error("    pnpm run compile");
  console.error("");
  waitThenExit(1);
}

// ---------- 启动前体检 ----------
// 这一步是「切真实数据」最容易出事的地方：共享盘没挂上（映射盘在计划任务里常常不存在，
// 或者别人重启了主机），服务会拿着一个不存在的路径**建出一个空库**，然后一切"正常"——
// 你对着一个空库录半天数据才发现不对。所以：**找不到 shop.db 就拒绝启动**。
console.log(`配置文件：${configFile}`);

let cfg = {};
try {
  // 去 BOM：记事本「另存为 UTF-8」会写 BOM，JSON.parse 会因此报错，
  // 而这个文件里通常有中文路径，用户很可能就是用记事本改的
  cfg = JSON.parse(fs.readFileSync(configFile, "utf-8").replace(/^\uFEFF/, ""));
} catch (err) {
  console.error("");
  console.error("[错误] 配置文件不是合法 JSON：");
  console.error(`  ${err && err.message ? err.message : err}`);
  console.error("");
  console.error("  常见原因：记事本另存为时选了 ANSI（中文路径变成乱码），或者手动改漏了逗号/引号。");
  console.error("  建议用 VS Code 打开这个文件改（右下角编码选 UTF-8）。");
  console.error("");
  waitThenExit(1);
}

const storageDir = String(cfg.storageDir || "");
const imageDir = String(cfg.imageDir || "");
const cacheDir = String(cfg.cacheDir || "");
const isDemo = /tmp-web-test|cherysis-demo/i.test(storageDir);

/** 目录能不能读（不做写入测试：共享盘上写测试反而可能留下垃圾） */
function dirOk(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

console.log("");
if (!storageDir) {
  console.error("[错误] 配置里没写 storageDir（shop.db 所在目录）。");
  waitThenExit(1);
}
if (!dirOk(storageDir)) {
  console.error(`[错误] 数据目录读不到：${storageDir}`);
  console.error("");
  console.error("  九成是共享盘没挂上（映射盘只在「某某登录了」的会话里存在）。按顺序查：");
  console.error("   1) 资源管理器里能看到那个盘吗？打不开就先连上它，或把配置改成 UNC 路径");
  console.error("      （形如 \\\\主机名\\共享名\\子目录，反斜杠要写两遍）");
  console.error("   2) 是不是在没人登录的情况下起的？计划任务用「登录时」触发器就不会有这个问题");
  console.error("   3) 路径里的中文有没有被记事本存坏？用 VS Code 打开配置确认编码是 UTF-8");
  console.error("");
  waitThenExit(1);
}
const dbFile = path.join(storageDir, "shop.db");
const dbExists = fs.existsSync(dbFile);
if (!dbExists && !args["allow-new-db"]) {
  console.error(`[错误] 数据目录里没有 shop.db：${dbFile}`);
  console.error("");
  console.error("  拒绝启动，是为了避免「服务在一个空目录上建出一个空库」——");
  console.error("  那样你会在一个空库上录半天数据，才发现路径指错了。");
  console.error("");
  console.error("  确实是全新部署、就是要建新库 → 加参数重跑：");
  console.error(`    node scripts/serve-web.cjs --config="${configFile}" --allow-new-db`);
  console.error("");
  waitThenExit(1);
}
const sizeMb = dbExists ? (fs.statSync(dbFile).size / 1024 / 1024).toFixed(1) : "0";
console.log(`数据目录：${storageDir}`);
console.log(`  shop.db ${dbExists ? `✓（${sizeMb} MB）` : "✗（--allow-new-db：会新建一个空库）"}`);
console.log(
  `图片目录：${imageDir || "（没配！图片相关的功能会报错）"}${imageDir ? (dirOk(imageDir) ? "  ✓" : "  ✗ 读不到") : ""}`,
);
console.log(`本机缓存：${cacheDir || "（没配）"}`);
if (isDemo) {
  console.log("");
  console.log("⚠️ 注意：这份配置指向的是**演示/测试数据**（tmp-web-test），不是正式商品库。");
  console.log("   正式数据的配置是 cherysis-server.config.json（真实路径 + 666 端口）。");
}
console.log("");

// 直接用 node 跑服务，stdio 全继承：日志、Ctrl+C、关窗口都跟直接跑一样。
// --config 给绝对路径：配置文件是按**当前目录**找的，写死绝对路径才不会因为从别处启动而找不到。
const child = spawn(process.execPath, [entry, `--config=${configFile}`], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code === null ? 0 : code));
