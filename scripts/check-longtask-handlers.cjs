// 「长活儿入口」在 VS Code 侧（假 ctx）的行为核对。
//
// 为什么单独一个脚本：这一轮给 handler 加了 `runLongTask` 接缝（网页版走服务端队列、
// VS Code 走"立刻跑"）。要证明 VS Code 侧**零回归**，本该由 src/test/extension.test.ts 的
// 那几条断言守着 —— 但本机跑不了那套（VS Code 的扩展宿主拿不到可写的 %TEMP%，
// 测试文件在加载阶段就 EPERM，早于任何被测代码）。所以这里用**和套件一样的用法**直接调真 handler：
// 手写一个没有 `longTask` 的假 ctx（假 h），看两条老语义还在不在：
//   1) buildSharedThumbs 是"不 await 直接开跑"的：调完立刻返回，日志随后自己出现
//   2) generateLiveGrid **返回 Promise**，await 它就能等到活儿干完（终态已发出）
//
// 用法：node scripts/check-longtask-handlers.cjs   （纯 node，跑的是编译产物 out/）
const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(__dirname, "..");
const imageHandlers = require(path.join(root, "out", "tools", "shopTool", "handlers", "image.js"))
  .imageHandlers;
const liveHandlers = require(path.join(root, "out", "tools", "shopTool", "handlers", "live.js"))
  .liveHandlers;
const sharp = require(path.join(root, "node_modules", "sharp"));

const fails = [];
const ok = (c, m) => {
  if (!c) fails.push(m);
};

/** 在仓库内造临时目录（不碰 %TEMP%：那正是套件跑不起来的原因） */
function mkTmp(name) {
  const dir = path.join(root, "tmp-web-test", "longtask-check", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 与套件同形的假 ctx / 假 h：注意**故意不给 longTask**（老测试就是这样） */
function fakeCtx(over) {
  const logs = [];
  const posts = [];
  const ctx = {
    storageDir: over.storageDir,
    defaultStorageDir: over.defaultStorageDir,
    log: (t) => logs.push(String(t)),
    postToWebview: (m) => posts.push(m),
    imageUrl: () => "",
    revealInOS: async () => undefined,
    pickStorageDir: async () => undefined,
    selectFolder: async () => over.outDir,
    selectFile: async () => undefined,
    selectFiles: async () => [],
    confirm: async () => true,
    chooseAction: async () => undefined,
    prefs: { get: (k, d) => d, update: async () => undefined },
  };
  const h = {
    ctx,
    db: {
      getProducts: () => over.products || [],
    },
    log: (t) => logs.push(String(t)),
    post: (m) => posts.push(m),
    getSetting: (k) => (k === "live_out_dir" ? String(over.outDir || "") : ""),
    setSetting: async () => undefined,
    readOnly: () => false,
    localPrefKey: () => false,
    imageDir: () => over.imageDir,
    postLiveState: () => undefined,
    invalidateCover: () => undefined,
  };
  return { ctx, h, logs, posts };
}

async function main() {
  const work = mkTmp("work");
  const storageDir = path.join(work, "storage"); // 共享数据目录（缩略图缓存落这儿）
  const defaultStorageDir = path.join(work, "local"); // 本机缓存目录（必须与共享目录不同）
  const imageDir = path.join(work, "images");
  const outDir = path.join(work, "out");
  for (const d of [storageDir, defaultStorageDir, imageDir, outDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // 造两个商品、每个夹里一张真图（sharp 生成，避免依赖仓库里的图）
  const products = [{ code: "L001" }, { code: "L002" }];
  for (const p of products) {
    const dir = path.join(imageDir, p.code);
    fs.mkdirSync(dir, { recursive: true });
    await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 120, b: 60 } },
    })
      .jpeg()
      .toFile(path.join(dir, `${p.code}_1.jpg`));
  }

  // ---- 1) buildSharedThumbs：不 await 直接开跑，日志随后自己出现
  const a = fakeCtx({ storageDir, defaultStorageDir, imageDir, outDir, products });
  ok(typeof a.h.longTask !== "function", "（前提）假 h 故意没有 longTask");
  let returned;
  let threw = "";
  try {
    returned = imageHandlers(a.h).buildSharedThumbs({}, a.h);
  } catch (err) {
    threw = String(err && err.message ? err.message : err);
  }
  ok(!threw, `1) 没有 longTask 的假 h 不该抛错，实际抛了：${threw}（多半是直接调了 h.longTask()）`);
  ok(returned === undefined, "1) buildSharedThumbs 是「不 await 直接开跑」的，不该返回 Promise");

  // 等汇总日志（最多 20 秒）
  const deadline = Date.now() + 20000;
  let summary = "";
  while (Date.now() < deadline) {
    summary = a.logs.filter((l) => l.includes("共享缩略图完成")).pop() || "";
    if (summary) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`1) buildSharedThumbs 汇总：${summary || "（20 秒内没等到）"}`);
  ok(!!summary, "1) 不带 longTask 也必须把活儿跑完并报汇总（这是 VS Code 版的老行为）");
  // 2 个商品夹 × 各 1 张图 → 2 张封面 + 2 张图库 = 4 张（封面那轮先跑，图库排后面）
  ok(/新生成 4 张/.test(summary), `1) 2 封面 + 2 图库共 4 张都该新生成，实际：${summary}`);

  // ---- 2) generateLiveGrid：返回 Promise，await 能等到终态
  const b = fakeCtx({
    storageDir,
    defaultStorageDir,
    imageDir,
    outDir,
    products,
    // 空 plan → handler 会走到"没有可生成的组"并补一条终态；这里验的是**返回与等待的语义**
    plan: [],
  });
  const ret = liveHandlers(b.h).generateLiveGrid({ plan: [] }, b.h);
  ok(typeof ret?.then === "function", "2) generateLiveGrid 必须返回 Promise（套件里 await 它等跑完）");
  const terminalBefore = b.posts.filter(
    (m) => m && m.type === "liveGridStatus" && ["done", "error", "cancelled"].includes(m.phase),
  ).length;
  await ret;
  const terminalAfter = b.posts.filter(
    (m) => m && m.type === "liveGridStatus" && ["done", "error", "cancelled"].includes(m.phase),
  ).length;
  console.log(
    `2) generateLiveGrid：返回 thenable=${typeof ret?.then === "function"}，await 前终态 ${terminalBefore} 条、await 后 ${terminalAfter} 条`,
  );
  ok(terminalAfter >= 1, "2) 每一条退出路径都必须发终态（否则前端按钮永远卡在「生成中」）");
  ok(terminalAfter >= terminalBefore, "2) await 之后终态不该变少");

  fs.rmSync(work, { recursive: true, force: true });

  console.log("");
  if (fails.length > 0) {
    console.error(`❌ check-longtask-handlers：${fails.length} 项不通过`);
    for (const f of fails) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log("✅ check-longtask-handlers：VS Code 侧（假 ctx）两条老语义都还在");
}

main().catch((err) => {
  console.error("❌ check-longtask-handlers 跑挂了：", err);
  process.exit(1);
});
