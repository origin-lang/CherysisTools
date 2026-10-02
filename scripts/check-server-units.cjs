// 网页版服务端「纯模块」的语义核对 —— 目前是 src/server/events.ts 的 EventHub（实时推送中枢）。
//
// 为什么要单独一个脚本：这些模块刻意不 import http、不 import vscode，所以能在**没有服务、
// 没有数据库、没有 VS Code** 的普通 node 进程里直接跑。语义（编号、去重、环形缓冲、
// 断线续传）全在这里钉死，改坏了立刻非零退出，不用等真机上"手机怎么不刷新"才发现。
//
// 用法：node scripts/check-server-units.cjs     （跑的是编译产物 out/，所以要先 pnpm run compile）
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

// ---------------------------------------------------------------- 汇总
if (fails.length > 0) {
  console.error(`❌ check-server-units：${fails.length} 项不通过`);
  for (const f of fails) {
    console.error(`   - ${f}`);
  }
  process.exit(1);
}
console.log(
  `✅ check-server-units：EventHub 语义 11 组 + 请求收集器 3 组用例全通过（共 ${11 + reqCases} 组）`,
);
