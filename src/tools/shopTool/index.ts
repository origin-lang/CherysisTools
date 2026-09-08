import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { ToolDefinition } from "../../core/toolRegistry.js";
import { readImageToBase64 } from "../../core/utils.js";
import { getDB, initDB, LivePlanRow, Product, SaleRule } from "./db.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"]);
const UPLOAD_FILTER: Record<string, string[]> = {
  图片: ["jpg", "jpeg", "png", "bmp", "webp", "gif"],
};

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function fileStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function canonicalCode(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/[【】\[\]（）()#\s_\-\u3000]/g, "");
  let digits: string | null = null;
  let m = s.match(/^[Ll](\d{1,4})$/);
  if (m) {
    digits = m[1];
  } else {
    m = s.match(/^(\d{1,4})$/);
    if (m) {
      digits = m[1];
    }
  }
  if (!digits) {
    return null;
  }
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    return null;
  }
  // 统一 3 位补零：L7→L007、L76→L076、L999→L999、L1044→L1044（最多 4 位）
  return `L${String(n).padStart(3, "0")}`;
}

function extractCodeToken(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const direct = canonicalCode(s);
  if (direct) {
    return direct;
  }
  const m = s.match(/[Ll](\d{1,4})/);
  if (m) {
    return canonicalCode(`L${m[1]}`);
  }
  return null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function applyExpr(cost: number, expr: string): number | null {
  const e = String(expr ?? "").replace(/cost/gi, `(${cost})`);
  if (!/^[0-9+\-*/().\s]+$/.test(e)) {
    return null;
  }
  try {
    const v = new Function(`return (${e});`)() as number;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function calcPrice(cost: number, rule: SaleRule | undefined): number {
  let v = rule ? applyExpr(cost, rule.expr) : null;
  if (v === null) {
    v = cost;
  }
  v = round2(v);
  const mode = rule?.tail_mode ?? "raw";
  const tail = String(rule?.tail_value ?? "").trim();
  switch (mode) {
    case "round":
      return Math.round(v);
    case "p99":
      return Math.floor(v) + 0.99;
    case "p88":
      return Math.floor(v) + 0.88;
    case "custom": {
      if (!tail || !/^\d{1,2}$/.test(tail)) {
        return v;
      }
      const dec = Number(tail) / Math.pow(10, tail.length);
      return round2(Math.floor(v) + dec);
    }
    default:
      return v;
  }
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function listImageFiles(dir: string): string[] {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  } catch {
    files = [];
  }
  files.sort((a, b) => {
    const na = Number((a.match(/(\d+)/) || ["", "0"])[1]);
    const nb = Number((b.match(/(\d+)/) || ["", "0"])[1]);
    return na - nb || a.localeCompare(b);
  });
  return files;
}

function localYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function firstImageFile(dir: string, code: string): string | null {
  const folder = path.join(dir, code);
  const files = listImageFiles(folder);
  if (files.length === 0) {
    return null;
  }
  const fp = path.join(folder, files[0]);
  return fs.existsSync(fp) ? fp : null;
}

// ── 封面 / 图片缩略图 ──────────────────────────────────────────────
// 列表/画册/lightbox 缩略条用 webp 小图，大幅降低过 IPC 的 payload；lightbox 大图仍按需读原图。
const COVER_THUMB = 160;

function coverThumbCachePaths(storageDir: string, code: string): { thumbPath: string; metaPath: string } | null {
  if (!storageDir) {
    return null;
  }
  const root = path.join(storageDir, "shop_thumbs");
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    return null;
  }
  return {
    thumbPath: path.join(root, `${code}.webp`),
    metaPath: path.join(root, `${code}.webp.json`),
  };
}

function fileFingerprint(src: string): string {
  try {
    const st = fs.statSync(src);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return "";
  }
}

/** 把单张图缩成 webp base64 小图；失败时回退原图 base64 */
async function thumbToBase64(src: string, size = COVER_THUMB): Promise<string> {
  try {
    const out = await sharp(src).resize(size, size, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
    return `data:image/webp;base64,${out.toString("base64")}`;
  } catch {
    try {
      return await readImageToBase64(src);
    } catch {
      return "";
    }
  }
}

/** 商品封面缩略图：磁盘缓存（按 code）+ 源文件指纹校验，命中直接读盘 */
async function coverThumbToBase64(src: string, storageDir: string, code: string): Promise<string> {
  const paths = coverThumbCachePaths(storageDir, code);
  if (paths) {
    try {
      const meta = JSON.parse(fs.readFileSync(paths.metaPath, "utf-8")) as { src?: string; key?: string };
      if (meta.src === src && meta.key === fileFingerprint(src) && fs.existsSync(paths.thumbPath)) {
        return `data:image/webp;base64,${fs.readFileSync(paths.thumbPath).toString("base64")}`;
      }
    } catch {
      /* 无缓存或缓存头不匹配 */
    }
  }
  const data = await thumbToBase64(src);
  if (paths && data.startsWith("data:image/webp")) {
    try {
      fs.writeFileSync(paths.thumbPath, Buffer.from(data.split(",")[1], "base64"));
      fs.writeFileSync(paths.metaPath, JSON.stringify({ src, key: fileFingerprint(src) }));
    } catch {
      /* 写缓存失败忽略 */
    }
  }
  return data;
}

function greyCellSvg(w: number, h: number): string {
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#d6d6d6"/>
  <text x="50%" y="50%" fill="#8a8a8a" font-size="${Math.round(h / 8)}" font-family="'Segoe UI',sans-serif" text-anchor="middle" dominant-baseline="middle">无图</text>
  </svg>`;
}

function labelSvg(w: number, h: number, text: string): string {
  const fs = Math.max(24, Math.round(Math.min(w, h) * 0.13));
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="${Math.round(h * 0.93)}" font-family="'Consolas','Segoe UI',monospace" font-weight="900" font-size="${fs}" fill="#ffffff" stroke="#000000" stroke-width="${Math.max(14, Math.round(fs * 0.32))}" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle" dominant-baseline="bottom">${text}</text>
  </svg>`;
}

// 直播排品九宫格：cells 长度 9，每项 { code, img }；缺图/缺码显示灰底占位
async function renderLiveGrid(
  cells: Array<{ code: string; img: string | null }>,
  outDir: string,
  groupNo: number,
): Promise<string> {
  let tileW = 300;
  let tileH = 300;
  const firstImg = cells.find((c) => c.img);
  if (firstImg) {
    try {
      const meta = await sharp(firstImg.img!).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (w > 40 && h > 40) {
        const MAX_EDGE = 1024;
        const MIN_EDGE = 256;
        const scale = Math.min(MAX_EDGE / w, MAX_EDGE / h, 1);
        tileW = Math.max(MIN_EDGE, Math.round(w * scale));
        tileH = Math.max(MIN_EDGE, Math.round(h * scale));
      }
    } catch {
      /* 尺寸读取失败用默认 */
    }
  }
  const canvasW = tileW * 3;
  const canvasH = tileH * 3;
  const layers: Parameters<sharp.Sharp["composite"]>[0] = [];
  const startNum = (groupNo - 1) * 9 + 1;
  for (let idx = 0; idx < 9; idx++) {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const cell = cells[idx];
    let input: Buffer;
    if (cell.img) {
      input = await sharp(cell.img).resize(tileW, tileH, { fit: "fill" }).toBuffer();
    } else {
      input = Buffer.from(greyCellSvg(tileW, tileH), "utf-8");
    }
    layers.push({
      input,
      left: col * tileW,
      top: row * tileH,
    });
    if (cell.code) {
      const text = `${startNum + idx}号`;
      layers.push({
        input: Buffer.from(labelSvg(tileW, tileH, text), "utf-8"),
        left: col * tileW,
        top: row * tileH,
      });
    }
  }
  const endNum = startNum + 8;
  const outFile = path.join(outDir, `${startNum}号-${endNum}号_${localYmd()}.jpg`);
  await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(layers)
    .jpeg({ quality: 95 })
    .toFile(outFile);
  return outFile;
}

function normalizeRule(r: any): SaleRule {
  return {
    grade: Number(r.grade),
    label: String(r.label ?? ("等级" + r.grade)),
    expr: String(r.expr ?? "cost"),
    tail_mode: String(r.tail_mode ?? "raw"),
    tail_value: String(r.tail_value ?? ""),
  };
}

// 老数据迁移：历史录入的是去前导零的编码（L76），新规范统一 3 位补零（L076）。
// 首次消息处理时把 products.code 补零，并把图片目录里对应文件夹改名为新编码。
let codeMigrated = false;

export const shopTool: ToolDefinition = {
  toolName: "shopTool",
  title: "🏪商品店铺管理",
  fragmentPath: "tools/shopTool/fragment.html",
  clientScriptPath: "tools/shopTool/client.js",

  resourceRoots(storageDir) {
    try {
      initDB(storageDir);
      const dir = String(getDB().getSetting("image_dir") || "").trim();
      return dir ? [dir] : [];
    } catch {
      return [];
    }
  },

  async handleMessage(msg, ctx) {
    const log = ctx.log;
    try {
      initDB(ctx.storageDir);
    } catch (err: any) {
      log(`❌数据库初始化失败：${err.message}`);
      return;
    }
    let db = getDB();

    if (!codeMigrated) {
      codeMigrated = true;
      try {
        for (const p of db.getProducts()) {
          const padded = canonicalCode(p.code);
          if (padded && padded !== p.code) {
            db.updateProductField(p.id, "code", padded);
          }
        }
        const dir = String(db.getSetting("image_dir") || "").trim();
        if (dir) {
          let subs: string[] = [];
          try {
            subs = fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => d.name);
          } catch {
            subs = [];
          }
          for (const name of subs) {
            const mm = name.match(/^[Ll](\d{1,4})$/);
            if (!mm) {
              continue;
            }
            const n = Number(mm[1]);
            if (!Number.isInteger(n) || n < 1) {
              continue;
            }
            const padded = `L${String(n).padStart(3, "0")}`;
            if (padded.toLowerCase() === name.toLowerCase()) {
              continue;
            }
            if (!fs.existsSync(path.join(dir, padded))) {
              try {
                fs.renameSync(path.join(dir, name), path.join(dir, padded));
              } catch {
                /* 忽略单个文件夹改名失败 */
              }
            }
          }
        }
      } catch (err: any) {
        log(`⚠️编码迁移失败：${err.message}`);
      }
    }

    const getSetting = (key: string): string => db.getSetting(key);
    const imageDir = (): string => String(getSetting("image_dir") || "").trim();
    const stockAlert = (): number => {
      const v = Number(getSetting("stock_alert") || 0);
      return Number.isFinite(v) ? v : 0;
    };

    // 商品封面用 base64 按需下发（与放大看图的 lightbox 同一机制），
    // 不依赖 webview 资源白名单，任意图片目录、上传/清空后都能即时生效
    const coverCache = new Map<string, string>();
    const readCover = async (code: string): Promise<string> => {
      const dir = imageDir();
      if (!dir) {
        return "";
      }
      const folder = path.join(dir, code);
      const files = listImageFiles(folder);
      if (files.length === 0) {
        return "";
      }
      return coverThumbToBase64(path.join(folder, files[0]), ctx.storageDir, code);
    };
    const invalidateCover = (code: string) => {
      coverCache.delete(code);
      const paths = coverThumbCachePaths(ctx.storageDir, code);
      if (paths) {
        try {
          fs.rmSync(paths.thumbPath, { force: true });
          fs.rmSync(paths.metaPath, { force: true });
        } catch {
          /* 忽略缓存清理失败 */
        }
      }
      ctx.postToWebview({ type: "coverInvalidated", code });
    };

    const loadAll = () => {
      const products: Product[] = db.getProducts();
      const stockMap = db.getStockTotals();
      const saleMap = db.getSaleTotals();
      const payload = products.map((p) => ({
        ...p,
        stockTotal: stockMap.get(p.id) ?? 0,
        soldTotal: saleMap.get(p.id)?.sold ?? 0,
        refundTotal: saleMap.get(p.id)?.refund ?? 0,
      }));
      ctx.postToWebview({ type: "productsLoaded", products: payload, stockAlert: stockAlert() });
      ctx.postToWebview({ type: "rulesLoaded", rules: db.getRules() });
      ctx.postToWebview({
        type: "settingsLoaded",
        settings: {
          image_dir: imageDir(),
          name_template: getSetting("name_template"),
          stock_alert: stockAlert(),
          col_visible_list: getSetting("col_visible_list"),
          col_visible_gallery: getSetting("col_visible_gallery"),
        },
      });
      ctx.postToWebview({ type: "settlesLoaded", settles: db.getSettleMonths() });
      postLiveState();
    };

    const postLiveState = () => {
      ctx.postToWebview({
        type: "liveState",
        stars: db.getLiveStars(),
        plan: db.getLivePlan(),
        outDir: getSetting("live_out_dir"),
      });
    };

    const replySales = (date: string) => {
      ctx.postToWebview({ type: "salesLoaded", date, sales: db.getSales(date) });
    };
    // 写入/删除销售后必须重发当日的销售明细，否则前端表格会停留在旧数据
    const refreshSales = (date: string) => {
      ctx.postToWebview({ type: "salesLoaded", date, sales: db.getSales(date) });
    };

    const lockedMonth = (month: string): boolean => {
      const s = db.getSettle(month);
      return !!s && s.locked === 1;
    };

    const requireMonthUnlocked = (date: string): string | null => {
      const month = monthOf(date);
      return lockedMonth(month) ? month : null;
    };

    try {
    switch (msg.type) {
      case "loadAll": {
        loadAll();
        replySales(todayStr());
        break;
      }
      case "addProduct": {
        const code = canonicalCode(msg.code);
        if (!code) {
          log("❌编号格式错误（应形如 L001~L9999，3 位补零，最多 4 位）");
          break;
        }
        if (db.getProductByCode(code)) {
          log(`❌编号 ${code} 已存在`);
          break;
        }
        const cost = Number(msg.costPrice ?? 0);
        if (cost < 0) {
          log("❌进价不能为负");
          break;
        }
        const grade = Number(msg.grade ?? 1);
        const custom = grade === 0;
        if (!custom && db.ensureRule(grade)) {
          log(`ℹ️等级 ${grade} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
        }
        const manualSale = Math.max(0, Number(msg.salePrice ?? 0));
        const rule = custom
          ? undefined
          : db.getRules().find((r) => r.grade === grade);
        const isManual = custom || manualSale > 0;
        const pid = db.addProduct({
          code,
          name: String(msg.name ?? "").trim(),
          category: String(msg.category ?? "").trim(),
          series: String(msg.series ?? "").trim(),
          grade,
          cost_price: cost,
          sale_price: isManual ? manualSale : calcPrice(cost, rule),
          price_manual: isManual ? 1 : 0,
          purchase_link: String(msg.purchaseLink ?? "").trim(),
          status: 0,
          remark: String(msg.remark ?? "").trim(),
        });
        const initialStock = Math.floor(Number(msg.initialStock ?? 0));
        if (initialStock > 0) {
          db.addStockIn({
            product_id: pid,
            qty: initialStock,
            date: todayStr(),
            remark: "期初入库",
          });
        }
        log(`✅已新建 ${code} ${String(msg.name ?? "")}（库存 +${initialStock}）`);
        loadAll();
        break;
      }
      case "updateProductField": {
        const field = String(msg.field);
        const id = Number(msg.id);
        const product = db.getProductById(id);
        if (!product) {
          log("❌商品不存在");
          break;
        }
        if (field === "code") {
          const code = canonicalCode(msg.value);
          if (!code) {
            log("❌编号格式错误");
            break;
          }
          const exist = db.getProductByCode(code);
          if (exist && exist.id !== id) {
            log(`❌编号 ${code} 已存在`);
            break;
          }
          db.updateProductField(id, "code", code);
        } else if (field === "grade" || field === "cost_price") {
          const grade = field === "grade" ? Number(msg.value) : product.grade;
          const cost = field === "cost_price" ? Number(msg.value) : product.cost_price;
          if (cost < 0) {
            log("❌进价不能为负");
            break;
          }
          if (field === "grade") {
            if (grade === 0) {
              // 切成「自定义」：售价固定不动，不再跟随规则
              db.updateProductField(id, "grade", 0);
              db.updateProductField(id, "price_manual", 1);
            } else {
              if (db.ensureRule(grade)) {
                log(`ℹ️等级 ${grade} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
              }
              // 主动选回某个等级 = 明确要跟随该等级规则，立即按规则重算
              db.updateProductField(id, "grade", grade);
              db.updateProductField(id, "price_manual", 0);
              const rule = db.getRules().find((r) => r.grade === grade);
              db.updateProductField(id, "sale_price", calcPrice(cost, rule));
            }
          } else {
            db.updateProductField(id, "cost_price", cost);
            if (product.price_manual === 1) {
              log(`⚠️${product.code} 售价是「自定义」，改进价不会重算售价；想跟随规则请把等级改回 ${product.grade || "对应等级"}`);
            } else {
              const rule = db.getRules().find((r) => r.grade === product.grade);
              db.updateProductField(id, "sale_price", calcPrice(cost, rule));
            }
          }
        } else if (field === "sale_price") {
          const v = Number(msg.value);
          if (!Number.isFinite(v) || v < 0) {
            log("❌售价不能为负");
            break;
          }
          if (v > 0) {
            // 手动填售价 → 转「自定义」（等级列会显示“自定义”）
            db.updateProductField(id, "sale_price", v);
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
        loadAll();
        break;
      }
      case "deleteProduct": {
        const id = Number(msg.id);
        const p = db.getProductById(id);
        db.deleteProduct(id);
        log(`🗑已删除 ${p ? p.code : id}（含其销售记录与入库记录）`);
        refreshSales(todayStr());
        loadAll();
        break;
      }
      case "setStatus": {
        const id = Number(msg.id);
        const status = msg.status === 1 ? 1 : 0;
        db.updateProductField(id, "status", status);
        const p = db.getProductById(id);
        log(status === 1 ? `🔻已下架 ${p?.code ?? id}` : `🔺已上架 ${p?.code ?? id}`);
        loadAll();
        break;
      }
      case "setProductsStatus": {
        const ids: number[] = (msg.ids || []).map(Number);
        const status = msg.status === 1 ? 1 : 0;
        if (ids.length === 0) {
          log("⚠没有选中要操作的商品");
          break;
        }
        for (const id of ids) {
          db.updateProductField(id, "status", status);
        }
        log(`✅已${status === 1 ? "下架" : "上架"} ${ids.length} 个商品`);
        loadAll();
        break;
      }
      case "deleteProducts": {
        const ids: number[] = (msg.ids || []).map(Number);
        if (ids.length === 0) {
          log("⚠没有选中要删除的商品");
          break;
        }
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
        log(`✅删除商品 ${n} 个${deleted.length ? `：${deleted.slice(0, 8).join("、")}${deleted.length > 8 ? " 等" : ""}` : ""}`);
        refreshSales(todayStr());
        loadAll();
        break;
      }
      case "saveRules": {
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
        loadAll();
        break;
      }
      case "addStockIn": {
        const qty = Math.floor(Number(msg.qty ?? 0));
        if (qty <= 0) {
          log("❌入库数量必须 > 0");
          break;
        }
        const id = Number(msg.productId);
        const p = db.getProductById(id);
        if (!p) {
          log("❌商品不存在");
          break;
        }
        db.addStockIn({
          product_id: id,
          qty,
          date: String(msg.date ?? todayStr()),
          remark: String(msg.remark ?? "补货入库"),
        });
        log(`📦已入库 ${p.code} +${qty}`);
        loadAll();
        break;
      }
      case "loadStockIns": {
        ctx.postToWebview({ type: "stockInsLoaded", rows: db.getStockIns() });
        break;
      }
      case "delStockIn": {
        const id = Number(msg.id);
        db.deleteStockIn(id);
        log("🗑已删除入库记录");
        ctx.postToWebview({ type: "stockInsLoaded", rows: db.getStockIns() });
        loadAll();
        break;
      }
      case "loadSales": {
        replySales(String(msg.date ?? todayStr()));
        break;
      }
      case "saveSale": {
        const date = String(msg.date ?? todayStr());
        const lk = requireMonthUnlocked(date);
        if (lk) {
          log(`❌${lk} 已月结锁定，不能改销售记录（去“分析·月报”解锁）`);
          break;
        }
        const productId = Number(msg.productId);
        const p = db.getProductById(productId);
        if (!p) {
          log("❌商品不存在");
          break;
        }
        const sold = Math.floor(Number(msg.sold ?? 0));
        const refund = Math.floor(Number(msg.refund ?? 0));
        if (!Number.isFinite(sold) || !Number.isFinite(refund) || sold < 0 || refund < 0 || (sold === 0 && refund === 0)) {
          log("❌卖出/退款需为非负整数，且至少一个 > 0");
          break;
        }
        const mode = msg.mode === "accumulate" ? "accumulate" : msg.mode === "skip" ? "skip" : "accumulate";
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
              ? `📝已累加 ${p.code}（当天已有记录，卖出+${sold} 退款+${refund}）`
              : `⏭已跳过 ${p.code}（当天已有记录）`,
        );
        refreshSales(date);
        loadAll();
        break;
      }
      case "pasteSales": {
        const date = String(msg.date ?? todayStr());
        const lk = requireMonthUnlocked(date);
        if (lk) {
          log(`❌${lk} 已月结锁定，不能改销售记录`);
          break;
        }
        const mode = msg.mode === "accumulate" ? "accumulate" : msg.mode === "skip" ? "skip" : "accumulate";
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
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i].trim();
          if (!raw) {
            continue;
          }
          const parts = raw
            .split(/\t|[,;，；]|\s{2,}/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (parts.length === 0) {
            continue;
          }
          if (i === 0 && /^(编号|商品|编号|code)/i.test(parts[0])) {
            continue;
          }
          if (/^(编号|名称|商品|code|id|品类|类别|分类|系列|等级|成本|进价|售价|数量|库存|状态|采购|备注)/i.test(parts[0])) {
            continue;
          }
          const token = parts[0];
          const code = extractCodeToken(token);
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
          } else if (res === "updated") {
            updated++;
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
        ctx.postToWebview({
          type: "pasteResult",
          ok: true,
          created,
          updated,
          skipped,
          missing: missingList,
          badLines: bad,
        });
        refreshSales(date);
        loadAll();
        break;
      }
      case "deleteSales": {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(Number) : [Number(msg.id)];
        const date = String(msg.date ?? todayStr());
        const lk = requireMonthUnlocked(date);
        if (lk) {
          log(`❌${lk} 已月结锁定，不能删除销售记录`);
          break;
        }
        db.deleteSales(ids);
        log(`🗑已删除 ${ids.length} 条销售记录`);
        refreshSales(date);
        loadAll();
        break;
      }
      case "salesTrend": {
        const by = msg.by === "day" ? "day" : "month";
        const productId = msg.productId ? Number(msg.productId) : undefined;
        const rows = db.salesTrend(by, String(msg.month ?? ""), productId);
        ctx.postToWebview({ type: "trendLoaded", by, rows, productId: productId ?? null });
        break;
      }
      case "monthBuild": {
        const month = String(msg.month ?? todayStr().slice(0, 7));
        const snapshot = db.snapshotMonth(month);
        const settle = db.getSettle(month);
        ctx.postToWebview({ type: "monthBuilt", month, snapshot, settle: settle ?? null });
        break;
      }
      case "saveSettle": {
        const month = String(msg.month ?? todayStr().slice(0, 7));
        const settle = db.getSettle(month);
        if (settle && settle.locked === 1) {
          log(`❌${month} 已锁定，先解锁再改`);
          break;
        }
        const income = Number(msg.incomeAmount ?? 0);
        const extra = Number(msg.extraExpense ?? 0);
        if (!Number.isFinite(income) || !Number.isFinite(extra) || income < 0 || extra < 0) {
          log("❌到账收入与其他支出需为非负数字");
          break;
        }
        const snap = db.snapshotMonth(month);
        const profit = round2(income - snap.goods_cost - extra);
        db.saveSettle({
          month,
          income_amount: income,
          extra_expense: extra,
          goods_cost: round2(snap.goods_cost),
          sold_total: snap.sold_total,
          refund_total: snap.refund_total,
          profit,
          locked: 0,
        });
        log(
          `🖊已保存 ${month} 月报：到账¥${income} 支出¥${extra} 货成本¥${round2(snap.goods_cost)} 利润¥${profit}`,
        );
        ctx.postToWebview({
          type: "monthBuilt",
          month,
          snapshot: snap,
          settle: db.getSettle(month),
        });
        ctx.postToWebview({ type: "settlesLoaded", settles: db.getSettleMonths() });
        break;
      }
      case "lockSettle":
      case "unlockSettle": {
        const month = String(msg.month ?? "");
        db.setLock(month, msg.type === "lockSettle" ? 1 : 0);
        log(msg.type === "lockSettle" ? `🔒已锁定 ${month}` : `🔓已解锁 ${month}`);
        ctx.postToWebview({ type: "settlesLoaded", settles: db.getSettleMonths() });
        ctx.postToWebview({
          type: "monthBuilt",
          month,
          snapshot: db.snapshotMonth(month),
          settle: db.getSettle(month) ?? null,
        });
        break;
      }
      case "deleteSettle": {
        const month = String(msg.month ?? "");
        db.deleteSettle(month);
        log(`🗑已删除 ${month} 月报`);
        ctx.postToWebview({ type: "settlesLoaded", settles: db.getSettleMonths() });
        break;
      }
      case "getCover": {
        const code = String(msg.code ?? "");
        let data = coverCache.get(code);
        if (data === undefined) {
          data = await readCover(code);
          coverCache.set(code, data);
        }
        ctx.postToWebview({ type: "coverLoaded", code, data });
        break;
      }
      case "getImages": {
        const code = String(msg.code ?? "");
        const dir = imageDir();
        if (!dir) {
          ctx.postToWebview({ type: "imagesLoaded", code, images: [] });
          break;
        }
        const folder = path.join(dir, code);
        const files = listImageFiles(folder);
        if (files.length === 0) {
          ctx.postToWebview({ type: "imagesLoaded", code, images: [] });
          break;
        }
        const thumbs: string[] = [];
        let big0 = "";
        for (let i = 0; i < files.length; i++) {
          const fp = path.join(folder, files[i]);
          if (i === 0) {
            try {
              big0 = await readImageToBase64(fp);
            } catch {
              big0 = "";
            }
          }
          thumbs.push(await thumbToBase64(fp));
        }
        ctx.postToWebview({ type: "imagesLoaded", code, images: thumbs, big0 });
        break;
      }
      case "getFullImage": {
        const code = String(msg.code ?? "");
        const index = Number(msg.index ?? 0);
        const dir = imageDir();
        if (!dir) {
          ctx.postToWebview({ type: "fullImageLoaded", code, index, data: "" });
          break;
        }
        const folder = path.join(dir, code);
        const files = listImageFiles(folder);
        const fp = files[index] ? path.join(folder, files[index]) : null;
        if (!fp) {
          ctx.postToWebview({ type: "fullImageLoaded", code, index, data: "" });
          break;
        }
        try {
          const data = await readImageToBase64(fp);
          ctx.postToWebview({ type: "fullImageLoaded", code, index, data });
        } catch {
          ctx.postToWebview({ type: "fullImageLoaded", code, index, data: "" });
        }
        break;
      }
      case "uploadImages": {
        const code = String(msg.code ?? "");
        const dir = imageDir();
        if (!dir) {
          log("❌请先在「规则与设置」里选择图片根目录");
          break;
        }
        const folder = path.join(dir, code);
        fs.mkdirSync(folder, { recursive: true });
        const picked = await ctx.selectFiles(UPLOAD_FILTER);
        if (!picked.length) {
          break;
        }
        const stamp = (): string => {
          const d = new Date();
          const p2 = (n: number) => String(n).padStart(2, "0");
          return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
        };
        let added = 0;
        for (const src of picked) {
          const ext = path.extname(src).toLowerCase() || ".jpg";
          const base = `${code}_${stamp()}`;
          let target = path.join(folder, `${base}${ext}`);
          let n = 2;
          while (fs.existsSync(target)) {
            target = path.join(folder, `${base}_${n}${ext}`);
            n++;
          }
          try {
            fs.copyFileSync(src, target);
            added++;
          } catch (err: any) {
            log(`⚠️复制失败 ${path.basename(src)}：${err.message}`);
          }
        }
        log(`🖼已上传导入 ${added} 张图 → ${code} 文件夹（自动按 ${code}_时间戳.jpg 命名）`);
        const files = listImageFiles(folder);
        const imgs: string[] = [];
        let big0 = "";
        for (let i = 0; i < files.length; i++) {
          const fp = path.join(folder, files[i]);
          if (i === 0) {
            try {
              big0 = await readImageToBase64(fp);
            } catch {
              big0 = "";
            }
          }
          imgs.push(await thumbToBase64(fp));
        }
        ctx.postToWebview({ type: "imagesLoaded", code, images: imgs, big0 });
        invalidateCover(code);
        loadAll();
        break;
      }
      case "clearImages": {
        const code = String(msg.code ?? "");
        const dir = imageDir();
        if (!dir) {
          log("❌未配置图片根目录");
          break;
        }
        const folder = path.join(dir, code);
        if (!fs.existsSync(folder)) {
          log(`⚠️${code} 无图片文件夹`);
          break;
        }
        const files = listImageFiles(folder);
        for (const f of files) {
          try {
            fs.unlinkSync(path.join(folder, f));
          } catch {
            /* 忽略单张删除失败 */
          }
        }
        log(`🗑已清空 ${code} 图片文件夹（${files.length} 张）`);
        ctx.postToWebview({ type: "imagesLoaded", code, images: [] });
        invalidateCover(code);
        loadAll();
        break;
      }
      case "importProducts": {
        const black: string[] = [];
        let created = 0;
        let skipped = 0;
        const lines = String(msg.text ?? "").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i].trim();
          if (!raw) {
            continue;
          }
          const parts = raw
            .split(/\t|[,;，；]|\s{2,}/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (parts.length === 0) {
            continue;
          }
          if (i === 0 && /编号|商品|编号|code/i.test(parts[0])) {
            continue;
          }
          if (/^(编号|名称|商品|code|id|品类|类别|分类|系列|等级|成本|进价|售价|数量|库存|状态|采购|备注)/i.test(parts[0])) {
            continue;
          }
          const rawCode = parts[0];
          const mT = rawCode.match(/[Ll](\d{1,4})/);
          const code = canonicalCode(mT ? `L${mT[1]}` : rawCode);
          if (!code) {
            black.push(`行${i + 1}: ${raw}`);
            continue;
          }
          if (db.getProductByCode(code)) {
            skipped++;
            continue;
          }
          const name = String(parts[1] ?? "");
          const category = String(parts[2] ?? "");
          const series = String(parts[3] ?? "");
          const gradeRaw = Math.floor(Number(parts[4] ?? 1));
          const grade = Number.isFinite(gradeRaw) && gradeRaw >= 0 && gradeRaw <= 99 ? gradeRaw : 1;
          const costRaw = Number(parts[5] ?? 0);
          const cost = Number.isFinite(costRaw) && costRaw >= 0 ? costRaw : 0;
          const saleRaw = Number(parts[6] ?? 0);
          const link = String(parts[7] ?? "");
          const manual = Number.isFinite(saleRaw) && saleRaw > 0 ? saleRaw : 0;
          const custom = grade === 0;
          if (!custom && db.ensureRule(grade)) {
            log(`ℹ️等级 ${grade} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
          }
          const rule = custom
            ? undefined
            : db.getRules().find((r) => r.grade === grade);
          db.addProduct({
            code,
            name,
            category,
            series,
            grade,
            cost_price: cost,
            sale_price: custom || manual > 0 ? manual : calcPrice(cost, rule),
            price_manual: custom || manual > 0 ? 1 : 0,
            purchase_link: link,
            status: 0,
            remark: "",
          });
          created++;
        }
        log(
          `📥商品导入：新增 ${created} 个，跳过(编号已存在) ${skipped} 个` +
            (black.length ? `，无法解析 ${black.length} 行` : ""),
        );
        for (const b of black) {
          log(`  ⚠️${b}`);
        }
        ctx.postToWebview({ type: "productsImported", ok: true, created, skipped, bad: black });
        loadAll();
        break;
      }
      case "pickImageDir": {
        const picked = await ctx.selectFolder(
          "选择商品图片根目录（每商品一个文件夹，内放 {编号}_{序号}.jpg）",
        );
        if (picked) {
          db.setSetting("image_dir", picked);
          log(`🖼图片根目录已设为：${picked}`);
          loadAll();
        }
        break;
      }
      case "saveSettings": {
        const key = String(msg.key ?? "");
        const allowedKeys = new Set(["image_dir", "name_template", "stock_alert", "col_visible_list", "col_visible_gallery", "live_out_dir"]);
        if (!allowedKeys.has(key)) {
          log("❌不支持的设置项: " + key);
          break;
        }
        db.setSetting(key, String(msg.value ?? ""));
        log("⚙️设置已保存");
        loadAll();
        break;
      }
      case "toggleLiveStar": {
        const code = canonicalCode(String(msg.code ?? ""));
        if (!code) {
          log("❌编号格式错误");
          break;
        }
        const set = new Set(db.getLiveStars());
        const adding = !set.has(code);
        if (adding) {
          set.add(code);
        } else {
          set.delete(code);
        }
        db.replaceLiveStars([...set]);
        postLiveState();
        log(adding ? `⭐已选 ${code}` : `☆已取消 ${code}`);
        break;
      }
      case "setLiveStars": {
        const codes = Array.isArray(msg.codes) ? (msg.codes as unknown[]) : [];
        const valid = new Set(db.getProducts().map((p) => p.code));
        const set = new Set<string>();
        for (const raw of codes) {
          const c = canonicalCode(raw);
          if (c && valid.has(c)) {
            set.add(c);
          }
        }
        db.replaceLiveStars([...set].sort());
        postLiveState();
        break;
      }
      case "saveLivePlan": {
        const raw = Array.isArray(msg.plan) ? (msg.plan as any[]) : [];
        db.replaceLivePlan(
          raw.map((r) => ({
            group_no: Number(r.group_no),
            slot_no: Number(r.slot_no),
            code: String(r.code ?? ""),
          })),
        );
        postLiveState();
        break;
      }
      case "clearLivePlan": {
        db.replaceLivePlan([]);
        postLiveState();
        log("🗑已清空排品格子（已选商品保留）");
        break;
      }
      case "pickLiveOutDir": {
        const dir = await ctx.selectFolder("选择直播排品九宫格输出目录");
        if (!dir) {
          break;
        }
        db.setSetting("live_out_dir", dir);
        log(`📁直播排品输出目录：${dir}`);
        postLiveState();
        break;
      }
      case "generateLiveGrid": {
        const rawPlan = Array.isArray(msg.plan) ? (msg.plan as any[]) : [];
        const plan: LivePlanRow[] = rawPlan.map((r) => ({
          group_no: Number(r.group_no),
          slot_no: Number(r.slot_no),
          code: String(r.code ?? ""),
        }));
        db.replaceLivePlan(plan);
        const dir = imageDir();
        const products = db.getProducts();
        const byCode = new Map<string, Product>();
        for (const p of products) {
          byCode.set(p.code, p);
        }
        const groups = new Map<number, Map<number, string>>();
        for (const r of plan) {
          if (!byCode.has(r.code)) {
            continue;
          }
          let slots = groups.get(r.group_no);
          if (!slots) {
            slots = new Map();
            groups.set(r.group_no, slots);
          }
          slots.set(r.slot_no, r.code);
        }
        if (groups.size === 0) {
          log("❌先填至少一个排品格子再生成");
          break;
        }
        let outDir = String(getSetting("live_out_dir") || "").trim();
        if (outDir && fs.existsSync(outDir)) {
          const ok = await ctx.confirm(`直播排品将输出到：${outDir}`, "点「取消」改为另选输出目录");
          if (!ok) {
            outDir = "";
          }
        }
        if (!outDir) {
          const picked = await ctx.selectFolder("选择直播排品九宫格输出目录");
          if (!picked) {
            log("❌未选择输出目录，已取消");
            break;
          }
          outDir = picked;
          db.setSetting("live_out_dir", outDir);
        }
        if (!fs.existsSync(outDir)) {
          try {
            fs.mkdirSync(outDir, { recursive: true });
          } catch (err: any) {
            log(`❌创建输出目录失败：${err.message}`);
            break;
          }
        }
        const onlyGroups = Array.isArray(msg.groups) ? new Set((msg.groups as any[]).map(Number)) : null;
        let groupNos = [...groups.keys()].sort((a, b) => a - b);
        if (onlyGroups) {
          groupNos = groupNos.filter((g) => onlyGroups.has(g));
        }
        if (groupNos.length === 0) {
          log("❌没有可生成的组");
          break;
        }
        const files: string[] = [];
        for (const g of groupNos) {
          const slots = groups.get(g)!;
          const cells: Array<{ code: string; img: string | null }> = [];
          for (let s = 1; s <= 9; s++) {
            const code = slots.get(s) ?? "";
            cells.push({ code, img: code ? firstImageFile(dir, code) : null });
          }
          try {
            files.push(await renderLiveGrid(cells, outDir, g));
          } catch (err: any) {
            log(`❌第 ${g} 组生成失败：${err.message}`);
          }
        }
        try {
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outDir));
        } catch {
          /* 忽略打开失败 */
        }
        log(
          `🖼直播九宫格完成 ${files.length} 张（${groupNos.map((g) => `第${g}组`).join(" ")}）`,
        );
        ctx.postToWebview({ type: "liveGenerated", dir: outDir, count: files.length });
        postLiveState();
        break;
      }
      case "exportDB": {
        const dir = await ctx.selectFolder("选择数据库备份目录");
        if (!dir) {
          break;
        }
        const outFile = path.join(dir, `商品数据_${fileStamp()}.db`);
        try {
          await db.backupDB(outFile);
          log(`✅数据库已备份：${outFile}`);
          ctx.postToWebview({ type: "toast", text: "数据库备份完成" });
        } catch (err: any) {
          log(`❌备份数据库失败：${err.message}`);
          ctx.postToWebview({ type: "toast", text: `备份失败：${err.message}` });
        }
        break;
      }
      case "importDB": {
        const fp = await ctx.selectFile({ 数据库: ["db"] });
        if (!fp) {
          break;
        }
        try {
          db.restoreDB(fp, ctx.storageDir);
          db = getDB();
          log("✅数据库已恢复，数据已替换为所选备份");
          ctx.postToWebview({ type: "toast", text: "数据库恢复完成" });
          loadAll();
          postLiveState();
        } catch (err: any) {
          log(`❌恢复数据库失败：${err.message}`);
          ctx.postToWebview({ type: "toast", text: `恢复失败：${err.message}` });
          try {
            db = getDB();
            loadAll();
          } catch {
            /* 忽略 */
          }
        }
        break;
      }
      default: {
        log(`❌未处理的消息类型:${msg.type}`);
      }
    }
    } catch (err: any) {
      const text = String(err?.message ?? err ?? "未知错误");
      log(`❌操作失败：${text}`);
      ctx.postToWebview({ type: "dbOpError", message: text });
    }
  },
};