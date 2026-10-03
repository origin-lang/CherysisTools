/**
 * 「网页版服务」工具：侧栏可点开的一个面板，用来起/停服务、开关开机自启、改配置，
 * 以及一眼看到「手机该访问哪个地址」。
 *
 * 为什么把它做成普通工具而不是在命令里 spawn 一个黑框：
 *   · 不用去 .vscode\extensions 那层找 cmd（版本号文件夹、装没装过旧版全靠猜，太容易点错）；
 *   · 起停状态、自启状态、配置内容都在同一屏里，不用"起完再去终端抄一行地址"；
 *   · 终端仍然负责看日志（serve-web.cjs 原样复用，体检三行、Ctrl+C、出错信息一个不少）。
 *
 * 所有路径都锚在**扩展目录**（cherysis-server.config.json 就在那儿），
 * 跟双击扩展目录里的「启动网页版.cmd」完全是同一份配置。
 */
import * as fs from "fs";
import * as vscode from "vscode";
import { ToolDefinition } from "../../core/toolRegistry.js";
import type { ToolContext } from "../../core/toolContext.js";
import {
  buildDefaultConfig,
  configSyncRows,
  defaultCacheDir,
  DEFAULT_PORT,
  portInUse,
  portOf,
  readServerConfig,
  runAutostart,
  serverConfigPath,
  serverStatusAsync,
  serverUrl,
  stopPort,
  writeServerConfig,
} from "./service.js";

/** 传给前端的字段白名单：token 是口令，一个字节都不进 webview */
const FRONT_FIELDS = ["storageDir", "imageDir", "cacheDir", "port"] as const;

const extDirOf = (ctx: ToolContext): string => ctx.extensionUri.fsPath;

/**
 * 起服务：开一个 VS Code 内置终端跑 serve-web.cjs。
 *
 * 走 serve-web.cjs 而不是直接 node out/server/index.js —— 前者带"启动前体检"
 * （找不到 shop.db 就拒绝启动），正是"切数据目录时最容易出事"的那一道闸，
 * 绕过它就会在一个空库上录半天数据才发现不对。
 *
 * 命令里顺手带一句 `chcp 65001 >nul`：serve-web.cjs 那屏体检提示是中文，
 * 而外层终端是 PowerShell 5.1（代码页 936），node 按 UTF-8 吐出去的中文会被解成乱码；
 * 在子 cmd 里先切到 UTF-8 再跑 node，这屏中文才看得清。输出重定向到 nul 免得插一行
 * "Active code page: 65001"。
 *
 * 这一行命令为什么是 `cmd /c "..."` 这种包了一层的写法（别手贱"简化"它）：
 * sendText 发的是**文本**，得由 VS Code 终端用你系统的默认 shell 解释执行，
 * 而你机器上是 Windows PowerShell 5.1 —— `&&` 是 PowerShell 7 才支持的，
 * 5.1 一看到就整行报"标记 && 不是此版本中的有效语句分隔符"，服务压根没起来，
 * 终端里只剩一行红字，根本看不出是命令本身写错了（这个坑踩过一次）。
 * 包一层 cmd /c 之后，交给 cmd 去解 `&`：这条字符串在 cmd / PowerShell / Git Bash 下
 * 都是同一条合法命令；而 cmd 的 `&` 是无条件分隔（不像 && 要看上一条成功与否），
 * 正好保留"双击 .cmd 那个按任意键"的效果 —— 体检报错能把屏幕留在给人看。
 */
export function startWebServer(extDir: string): void {
  const term = vscode.window.createTerminal({ name: "Cherysis 网页版", cwd: extDir });
  term.sendText('cmd /c "chcp 65001 >nul & node scripts/serve-web.cjs & pause"');
  term.show();
}

export function stopWebServer(port: number): { ok: boolean; detail: string } {
  return stopPort(port);
}

/** 当前这台机器在 VS Code 里配的库 / 图片目录（两边对一眼要用） */
function vscodePaths(): { storageDir: string; imageDir: string } {
  const c = vscode.workspace.getConfiguration("cherysis");
  const get = (k: string): string => String(c.get<string>(k) ?? "").trim();
  return { storageDir: get("storageDir"), imageDir: get("shopTool.imageDir") };
}

/**
 * 配置文件不存在时，照 VS Code 那边的设置现生成一份。
 *
 * 「装上扩展就能双击 cmd 用」全靠这一步：vsix 里只有 example，真正的 json 是空的，
 * 缺文件 serve-web.cjs 会直接拒跑。而让用户手打一遍带中文的路径（z:\测试商品…）既痛
 * 又极易打错一个字符 —— 错的那点方向是"图全挂但库还在"，最难察觉。
 *
 * 返回 false 时调用方该停下来（别去启动一个没有配置的服务），文案里必须给出**下一步**：
 * 静态报错「配置不存在」只会让人盯着空表单发呆。
 */
function ensureServerConfig(ctx: ToolContext): boolean {
  return ensureServerConfigAt(extDirOf(ctx), (t) => ctx.log(t)).ok;
}

/** 纯版本（给命令面板那条入口用）：不碰 webview，只把要说的话收进 logs */
export function ensureServerConfigAt(
  extDir: string,
  log?: (t: string) => void,
): { ok: boolean; logs: string[] } {
  const logs: string[] = [];
  const say = (t: string): void => {
    logs.push(t);
    log?.(t);
  };
  const cfgPath = serverConfigPath(extDir);
  if (readServerConfig(cfgPath)) {
    return { ok: true, logs };
  }
  const vs = vscodePaths();
  if (!vs.storageDir) {
    say("❌ 网页版的配置文件还不存在，而且 VS Code 设置里也没填数据目录（cherysis.storageDir），我没法凭空替你猜。");
    say("ℹ️ 两条路：① 在扩展目录里把 cherysis-server.config.example.json 复制一份改名；");
    say("      ② 或到设置里填 cherysis.storageDir / cherysis.shopTool.imageDir，再回来点「生成默认配置」。");
    return { ok: false, logs };
  }
  try {
    writeServerConfig(cfgPath, buildDefaultConfig(vs.storageDir, vs.imageDir));
  } catch (err: any) {
    say(`❌ 建不了配置文件：${err?.message ?? err}`);
    say("ℹ️ 扩展目录只读时（比如装在 Program Files）会这样：换个地方解压一份再用，或先「保存配置」试试。");
    return { ok: false, logs };
  }
  say(`✅ 照 VS Code 的设置生成了一份配置：${cfgPath}`);
  say(`ℹ️ 数据目录：${vs.storageDir}`);
  say(`ℹ️ 图片目录：${vs.imageDir || "（没填 —— 图片相关功能会报错，数据还能录）"}`);
  say(`ℹ️ 本机缓存：${defaultCacheDir()}（本机盘，换台机器填那台机器的用户目录）｜端口 ${DEFAULT_PORT}`);
  say("ℹ️ 这份配置和「启动网页版.cmd」是同一个文件，以后双击 cmd 也用它。");
  return { ok: true, logs };
}

/** 面板要的那一屏状态；overrideFields 用来覆盖某个字段（比如刚选完目录还没落盘） */
async function pushStatus(
  ctx: ToolContext,
  overrideFields?: Record<string, unknown>,
): Promise<void> {
  const s = await serverStatusAsync(extDirOf(ctx));
  const fields: Record<string, unknown> = {};
  for (const k of FRONT_FIELDS) {
    fields[k] = s.cfg ? s.cfg[k] : "";
  }
  Object.assign(fields, overrideFields || {});
  ctx.postToWebview({
    type: "wsStatus",
    running: s.running,
    autostart: s.autostart,
    port: s.port,
    url: serverUrl(s.cfg),
    configPath: s.configPath,
    configOk: s.configOk,
    configError: s.configError,
    fields,
    // 没配 / 配了但和 VS Code 不一样时，面板上摆一行行对照，别让人靠猜
    sync: configSyncRows(vscodePaths(), s.cfg),
    canGen: !s.cfg && !!vscodePaths().storageDir,
  });
}

async function handleStart(ctx: ToolContext): Promise<void> {
  const extDir = extDirOf(ctx);
  const cfgPath = serverConfigPath(extDir);
  // 顺手把"配置不存在"这件事抹掉：照 VS Code 的设置生成一份再往下走。
  // 以前这里只报一句"缺配置文件"，新手对着空面板和空表单无从下手。
  if (!ensureServerConfig(ctx)) {
    return;
  }
  const cfg = readServerConfig(cfgPath) || {};
  if (!cfg) {
    ctx.log(`❌ 配置文件读不出来（不是合法 JSON）：${cfgPath}`);
    ctx.log("ℹ️ 用记事本打开它，另存为 UTF-8（带 BOM 会读不出来），或删了重建一份。");
    return;
  }
  const dir = String(cfg.storageDir || "").trim();
  if (dir) {
    // 共享盘没挂上时空库是无声的坑：体检在终端里做，这里再点一句，免得对着黑框猜
    ctx.log(`ℹ️ 这份配置的数据目录：${dir}`);
  }
  // 先探一下端口：已经跑着时直接给结论，别让人对着终端里那一屏 EADDRINUSE 猜发生了什么
  if (await portInUse(portOf(cfg))) {
    ctx.log(`⚠️ ${portOf(cfg)} 端口已经有服务在听：${serverUrl(cfg)}`);
    ctx.log("ℹ️ 多半已经跑着了（双击 cmd / 开机自启起过）。要换端口就改下面的配置，要停就点「⏹ 停止」。");
    return;
  }
  ctx.log("ℹ️ 终端里开一个「Cherysis 网页版」标签页跑服务：Ctrl+C 或关掉它即停；" +
    "启动失败时那屏会停在『按任意键继续』，看清报错再关。");
  startWebServer(extDir);
}

async function handleStop(ctx: ToolContext): Promise<void> {
  const cfg = readServerConfig(serverConfigPath(extDirOf(ctx)));
  const r = stopWebServer(portOf(cfg));
  ctx.log(r.ok ? `✅${r.detail}` : `❌${r.detail}`);
}

async function handleAutostart(ctx: ToolContext, on: boolean): Promise<void> {
  const r = runAutostart(extDirOf(ctx), on);
  if (!r.ok) {
    ctx.log(`❌${r.detail.split("\n")[0]}`);
    ctx.log("ℹ️ 建计划任务常常要管理员权限：开始菜单搜 cmd → 右键「以管理员身份运行」，进扩展目录再跑一次 设置开机自启.cmd");
    return;
  }
  ctx.log(on ? "✅ 已设置开机自启（下次登录 Windows 时自动起）" : "✅ 已取消开机自启");
  for (const line of r.detail.split("\n").filter((x) => x.trim())) {
    if (!/^✅|^❌/.test(line)) {
      ctx.log(`ℹ️${line}`);
    }
  }
}

async function handleSaveConfig(ctx: ToolContext, f: Record<string, any>): Promise<void> {
  const extDir = extDirOf(ctx);
  const cfgPath = serverConfigPath(extDir);
  const cur = readServerConfig(cfgPath) || {};
  const oldPort = portOf(cur);
  const next: Record<string, unknown> = { ...cur };
  for (const k of FRONT_FIELDS) {
    const v = String(f[k] ?? "").trim();
    if (v) {
      next[k] = v;
    }
  }
  if (!String(next.storageDir || "").trim()) {
    ctx.log("❌ 数据目录（storageDir）不能空：服务靠它找 shop.db");
    return;
  }
  if (!String(next.imageDir || "").trim()) {
    ctx.log("⚠️ 没填图片目录：图片相关的功能会报错，但数据还能录");
  }
  try {
    writeServerConfig(cfgPath, next as never);
  } catch (err: any) {
    ctx.log(`❌ 写不进去：${err?.message ?? err}`);
    ctx.log("ℹ️ 扩展目录只读时会这样（比如装在 Program Files）。换个地方解压一份再用。");
    return;
  }
  const portChanged = portOf(next as never) !== oldPort;
  ctx.log(`✅ 已写入：${cfgPath}`);
  ctx.log(portChanged ? "ℹ️ 端口改过了，要重新「启动」才生效" : "ℹ️ 改了路径一般要重启服务才生效");
}

export const webServerTool: ToolDefinition = {
  toolName: "webServer",
  title: "网页版服务",
  category: "service",
  fragmentPath: "tools/webServerTool/fragment.html",
  clientScriptPath: "tools/webServerTool/client.js",
  handleMessage: async (msg: any, ctx: ToolContext) => {
    switch (msg?.type) {
      case "status":
        await pushStatus(ctx);
        break;
      case "start":
        await handleStart(ctx);
        break;
      case "stop":
        await handleStop(ctx);
        break;
      case "autostart":
        await handleAutostart(ctx, !!msg.value);
        break;
      case "saveConfig":
        await handleSaveConfig(ctx, msg.fields || {});
        break;
      case "genConfig":
        if (ensureServerConfig(ctx)) {
          ctx.log("ℹ️ 下面「配置」那几栏已经是这份配置的内容；要改就在上面「选文件夹」或手打，「保存配置」写盘，改了路径一般要重新「启动」才生效。");
        }
        await pushStatus(ctx);
        break;
      case "pickFolder": {
        const target = String(msg.target || "");
        const dir = await ctx.selectFolder(
          target === "imageDir"
            ? "选商品图片根目录"
            : target === "cacheDir"
              ? "选本机缓存目录（放本机盘）"
              : "选数据目录（shop.db 在这里）",
        );
        if (dir) {
          // 回填输入框 + 把那一栏的状态刷掉（还没保存，先让面板看起来是刚选的）
          ctx.postToWebview({ type: "wsFill", target, path: dir });
          const key = target === "storageDir" || target === "cacheDir" ? target : "imageDir";
          await pushStatus(ctx, { [key]: dir });
        }
        break;
      }
      case "openConfig": {
        const p = serverConfigPath(extDirOf(ctx));
        if (fs.existsSync(p)) {
          await ctx.revealInOS(p);
        } else {
          ctx.log("ℹ️ 这个文件还不存在，先在下面填好配置保存一次。");
        }
        break;
      }
      case "copyUrl": {
        const url = serverUrl(readServerConfig(serverConfigPath(extDirOf(ctx))));
        try {
          await vscode.env.clipboard.writeText(url);
          ctx.log(`✅ 已复制：${url}`);
        } catch (err: any) {
          ctx.log(`❌ 复制失败：${err?.message ?? err}`);
        }
        break;
      }
      case "openUrl": {
        const url = serverUrl(readServerConfig(serverConfigPath(extDirOf(ctx))));
        try {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (err: any) {
          ctx.log(`❌ 打不开：${err?.message ?? err}`);
        }
        break;
      }
      default:
        ctx.log(`ℹ️ 未处理的消息：${msg?.type}`);
    }
  },
};
