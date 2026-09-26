import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import { Workbook } from "exceljs";
import sharp from "sharp";
import { Handler, HandlerCtx } from "./types.js";
import { getDB, Product } from "../db.js";
import { net } from "../salesModel.js";
import { fileStamp } from "../pricing.js";
import { PRODUCT_FIELD_ORDER } from "../productFields.js";
import { firstImageFile } from "../images.js";

// 读取原图嵌入 Excel：jpg/jpeg/png/gif 直接用原文件（不缩小），其它格式转 png 兜底
async function readImageForExcel(
  fp: string,
): Promise<{ buffer: Buffer; extension: "jpeg" | "png" | "gif" }> {
  const ext = path.extname(fp).toLowerCase();
  const buf = await fs.promises.readFile(fp);
  if (ext === ".jpg" || ext === ".jpeg") {
    return { buffer: buf, extension: "jpeg" };
  }
  if (ext === ".png") {
    return { buffer: buf, extension: "png" };
  }
  if (ext === ".gif") {
    return { buffer: buf, extension: "gif" };
  }
  const png = await sharp(buf).png().toBuffer();
  return { buffer: png, extension: "png" };
}

// 导入导出域：商品/销售/月报/排品清单导出、数据库备份与恢复、文件定位
export function impexpHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;
  const ctx = h.ctx;

  return {
    async exportProducts(msg) {
      const dir = await ctx.selectFolder("选择导出目录");
      if (!dir) {
        post({ type: "exportCancelled" });
        return;
      }
      try {
        const all = db.getProductsWithTotals();
        let list: typeof all = all;
        if (Array.isArray(msg.codes) && msg.codes.length) {
          const byCode = new Map(all.map((p) => [p.code, p]));
          list = (msg.codes as string[])
            .map((code) => byCode.get(code))
            .filter((p): p is (typeof all)[number] => !!p);
        }
        const gradeLabel = new Map(
          db.getRules().map((r) => [String(r.grade), r.label || `等级${r.grade}`]),
        );
        let cols: Array<{ key: string; label: string }>;
        const want =
          Array.isArray(msg.fields) && msg.fields.length
            ? new Set<string>(msg.fields.map(String))
            : null;
        if (want) {
          want.add("code");
          const wantImage = want.has("_image");
          cols = PRODUCT_FIELD_ORDER.filter((f) => want.has(f.key));
          const savedFields = cols.map((c) => c.key);
          if (wantImage) {
            savedFields.push("_image");
          }
          // 导出勾了哪些列是各人习惯，落本机不写共享库（只读模式下也能改）
          await h.setSetting("export_fields", JSON.stringify(savedFields));
        } else {
          let rawVis: unknown;
          try {
            rawVis = JSON.parse(String(h.getSetting("col_visible_list") || "[]"));
          } catch {
            rawVis = [];
          }
          const vis = new Set<string>(Array.isArray(rawVis) ? (rawVis as string[]) : []);
          cols = PRODUCT_FIELD_ORDER.filter((f) => vis.has(f.key));
        }
        if (cols.length === 0) {
          cols = [{ key: "code", label: "编号" }];
        }
        const valOf = (p: Product, key: string): any => {
          switch (key) {
            case "grade":
              return gradeLabel.get(String(p.grade)) || `等级${p.grade}`;
            case "status":
              return p.status === 1 ? "已下架" : "在售";
            case "netTotal":
              return net((p as any).soldTotal, (p as any).refundTotal);
            case "stockTotal":
              return (p as any).stockTotal;
            case "soldTotal":
              return (p as any).soldTotal;
            case "cost_price":
            case "sale_price":
              return Number((p as any)[key] ?? 0);
            default:
              return (p as any)[key] ?? "";
          }
        };
        const withImages = !!(
          Array.isArray(msg.fields) &&
          (msg.fields as string[]).includes("_image")
        );
        const outFile = path.join(dir, `商品清单_${fileStamp()}.xlsx`);
        if (withImages) {
          const imageDir = h.imageDir();
          const stIdx = cols.findIndex((c) => c.key === "status");
          const plIdx = cols.findIndex((c) => c.key === "purchase_link");
          const imgColIdx =
            stIdx >= 0 ? stIdx : plIdx >= 0 ? plIdx : cols.length;
          const displayCols = cols.slice();
          displayCols.splice(imgColIdx, 0, { key: "_image", label: "图片" });
          const wb = new Workbook();
          const ws = wb.addWorksheet("商品清单");
          displayCols.forEach((c, ci) => {
            const cell = ws.getCell(1, ci + 1);
            cell.value = c.label;
            cell.font = { bold: true };
            cell.alignment = { horizontal: "center", vertical: "middle" };
          });
          displayCols.forEach((_, i) => {
            ws.getColumn(i + 1).width = i === imgColIdx ? 16 : 13;
          });
          let embedded = 0;
          let failed = 0;
          for (let i = 0; i < list.length; i++) {
            const p = list[i];
            const rowIndex = i + 2;
            for (let c = 0; c < displayCols.length; c++) {
              if (displayCols[c].key !== "_image") {
                const cell = ws.getCell(rowIndex, c + 1);
                cell.value = valOf(p, displayCols[c].key);
                cell.alignment = { vertical: "middle" };
              }
            }
            const fp = firstImageFile(imageDir, p.code);
            if (!fp) {
              ws.getRow(rowIndex).height = 22;
              continue;
            }
            try {
              const { buffer, extension } = await readImageForExcel(fp);
              const meta = await sharp(buffer).metadata();
              const sw = meta.width || 88;
              const sh = meta.height || 88;
              const box = 88;
              let dw = box;
              let dh = box;
              if (sw >= sh) {
                dh = Math.max(1, Math.round((sh / sw) * box));
              } else {
                dw = Math.max(1, Math.round((sw / sh) * box));
              }
              const imgId = wb.addImage({ buffer: buffer as any, extension });
              ws.addImage(imgId, {
                tl: { col: imgColIdx, row: rowIndex - 1 },
                ext: { width: dw, height: dh },
                editAs: "oneCell",
              });
              ws.getRow(rowIndex).height = Math.ceil((dh * 72) / 96) + 6;
              embedded++;
            } catch {
              failed++;
              ws.getRow(rowIndex).height = 22;
            }
          }
          if (!imageDir) {
            log("‼导出勾选了图片，但「规则与设置」中未设置图片目录，所有图片列留空");
          } else if (embedded === 0) {
            log(`‼导出未嵌入任何图片：图片目录「${imageDir}」下找不到匹配商品文件夹的第一张图`);
          } else if (failed > 0) {
            log(`⚠${list.length} 行中有 ${failed} 行图片读取失败已留空，成功嵌入 ${embedded} 行`);
          }
          const raw = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
          await fs.promises.writeFile(outFile, raw);
        } else {
          const aoa: any[][] = [cols.map((c) => c.label)];
          for (const p of list) {
            aoa.push(cols.map((c) => valOf(p, c.key)));
          }
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "商品清单");
          await fs.promises.writeFile(
            outFile,
            XLSX.write(wb, { bookType: "xlsx", type: "buffer" }),
          );
        }
        log(`✅商品清单已导出（${list.length}条${withImages ? "，含图" : ""}）：${outFile}`);
        post({
          type: "exportDone",
          kind: "products",
          path: outFile,
          count: list.length,
          filtered: msg.filtered ? 1 : 0,
        });
      } catch (err: any) {
        log(`❌导出商品清单失败：${err.message}`);
        post({ type: "dbOpError", message: `导出商品失败：${err.message}` });
      }
    },

    async salesExportPreview(msg) {
      const from = String(msg.dateFrom || "");
      const to = String(msg.dateTo || "");
      const rows = from && to ? db.getSalesRange(from, to) : [];
      post({ type: "salesExportPreviewLoaded", from, to, rows });
    },

    async exportSales(msg) {
      const dir = await ctx.selectFolder("选择导出目录");
      if (!dir) {
        post({ type: "exportCancelled" });
        return;
      }
      try {
        const from = String(msg.dateFrom || "");
        const to = String(msg.dateTo || "");
        const rows = from && to ? db.getSalesRange(from, to) : [];
        const aoa: any[][] = [
          ["日期", "编号", "名称", "销量", "退款", "净售", "成本", "备注"],
        ];
        let sold = 0;
        let refund = 0;
        for (const r of rows) {
          sold += r.sold_qty;
          refund += r.refund_qty;
          aoa.push([
            r.date,
            r.code ?? "",
            r.name ?? "",
            r.sold_qty,
            r.refund_qty,
            r.sold_qty - r.refund_qty,
            r.cost_price,
            r.note || "",
          ]);
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "销售流水");
        const outFile = path.join(dir, `销售流水_${from}_${to}.xlsx`);
        await fs.promises.writeFile(outFile, XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
        log(`✅销售流水已导出（${rows.length}条，${from} ~ ${to}）：${outFile}`);
        post({
          type: "exportDone",
          kind: "sales",
          path: outFile,
          count: rows.length,
        });
      } catch (err: any) {
        log(`❌导出销售流水失败：${err.message}`);
        post({ type: "dbOpError", message: `导出销售失败：${err.message}` });
      }
    },

    async exportSettles() {
      const dir = await ctx.selectFolder("选择导出目录");
      if (!dir) {
        post({ type: "exportCancelled" });
        return;
      }
      try {
        const settles = db.getSettleMonths();
        const aoa: any[][] = [
          ["月份", "到账收入", "本月进货支出", "杂项支出", "期初库存", "期末库存", "净利润", "净售件数", "已锁定", "更新时间"],
        ];
        for (const s of settles) {
          aoa.push([
            s.month,
            s.income_amount,
            s.purchase_cost ?? 0,
            s.extra_expense,
            s.start_stock ?? 0,
            s.end_stock ?? 0,
            s.profit,
            (s.sold_total ?? 0) - (s.refund_total ?? 0),
            s.locked === 1 ? "是" : "否",
            s.updated_at,
          ]);
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "月度结算");
        const outFile = path.join(dir, `月度结算_${fileStamp()}.xlsx`);
        await fs.promises.writeFile(outFile, XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
        log(`✅月度结算已导出（${settles.length}个月）：${outFile}`);
        post({
          type: "exportDone",
          kind: "settles",
          path: outFile,
          count: settles.length,
        });
      } catch (err: any) {
        log(`❌导出月度结算失败：${err.message}`);
        post({ type: "dbOpError", message: `导出月报失败：${err.message}` });
      }
    },

    async exportLivePlan() {
      const dir = await ctx.selectFolder("选择导出目录");
      if (!dir) {
        post({ type: "exportCancelled" });
        return;
      }
      try {
        const plan = db
          .getLivePlan()
          .filter((r) => r.code)
          .sort((a, b) => a.group_no - b.group_no || a.slot_no - b.slot_no);
        const aoa: any[][] = [["组号", "号数", "编号", "名称"]];
        for (const r of plan) {
          const p = db.getProductByCode(r.code);
          aoa.push([
            r.group_no,
            (r.group_no - 1) * 9 + r.slot_no,
            r.code,
            p ? p.name : "",
          ]);
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "排品清单");
        const outFile = path.join(dir, `排品清单_${fileStamp()}.xlsx`);
        await fs.promises.writeFile(outFile, XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
        log(`✅排品清单已导出（${plan.length}款）：${outFile}`);
        post({
          type: "exportDone",
          kind: "live",
          path: outFile,
          count: plan.length,
        });
      } catch (err: any) {
        log(`❌导出排品清单失败：${err.message}`);
        post({ type: "dbOpError", message: `导出排品失败：${err.message}` });
      }
    },

    async exportDB() {
      const dir = await ctx.selectFolder("选择数据库备份目录");
      if (!dir) {
        return;
      }
      const outFile = path.join(dir, `商品数据_${fileStamp()}.db`);
      try {
        await db.backupDB(outFile);
        log(`✅数据库已备份：${outFile}`);
        post({ type: "toast", text: "数据库备份完成" });
      } catch (err: any) {
        log(`❌备份数据库失败：${err.message}`);
        post({ type: "toast", text: `备份失败：${err.message}` });
      }
    },

    async importDB() {
      const fp = await ctx.selectFile({ 数据库: ["db"] });
      if (!fp) {
        return;
      }
      try {
        await h.preOpBackup();
        db.restoreDB(fp, ctx.storageDir);
        h.setDB(getDB());
        h.resetUndo();
        log("✅数据库已恢复，数据已替换为所选备份");
        post({ type: "toast", text: "数据库恢复完成" });
        h.loadAll();
        h.postLiveState();
      } catch (err: any) {
        log(`❌恢复数据库失败：${err.message}`);
        post({ type: "toast", text: `恢复失败：${err.message}` });
        try {
          h.setDB(getDB());
          h.resetUndo();
          h.loadAll();
        } catch {
          /* 忽略 */
        }
      }
    },

    async revealFile(msg) {
      try {
        const fp = String(msg.path ?? "");
        if (fp) {
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fp));
        }
      } catch (err: any) {
        log(`❌定位文件失败：${err.message}`);
      }
    },
  };
}