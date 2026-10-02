// 网页版服务的启动器：双击「启动网页版.cmd」时真正干活的就是它。
//
// 为什么不把逻辑写在 .cmd 里：批处理文件里的中文会被 cmd 按当前代码页解析，
// 多字节字符能把命令行切坏（实测：注释里的中文让后面的命令整段错位）。
// 所以 .cmd 只留三行 ASCII（切目录 + 调本文件 + pause），中文提示与检查都在这里 ——
// node 在 chcp 65001 下输出中文是稳的。
//
// 用法：node scripts/serve-web.cjs [--config=配置文件的绝对路径]
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);

const configFile = path.resolve(args.config || path.join(root, "cherysis-server.config.json"));

if (!fs.existsSync(configFile)) {
  console.error("");
  console.error("[错误] 没找到配置文件：");
  console.error(`  ${configFile}`);
  console.error("");
  console.error("  把 cherysis-server.config.example.json 复制一份、改名成 cherysis-server.config.json，");
  console.error("  再把里面的 storageDir / imageDir / cacheDir 改成这台机器上的真实路径。");
  console.error("  说明见 docs/网页版-使用与运维.md 第二节。");
  console.error("");
  process.exit(1);
}

const entry = path.join(root, "out", "server", "index.js");
if (!fs.existsSync(entry)) {
  console.error("");
  console.error("[错误] 还没编译过（找不到 out/server/index.js）。先在项目目录里跑：");
  console.error("");
  console.error("    pnpm install     （只第一次需要）");
  console.error("    pnpm run compile");
  console.error("");
  process.exit(1);
}

// 直接用 node 跑服务，stdio 全继承：日志、Ctrl+C、关窗口都跟直接跑一样。
// --config 给绝对路径：配置文件是按**当前目录**找的，写死绝对路径才不会因为从别处启动而找不到。
const child = spawn(process.execPath, [entry, `--config=${configFile}`], {
  cwd: root,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code === null ? 0 : code));
