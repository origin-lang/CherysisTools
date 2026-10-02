// 重活队列（longTask 接缝）的端到端核对：真跑一次「生成共享缩略图」，看四件事。
//
//   1) /api/invoke **立刻**返回 —— 活儿交给宿主了，不再卡在请求里（网页版上那是几分钟）
//   2) SSE 收到 queue 事件：先 running=生成共享缩略图，跑完再回到空闲
//   3) 进度日志（…共享缩略图 n/N）也从 SSE 一条条出来，最后是「✅完成」
//   4) /api/ping 的 tasks 状态跟着变，跑完回到空闲
//
// 用法：起测试服务后 node scripts/e2e-web-tasks.cjs [--base=http://127.0.0.1:667] [--force]
// ⚠️ 它会真的去生成缩略图（写 tmp-web-test 那几个目录），默认只肯对着测试库跑。
//
// 注：「两个不同重活同时进来，第二个排队」由 scripts/check-server-units.cjs 的 TaskQueue
// 用例守着（真时间片、峰值=1、按序）—— 端到端这边凑不出第二个能跑的重活
// （generateLiveGrid 和 generateStarOverview 在网页版都要先选目录，服务端选不了）。
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);
const BASE = String(args.base || "http://127.0.0.1:667").replace(/\/+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fails = [];
const ok = (c, m) => {
  if (!c) fails.push(m);
};

async function main() {
  const ping0 = await (await fetch(BASE + "/api/ping")).json();
  if (!/tmp-web-test/.test(ping0.storageDir) && !args.force) {
    console.error(
      `❌ 这个脚本会真的生成缩略图（写共享缩略图缓存），默认只允许对着测试库跑。\n` +
        `   服务端报的库在：${ping0.storageDir}\n` +
        `   确认要对着它跑就加 --force。`,
    );
    process.exit(2);
  }
  console.log(`目标服务：${BASE}\n目标库：${ping0.storageDir}\n`);

  const events = [];
  const ctrl = new AbortController();
  const res = await fetch(BASE + "/api/events?client=TASKS", { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) return;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = { event: "", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data = (ev.data ? ev.data + "\n" : "") + line.slice(6);
        }
        if (ev.event) events.push(ev);
      }
    }
  })();
  const queueStates = () => events.filter((e) => e.event === "queue").map((e) => JSON.parse(e.data));
  const logs = () => events.filter((e) => e.event === "log").map((e) => e.data);

  await sleep(300);

  // ---- 1) 请求立刻返回
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cherysis-client": "PHONE" },
    body: JSON.stringify({ type: "buildSharedThumbs" }),
  }).then((x) => x.json());
  const ms = Date.now() - t0;
  console.log(`1) /api/invoke 用时 ${ms}ms，ok=${r.ok}，同步日志 ${r.logs.length} 条`);
  console.log(`   同步日志：${JSON.stringify(r.logs)}`);
  ok(ms < 2000, `1) 请求应立刻返回（活儿交给宿主了），实际用了 ${ms}ms`);
  ok(r.ok, "1) 请求应成功");
  ok(
    r.logs.some((l) => l.includes("开始生成共享缩略图")),
    "1) 同步那段应该先说「开始生成共享缩略图」",
  );

  // ---- 2/3) 等它跑完（最多 90 秒），盯 queue 事件与进度日志
  const deadline = Date.now() + 90000;
  let done = false;
  while (Date.now() < deadline) {
    await sleep(400);
    if (logs().some((l) => l.includes("共享缩略图完成")) || logs().some((l) => l.includes("生成共享缩略图失败"))) {
      done = true;
      break;
    }
  }
  const st = queueStates();
  console.log(`2) queue 事件 ${st.length} 条：${JSON.stringify(st.slice(0, 6))}`);
  ok(st.length > 0, "2) 应该收到 queue 事件（手机上「正在生成 X」就靠它）");
  ok(
    st.some((s) => s.running === "生成共享缩略图"),
    `2) 应出现过 running=生成共享缩略图，实际 ${JSON.stringify(st.map((s) => s.running))}`,
  );
  ok(
    st.some((s) => s.running === "" && s.waiting.length === 0),
    `2) 跑完应广播回空闲状态，实际最后一条 ${JSON.stringify(st[st.length - 1])}`,
  );

  const prog = logs().filter((l) => l.includes("共享缩略图"));
  console.log(`3) 从 SSE 收到的进度日志 ${prog.length} 条：`);
  for (const l of prog.slice(0, 8)) console.log(`   ${l}`);
  ok(done, "3) 90 秒内应跑完（看到「✅共享缩略图完成」）");
  ok(
    prog.some((l) => l.includes("✅共享缩略图完成")),
    "3) 完成那条日志必须也推到了手机上（以前它是掉在地上的）",
  );

  // ---- 4) ping 里的队列状态回到空闲
  const ping = await (await fetch(BASE + "/api/ping")).json();
  console.log(`4) ping.tasks = ${JSON.stringify(ping.tasks)}`);
  ok(ping.tasks.running === "" && ping.tasks.waiting.length === 0, "4) 跑完后队列应空闲");

  ctrl.abort();
  await pump.catch(() => undefined);

  console.log("");
  if (fails.length > 0) {
    console.error(`❌ e2e-web-tasks：${fails.length} 项不通过`);
    for (const f of fails) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log("✅ e2e-web-tasks：请求不阻塞 / queue 事件 / 进度日志 / 队列回空闲，四组都对");
}

main().catch((err) => {
  console.error("❌ e2e-web-tasks 跑挂了：", err);
  process.exit(1);
});
