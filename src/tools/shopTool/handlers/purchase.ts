// ===== 进货单（补货单，2026-10-15）=====
// 手机端「进货」tab 的后端落点。一张单 + 若干行，**行整表替换**（跟 live_plan 一个套路）。
//
// 三条口径（详见 docs/进货单-设计方案.md）：
//   · 名称/图片**不落库**，显示时按编号现查 —— 改了商品，单子里立刻是新名字
//   · **不碰库存** —— 老板明确说现在库存统计不准，这张单只记"要补多少 / 实际拿了多少"
//   · 整张单一次事务提交（共享盘上一个批量 = 一次网络提交，不是一行一次）
//
// 想整体去掉这个功能：删本文件 + index.ts 里 handlers 表带同标记的那一行 + WRITE_ACTIONS 里两条，
// 再删 db.ts 里带同标记的几处（两张表、三个接口、预编译与实现）。
//
// ⚠️ 2026-10-16：**「生成 HTML」那条出口已整个删掉**（老板拍的板）。原因记一下，免得以后又想加回来：
//   · 它唯一多出来的东西是"浏览器里排版好看"，而老板要的一直是**带图的表格** → Excel 全覆盖了；
//   · 它的硬伤是**别人打不开**：WPS 的 HTML 预览器、微信里点开都**不渲染内嵌 data: 图片**
//     （他自己就撞过一次，以为图挂了）—— 要发给档口/仓管看，这条路最脆；
//   · 加上"存到手机再用浏览器打开"本身很绕（安卓要选打开方式、iOS 更麻烦）。
//   真要"发一张带图的单给人看"，该做的是**长图**（复用直播排品那套拼图），不是 HTML。
import { Workbook } from "exceljs";
import sharp from "sharp";
import { Handler, HandlerCtx, runLongTask } from "./types.js";
import { canonicalCode, todayStr } from "../pricing.js";
import { firstImageFile } from "../images.js";
import { localStamp } from "../liveGrid.js";
import { withSharpFile } from "../../../core/utils.js";

// 导出任务的模块级忙碌闸：一次只跑一个重活儿，生成期间再点按钮直接忽略
// （前端按钮也会禁掉，这是双保险。留着模块级的而不是局部变量 —— 以后若再加第二条出口，闸是现成的）
let exportJobActive = false;

/**
 * 导出的输入归一：编号走 canonicalCode、剔除空行。
 * 与 purchaseSaveOrder 同一套口径 —— 屏幕上没填完的行不进导出。
 * 2026-10-17：现场新货行没有编号也能进导出（名字就是它的身份）；进价/认货照跟着走。
 */
function normExportItems(rawItems: any[]): Array<{
  code: string;
  need: number;
  got: number;
  done: number;
  note: string;
  name: string;
  price: number;
  img: string;
  kind: number;
}> {
  return (Array.isArray(rawItems) ? rawItems : [])
    .map((it) => ({
      code: canonicalCode(it?.code) || String(it?.code ?? "").trim(),
      need: Number(it?.need ?? 0) || 0,
      got: Number(it?.got ?? 0) || 0,
      done: Number(it?.done ?? 0) ? 1 : 0,
      note: String(it?.note ?? ""),
      name: String(it?.name ?? "").trim(),
      price: Number(it?.price ?? 0) || 0,
      img: String(it?.img ?? ""),
      kind: Number(it?.kind ?? 0) ? 1 : 0,
    }))
    .filter((it) => it.code || it.name);
}

export function purchaseHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;

  /** 把全部进货单推给前端（进「进货」tab、或每次改动之后） */
  const postList = () => {
    post({ type: "purchaseState", orders: db.listPurchaseOrders() });
  };

  return {
    /** 读全部进货单 */
    purchaseList() {
      postList();
    },

    /**
     * 整张保存（id 为空则新建）。行整表替换 —— 单子的编辑粒度就是"整张"，
     * 不做逐行增删的接口，免得两边行序对不上。
     */
    purchaseSaveOrder(msg) {
      const rawItems = Array.isArray(msg.items) ? (msg.items as any[]) : [];
      const items = rawItems
        .map((it, i) => ({
          sort: i,
          // 编号统一走 canonicalCode 归一；真归一不了就保留原文（别静默丢行，
          // 前端本来就会提示"编号不存在"）
          code: canonicalCode(it?.code) || String(it?.code ?? "").trim(),
          need: Number(it?.need ?? 0) || 0,
          got: Number(it?.got ?? 0) || 0,
          done: Number(it?.done ?? 0) ? 1 : 0,
          note: String(it?.note ?? ""),
          // 现场新货行（2026-10-17）：手写名称 / 进价 / 认货照的临时号 / 行的种类
          name: String(it?.name ?? "").trim(),
          price: Number(it?.price ?? 0) || 0,
          img: String(it?.img ?? ""),
          kind: Number(it?.kind ?? 0) ? 1 : 0,
        }))
        .filter((it) => it.code || it.name);
      const idRaw = Number(msg.id ?? 0);
      const id = Number.isInteger(idRaw) && idRaw > 0 ? idRaw : null;
      const date = String(msg.date ?? "").trim() || todayStr();
      const note = String(msg.note ?? "");
      const newId = db.savePurchaseOrder(id, date, note, items);
      log(`📝已保存进货单（${date}，${items.length} 款）`);
      post({ type: "purchaseSaved", id: newId });
      postList();
    },

    /** 删掉一整张单 */
    purchaseDeleteOrder(msg) {
      const id = Number(msg.id ?? 0);
      if (!Number.isInteger(id) || id <= 0) {
        log("❌进货单不存在");
        return;
      }
      db.deletePurchaseOrder(id);
      log("🗑已删除进货单");
      postList();
    },

    /**
     * 进货单「导出 Excel」（2026-10-16 新增）：屏幕上这份清单 → 一张**带图**的 xlsx。
     *
     * 排版口径照抄「商品清单带图导出」（handlers/impexp.ts 的 withImages 分支）：exceljs Workbook、
     * 图 88px 方框嵌在单元格里、`tl/ext` 定位、行高按 96dpi 折算（`ceil(dh*72/96)+6`）。
     * ⚠️ 但**图片不照抄它**：那边 `readImageForExcel` 是**原图直嵌**，老板的货手机拍的一张 1~3MB
     *    —— 实测 5 款 7.1MB、40 款 50MB+（微信发不出）。这里自己缩到 320px/jpeg q80 → 5 款 78KB。
     *
     * 数字口径（2026-10-16 老板要的）：
     *   · **不带勾选态**（不写 ✓ / 不写"已办"列）—— 导出去的表是给档口/别人看的，勾选是我们自己的事
     *   · **差 列写成公式** `=E{r}-D{r}`、汇总行的 需/拿/差 也写公式 —— 别人在表格上改需/拿，差和汇总自动重算
     *     （都带 `result` 静态值：不重算的预览器/老软件也能直接看到数）
     *
     * ⚠️ **纯读**：不落库、不写共享盘、**电脑上也不留文件**（老板："我没在电脑上点，就别在电脑上备份"）
     *    → 字节 base64 后随 purchaseXlsxDone 回传，手机端解成 Blob 下载（WPS 打开）。
     *    ⚠️ 大单会撑大这条消息（压图后 40 款约 0.6~1MB → base64 约 1.3MB）；
     *       若哪天真遇到卡顿，就把它改回"落盘 + /api/download"（自己加回输出目录那步即可）。
     * 收的是**屏幕上这份** {date,note,items}（可能还有没存完的改动），不是库里那份。
     * ⚠️ **每条退出路径都要发终态**（含 error），前端按钮才复位得回来。
     *
     * ⚠️ 出口一律走 `postMe` / `logMe`（= 只回发起人）：网页版一个服务进程对着手机 + 电脑两台，
     *    broadcast 的话**手机上点导出、电脑那台也弹一次下载**（2026-10-17 老板报的毛病），
     *    而这份 base64 有一两 MB，白推一遍还占带宽。见 events.ts 的 HubEvent.target。
     */
    purchaseExportXlsx(msg) {
      const postMe = (m: any) => post(m, { toRequester: true });
      const logMe = (s: string) => log(s, { toRequester: true });
      if (exportJobActive) {
        logMe("⏭️已有一个导出任务在跑，这一次点击已忽略（等它出完再点）");
        return;
      }
      exportJobActive = true;
      return runLongTask(h, "导出进货单Excel", () =>
        (async () => {
          try {
            const items = normExportItems(msg.items as any[]);
            if (items.length === 0) {
              logMe("❌清单里没有可导出的商品行");
              postMe({ type: "purchaseXlsxDone", error: "清单里还没有商品" });
              return;
            }
            // 名称/图片照旧不落库、现查：改了商品，导出的就是新名字
            const date = String(msg.date ?? "").trim() || todayStr();
            const note = String(msg.note ?? "");
            const byCode = new Map(db.getProducts().map((p) => [p.code, p.name]));
            const imageRoot = h.imageDir();

            const wb = new Workbook();
            wb.creator = "Cherysis";
            const ws = wb.addWorksheet("进货单");
            const HEAD = ["图片", "编号", "名称", "需", "拿", "差", "备注"];
            const WIDTH = [14, 10, 24, 7, 7, 7, 26];
            const IMG_W = 88; // 与商品清单导出同一档方框（图列宽 14 正好放得下）
            HEAD.forEach((label, i) => {
              const c = ws.getCell(1, i + 1);
              c.value = label;
              c.font = { bold: true };
              c.alignment = { horizontal: "center", vertical: "middle" };
            });
            WIDTH.forEach((w, i) => {
              ws.getColumn(i + 1).width = w;
            });
            ws.getRow(1).height = 22;

            // 老板 10-17 定的顺序：**先把补货的读完，再列现场进的新货**（没有新货就只有补货那段）。
            // Array.sort 是稳定排序 → 同类之间保持屏幕上看到的顺序。
            const ordered = [...items.filter((it) => !it.kind), ...items.filter((it) => it.kind)];
            let pics = 0;
            let failed = 0;
            for (let i = 0; i < ordered.length; i++) {
              const it = ordered[i];
              const r = i + 2;
              const isNew = !!it.kind;
              ws.getCell(r, 2).value = it.code; // 不带勾选态；新货行常常没有编号
              // 名称：库里有就用库里的（改了商品这里立刻新值），没有就用行上手写的那个
              ws.getCell(r, 3).value = byCode.get(it.code) || it.name || "";
              // 新货行没有"需"这回事 → 那格留空，差也留空（不能按 拿-0 算成"多拿了"）
              ws.getCell(r, 4).value = isNew ? "" : it.need;
              ws.getCell(r, 5).value = it.got;
              const diff = it.got - it.need;
              const dc = ws.getCell(r, 6);
              if (isNew) {
                dc.value = "";
              } else {
                // 公式 + result：别人改了需/拿 差会跟着算；不重算的预览器也能直接看到数
                dc.value = { formula: `E${r}-D${r}`, result: diff };
                if (diff > 0) {
                  // 拿>需 标绿加粗 —— 跟手机版那格染绿、导出的 html 是同一个口径
                  dc.font = { color: { argb: "FF0A7D55" }, bold: true };
                }
              }
              // 备注：新货行把进价/合计写在最前面（老板："合计你就顺带的事情"）
              const amount = Math.round(it.price * it.got * 100) / 100;
              const priceTxt =
                isNew && it.price > 0
                  ? `进价 ¥${Math.round(it.price * 100) / 100} × ${it.got} = ¥${amount}`
                  : "";
              ws.getCell(r, 7).value = [priceTxt, it.note].filter(Boolean).join(" ｜ ");
              for (let c = 2; c <= 7; c++) {
                ws.getCell(r, c).alignment = { vertical: "middle" };
              }
              // 认货照：新货行存在临时号底下的夹子里（it.img），补货行照旧按编号取
              const imgKey = it.img || it.code;
              const fp = imageRoot && imgKey ? firstImageFile(imageRoot, imgKey) : null;
              if (!fp) {
                ws.getRow(r).height = 22;
                continue;
              }
              // 逐行 try/catch：一款坏图不能把整次导出带崩（跟商品清单导出同一套处理）
              try {
                // ⚠️⚠️ 这里**故意不照抄**商品清单导出的「原图直嵌」（readImageForExcel）：
                //    老板的货是手机拍的，原图一张 1~3MB —— 实测 5 款直接 7.1MB，
                //    40 款 50MB+，微信发不出去、手机 WPS 也难开。
                //    单元格只显示 88px，缩到 320px（2~3 倍屏够看）jpeg q80：一张约 20~30KB。
                //    （所以体积这事上两条路的差别是有意的，不是漏了。）
                const buf = await withSharpFile((f) =>
                  f(fp)
                    .rotate() // 先摆正 EXIF 方向（手机竖拍直读是躺着的）
                    .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toBuffer(),
                );
                const meta = await sharp(buf).metadata();
                const sw = meta.width || IMG_W;
                const sh = meta.height || IMG_W;
                let dw = IMG_W;
                let dh = IMG_W;
                if (sw >= sh) {
                  dh = Math.max(1, Math.round((sh / sw) * IMG_W));
                } else {
                  dw = Math.max(1, Math.round((sw / sh) * IMG_W));
                }
                const imgId = wb.addImage({ buffer: buf as any, extension: "jpeg" });
                ws.addImage(imgId, {
                  tl: { col: 0, row: r - 1 },
                  ext: { width: dw, height: dh },
                  editAs: "oneCell",
                });
                ws.getRow(r).height = Math.ceil((dh * 72) / 96) + 6;
                pics++;
              } catch {
                failed++;
                ws.getRow(r).height = 22;
              }
            }

            // 汇总行：款数写文字，需/拿/差 三格写成公式（范围给足到 500 行，别人加行也带得进去）
            const totalNeed = ordered.reduce((n, it) => n + (it.kind ? 0 : it.need), 0);
            const totalGot = ordered.reduce((n, it) => n + it.got, 0);
            const newCnt = ordered.filter((it) => it.kind).length;
            const sr = ordered.length + 2;
            const sc = ws.getCell(sr, 2);
            sc.value = newCnt
              ? `共 ${ordered.length} 款（补货 ${ordered.length - newCnt} · 新货 ${newCnt}）· 需 · 拿 · 差`
              : `共 ${ordered.length} 款 · 需 · 拿 · 差`;
            sc.font = { bold: true };
            const needC = ws.getCell(sr, 4);
            needC.value = { formula: "SUM(D2:D500)", result: totalNeed };
            needC.font = { bold: true };
            const gotC = ws.getCell(sr, 5);
            gotC.value = { formula: "SUM(E2:E500)", result: totalGot };
            gotC.font = { bold: true };
            const diffC = ws.getCell(sr, 6);
            diffC.value = { formula: `E${sr}-D${sr}`, result: totalGot - totalNeed };
            diffC.font = { bold: true };
            if (note) {
              const nc = ws.getCell(sr + 1, 2);
              nc.value = `备注：${note}`;
            }

            const raw = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
            if (!imageRoot) {
              logMe("‼导出勾了图片，但没配图片目录，图列全空");
            } else if (failed > 0) {
              logMe(`⚠${items.length} 行里有 ${failed} 行图片读取失败已留空`);
            }
            const fileName = `进货单_${date}_${localStamp()}.xlsx`;
            logMe(
              `📊已生成进货单 Excel（${items.length} 款 / ${pics} 图，${Math.round(raw.length / 1024)}KB）`,
            );
            // 字节随回包走（base64）：手机端解成 Blob 下载，**电脑上不落文件**
            // （postMe：只有点了按钮的那一台收得到这张表，别人连这条消息都看不见）
            postMe({
              type: "purchaseXlsxDone",
              file: fileName,
              b64: Buffer.from(raw).toString("base64"),
              count: items.length,
              pics,
              size: raw.length,
            });
          } catch (err: any) {
            logMe(`❌导出进货单 Excel 出错：${err?.message ?? err}`);
            postMe({ type: "purchaseXlsxDone", error: "生成过程出错，已中止" });
          }
        })().finally(() => {
          exportJobActive = false;
        }),
      );
    },
  };
}
