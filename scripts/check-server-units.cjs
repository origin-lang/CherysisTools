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

// 12) 定向（target）：**只发给那一个**，别人一条都看不到
//     —— 这就是「手机上点导出、电脑那台也下载一份」的病根，别退回广播
{
  const hub = new Hub();
  const phone = fakeSink("PHONE");
  const pc = fakeSink("PC");
  hub.attach(phone);
  hub.attach(pc);
  hub.publish({
    event: "post",
    data: { type: "purchaseXlsxDone", b64: "AAA" },
    origin: "OTHER",
    target: "PHONE",
  });
  ok(phone.frames().length === 1, `定向帧应发给 target，实际 ${phone.frames().length} 条`);
  ok(
    pc.frames().length === 0,
    `定向帧绝不该发给别人，实际 ${pc.frames().length} 条（回去了就是"手机点导出、电脑也下载"）`,
  );
}

// 13) 定向帧**不按 origin 跳过**：target 与发信人同一个连接时也必须发
//     （长任务脱钩后 origin 已经空了，靠它判不出来；况且发信人往往正是唯一该收的人）
{
  const hub = new Hub();
  const s = fakeSink("PHONE");
  hub.attach(s);
  hub.publish({ event: "post", data: {}, origin: "PHONE", target: "PHONE" });
  ok(s.frames().length === 1, "target 与 origin 相同时也要发（定向优先于「跳过自己」）");
}

// 14) 定向帧**不进环形缓冲**：既不该补发给别人，也怕一两 MB 的帧撑爆内存
{
  const hub = new Hub(5);
  hub.publish({ event: "log", data: "a" }); // id 1
  hub.publish({ event: "post", data: { b64: "x".repeat(64) }, target: "PHONE" }); // id 2（不该入缓冲）
  hub.publish({ event: "log", data: "b" }); // id 3
  const s = fakeSink("PHONE");
  hub.attach(s);
  hub.replay(s, 1); // 断在 1
  const f = s.frames();
  ok(
    f.length === 1 && f[0].event === "log" && f[0].id === 3,
    `定向帧不该进环形缓冲（补发 = 推给另一台设备），实际补发 ${JSON.stringify(f.map((x) => x.event + x.id))}`,
  );
}

// ------------------------------------------------ 请求收集器（httpHost.makeRequestSink）
// 这一段钉的是"实时推送最容易静悄悄出错"的两条规则，改坏了真机上表现为
// 「别人看得见、点了按钮的人自己看不见」——所以必须有断言守着。
let reqCases = 0;
{
  const { makeRequestSink, sinkPost, sinkLog } = require(path.join(root, "out", "server", "httpHost.js"));
  const published = [];
  const sink = makeRequestSink("PHONE-1", (e) => published.push(e));

  // 15) 请求在飞：两个数组照收，实时推送也照发，且标着发起人（中枢会跳过他自己）
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

  // 16) detach 之后：数组不再增长（后台任务跑几分钟不能一直往里堆），但实时推送照旧 ——
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

  // 17) 多行日志原样交给接收方（前端按行拆进日志区），不在这里做裁剪
  reqCases++;
  const sink2 = makeRequestSink("PHONE-2", (e) => published.push(e));
  sinkLog(sink2, "第一行\n第二行");
  ok(published[4].data === "第一行\n第二行", "多行日志应原样传出");
  ok(sink2.logs[0] === "第一行\n第二行", "数组里也应是原文一行（前端自己拆）");

  // 18) 「只回发起人」+ 请求还在飞 → **一条都不推**：
  //     结果已经随这个请求的响应回去了，再推一遍就是应用两遍；推给别人更没道理
  reqCases++;
  const targeted = [];
  const sink3 = makeRequestSink("PHONE-3", (e) => targeted.push(e));
  sinkPost(sink3, { type: "purchaseXlsxDone", b64: "AAA" }, { toRequester: true });
  sinkLog(sink3, "📊已生成进货单 Excel", { toRequester: true });
  ok(
    sink3.posts.length === 1 && sink3.logs.length === 1,
    "请求在飞时「只回发起人」的 post/log 仍要收进数组（随响应回去）",
  );
  ok(targeted.length === 0, `请求在飞时不该再推 SSE，实际 ${targeted.length} 条（会两遍）`);

  // 19) 「只回发起人」+ 已脱钩 → 定向推给发起人（target = clientId）
  reqCases++;
  sink3.detached = true;
  sinkPost(sink3, { type: "purchaseXlsxDone", b64: "AAA" }, { toRequester: true });
  ok(targeted.length === 1, `脱钩后必须推出去（否则点导出的人收不到文件），实际 ${targeted.length} 条`);
  ok(targeted[0].target === "PHONE-3", `target 必须是发起人，实际 "${targeted[0].target}"`);
  ok(targeted[0].origin === "", "定向帧的 origin 应为空（脱钩后本来就没有发起人可标）");

  // 20) 没带 clientId（curl 调试 / 很早以前的缓存页面）→ **退回广播**：
  //     宁可多发给别人，也不能让点了按钮的那台什么都收不到
  reqCases++;
  const fallback = [];
  const sink4 = makeRequestSink("", (e) => fallback.push(e));
  sink4.detached = true;
  sinkPost(sink4, { type: "purchaseXlsxDone" }, { toRequester: true });
  ok(
    fallback.length === 1 && !fallback[0].target,
    "没有 clientId 时要退回广播（target 空串），不能把结果发丢",
  );
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

  // ---- 删成品那条路由（2026-10-18）----
  // 这是整个服务里唯一删文件的地方，而目标目录里还躺着进货单导出的 xlsx。
  // 三条硬门槛，少一条就可能把他的进货单删了：
  //   ① 只收 POST；② all 的候选只从 listArtifacts 来（jpg/png/html）；
  //   ③ 每个名字再过 isArtifactName + resolveArtifact。
  // ⚠️ index.ts 是 CRLF：写成 \n 结尾永远匹配不到（这次就栽了一回）
  const delBlock = /if \(p === "\/api\/live\/delete"\)([\s\S]*?)\r?\n      \}\r?\n/.exec(serverIndex);
  wiringCases++;
  ok(!!delBlock, "要有 /api/live/delete 路由（手机「已生成」层要能删、能清空）");
  wiringCases++;
  ok(
    !delBlock || /req\.method !== "POST"/.test(delBlock[1]),
    "/api/live/delete 必须只收 POST（GET 一条链接就能删文件太危险）",
  );
  wiringCases++;
  ok(
    !delBlock || /body\.all === true[\s\S]{0,200}?listArtifacts\(dir/.test(delBlock[1]),
    "delete 的 all 分支必须从 listArtifacts 取候选：那个目录里还有进货单的 xlsx，按 readdirSync 全删就完了",
  );
  wiringCases++;
  ok(
    !delBlock || !/readdirSync/.test(delBlock[1]),
    "delete 里不许出现 readdirSync：删除只能按白名单走，不能\"列目录然后全删\"",
  );
  wiringCases++;
  ok(
    !delBlock || /!isArtifactName\(n\)[\s\S]{0,160}?resolveArtifact\(dir, n\)/.test(delBlock[1]),
    "delete 每个名字都要过 isArtifactName + resolveArtifact 两道（扩展名白名单 + 路径不许逃出目录）",
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

  // 「只回发起人」这条链路有三段，缺任何一段都静默失效（表现就是老板说的
  // "我手机上点导出，电脑上也跟着下载"）：handler 带 toRequester → post 透传 opts →
  // httpHost 变成 target。三段都钉住。
  const purchaseSrc = fs.readFileSync(
    path.join(root, "src", "tools", "shopTool", "handlers", "purchase.ts"),
    "utf8",
  );
  wiringCases++;
  ok(
    /const postMe = \(m: any\) => post\(m, \{ toRequester: true \}\)/.test(purchaseSrc) &&
      /const logMe = \(s: string\) => log\(s, \{ toRequester: true \}\)/.test(purchaseSrc),
    "进货单导出必须走 postMe / logMe（只回发起人），否则手机点导出、电脑那台也下载一份",
  );
  wiringCases++;
  ok(
    (purchaseSrc.match(/postMe\(\{\s*type: "purchaseXlsxDone"/g) || []).length === 3 &&
      !/\bpost\(\{\s*type: "purchaseXlsxDone"/.test(purchaseSrc),
    "purchaseXlsxDone 的三条出口（成功 / 空单 / 出错）都必须走 postMe，不许有裸 post",
  );
  wiringCases++;
  ok(
    (purchaseSrc.match(/logMe\(/g) || []).length >= 4 && !/\blog\("⏭️已有一个导出任务在跑/.test(purchaseSrc),
    "导出的日志也要跟着走 logMe（否则别人的日志区会冒出你没点过的导出记录）",
  );
  wiringCases++;
  ok(
    /post: \(m, opts\) => ctx\.postToWebview\(m, opts\)/.test(shopIndex),
    "shopTool/index.ts 的 post 必须把 opts 透传给宿主（漏了等于定向从未生效）",
  );
  wiringCases++;
  ok(
    /sinkPost\(sink, msg, opts\)/.test(fs.readFileSync(path.join(root, "src", "server", "httpHost.ts"), "utf8")),
    "httpHost 的 postToWebview 必须把 opts 交给 sinkPost（否则 target 永远为空 = 还是广播）",
  );

  // ------------------------------------------------ 外网访问（cloudflared 快速隧道）
  //
  // 这一组的由来：地址是 Cloudflare **每次现分配**的，所以"谁去抓、谁去显示"必须钉死，
  // 一旦有人想省事在面板里拼一个 / 或者把上次的地址记住，表现就是"面板显示的和真的不是一个"，
  // 而这种事在真机上极难查（看起来就是"链接打不开"）。
  /**
   * 断言「不许出现某参数」之前必须先剥注释 —— 注释里写着"别加 --protocol"，
   * 不剥的话正则命中的正是那句劝告（这坑在手机版那边也踩过两次）。
   * `(^|[^:])` 是为了不把 `http://` 当成行注释。
   */
  const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const tunnelSrc = fs.readFileSync(path.join(root, "src", "server", "tunnel.ts"), "utf8");
  const serverIndexSrc = fs.readFileSync(path.join(root, "src", "server", "index.ts"), "utf8");
  const wsIndexSrc = fs.readFileSync(
    path.join(root, "src", "tools", "webServerTool", "index.ts"),
    "utf8",
  );
  const wsServiceSrc = fs.readFileSync(
    path.join(root, "src", "tools", "webServerTool", "service.ts"),
    "utf8",
  );
  const wsClientSrc = fs.readFileSync(path.join(root, "src", "tools", "webServerTool", "client.js"), "utf8");

  wiringCases++;
  ok(
    /path\.join\(cacheDir, "bin", name\)/.test(tunnelSrc) &&
      /"cloudflared\.exe"/.test(tunnelSrc),
    "cloudflared 必须放 <cacheDir>/bin 下：放 .workbuddy 里跑会因加载 iphlpapi.dll 被拒直接 panic",
  );
  wiringCases++;
  ok(
    /\["tunnel", "--url", `http:\/\/127\.0\.0\.1:\$\{opts\.port\}`, "--no-autoupdate", "--logfile", logPath\]/.test(
      tunnelSrc,
    ),
    "启动参数必须是 tunnel --url http://127.0.0.1:<port> --no-autoupdate --logfile <文件>（少 --no-autoupdate 会自己升级把进程换掉）",
  );
  wiringCases++;
  ok(
    !/--protocol/.test(noComments(tunnelSrc)),
    "别给 cloudflared 加 --protocol http2：实测 2.0s，QUIC 只要 1.1~1.5s",
  );
  wiringCases++;
  ok(
    tunnelSrc.includes("trycloudflare") &&
      /function urlFromLog/.test(tunnelSrc) &&
      /st\.url = url;/.test(tunnelSrc),
    "外网地址必须从 cloudflared 写出的日志里抓（域名是它现分配的），不许自己拼",
  );
  wiringCases++;
  ok(
    /delay = Math\.min\(WATCH_MS \* st\.restarts, SLOW_RETRY_MS\)/.test(tunnelSrc) &&
      /setTimeout\(tick, delay\)/.test(tunnelSrc),
    "看门人要退避重试（30s 起、最长 5 分钟）；别退回到固定间隔狂起进程",
  );
  wiringCases++;
  ok(
    !/POLL_MAX/.test(noComments(tunnelSrc)),
    "拿地址不许「等 N 次就放弃」：开机自启时网络常常还没就绪，早早放弃 = 开机后外网一直打不开",
  );
  wiringCases++;
  ok(
    /🔒 密码：\$\{cfg\.password\}/.test(serverIndexSrc),
    "启动横幅要把密码直接打出来（窗口是本机的，他自己人要能一眼看到；藏起来只会让他回头翻配置文件）",
  );
  // 2026-10-18：老板把服务交给别人用，发现「别人那边没有密码」——那台机器上配置是自动生成的，
  // 只有 storageDir/imageDir/port 三项，压根看不见还有 password 这回事，于是隧道开着、门禁空着。
  // 所以自动生成的配置里**必须显式写出 password**（哪怕是空串），让人知道有这么个开关。
  wiringCases++;
  const webSvcSrc = fs.readFileSync(
    path.join(root, "src", "tools", "webServerTool", "service.ts"),
    "utf8",
  );
  ok(
    /password:\s*""/.test(webSvcSrc),
    "自动生成的配置里必须带 password 字段（哪怕是空串）：少了它，别人的机器上根本不知道还有密码这回事，" +
      "开着外网隧道也以为有密码，实际谁拿到链接谁能改库",
  );
  wiringCases++;
  const exampleCfg = fs.readFileSync(
    path.join(root, "cherysis-server.config.example.json"),
    "utf8",
  );
  ok(
    /"password"\s*:/.test(exampleCfg),
    "示例配置里必须有 password 一栏：大家照着抄的那份少了它，抄完就是没门禁",
  );
  wiringCases++;
  ok(
    /if \(pid && isAlive\(pid\)\) \{[\s\S]{0,140}?st\.restarts = 0/.test(tunnelSrc),
    "隧道活着时看门人只该重置计数，不许重起（重起 = 换地址）",
  );
  wiringCases++;
  ok(
    /tunnel: tunnel \? tunnel\.status\(\) : null/.test(serverIndexSrc),
    "/api/ping 必须带 tunnel 状态：面板和手机都靠它拿地址",
  );
  wiringCases++;
  // 手机设置页那两行地址（2026-10-17）。外网地址必须现取，绝不能写死 —— 隧道重起就换了。
  const mobileAppSrc = fs.readFileSync(path.join(root, "src", "webview", "mobile", "app.js"), "utf8");
  const mobileAppNoC = noComments(mobileAppSrc);
  ok(
    /lanUrls: lanUrls\(cfg\.port\)/.test(serverIndexSrc),
    "/api/ping 必须带内网地址：手机从外面用 4G 打开设置页时，也要能看出「在家该用哪个」",
  );
  wiringCases++;
  ok(
    /function urlRows\(j\)/.test(mobileAppNoC) && /\) \+ urlRows\(j\)/.test(mobileAppNoC),
    "手机设置页「服务」卡片要把内网/外网地址拼进去（老板要能直接复制发人）",
  );
  wiringCases++;
  ok(
    /data-copy="' \+\s*esc\(url\)/.test(mobileAppNoC) && /getAttribute\("data-copy"\)/.test(mobileAppNoC),
    "复制按钮的地址必须走 data-copy 属性：这块每次切页签都重画，塞闭包一重画就丢",
  );
  wiringCases++;
  ok(
    /execCommand\("copy"\)/.test(mobileAppNoC) && /navigator\.clipboard/.test(mobileAppNoC),
    "复制必须留 textarea+execCommand 降级路：局域网是 http，navigator.clipboard 在非 https 下不存在",
  );
  wiringCases++;
  // 脱钩之后这条**反过来了**：退出时停隧道 = 下次新地址 = 已经发出去的链接全废。
  // 要关外网访问只能靠 tunnel: false（那条路会把遗留隧道杀掉）。
  wiringCases++;
  ok(
    !/\btunnel\?\.stop\(\)|\btunnel\.stop\(\)/.test(noComments(serverIndexSrc)),
    "服务退出时不许停隧道（停了地址就换，脱钩白做）；关外网只能走 tunnel: false",
  );
  wiringCases++;
  ok(
    /tunnel: s\.tunnel \|\| null/.test(wsIndexSrc) &&
      /s\.tunnel = s\.running \? await pingTunnel\(s\.port/.test(wsServiceSrc),
    "面板的 wsStatus 必须把 tunnel 带上，否则面板永远显示不出外网地址",
  );
  wiringCases++;
  ok(
    /export function tunnelUrlOf/.test(wsIndexSrc) &&
      /case "copyTunnel":/.test(wsIndexSrc) &&
      /case "openTunnel":/.test(wsIndexSrc),
    "复制/打开外网地址必须在后端校验形状（消息来自 webview，谁都能发）",
  );
  wiringCases++;
  ok(
    /renderTunnel\(s\.tunnel\)/.test(wsClientSrc) &&
      /t\.state === "up" && t\.url/.test(wsClientSrc) &&
      !/tunnelUrl\s*=\s*localStorage/.test(wsClientSrc),
    "面板只显示服务刚给的地址，不许缓存到本地（缓存的那个下次一定是死的）",
  );

  // ---- 脱钩（B 方案）：让地址在"服务重启"时不变 ----
  wiringCases++;
  ok(
    /detached: true/.test(tunnelSrc) && /\.unref\(\)/.test(tunnelSrc),
    "隧道必须脱钩（detached + unref），否则服务一退出它就跟着死 = 又换一个地址",
  );
  wiringCases++;
  ok(
    /"--logfile", logPath/.test(tunnelSrc) && /stdio: "ignore"/.test(tunnelSrc),
    "必须让 cloudflared 自己写 --logfile 并断开 stdout 管道：脱钩后管道一断它就会挂",
  );
  wiringCases++;
  ok(
    /meta\.port === opts\.port && isAlive\(meta\.pid\)/.test(tunnelSrc),
    "启动时必须先试着接管旧隧道（pid 活着 + 端口对得上）；不接管就等于每次启动都换地址",
  );
  wiringCases++;
  ok(/WATCH_MS/.test(tunnelSrc) && /const startWatch/.test(tunnelSrc), "看门人必须存在（否则隧道崩了就再没人管）");
  wiringCases++;
  ok(
    /if \(opts\.enabled === false\) \{[\s\S]{0,160}?killAll\(\)/.test(tunnelSrc),
    "tunnel: false 启动时必须把遗留隧道杀掉，否则「关不掉外网访问」",
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

// ------------------------------------------------ 二进制落点（cloudflaredPath）
// 只测这个纯函数，但它是那次 panic 的直接教训：**同一份 exe 换个目录就能跑**，
// 所以"落点必须算得出来、必须落在 <cacheDir>/bin"这件事得钉住 ——
// 有人为了"方便"把它挪回项目目录/临时目录，下次就是又一轮 `iphlpapi.dll` 的坑。
let tunnelCases = 0;
{
  const { cloudflaredPath } = require(path.join(root, "out", "server", "tunnel.js"));
  const base = path.join(root, "tmp", "cache");
  tunnelCases++;
  ok(
    path.dirname(cloudflaredPath(base)) === path.join(base, "bin"),
    "cloudflared 必须落在 <cacheDir>/bin 里（放 .workbuddy 目录下会被安全策略拦到 panic）",
  );
  tunnelCases++;
  ok(
    path.basename(cloudflaredPath(base)) === (process.platform === "win32" ? "cloudflared.exe" : "cloudflared"),
    "文件名要带平台后缀（Windows 上少了 .exe 直接起不来）",
  );
}

// ------------------------------------------------ 外网密码门（gate.ts）
//
// 这一组守的是"外网要密码、局域网不要"这条口径，以及票本身的强度。
// 一旦有人图省事把 cookie 换成明文密码、或者把"只拦隧道"改成"拦所有"，
// 表现分别是"谁都能进"和"在家打开也要输密码"——两种都很难在真机上一眼看出。
let gateCases = 0;
{
  const {
    makeTicket,
    checkTicket,
    readCookie,
    isFromTunnel,
    safeNext,
    tooManyFails,
    noteFail,
    noteOk,
    ticketCookie,
    lockLeftMs,
    lockText,
    listLocks,
    unlockIp,
    unlockAll,
    loadLocks,
    MAX_FAILS,
    FAIL_WINDOW_MS,
    LOCK_MS,
    GATE_COOKIE,
  } = require(path.join(root, "out", "server", "gate.js"));

  const PW = "202610171997";
  const future = Date.now() + 86400000;

  gateCases++;
  ok(checkTicket(PW, makeTicket(PW, future)) === true, "自己签的票必须验得过（否则登录成功也进不去）");

  gateCases++;
  ok(
    checkTicket(PW, makeTicket(PW, Date.now() - 1000)) === false,
    "过期的票必须验不过（不然一次登录永久有效）",
  );

  gateCases++;
  ok(
    checkTicket(PW, makeTicket(PW, future).replace(/.$/, "x")) === false,
    "签名被改一个字符就必须验不过（这条是防伪造的底线）",
  );

  gateCases++;
  ok(
    checkTicket("别的密码", makeTicket(PW, future)) === false,
    "改密码以后老票必须立刻失效（密钥由密码派生，否则改密码等于没改）",
  );

  gateCases++;
  ok(checkTicket(PW, "") === false && checkTicket(PW, "abc") === false, "空票、乱码一律不许放行");

  gateCases++;
  ok(
    isFromTunnel({ headers: { "cf-ray": "8a1b" } }) === true &&
      isFromTunnel({ headers: { "cf-connecting-ip": "1.2.3.4" } }) === true &&
      isFromTunnel({ headers: {} }) === false,
    "只有带 Cloudflare 头的才算外网；局域网与本机不能拦（否则在家打开也要弹密码）",
  );

  gateCases++;
  ok(
    readCookie({ headers: { cookie: "a=1; " + GATE_COOKIE + "=xyz; b=2" } }, GATE_COOKIE) === "xyz" &&
      readCookie({ headers: {} }, GATE_COOKIE) === "",
    "cookie 要能从一串里正确挑出来（挑错 = 要么谁都能过，要么谁都过不了）",
  );

  gateCases++;
  ok(
    safeNext("/a/b?c=1") === "/a/b?c=1" &&
      safeNext("//evil.com") === "/" &&
      safeNext("https://evil.com") === "/",
    "登录后跳转只认站内路径（不然 ?next=//evil.com 就是个开放重定向）",
  );

  gateCases++;
  const ip = "unit-" + Date.now();
  for (let i = 0; i < 10; i++) {
    noteFail(ip);
  }
  ok(
    tooManyFails(ip) === true,
    "同一 IP 连错 10 次必须被挡住（密码是日期+1997 这种，不防爆破等于没设）",
  );

  gateCases++;
  noteOk(ip);
  ok(tooManyFails(ip) === false, "登录成功必须把失败计数清零（否则成功一次也还是被挡着）");

  // ---- 「5 分钟内错 10 次就关 5 分钟小黑屋」（2026-10-17 晚，他提的防爆破）
  // ⚠️ 这几个函数都吃 now 参数，别用真实时间 —— 用真实时间就只能测"立刻"，测不出窗口边界。
  gateCases++;
  ok(
    MAX_FAILS === 10 && FAIL_WINDOW_MS === 5 * 60_000 && LOCK_MS === 24 * 60 * 60_000,
    "口径必须是「5 分钟里错 10 次 → 关 24 小时」（他说自己人不可能错 10 次，错满就是有人在外面试）",
  );

  gateCases++;
  {
    // 慢慢试：每 61 秒错一次，凑 10 次要 9 分钟 —— 每个窗口里最多只有 5 次，不该被锁
    const slow = "slow-" + Date.now();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) noteFail(slow, t0 + i * 61_000);
    ok(
      tooManyFails(slow, t0 + 9 * 61_000) === false,
      "「5 分钟内的 10 次」才算：隔一分钟错一次的人不该被锁（不然正常手抖也会被关）",
    );
  }

  gateCases++;
  {
    // 快快试：20 秒一次，3 分钟凑够 10 次 → 锁；锁从**最后一次**算，不是从第一次
    const fast = "fast-" + Date.now();
    const base = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) noteFail(fast, base + i * 20_000);
    const lastAt = base + 9 * 20_000;
    ok(
      tooManyFails(fast, lastAt + 4 * 60_000) === true,
      "第 10 次之后 4 分钟还得关着（锁的是 LOCK_MS 那么久，不是「够窗口时间就自动放」）",
    );
  }

  gateCases++;
  {
    const fast = "fast2-" + Date.now();
    const base = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) noteFail(fast, base + i * 20_000);
    const lastAt = base + 9 * 20_000;
    ok(
      lockLeftMs(fast, lastAt) === LOCK_MS &&
        tooManyFails(fast, lastAt + LOCK_MS + 1000) === false,
      "锁的时长必须从最后一次试错起算：从他第一次错算起的话，慢慢试的人等于没锁",
    );
  }

  gateCases++;
  {
    const fx = "mixed-" + Date.now();
    const base = 1_700_000_000_000;
    // 先错 9 次，隔了 6 分钟（窗口早过了）再错 1 次 → 窗口重置，不该锁
    for (let i = 0; i < 9; i++) noteFail(fx, base + i * 1000);
    noteFail(fx, base + 6 * 60_000);
    ok(
      tooManyFails(fx, base + 6 * 60_000) === false,
      "跨出 5 分钟窗口后计数要重置（不然攒够 10 次就永久锁，正常用户会被自己坑死）",
    );
  }

  gateCases++;
  ok(
    /24 小时后再来/.test(lockText(24 * 60 * 60_000)) && /5 分钟后再来/.test(lockText(5 * 60_000)) &&
      /1 分钟后再来/.test(lockText(1)),
    "给用户的话要能看懂（24 小时别写成「1440 分钟」，最少说 1 分钟）",
  );

  // ---- 24 小时锁必须活过重启 + 后台能解（2026-10-17 晚第二拨）
  gateCases++;
  {
    const os = require("os");
    const tmp = path.join(os.tmpdir(), "cherysis-locks-" + process.pid + "-" + Date.now() + ".json");
    const ipP = "persist-" + Date.now();
    const now = Date.now();

    ok(loadLocks(tmp) === 0, "没有落盘文件时应当当没封过人（别让缺文件把服务卡死）");

    for (let i = 0; i < 10; i++) {
      noteFail(ipP, now + i);
    }
    // 文件可能根本没被写出来（变异不落盘时）→ 先看存在性，别让断言变成 ENOENT 崩溃
    const raw = fs.existsSync(tmp) ? fs.readFileSync(tmp, "utf8") : "";
    const disk = raw ? JSON.parse(raw) : {};
    ok(
      !!disk[ipP] && disk[ipP].n === 10,
      "撞线必须落盘：24 小时的锁要是能被「重启一下服务」洗掉，这道锁等于没设",
    );
  }

  gateCases++;
  {
    const list = listLocks();
    const one = list.find((l) => l.ip.indexOf("persist-") === 0);
    ok(
      !!one && one.leftMs > 23 * 60 * 60_000 && one.fails === 10,
      "被封的人要能在后台列表里看到（ip + 还剩多久 + 错了几次），否则「必须后台操作才能放行」落不了地",
    );
  }

  gateCases++;
  {
    const ipP = listLocks().find((l) => l.ip.indexOf("persist-") === 0).ip;
    const had = unlockIp(ipP);
    ok(
      had === true && !listLocks().some((l) => l.ip === ipP),
      "「解除」要真的把人从名单里拿掉（点了还锁着 = 他永远进不来）",
    );
  }

  gateCases++;
  {
    const os = require("os");
    const tmp2 = path.join(os.tmpdir(), "cherysis-locks2-" + process.pid + "-" + Date.now() + ".json");
    const ipR = "restore-" + Date.now();
    fs.writeFileSync(tmp2, JSON.stringify({ [ipR]: { n: 10, first: Date.now(), last: Date.now() } }));
    loadLocks(tmp2);
    ok(
      listLocks().some((l) => l.ip === ipR),
      "重启后要能从磁盘把封禁读回来（读不回来的话，重启一次就白封了）",
    );
  }

  gateCases++;
  {
    const n = unlockAll();
    ok(n >= 1 && listLocks().length === 0, "「全部解除」要能一次清干净（换密码/自己把自己锁了时用）");
  }

  gateCases++;
  ok(
    /HttpOnly/.test(ticketCookie(PW)) && /SameSite=Lax/.test(ticketCookie(PW)),
    "cookie 必须 HttpOnly + SameSite（别让页面脚本读走、别被跨站顺手带上）",
  );

  const gateIndexSrc = fs.readFileSync(path.join(root, "src", "server", "index.ts"), "utf8");
  // 剥注释再断言：注释里写着「不能等下一次」这种话，本身就会被正则命中 → 假绿
  const gateNoC = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  gateCases++;
  ok(
    /if \(cfg\.password && isFromTunnel\(req\)\)/.test(gateIndexSrc),
    "门禁必须只在「配了密码 + 来自隧道」时生效（两条件缺一都会出事）",
  );
  gateCases++;
  ok(
    /p === "\/login"/.test(gateIndexSrc) && /p === "\/api\/login"/.test(gateIndexSrc),
    "登录页和登录接口必须放行，否则重定向到自己 = 死循环",
  );
  gateCases++;
  ok(
    /res\.setHeader\("Set-Cookie", ticketCookie\(cfg\.password\)\)/.test(gateIndexSrc),
    "登录成功必须下发 cookie（不发的话每次刷新都要重输）",
  );
  gateCases++;
  {
    // 接线：429 + Retry-After，而且**撞线的那一次**就要回 429（不能等下一次）
    const noC = gateNoC(gateIndexSrc);
    ok(
      /sendJson\(res, 429/.test(noC) && /Retry-After/.test(noC) && /lockText\(/.test(noC),
      "被关小黑屋要回 429 + Retry-After + 一句人话（401 是「密码错」，429 才是「你被锁了」）",
    );
  }
  gateCases++;
  {
    // 锁着的时候连"密码对了"也不许过：lockLeftMs 的判断必须在比对密码之前
    const noC = gateNoC(gateIndexSrc);
    const atLock = noC.indexOf("const left = lockLeftMs(ip)");
    const atCmp = noC.indexOf("=== cfg.password");
    ok(
      atLock > 0 && atCmp > atLock,
      "小黑屋的判断必须在比对密码之前（放后面 = 爆破的人照样能试，等于没锁）",
    );
  }
  gateCases++;
  {
    // 刚撞线那一次就把话说明白：noteFail 之后还要再看一次 lockLeftMs
    const noC = gateNoC(gateIndexSrc);
    const atFail = noC.indexOf("noteFail(ip)");
    ok(
      atFail > 0 && noC.indexOf("const justLocked = lockLeftMs(ip)") > atFail,
      "第 10 次错的那一下就要回 429 说清楚（不然他还要再点一次才知道被锁了）",
    );
  }
  gateCases++;
  ok(
    /loginHtml\(url\.searchParams\.get\("next"\) \|\| "\/", left > 0 \? lockText\(left\) : ""\)/.test(
      gateNoC(gateIndexSrc),
    ),
    "被锁着的人打开登录页要直接看到「还要等几分钟」（否则只会在那儿一直点按钮）",
  );

  // ---- 落盘 + 后台放行（2026-10-17 晚第二拨）
  gateCases++;
  ok(
    /loadLocks\(path\.join\(cfg\.cacheDir, "gate-locks\.json"\)\)/.test(gateNoC(gateIndexSrc)),
    "启动时必须把封禁名单从磁盘读回来（读不回来 = 重启一次就把 24 小时的锁洗掉了）",
  );
  gateCases++;
  ok(
    /gateLocks: isFromTunnel\(req\) \? \[\] : listLocks\(\)/.test(gateNoC(gateIndexSrc)),
    "被封名单只给局域网看：外网来的人不该知道自己有没有在名单上，更不该能点解除",
  );
  gateCases++;
  {
    const noC = gateNoC(gateIndexSrc);
    const atEp = noC.indexOf('p === "/api/gate/unlock"');
    const near = atEp > 0 ? noC.slice(atEp, atEp + 420) : "";
    ok(
      atEp > 0 && /isFromTunnel\(req\)/.test(near) && /sendJson\(res, 403/.test(near),
      "解除封禁必须拒绝外网请求（被封的人自己点一下就解了，这道锁就等于没锁）",
    );
  }
  gateCases++;
  ok(
    /unlockIp\(ip\) \? 1 : 0/.test(gateNoC(gateIndexSrc)) && /unlockAll\(\)/.test(gateNoC(gateIndexSrc)),
    "解除要能按 IP 解，也要能全部解（换密码、或者自己把自己锁了的时候）",
  );
  gateCases++;
  {
    // 后台那个「解除」得在手机版设置页里点得到，不然"必须后台操作"落不了地
    const mob = gateNoC(
      fs.readFileSync(path.join(root, "src", "webview", "mobile", "app.js"), "utf8"),
    );
    ok(
      /function lockRows\(j\)/.test(mob) &&
        /\) \+ urlRows\(j\) \+ lockRows\(j\)/.test(mob) &&
        /data-unlock="/.test(mob) &&
        /getAttribute\("data-unlock"\)/.test(mob) &&
        /\/api\/gate\/unlock/.test(mob),
      "设置页「服务」卡片里要能看到被封的 IP 并点「解除」（手机/电脑在局域网打开就行）",
    );
  }
}

// ------------------------------------------------- 直播成品只读（2026-10-17 手机版 A 档）
// 手机版「直播」那一格只看已经生成好的九宫格 / HTML 样品，走 /api/live/{list,thumb,file}。
// 这里钉的是**唯一的高危面**：目录里能放任意文件，参数一旦能带 `../` 就是把整台机器开放下载。
{
  const LA = require(path.join(root, "out", "server", "liveArtifacts.js"));
  const liveIndexSrc = fs.readFileSync(path.join(root, "src", "server", "index.ts"), "utf8");
  const liveSrc = fs.readFileSync(path.join(root, "src", "server", "liveArtifacts.ts"), "utf8");
  const idxNoC = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const liveNoC = idxNoC(liveSrc);
  const liveCases = { n: 0 };
  const ck = (cond, msg) => {
    liveCases.n++;
    ok(cond, msg);
  };

  ck(
    typeof LA.isSafeArtifactName === "function" &&
      typeof LA.resolveArtifact === "function" &&
      typeof LA.listArtifacts === "function" &&
      typeof LA.ensureThumb === "function" &&
      typeof LA.mimeOf === "function",
    "liveArtifacts 要导出 名字校验 / 解路径 / 列表 / 缩略图 / MIME 这五样",
  );

  // ---- 名字校验：这一组红一条就等于开了个下载机
  for (const bad of ["../x.jpg", "..\\x.jpg", "a/b.jpg", "a\\b.jpg", "", ".", "..", "C:x.jpg", "a\0.jpg"]) {
    ck(LA.isSafeArtifactName(bad) === false, `名字校验必须挡住 ${JSON.stringify(bad)}（能带分隔符就是路径穿越）`);
  }
  ck(LA.isSafeArtifactName("a".repeat(201) + ".jpg") === false, "名字校验要挡住超长名字（200 字符以上）");
  ck(
    LA.isSafeArtifactName("直播排品样品_20261017.html") === true,
    "正常中文成品名要放行（他的文件全是中文名，挡了就等于没功能）",
  );

  // ---- 解路径：basename 过了还要 resolve 前缀二次校验
  {
    const d = path.join(root, "out");
    ck(LA.resolveArtifact(d, "../package.json") === null, "解路径要挡住 ../package.json（上一级就是仓库根）");
    ck(LA.resolveArtifact(d, "sub/x.jpg") === null, "解路径要挡住带子目录的名字");
    ck(LA.resolveArtifact("", "a.jpg") === null, "目录为空时不许解出路径");
    ck(
      LA.resolveArtifact(d, "x.jpg") === path.join(path.resolve(d), "x.jpg"),
      "合法名字要解成「目录 + 名字」的绝对路径",
    );
  }

  // ---- 列表：只认图片和 html，新的排前面
  {
    const tmp = path.join(root, "tmp-web-test", "live-art-check");
    fs.mkdirSync(tmp, { recursive: true });
    const jpg = path.join(tmp, "九宫格_1.jpg");
    const html = path.join(tmp, "样品_1.html");
    fs.writeFileSync(jpg, Buffer.alloc(1200, 1));
    fs.writeFileSync(html, "<html></html>");
    fs.writeFileSync(path.join(tmp, "不该出现.txt"), "x");
    fs.mkdirSync(path.join(tmp, "假图片.jpg"), { recursive: true }); // 名字像图片的目录
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(jpg, old, old);
    const items = LA.listArtifacts(tmp);
    ck(
      items.length === 2 && items.every((i) => i.name === "九宫格_1.jpg" || i.name === "样品_1.html"),
      "列表只认 jpg/png/html（txt 和「名字像图片的目录」都不许混进来）",
    );
    ck(items[0].name === "样品_1.html", "列表要按修改时间倒序（他要的多半是刚生成的那批）");
    ck(
      items[0].kind === "html" && items[1].kind === "grid",
      "kind 要分开（手机端按它决定是「看长图」还是「存下来转发」）",
    );
    ck(LA.listArtifacts(tmp, 1).length === 1, "limit 要生效");
    ck(LA.listArtifacts(path.join(tmp, "不存在")).length === 0, "目录不在时回空数组，不许抛（手机上会弹一堆错）");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 缩略图缓存键：mtime + 名字哈希，两样都不能少
  {
    const c = path.join(root, "tmp-web-test");
    const a = LA.thumbCachePath(c, "九宫格_1.jpg", 111);
    const b = LA.thumbCachePath(c, "长图_1.jpg", 111);
    const d2 = LA.thumbCachePath(c, "九宫格_1.jpg", 222);
    ck(/111-/.test(path.basename(a)), "缩略图缓存键要带 mtime（不带的话重新生成还是拿旧图）");
    ck(a !== b, "中文名压成下划线后会撞车 → 缓存键必须再把名字哈希算进去（同批两个文件别共用一张缩略图）");
    ck(a !== d2, "同一个名字 mtime 变了要换键");
    ck(/\.webp$/.test(a), "缓存是 webp（手机上一屏挂六七张，jpeg 大一圈）");
  }

  // ---- 接线：三条路由，各道校验都在
  {
    const noC = idxNoC(liveIndexSrc);
    ck(
      /p === "\/api\/live\/list"/.test(noC) &&
        /p === "\/api\/live\/thumb"/.test(noC) &&
        /p === "\/api\/live\/file"/.test(noC),
      "三条接口都要在（列表 / 缩略图 / 原文件）",
    );
    ck(
      (noC.match(/resolveArtifact\(liveOutDir\(\), name\)/g) || []).length === 2,
      "thumb 与 file 都必须过 resolveArtifact —— 直接 path.join(dir, name) 就是下载机",
    );
    ck(
      !/path\.join\((liveOutDir\(\)|dir), *name\)/.test(noC),
      "任何地方都不许用 path.join(目录, 用户给的名字) 拼路径",
    );
    ck(
      noC.indexOf('/api/live/file') > 0 && noC.indexOf('/api/live/file') < noC.indexOf("sendStatic(res, p ==="),
      "三条接口要插在 sendStatic 之前（排在后面会被静态兜底吃掉，永远 404）",
    );
    ck(/Content-Security-Policy/.test(noC) && /img-src data:/.test(noC), "内联预览 HTML 要带 CSP 按住脚本");
    // ⚠️ 光查字符串存在不够：`if (dl) {` 改成 `if (false) {` 时字符串还在，断言照样绿（漏网过一次）。
    //    所以钉结构：Content-Disposition 必须挂在 `if (dl) {` 分支开头那一段里。
    const dlAt = noC.indexOf("if (dl) {");
    const cdAt = noC.indexOf("Content-Disposition");
    ck(
      /url\.searchParams\.get\("dl"\) === "1"/.test(noC) &&
        dlAt > 0 &&
        cdAt > dlAt &&
        cdAt - dlAt < 200 &&
        /"attachment; filename\*=UTF-8''"/.test(noC),
      "?dl=1 要走附件下载（中文名必须 filename*=UTF-8''，否则存下来是乱码）",
    );
    ck(
      /const liveOutDir = \(\): string =>/.test(noC) && /prefs\.get\("live_out_dir"/.test(noC),
      "成品目录要读本机偏好 live_out_dir（跟电脑端生成时同一个目录，别另开一份）",
    );
    ck(
      /fs\.statSync\(d\)\.isDirectory\(\) \? d : ""/.test(noC),
      "成品目录要验活（盘没挂上就回空串，别四处散播 ENOENT）",
    );
  }

  // ---- 模块内部的两条注释级硬规矩（防止以后"优化"掉）
  ck(
    /if \(s\.includes\("\/"\) \|\| s\.includes\("\\\\"\) \|\| s\.includes\("\.\."\)/.test(liveNoC),
    "名字校验里那条「/ \\ .. 空字节一律拒绝」不许拆开写成分散判断（拆开容易漏一条）",
  );
  ck(
    /full\.startsWith\(root \+ path\.sep\)/.test(liveNoC),
    "resolveArtifact 的「必须落在目录里」前缀校验不许删（basename 那条只是第一道）",
  );

  // ---- 手机版排品：读 / 写两条消息（2026-10-17 晚第二版，手机上能改排品） ----
  // 老板第一版要的是"看成品"，看到实物后改口要**排品表本身**并能改 → 手机端直接调
  // `getLiveState`（读）和 `saveLivePlan`（写整张表）。这两条的"读/写"归类必须对，
  // 否则要么只读模式下被误拦，要么写操作绕过排队。
  {
    const liveSrc2 = fs.readFileSync(path.join(root, "src", "tools", "shopTool", "handlers", "live.ts"), "utf8");
    const shopIdx = fs.readFileSync(path.join(root, "src", "tools", "shopTool", "index.ts"), "utf8");
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    ck(
      /getLiveState\(\)\s*\{\s*h\.postLiveState\(\);\s*\}/.test(strip(liveSrc2)),
      "要有 getLiveState：纯读一条 liveState（手机只拿 plan，不该顺带把整库商品再读一遍）",
    );
    const wr = /const WRITE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(shopIdx);
    const wl = wr ? wr[1] : "";
    ck(/saveLivePlan/.test(wl), "saveLivePlan 必须在 WRITE_ACTIONS 里（写库 → 要排队、只读模式下要拦）");
    ck(!/getLiveState/.test(wl), "getLiveState 是读，不该进 WRITE_ACTIONS（进了就会被只读模式挡掉）");
    ck(
      /saveLivePlan\(msg\)\s*\{[\s\S]{0,400}?db\.replaceLivePlan\(/.test(strip(liveSrc2)),
      "saveLivePlan 要走 replaceLivePlan（整表一次事务），别逐行插",
    );

    // ---- 手机端出图：没有对话框通道，必须能跳过「确认输出目录」（2026-10-17 晚）----
    // 网页版宿主（src/server/httpHost.ts）的 chooseAction 一律回 undefined，而 generateLiveGrid
    // 原来**只要目录可用就问一句确认**，undefined 会被当成「取消」→ 手机上点了没反应。
    // 所以手机端带 skipConfirm:true，且**只在目录可用时**才认这个标记（目录不可用还得走选目录）。
    const g = strip(liveSrc2);
    ck(
      /else if \(msg\.skipConfirm === true\) \{[\s\S]{0,120}?outDir = saved;/.test(g),
      "generateLiveGrid 要有 skipConfirm 分支：网页版没有对话框通道，否则手机点生成会一路走到「已取消」",
    );
    ck(
      /const saved = String\(h\.getSetting\("live_out_dir"\)[\s\S]{0,4000}?else if \(msg\.skipConfirm === true\)/.test(g),
      "skipConfirm 必须排在「目录可用」那条 else 之后：目录不可用时不能跳过选目录",
    );
    ck(
      /skipConfirm/.test(g) && !/if \(msg\.skipConfirm\)/.test(g),
      "skipConfirm 必须写成 === true 的显式判断（手机发的是 1/字符串也别误伤，但 truthy 判断容易被别的消息带进来）",
    );

    // ---- 手机出图**不落盘**（2026-10-18）：老板「为什么写的电脑上的目录里呢？我不想这样」----
    // 做法跟进货单导出一样：内存里出 jpg → base64 随定向消息推给点按钮的那台手机。
    ck(/const inline = msg\.inline === true;/.test(g), "generateLiveGrid 要有 inline 判断（手机出图不写电脑目录）");
    ck(
      /if \(!inline\) \{[\s\S]{0,4000}?mkdirSync\(outDir/.test(g),
      "inline 为真时必须整块跳过目录选择/确认（否则手机上还得弹一个选不了的框）",
    );
    ck(
      /renderLiveGridBuffer\(cells, g, labelMode\)/.test(g),
      "inline 出九宫格要走 renderLiveGridBuffer（内存里出，别落盘）",
    );
    ck(/type: "liveInlineImage"/.test(g), "生成完要发 liveInlineImage 回手机：否则界面上什么都没有");
    ck(/b64: .*toString\("base64"\)/.test(g), "liveInlineImage 必须带 b64（jpg 字节 base64 过去）");
    // ⚠️ 不能只查"liveInlineImage 附近有 toRequester"：单组那条也在附近，长图那条被改坏了照样绿（漏网过一次）。
    //    两条路各推一张，所以必须**数够两条**。
    const targetedPosts = (g.match(/toRequester:\s*true/g) || []).length;
    ck(
      targetedPosts >= 2,
      "两条 liveInlineImage（单组 / 长图）都必须 toRequester: true：少一条，那条路就把几 MB 的图广播给所有设备",
    );
    ck(!/toRequester:\s*false/.test(g), "toRequester 不该写成 false：那等于没写定向，看着有其实没有");
    // ⚠️ 用"在长图这段里的先后顺序"判断，别用「中间隔多少字符」：
    //    中间插了「筛掉没图的组」那几句之后，距离一变就误报红。
    const longSeg = g.slice(g.indexOf("generateLiveLong(msg)"));
    const atInline = longSeg.indexOf("if (msg.inline === true)");
    const atUsable = longSeg.indexOf("renderLiveLongBuffer(usable");
    const atReady = longSeg.indexOf("readyOutDir()");
    ck(atUsable > 0, "generateLiveLong 的 inline 分支要走 renderLiveLongBuffer(usable)（内存出长图）");
    ck(
      atInline > 0 && atReady > 0 && atInline < atReady,
      "长图的 inline 分支必须排在 readyOutDir() 之前：排在后面就还是会先去要目录",
    );

    // ---- 一组一张图都没有就别拼（2026-10-18 老板：「没有任何图就不要让它拼接了，除非有一张」）----
    ck(
      /if \(!cells\.some\(\(c\) => c\.img\)\) \{[\s\S]{0,300}?continue;/.test(g),
      "generateLiveGrid 要跳过「整组没图」的组：否则拼出来就是 9 个白格子（手机上还得存一张全白的图）",
    );
    ck(
      /const usable = payload\.filter\(\(g\) => g\.cells\.some\(\(c\) => c\.img\)\);/.test(g),
      "generateLiveLong 要先按「至少有一张图」筛掉没图的组：全白的卡拼进长图只是把图拉长",
    );
    ck(
      /renderLiveLongBuffer\(usable, \{ labelMode \}\)/.test(g) &&
        /renderLiveLongImage\(usable, outDir, \{ labelMode \}\)/.test(g),
      "长图两条路都必须用筛过的 usable，别漏一条又去拼白格子",
    );
    ck(
      /if \(files\.length === 0 && shots\.length === 0\) \{[\s\S]{0,300}?gridStatus\("error"/.test(g),
      "一组都没图时必须回 error（不能假装「已生成 0 张」）",
    );
  }

  global.__liveCases = liveCases.n;
}

// ---------------------------------------------------------------- 汇总
if (fails.length > 0) {
  console.error(`❌ check-server-units：${fails.length} 项不通过`);
  for (const f of fails) {
    console.error(`   - ${f}`);
  }
  process.exit(1);
}
const liveCases = global.__liveCases || 0;
console.log(
  `✅ check-server-units：EventHub 14 组 + 请求收集器 ${reqCases} 组 + 串行队列 ${queueCases} 组` +
    ` + 重活队列 ${taskCases} 组 + changed 判定 ${changeCases} 组 + 长活儿入口 ${seamCases} 组` +
    ` + 外网隧道落点 ${tunnelCases} 组 + 外网密码门 ${gateCases} 组 + 直播（成品只读 + 排品读写）${liveCases} 组` +
    ` + 接线断言 ${wiringCases} 组，` +
    `共 ${14 + reqCases + queueCases + taskCases + changeCases + seamCases + tunnelCases + gateCases + liveCases + wiringCases} 组用例全通过`,
);
})().catch((err) => {
  // 用例本身崩了（不是断言失败）也要非零退出，否则 CI 会把它当通过
  console.error(`❌ check-server-units 跑挂了：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
