import * as path from "path";
import * as XLSX from "xlsx";
import { ToolDefinition } from "../../core/toolRegistry.js";
import { getDB, initDB, OrderRecord } from "./db.js";

let parseSeq = 0;

export const ORDER_HEADERS = [
  "采集日期",
  "订单号",
  "下单时间",
  "供应商名称",
  "货号",
  "货品名称",
  "规格",
  "数量",
  "单价(元)",
  "本订单实付款(元)",
];
const ORDER_WIDTHS = [12, 18, 20, 22, 10, 50, 30, 8, 10, 16];
const PAY_COL = 9;

export interface PreviewRow {
  collectDate: string;
  orderNo: string;
  orderTime: string;
  supplier: string;
  huohao: string;
  name: string;
  spec: string;
  qty: string;
  price: string;
  pay: string;
  status: string;
}

interface ParsedOrder {
  collectDate: string;
  orderNo: string;
  orderTime: string;
  supplier: string;
  pay: string;
  items: Array<{
    huohao: string;
    name: string | null;
    spec: string | null;
    qty: string | null;
    price: string | null;
    status: string | null;
  }>;
}

export function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function cleanLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((ln) => ln.trim())
    .filter((ln) => ln.length > 0);
}

export function findAfter(
  lines: string[],
  keys: string[],
  start = 0,
): [number | null, string | null] {
  for (let i = start; i < lines.length; i++) {
    for (const k of keys) {
      const text = lines[i];
      if (text.startsWith(k)) {
        const rest = text.slice(k.length);
        if (/^[：: \t]/.test(rest)) {
          return [i, rest.replace(/^[：: \t]+/, "").trim()];
        }
      }
    }
  }
  return [null, null];
}

const HUOHAO_PATS = [/货\s*号\s*[:：]?\s*(.+)$/, /丁里号\s*[:：]?\s*(.+)$/];

export function getHuohao(ln: string): string | null {
  for (const p of HUOHAO_PATS) {
    const m = ln.match(p);
    if (m) {
      return m[1].trim();
    }
  }
  return null;
}

const SERVICE_SKIP =
  /^7天|退货包运费|极速退款|48小时|交期保障|品质保障|印错包赔|破损包赔|延期必赔|真实工厂|申请理赔|查看服务|上门取件|发货承诺|订单承诺/;

export function parseItems(lines: string[]): ParsedOrder["items"] {
  let start = 0;
  let headerIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("货品状态")) {
      headerIdx = i;
    }
  }
  if (headerIdx === null) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("货品")) {
        headerIdx = i;
      }
    }
  }
  if (headerIdx !== null) {
    start = headerIdx + 1;
  }

  const body = lines.slice(start);
  const huohaoIdx: number[] = [];
  body.forEach((ln, i) => {
    if (getHuohao(ln) !== null) {
      huohaoIdx.push(i);
    }
  });

  const items: ParsedOrder["items"] = [];
  for (let k = 0; k < huohaoIdx.length; k++) {
    const idx = huohaoIdx[k];
    const item: ParsedOrder["items"][number] = {
      huohao: getHuohao(body[idx]) ?? "",
      name: null,
      spec: null,
      qty: null,
      price: null,
      status: null,
    };
    const desc = body.slice(Math.max(0, idx - 2), idx);
    let afterEnd = k + 1 < huohaoIdx.length ? huohaoIdx[k + 1] - 2 : body.length;
    afterEnd = Math.max(afterEnd, idx + 1);
    const after = body.slice(idx + 1, afterEnd);

    for (const c of desc) {
      if (SERVICE_SKIP.test(c) || /^[\d\s.,%/\-¥元件]+$/.test(c)) {
        continue;
      }
      if (c.length >= 4) {
        item.name = c;
        break;
      }
    }
    const spec = desc.filter((c) => /颜色|尺码/.test(c));
    if (spec.length > 0) {
      item.spec = spec.join("；");
    }
    let unit: string | null = null;
    for (const c of [...after, ...desc]) {
      const m = c.match(/优惠后\s*([\d.]+)\s*元/);
      if (m) {
        unit = m[1];
        break;
      }
    }
    if (!unit) {
      for (const c of [...after, ...desc]) {
        const m = c.match(/([\d.]+)\s*元\s*\/\s*件/);
        if (m) {
          unit = m[1];
          break;
        }
      }
    }
    item.price = unit;
    for (const c of after) {
      const cClean = c.replace(/[¥元\/件 ]/g, "");
      if (/^\d{1,4}$/.test(cClean)) {
        item.qty = cClean;
        break;
      }
    }
    for (const c of after) {
      if (/退款成功|已确认收货|交易成功|已发货|待发货/.test(c)) {
        item.status = c;
        break;
      }
    }
    items.push(item);
  }
  return items;
}

export function parseOrder(lines: string[]): ParsedOrder {
  const [, seller] = findAfter(lines, ["供应商", "卖家", "供应商名称"]);
  const supplier = (seller || "").replace(/诚信通会员/g, "").trim();
  const [, orderNo] = findAfter(lines, ["订单号", "订单编号", "丁単号", "丁里号"]);
  const [, orderTime] = findAfter(lines, ["下单时间"]);

  let payLine: string | null = null;
  for (const ln of lines) {
    if (ln.startsWith("实付款") || ln.trimStart().startsWith("实付款")) {
      payLine = ln;
      break;
    }
  }
  if (payLine === null) {
    for (const ln of lines) {
      if (ln.includes("实付款")) {
        payLine = ln;
        break;
      }
    }
  }
  let pay = "";
  if (payLine) {
    const m = payLine.replace(/[¥￥,]/g, "").match(/[\d.]+/);
    if (m) {
      pay = m[0];
    }
  }

  return {
    collectDate: todayStr(),
    orderNo: orderNo ?? "",
    orderTime: orderTime ?? "",
    supplier,
    pay,
    items: parseItems(lines),
  };
}

export function splitBlocks(raw: string): string[] {
  return raw
    .split(/\n\s*(?:-{3,}|={3,})\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

function toPreviewRows(parsed: ParsedOrder[]): PreviewRow[] {
  const rows: PreviewRow[] = [];
  for (const p of parsed) {
    for (const it of p.items) {
      rows.push({
        collectDate: p.collectDate,
        orderNo: p.orderNo,
        orderTime: p.orderTime,
        supplier: p.supplier,
        huohao: it.huohao,
        name: it.name ?? "",
        spec: it.spec ?? "",
        qty: it.qty ?? "",
        price: it.price ?? "",
        pay: p.pay,
        status: it.status ?? "",
      });
    }
  }
  return rows;
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === "") {
    return null;
  }
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

export function toInt(v: unknown): number | null {
  const n = toNum(v);
  if (n === null) {
    return null;
  }
  return Math.floor(n);
}

function stamp(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
}

export function exportOrdersExcel(orders: OrderRecord[], outDir: string): string {
  const aoa: (string | number)[][] = [ORDER_HEADERS];
  for (const o of orders) {
    for (const it of o.items) {
      aoa.push([
        o.collect_date,
        o.order_no,
        o.order_time,
        o.supplier,
        it.huohao,
        it.name,
        it.spec,
        it.qty ?? "",
        it.price ?? "",
        o.pay_amount ?? "",
      ]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const merges: XLSX.Range[] = [];
  let i = 2;
  while (i <= aoa.length) {
    const orderNo = aoa[i - 1][1];
    let j = i;
    while (j + 1 <= aoa.length && aoa[j][1] === orderNo) {
      j += 1;
    }
    if (j > i) {
      merges.push({ s: { r: i - 1, c: PAY_COL }, e: { r: j - 1, c: PAY_COL } });
    }
    i = j + 1;
  }
  if (merges.length > 0) {
    ws["!merges"] = merges;
  }
  ws["!cols"] = ORDER_WIDTHS.map((w) => ({ wch: w }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "订单明细");
  const file = path.join(outDir, `1688采集信息表${stamp()}.xlsx`);
  XLSX.writeFile(wb, file);
  return file;
}

export const order1688Tool: ToolDefinition = {
  toolName: "order1688Tool",
  title: "📥1688订单提取",
  fragmentPath: "tools/order1688Tool/fragment.html",
  clientScriptPath: "tools/order1688Tool/client.js",

  async handleMessage(msg, ctx) {
    const log = ctx.log;
    try {
      initDB(ctx.storageDir);
    } catch (err: any) {
      log(`❌数据库初始化失败：${err.message}`);
      return;
    }
    const db = getDB();

    switch (msg.type) {
      case "log": {
        log(String(msg.text ?? ""));
        break;
      }
      case "parse": {
        const text = String(msg.text ?? "");
        if (!text.trim()) {
          log("⚠粘贴文本为空");
          break;
        }
        const blocks = splitBlocks(text);
        if (blocks.length === 0) {
          log("⚠未能在文本中识别订单块");
          break;
        }
        const parsed: ParsedOrder[] = [];
        let failCnt = 0;
        for (const bk of blocks) {
          if (bk.length < 5) {
            continue;
          }
          const p = parseOrder(cleanLines(bk));
          if (!p.orderNo || p.items.length === 0) {
            failCnt += 1;
            log(`[失败] 未解析到订单，内容可能是：${bk.slice(0, 30)}`);
            continue;
          }
          parsed.push(p);
        }
        if (failCnt > 0) {
          log(`共 ${failCnt} 个文本块解析失败，已跳过`);
        }
        const runId = "P" + ++parseSeq;
        const rows = toPreviewRows(parsed);
        const ordersDump = JSON.stringify(rows);
        ctx.postToWebview({ type: "parsed", runId, orders: rows, ordersDump });
        console.log(`[o8-parse] ${runId} rows=`, rows.length, "dumpLen=", ordersDump.length, JSON.stringify(rows.slice(0, 1)));
        if (rows.length > 0) {
          log(`✅解析完成 ${runId}：共 ${rows.length} 行商品明细，请在预览区核对后可改可删，再点「入库」`);
        } else {
          log(`⚠没有解析到任何订单 ${runId}`);
        }
        break;
      }
      case "importOrders": {
        const raw: any[] = Array.isArray(msg.rows) ? msg.rows : [];
        const grouped = new Map<string, PreviewRow[]>();
        const orderIdx: string[] = [];
        for (const r of raw) {
          const no = String(r?.orderNo ?? "").trim();
          if (!no) {
            continue;
          }
          if (!grouped.has(no)) {
            grouped.set(no, []);
            orderIdx.push(no);
          }
          grouped.get(no)!.push(r);
        }
        if (orderIdx.length === 0) {
          log("⚠没有可入库的订单（订单号为空），未写入");
          break;
        }
        let added = 0;
        let skipped = 0;
        for (const no of orderIdx) {
          const rows = grouped.get(no)!;
          const first = rows[0];
          const res = db.addOrder({
            order_no: no,
            collect_date: String(first.collectDate || todayStr()),
            order_time: String(first.orderTime || ""),
            supplier: String(first.supplier || ""),
            pay_amount: toNum(first.pay),
            items: rows.map((r) => ({
              huohao: String(r.huohao || ""),
              name: String(r.name || ""),
              spec: String(r.spec || ""),
              qty: toInt(r.qty),
              price: toNum(r.price),
            })),
          });
          if (res === "added") {
            added += 1;
            log(`✅订单 ${no} 入库 ${rows.length} 行（实付款 ${first.pay || "-"} 元）`);
          } else {
            skipped += 1;
            log(`⏭订单 ${no} 已存在，未重复写入`);
          }
        }
        log(`== 本轮合计：新增 ${added}，去重跳过 ${skipped} ==`);
        ctx.postToWebview({ type: "importResult", ok: true, added, skipped });
        ctx.postToWebview({ type: "ordersLoaded", orders: db.getOrders() });
        break;
      }
      case "loadOrders": {
        ctx.postToWebview({ type: "ordersLoaded", orders: db.getOrders() });
        break;
      }
      case "deleteOrders": {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(Number) : [];
        if (ids.length === 0) {
          log("⚠没有选中要删除的订单");
          break;
        }
        db.deleteOrders(ids);
        log(`🗑已删除选中订单 ${ids.length} 个`);
        ctx.postToWebview({ type: "ordersLoaded", orders: db.getOrders() });
        break;
      }
      case "exportExcel": {
        const orders = db.getOrders();
        if (orders.length === 0) {
          log("⚠暂无订单记录，先到「抓取入库」粘贴导入");
          break;
        }
        const dir = await ctx.selectFolder("选择导出采集表的文件夹");
        if (!dir) {
          break;
        }
        try {
          const file = exportOrdersExcel(orders, dir);
          log(`✅已导出采集表：${file}`);
        } catch (err: any) {
          const msgText = String(err?.message ?? err);
          if (/EPERM|EBUSY|被占用|access/i.test(msgText)) {
            log(`❌导出失败：文件被 Excel/WPS 占用或目录不可写，请关闭后重试。\n  ${msgText}`);
          } else {
            log(`❌导出Excel失败：${msgText}`);
          }
        }
        break;
      }
      default: {
        log(`❌未处理的消息类型:${msg.type}`);
      }
    }
  },
};