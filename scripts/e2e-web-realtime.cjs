// 网页版实时推送 + 写串行化的端到端核对。
//
// 这是 scripts/ 里唯一两个**要连着一个真跑着的服务**的脚本（其余都是纯静态核对）。
// 用法：
//   1) 起测试服务（667 + tmp-web-test 三个路径，见 docs/网页版-使用与运维.md）
//   2) node scripts/e2e-web-realtime.cjs            # 默认 http://127.0.0.1:667
//      可选：--base=http://127.0.0.1:666  --force
//
// ⚠️ 它**会真的写库**（改库存/状态/备注）。默认只肯对着 tmp-web-test 的测试库跑：
//    服务端 /api/ping 报的 storageDir 里不含 tmp-web-test 就直接拒绝执行，
//    除非显式加 --force。正式库上别加。
//
// 验四件事：
//   a) 写操作的回推必须真的到旁观者手上（网页版"别人改了我这边自动变"就靠它）
//   b) 写操作有回推时**不该**再发 changed（不然没事就亮「有改动」，久了没人信）
//   c) 别人**不经过服务**改库（模拟电脑版 VS Code 直接写同一个 shop.db）→ 巡检发现并广播 changed
//   d) 并发写：全部落库、rev 逐次 +1（说明真串行、没丢写）、队列回到空
//
// 注：「写成功但一条回推都没有 → 必须发 changed」那条支路真机上凑不出来（所有写 handler 都会
// 回推），由 scripts/check-server-units.cjs 里 shouldAnnounceChange 的用例守着。
const path = require("path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);
const BASE = String(args.base || "http://127.0.0.1:667").replace(/\/+$/, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function invoke(body, client) {
  return fetch(BASE + "/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cherysis-client": client },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

async function main() {
  // 安全闸：先问服务端"你的库在哪"，不是测试库就不写
  const ping0 = await (await fetch(BASE + "/api/ping")).json();
  const DB = path.join(ping0.storageDir, "shop.db");
  if (!/tmp-web-test/.test(ping0.storageDir) && !args.force) {
    console.error(
      `❌ 这个脚本会真的写库，默认只允许对着测试库跑。\n` +
        `   服务端报的库在：${ping0.storageDir}\n` +
        `   确认要对着它跑就加 --force（正式库上请慎重）。`,
    );
    process.exit(2);
  }
  console.log(`目标服务：${BASE}\n目标库：${DB}\n`);

  const events = [];
  const ctrl = new AbortController();
  const res = await fetch(BASE + "/api/events?client=WATCHER", { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        return; // abort 了
      }
      if (chunk.done) return;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = { id: 0, event: "", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) ev.id = Number(line.slice(4));
          else if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data = (ev.data ? ev.data + "\n" : "") + line.slice(6);
        }
        if (ev.event) events.push(ev);
      }
    }
  })();

  const since = () => events.length;
  const slice = (from) => events.slice(from);
  const summarize = (list) =>
    list.map((e) => `${e.event}${e.event === "post" ? "(" + JSON.parse(e.data).type + ")" : ""}`);
  const fails = [];
  const ok = (cond, msg) => {
    if (!cond) fails.push(msg);
  };

  await sleep(400);
  console.log(`连接建立后收到的事件：${JSON.stringify(summarize(events))}`);

  // 拿几个真实存在的商品 id 来写（测试库里 1~160 一定在）
  const all0 = await invoke({ type: "loadAll" }, "SETUP");
  const prods0 = (all0.posts.find((p) => p.type === "productsLoaded") || {}).products || [];
  const ids = prods0
    .map((p) => Number(p.id))
    .filter((n) => Number.isFinite(n))
    .slice(0, 6);
  if (ids.length < 6) {
    console.error(`❌ 库里商品太少（只认出 ${ids.length} 个），这个脚本至少要 6 个才能验并发写`);
    process.exit(2);
  }
  const one = ids[0];
  // 每一轮用一个不同的后缀：上一轮留下的值如果和这轮相同，SQLite 会当成"没改动"
  // （库文件都不变），rev 也就不该 +1 —— 那是**正确**行为，但会让断言偶发失败。
  const tag = Date.now().toString(36);

  // ---- a) 写操作的回推必须真的到旁观者手上
  let from = since();
  const ra = await invoke({ type: "setStockQty", id: one, qty: 7 }, "PHONE-A");
  await sleep(500);
  const ea = slice(from);
  console.log(`\na) setStockQty（id=${one}）：ok=${ra.ok} rev.seq=${ra.rev.seq} posts=${ra.posts.length}`);
  console.log(`   旁观者收到：${JSON.stringify(summarize(ea))}`);
  ok(
    ea.some((e) => e.event === "post" && JSON.parse(e.data).type === "productsDelta"),
    "a) 写操作的 delta 必须广播到旁观者（这是「别人改了我这边自动变」的来源）",
  );
  ok(
    ea.some((e) => e.event === "log"),
    "a) 日志也要广播（后台任务的进度就靠这条路回到手机上）",
  );
  ok(!ea.some((e) => e.event === "changed"), "a) 已经有 delta 了，不该再发 changed（白亮一次角标）");

  // ---- b) 有回推的写 → 不该再发 changed
  from = since();
  const rb = await invoke({ type: "setStatus", id: ids[1], status: 1 }, "PHONE-A");
  await sleep(500);
  const eb = slice(from);
  console.log(`\nb) setStatus（id=${ids[1]}）：ok=${rb.ok} rev.seq=${rb.rev.seq} posts=${rb.posts.length}`);
  console.log(`   旁观者收到：${JSON.stringify(summarize(eb))}`);
  ok(
    eb.some((e) => e.event === "post" && JSON.parse(e.data).type === "productsDelta"),
    "b) 有回推的写应该把 delta 广播出去（别人靠它就同步了）",
  );
  ok(!eb.some((e) => e.event === "changed"), "b) 已经有 delta 了不该再发 changed（会没事就亮「有改动」）");

  // ---- c) 不经过服务的改库（模拟电脑版）→ 巡检发现
  from = since();
  const dv0 = (await (await fetch(BASE + "/api/ping")).json()).dataVersion;
  const raw = new Database(DB, { timeout: 10000 });
  raw.pragma("journal_mode = DELETE");
  raw.prepare("UPDATE products SET remark = ? WHERE id = ?").run("电脑版改的-" + tag, one);
  raw.close();
  console.log("\nc) 已从另一个连接直接改了库（模拟电脑版 VS Code），等巡检…");
  await sleep(4500);
  const dv1 = (await (await fetch(BASE + "/api/ping")).json()).dataVersion;
  const ec = slice(from);
  console.log(`   旁观者收到：${JSON.stringify(summarize(ec))}`);
  console.log(`   巡检读到的 dataVersion：${dv0} → ${dv1}（变了才说明它看见了外面的改动）`);
  ok(ec.some((e) => e.event === "changed"), "c) 别人绕过服务改了库，巡检必须发现并广播 changed");
  const byOutside = ec.filter((e) => e.event === "changed").map((e) => JSON.parse(e.data).by);
  ok(
    byOutside.includes(""),
    `c) 巡检发的 changed 里 by 应为空串（表示服务端自己发现的），实际 ${JSON.stringify(byOutside)}`,
  );

  // ---- d) 并发写：全部落库 + rev 逐次 +1
  from = since();
  const want = ids.map((id) => "并发测试-" + id + "-" + tag);
  const t0 = Date.now();
  const rd = await Promise.all(
    ids.map((id, i) =>
      invoke({ type: "updateProductField", id, field: "remark", value: want[i] }, "W" + (i + 1)),
    ),
  );
  const ms = Date.now() - t0;
  await sleep(400);
  const seqs = rd.map((r) => r.rev.seq);
  console.log(`\nd) ${ids.length} 个并发写：${ms}ms，ok=${JSON.stringify(rd.map((r) => r.ok))}`);
  console.log(`   rev.seq = ${JSON.stringify(seqs)}`);
  ok(
    rd.every((r) => r.ok),
    "d) 并发写都应成功",
  );
  ok(
    new Set(seqs).size === ids.length,
    `d) 每个写应各自拿到一个不同的 rev.seq（说明真串行、没丢写），实际 ${JSON.stringify(seqs)}`,
  );
  ok(
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
    `d) rev 必须逐个递增（说明写真的一个接一个落地），实际 ${JSON.stringify(seqs)}`,
  );

  const check = await invoke({ type: "loadAll" }, "CHECK");
  const prods = (check.posts.find((p) => p.type === "productsLoaded") || {}).products || [];
  const got = ids.map((id) => (prods.find((p) => Number(p.id) === id) || {}).remark);
  console.log(`   回读 remark = ${JSON.stringify(got)}`);
  ok(
    got.every((v, i) => v === want[i]),
    `d) ${ids.length} 条写都应落库且互不覆盖，实际 ${JSON.stringify(got)}`,
  );

  const ping = await (await fetch(BASE + "/api/ping")).json();
  console.log(
    `   ping：rev.seq=${ping.rev.seq} writeQueue=${ping.writeQueue} eventClients=${ping.eventClients} dataVersion=${ping.dataVersion}`,
  );
  ok(ping.writeQueue === 0, "d) 跑完后写队列应回到 0");

  ctrl.abort();
  await pump.catch(() => undefined);

  console.log("");
  if (fails.length > 0) {
    console.error(`❌ e2e-web-realtime：${fails.length} 项不通过`);
    for (const f of fails) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log("✅ e2e-web-realtime：a/b/c/d 四组全部符合预期");
}

main().catch((err) => {
  console.error("❌ e2e-web-realtime 跑挂了：", err);
  process.exit(1);
});
