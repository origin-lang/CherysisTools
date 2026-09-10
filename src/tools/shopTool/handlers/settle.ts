import { Handler, HandlerCtx } from "./types.js";
import { round2, todayStr } from "../pricing.js";

// 月结域：月度结算的生成/保存/锁定/解锁/删除
export function settleHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;

  const prevMonth = (month: string): string => {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) {
      return "";
    }
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  };

  return {
    monthBuild(msg) {
      const month = String(msg.month ?? todayStr().slice(0, 7));
      const snapshot = db.snapshotMonth(month);
      const settle = db.getSettle(month);
      post({
        type: "monthBuilt",
        month,
        snapshot,
        settle: settle ?? null,
        prevEndStock: Number(db.getSettle(prevMonth(month))?.end_stock || 0),
        endStockAuto: round2(db.sumStockCost()),
      });
    },

    saveSettle(msg) {
      const month = String(msg.month ?? todayStr().slice(0, 7));
      const settle = db.getSettle(month);
      if (settle && settle.locked === 1) {
        log(`❌${month} 已锁定，先解锁再改`);
        return;
      }
      const income = Number(msg.incomeAmount ?? 0);
      const purchase = Number(msg.purchaseCost ?? 0);
      const extra = Number(msg.extraExpense ?? 0);
      const startStock = Number(msg.startStock ?? 0);
      const endStock = round2(db.sumStockCost());
      const vals = [income, purchase, extra, startStock];
      if (!vals.every(Number.isFinite) || vals.some((v) => v < 0)) {
        log("❌到账/进货/杂项/期初需为非负数");
        return;
      }
      const snap = db.snapshotMonth(month);
      const profit = round2(income - purchase - extra + endStock - startStock);
      db.saveSettle({
        month,
        income_amount: income,
        extra_expense: extra,
        purchase_cost: purchase,
        end_stock: endStock,
        start_stock: startStock,
        goods_cost: round2(snap.goods_cost),
        sold_total: snap.sold_total,
        refund_total: snap.refund_total,
        profit,
        locked: 0,
      });
      log(
        `🖊已保存 ${month} 月报：到账¥${income} 进货¥${purchase} 杂项¥${extra} 期初¥${startStock} 期末¥${endStock} 净利润¥${profit}`,
      );
      post({
        type: "monthBuilt",
        month,
        snapshot: snap,
        settle: db.getSettle(month),
        prevEndStock: Number(db.getSettle(prevMonth(month))?.end_stock || 0),
        endStockAuto: round2(db.sumStockCost()),
      });
      post({ type: "settlesLoaded", settles: db.getSettleMonths() });
    },

    lockSettle(msg) {
      const month = String(msg.month ?? "");
      db.setLock(month, 1);
      log(`🔒已锁定 ${month}`);
      post({ type: "settlesLoaded", settles: db.getSettleMonths() });
      post({
        type: "monthBuilt",
        month,
        snapshot: db.snapshotMonth(month),
        settle: db.getSettle(month) ?? null,
        prevEndStock: Number(db.getSettle(prevMonth(month))?.end_stock || 0),
        endStockAuto: round2(db.sumStockCost()),
      });
    },

    unlockSettle(msg) {
      const month = String(msg.month ?? "");
      db.setLock(month, 0);
      log(`🔓已解锁 ${month}`);
      post({ type: "settlesLoaded", settles: db.getSettleMonths() });
      post({
        type: "monthBuilt",
        month,
        snapshot: db.snapshotMonth(month),
        settle: db.getSettle(month) ?? null,
        prevEndStock: Number(db.getSettle(prevMonth(month))?.end_stock || 0),
        endStockAuto: round2(db.sumStockCost()),
      });
    },

    async deleteSettle(msg) {
      const month = String(msg.month ?? "");
      await h.preOpBackup();
      db.deleteSettle(month);
      log(`🗑已删除 ${month} 月报`);
      post({ type: "settlesLoaded", settles: db.getSettleMonths() });
    },
  };
}