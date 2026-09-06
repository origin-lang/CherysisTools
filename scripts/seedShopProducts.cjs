const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_DB = path.join(
  process.env.APPDATA,
  "Code",
  "User",
  "globalStorage",
  "faye.cherysis",
  "shop.db",
);

const dbPath = process.argv[2] || DEFAULT_DB;
const targetTotal = Math.max(1, Math.floor(Number(process.argv[3] || 800)));

const CATEGORIES = ["连衣裙", "半身裙", "打底衫", "T恤", "短裤", "长裤", "卫衣", "卫裤", "外套", "针织衫"];
const SERIES = ["清新风", "简约风", "韩版", "日系", "欧美风", "甜美系", "通勤", "休闲"];

function round2(v) {
  return Math.round(v * 100) / 100;
}

function applyExpr(cost, expr) {
  const e = String(expr ?? "").replace(/cost/gi, `(${cost})`);
  if (!/^[0-9+\-*/().\s]+$/.test(e)) {
    return null;
  }
  try {
    const v = new Function(`return (${e});`)();
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function calcPrice(cost, rule) {
  let v = rule ? applyExpr(cost, rule.expr) : null;
  if (v === null) {
    v = cost;
  }
  v = round2(v);
  const mode = rule?.tail_mode ?? "raw";
  const tail = String(rule?.tail_value ?? "").trim();
  switch (mode) {
    case "round":
      return Math.round(v);
    case "p99":
      return Math.floor(v) + 0.99;
    case "p88":
      return Math.floor(v) + 0.88;
    case "custom": {
      if (!tail || !/^\d{1,2}$/.test(tail)) {
        return v;
      }
      const dec = Number(tail) / Math.pow(10, tail.length);
      return round2(Math.floor(v) + dec);
    }
    default:
      return v;
  }
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const existing = db.prepare("SELECT code FROM products").all().map((r) => String(r.code));
const used = new Set(existing);
const rules = db.prepare("SELECT grade, expr, tail_mode, tail_value FROM sale_rules").all();
const ruleByGrade = new Map(rules.map((r) => [Number(r.grade), r]));

const need = targetTotal - existing.length;
if (need <= 0) {
  console.log(`已是 ${existing.length} 个商品（目标 ${targetTotal}），无需补充。`);
  db.close();
  process.exit(0);
}

const codes = [];
for (let n = 1; n <= 9999 && codes.length < need; n++) {
  const code = `L${String(n).padStart(3, "0")}`;
  if (!used.has(code)) {
    codes.push(code);
  }
}
if (codes.length < need) {
  console.log(`⚠ 可用编号不足：现有 ${existing.length}，只能再补 ${codes.length} 个（编号上限 L9999）。`);
}

const insert = db.prepare(
  `INSERT INTO products (code, name, category, series, grade, cost_price, sale_price, price_manual, purchase_link, status, remark, created_at)
   VALUES (@code, @name, @category, @series, @grade, @cost_price, @sale_price, @price_manual, @purchase_link, @status, @remark, @created_at)`,
);
const now = new Date().toISOString();

const t0 = Date.now();
const tx = db.transaction(() => {
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const allIdx = existing.length + i;
    const category = CATEGORIES[allIdx % CATEGORIES.length];
    const series = SERIES[(allIdx * 7) % SERIES.length];
    const grade = 1 + (allIdx % 3);
    const cost = round2(5 + (allIdx % 60) + ((allIdx * 7) % 10) * 0.1);
    const sale = calcPrice(cost, ruleByGrade.get(grade));
    insert.run({
      code,
      name: `测试${category}${code}`,
      category,
      series,
      grade,
      cost_price: cost,
      sale_price: sale,
      price_manual: 0,
      purchase_link: `https://item.1688.com/item.htm?id=${6800000000 + allIdx}`,
      status: 0,
      remark: "性能测试种子数据",
      created_at: now,
    });
  }
});
tx();
const dt = Date.now() - t0;

db.close();
console.log(`✅ 完成：原 ${existing.length} 个 → 新增 ${codes.length} 个 → 共 ${existing.length + codes.length} 个商品。`);
console.log(`   编号示例：${codes.slice(0, 3).join(" ")} … ${codes.slice(-3).join(" ")}`);
console.log(`   耗时：${dt} ms（含事务）；cost 范围约 ¥5~¥64，售价按现有售价规则计算。`);