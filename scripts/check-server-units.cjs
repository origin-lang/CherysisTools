// 网页版服务端「纯模块」的语义核对 —— 目前是 src/server/events.ts 的 EventHub（实时推送中枢）。
//
// 为什么要单独一个脚本：这些模块刻意不 import http、不 import vscode，所以能在**没有服务、
// 没有数据库、没有 VS Code** 的普通 node 进程里直接跑。语义（编号、去重、环形缓冲、
// 断线续传）全在这里钉死，改坏了立刻非零退出，不用等真机上"手机怎么不刷新"才发现。
//
// 用法：node scripts/check-server-units.cjs     （跑的是编译产物 out/，所以要先 pnpm run compile）
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const eventsFile = path.join(root, "out", "server", "events.js");

const fails = [];
const ok = (cond, msg) => {
  if (!cond) {
    fails.push(msg);
  }
};

let Hub;
let formatFrame;
try {
  ({ EventHub: Hub, formatFrame } = require(eventsFile));
} catch (err) {
  console.error(`❌ 读不到编译产物 ${path.relative(root, eventsFile)}：${err.message}`);
  console.error("   先跑 pnpm run compile（pretest 里已经串好了，单独跑本脚本时才需要手动）。");
  process.exit(1);
}

/** 假订阅者：只要 write/end/origin 三样，跟真实 http 响应同形 */
function fakeSink(origin) {
  const got = [];
  return {
    origin,
    got,
    write: (chunk) => {
      got.push(chunk);
    },
    end: () => {
      got.push("<end>");
    },
    /** 把收到的分帧解析成 [{id, event, data}]：顺便验证线格式本身没写坏 */
    frames: () => parseFrames(got.filter((c) => c !== "<end>").join("")),
  };
}

function parseFrames(text) {
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const out = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) out.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) out.event = line.slice(7);
        else if (line.startsWith("data: ")) out.data = (out.data === undefined ? "" : out.data + "\n") + line.slice(6);
        else if (line.startsWith(": ")) out.comment = line.slice(2);
      }
      return out;
    });
}

// ---------------------------------------------------------------- 用例
// 里面有 await（排队那几组要真等），所以整段包在 async 里跑；汇总放在最后。
(async () => {

// 1) 编号单调递增
{
  const hub = new Hub();
  const a = hub.publish({ event: "log", data: "1" });
  const b = hub.publish({ event: "log", data: "2" });
  ok(b.id === a.id + 1, `编号应单调递增：${a.id} → ${b.id}`);
  ok(a.id === 1, `第一条应从 1 开始，实际 ${a.id}`);
}

// 2) 订阅者收到事件，事件名/数据/origin 都在
{
  const hub = new Hub();
  const s = fakeSink("A");
  hub.attach(s);
  hub.publish({ event: "post", data: { type: "productsDelta", products: [{ id: 7 }] }, origin: "B" });
  const f = s.frames();
  ok(f.length === 1, `应收到 1 条，实际 ${f.length}`);
  ok(f[0] && f[0].event === "post", `事件名应是 post，实际 ${f[0] && f[0].event}`);
  ok(
    f[0] && JSON.parse(f[0].data).products[0].id === 7,
    "data 必须是能被 JSON.parse 的完整对象",
  );
}

// 3) 跳过自己：同 origin 的订阅者收不到（自己那次 /api/invoke 的响应里已经有了）
{
  const hub = new Hub();
  const me = fakeSink("A");
  const other = fakeSink("B");
  hub.attach(me);
  hub.attach(other);
  hub.publish({ event: "log", data: "x", origin: "A" });
  ok(me.frames().length === 0, "同 origin 的订阅者不该收到（会重复应用两遍）");
  ok(other.frames().length === 1, "别人的订阅者应该收到");
  // 服务端自己发的（无 origin）两边都要收到
  hub.publish({ event: "changed", data: {} });
  ok(me.frames().length === 1 && other.frames().length === 2, "无 origin 的事件应广播给所有人");
}

// 4) 摘掉之后不再收到
{
  const hub = new Hub();
  const s = fakeSink("");
  const off = hub.attach(s);
  hub.publish({ event: "log", data: "before" });
  off();
  hub.publish({ event: "log", data: "after" });
  ok(s.frames().length === 1, `摘掉后不该再收到，实际收到 ${s.frames().length} 条`);
  ok(hub.clientCount === 0, `摘掉后 clientCount 应为 0，实际 ${hub.clientCount}`);
}

// 5) 环形缓冲：只留最近 keep 条
{
  const hub = new Hub(3);
  for (let i = 1; i <= 5; i++) {
    hub.publish({ event: "log", data: String(i) });
  }
  const late = fakeSink("");
  hub.attach(late);
  hub.replay(late, 0); // 新连接不补
  ok(late.frames().length === 0, "新连接（lastId=0）不该补发任何旧事件");
  const back = fakeSink("");
  hub.attach(back);
  hub.replay(back, 2); // 断在 2：应补 3/4/5
  const ids = back.frames().map((f) => f.id);
  ok(JSON.stringify(ids) === "[3,4,5]", `应补 3,4,5，实际 ${JSON.stringify(ids)}`);
}

// 6) 断太久（缓冲里已经没有那个断点）→ 发 reset 让前端整表重读
{
  const hub = new Hub(2);
  for (let i = 1; i <= 6; i++) {
    hub.publish({ event: "log", data: String(i) });
  }
  const s = fakeSink("");
  hub.attach(s);
  hub.replay(s, 1); // 断在 1，但缓冲只剩 5/6
  const f = s.frames();
  ok(f.length === 1 && f[0].event === "reset", `应只发一条 reset，实际 ${JSON.stringify(f.map((x) => x.event))}`);
}

// 7) 订阅者写失败不把 publish 带崩，并且那个订阅者被摘掉
{
  const hub = new Hub();
  const bad = {
    origin: "",
    write: () => {
      throw new Error("连接已断");
    },
    end: () => undefined,
  };
  const good = fakeSink("");
  hub.attach(bad);
  hub.attach(good);
  let threw = false;
  try {
    hub.publish({ event: "log", data: "x" });
  } catch {
    threw = true;
  }
  ok(!threw, "publish 不能因为某个订阅者写失败而抛出去（调用方是后台任务）");
  ok(hub.clientCount === 1, `坏订阅者应被摘掉，剩 1 个，实际 ${hub.clientCount}`);
  ok(good.frames().length === 1, "好订阅者照样收到");
}

// 8) data 里的换行必须拆成多行 `data:`（否则浏览器按第一个换行截断，前端拿到半个 JSON）
{
  const hub = new Hub();
  const s = fakeSink("");
  hub.attach(s);
  hub.publish({ event: "log", data: "第一行\n第二行" });
  const raw = s.got.join("");
  ok(raw.includes("data: 第一行\ndata: 第二行"), `换行没拆开：${JSON.stringify(raw)}`);
  ok(s.frames()[0].data === "第一行\n第二行", "拆开后合并回来应与原文一致");
}

// 9) 字符串 data 原样发（不做二次 JSON 编码：前端按文本处理日志）
{
  const hub = new Hub();
  const s = fakeSink("");
  hub.attach(s);
  hub.publish({ event: "log", data: "📝已记录 L001 卖5退0" });
  ok(s.frames()[0].data === "📝已记录 L001 卖5退0", "字符串 data 应原样发");
}

// 10) formatFrame 的形状：id / event / data 三行 + 空行结尾
{
  const text = formatFrame({ id: 9, event: "toast", data: "{}", origin: "A" });
  ok(text === 'id: 9\nevent: toast\ndata: {}\n\n', `线格式不对：${JSON.stringify(text)}`);
}

// 11) closeAll：全部断开 + 计数归零
{
  const hub = new Hub();
  const s1 = fakeSink("");
  const s2 = fakeSink("");
  hub.attach(s1);
  hub.attach(s2);
  hub.closeAll();
  ok(hub.clientCount === 0, "closeAll 后应没有订阅者");
  ok(s1.got.includes("<end>") && s2.got.includes("<end>"), "closeAll 应把每个连接 end 掉");
}

// ------------------------------------------------ 请求收集器（httpHost.makeRequestSink）
// 这一段钉的是"实时推送最容易静悄悄出错"的两条规则，改坏了真机上表现为
// 「别人看得见、点了按钮的人自己看不见」——所以必须有断言守着。
let reqCases = 0;
{
  const { makeRequestSink, sinkPost, sinkLog } = require(path.join(root, "out", "server", "httpHost.js"));
  const published = [];
  const sink = makeRequestSink("PHONE-1", (e) => published.push(e));

  // 12) 请求在飞：两个数组照收，实时推送也照发，且标着发起人（中枢会跳过他自己）
  reqCases++;
  sinkPost(sink, { type: "productsDelta", products: [{ id: 1 }] });
  sinkLog(sink, "📝已记录 L001 卖5退0");
  ok(sink.posts.length === 1 && sink.logs.length === 1, "请求在飞时 posts/logs 都要收");
  ok(published.length === 2, `实时推送也应收到 2 条，实际 ${published.length}`);
  ok(
    published.every((e) => e.origin === "PHONE-1"),
    "请求在飞时 origin 必须是发起人（否则他会把同一件事应用两遍）",
  );
  ok(published[0].event === "post" && published[1].event === "log", "事件名要区分 post / log");

  // 13) detach 之后：数组不再增长（后台任务跑几分钟不能一直往里堆），但实时推送照旧 ——
  //     而且 origin 必须清空，否则点了按钮的那台手机永远收不到自己触发的进度
  reqCases++;
  sink.detached = true;
  sinkLog(sink, "…共享缩略图 50/156（新生成 40、已有 10、失败 0）");
  sinkPost(sink, { type: "toast", text: "完成" });
  ok(sink.posts.length === 1 && sink.logs.length === 1, "detach 后不该再往 posts/logs 里堆（那是内存只增不减）");
  ok(published.length === 4, `detach 后实时推送仍应收到，实际共 ${published.length} 条`);
  ok(
    published[2].origin === "" && published[3].origin === "",
    "detach 后 origin 必须清空（发起人自己也要收得到后台进度）",
  );

  // 14) 多行日志原样交给接收方（前端按行拆进日志区），不在这里做裁剪
  reqCases++;
  const sink2 = makeRequestSink("PHONE-2", (e) => published.push(e));
  sinkLog(sink2, "第一行\n第二行");
  ok(published[4].data === "第一行\n第二行", "多行日志应原样传出");
  ok(sink2.logs[0] === "第一行\n第二行", "数组里也应是原文一行（前端自己拆）");
}

// ------------------------------------------------ 写串行化 / 重活排队（serialQueue.ts）
let queueCases = 0;
{
  const { SerialQueue } = require(path.join(root, "out", "server", "serialQueue.js"));

  // 15) 并发=1：同时丢 5 个进去，任何时刻在跑的都不超过 1 个
  queueCases++;
  const q = new SerialQueue("测试");
  let running = 0;
  let maxRunning = 0;
  const order = [];
  const mk = (i) =>
    q.run(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      order.push(i);
      running--;
      return i;
    });
  const results = await Promise.all([1, 2, 3, 4, 5].map(mk));
  ok(maxRunning === 1, `同一时刻最多只能有 1 个在跑，实际峰值 ${maxRunning}`);
  ok(JSON.stringify(order) === "[1,2,3,4,5]", `应按进队顺序跑完，实际 ${JSON.stringify(order)}`);
  ok(JSON.stringify(results) === "[1,2,3,4,5]", "每个调用的返回值应是它自己任务的结果");
  ok(q.depth === 0 && !q.busy, `跑完后队列应为空，实际 depth=${q.depth}`);

  // 16) depth 能看到"前面还有几个"（排队时不能是 0，否则界面没法显示"你是第 N 位"）
  queueCases++;
  const q2 = new SerialQueue("测试2");
  let seenDepth = 0;
  const slow = q2.run(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const waiting = q2.run(async () => {
    seenDepth = q2.depth; // 这个任务开始跑时，前面那个还没跑完
  });
  ok(q2.depth === 2, `两个任务在队里时 depth 应为 2，实际 ${q2.depth}`);
  await Promise.all([slow, waiting]);
  ok(seenDepth === 1, `轮到自己时应该只剩自己在跑，实际 depth=${seenDepth}`);

  // 17) 一个任务抛错：错误沿它自己的 Promise 出去，后面排队的照跑
  //     （这条最要紧：一个用户输入出错不能把别人的保存卡死）
  queueCases++;
  const q3 = new SerialQueue("测试3");
  const bad = q3.run(() => {
    throw new Error("故意失败");
  });
  let caught = "";
  try {
    await bad;
  } catch (err) {
    caught = err.message;
  }
  ok(caught === "故意失败", `失败任务的错误应原样抛给调用方，实际 "${caught}"`);
  const after = await q3.run(() => "后面这个照样跑");
  ok(after === "后面这个照样跑", "前一个失败后，后面排队的必须照跑");
  ok(q3.depth === 0, "失败也不该把队列卡住");
}

// ------------------------------------------------ 重活队列（taskQueue.ts）
let taskCases = 0;
{
  const { TaskQueue } = require(path.join(root, "out", "server", "taskQueue.js"));

  // 21) 三种不同名字的重活同时丢进去，任何时刻只跑一个，且按进队顺序
  taskCases++;
  const tq = new TaskQueue();
  const seen = [];
  const states = [];
  tq.onChange((s) => states.push(`${s.running}|${s.waiting.join("+")}`));
  let running = 0;
  let maxRunning = 0;
  const mk = (name) => () =>
    new Promise((resolve) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      seen.push(name);
      setTimeout(() => {
        running--;
        resolve();
      }, 8);
    });
  tq.enqueue("生成共享缩略图", mk("生成共享缩略图"));
  tq.enqueue("生成九宫格", mk("生成九宫格"));
  tq.enqueue("生成九宫格", mk("生成九宫格"));
  ok(tq.depth === 3, `刚进队时 depth 应为 3，实际 ${tq.depth}`);
  ok(
    JSON.stringify(tq.status().waiting) === '["生成共享缩略图","生成九宫格","生成九宫格"]',
    `排队顺序应保持进队顺序，实际 ${JSON.stringify(tq.status().waiting)}`,
  );
  // 等它跑完（8ms × 3 + 余量）
  await new Promise((r) => setTimeout(r, 120));
  ok(maxRunning === 1, `重活同一时刻只能跑一个，实际峰值 ${maxRunning}`);
  ok(
    JSON.stringify(seen) === '["生成共享缩略图","生成九宫格","生成九宫格"]',
    `必须按进队顺序跑，实际 ${JSON.stringify(seen)}`,
  );
  ok(tq.depth === 0 && tq.status().running === "", `跑完后队列应空闲，实际 ${JSON.stringify(tq.status())}`);

  // 22) 状态变化要广播出去（手机上「正在生成 X / 前面还有 N 个」就靠它）
  taskCases++;
  ok(states.length >= 3, `每次进出队都该广播状态，实际只广播了 ${states.length} 次`);
  ok(
    states.some((s) => s.startsWith("生成共享缩略图|")),
    `广播里应出现过 running=生成共享缩略图，实际 ${JSON.stringify(states.slice(0, 4))}`,
  );
  ok(
    states[states.length - 1] === "|",
    `最后一次广播应该是"跑完了"（running 空、没人排队），实际 ${states[states.length - 1]}`,
  );

  // 23) 一个任务抛错：错误交给 onError、队列继续（不能卡死后面排队的）
  taskCases++;
  const errs = [];
  const tq2 = new TaskQueue((name, err) => errs.push(`${name}:${err.message}`));
  let afterRan = false;
  tq2.enqueue("会失败的任务", () => {
    throw new Error("故意失败");
  });
  tq2.enqueue("后面的任务", async () => {
    afterRan = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  ok(errs.length === 1 && errs[0] === "会失败的任务:故意失败", `错误应交给 onError，实际 ${JSON.stringify(errs)}`);
  ok(afterRan, "前一个任务失败后，后面排队的必须照跑");
  ok(tq2.depth === 0, "失败不该把队列卡住");

  // 24) 排队期间**不许**开始干活（传的是工厂，不是已经开始的 Promise）——
  //     这条是"排队"有没有意义的关键：否则排队只是把 IO 提前了
  taskCases++;
  const tq3 = new TaskQueue();
  let started = 0;
  const blocker = new Promise((r) => setTimeout(r, 40));
  tq3.enqueue("占着的那一个", async () => {
    started++;
    await blocker;
  });
  tq3.enqueue("还在排队的那个", async () => {
    started++;
  });
  await new Promise((r) => setTimeout(r, 10));
  ok(started === 1, `排队中的任务不该已经开始，实际已开始 ${started} 个`);
  await new Promise((r) => setTimeout(r, 80));
  ok(started === 2, `两个最终都要跑，实际 ${started}`);
}

// ------------------------------------------------ 接线断言（源码级）
// 串行化依赖两件事同时成立：① shopTool 导出 isWriteAction（清单只有一处）；
// ② 服务端的 invoke 真的用它决定排队。少任何一条，这个功能就静默失效了
// （表现是"偶尔丢一次写"，最难查的那种），所以用源码断言钉住。
let wiringCases = 0;
{
  const shopIndex = fs.readFileSync(path.join(root, "src", "tools", "shopTool", "index.ts"), "utf8");
  const serverIndex = fs.readFileSync(path.join(root, "src", "server", "index.ts"), "utf8");

  wiringCases++;
  ok(
    /export function isWriteAction\(type: string\): boolean \{\s*return WRITE_ACTIONS\.has\(type\)/.test(
      shopIndex,
    ),
    "shopTool/index.ts 里应导出 isWriteAction，且直接转发 WRITE_ACTIONS（不许另抄一份清单）",
  );

  wiringCases++;
  ok(
    /isWriteAction\(type\)/.test(serverIndex) && /writeLock\.run\(run\)/.test(serverIndex),
    "服务端 invoke 必须用 isWriteAction 判断、并让写请求走 writeLock.run（串行化）",
  );

  wiringCases++;
  ok(
    /event: "changed"/.test(serverIndex),
    "服务端应发 changed 事件（没它前端不会提示「有改动」）",
  );

  // 长活儿那两处必须真的走 runLongTask：少一处就是"网页版上两个人同时点生成把共享盘打满"，
  // 或者"那个请求挂几分钟" —— 都属于不报错但很难受的那类。
  const imgSrc = fs.readFileSync(path.join(root, "src", "tools", "shopTool", "handlers", "image.ts"), "utf8");
  const liveSrc = fs.readFileSync(path.join(root, "src", "tools", "shopTool", "handlers", "live.ts"), "utf8");
  wiringCases++;
  ok(
    /runLongTask\(h, "生成共享缩略图"/.test(imgSrc),
    "buildSharedThumbs 必须走 runLongTask（否则网页版不排队、进度也回不到手机）",
  );
  wiringCases++;
  ok(
    /return runLongTask\(h, "生成九宫格"/.test(liveSrc),
    "generateLiveGrid 必须 return runLongTask（保住「await 能等到跑完」的既有语义，同时网页版立刻返回）",
  );
  wiringCases++;
  ok(
    /tasks\.enqueue\(name, run\)/.test(fs.readFileSync(path.join(root, "src", "server", "httpHost.ts"), "utf8")),
    "网页版宿主必须把 longTask 接到服务端队列上（TaskQueue.enqueue）",
  );
  wiringCases++;
  ok(
    /export function runLongTask\(/.test(
      fs.readFileSync(path.join(root, "src", "tools", "shopTool", "handlers", "types.ts"), "utf8"),
    ),
    "runLongTask 必须存在（长活儿的唯一入口；假 ctx 没有 longTask 时靠它兜底）",
  );
  wiringCases++;
  ok(
    /new TaskQueue\(/.test(serverIndex) && /tasks\.onChange\(/.test(serverIndex),
    "服务端要建重活队列，并把状态变化（queue 事件）广播出去",
  );
}

// ------------------------------------------------ 「该不该发 changed」（events.shouldAnnounceChange）
let changeCases = 0;
{
  const { shouldAnnounceChange } = require(path.join(root, "out", "server", "events.js"));

  // 18) 写成功 + 一条回推都没有 → 必须提醒（别人毫无知觉）
  changeCases++;
  ok(shouldAnnounceChange(true, 0) === true, "写成功但没回推 → 应该发 changed");

  // 19) 写成功 + 有回推 → 别再打扰（别人靠回推已经同步了）
  changeCases++;
  ok(shouldAnnounceChange(true, 3) === false, "写成功且有回推 → 不该再发 changed（会没事就亮角标）");

  // 20) 没写进库（改了不存在的商品 / 校验没过）→ 什么都不该发
  changeCases++;
  ok(shouldAnnounceChange(false, 0) === false, "没真写进库 → 不该发 changed");
}

// ------------------------------------------------ 长活儿入口（runLongTask）
// 这一组守的是**兼容性**：加接缝之前，handler 是"直接跑"的，想等的调用方 await 就能等到跑完
// （VS Code 版与那一批手写假 ctx 的测试都依赖它）。接缝加进来以后必须还是这样，
// 否则表现是"await generateLiveGrid(...) 立刻返回、后面的断言看见半成品"——
// 而这类失败在真机上要翻很久。
let seamCases = 0;
{
  const { runLongTask } = require(path.join(root, "out", "tools", "shopTool", "handlers", "types.js"));

  // 25) 宿主实现了 longTask：原样转发，返回值照给
  seamCases++;
  let calledName = "";
  const forwarded = runLongTask(
    { longTask: (n, r) => { calledName = n; return r(); } },
    "生成九宫格",
    async () => "跑完了",
  );
  ok(calledName === "生成九宫格", `应把任务名原样转给宿主，实际 "${calledName}"`);
  ok((await forwarded) === "跑完了", "宿主实现的返回值应原样交给调用方");

  // 26) 宿主没实现（测试里的假 ctx / 将来别的宿主）：立刻跑，且**返回 Promise**
  seamCases++;
  let finished = false;
  const p = runLongTask({}, "生成九宫格", async () => {
    await new Promise((r) => setTimeout(r, 20));
    finished = true;
  });
  ok(finished === false, "没实现 longTask 时应立刻开跑（异步进行中，不是同步就完成）");
  ok(typeof p?.then === "function", "没实现 longTask 时也必须返回 Promise（否则 await 的语义就丢了）");
  await p;
  ok(finished === true, "await 之后必须真的跑完了 —— VS Code 版与测试都靠这条");
}

// ---------------------------------------------------------------- 汇总
if (fails.length > 0) {
  console.error(`❌ check-server-units：${fails.length} 项不通过`);
  for (const f of fails) {
    console.error(`   - ${f}`);
  }
  process.exit(1);
}
console.log(
  `✅ check-server-units：EventHub 11 组 + 请求收集器 ${reqCases} 组 + 串行队列 ${queueCases} 组` +
    ` + 重活队列 ${taskCases} 组 + changed 判定 ${changeCases} 组 + 长活儿入口 ${seamCases} 组` +
    ` + 接线断言 ${wiringCases} 组，共 ${11 + reqCases + queueCases + taskCases + changeCases + seamCases + wiringCases} 组用例全通过`,
);
})().catch((err) => {
  // 用例本身崩了（不是断言失败）也要非零退出，否则 CI 会把它当通过
  console.error(`❌ check-server-units 跑挂了：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
