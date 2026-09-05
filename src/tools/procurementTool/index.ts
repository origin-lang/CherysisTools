import * as fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { ToolDefinition } from "../../core/toolRegistry.js";
import {
  autoReceiptDates,
  closeDB,
  genOrderNo,
  getDB,
  getDBPath,
  initDB,
  Order,
  Supplier,
} from "./db.js";

/** 撤销/重做快照栈上限 */
const UNDO_LIMIT = 30;
const REDO_LIMIT = 30;
/** 撤销快照栈：每条 = 某次改动「之前」的整库状态 + 该次改动的动作描述，仅存内存，面板重开即清 */
const undoStack: Array<{ suppliers: Supplier[]; orders: Order[]; desc: string }> = [];
/** 重做快照栈：撤销时把「当前状态」压入，重做时取出来恢复 */
const redoStack: Array<{ suppliers: Supplier[]; orders: Order[]; desc: string }> = [];

/** 字段 key → 中文名，撤销提示里显示改的是哪个字段 */
const FIELD_LABELS: Record<string, Record<string, string>> = {
  supplier: {
    name: "厂商",
    free_shipping: "是否包邮",
    relationship: "合作关系",
    quality_desc: "产品质量",
  },
  order: {
    order_no: "订单编号",
    supplier_id: "供应商",
    pay_amount: "付款金额",
    receive_time: "签收时间",
    deadline: "截止时间",
    paid_amount: "实付金额",
    status: "状态",
  },
};

export const procurementTool: ToolDefinition = {
  toolName: "procurementTool",
  title: "📦供应商采购管理",
  fragmentPath: "tools/procurementTool/fragment.html",
  clientScriptPath: "tools/procurementTool/client.js",
  async handleMessage(msg, ctx) {
    const log = ctx.log;
    // 首次访问初始化数据库
    try {
      initDB(ctx.storageDir);
    } catch (err: any) {
      log(`❌数据库初始化失败：${err.message}`);
      return;
    }
    let db = getDB();

    // 全量回推 + 撤销/重做可用性（前端据此控制按钮灰显）
    const postAll = () => {
      const suppliers = db.getSuppliers();
      const orders = db.getOrders();
      const undoAvailable = undoStack.length > 0;
      const redoAvailable = redoStack.length > 0;
      ctx.postToWebview({ type: "suppliersLoaded", suppliers, undoAvailable, redoAvailable });
      ctx.postToWebview({ type: "ordersLoaded", orders, suppliers, undoAvailable, redoAvailable });
    };
    // 操作前快照（改动成功后 pushUndo(snap, desc) 才生效，失败则不污染栈）
    const snapIt = () => ({ suppliers: db.getSuppliers(), orders: db.getOrders() });
    const pushUndo = (
      snap: { suppliers: Supplier[]; orders: Order[] },
      desc: string,
    ) => {
      undoStack.push({ ...snap, desc });
      if (undoStack.length > UNDO_LIMIT) {
        undoStack.shift();
      }
      // 产生新改动即作废重做分支
      redoStack.length = 0;
    };

    switch (msg.type) {
      // ===== 供应商 =====
      case "loadSuppliers": {
        postAll();
        break;
      }
      case "addSupplier": {
        try {
          const snap = snapIt();
          const name = String(msg.name ?? "").trim();
          const id = db.addSupplier({
            name,
            free_shipping: msg.freeShipping ? 1 : 0,
            relationship: msg.relationship || "待评估",
            quality_desc: msg.qualityDesc ?? "",
          });
          pushUndo(snap, `新增供应商「${name}」`);
          log(`✅供应商已添加(id=${id})`);
          postAll();
        } catch (err: any) {
          log(`❌添加供应商失败：${err.message}`);
        }
        break;
      }
      case "updateSupplier": {
        try {
          const snap = snapIt();
          const s: Supplier = {
            id: Number(msg.id),
            name: String(msg.name ?? "").trim(),
            free_shipping: msg.freeShipping ? 1 : 0,
            relationship: msg.relationship || "待评估",
            quality_desc: msg.qualityDesc ?? "",
          };
          db.updateSupplier(s);
          pushUndo(snap, `修改供应商「${s.name}」`);
          log("✅供应商已更新");
          postAll();
        } catch (err: any) {
          log(`❌更新供应商失败：${err.message}`);
        }
        break;
      }
      // 双击单元格内联编辑：只更新单个字段
      case "updateSupplierField": {
        try {
          const id = Number(msg.id);
          const field = String(msg.field);
          const value = msg.value;
          const list = db.getSuppliers();
          const cur = list.find((s) => s.id === id);
          if (!cur) {
            log("⚠供应商不存在");
            break;
          }
          const next: Supplier = { ...cur };
          if (field === "name") {
            next.name = String(value ?? "");
            if (!next.name) {
              log("⚠厂商不能为空");
              break;
            }
          } else if (field === "free_shipping") {
            next.free_shipping = value ? 1 : 0;
          } else if (field === "relationship") {
            next.relationship = String(value ?? "");
          } else if (field === "quality_desc") {
            next.quality_desc = String(value ?? "");
          } else {
            log(`⚠未知字段：${field}`);
            break;
          }
          const snap = snapIt();
          db.updateSupplier(next);
          pushUndo(snap, `修改供应商「${cur.name}」的「${FIELD_LABELS.supplier[field] || field}」`);
          postAll();
        } catch (err: any) {
          log(`❌${err.message}`);
        }
        break;
      }
      case "deleteSupplier": {
        try {
          const id = Number(msg.id);
          const name = db.getSuppliers().find((s) => s.id === id)?.name ?? `id=${id}`;
          const snap = snapIt();
          db.deleteSupplier(id);
          pushUndo(snap, `删除供应商「${name}」`);
          log(`✅供应商「${name}」已删除`);
          postAll();
        } catch (err: any) {
          log(`❌${err.message}`);
        }
        break;
      }

      case "deleteSuppliers": {
        try {
          const ids: number[] = (msg.ids || []).map(Number);
          if (ids.length === 0) {
            log("⚠没有选中要删除的供应商");
            break;
          }
          const ok = await ctx.confirm(`确定删除选中的 ${ids.length} 个供应商吗？`, "有关联订单的厂商会被跳过");
          if (!ok) {break;}
          const snap = snapIt();
          let n = 0;
          let skipped = 0;
          const deletedNames: string[] = [];
          for (const id of ids) {
            try {
              const name = db.getSuppliers().find((s) => s.id === id)?.name ?? `id=${id}`;
              db.deleteSupplier(id);
              deletedNames.push(name);
              n++;
            } catch {
              skipped++;
            }
          }
          pushUndo(snap, `批量删除供应商(${n}个)`);
          log(`✅删除供应商 ${n} 个${skipped ? `，跳过 ${skipped} 个(存在关联订单)` : ""}${deletedNames.length ? `：${joinList(deletedNames)}` : ""}`);
          postAll();
        } catch (err: any) {
          log(`❌批量删除失败：${err.message}`);
        }
        break;
      }

      // ===== 订单 =====
      case "loadOrders": {
        postAll();
        break;
      }
      case "addOrder": {
        try {
          const snap = snapIt();
          const orderNo = String(msg.orderNo ?? "").trim() || genOrderNo(db);
          const id = db.addOrder({
            order_no: orderNo,
            supplier_id: Number(msg.supplierId),
            pay_amount: toNum(msg.payAmount),
            receive_time: strOrNull(msg.receiveTime),
            deadline: strOrNull(msg.deadline),
            paid_amount: toNum(msg.paidAmount),
            status: msg.status || "已下单",
          });
          pushUndo(snap, `新增订单「${orderNo}」`);
          log(`✅订单已添加(${orderNo})`);
          postAll();
        } catch (err: any) {
          log(`❌添加订单失败：${err.message}`);
        }
        break;
      }
      case "updateOrder": {
        try {
          const snap = snapIt();
          const o: Order = {
            id: Number(msg.id),
            order_no: String(msg.orderNo ?? "").trim(),
            supplier_id: Number(msg.supplierId),
            pay_amount: toNum(msg.payAmount),
            receive_time: strOrNull(msg.receiveTime),
            deadline: strOrNull(msg.deadline),
            paid_amount: toNum(msg.paidAmount),
            status: msg.status || "已下单",
          };
          db.updateOrder(o);
          pushUndo(snap, `修改订单「${o.order_no}」`);
          log("✅订单已更新");
          postAll();
        } catch (err: any) {
          log(`❌更新订单失败：${err.message}`);
        }
        break;
      }
      // 双击单元格内联编辑：只更新单个字段
      case "updateOrderField": {
        try {
          const id = Number(msg.id);
          const field = String(msg.field);
          const value = msg.value;
          const list = db.getOrders();
          const cur = list.find((o) => o.id === id);
          if (!cur) {
            log("⚠订单不存在");
            break;
          }
          const next: Order = { ...cur };
          if (field === "order_no") {
            next.order_no = String(value ?? "").trim() || genOrderNo(db);
          } else if (field === "supplier_id") {
            next.supplier_id = Number(value);
          } else if (field === "pay_amount") {
            next.pay_amount = toNum(value);
          } else if (field === "paid_amount") {
            next.paid_amount = toNum(value);
          } else if (field === "receive_time") {
            next.receive_time = strOrNull(value);
          } else if (field === "deadline") {
            next.deadline = strOrNull(value);
          } else if (field === "status") {
            next.status = String(value ?? "已下单");
          } else {
            log(`⚠未知字段：${field}`);
            break;
          }
          const snap = snapIt();
          db.updateOrder(next);
          pushUndo(snap, `修改订单「${cur.order_no}」的「${FIELD_LABELS.order[field] || field}」`);
          postAll();
        } catch (err: any) {
          log(`❌更新订单失败：${err.message}`);
        }
        break;
      }
      case "deleteOrder": {
        try {
          const id = Number(msg.id);
          const orderNo = db.getOrders().find((o) => o.id === id)?.order_no ?? `id=${id}`;
          const snap = snapIt();
          db.deleteOrder(id);
          pushUndo(snap, `删除订单「${orderNo}」`);
          log(`✅订单「${orderNo}」已删除`);
          postAll();
        } catch (err: any) {
          log(`❌删除订单失败：${err.message}`);
        }
        break;
      }
      case "deleteOrders": {
        try {
          const ids: number[] = (msg.ids || []).map(Number);
          if (ids.length === 0) {
            log("⚠没有选中要删除的订单");
            break;
          }
          const ok = await ctx.confirm(`确定删除选中的 ${ids.length} 个订单吗？`, "删除后无法恢复");
          if (!ok) {break;}
          const snap = snapIt();
          const orders = db.getOrders();
          const deletedNos: string[] = [];
          for (const id of ids) {
            const o = orders.find((x) => x.id === id);
            db.deleteOrder(id);
            if (o) {deletedNos.push(o.order_no);}
          }
          pushUndo(snap, `批量删除订单(${ids.length}个)`);
          log(`✅删除订单 ${ids.length} 个${deletedNos.length ? `：${joinList(deletedNos)}` : ""}`);
          postAll();
        } catch (err: any) {
          log(`❌批量删除失败：${err.message}`);
        }
        break;
      }
      // 自动签收：一键填签收时间+截止时间(7天后)，状态->已签收
      case "autoReceipt": {
        try {
          if (!msg.id) {
            log("⚠请先选择要签收的订单");
            break;
          }
          const cur = db.getOrders().find((o) => o.id === Number(msg.id));
          if (!cur) {
            log("⚠订单不存在");
            break;
          }
          const ok = await ctx.confirm(
            `对订单「${cur.order_no}」执行自动签收？`,
            "将填入今天为签收时间、7天后为截止时间，状态改为已签收",
          );
          if (!ok) {break;}
          const snap = snapIt();
          const { receive_time, deadline } = autoReceiptDates();
          db.updateOrder({
            ...cur,
            receive_time,
            deadline,
            status: "已签收",
          });
          pushUndo(snap, `自动签收订单「${cur.order_no}」`);
          log(`✅已签收：${cur.order_no}（截止 ${deadline}）`);
          postAll();
        } catch (err: any) {
          log(`❌自动签收失败：${err.message}`);
        }
        break;
      }

      // ===== 撤销 / 重做 =====
      case "undoRequest": {
        const snap = undoStack.pop();
        if (!snap) {
          log("⚠没有可撤销的操作");
          break;
        }
        try {
          // 把当前状态压入重做栈，之后可「重做」抵销这次撤销
          redoStack.push({ ...snapIt(), desc: snap.desc });
          if (redoStack.length > REDO_LIMIT) {
            redoStack.shift();
          }
          db.restoreAll(snap.suppliers, snap.orders);
          log(`↩ 已撤销：${snap.desc}`);
        } catch (err: any) {
          log(`❌撤销失败：${err.message}`);
        }
        postAll();
        break;
      }
      case "redoRequest": {
        const snap = redoStack.pop();
        if (!snap) {
          log("⚠没有可重做的操作");
          break;
        }
        try {
          // 重新执行后，当前状态也压入撤销栈，可再「撤销」回退到这里
          pushUndo(snapIt(), snap.desc);
          db.restoreAll(snap.suppliers, snap.orders);
          log(`↪ 已重做：${snap.desc}`);
        } catch (err: any) {
          log(`❌重做失败：${err.message}`);
        }
        postAll();
        break;
      }

      // ===== 导入导出 =====
      // 导出数据库文件(.db)：拷到用户指定目录，便于备份/迁移到其他电脑
      case "exportDB": {
        const dir = await ctx.selectFolder("选择数据库导出目录");
        if (!dir) {break;}
        try {
          const src = getDBPath();
          const outFile = path.join(dir, `采购数据_${ts()}.db`);
          fs.copyFileSync(src, outFile);
          log(`✅数据库已导出：${outFile}`);
        } catch (err: any) {
          log(`❌导出数据库失败：${err.message}`);
        }
        break;
      }
      case "importDB": {
        const fp = await ctx.selectFile({ 数据库: ["db"] });
        if (!fp) {break;}
        try {
          const target = getDBPath();
          closeDB();
          fs.copyFileSync(fp, target);
          initDB(ctx.storageDir);
          db = getDB();
          // 换成别的库：原库快照不再有效，清空撤销/重做栈
          undoStack.length = 0;
          redoStack.length = 0;
          log("✅数据库已导入，数据已替换为所选文件");
          postAll();
        } catch (err: any) {
          log(`❌导入数据库失败：${err.message}`);
          // 尝试恢复
          try {
            initDB(ctx.storageDir);
            postAll();
          } catch { /* 忽略 */ }
        }
        break;
      }
      case "importSuppliers": {
        const fp = await ctx.selectFile({ Excel: ["xlsx", "xls", "csv"] });
        if (!fp) {break;}
        try {
          const snap = snapIt();
          const wb = XLSX.readFile(fp);
          const ws = wb.Sheets[wb.SheetNames[0]];
          // 逐行读原始记录，便于匹配中文/英文表头别名
          const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false }) as any[];
          let n = 0;
          let skipped = 0;
          for (const r of rows) {
            const name = firstMatch(r, ["厂商", "厂商名称", "名称", "name", "供应商"]);
            if (!name) {
              skipped++;
              continue;
            }
            db.addSupplier({
              name,
              free_shipping: /是|真|1|true|yes/i.test(firstMatch(r, ["是否包邮", "包邮", "free_shipping", "freeShipping"])) ? 1 : 0,
              relationship: firstMatch(r, ["合作关系", "关系", "relationship", "relation"]) || "待评估",
              quality_desc: firstMatch(r, ["产品质量", "产品质量描述", "质量描述", "quality_desc", "qualityDesc", "quality"]),
            });
            n++;
          }
          if (n > 0) {pushUndo(snap, `导入供应商(${n}条)`);}
          log(`✅导入供应商 ${n} 条${skipped ? `，跳过 ${skipped} 条(缺厂商名)` : ""}`);
          postAll();
        } catch (err: any) {
          log(`❌导入失败：${err.message}`);
        }
        break;
      }
      case "exportSuppliers": {
        const dir = await ctx.selectFolder("选择导出目录");
        if (!dir) {break;}
        try {
          const suppliers = db.getSuppliers();
          const aoa: any[][] = [
            ["厂商", "是否包邮", "合作关系", "产品质量"],
          ];
          for (const s of suppliers) {
            aoa.push([s.name, s.free_shipping ? "是" : "否", s.relationship, s.quality_desc]);
          }
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "供应商");
          const outFile = path.join(dir, `供应商档案_${ts()}.xlsx`);
          XLSX.writeFile(wb, outFile);
          log(`✅供应商已导出：${outFile}`);
        } catch (err: any) {
          log(`❌导出失败：${err.message}`);
        }
        break;
      }
      case "importOrders": {
        const fp = await ctx.selectFile({ Excel: ["xlsx", "xls", "csv"] });
        if (!fp) {break;}
        try {
          const snap = snapIt();
          let changed = false;
          const wb = XLSX.readFile(fp);
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];
          let suppliers = db.getSuppliers();
          const existingNos = new Set(db.getOrders().map((o) => o.order_no));
          const seenNos = new Set<string>();
          const nameToId = new Map<string, number>();

          let n = 0;
          let skipped = 0;
          const badDates: string[] = [];
          const noSupplier: string[] = [];
          const noSupName: string[] = [];
          const duplicateNos: string[] = [];
          const missingSupNames = new Set<string>();
          interface PendingRow {
            lineNo: number;
            orderNo: string;
            supName: string;
            supId: number | null;
            receive_time: string | null;
            deadline: string | null;
            r: any;
          }
          const pending: PendingRow[] = [];

          // 第一遍：逐行校验，把问题行挑出来；其余进 pending（含“厂商不存在”行，等用户决定后再定）
          let lineNo = 1;
          for (const r of rows) {
            lineNo++;
            const supName = firstMatch(r, ["供应商", "厂商", "厂商名称", "名称", "supplier", "name"]);
            const orderNo = firstMatch(r, ["订单编号", "订单号", "order_no", "orderNo"]) || genOrderNo(db);
            if (!supName) {
              noSupName.push(`第${lineNo}行(缺供应商名)`);
              skipped++;
              continue;
            }
            // 订单编号唯一：库内已有 或 本文件内已出现过
            if (existingNos.has(orderNo) || seenNos.has(orderNo)) {
              duplicateNos.push(`第${lineNo}行(${orderNo})编号已存在`);
              skipped++;
              continue;
            }
            seenNos.add(orderNo);
            const rawReceive = r["签收时间"] ?? r["receive_time"] ?? r["收货时间"];
            const rawDeadline = r["截止时间"] ?? r["deadline"];
            const receive_time = parseDate(rawReceive);
            const deadline = parseDate(rawDeadline);
            if (
              (rawReceive !== "" && rawReceive !== undefined && rawReceive !== null && !receive_time) ||
              (rawDeadline !== "" && rawDeadline !== undefined && rawDeadline !== null && !deadline)
            ) {
              badDates.push(`第${lineNo}行(${orderNo}):${String(rawReceive ?? rawDeadline)}`);
              skipped++;
              continue;
            }
            const sup = suppliers.find((s) => s.name === supName);
            pending.push({
              lineNo,
              orderNo,
              supName,
              supId: sup ? sup.id : null,
              receive_time,
              deadline,
              r,
            });
            if (!sup) {
              missingSupNames.add(supName);
            }
          }

          // 厂商不在档案中：询问用户是否自动加入供应商档案
          if (missingSupNames.size > 0) {
            const namesList = Array.from(missingSupNames).join("、");
            const ok = await ctx.confirm(
              `有 ${missingSupNames.size} 个厂商不在档案中：${namesList}`,
              "点「确定」自动把这几个厂商加入供应商档案并继续导入；点其他则跳过这些订单行",
            );
            if (ok) {
              for (const name of missingSupNames) {
                try {
                  const id = db.addSupplier({
                    name,
                    free_shipping: 0,
                    relationship: "待评估",
                    quality_desc: "",
                  });
                  changed = true;
                  nameToId.set(name, id);
                  log(`➕已自建厂商:${name}(id=${id})`);
                } catch (err: any) {
                  const cur = db.getSuppliers().find((s) => s.name === name);
                  if (cur) {
                    nameToId.set(name, cur.id);
                  } else {
                    log(`❌自建厂商失败:${name}｜${err.message}`);
                  }
                }
              }
              suppliers = db.getSuppliers();
            }
          }

          // 第二遍：真正写入
          for (const p of pending) {
            let supId = p.supId;
            if (supId === null) {
              supId = nameToId.get(p.supName) ?? (suppliers.find((s) => s.name === p.supName)?.id ?? null);
            }
            if (supId === null) {
              noSupplier.push(`第${p.lineNo}行(${p.orderNo}):厂商「${p.supName}」不在档案中`);
              skipped++;
              continue;
            }
            db.addOrder({
              order_no: p.orderNo,
              supplier_id: supId,
              pay_amount: toNum(p.r["付款金额"] ?? p.r["pay_amount"] ?? p.r["应付"]),
              receive_time: p.receive_time,
              deadline: p.deadline,
              paid_amount: toNum(p.r["实付金额"] ?? p.r["paid_amount"] ?? p.r["实付"]),
              status: firstMatch(p.r, ["订单状态", "状态", "status"]) || "已下单",
            });
            changed = true;
            n++;
          }
          logGroup("⚠订单编号重复，已跳过，明细如下：", duplicateNos, log);
          logGroup("⚠日期无法识别，已跳过，明细如下：", badDates, log);
          logGroup("⚠厂商不在档案中，已跳过，明细如下：", noSupplier, log);
          logGroup("⚠缺供应商名，已跳过，明细如下：", noSupName, log);
          const reasons: string[] = [];
          if (duplicateNos.length) {reasons.push("编号重复");}
          if (badDates.length) {reasons.push("日期无效");}
          if (noSupplier.length) {reasons.push("厂商不存在");}
          if (noSupName.length) {reasons.push("缺供应商名");}
          log(`✅导入订单 ${n} 条${skipped ? `，跳过 ${skipped} 条(${reasons.join("/")})` : ""}`);
          if (changed) {pushUndo(snap, `导入订单(${n}条${n === 0 ? "，含自建厂商" : ""})`);}
          postAll();
        } catch (err: any) {
          log(`❌导入失败：${err.message}`);
        }
        break;
      }
      case "exportOrders": {
        const dir = await ctx.selectFolder("选择导出目录");
        if (!dir) {break;}
        try {
          const orders = db.getOrders();
          const aoa: any[][] = [
            ["订单编号", "供应商", "付款金额", "签收时间", "截止时间", "实付金额", "订单状态"],
          ];
          for (const o of orders) {
            aoa.push([
              o.order_no,
              o.supplier_name ?? "",
              o.pay_amount ?? "",
              o.receive_time ?? "",
              o.deadline ?? "",
              o.paid_amount ?? "",
              o.status,
            ]);
          }
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "采购订单");
          const outFile = path.join(dir, `采购订单_${ts()}.xlsx`);
          XLSX.writeFile(wb, outFile);
          log(`✅订单已导出：${outFile}`);
        } catch (err: any) {
          log(`❌导出失败：${err.message}`);
        }
        break;
      }
    }
  },
};

function toNum(v: any): number | null {
  if (v === undefined || v === null || v === "") {return null;}
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// 分组日志：类别标题占一行，每个明细独立一行
function logGroup(header: string, items: string[], log: (t: string) => void): void {
  if (items.length > 0) {
    log(header);
    items.forEach((item) => log(`  ${item}`));
  }
}

// 列表摘要：过长时截断并标注总数，避免日志刷屏
function joinList(items: string[], max = 8): string {
  return items.length <= max
    ? items.join("、")
    : `${items.slice(0, max).join("、")} 等 ${items.length} 条`;
}

// 从一行原始 excel 数据中按表头别名取第一个非空值
function firstMatch(row: any, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

function xlsxNum(v: any): number | null {
  if (v === undefined || v === null || v === "") {return null;}
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function strOrNull(v: any): string | null {
  if (v === undefined || v === null || v === "") {return null;}
  return String(v);
}

// 将 Excel 日期序列号(如 46267)或常见日期文本(2026-08-14 / 2026/8/13 / 2026年8月13日)统一为 YYYY-MM-DD
function parseDate(v: any): string | null {
  if (v === undefined || v === null || v === "") {return null;}
  if (typeof v === "number" && isFinite(v)) {return excelSerialToDate(v);}
  const s = String(v).trim();
  if (!s) {return null;}
  if (/^\d+(\.\d+)?$/.test(s)) {return excelSerialToDate(Number(s));}
  const m0 = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m0) {return buildDate(Number(m0[1]), Number(m0[2]), Number(m0[3]));}
  const m1 = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (m1) {return buildDate(Number(m1[1]), Number(m1[2]), Number(m1[3]));}
  return null;
}

function buildDate(y: number, mo: number, d: number): string | null {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) {return null;}
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d) {
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }
  return null;
}

// Excel 1900 日期系统序列号 → YYYY-MM-DD（25569 对应 1970-01-01）
function excelSerialToDate(serial: number): string | null {
  if (!isFinite(serial) || serial < 59) {return null;}
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) {return null;}
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function ts(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
}
