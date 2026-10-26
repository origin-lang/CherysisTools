import { Handler, HandlerCtx } from "./types.js";
import { SaleRule } from "../db.js";
import { canonicalCode, calcPrice, round2, todayStr, applyExpr, normalizeRule } from "../pricing.js";
import {
  IMPORTABLE_FIELD_ORDER,
  normText,
  normMoney,
  normGrade,
  normInt,
} from "../productFields.js";
import { splitCells, isHeaderRow, codeFromCell } from "../rowParse.js";
// ===== 套装（可整体移除）===== looksLikeSet 是「T 前缀」约定的唯一判定处（定义在 sets.ts），别在这边另写 startsWith
import { looksLikeSet } from "./sets.js";

/** 商品可编辑字段 key → 中文名（撤销提示里显示改的是哪个字段） */
const PRODUCT_FIELD_LABELS: Record<string, string> = {
  code: "编号",
  name: "名称",
  category: "品类",
  series: "系列",
  grade: "等级",
  cost_price: "进价",
  sale_price: "售价",
  price_manual: "自定义售价",
  purchase_link: "采购链接",
  status: "状态",
  remark: "备注",
};

// 导入预览：解析后先展示「将新增/将更新/将跳过」，确认后才落库
const IMPORT_PREVIEW_ROW_LIMIT = 200;
const IMPORT_DEFAULT_MISSING_RULE = (grade: number): SaleRule => ({
  grade,
  label: `等级${grade}`,
  expr: "cost*1.5",
  tail_mode: "p88",
  tail_value: "",
});
// 等级列认三种写法，导出→导入要能原样回来：
//   "自定义" / "手动"        → 0
//   "一级" / "二级" / 自定义等级名 → 该等级（按 label 反查，查不到再按 "等级N" 兜底）
//   "2" / "02"               → 2
// 认不出来的返回 null，交给调用方决定是「保持原值」还是「回退 0」。
const parseGradeCell = (raw: string, rules: SaleRule[]): number | null => {
  const s = String(raw ?? "").trim();
  if (!s) {
    return null;
  }
  if (s === "自定义" || s === "手动" || s === "0") {
    return 0;
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 0 && n <= 99 ? n : null;
  }
  const byLabel = rules.find((r) => r.label && r.label === s);
  if (byLabel) {
    return byLabel.grade;
  }
  const m = s.match(/^等级\s*(\d{1,2})$/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 99 ? n : null;
  }
  return null;
};
type ImportWritableField =
  | "name"
  | "category"
  | "series"
  | "purchase_link"
  | "grade"
  | "cost_price"
  | "sale_price"
  | "price_manual"
  | "status";
interface NewImportPlanRow {
  code: string;
  name: string;
  category: string;
  series: string;
  grade: number;
  cost: number;
  manual: number;
  purchase_link: string;
  status: number;
}
interface ImportWriteOp {
  field: ImportWritableField;
  value: number | string;
}
interface UpdateImportPlanRow {
  code: string;
  writes: ImportWriteOp[];
}
interface PendingImportPlan {
  token: string;
  mode: "add" | "update" | "both";
  modeLabel: string;
  newRows: NewImportPlanRow[];
  updateRows: UpdateImportPlanRow[];
  gradesToEnsure: number[];
  skipped: number;
  bad: string[];
  dup: string[];
  // ===== 套装（可整体移除）===== 因「T 开头」被挡下的行（导入不做套装，但要让用户知道是哪几行、为什么）
  setBlocked: string[];
}
let pendingImport: PendingImportPlan | null = null;

// 商品管理域：新建/编辑/清点/上下架/删除/批量/入库/导入
export function productHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;

  // 无副作用的导入解析：与旧 importProducts 逐行决策一致，但只收集"计划"不落库。
  // ensureRule 的默认规则是确定性的（cost*1.5 → +0.88），预览用
  // IMPORT_DEFAULT_MISSING_RULE 代替，结果与 commit 时确保后的规则完全一致。
  const buildImportPlan = (
    text: string,
    mode: "add" | "update" | "both",
    importFields: string[],
  ): {
    newRows: NewImportPlanRow[];
    updateRows: UpdateImportPlanRow[];
    gradesToEnsure: number[];
    skipped: number;
    bad: string[];
    dupLines: string[];
    setBlocked: string[];
    displayRows: Array<{
      kind: "new" | "update";
      code: string;
      name: string;
      detail: string;
    }>;
  } => {
    const rules = db.getRules();
    const ruleOf = (grade: number): SaleRule | undefined =>
      rules.find((r) => r.grade === grade) ?? IMPORT_DEFAULT_MISSING_RULE(grade);
    const parseStatus = (rawv: string): number | null => {
      const s = String(rawv ?? "").trim();
      if (!s) {
        return null;
      }
      if (s === "1" || s === "已下架" || s === "下架") {
        return 1;
      }
      if (s === "0" || s === "在售" || s === "上架") {
        return 0;
      }
      return null;
    };
    const newRows: NewImportPlanRow[] = [];
    const updateRows: UpdateImportPlanRow[] = [];
    const gradesToEnsure = new Set<number>();
    const bad: string[] = [];
    const dupLines: string[] = [];
    // ===== 套装（可整体移除）=====
    // 导入表是「一行一个商品、一列一个字段」，而"谁包含谁"是**关系**不是字段，
    // 硬塞进某一列会让语义变脏（商家原话："这个组成不是字段吧"）。所以导入整条链路不做套装。
    // 但必须堵住 T 开头的行：否则它会以"看着像套装、其实是普通商品"的样子躺进画册，
    // 把「T = 套装」这个给人看的约定破坏掉。单独一个列表，日志里理由才说得清楚。
    const setBlocked: string[] = [];
    // 同一批粘贴内的编号去重：预览不落库，库里查不到的同号两行都会判"新增"，
    // 提交时第二行走身份复检又被跳过——预览与结果不一致。约定：只取第一条，其余计入跳过。
    const newCodes = new Set<string>();
    const displayRows: Array<{
      kind: "new" | "update";
      code: string;
      name: string;
      detail: string;
    }> = [];
    let skipped = 0;
    const lines = String(text ?? "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) {
        continue;
      }
      const parts = splitCells(raw);
      if (parts.length === 0) {
        continue;
      }
      if (isHeaderRow(parts)) {
        continue;
      }
      const code = codeFromCell(parts[0]);
      if (!code) {
        bad.push(`行${i + 1}: ${raw}`);
        continue;
      }
      // ===== 套装（可整体移除）=====
      // T 开头的行一律不收（新增和更新都不收）：更新行更危险 —— 导入表的字段里没有"类型"，
      // 一行 T001 的"更新"根本没法定它到底该不该是套装。让用户手工建，代价最低。
      if (looksLikeSet(code)) {
        setBlocked.push(`行${i + 1}: ${code} 是 T 开头的编号，导入不含套装 —— 请用「新建 → 套装」手工建`);
        continue;
      }
      const exist = db.getProductByCode(code);
      if (exist) {
        if (mode === "add") {
          skipped++;
          continue;
        }
        const has = (key: string) => {
          const idx = importFields.indexOf(key);
          return idx >= 0 && idx < parts.length;
        };
        const getv = (key: string) => {
          const idx = importFields.indexOf(key);
          return idx >= 0 ? String(parts[idx] ?? "") : "";
        };
        const real = (rawv: string): number | null => {
          const v = Number(String(rawv ?? "").trim().replace(/^[¥￥]\s*/, ""));
          return Number.isFinite(v) ? v : null;
        };
        const writes: ImportWriteOp[] = [];
        for (const key of ["name", "category", "series", "purchase_link"]) {
          if (has(key)) {
            writes.push({
              field: key as ImportWritableField,
              value: normText(key as "name" | "category" | "series" | "purchase_link", getv(key)).value,
            });
          }
        }
        const gradeRaw = has("grade") ? parseGradeCell(getv("grade"), rules) : null;
        const costRaw = has("cost_price") ? real(getv("cost_price")) : null;
        const saleRaw = has("sale_price") ? real(getv("sale_price")) : null;
        const gradeOk = gradeRaw !== null;
        const costOk = costRaw !== null && costRaw >= 0;
        const gradeChange = gradeOk && gradeRaw !== exist.grade;
        const costChange = costOk && round2(costRaw as number) !== exist.cost_price;
        const effGrade = gradeOk ? (gradeRaw as number) : exist.grade;
        const effCost = costOk ? round2(costRaw as number) : exist.cost_price;
        if (gradeChange) {
          writes.push({ field: "grade", value: gradeRaw as number });
          // 切成 0（自定义）必须同时置 price_manual=1，跟 updateProductField 的
          // grade 分支保持一致。否则 grade=0 + price_manual=0 会被当成「跟随规则」，
          // 而 0 号等级根本没有规则 → 售价回落成进价，0 毛利。
          if (gradeRaw === 0) {
            writes.push({ field: "price_manual", value: 1 });
          }
        }
        if (costChange) {
          writes.push({ field: "cost_price", value: round2(costRaw as number) });
        }
        // 售价：填了 >0 → 手动价；否则非自定义且（售价列可见 或 等级/进价有变）→ 按规则重算
        const manualSale = saleRaw !== null && saleRaw > 0 ? round2(saleRaw) : null;
        if (manualSale !== null) {
          writes.push({ field: "sale_price", value: manualSale });
          writes.push({ field: "price_manual", value: 1 });
        } else if (
          effGrade !== 0 &&
          (gradeChange ||
            costChange ||
            (importFields.includes("sale_price") && exist.price_manual !== 1))
        ) {
          const next = calcPrice(effCost, ruleOf(effGrade));
          if (exist.sale_price !== next || exist.price_manual !== 0) {
            gradesToEnsure.add(effGrade);
            writes.push({ field: "sale_price", value: next });
            writes.push({ field: "price_manual", value: 0 });
          }
        }
        const stRaw = has("status") ? parseStatus(getv("status")) : null;
        if (stRaw !== null && stRaw !== exist.status) {
          writes.push({ field: "status", value: stRaw });
        }
        if (writes.length === 0) {
          skipped++;
          continue;
        }
        // 只保留真正会改动的字段：值相同就跳过。每条写入在共享盘上就是一次
        // 独立 fsync（db.updateProductField 不包事务），重导同一份文件原本要
        // 上千次写，现在 0 次。前面已比较过的字段过这层是幂等的。
        const realWrites = writes.filter((w) => {
          const oldVal = exist[w.field];
          return typeof oldVal === "number" && typeof w.value === "number"
            ? oldVal !== w.value
            : String(oldVal ?? "") !== String(w.value ?? "");
        });
        // 描述只列真实变化；price_manual 是标记位，不占描述
        const diffs: string[] = [];
        for (const w of realWrites) {
          if (w.field === "price_manual") {
            continue;
          }
          const oldVal = String(exist[w.field] ?? "");
          diffs.push(`${PRODUCT_FIELD_LABELS[w.field] ?? w.field}: ${oldVal || "（空）"}→${String(w.value) || "（空）"}`);
        }
        if (realWrites.length === 0) {
          // 无变化也要列进预览：每行粘贴的内容都得有交代，不能看着像被丢了
          skipped++;
          displayRows.push({ kind: "update", code, name: exist.name, detail: "（无变化）" });
          continue;
        }
        updateRows.push({ code, writes: realWrites });
        displayRows.push({
          kind: "update",
          code,
          name: exist.name,
          detail: diffs.length ? diffs.join("；") : "仅修正售价标记",
        });
        continue;
      }
      if (mode === "update") {
        skipped++;
        continue;
      }
      // 编号在本批粘贴里已计划过新增 → 重复，只取第一条，其余计入跳过
      if (newCodes.has(code)) {
        skipped++;
        dupLines.push(`行${i + 1}: 编号 ${code} 重复，仅保留第一条`);
        continue;
      }
      newCodes.add(code);
      const get = (key: string) => {
        const idx = importFields.indexOf(key);
        return idx >= 0 ? String(parts[idx] ?? "") : "";
      };
      const name = normText("name", get("name")).value || code;
      const category = normText("category", get("category")).value;
      const series = normText("series", get("series")).value;
      // 等级列缺失或认不出来 → 回退 0（自定义），不是 1
      const gradeParsed = parseGradeCell(get("grade"), rules);
      const grade = gradeParsed === null ? 0 : gradeParsed;
      const costRaw = Number(String(get("cost_price") ?? "").trim().replace(/^[¥￥]\s*/, "") || 0);
      const cost = Number.isFinite(costRaw) && costRaw >= 0 ? round2(costRaw) : 0;
      const saleRaw = Number(String(get("sale_price") ?? "").trim().replace(/^[¥￥]\s*/, "") || 0);
      const link = normText("purchase_link", get("purchase_link")).value;
      const statusRaw = parseStatus(get("status"));
      const manual = Number.isFinite(saleRaw) && saleRaw > 0 ? round2(saleRaw) : 0;
      const custom = grade === 0;
      if (!custom) {
        gradesToEnsure.add(grade);
      }
      newRows.push({
        code,
        name,
        category,
        series,
        grade,
        cost,
        manual,
        purchase_link: link,
        status: statusRaw === null ? 0 : statusRaw,
      });
      const sale = custom || manual > 0 ? manual : calcPrice(cost, ruleOf(grade));
      displayRows.push({
        kind: "new",
        code,
        name: name || code,
        detail: `等级${grade} · 进价¥${cost.toFixed(2)} · 售价¥${sale.toFixed(2)}`,
      });
    }
    return {
      newRows,
      updateRows,
      gradesToEnsure: Array.from(gradesToEnsure),
      skipped,
      bad,
      dupLines,
      setBlocked,
      displayRows,
    };
  };

  return {
    addProduct(msg) {
      const code = canonicalCode(msg.code);
      if (!code) {
        log("❌编号格式错误（应形如 A001 或 L007：1 个字母 + 数字，3 位补零，最多 4 位）");
        return;
      }
      // ===== 套装（可整体移除）=====
      // 新建时就把「编号前缀」和「kind」拧成一致：套装必须 T 开头，T 开头的必须是套装。
      // 只在入口守一次，之后（改号、导入）都沿用同一条口径，前缀与 kind 就永远不会打架。
      const isSet = Number(msg.kind) === 1;
      if (isSet && !looksLikeSet(code)) {
        log(`❌套装的编号必须以 T 开头（现在是 ${code}）`);
        return;
      }
      if (!isSet && looksLikeSet(code)) {
        log(`❌${code} 是 T 开头的编号，T 是套装专用。请把类型选成「套装」，或换个编号`);
        return;
      }
      if (db.getProductByCode(code)) {
        log(`❌编号 ${code} 已存在`);
        return;
      }
      const nameR = normText("name", msg.name);
      if (!nameR.ok) {
        log(`❌${nameR.msg}`);
        return;
      }
      const categoryR = normText("category", msg.category);
      const seriesR = normText("series", msg.series);
      const linkR = normText("purchase_link", msg.purchaseLink);
      const remarkR = normText("remark", msg.remark);
      for (const r of [categoryR, seriesR, linkR]) {
        if (!r.ok) {
          log(`❌${r.msg}`);
          return;
        }
      }
      const cost = normMoney("cost_price", msg.costPrice);
      if (!cost.ok) {
        log(`❌${cost.msg}`);
        return;
      }
      const sale = normMoney("sale_price", msg.salePrice);
      if (!sale.ok) {
        log(`❌${sale.msg}`);
        return;
      }
      // 缺省 0（自定义）：售价没填就先留空，等级规则表默认也是空的
      const grade = normGrade(msg.grade);
      if (!grade.ok) {
        log(`❌${grade.msg}`);
        return;
      }
      const initialStock = normInt("stockTotal", msg.initialStock);
      if (!initialStock.ok) {
        log(`❌${initialStock.msg}`);
        return;
      }
      // ===== 套装（可整体移除）===== 新建套装当场带的子编号（2026-10-26）。
      // 建壳**之前**全验完：存在、不是套装、不是自己、去重 —— 有一个不合法整体拒掉，
      // 不出现「套装建成了、成员缺一半」。建壳后再逐个挂成员，撤销一次全回。
      const childCodes: string[] = [];
      if (isSet) {
        for (const raw of Array.isArray(msg.childCodes) ? msg.childCodes : []) {
          const cc = canonicalCode(raw);
          if (!cc || cc === code) {
            log(`❌子编号「${raw}」不合法（或与套装自己同号）`);
            return;
          }
          if (!db.getProductByCode(cc)) {
            log(`❌子编号 ${cc} 不在库里，先建普通商品再组套装`);
            return;
          }
          if (looksLikeSet(cc)) {
            log(`❌${cc} 本身是套装，套装不能套套装`);
            return;
          }
          if (childCodes.includes(cc)) {
            log(`⚠️子编号 ${cc} 重复，只保留一个`);
            continue;
          }
          childCodes.push(cc);
        }
      }
      const snap = h.snapshot();
      const custom = grade.value === 0;
      // 套装不参与等级算价，别为一个"反正会丢掉"的等级白建一条规则
      if (!isSet && !custom && db.ensureRule(grade.value)) {
        log(`ℹ️等级 ${grade.value} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
      }
      const isManual = custom || sale.value > 0;
      // ===== 套装（可整体移除）=====
      // 套装跟普通商品在一个入口建，但落库的形态不同：
      //   等级固定 0（不参与算价）、进价固定 0（它是派生值，落库必然跟子商品对不上）、
      //   售价手填且恒 price_manual=1、不记期初库存。
      // 子商品的关联由界面上「＋ 添加编号」逐个加（走 setAddMember），建壳这一步不涉及。
      const pid = db.addProduct({
        code,
        name: nameR.value,
        category: categoryR.value,
        series: seriesR.value,
        grade: isSet ? 0 : grade.value,
        cost_price: isSet ? 0 : cost.value,
        sale_price: isSet ? sale.value : isManual ? sale.value : calcPrice(cost.value, custom ? undefined : db.getRules().find((r) => r.grade === grade.value)),
        price_manual: isSet ? 1 : isManual ? 1 : 0,
        purchase_link: linkR.value,
        status: 0,
        remark: remarkR.value,
        stock_manual: 0,
        kind: isSet ? 1 : 0,
      });
      if (!isSet && initialStock.value > 0) {
        db.addStockIn({
          product_id: pid,
          qty: initialStock.value,
          date: todayStr(),
          remark: "期初入库",
        });
      }
      for (const cc of childCodes) {
        db.addSetMember(code, cc);
      }
      h.pushUndo(
        snap,
        isSet
          ? `新建套装 ${code} ${nameR.value}`
          : `新建商品 ${code} ${nameR.value}（期初库存 +${initialStock.value}）`,
      );
      log(
        isSet
          ? `✅已新建套装 ${code} ${nameR.value}${childCodes.length ? `（含 ${childCodes.length} 件子商品）` : "（还没加子商品，去详情页点「＋ 添加编号」）"}`
          : `✅已新建 ${code} ${nameR.value}（库存 +${initialStock.value}）`,
      );
      post({ type: "toast", text: `✅已新建 ${code}` });
      h.loadAll();
    },

    updateProductField(msg) {
      const field = String(msg.field);
      const id = Number(msg.id);
      const product = db.getProductById(id);
      if (!product) {
        log("❌商品不存在");
        return;
      }
      const snap = h.snapshot();
      let gradeRuleCreated = false;
      if (field === "code") {
        const code = canonicalCode(msg.value);
        if (!code) {
          log("❌编号格式错误（应形如 A001 或 L007：1 个字母 + 数字，3 位补零，最多 4 位）");
          return;
        }
        // ===== 套装（可整体移除）=====
        // 禁止跨类型改号：套装只能改成 T 开头的，普通商品不能改成 T 开头。
        // 理由见 docs/套装-设计方案.md 决策 3 —— 改号会连带重命名图片文件夹，一旦还顺带
        // 换了商品身份，事后无法追查；锁住这一点，前缀和 kind 就永远不会打架。
        if (looksLikeSet(code) !== looksLikeSet(product.code)) {
          log(
            Number(product.kind) === 1
              ? `❌${product.code} 是套装，只能改成 T 开头的编号`
              : `❌T 开头的编号是套装专用，普通商品不能改成 ${code}`,
          );
          return;
        }
        const exist = db.getProductByCode(code);
        if (exist && exist.id !== id) {
          log(`❌编号 ${code} 已存在`);
          return;
        }
        const oldCode = product.code;
        // 图片文件夹同步是改号保存的前置条件：文件夹没搬成（冲突/失败）→ 本次改号取消、不落库；
        // 弹窗/日志已由 renameImageFolder 发出，这里用 dbOpError 顶掉前端乐观的「已保存」
        const st = h.renameImageFolder(oldCode, code);
        if (st === "conflict" || st === "error") {
          post({
            type: "dbOpError",
            message: `编号未保存：${code} 的图片文件夹未能同步，本次改号已取消（详情见弹窗/日志）`,
          });
          h.loadAll();
          return;
        }
        db.updateProductField(id, "code", code);
        // ===== 套装（可整体移除）===== 关联表里存的是编号，改号必须跟着改，否则套装清单会指向旧编号
        db.renameSetCodes(oldCode, code);
      } else if (field === "name" || field === "category" || field === "series" || field === "purchase_link" || field === "remark") {
        const r = normText(field, msg.value);
        if (!r.ok) {
          log(`❌${r.msg}`);
          return;
        }
        db.updateProductField(id, field, r.value);
        if (r.truncated) {
          log(`‼${product.code} 的${field === "name" ? "名称" : field === "category" ? "品类" : field === "series" ? "系列" : field === "purchase_link" ? "采购链接" : "备注"}超长，已截断`);
        }
      } else if (field === "grade") {
        const grade = normGrade(msg.value);
        if (!grade.ok) {
          log(`❌${grade.msg}`);
          return;
        }
        if (grade.value === 0) {
          // 切成「自定义」：售价固定不动，不再跟随规则
          db.updateProductField(id, "grade", 0);
          db.updateProductField(id, "price_manual", 1);
        } else {
          if (db.ensureRule(grade.value)) {
            gradeRuleCreated = true;
            log(`ℹ️等级 ${grade.value} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
          }
          // 主动选回某个等级 = 明确要跟随该等级规则，立即按规则重算
          db.updateProductField(id, "grade", grade.value);
          db.updateProductField(id, "price_manual", 0);
          const rule = db.getRules().find((r) => r.grade === grade.value);
          db.updateProductField(id, "sale_price", calcPrice(product.cost_price, rule));
        }
      } else if (field === "cost_price") {
        const cost = normMoney("cost_price", msg.value);
        if (!cost.ok) {
          log(`❌${cost.msg}`);
          return;
        }
        db.updateProductField(id, "cost_price", cost.value);
        if (product.price_manual === 1) {
          log(`⚠️${product.code} 售价是「自定义」，改进价不会重算售价；想跟随规则请把等级改回 ${product.grade || "对应等级"}`);
        } else {
          const rule = db.getRules().find((r) => r.grade === product.grade);
          db.updateProductField(id, "sale_price", calcPrice(cost.value, rule));
        }
      } else if (field === "sale_price") {
        const sale = normMoney("sale_price", msg.value);
        if (!sale.ok) {
          log(`❌${sale.msg}`);
          return;
        }
        if (sale.value > 0) {
          // 手动填售价 → 转「自定义」（等级列会显示“自定义”）
          db.updateProductField(id, "sale_price", sale.value);
          db.updateProductField(id, "price_manual", 1);
        } else {
          // 清空售价 → 回归规则，立即按当前进价重算
          const rule = db.getRules().find((r) => r.grade === product.grade);
          db.updateProductField(id, "sale_price", calcPrice(product.cost_price, rule));
          db.updateProductField(id, "price_manual", 0);
        }
      } else {
        db.updateProductField(id, field, msg.value);
      }
      h.pushUndo(
        snap,
        `修改 ${product.code} 的「${PRODUCT_FIELD_LABELS[field] || field}」`,
      );
      log(`✏️已更新 ${product.code}`);
      if (gradeRuleCreated) {
        h.post({ type: "rulesLoaded", rules: db.getRules() });
      }
      h.postProductsDelta([id]);
    },

    setStockQty(msg) {
      const sid = Number(msg.id);
      const product = db.getProductById(sid);
      if (!product) {
        log("❌商品不存在");
        return;
      }
      const qty = normInt("stockTotal", msg.qty);
      if (!qty.ok) {
        log(`❌${qty.msg}`);
        return;
      }
      const snap = h.snapshot();
      db.updateStockQty(sid, qty.value);
      const display = qty.value;
      h.pushUndo(snap, `清点库存 ${product.code} → ${display}`);
      log(`🔢清点 ${product.code} 库存 = ${display}`);
      h.postProductsDelta([sid]);
    },

    async deleteProduct(msg) {
      const id = Number(msg.id);
      const p = db.getProductById(id);
      if (p) {
        await h.preOpBackup();
      }
      // ===== 套装（可整体移除）=====
      // 硬删除不可逆，删之前先把"会连带丢掉的关联"记下来 —— db.deleteProduct 的事务里会
      // 顺手清掉 set_items（它作为套装被删 → 整份清单没了；作为子商品被删 → 从所有套装里摘掉），
      // 这里只负责把代价说出来，别让用户删完才发现套装少了个零件。
      // 注意 p 必须在 db.deleteProduct 之前读，删完就查不到了。
      let setNote = "";
      if (p) {
        const inSets = db.setsOfCode(p.code);
        const childCnt = Number(p.kind) === 1 ? db.listSetMembers(p.code).length : 0;
        if (inSets.length) {
          setNote += `，已从套装 ${inSets.join("、")} 中移出`;
        }
        if (childCnt) {
          setNote += `，其 ${childCnt} 个子商品的关联一并清除（商品本身不受影响）`;
        }
      }
      const snap = h.snapshot();
      if (p) {
        // 先删图片文件夹（删不掉也不阻塞删商品，但会打印完整路径），再删商品
        h.removeImageFolder(p.code);
        h.invalidateCover(p.code);
      }
      db.deleteProduct(id);
      h.pushUndo(snap, `删除商品 ${p ? p.code : id}（含其销售/入库记录）`);
      log(`🗑已删除 ${p ? p.code : id}（含其销售记录与入库记录）${setNote}`);
      h.refreshSales(todayStr());
      h.postProductsDelta([], [id]);
      h.postLiveState();
    },

    setStatus(msg) {
      const id = Number(msg.id);
      const status = msg.status === 1 ? 1 : 0;
      const snap = h.snapshot();
      db.updateProductField(id, "status", status);
      const p = db.getProductById(id);
      h.pushUndo(snap, `${status === 1 ? "下架" : "上架"} ${p?.code ?? id}`);
      log(status === 1 ? `🔻已下架 ${p?.code ?? id}` : `🔺已上架 ${p?.code ?? id}`);
      h.postProductsDelta([id]);
    },

    saveRules(msg) {
      const rules: SaleRule[] = (msg.rules ?? []).map(normalizeRule);
      const grades = new Set<number>();
      for (const r of rules) {
        const g = Number(r.grade);
        if (!Number.isInteger(g) || g < 1 || g > 99) {
          log("❌等级必须为 1~99 的整数");
          return;
        }
        if (grades.has(g)) {
          log("❌等级重复：" + g);
          return;
        }
        applyExpr(10, r.expr);
        grades.add(g);
      }
      for (const r of rules) {
        if (applyExpr(10, r.expr) === null) {
          log(`❌等级 ${r.grade} 的公式非法：${r.expr}`);
          return;
        }
      }
      // 删规则前先看还有谁跟着走。少了规则 → calcPrice 拿 undefined → 售价回落成
      // 进价，0 毛利，而且只在日志里留一句「已重算」，事后根本看不出来。
      // 这里直接拦下来，把受影响的编号报出去，让人先把商品改成自定义或换个等级。
      const kept = new Set(rules.map((r) => Number(r.grade)));
      const orphans = db
        .getProducts()
        .filter((p) => p.price_manual !== 1 && p.grade > 0 && !kept.has(p.grade));
      if (orphans.length > 0) {
        const detail = orphans
          .slice(0, 12)
          .map((p) => p.code)
          .join("、");
        const more = orphans.length > 12 ? ` 等 ${orphans.length} 个` : "";
        const grades = Array.from(new Set(orphans.map((p) => p.grade))).join("、");
        log(`❌等级 ${grades} 的规则被删了，但还有 ${orphans.length} 个商品跟着它算售价：${detail}${more}`);
        log("   请先把这些商品改成「自定义」或改到其它等级，再保存规则");
        return;
      }
      const snap = h.snapshot();
      db.replaceRules(rules);
      db.runInTx(() => {
        for (const p of db.getProducts()) {
          if (p.price_manual === 1) {
            continue;
          }
          const rule = rules.find((r) => r.grade === p.grade);
          db.updateProductField(p.id, "sale_price", calcPrice(p.cost_price, rule));
        }
      });
      h.pushUndo(snap, "保存售价规则（已重算受影响商品售价）");
      log("📐售价规则已保存，受影响商品已重算售价");
      h.loadAll();
    },

    setProductsStatus(msg) {
      const ids: number[] = (msg.ids || []).map(Number);
      const status = msg.status === 1 ? 1 : 0;
      if (ids.length === 0) {
        log("⚠没有选中要操作的商品");
        return;
      }
      const snap = h.snapshot();
      db.runInTx(() => {
        for (const id of ids) {
          db.updateProductField(id, "status", status);
        }
      });
      h.pushUndo(snap, `批量${status === 1 ? "下架" : "上架"} ${ids.length} 个商品`);
      log(`✅已${status === 1 ? "下架" : "上架"} ${ids.length} 个商品`);
      h.postProductsDelta(ids);
    },

    setProductsStock(msg) {
      const ids: number[] = (msg.ids || []).map(Number);
      if (ids.length === 0) {
        log("⚠没有选中要操作的商品");
        return;
      }
      const mode = ["set", "add", "sub"].includes(String(msg.mode))
        ? String(msg.mode)
        : "set";
      const qty = normInt("stockTotal", msg.qty);
      if (!qty.ok) {
        log(`❌${qty.msg}`);
        return;
      }
      const snap = h.snapshot();
      const changed: number[] = [];
      db.runInTx(() => {
        for (const id of ids) {
          const p = db.getProductById(id);
          if (!p) {
            continue;
          }
          const cur = Number(p.stock_manual || 0);
          const next =
            mode === "add"
              ? cur + qty.value
              : mode === "sub"
                ? Math.max(0, cur - qty.value)
                : qty.value;
          db.updateStockQty(id, next);
          changed.push(id);
        }
      });
      const label =
        mode === "add"
          ? `增加 ${qty.value}`
          : mode === "sub"
            ? `减少 ${qty.value}`
            : `设为 ${qty.value}`;
      h.pushUndo(snap, `批量改库存（${label}）${changed.length} 个商品`);
      log(`🔢批量改库存：${changed.length} 个商品 ${label}`);
      h.postProductsDelta(changed);
    },

    setProductsField(msg) {
      const ids: number[] = (msg.ids || []).map(Number);
      if (ids.length === 0) {
        log("⚠没有选中要操作的商品");
        return;
      }
      const field = String(msg.field);
      if (field !== "grade" && field !== "purchase_link") {
        log("❌批量操作目前仅支持「等级」和「采购链接」");
        return;
      }
      let value: number | string;
      if (field === "grade") {
        const g = normGrade(msg.value);
        if (!g.ok) {
          log(`❌${g.msg}`);
          return;
        }
        value = g.value;
      } else {
        const t = normText("purchase_link", msg.value);
        if (!t.ok) {
          log(`❌${t.msg}`);
          return;
        }
        value = t.value;
      }
      const snap = h.snapshot();
      const changed: number[] = [];
      let gradeRuleCreated = false;
      // 规则表循环里读一次就好：只有 ensureRule 真新建了才重读，其余行共用同一份
      let rules = db.getRules();
      db.runInTx(() => {
        for (const id of ids) {
          const p = db.getProductById(id);
          if (!p) {
            continue;
          }
          if (field === "grade") {
            if (value === 0) {
              // 切成「自定义」：售价固定不动，不再跟随规则
              db.updateProductField(id, "grade", 0);
              db.updateProductField(id, "price_manual", 1);
            } else {
              if (db.ensureRule(Number(value))) {
                gradeRuleCreated = true;
                rules = db.getRules();
              }
              db.updateProductField(id, "grade", Number(value));
              db.updateProductField(id, "price_manual", 0);
              const rule = rules.find((r) => r.grade === value);
              db.updateProductField(id, "sale_price", calcPrice(p.cost_price, rule));
            }
          } else {
            db.updateProductField(id, "purchase_link", value);
          }
          changed.push(id);
        }
      });
      h.pushUndo(
        snap,
        `批量${field === "grade" ? "改等级" : "改采购链接"} ${changed.length} 个商品`,
      );
      log(`✅批量${field === "grade" ? "改等级" : "改采购链接"}：${changed.length} 个商品`);
      if (field === "grade" && gradeRuleCreated) {
        h.post({ type: "rulesLoaded", rules: db.getRules() });
      }
      h.postProductsDelta(changed);
    },

    async deleteProducts(msg) {
      const ids: number[] = (msg.ids || []).map(Number);
      if (ids.length === 0) {
        log("⚠没有选中要删除的商品");
        return;
      }
      await h.preOpBackup();
      const snap = h.snapshot();
      let n = 0;
      const deleted: string[] = [];
      // ===== 套装（可整体移除）===== 批量删同样要把套装关联的代价汇总出来（见 deleteProduct 的说明）
      const setsAffected = new Set<string>();
      for (const id of ids) {
        const p = db.getProductById(id);
        if (p) {
          deleted.push(p.code);
          for (const sc of db.setsOfCode(p.code)) {
            setsAffected.add(sc);
          }
          if (Number(p.kind) === 1) {
            setsAffected.add(p.code);
          }
        }
        db.deleteProduct(id);
        n++;
      }
      let imgCleaned = 0;
      for (const code of deleted) {
        if (h.removeImageFolder(code)) {
          imgCleaned++;
        }
        h.invalidateCover(code);
      }
      if (imgCleaned > 0) {
        log(`🗑已同时清理 ${imgCleaned} 个商品图片文件夹`);
      }
      h.pushUndo(snap, `批量删除商品 ${n} 个`);
      log(
        `✅删除商品 ${n} 个${deleted.length ? `：${deleted.slice(0, 8).join("、")}${deleted.length > 8 ? " 等" : ""}` : ""}` +
          // ===== 套装（可整体移除）=====
          (setsAffected.size ? `（涉及其中的套装 ${Array.from(setsAffected).slice(0, 6).join("、")}）` : ""),
      );
      h.refreshSales(todayStr());
      h.postProductsDelta([], ids);
      h.postLiveState();
    },

    addStockIn(msg) {
      const qty = Math.floor(Number(msg.qty ?? 0));
      if (qty <= 0) {
        log("❌入库数量必须 > 0");
        return;
      }
      const id = Number(msg.productId);
      const p = db.getProductById(id);
      if (!p) {
        log("❌商品不存在");
        return;
      }
      const snap = h.snapshot();
      db.addStockIn({
        product_id: id,
        qty,
        date: String(msg.date ?? todayStr()),
        remark: String(msg.remark ?? "补货入库"),
      });
      h.pushUndo(snap, `入库 ${p.code} +${qty}`);
      log(`📦已入库 ${p.code} +${qty}`);
      h.postProductsDelta([p.id]);
    },

    loadStockIns() {
      h.postStockIns();
    },

    async delStockIn(msg) {
      const id = Number(msg.id);
      const row = db.getStockIns().find((r) => r.id === id);
      await h.preOpBackup();
      const snap = h.snapshot();
      db.deleteStockIn(id);
      h.pushUndo(snap, `删除入库记录（${row ? row.code : id}）`);
      log("🗑已删除入库记录");
      h.postStockIns();
      if (row) {
        h.postProductsDelta([row.product_id]);
      }
    },

    async previewImportProducts(msg) {
      const mode = msg.mode === "add" || msg.mode === "update" ? msg.mode : "both";
      // 导入列 = “编号” + 客户端勾选的可写字段（优先）；缺省回退 当前可见列∩可写字段
      let importable: Array<{ key: string; label: string }>;
      const want =
        Array.isArray(msg.fields) && msg.fields.length
          ? new Set<string>(msg.fields.map(String))
          : null;
      if (want) {
        importable = IMPORTABLE_FIELD_ORDER.filter((f) => want.has(f.key));
      } else {
        const rawVisSetting = String(h.getSetting("col_visible_list") || "");
        let rawVis: unknown = [];
        let hasVisConfig = false;
        if (rawVisSetting) {
          hasVisConfig = true;
          try {
            rawVis = JSON.parse(rawVisSetting);
          } catch {
            rawVis = [];
          }
        }
        const visSet = new Set<string>(Array.isArray(rawVis) ? (rawVis as string[]) : []);
        importable = IMPORTABLE_FIELD_ORDER.filter((f) => visSet.has(f.key));
        if (importable.length === 0) {
          // 从未配置时兜底为完整可写列（=旧 8 列格式），避免第一次用时只导得进编号；
          // 用户故意只保留编号 → 不导入任何可写字段，只定位/更新编号本身
          importable = hasVisConfig ? [] : IMPORTABLE_FIELD_ORDER;
        }
      }
      // 记住这次的勾选与模式，下次打开弹窗默认。
      // 导入列选什么是各人习惯（各有各的表格），落本机不写共享库
      await h.setSetting("import_fields", JSON.stringify(importable.map((f) => f.key)));
      await h.setSetting("import_mode", mode);
      const importFields = ["code"].concat(
        importable.map((f) => f.key),
      );
      const plan = buildImportPlan(String(msg.text ?? ""), mode, importFields);
      // 计划暂存于此（预览无任何落库副作用），凭随机 token 提交防误触发
      const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      pendingImport = {
        token,
        mode,
        modeLabel: mode === "add" ? "只新增" : mode === "update" ? "只修改" : "新增＋修改",
        newRows: plan.newRows,
        updateRows: plan.updateRows,
        gradesToEnsure: plan.gradesToEnsure,
        skipped: plan.skipped,
        bad: plan.bad,
        dup: plan.dupLines,
        setBlocked: plan.setBlocked,
      };
      post({
        type: "importPreview",
        ok: true,
        token,
        created: plan.newRows.length,
        updated: plan.updateRows.length,
        skipped: plan.skipped,
        bad: plan.bad,
        duplicates: plan.dupLines.length,
        duplicateLines: plan.dupLines,
        // ===== 套装（可整体移除）===== 让预览弹窗能把「哪几行是 T 开头、为什么没收」列出来
        setBlocked: plan.setBlocked,
        rows: plan.displayRows.slice(0, IMPORT_PREVIEW_ROW_LIMIT),
        total: plan.displayRows.length,
        truncated: plan.displayRows.length > IMPORT_PREVIEW_ROW_LIMIT,
      });
      log(
        `🔍预览商品导入：将新增 ${plan.newRows.length}、将更新 ${plan.updateRows.length}` +
          (plan.skipped ? `，将跳过 ${plan.skipped}` : "") +
          (plan.dupLines.length ? `，其中重复编号 ${plan.dupLines.length} 行已忽略` : "") +
          (plan.setBlocked.length ? `，${plan.setBlocked.length} 行 T 开头（导入不做套装）` : "") +
          (plan.bad.length ? `，无法解析 ${plan.bad.length} 行` : ""),
      );
      for (const d of plan.dupLines) {
        log(`  ⚠️${d}`);
      }
      for (const s of plan.setBlocked) {
        log(`  ⚠️${s}`);
      }
    },

    async commitImportProducts(msg) {
      if (!pendingImport || String(msg.token ?? "") !== pendingImport.token) {
        log("❌导入预览已失效：请重新打开「导入商品」并先解析预览");
        return;
      }
      const plan = pendingImport;
      pendingImport = null;
      // 刻意不 preOpBackup：下面 h.snapshot() 抓的是同一份「导入前」状态，已经进了撤销栈
      // （上限 20 条），留档并不会多保住任何信息，只是把同一份数据再整库拷一遍到共享盘和本机。
      // 导入是 preOpBackup 唯一的日常高频调用点，删档/恢复这类真·破坏性操作才留。
      // 跨会话的兜底靠每日自动备份（shop_auto_*）和设置里的手动「备份数据库」。
      const snap = h.snapshot();
      let created = 0;
      let updated = 0;
      let skipped = plan.skipped;
      let identitySkipped = 0;
      // 预览把应该确保的等级记下来了，这里统一创建（缺的才创建，与旧行为一致）
      for (const grade of plan.gradesToEnsure) {
        if (db.ensureRule(grade)) {
          log(`ℹ️等级 ${grade} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
        }
      }
      // 等级会在上一步全部补齐，规则表读一次就好，不再每行重读
      const rules = db.getRules();
      const ruleOf = (grade: number): SaleRule | undefined =>
        rules.find((r) => r.grade === grade);
      // 提交完把这批编号的 id 收起来，待会儿只增量推它们（整表重推在共享盘上是几秒）
      const touched: number[] = [];
      // 新行/更新行这两趟写包进一个事务：整批一次提交，共享盘上省掉逐行的网络提交
      db.runInTx(() => {
        for (const row of plan.newRows) {
          // 提交前身份复检：预览后该编号被占用 → 跳过，避免覆盖
          if (db.getProductByCode(row.code)) {
            identitySkipped++;
            skipped++;
            continue;
          }
          const custom = row.grade === 0;
          const rule = custom ? undefined : ruleOf(row.grade);
          const sale = custom || row.manual > 0 ? row.manual : calcPrice(row.cost, rule);
          const id = db.addProduct({
            code: row.code,
            name: row.name || row.code,
            category: row.category,
            series: row.series,
            grade: row.grade,
            cost_price: row.cost,
            sale_price: sale,
            price_manual: custom || row.manual > 0 ? 1 : 0,
            purchase_link: row.purchase_link,
            status: row.status,
            remark: "",
            stock_manual: 0,
            // 导入永远只建普通商品：T 开头的行在解析阶段就已经被挡下了（见 buildImportPlan）
            kind: 0,
          });
          touched.push(id);
          created++;
        }
        for (const row of plan.updateRows) {
          const exist = db.getProductByCode(row.code);
          // 提交前身份复检：预览后该编号被删除 → 跳过
          if (!exist) {
            identitySkipped++;
            skipped++;
            continue;
          }
          for (const op of row.writes) {
            db.updateProductField(exist.id, op.field, op.value);
          }
          touched.push(exist.id);
          updated++;
        }
      });
      log(
        `📥商品导入（${plan.modeLabel}）：新增 ${created}，更新 ${updated}` +
          (skipped ? `，跳过 ${skipped}` : "") +
          (plan.setBlocked.length ? `，${plan.setBlocked.length} 行 T 开头未导入` : "") +
          (plan.bad.length ? `，无法解析 ${plan.bad.length} 行` : ""),
      );
      if (identitySkipped > 0) {
        log(`  ⚠️${identitySkipped} 行因预览后商品编号已被占用/删除而未应用`);
      }
      for (const b of plan.bad) {
        log(`  ⚠️${b}`);
      }
      for (const d of plan.dup) {
        log(`  ⚠️${d}`);
      }
      // ===== 套装（可整体移除）=====
      for (const s of plan.setBlocked) {
        log(`  ⚠️${s}`);
      }
      if (created > 0 || updated > 0) {
        h.pushUndo(snap, `商品导入（${plan.modeLabel} 新增 ${created}、更新 ${updated}）`);
      }
      post({
        type: "productsImported",
        ok: true,
        created,
        updated,
        skipped,
        bad: plan.bad,
        // 重复编号的具体行号也要发出去：之前只进日志，提交完弹窗一关就再也找不到了。
        // 字段形状跟 importPreview 保持一致（duplicates 计数 / duplicateLines 明细）
        duplicates: plan.dup.length,
        duplicateLines: plan.dup,
        // ===== 套装（可整体移除）=====
        setBlocked: plan.setBlocked,
        mode: plan.mode as string,
      });
      // 只把这批动过的商品推回去，不整库重读重推（共享盘上那是几秒的等待）。
      // 筛选面板重建前端挂在 productsDelta 上（新分类/新系列靠它出现），规则新建的
      // 时候也顺手推一份 —— 以前这两样都是整表推送顺带做的。
      if (touched.length > 0) {
        h.postProductsDelta(touched);
      }
      if (plan.gradesToEnsure.length > 0) {
        post({ type: "rulesLoaded", rules: db.getRules() });
      }
    },
  };
}