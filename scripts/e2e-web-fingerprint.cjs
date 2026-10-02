// 库指纹灵敏度核对：rev 只该在"真的写进去了"时前进。
//
// 为什么单独验：rev（以及由它推出来的「有改动」提示）全靠"库文件指纹变了没有"来判断。
// 判据太松 → 没事就亮角标，用户就不信它了；太紧 → 别人改了不提示，等于没做。
// 四种情形都要对：真改动要认得出（哪怕大小没变）、没改动不许乱报。
//
// 用法：起服务后 node scripts/e2e-web-fingerprint.cjs [--base=http://127.0.0.1:667] [--force]
// ⚠️ 它**会真的写库**（改库存/备注），默认只肯对着 tmp-web-test 的测试库跑。
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
  }),
);
const BASE = String(args.base || "http://127.0.0.1:667").replace(/\/+$/, "");
const invoke = (b, c) =>
  fetch(BASE + "/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cherysis-client": c },
    body: JSON.stringify(b),
  }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fails = [];
const ok = (c, m) => {
  if (!c) fails.push(m);
};

async function main() {
  // 安全闸：不是测试库就不写
  const ping0 = await (await fetch(BASE + "/api/ping")).json();
  if (!/tmp-web-test/.test(ping0.storageDir) && !args.force) {
    console.error(
      `❌ 这个脚本会真的写库，默认只允许对着测试库跑。\n` +
        `   服务端报的库在：${ping0.storageDir}\n` +
        `   确认要对着它跑就加 --force（正式库上请慎重）。`,
    );
    process.exit(2);
  }
  const base = ping0.rev.seq;
  console.log(`起始 rev.seq = ${base}`);
  // 拿库里真实存在的头几个商品来写
  const all = await invoke({ type: "loadAll" }, "SETUP");
  const prods = (all.posts.find((p) => p.type === "productsLoaded") || {}).products || [];
  const ids = prods.map((p) => Number(p.id)).filter(Number.isFinite).slice(0, 2);
  if (ids.length < 2) {
    console.error("❌ 库里商品太少，验不了");
    process.exit(2);
  }
  const [a, b] = ids;

  // ① 真的改一个新值 → 必须 +1
  const r1 = await invoke({ type: "setStockQty", id: a, qty: 9 }, "T");
  console.log(`① 库存 ${a} → 9：rev=${r1.rev.seq}（期望 ${base + 1}）`);
  ok(r1.rev.seq === base + 1, `① 真改动应让 rev +1，实际 ${r1.rev.seq}`);

  // ② 再写同一个值（等于没改）→ rev 不该动
  const r2 = await invoke({ type: "setStockQty", id: a, qty: 9 }, "T");
  console.log(`② 库存 ${a} → 9（同值重写）：rev=${r2.rev.seq}（期望 ${base + 1}）`);
  ok(r2.rev.seq === base + 1, `② 没真改动就不该 +1，实际 ${r2.rev.seq}`);

  // ③ 改一个**长度相同**的备注：只变字节、不变大小 —— 这是指纹最容易失灵的地方
  await invoke({ type: "updateProductField", id: b, field: "remark", value: "AAA" }, "T");
  await sleep(150);
  const p3 = await (await fetch(BASE + "/api/ping")).json();
  const r3 = await invoke({ type: "updateProductField", id: b, field: "remark", value: "BBB" }, "T");
  console.log(`③ 备注 AAA → BBB（同长度）：rev ${p3.rev.seq} → ${r3.rev.seq}（期望 +1）`);
  ok(r3.rev.seq === p3.rev.seq + 1, `③ 同长度改动也必须被发现，实际 ${p3.rev.seq} → ${r3.rev.seq}`);

  // ④ 校验失败的写（不存在的商品）→ rev 不动
  const r4 = await invoke({ type: "setStockQty", id: 999999, qty: 3 }, "T");
  console.log(`④ 改不存在的商品：rev=${r4.rev.seq}（期望保持 ${r3.rev.seq}）`);
  ok(r4.rev.seq === r3.rev.seq, `④ 没写进库就不该 +1，实际 ${r4.rev.seq}`);

  console.log("");
  if (fails.length) {
    console.error(`❌ e2e-web-fingerprint：${fails.length} 项不通过`);
    for (const f of fails) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log("✅ e2e-web-fingerprint：四种情形都符合预期（真改动认得出、没改动不乱报）");
}

main().catch((e) => {
  console.error("❌ e2e-web-fingerprint 跑挂了：", e);
  process.exit(1);
});
