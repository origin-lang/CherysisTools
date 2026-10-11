// ===== 套装（可整体移除）=====
// 这是套装功能的**唯一后端落点**：前缀常量、校验、四个消息全在这一个文件里。
//
// 想整体去掉套装：
//   1. 删本文件；
//   2. 删 index.ts 里 handlers 表的 `...setHandlers(h)` 那一行（同标记）；
//   3. 删 db.ts 里带同标记的那几处（kind 列、set_items 表、四个接口、deleteProduct 里的两条清理）；
//   4. 界面侧看 docs/套装-设计方案.md 第六章（6 个接入点，每个都带同标记）。
//
// 为什么单独一个文件：商家明确要求"这属于附加功能，哪天不好我可能都想去掉"。
// 散在各处就拔不干净了。
import { Handler, HandlerCtx } from "./types.js";
import { canonicalCode, round2 } from "../pricing.js";

/** 套装编号前缀。**全项目只允许在这里定义一次** —— 别在各处散着写 startsWith("T")。 */
export const SET_PREFIX = "T";

/**
 * 看编号**像不像**套装 —— 这是给人看的约定（一眼认出来）。
 * 机器判断请用 products.kind，别用这个：改号允许换前缀，只用前缀会漏。
 */
export function looksLikeSet(code: unknown): boolean {
  return String(code ?? "").trim().toUpperCase().startsWith(SET_PREFIX);
}

export function setHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;

  /**
   * 一个套装的当前全貌（成员 + 合计）。
   * 合计**永远现算、绝不落库** —— 落库就一定会跟子商品的真实值不同步（子商品调个价，
   * 套装的合计就成了旧数字），这是这类系统的经典坑。
   */
  const snapOf = (code: string) => {
    const items = db.listSetMembers(code);
    let sumCost = 0;
    let sumSale = 0;
    for (const it of items) {
      sumCost += Number(it.cost_price || 0);
      sumSale += Number(it.sale_price || 0);
    }
    return {
      code,
      items,
      count: items.length,
      sumCost: round2(sumCost),
      sumSale: round2(sumSale),
    };
  };

  return {
    /** 读一个套装的成员清单（打开套装详情页时调） */
    setMembers(msg) {
      const code = canonicalCode(msg.code);
      if (!code) {
        log("❌编号格式错误");
        return;
      }
      const p = db.getProductByCode(code);
      if (!p) {
        log(`❌没有 ${code} 这个编号`);
        return;
      }
      post({ type: "setMembers", ...snapOf(code) });
    },

    /** 往上加一个子商品。校验从松到紧，每条都给明确的中文原因，不静默失败 */
    setAddMember(msg) {
      const setCode = canonicalCode(msg.code);
      const childCode = canonicalCode(msg.childCode);
      if (!setCode || !childCode) {
        log("❌编号格式错误（应形如 A001 / T001）");
        return;
      }
      if (setCode === childCode) {
        log("❌不能把自己放进自己");
        return;
      }
      const setP = db.getProductByCode(setCode);
      if (!setP) {
        log(`❌没有 ${setCode} 这个编号`);
        return;
      }
      if (Number(setP.kind) !== 1) {
        log(`❌${setCode} 不是套装（只有套装能装子商品）`);
        return;
      }
      const child = db.getProductByCode(childCode);
      if (!child) {
        log(`❌没有 ${childCode} 这个编号`);
        return;
      }
      if (Number(child.kind) === 1) {
        log(`❌${childCode} 是套装，套装不能放进套装里`);
        return;
      }
      // 已经在了就什么都不做（幂等）：重复点两次不该报错，也不该多出一条
      if (db.listSetMembers(setCode).some((x) => x.code === childCode)) {
        log(`ℹ️${childCode} 已经在 ${setCode} 里了`);
        post({ type: "setMembers", ...snapOf(setCode) });
        return;
      }
      const snap = h.snapshot();
      db.addSetMember(setCode, childCode);
      h.pushUndo(snap, `把 ${childCode} 加进 ${setCode}`);
      log(`✅已把 ${childCode} 加进 ${setCode}`);
      post({ type: "setMembers", ...snapOf(setCode) });
    },

    /** 把一个子商品从套装里移出。**只删关联，不删商品** */
    setRemoveMember(msg) {
      const setCode = canonicalCode(msg.code);
      const childCode = canonicalCode(msg.childCode);
      if (!setCode || !childCode) {
        log("❌编号格式错误");
        return;
      }
      const snap = h.snapshot();
      db.removeSetMember(setCode, childCode);
      h.pushUndo(snap, `把 ${childCode} 从 ${setCode} 移出`);
      log(`✅已把 ${childCode} 从 ${setCode} 移出（商品本身还在）`);
      post({ type: "setMembers", ...snapOf(setCode) });
    },

    /** 这个商品属于哪些套装（子商品详情页显示"属于 T001、T002"用） */
    setOfCode(msg) {
      const code = canonicalCode(msg.code);
      if (!code) {
        return;
      }
      post({ type: "setOfCode", code, sets: db.setsOfCode(code) });
    },

    /** 要删一个商品之前，先问清楚它挂在哪些套装里（删除不可逆，必须让用户看见代价） */
    setWhereUsed(msg) {
      const code = canonicalCode(msg.code);
      if (!code) {
        return;
      }
      const asSet = db.getProductByCode(code);
      const sets = db.setsOfCode(code);
      let childCount = 0;
      if (asSet && Number(asSet.kind) === 1) {
        childCount = db.listSetMembers(code).length;
      }
      post({ type: "setWhereUsed", code, sets, childCount });
    },
  };
}
