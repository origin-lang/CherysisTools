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
          const v = Number(rawv);
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
        const gradeRaw = has("grade") ? real(getv("grade")) : null;
        const costRaw = has("cost_price") ? real(getv("cost_price")) : null;
        const saleRaw = has("sale_price") ? real(getv("sale_price")) : null;
        const gradeOk = gradeRaw !== null && gradeRaw >= 0 && gradeRaw <= 99;
        const costOk = costRaw !== null && costRaw >= 0;
        const gradeChange = gradeOk && gradeRaw !== exist.grade;
        const costChange = costOk && round2(costRaw as number) !== exist.cost_price;
        const effGrade = gradeOk ? (gradeRaw as number) : exist.grade;
        const effCost = costOk ? round2(costRaw as number) : exist.cost_price;
        if (gradeChange) {
          writes.push({ field: "grade", value: gradeRaw as number });
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
        // 展示只列真实变化，避免同值重写刷屏
        const diffs: string[] = [];
        for (const w of writes) {
          if (w.field === "price_manual") {
            continue;
          }
          const oldVal = String((exist as unknown as Record<string, unknown>)[w.field] ?? "");
          const newVal = String(w.value);
          if (oldVal !== newVal) {
            diffs.push(`${PRODUCT_FIELD_LABELS[w.field] ?? w.field}: ${oldVal || "（空）"}→${newVal || "（空）"}`);
          }
        }
        updateRows.push({ code, writes });
        displayRows.push({
          kind: "update",
          code,
          name: exist.name,
          detail: diffs.length ? diffs.join("；") : "（无实际变化，仅重写）",
        });
        continue;
      }
      if (mode === "update") {
        skipped++;
        continue;
      }
      const get = (key: string) => {
        const idx = importFields.indexOf(key);
        return idx >= 0 ? String(parts[idx] ?? "") : "";
      };
      const name = normText("name", get("name")).value || code;
      const category = normText("category", get("category")).value;
      const series = normText("series", get("series")).value;
      const gradeRaw = Math.floor(Number(get("grade") || 1));
      const grade = Number.isFinite(gradeRaw) && gradeRaw >= 0 && gradeRaw <= 99 ? gradeRaw : 1;
      const costRaw = Number(get("cost_price") || 0);
      const cost = Number.isFinite(costRaw) && costRaw >= 0 ? round2(costRaw) : 0;
      const saleRaw = Number(get("sale_price") || 0);
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
      displayRows,
    };
  };

  return {
    addProduct(msg) {
      const code = canonicalCode(msg.code);
      if (!code) {
        log("❌编号格式错误（应形如 L001~L9999，3 位补零，最多 4 位）");
        return;
      }
      if (db.getProductByCode(code)) {
        log(`❌编号 ${code} 已存在`);
        return;
      }
      const nameR = normText("name", msg.name, { required: true });
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
      const grade = normGrade(msg.grade ?? 1);
      if (!grade.ok) {
        log(`❌${grade.msg}`);
        return;
      }
      const initialStock = normInt("stockTotal", msg.initialStock);
      if (!initialStock.ok) {
        log(`❌${initialStock.msg}`);
        return;
      }
      const snap = h.snapshot();
      const custom = grade.value === 0;
      if (!custom && db.ensureRule(grade.value)) {
        log(`ℹ️等级 ${grade.value} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
      }
      const isManual = custom || sale.value > 0;
      const pid = db.addProduct({
        code,
        name: nameR.value,
        category: categoryR.value,
        series: seriesR.value,
        grade: grade.value,
        cost_price: cost.value,
        sale_price: isManual ? sale.value : calcPrice(cost.value, custom ? undefined : db.getRules().find((r) => r.grade === grade.value)),
        price_manual: isManual ? 1 : 0,
        purchase_link: linkR.value,
        status: 0,
        remark: remarkR.value,
        stock_manual: 0,
      });
      if (initialStock.value > 0) {
        db.addStockIn({
          product_id: pid,
          qty: initialStock.value,
          date: todayStr(),
          remark: "期初入库",
        });
      }
      h.pushUndo(snap, `新建商品 ${code} ${nameR.value}（期初库存 +${initialStock.value}）`);
      log(`✅已新建 ${code} ${nameR.value}（库存 +${initialStock.value}）`);
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
      if (field === "code") {
        const code = canonicalCode(msg.value);
        if (!code) {
          log("❌编号格式错误");
          return;
        }
        const exist = db.getProductByCode(code);
        if (exist && exist.id !== id) {
          log(`❌编号 ${code} 已存在`);
          return;
        }
        db.updateProductField(id, "code", code);
      } else if (field === "name" || field === "category" || field === "series" || field === "purchase_link" || field === "remark") {
        const r = normText(field, msg.value, field === "name" ? { required: true } : undefined);
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
      h.loadAll();
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
      const snap = h.snapshot();
      if (p) {
        // 先删图片文件夹（删不掉也不阻塞删商品，但会打印完整路径），再删商品
        h.removeImageFolder(p.code);
        h.invalidateCover(p.code);
      }
      db.deleteProduct(id);
      h.pushUndo(snap, `删除商品 ${p ? p.code : id}（含其销售/入库记录）`);
      log(`🗑已删除 ${p ? p.code : id}（含其销售记录与入库记录）`);
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
      const snap = h.snapshot();
      db.replaceRules(rules);
      for (const p of db.getProducts()) {
        if (p.price_manual === 1) {
          continue;
        }
        const rule = rules.find((r) => r.grade === p.grade);
        db.updateProductField(p.id, "sale_price", calcPrice(p.cost_price, rule));
      }
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
      for (const id of ids) {
        db.updateProductField(id, "status", status);
      }
      h.pushUndo(snap, `批量${status === 1 ? "下架" : "上架"} ${ids.length} 个商品`);
      log(`✅已${status === 1 ? "下架" : "上架"} ${ids.length} 个商品`);
      h.postProductsDelta(ids);
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
      for (const id of ids) {
        const p = db.getProductById(id);
        if (p) {
          deleted.push(p.code);
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
      log(`✅删除商品 ${n} 个${deleted.length ? `：${deleted.slice(0, 8).join("、")}${deleted.length > 8 ? " 等" : ""}` : ""}`);
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

    previewImportProducts(msg) {
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
      // 记住这次的勾选与模式，下次打开弹窗默认
      db.setSetting("import_fields", JSON.stringify(importable.map((f) => f.key)));
      db.setSetting("import_mode", mode);
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
      };
      post({
        type: "importPreview",
        ok: true,
        token,
        created: plan.newRows.length,
        updated: plan.updateRows.length,
        skipped: plan.skipped,
        bad: plan.bad,
        rows: plan.displayRows.slice(0, IMPORT_PREVIEW_ROW_LIMIT),
        total: plan.displayRows.length,
        truncated: plan.displayRows.length > IMPORT_PREVIEW_ROW_LIMIT,
      });
      log(
        `🔍预览商品导入：将新增 ${plan.newRows.length}、将更新 ${plan.updateRows.length}` +
          (plan.skipped ? `，将跳过 ${plan.skipped}` : "") +
          (plan.bad.length ? `，无法解析 ${plan.bad.length} 行` : ""),
      );
    },

    async commitImportProducts(msg) {
      if (!pendingImport || String(msg.token ?? "") !== pendingImport.token) {
        log("❌导入预览已失效：请重新打开「导入商品」并先解析预览");
        return;
      }
      const plan = pendingImport;
      pendingImport = null;
      await h.preOpBackup();
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
      const ruleOf = (grade: number): SaleRule | undefined =>
        db.getRules().find((r) => r.grade === grade);
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
        db.addProduct({
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
        });
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
        updated++;
      }
      log(
        `📥商品导入（${plan.modeLabel}）：新增 ${created}，更新 ${updated}` +
          (skipped ? `，跳过 ${skipped}` : "") +
          (plan.bad.length ? `，无法解析 ${plan.bad.length} 行` : ""),
      );
      if (identitySkipped > 0) {
        log(`  ⚠️${identitySkipped} 行因预览后商品编号已被占用/删除而未应用`);
      }
      for (const b of plan.bad) {
        log(`  ⚠️${b}`);
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
        mode: plan.mode as string,
      });
      h.loadAll();
    },
  };
}