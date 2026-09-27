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

// 抽 `var name = (a, b) => { ... }` 箭头函数的函数体（前端 sanitizeProductField 是这种写法）
function extractArrowBody(file, varName, label) {
  const src = fs.readFileSync(file, "utf8");
  const startRe = new RegExp(`var ${varName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`);
  const start = src.match(startRe);
  if (!start || start.index === undefined) {
    fails.push(`${label}: 找不到 ${varName} 箭头函数`);
    return null;
  }
  const open = start.index + start[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      return src.slice(open + 1, i);
    }
  }
  fails.push(`${label}: ${varName} 箭头函数括号未闭合`);
  return null;
}

// 抽 `const name = (a, b): T => { ... }` 的函数体。TS 源码里的辅助函数常写成这种
// 形式（extractFnBody 只认 `function name(...)` 声明，抽不到），签名里的类型标注
// 在 `=>` 之前，函数体内部是纯 JS，能直接 new Function 跑。
function extractConstArrowBody(file, name, label) {
  const src = fs.readFileSync(file, "utf8");
  const startRe = new RegExp(`const ${name}\\s*=\\s*\\([^)]*\\)[^=]*=>\\s*\\{`);
  const start = src.match(startRe);
  if (!start || start.index === undefined) {
    fails.push(`${label}: 找不到 ${name} 箭头函数`);
    return null;
  }
  const open = start.index + start[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      return src.slice(open + 1, i);
    }
  }
  fails.push(`${label}: ${name} 箭头函数括号未闭合`);
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

  // —— 导入可写字段清单：前端 client-product.js IMPORT_WRITABLE_KEYS ⇄ 后端 IMPORTABLE_FIELD_ORDER ——
  let backendFields = null;
  try {
    backendFields = require(path.join(root, "out", "tools", "shopTool", "productFields.js"));
  } catch {
    fails.push("productFields.ts 未编译：先运行 pnpm run compile 再执行本脚本");
  }
  const clientProductFile = path.join(root, "src", "tools", "shopTool", "client-product.js");
  if (backendFields) {
    const opSrc = fs.readFileSync(clientProductFile, "utf8");
    const m = opSrc.match(/const IMPORT_WRITABLE_KEYS = (\[[\s\S]*?\]);/);
    if (!m) {
      fails.push("client-product.js: 找不到 IMPORT_WRITABLE_KEYS");
    } else {
      const clientKeys = new Function(`return ${m[1]}`)();
      const backendKeys = backendFields.IMPORTABLE_FIELD_ORDER.map((f) => f.key);
      if (clientKeys.join(",") !== backendKeys.join(",")) {
        fails.push(
          `导入可写字段漂移：前端 [${clientKeys.join(", ")}] vs 后端 [${backendKeys.join(", ")}]`,
        );
      }
    }
  }

  // —— 校验行为：前端 sanitizeProductField ⇄ 后端 normText / normMoney / normGrade / normInt ——
  if (backendFields && jsSpecs) {
    const body = extractArrowBody(jsFile, "sanitizeProductField", "client-core.js");
    if (body !== null) {
      const front = new Function(
        "FIELD_SPECS",
        "parseMoneyInput",
        `return (field, raw) => {${body}}`,
      )(jsSpecs, (raw) =>
        Number(String(raw ?? "").trim().replace(/^[¥￥]\s*/, "")),
      );
      const serverOf = (field) => {
        const spec = backendFields.PRODUCT_FIELDS.find((f) => f.key === field);
        if (spec && spec.kind === "grade") {
          return (raw) => backendFields.normGrade(raw);
        }
        if (spec && spec.kind === "money") {
          return (raw) => backendFields.normMoney(field, raw);
        }
        if (spec && spec.kind === "int") {
          return (raw) => backendFields.normInt(field, raw);
        }
        return (raw) => backendFields.normText(field, raw);
      };
      // 每个字段给一组边界样例（空串/空格/超长/负数/小数/带币符/非法文本）
      const valSamples = {
        name: ["", "  铜合金手链  ", "有 空 格", "x".repeat(101), null, 123],
        category: ["", "手链", "有 空 格", "y".repeat(51)],
        series: ["", "C类", "s".repeat(51)],
        purchase_link: ["", "https://x", "a b", "z".repeat(501)],
        remark: ["", "备注", "r".repeat(201)],
        grade: [0, 1, 99, 100, -1, 1.5, "2", ""],
        cost_price: ["", "-1", "¥12.345", "￥9.9", "abc", "0", 12.5],
        sale_price: ["", "-1", "100", "x", 9.9],
        stockTotal: [0, -1, 1.5, "3", "", null],
      };
      for (const [field, samples] of Object.entries(valSamples)) {
        const serverFn = serverOf(field);
        for (const raw of samples) {
          const a = serverFn(raw);
          const b = front(field, raw);
          // 通过时比归一化结果；拒绝时比提示文案（后端拒绝会回带原值 value，前端不带，属无关形状差异）
          const av = a.ok
            ? JSON.stringify({ ok: true, value: a.value, truncated: !!a.truncated })
            : JSON.stringify({ ok: false, msg: a.msg });
          const bv = b.ok
            ? JSON.stringify({ ok: true, value: b.value, truncated: !!b.truncated })
            : JSON.stringify({ ok: false, msg: b.msg });
          if (av !== bv) {
            fails.push(`字段校验漂移 ${field}(${JSON.stringify(raw)}): 后端 ${av} vs 前端 ${bv}`);
          }
        }
      }
      // 缺省等级必须是 0（自定义），两边都得是 0
      for (const raw of [undefined, null, ""]) {
        const back = backendFields.normGrade(raw);
        const front2 = front("grade", raw);
        if (back.ok !== front2.ok || back.value !== front2.value) {
          fails.push(
            `等级缺省值漂移(${JSON.stringify(raw) ?? "undefined"}): 后端 ${JSON.stringify(back.value)} vs 前端 ${JSON.stringify(front2.value)}`,
          );
        }
      }
    }
  }

  // —— 导入等级单元格解析：parseGradeCell 直接从 product.ts 抽真实函数体跑 ——
  {
    const body = extractConstArrowBody(
      path.join(root, "src", "tools", "shopTool", "handlers", "product.ts"),
      "parseGradeCell",
      "handlers/product.ts",
    );
    if (body !== null) {
      const parse = new Function("return function parseGradeCell(raw, rules) {\n" + body + "\n}")();
      const rules = [
        { grade: 1, label: "一级" },
        { grade: 2, label: "二级" },
        { grade: 7, label: "特级" },
        { grade: 8, label: "" },
      ];
      // 导出写的是等级名，导入必须原样认回来；空/认不出 → null（调用方回退 0）
      const cases = [
        ["自定义", 0],
        ["手动", 0],
        ["0", 0],
        ["一级", 1],
        ["二级", 2],
        ["特级", 7],
        ["等级3", 3],
        ["等级 12", 12],
        ["1", 1],
        ["02", 2],
        [" 7 ", 7],
        ["99", 99],
        ["", null],
        ["   ", null],
        ["一级 ", 1],
        ["100", null],
        ["abc", null],
        ["等级", null],
        ["等级0", null],
      ];
      for (const [raw, want] of cases) {
        const got = parse(raw, rules);
        if (got !== want) {
          fails.push(`等级单元格解析 ${JSON.stringify(raw)}: 期望 ${want} 实得 ${got}`);
        }
      }
      // 认不出的等级名不能瞎猜成某个等级，否则会静默改错别人的等级
      if (parse("不存在", rules) !== null) {
        fails.push("等级单元格解析：未知等级名应返回 null");
      }
    }
  }

  if (fails.length === 0) {
    console.log(`✅ parity OK：PRODUCT_FIELDS(FIELD_SPECS) 13 条逐一相等，canonicalCode/applyExpr/calcPrice 行为抽查通过`);
    console.log(`   导入可写字段与 sanitize/norm* 校验行为同步，无漂移`);
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