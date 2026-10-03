// 「网页版服务」这个工具的接线 + 纯逻辑核对。
//
// 钉住三件最容易改歪的事：
//   1) 面板的三件套（fragment.html / client.js）和 package.json 里的命令声明必须对得上 ——
//      少一条命令，用户在命令面板里就搜不到，又会退回去 C 盘找 .cmd；
//   2) 工具元信息（toolName / category / fragmentPath / clientScriptPath）要能被 toolRegistry 认，
//      树里那个「网页版服务」节点才点得开；
//   3) 配置读写、端口解析、停止进程的判断，行为必须可预期 —— 尤其是"别误杀 VS Code"
//      （VS Code 的扩展宿主也是 node.exe，只能杀按端口定位到的那一个）。
//
// 用法：node scripts/check-webServerTool.cjs    （跑的是编译产物 out/，先 pnpm run compile）
const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(__dirname, "..");
const fails = [];
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
};

// 只 require service.js（纯 node、不 import vscode）。index.js 在普通 node 里 require 不动
// （它要 import "vscode"），它的元信息改用文本核对 —— 反正要防的是"写歪了"而不是运行时行为。
let service;
try {
  service = require(path.join(root, "out", "tools", "webServerTool", "service.js"));
} catch (err) {
  console.error(`❌ 读不到编译产物 out/tools/webServerTool/：${err.message}`);
  console.error("   先跑 pnpm run compile。");
  process.exit(1);
}

// ---- 1) 前端三件套与命令声明 ----
const frag = path.join(root, "src", "tools", "webServerTool", "fragment.html");
const client = path.join(root, "src", "tools", "webServerTool", "client.js");
ok(fs.existsSync(frag), "缺 fragment.html");
ok(fs.existsSync(client), "缺 client.js");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const cmdTitles = (pkg.contributes.commands || []).map((c) => c.title);
for (const need of [
  "Cherysis:打开网页版服务面板",
  "Cherysis:启动网页版服务",
]) {
  ok(cmdTitles.includes(need), `package.json 的 commands 里缺「${need}」`);
}
const src = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf-8");
ok(/registerCommand\("Cherysis\.openWebServer"/.test(src), "extension.ts 没注册 Cherysis.openWebServer");
ok(
  /registerCommand\("Cherysis\.startWebServer"/.test(src),
  "extension.ts 没注册 Cherysis.startWebServer",
);
ok(/toolRegistry\.register\(webServerTool\)/.test(src), "extension.ts 没把 webServerTool 注册进工具");

// ---- 2) 工具元信息（文本核对）----
const idxTs = fs.readFileSync(path.join(root, "src", "tools", "webServerTool", "index.ts"), "utf-8");
ok(/export const webServerTool/.test(idxTs), "index.ts 没导出 webServerTool");
ok(/toolName:\s*"webServer"/.test(idxTs), "toolName 不是 webServer（侧栏节点和注册处要对得上）");
ok(/category:\s*"service"/.test(idxTs), 'category 不是 "service"（toolTree 的分组表里要有这一项）');
ok(
  /fragmentPath:\s*"tools\/webServerTool\/fragment\.html"/.test(idxTs),
  "fragmentPath 不是 tools/webServerTool/fragment.html",
);
ok(
  /clientScriptPath:\s*"tools\/webServerTool\/client\.js"/.test(idxTs),
  "clientScriptPath 不是 tools/webServerTool/client.js",
);
const toolTree = fs.readFileSync(path.join(root, "src", "webview", "toolTree.ts"), "utf-8");
ok(/service:\s*\{/.test(toolTree), 'toolTree.ts 的 GROUP_INFO 里没有 service 这一项（树会渲染不出来）');
ok(frag && fs.statSync(frag).size > 0, "fragment.html 是空的");
ok(client && fs.statSync(client).size > 0, "client.js 是空的");

// ---- 3) 「启动」那一行命令 ----
// 面板点的「启动」是往终端 sendText 一段**文本**，由系统默认 shell 解释：你机器上是
// Windows PowerShell 5.1，而 `&&` 要 PowerShell 7 才有 —— 5.1 直接整行 ParserError，
// 服务压根没起来，终端里只留一行红字，看不出是命令本身写错。所以钉死这条命令的形态：
// 必须包一层 cmd /c，让 cmd 去解 `&`（cmd 的 `&` 无条件分隔，顺带保留"按任意键"）。
// 形态：cmd /c 包一层（给 cmd 解 `&`）+ 开头 chcp 65001（子 cmd 里切 UTF-8，否则中文体检是乱码）
const startCmdRe =
  /sendText\(\s*['"]cmd \/c "chcp 65001 >nul & node scripts\/serve-web\.cjs & pause"['"]\s*\)/;
ok(
  startCmdRe.test(idxTs),
  "startWebServer 发的启动命令不是 `cmd /c \"chcp 65001 >nul & node scripts/serve-web.cjs & pause\"` 了，" +
    "check 脚本要同步（改了要确认默认 shell 是否还认这行）",
);
const startFn = /export function startWebServer[\s\S]*?\n}/.exec(idxTs);
ok(
  startFn && !/&&/.test(startFn[0]),
  "startWebServer 里还用了 `&&`（PowerShell 5.1 不支持，点「启动」会报“标记 && 不是有效语句分隔符”）",
);

// ---- 4) 纯逻辑 ----
ok(service.portOf(null) === 666, "portOf(null) 应回退 666");
ok(service.portOf({ port: "0" }) === 666, "portOf({port:'0'}) 应回退 666");
ok(service.portOf({ port: "8080" }) === 8080, "portOf 应认 8080");
ok(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(service.serverUrl({ port: 666 })), `serverUrl 格式不对：${service.serverUrl({ port: 666 })}`);

const tmpCfg = path.join(os.tmpdir(), `ws-check-${process.pid}.json`);
try {
  service.writeServerConfig(tmpCfg, { storageDir: "D:\\a", port: "667", token: "SECRET" });
  const back = service.readServerConfig(tmpCfg);
  ok(back && back.port === "667", "配置写进去读出来 port 不对");
  ok(back && back.token === "SECRET", "token 应该原样存盘（只是不传给前端）");
  const raw = fs.readFileSync(tmpCfg, "utf-8");
  ok(raw.endsWith("\n"), "配置文件末尾应有换行");
  ok(raw.charCodeAt(0) !== 0xfeff, "写配置不该带 BOM（记事本另存为才会带）");
  fs.unlinkSync(tmpCfg);
} catch (err) {
  fails.push(`配置读写抛异常：${err.message}`);
}

// 停一个肯定没进程的端口：应当"本来就没跑"，而不是报错
const stopped = service.stopPort(47821);
ok(stopped && stopped.ok === true, `stopPort(47821) 应算成功（没有进程监听）：${JSON.stringify(stopped)}`);
ok(/没有进程在监听/.test(stopped.detail), `stopPort 的措辞不对：${stopped.detail}`);

const st = service.autostartStatus();
ok(st && typeof st.on === "boolean", "autostartStatus 应返回 boolean 的 on");

// ---- 5) 自动生成默认配置 ----
// 用途：vsix 里只有 example，真正的 json 是空的，缺文件 serve-web.cjs 直接拒跑。
// 而让用户手打 z:\测试商品… 这种带中文的路径，错一个字符就是"图全挂但库还在"。
const generated = service.buildDefaultConfig("z:\\测试商品管理程序20261001\\数据库", "");
ok(generated.port === 666, `buildDefaultConfig 默认端口应是 666：${JSON.stringify(generated)}`);
ok(
  generated.host === undefined && generated.liveOutDir === undefined,
  "buildDefaultConfig 不该写 host / liveOutDir —— src/server/config.ts 自己有默认值，别开两份",
);
// cacheDir 最不能写死：%LOCALAPPDATA% 是"跑服务那台机器的当前用户"。
// 一旦把 C:\Users\<某人>\… 写进配置，这份文件拷到第二台机器就指向一个不存在的目录
// （缓存重建 / prefs 重置 / 九宫格 out 错位，不报错但很绕）。
ok(
  generated.cacheDir === undefined,
  `buildDefaultConfig 不该写 cacheDir：写死成某台机器的用户名，换台机器就指错（现在是 ${generated.cacheDir}）`,
);
ok(
  /%LOCALAPPDATA%/.test(fs.readFileSync(path.join(root, "src", "tools", "webServerTool", "service.ts"), "utf-8")),
  "service.ts 里交代不清 cacheDir 为什么留空（注释要在，后人最容易手贱补上写死的那行）",
);

// ---- 6) 两边一致性比对 ----
const A = "z:\\测试商品管理程序20261001\\数据库";
const sameRow = service.configSyncRows({ storageDir: A }, { storageDir: A.replace(/\\/g, "/") });
ok(sameRow[0].status === "same", `大小写/斜杠写法不同也该判一致：${JSON.stringify(sameRow[0])}`);
const diffRow = service.configSyncRows({ storageDir: A }, { storageDir: "z:\\别的库" });
ok(diffRow[0].status === "diff", `指向不同目录该判不一致：${JSON.stringify(diffRow[0])}`);
const emptyRow = service.configSyncRows({}, { storageDir: A });
ok(emptyRow[0].status === "empty", `VS Code 侧没填该判 empty：${JSON.stringify(emptyRow[0])}`);
const naRow = service.configSyncRows({}, { cacheDir: "C:\\x" })[2];
ok(naRow.status === "na", `本机缓存没有 VS Code 侧可比项，该判 na：${JSON.stringify(naRow)}`);
ok(
  service.configSyncRows({ imageDir: "z:\\图" }, { imageDir: "z:\\图", cacheDir: "C:\\x" })[1].status ===
    "same",
  "两边图片目录相同时该判一致",
);
ok(service.normPathKey("Z:\\Data\\") === service.normPathKey("z:/data"), "normPathKey 归一化不对");

// ---- 7) 新接线的文本核对 ----
ok(
  /case "genConfig"/.test(idxTs),
  "index.ts 没处理 genConfig 消息（面板上「按 VS Code 设置生成」会变成\"未处理的消息\"）",
);
const startHandler = /async function handleStart[\s\S]*?\n}/.exec(idxTs);
ok(
  startHandler && /ensureServerConfig\(ctx\)/.test(startHandler[0]),
  "handleStart 没先 ensureServerConfig —— 没配置文件时点「启动」仍旧只会报错",
);
const fragHtml = fs.readFileSync(frag, "utf-8");
for (const id of ["wsGenBtn", "wsNoCfgRow", "wsSyncList", "wsSyncSummary", "wsStopCmdBtn", "wsCacheHint", "wsCmdList"]) {
  ok(fragHtml.includes(`id="${id}"`), `fragment.html 缺 id="${id}"（client.js 会拿到 null）`);
}

// ---- 8) 「停止服务.cmd」这一条路 ----
// 面板的「⏹ 停止」是静默的（杀掉就完了，不告诉你"是谁占着端口"），而那恰好是最难查的半边；
// 不开 VS Code 的场景（服务被双击 cmd / 开机自启起起来）也只能靠这个 cmd。
const stopScript = path.join(root, "scripts", "stop-web.cjs");
const stopCmdFile = path.join(root, "停止服务.cmd");
ok(fs.existsSync(stopScript), "缺 scripts/stop-web.cjs（「停止服务.cmd」和面板那个按钮都靠它）");
ok(fs.existsSync(stopCmdFile), "缺 停止服务.cmd（别人机器上不开 VS Code 就停不了服务）");
const stopCjs = fs.existsSync(stopScript) ? fs.readFileSync(stopScript, "utf-8") : "";
const stopCmdTxt = fs.existsSync(stopCmdFile) ? fs.readFileSync(stopCmdFile, "utf-8") : "";
// 中文必须留在 cjs 里：.cmd 里出现多字节字符会被 cmd 按当前代码页切坏命令行
ok(!/[^\x00-\x7F]/.test(stopCmdTxt), "停止服务.cmd 里有非 ASCII 字符（中文得留在 scripts/stop-web.cjs 里）");
ok(/chcp 65001/.test(stopCmdTxt), "停止服务.cmd 没切 UTF-8（中文会成乱码）");
ok(/cd \/d "%~dp0"/.test(stopCmdTxt), "停止服务.cmd 没 cd 到自身目录 —— 会去读错层的配置");
ok(/node "scripts\\stop-web\.cjs"/.test(stopCmdTxt), "停止服务.cmd 没调 scripts/stop-web.cjs");
ok(/pause/.test(stopCmdTxt), "停止服务.cmd 结尾没 pause（窗口一闪就没，看不出停没停成）");
// 停的逻辑只此一份：跟面板「⏹ 停止」共用 service.js，别在脚本里再写一遍 netstat 解析
ok(/out[\s\\]+tools[\s\\]+webServerTool[\s\\]+service\.js/.test(stopCjs.replace(/\//g, path.sep)) || stopCjs.includes("tools" + path.sep + "webServerTool" + path.sep + "service.js"), "stop-web.cjs 没复用 service.js 的 stopPort（两份实现早晚会漂）");
ok(!/taskkill\s+\/IM\s+node\.exe/i.test(stopCjs), "stop-web.cjs 里有 `taskkill /IM node.exe`（VS Code 扩展宿主也是 node.exe，会连编辑器一起带走）");
// 面板那条入口也得跟着齐
ok(
  /stopWebServerCmd\(/.test(idxTs),
  "index.ts 没实现 stopWebServerCmd（面板「在终端里用 cmd 关掉」点了没反应）",
);
const stopFn = /export function stopWebServerCmd[\s\S]*?\n}/.exec(idxTs);
ok(
  stopFn && /sendText\(\s*['"]cmd \/c "chcp 65001 >nul & node scripts\/stop-web\.cjs & pause"['"]\s*\)/.test(stopFn[0]),
  "stopWebServerCmd 发的命令不是 `cmd /c \"chcp 65001 >nul & node scripts/stop-web.cjs & pause\"` 了" +
    "（check 脚本要同步：默认 shell 是 PowerShell 5.1，&& 这种形态会整行 ParserError）",
);
ok(
  stopFn && !/&&/.test(stopFn[0]),
  "stopWebServerCmd 里还用了 `&&`（PowerShell 5.1 不支持）",
);
ok(
  /case "stopCmd"/.test(idxTs) && /case "listCmds"/.test(idxTs),
  "index.ts 没处理 stopCmd / listCmds 消息",
);

const clientJs = fs.readFileSync(client, "utf-8");
ok(/{ type: "genConfig" }/.test(clientJs), "client.js 没发 genConfig（生成按钮点了没反应）");
ok(/renderSync\(/.test(clientJs), "client.js 没渲染一致性对照表（wsSyncList 永远是空的）");
ok(/{ type: "stopCmd" }/.test(clientJs), "client.js 没发 stopCmd（「在终端里用 cmd 关掉」点了没反应）");
ok(/renderCacheHint\(/.test(clientJs), "client.js 没渲染本机缓存的空值提示（留空=本机默认 这条看不见）");
ok(/renderCmdList\(/.test(clientJs), "client.js 没列扩展目录里那几个 cmd");

if (fails.length > 0) {
  console.error("❌ check-webServerTool：");
  for (const f of fails) console.error("   " + f);
  process.exit(1);
}
console.log(
  "✅ check-webServerTool：接线（fragment/client/命令/注册）齐备；" +
    "工具元信息正确；配置读写 + 尾换行 + 无 BOM + 端口回退 + 停空端口 全通过；" +
    "自启查询返回布尔 on",
);
