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

// 商品管理域：新建/编辑/清点/上下架/删除/批量/入库/导入
export function productHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;

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
      db.updateStockQty(sid, qty.value);
      const display = qty.value;
      log(`🔢清点 ${product.code} 库存 = ${display}`);
      h.loadAll();
    },

    async deleteProduct(msg) {
      const id = Number(msg.id);
      const p = db.getProductById(id);
      if (p) {
        await h.preOpBackup();
      }
      if (p) {
        // 先删图片文件夹（删不掉也不阻塞删商品，但会打印完整路径），再删商品
        h.removeImageFolder(p.code);
        h.invalidateCover(p.code);
      }
      db.deleteProduct(id);
      log(`🗑已删除 ${p ? p.code : id}（含其销售记录与入库记录）`);
      h.refreshSales(todayStr());
      h.loadAll();
    },

    setStatus(msg) {
      const id = Number(msg.id);
      const status = msg.status === 1 ? 1 : 0;
      db.updateProductField(id, "status", status);
      const p = db.getProductById(id);
      log(status === 1 ? `🔻已下架 ${p?.code ?? id}` : `🔺已上架 ${p?.code ?? id}`);
      h.loadAll();
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
      db.replaceRules(rules);
      for (const p of db.getProducts()) {
        if (p.price_manual === 1) {
          continue;
        }
        const rule = rules.find((r) => r.grade === p.grade);
        db.updateProductField(p.id, "sale_price", calcPrice(p.cost_price, rule));
      }
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
      for (const id of ids) {
        db.updateProductField(id, "status", status);
      }
      log(`✅已${status === 1 ? "下架" : "上架"} ${ids.length} 个商品`);
      h.loadAll();
    },

    async deleteProducts(msg) {
      const ids: number[] = (msg.ids || []).map(Number);
      if (ids.length === 0) {
        log("⚠没有选中要删除的商品");
        return;
      }
      await h.preOpBackup();
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
      log(`✅删除商品 ${n} 个${deleted.length ? `：${deleted.slice(0, 8).join("、")}${deleted.length > 8 ? " 等" : ""}` : ""}`);
      h.refreshSales(todayStr());
      h.loadAll();
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
      db.addStockIn({
        product_id: id,
        qty,
        date: String(msg.date ?? todayStr()),
        remark: String(msg.remark ?? "补货入库"),
      });
      log(`📦已入库 ${p.code} +${qty}`);
      h.loadAll();
    },

    loadStockIns() {
      h.postStockIns();
    },

    async delStockIn(msg) {
      const id = Number(msg.id);
      await h.preOpBackup();
      db.deleteStockIn(id);
      log("🗑已删除入库记录");
      h.postStockIns();
      h.loadAll();
    },

    async importProducts(msg) {
      await h.preOpBackup();
      const black: string[] = [];
      let created = 0;
      let updated = 0;
      let skipped = 0;
      // 导入列 = “编号” + 当前可见列∩可写字段（派生列不参与导入；默认可见=旧 8 列格式）
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
      // 只读列（编号）始终参与定位，但只取它自己的字段；导入列 = 可见∩可写
      let importable = IMPORTABLE_FIELD_ORDER.filter((f) =>
        visSet.has(f.key),
      );
      if (importable.length === 0) {
        if (!hasVisConfig) {
          // 从未配置时兜底为完整可写列（=旧 8 列格式），避免第一次用时只导得进编号
          importable = IMPORTABLE_FIELD_ORDER;
        } else {
          // 用户故意只保留编号 → 不导入任何可写字段，只定位/更新编号本身
          importable = [];
        }
      }
      const importFields = ["code"].concat(
        importable.map((f) => f.key),
      );
      const lines = String(msg.text ?? "").split(/\r?\n/);
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
          black.push(`行${i + 1}: ${raw}`);
          continue;
        }
        const exist = db.getProductByCode(code);
        if (exist) {
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
          let touched = 0;
          for (const key of ["name", "category", "series", "purchase_link"]) {
            if (has(key)) {
              db.updateProductField(exist.id, key, normText(key as "name" | "category" | "series" | "purchase_link", getv(key)).value);
              touched++;
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
            db.updateProductField(exist.id, "grade", gradeRaw);
            touched++;
          }
          if (costChange) {
            db.updateProductField(exist.id, "cost_price", round2(costRaw as number));
            touched++;
          }
          // 售价：填了 >0 → 手动价；否则非自定义且（售价列可见 或 等级/进价有变）→ 按规则重算
          const manualSale = saleRaw !== null && saleRaw > 0 ? round2(saleRaw) : null;
          if (manualSale !== null) {
            db.updateProductField(exist.id, "sale_price", manualSale);
            db.updateProductField(exist.id, "price_manual", 1);
            touched++;
          } else if (
            effGrade !== 0 &&
            (gradeChange ||
              costChange ||
              (importFields.includes("sale_price") && exist.price_manual !== 1))
          ) {
            if (db.ensureRule(effGrade)) {
              log(`ℹ️等级 ${effGrade} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
            }
            const rule = db.getRules().find((r) => r.grade === effGrade);
            const next = calcPrice(effCost, rule);
            if (exist.sale_price !== next || exist.price_manual !== 0) {
              touched++;
            }
            db.updateProductField(exist.id, "sale_price", next);
            db.updateProductField(exist.id, "price_manual", 0);
          }
          if (touched > 0) {
            updated++;
          } else {
            skipped++;
          }
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
        const manual = Number.isFinite(saleRaw) && saleRaw > 0 ? round2(saleRaw) : 0;
        const custom = grade === 0;
        if (!custom && db.ensureRule(grade)) {
          log(`ℹ️等级 ${grade} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
        }
        const rule = custom
          ? undefined
          : db.getRules().find((r) => r.grade === grade);
        db.addProduct({
          code,
          name: name || code,
          category,
          series,
          grade,
          cost_price: cost,
          sale_price: custom || manual > 0 ? manual : calcPrice(cost, rule),
          price_manual: custom || manual > 0 ? 1 : 0,
          purchase_link: link,
          status: 0,
          remark: "",
          stock_manual: 0,
        });
        created++;
      }
      log(
        `📥商品导入：新增 ${created} 个，更新 ${updated} 个（编号已存在）` +
          (skipped ? `，无变更 ${skipped} 个` : "") +
          (black.length ? `，无法解析 ${black.length} 行` : ""),
      );
      for (const b of black) {
        log(`  ⚠️${b}`);
      }
      post({ type: "productsImported", ok: true, created, updated, skipped, bad: black });
      h.loadAll();
    },
  };
}