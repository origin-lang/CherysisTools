// shopTool 前后端双份规则 parity 核对（候选③）
// 背景：后端 TS（productFields.ts / pricing.ts，tsc 编译）与前端 JS（client-core.js，运行时原样下发）永远不可能共享代码。
// 本脚本各自读源文件，1) 结构对比 13 条字段规格；2) 行为抽查 canonicalCode/applyExpr/calcPrice，任一项漂移即非零退出。
// 用法：node scripts/check-shopTool-parity.cjs
const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(__dirname, "..");
const tsFile = path.join(root, "src", "tools", "shopTool", "productFields.ts");
const jsFile = path.join(root, "src", "tools", "shopTool", "client-core.js");

const fails = [];
const norm = (s) => s.replace(/[\r\n\s]+/g, " ").replace(/\s+([,;}])/g, "$1").trim();
const specSig = (spec) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(spec)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

function extractArray(file, re, label) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(re);
  if (!m) {
    fails.push(`${label}: 找不到数组字面量`);
    return null;
  }
  return new Function(`return ${m[1]}`)();
}

function extractFnBody(file, name, label) {
  const src = fs.readFileSync(file, "utf8");
  const startRe = new RegExp(`function ${name}\\([^)]*\\)[^\\{]*\\{`);
  const start = src.match(startRe);
  if (!start || start.index === undefined) {
    fails.push(`${label}: 找不到 ${name} 函数`);
    return null;
  }
  const open = start.index + start[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      return src.slice(open + 1, i).trim();
    }
  }
  fails.push(`${label}: ${name} 函数括号未闭合`);
  return null;
}

function main() {
  const tsSpecs = extractArray(
    tsFile,
    /export const PRODUCT_FIELDS: ProductFieldSpec\[\] = (\[[\s\S]*?\]);/,
    "productFields.ts PRODUCT_FIELDS",
  );
  const jsSpecs = extractArray(
    jsFile,
    /var FIELD_SPECS = (\[[\s\S]*?\]);/,
    "client-core.js FIELD_SPECS",
  );
  if (tsSpecs && jsSpecs) {
    const tsSig = tsSpecs.map(specSig);
    const jsSig = jsSpecs.map(specSig);
    if (tsSig.length !== jsSig.length) {
      fails.push(`字段条数不一致: 后端 ${tsSig.length} vs 前端 ${jsSig.length}`);
    } else {
      for (let i = 0; i < tsSig.length; i++) {
        if (tsSig[i] !== jsSig[i]) {
          fails.push(`第 ${i + 1} 条字段规格漂移:`);
          fails.push(`  后端 ${tsSpecs[i].key}: ${tsSig[i]}`);
          fails.push(`  前端 ${jsSpecs[i].key}: ${jsSig[i]}`);
        }
      }
    }
  }

  // 前端：client-core.js 是运行时原样下发的纯 JS，直接 new Function 重建真实行为
  const mkFrontendPricing = (file) => {
    const bodies = {
      canonicalCode: extractFnBody(file, "canonicalCode", "client-core.js"),
      applyExpr: extractFnBody(file, "applyExpr", "client-core.js"),
      calcPrice: extractFnBody(file, "calcPrice", "client-core.js"),
    };
    if (Object.values(bodies).some((b) => b === null)) {
      return null;
    }
    return {
      canonicalCode: new Function(`return function canonicalCode(raw) {\n${bodies.canonicalCode}\n}`)(),
      applyExpr: new Function(`return function applyExpr(cost, expr) {\n${bodies.applyExpr}\n}`)(),
      calcPrice: new Function("round2", "applyExpr", `return function calcPrice(cost, rule) {\n${bodies.calcPrice}\n}`)((v) => Math.round(v * 100) / 100, new Function(`return function applyExpr(cost, expr) {\n${bodies.applyExpr}\n}`)()),
    };
  };
  // 后端：pricing.ts 由 tsc 编译，行为以编译产物为准（与线上一致）
  const tsPricingOut = path.join(root, "out", "tools", "shopTool", "pricing.js");
  let backend = null;
  try {
    backend = require(tsPricingOut);
  } catch {
    fails.push(`pricing.ts 未编译：先运行 pnpm run compile 再执行本脚本（缺 ${path.relative(root, tsPricingOut)}）`);
  }

  const frontend = mkFrontendPricing(jsFile);
  if (backend && frontend) {
    const codeSamples = ["L7", "l76", "1044", "L1044", " l 9 ", "L9999", "L10000", "L0", "abc", "L12x", "Ｌ5"];
    for (const raw of codeSamples) {
      const a = backend.canonicalCode(raw);
      const b = frontend.canonicalCode(raw);
      if (a !== b) {
        fails.push(`canonicalCode("${raw}") 漂移: 后端 ${a} vs 前端 ${b}`);
      }
    }
    const costSamples = [8.5, 10, 99.99, 0, 12.345];
    const ruleSamples = [
      undefined,
      { expr: "cost*2", tail_mode: "round", tail_value: "" },
      { expr: "cost+0.6", tail_mode: "p99", tail_value: "" },
      { expr: "cost+0.6", tail_mode: "p88", tail_value: "" },
      { expr: "cost*1.2", tail_mode: "custom", tail_value: "9" },
      { expr: "cost*1.1", tail_mode: "custom", tail_value: "88" },
      { expr: "999", tail_mode: "custom", tail_value: "0" },
      { expr: "cost/abc", tail_mode: "raw", tail_value: "" },
    ];
    for (const cost of costSamples) {
      for (const rule of ruleSamples) {
        const a = backend.calcPrice(cost, rule);
        const b = frontend.calcPrice(cost, rule);
        if (a !== b) {
          fails.push(`calcPrice(${cost}, ${JSON.stringify(rule)}) 漂移: 后端 ${a} vs 前端 ${b}`);
        }
      }
    }
    const exprSamples = ["cost*2", "cost+1", "(cost+1)*2", "cost/abc", ""];
    for (const e of exprSamples) {
      const a = backend.applyExpr(7, e);
      const b = frontend.applyExpr(7, e);
      if (a !== b) {
        fails.push(`applyExpr(7, "${e}") 漂移: 后端 ${a} vs 前端 ${b}`);
      }
    }
  }

  if (fails.length === 0) {
    console.log(`✅ parity OK：PRODUCT_FIELDS(FIELD_SPECS) 13 条逐一相等，canonicalCode/applyExpr/calcPrice 行为抽查通过`);
    console.log(`   来源：${path.relative(root, tsFile)} ⇄ ${path.relative(root, jsFile)}`);
    return;
  }
  console.log(`❌ parity FAIL（${fails.length} 处）`);
  for (const f of fails) {
    console.log("  " + f);
  }
  process.exit(1);
}

main();