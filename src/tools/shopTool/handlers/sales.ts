import { Handler, HandlerCtx } from "./types.js";
import { Product } from "../db.js";
import { monthOf, todayStr } from "../pricing.js";
import { splitCells, isHeaderRow, codeFromCell } from "../rowParse.js";

// 销售域：按日期加载/单条增改/粘贴批量/删除/单元格改值/趋势
export function salesHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;

  const replySales = (date: string) => {
    post({ type: "salesLoaded", date, sales: h.db.getSales(date) });
  };

  const lockedMonth = (month: string): boolean => {
    const s = h.db.getSettle(month);
    return !!s && s.locked === 1;
  };

  const requireMonthUnlocked = (date: string): string | null => {
    const month = monthOf(date);
    return lockedMonth(month) ? month : null;
  };

  return {
    loadSales(msg) {
      replySales(String(msg.date ?? todayStr()));
    },

    saveSale(msg) {
      const date = String(msg.date ?? todayStr());
      const lk = requireMonthUnlocked(date);
      if (lk) {
        log(`❌${lk} 已月结锁定，不能改销售记录（去“分析·月报”解锁）`);
        return;
      }
      const productId = Number(msg.productId);
      const p = db.getProductById(productId);
      if (!p) {
        log("❌商品不存在");
        return;
      }
      const sold = Math.floor(Number(msg.sold ?? 0));
      const refund = Math.floor(Number(msg.refund ?? 0));
      if (!Number.isFinite(sold) || !Number.isFinite(refund) || sold < 0 || refund < 0 || (sold === 0 && refund === 0)) {
        log("❌卖出/退款需为非负整数，且至少一个 > 0");
        return;
      }
      const mode = msg.mode === "overwrite" ? "overwrite" : msg.mode === "skip" ? "skip" : "accumulate";
      const res = db.upsertSale({
        product_id: productId,
        date,
        sold_qty: sold,
        refund_qty: refund,
        cost_price: p.cost_price,
        note: String(msg.note ?? ""),
        mode,
      });
      log(
        res === "created"
          ? `📝已记录 ${p.code} 卖${sold}退${refund}`
          : res === "updated"
            ? mode === "overwrite"
              ? `📝已覆盖 ${p.code}（当天已有记录，替换为 卖${sold}退${refund}）`
              : `📝已累加 ${p.code}（当天已有记录，卖出+${sold} 退款+${refund}）`
            : `⏭已跳过 ${p.code}（当天已有记录）`,
      );
      h.refreshSales(date);
      h.postProductsDelta([productId]);
    },

    pasteSales(msg) {
      const date = String(msg.date ?? todayStr());
      const lk = requireMonthUnlocked(date);
      if (lk) {
        log(`❌${lk} 已月结锁定，不能改销售记录`);
        return;
      }
      const mode = msg.mode === "overwrite" ? "overwrite" : msg.mode === "skip" ? "skip" : "accumulate";
      const lines = String(msg.text ?? "").split(/\r?\n/);
      const products = db.getProducts();
      const byCode = new Map<string, Product>();
      for (const p of products) {
        byCode.set(p.code, p);
      }
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const missing = new Set<string>();
      const bad: string[] = [];
      const seen = new Set<string>();
      const touchedIds = new Set<number>();
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
        const sold = Math.floor(Number(parts[1] ?? 0));
        const refund = Math.floor(Number(parts[2] ?? 0));
        if (!Number.isFinite(sold) || !Number.isFinite(refund) || sold < 0 || refund < 0) {
          bad.push(`行${i + 1}: ${raw}`);
          continue;
        }
        if (sold === 0 && refund === 0) {
          bad.push(`行${i + 1}: ${raw}（卖出和退款都是 0，忽略）`);
          continue;
        }
        const product = byCode.get(code);
        if (!product) {
          missing.add(code);
          continue;
        }
        if (seen.has(product.code)) {
          bad.push(`行${i + 1}: ${raw}（本批重复行，忽略）`);
          continue;
        }
        seen.add(product.code);
        const res = db.upsertSale({
          product_id: product.id,
          date,
          sold_qty: sold,
          refund_qty: refund,
          cost_price: product.cost_price,
          note: "",
          mode,
        });
        if (res === "created") {
          created++;
          touchedIds.add(product.id);
        } else if (res === "updated") {
          updated++;
          touchedIds.add(product.id);
        } else {
          skipped++;
        }
      }
      const missingList = [...missing];
      log(
        `📥粘贴完成：新增${created} 更新${updated} 跳过${skipped}` +
          (missingList.length
            ? `，未匹配编号 ${missingList.length} 个（${missingList.join(" ")}）`
            : "") +
          `，无法解析 ${bad.length} 行`,
      );
      for (const b of bad) {
        log(`  ⚠️${b}`);
      }
      post({
        type: "pasteResult",
        ok: true,
        created,
        updated,
        skipped,
        missing: missingList,
        badLines: bad,
      });
      h.refreshSales(date);
      h.postProductsDelta([...touchedIds]);
    },

    async deleteSales(msg) {
      const ids = Array.isArray(msg.ids) ? msg.ids.map(Number) : [Number(msg.id)];
      const date = String(msg.date ?? todayStr());
      const lk = requireMonthUnlocked(date);
      if (lk) {
        log(`❌${lk} 已月结锁定，不能删除销售记录`);
        return;
      }
      await h.preOpBackup();
      db.deleteSales(ids);
      log(`🗑已删除 ${ids.length} 条销售记录`);
      h.refreshSales(date);
      h.loadAll();
    },

    updateSalesField(msg) {
      const id = Number(msg.id);
      const field = String(msg.field);
      const date = String(msg.date ?? todayStr());
      if (field !== "sold_qty" && field !== "refund_qty" && field !== "note") {
        log("❌不支持的字段：" + field);
        return;
      }
      if (field === "sold_qty" || field === "refund_qty") {
        const n = Math.floor(Number(msg.value));
        if (!Number.isFinite(n) || n < 0) {
          log("❌卖出/退款需为非负整数");
          return;
        }
        const lk = requireMonthUnlocked(date);
        if (lk) {
          log(`❌${lk} 已月结锁定，不能改销售记录（去“分析·月报”解锁）`);
          return;
        }
        db.updateSalesField(id, field, n);
        log(`✏️已改 ${field === "sold_qty" ? "卖出" : "退款"}→ ${n}`);
      } else {
        db.updateSalesField(id, "note", String(msg.value ?? ""));
        log("✏️已改备注");
      }
      h.refreshSales(date);
      h.loadAll();
    },

    salesTrend(msg) {
      const by = msg.by === "day" ? "day" : "month";
      const productId = msg.productId ? Number(msg.productId) : undefined;
      const rows = db.salesTrend(by, String(msg.month ?? ""), productId);
      post({ type: "trendLoaded", by, rows, productId: productId ?? null });
    },
  };
}