// ===== 补货跟踪（客户订单欠货，2026-10-18）=====
//
// 老板的原始需求（九轮谈下来的，别自作聪明改）：
//   客户下单 → 货不够 → 记下"这个单号缺哪些编号" → 持续跟踪 → 货真到了才闭环。
//   他现在的土办法是 WPS 四列：① 快递单号（要能扫码）② 缺的编号/物品 ③ 预期结果 ④ 实际情况。
//   这张表就是把那四列搬进库：一行 = 一个快递单号。
//
// 几条钉死的口径：
//   · due 存**真实日期**，绝不存"明天发/2天后"（他自己指出来的：过几天就漂了）
//   · 状态只有 wait / done / closed。**"发货了没""催了没"不进状态** —— 那是过程，他不管
//   · 一行里只要还有一个编号没到，就还是 wait；永远不来的他**手动关**（closed）
//   · **不导订单**：纯手工记录
//   · 软删除：单条删 + 清空已结束，都必须他手动点，且二次确认（前端做），后端只负责标记
//   · 和进货单**不是一回事**：进货单是"我要去进多少货"，这里是"哪个客户的单还欠着什么"
//
// 想整体去掉这个功能：删本文件 + index.ts 里 handlers 表带同标记的那一行 + WRITE_ACTIONS 里三条，
// 再删 db.ts 里带同标记的几处（一张表、四个接口、预编译与实现），
// 以及手机端 restock.js / restock.css / index.html 里那一屏。
import { Handler, HandlerCtx } from "./types.js";

/** 允许的状态值。别的（脏数据/前端传错）一律落回 wait */
function normStatus(v: any): "wait" | "done" | "closed" {
  const s = String(v ?? "").trim();
  return s === "done" || s === "closed" ? s : "wait";
}

/** 日期只收 YYYY-MM-DD；收不了就原样留着（前端已经校验过一遍，这里兜底） */
function normDate(v: any): string {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s;
}

export function restockHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;

  /** 把全部跟踪行推给前端（进「补货跟踪」页签、或每次改动之后） */
  const postList = () => {
    post({ type: "restockState", rows: db.listRestock() });
  };

  return {
    /** 读全部（软删除的读不出来） */
    restockList() {
      postList();
    },

    /**
     * 新建一条。**只做新增**，改走 restockUpdate —— 两个动作分开，
     * 免得"保存"这一条消息在 id 有/没有两种语义之间摇摆（进货单那边吃过这个亏）。
     */
    restockAdd(msg) {
      const waybill = String(msg.waybill ?? "").trim();
      const items = String(msg.items ?? "").trim();
      // 单号和缺的东西都是核心：两样都空就没什么可记的
      if (!waybill && !items) {
        log("❌补货记录：单号和缺的编号不能都空着");
        return;
      }
      const id = db.addRestock({
        waybill,
        items,
        due: normDate(msg.due),
        status: normStatus(msg.status),
        note: String(msg.note ?? ""),
        due_changes: 0,
        due_first: "",
      });
      log(`📌记了一条补货跟踪（${waybill || items}）`);
      post({ type: "restockSaved", id, created: true });
      postList();
    },

    /**
     * 改一条（到了 / 改期 / 关了 / 改备注，全走这条）。
     *
     * ⚠️ **改期的计数在这里算**，不吃前端传的 due_changes —— 原因：
     *   ① 次数和"原定哪天"必须跟 due 一起变，前端算容易漏（三条路：改期按钮 / 直接改日期 / 批量）
     *   ② 只有一处算，断言和变异才有唯一锚点
     */
    restockUpdate(msg) {
      const id = Number(msg.id ?? 0);
      if (!Number.isInteger(id) || id <= 0) {
        log("❌补货记录不存在");
        return;
      }
      const old = db.listRestock().find((r) => r.id === id);
      if (!old) {
        log("❌补货记录不存在（可能已被删掉）");
        return;
      }
      // ⚠️⚠️ 这里必须是**局部更新**（`msg.due === undefined` 就沿用 old.due）。
      //   前端"点到了 / 点关了"只发 `{id, status}`、"改期"只发 `{id, due}` —— 是**故意的**：
      //   每一次动作只说自己改了什么，用局部发送天然不会把别的字段冲掉。
      //   所以后端**绝不能**把"没传"当成"要清空"（这一行原来写成 `normDate(msg.due)`，
      //   点一下「到了」就把约定日期清空了，端到端跑到才露出来）。
      const rawDue = msg.due === undefined ? old.due : msg.due;
      const due = normDate(rawDue);
      // 只有**日期真的变了**才算改一次期；同一天点两次不算（否则次数一路虚涨）
      const dateChanged = !!due && due !== old.due;
      const dueChanges = dateChanged ? old.due_changes + 1 : old.due_changes;
      // 原定日：第一次改期时把**当时那个 due** 记下来，之后再改都不覆盖它
      const dueFirst = dateChanged ? old.due_first || old.due : old.due_first;
      const row = {
        waybill: String(msg.waybill ?? old.waybill).trim(),
        items: String(msg.items ?? old.items).trim(),
        due,
        status: normStatus(msg.status ?? old.status),
        note: String(msg.note ?? old.note),
        due_changes: dueChanges,
        due_first: dueFirst,
      };
      const ok = db.updateRestock(id, row);
      if (!ok) {
        log("❌补货记录没能改成功");
        return;
      }
      const st = row.status === "done" ? "✅到了" : row.status === "closed" ? "🚪关了" : "⏳还在等";
      log(`📌补货跟踪已更新（${row.waybill || row.items} · ${st}）`);
      post({ type: "restockSaved", id, created: false });
      postList();
    },

    /**
     * **软删除**（ids 有一堆就是批量，「清空已结束」也走这条）。
     * 前端必须已经二次确认过；这里只负责标记，不真删 —— 删错了还能捞回来。
     */
    restockDelete(msg) {
      const raw = Array.isArray(msg.ids) ? (msg.ids as any[]) : msg.id ? [msg.id] : [];
      const ids = raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) {
        log("❌没有要删的补货记录");
        return;
      }
      const n = db.deleteRestock(ids);
      log(`🗑已删掉 ${n} 条补货跟踪`);
      post({ type: "restockDeleted", count: n });
      postList();
    },
  };
}
