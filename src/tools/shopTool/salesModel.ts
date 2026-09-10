// 销售 upsert 决策模型（纯函数，无副作用）：
// 模式矩阵（overwrite / accumulate / skip）、净售口径、库存 delta 只在这里定。
// db.upsertSale 只是把这层决策结果落库，测试只需普通对象即可打满矩阵。
export type UpsertMode = "overwrite" | "accumulate" | "skip";

export interface UpsertInput {
  sold_qty: number;
  refund_qty: number;
}

/** 净售口径：卖出 − 退款。全工具唯一处，防止各调用点推导口径漂移 */
export function net(sold: number, refund: number): number {
  return sold - refund;
}

/** 前端消息里的 mode 字段 → 规范化模式。非法值一律落到 accumulate（与原行为一致） */
export function resolveUpsertMode(raw: unknown): UpsertMode {
  return raw === "overwrite" ? "overwrite" : raw === "skip" ? "skip" : "accumulate";
}

export type UpsertDecision =
  | { action: "created"; sold_qty: number; refund_qty: number; stockDelta: number; saleDeltaSold: number; saleDeltaRefund: number }
  | { action: "updated"; sold_qty: number; refund_qty: number; stockDelta: number; saleDeltaSold: number; saleDeltaRefund: number }
  | { action: "skipped" };

/**
 * 按「当天已有记录 + 模式」决定落库动作与两组 delta：
 * - stockDelta：stock_manual 列要变的量（写入/覆盖 = 新旧净售差；累加 = -本次净售；新增 = -本次净售）
 * - saleDelta*：销量聚合缓存要变的量（覆盖 = 本次减旧的差值；其余 = 本次值）
 * 返回 skipped 表示不改任何数据。
 */
export function decideUpsert(
  existing: { sold_qty: number; refund_qty: number } | undefined,
  input: UpsertInput,
  mode: UpsertMode,
): UpsertDecision {
  if (!existing) {
    return {
      action: "created",
      sold_qty: input.sold_qty,
      refund_qty: input.refund_qty,
      stockDelta: -net(input.sold_qty, input.refund_qty),
      saleDeltaSold: input.sold_qty,
      saleDeltaRefund: input.refund_qty,
    };
  }
  if (mode === "skip") {
    return { action: "skipped" };
  }
  if (mode === "accumulate") {
    const sold_qty = existing.sold_qty + input.sold_qty;
    const refund_qty = existing.refund_qty + input.refund_qty;
    return {
      action: "updated",
      sold_qty,
      refund_qty,
      stockDelta: net(existing.sold_qty, existing.refund_qty) - net(sold_qty, refund_qty),
      saleDeltaSold: input.sold_qty,
      saleDeltaRefund: input.refund_qty,
    };
  }
  // overwrite：直接替换当天记录
  return {
    action: "updated",
    sold_qty: input.sold_qty,
    refund_qty: input.refund_qty,
    stockDelta: net(existing.sold_qty, existing.refund_qty) - net(input.sold_qty, input.refund_qty),
    saleDeltaSold: input.sold_qty - existing.sold_qty,
    saleDeltaRefund: input.refund_qty - existing.refund_qty,
  };
}