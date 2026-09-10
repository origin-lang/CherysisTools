import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ToolDefinition } from "../../core/toolRegistry.js";
import { readImageToBase64 } from "../../core/utils.js";
import { getDB, initDB, LivePlanRow, Product, SaleRule } from "./db.js";
import {
  canonicalCode,
  extractCodeToken,
  round2,
  applyExpr,
  calcPrice,
  monthOf,
  todayStr,
  fileStamp,
  normalizeRule,
} from "./pricing.js";
import {
  UPLOAD_FILTER,
  listImageFiles,
  firstImageFile,
  coverThumbToBase64,
  coverThumbCachePaths,
  thumbToBase64,
} from "./images.js";
import { renderLiveGrid } from "./liveGrid.js";
import * as XLSX from "xlsx";

// 自动备份：每日首次启动自动留档（shop_auto_*），破坏性操作前追加留档（shop_pre_*）；两类各自独立配额剪除，只保留最新 N 份，不无限累积。
const AUTO_BACKUP_KEEP = 14;
const PRE_BACKUP_KEEP = 20;
let lastAutoBackupCheckDate = "";
const backupDir = (storageDir: string): string => path.join(storageDir, "backups");

function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) {
    return "";
  }
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// 字段规整：name 必填无空格；category/series/purchase_link 无空格；文字超长截断；金额 round2；库存整数。
// 与前端 sanitizeProductField（client-core.js）同规则，这里是入库前最后一道拦截。
function normText(
  field: "name" | "category" | "series" | "purchase_link" | "remark",
  raw: unknown,
  opts?: { required?: boolean },
): { ok: boolean; msg: string; value: string; truncated: boolean } {
  const MAX: Record<string, number> = {
    name: 100,
    category: 50,
    series: 50,
    purchase_link: 500,
    remark: 200,
  };
  const NO_SPACE = new Set(["name", "category", "series", "purchase_link"]);
  const label: Record<string, string> = {
    name: "名称",
    category: "品类",
    series: "系列",
    purchase_link: "采购链接",
    remark: "备注",
  };
  let s = String(raw ?? "").trim();
  if (opts?.required && !s) {
    return { ok: false, msg: `${label[field]}不能为空`, value: s, truncated: false };
  }
  if (NO_SPACE.has(field) && /\s/.test(s)) {
    return { ok: false, msg: `${label[field]}不能包含空格`, value: s, truncated: false };
  }
  const truncated = s.length > MAX[field];
  if (truncated) {
    s = s.slice(0, MAX[field]);
  }
  return { ok: true, msg: "", value: s, truncated };
}

function normMoney(field: "cost_price" | "sale_price", raw: unknown): { ok: boolean; msg: string; value: number } {
  const n = Number(raw ?? 0);
  const label = field === "cost_price" ? "进价" : "售价";
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, msg: `${label}需为 ≥0 的数字`, value: 0 };
  }
  return { ok: true, msg: "", value: round2(n) };
}

function normGrade(raw: unknown): { ok: boolean; msg: string; value: number } {
  const n = Number(raw ?? 1);
  if (n === 0) {
    return { ok: true, msg: "", value: 0 };
  }
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    return { ok: false, msg: "等级需为 0（自定义）或 1-99 的整数", value: n };
  }
  return { ok: true, msg: "", value: n };
}

function normInt(field: string, raw: unknown): { ok: boolean; msg: string; value: number } {
  const n = Number(raw ?? 0);
  const label = field === "stockTotal" ? "库存" : field;
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, msg: `${label}需为非负整数`, value: n };
  }
  return { ok: true, msg: "", value: n };
}

// 商品字段的固定显示顺序（与前端 client-core.js PRODUCT_FIELDS 保持一致）
const PRODUCT_FIELD_ORDER: Array<{ key: string; label: string }> = [
  { key: "code", label: "编号" },
  { key: "name", label: "名称" },
  { key: "category", label: "品类" },
  { key: "series", label: "系列" },
  { key: "grade", label: "等级" },
  { key: "cost_price", label: "进价" },
  { key: "sale_price", label: "售价" },
  { key: "stockTotal", label: "库存" },
  { key: "soldTotal", label: "累计售出" },
  { key: "netTotal", label: "累计净售" },
  { key: "status", label: "状态" },
  { key: "purchase_link", label: "采购链接" },
];
// 可写字段子集（派生列不参与导入/导出写回）
const IMPORTABLE_FIELD_ORDER = PRODUCT_FIELD_ORDER.filter((f) =>
  ["name", "category", "series", "grade", "cost_price", "sale_price", "purchase_link"].includes(f.key),
);

// 导入/粘贴时的表头关键词：首列命中即视为表头行整行跳过（pasteSales 与 importProducts 共用）
const HEADER_FIRST_COLUMN_RE = /^(编号|名称|商品|code|id|品类|类别|分类|系列|等级|成本|进价|售价|数量|库存|状态|采购|备注)/i;

async function backupToDir(storageDir: string, prefix: string): Promise<string | null> {
  try {
    fs.mkdirSync(backupDir(storageDir), { recursive: true });
  } catch {
    return null;
  }
  const file = path.join(backupDir(storageDir), `${prefix}_${fileStamp()}.db`);
  try {
    await getDB().backupDB(file);
    return file;
  } catch {
    return null;
  }
}

function pruneBackups(storageDir: string, prefix: string, keep: number): void {
  try {
    const files = fs
      .readdirSync(backupDir(storageDir))
      .filter((f) => f.startsWith(prefix) && f.endsWith(".db"))
      .map((f) => ({ f, m: fs.statSync(path.join(backupDir(storageDir), f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of files.slice(keep)) {
      try {
        fs.unlinkSync(path.join(backupDir(storageDir), f));
      } catch {
        /* 忽略单个删除失败 */
      }
    }
  } catch {
    /* 目录不存在则无事可做 */
  }
}

function backupTargetDirs(storageDir: string, defaultStorageDir: string): string[] {
  const set = new Set<string>();
  if (storageDir) {
    set.add(storageDir);
  }
  if (defaultStorageDir) {
    set.add(defaultStorageDir);
  }
  return Array.from(set);
}

async function maybeAutoBackup(storageDir: string, defaultStorageDir: string, log: (s: string) => void): Promise<void> {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  if (lastAutoBackupCheckDate === stamp) {
    return;
  }
  lastAutoBackupCheckDate = stamp;
  try {
    if (String(getDB().getSetting("auto_backup_date") || "") === stamp) {
      return;
    }
    const okFiles: string[] = [];
    const failDirs: string[] = [];
    for (const dir of backupTargetDirs(storageDir, defaultStorageDir)) {
      const file = await backupToDir(dir, "shop_auto");
      if (file) {
        okFiles.push(file);
        pruneBackups(dir, "shop_auto_", AUTO_BACKUP_KEEP);
      } else {
        failDirs.push(dir);
      }
    }
    if (okFiles.length > 0) {
      getDB().setSetting("auto_backup_date", stamp);
    }
    if (okFiles.length > 0 && failDirs.length === 0) {
      log(`✅每日自动备份完成（${okFiles.length} 份）${okFiles.join(" | ")}`);
    } else if (okFiles.length > 0) {
      log(`⚠️每日自动备份部分成功（${failDirs.length} 个目录失败）${okFiles.join(" | ")}`);
    } else {
      log("⚠️每日自动备份失败");
    }
  } catch (err: any) {
    log(`⚠️每日自动备份失败：${err.message}`);
  }
}

async function preOpBackup(storageDir: string, defaultStorageDir: string, log: (s: string) => void): Promise<void> {
  const okFiles: string[] = [];
  try {
    for (const dir of backupTargetDirs(storageDir, defaultStorageDir)) {
      const file = await backupToDir(dir, "shop_pre");
      if (file) {
        okFiles.push(file);
        pruneBackups(dir, "shop_pre_", PRE_BACKUP_KEEP);
      }
    }
  } catch (err: any) {
    log(`⚠️操作前自动留档失败：${err.message}`);
    return;
  }
  if (okFiles.length > 0) {
    log(`🛡️操作前已自动留档（${okFiles.length} 份）${okFiles.join(" | ")}`);
  } else {
    log("⚠️操作前自动留档失败");
  }
}

// 老数据迁移：历史录入的是去前导零的编码（L76），新规范统一 3 位补零（L076）。
// 首次消息处理时把 products.code 补零，并把图片目录里对应文件夹改名为新编码。
let codeMigrated = false;

export const shopTool: ToolDefinition = {
  toolName: "shopTool",
  title: "🏪商品店铺管理",
  fragmentPath: "tools/shopTool/fragment.html",
  clientScriptPath: [
    "tools/shopTool/client-core.js",
    "tools/shopTool/client-product.js",
    "tools/shopTool/client-sales.js",
    "tools/shopTool/client-report.js",
    "tools/shopTool/client-live.js",
    "tools/shopTool/client-main.js",
  ],

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

    await maybeAutoBackup(ctx.storageDir, ctx.defaultStorageDir, log);

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

    // 删商品时先删对应图片文件夹：失败自动重试一次，删完再校验一次，
    // 仍删不掉就打印完整路径（多半是文件被占用），返回值标识是否真正删掉
    const removeImageFolder = (code: string): boolean => {
      const dir = imageDir();
      if (!dir) {
        log("⚠️未配置图片根目录，无法删除图片文件夹");
        return false;
      }
      const folder = path.join(dir, code);
      if (!fs.existsSync(folder)) {
        return false;
      }
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch {
        try {
          fs.rmSync(folder, { recursive: true, force: true });
        } catch (err: any) {
          log(`⚠️删除图片文件夹失败：${folder}（${err?.message ?? err}）`);
          return false;
        }
      }
      if (fs.existsSync(folder)) {
        log(`⚠️图片文件夹删除后仍存在：${folder}（可能被占用）`);
        return false;
      }
      log(`🗑已清理图片文件夹：${folder}`);
      return true;
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
        const nameR = normText("name", msg.name, { required: true });
        if (!nameR.ok) {
          log(`❌${nameR.msg}`);
          break;
        }
        const categoryR = normText("category", msg.category);
        const seriesR = normText("series", msg.series);
        const linkR = normText("purchase_link", msg.purchaseLink);
        const remarkR = normText("remark", msg.remark);
        for (const r of [categoryR, seriesR, linkR]) {
          if (!r.ok) {
            log(`❌${r.msg}`);
            break;
          }
        }
        if (!categoryR.ok || !seriesR.ok || !linkR.ok) {
          break;
        }
        const cost = normMoney("cost_price", msg.costPrice);
        if (!cost.ok) {
          log(`❌${cost.msg}`);
          break;
        }
        const sale = normMoney("sale_price", msg.salePrice);
        if (!sale.ok) {
          log(`❌${sale.msg}`);
          break;
        }
        const grade = normGrade(msg.grade ?? 1);
        if (!grade.ok) {
          log(`❌${grade.msg}`);
          break;
        }
        const initialStock = normInt("stockTotal", msg.initialStock);
        if (!initialStock.ok) {
          log(`❌${initialStock.msg}`);
          break;
        }
        const custom = grade.value === 0;
        if (!custom && db.ensureRule(grade.value)) {
          log(`ℹ️等级 ${grade.value} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
        }
        const isManual = custom || sale.value > 0;
        const pid = db.addProduct({
          code,
          name: nameR.value,
          category: categoryR.value,
          series: seriesR.value,
          grade: grade.value,
          cost_price: cost.value,
          sale_price: isManual ? sale.value : calcPrice(cost.value, custom ? undefined : db.getRules().find((r) => r.grade === grade.value)),
          price_manual: isManual ? 1 : 0,
          purchase_link: linkR.value,
          status: 0,
          remark: remarkR.value,
          stock_manual: 0,
        });
        if (initialStock.value > 0) {
          db.addStockIn({
            product_id: pid,
            qty: initialStock.value,
            date: todayStr(),
            remark: "期初入库",
          });
        }
        log(`✅已新建 ${code} ${nameR.value}（库存 +${initialStock.value}）`);
        ctx.postToWebview({ type: "toast", text: `✅已新建 ${code}` });
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
        } else if (field === "name" || field === "category" || field === "series" || field === "purchase_link" || field === "remark") {
          const r = normText(field, msg.value, field === "name" ? { required: true } : undefined);
          if (!r.ok) {
            log(`❌${r.msg}`);
            break;
          }
          db.updateProductField(id, field, r.value);
          if (r.truncated) {
            log(`‼${product.code} 的${field === "name" ? "名称" : field === "category" ? "品类" : field === "series" ? "系列" : field === "purchase_link" ? "采购链接" : "备注"}超长，已截断`);
          }
        } else if (field === "grade") {
          const grade = normGrade(msg.value);
          if (!grade.ok) {
            log(`❌${grade.msg}`);
            break;
          }
          if (grade.value === 0) {
            // 切成「自定义」：售价固定不动，不再跟随规则
            db.updateProductField(id, "grade", 0);
            db.updateProductField(id, "price_manual", 1);
          } else {
            if (db.ensureRule(grade.value)) {
              log(`ℹ️等级 ${grade.value} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
            }
            // 主动选回某个等级 = 明确要跟随该等级规则，立即按规则重算
            db.updateProductField(id, "grade", grade.value);
            db.updateProductField(id, "price_manual", 0);
            const rule = db.getRules().find((r) => r.grade === grade.value);
            db.updateProductField(id, "sale_price", calcPrice(product.cost_price, rule));
          }
        } else if (field === "cost_price") {
          const cost = normMoney("cost_price", msg.value);
          if (!cost.ok) {
            log(`❌${cost.msg}`);
            break;
          }
          db.updateProductField(id, "cost_price", cost.value);
          if (product.price_manual === 1) {
            log(`⚠️${product.code} 售价是「自定义」，改进价不会重算售价；想跟随规则请把等级改回 ${product.grade || "对应等级"}`);
          } else {
            const rule = db.getRules().find((r) => r.grade === product.grade);
            db.updateProductField(id, "sale_price", calcPrice(cost.value, rule));
          }
        } else if (field === "sale_price") {
          const sale = normMoney("sale_price", msg.value);
          if (!sale.ok) {
            log(`❌${sale.msg}`);
            break;
          }
          if (sale.value > 0) {
            // 手动填售价 → 转「自定义」（等级列会显示“自定义”）
            db.updateProductField(id, "sale_price", sale.value);
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
      case "setStockQty": {
        const sid = Number(msg.id);
        const product = db.getProductById(sid);
        if (!product) {
          log("❌商品不存在");
          break;
        }
        const qty = normInt("stockTotal", msg.qty);
        if (!qty.ok) {
          log(`❌${qty.msg}`);
          break;
        }
        db.updateStockQty(sid, qty.value);
        log(`🔢清点 ${product.code} 库存 = ${qty}`);
        loadAll();
        break;
      }
      case "deleteProduct": {
        const id = Number(msg.id);
        const p = db.getProductById(id);
        if (p) {
          await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
        }
        if (p) {
          // 先删图片文件夹（删不掉也不阻塞删商品，但会打印完整路径），再删商品
          removeImageFolder(p.code);
          invalidateCover(p.code);
        }
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
        await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
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
        let imgCleaned = 0;
        for (const code of deleted) {
          if (removeImageFolder(code)) {
            imgCleaned++;
          }
          invalidateCover(code);
        }
        if (imgCleaned > 0) {
          log(`🗑已同时清理 ${imgCleaned} 个商品图片文件夹`);
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
        await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
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
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i].trim();
          if (!raw) {
            continue;
          }
          const parts = raw
            .split(/[,;，；]|\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (parts.length === 0) {
            continue;
          }
          if (HEADER_FIRST_COLUMN_RE.test(parts[0])) {
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
        await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
        db.deleteSales(ids);
        log(`🗑已删除 ${ids.length} 条销售记录`);
        refreshSales(date);
        loadAll();
        break;
      }
      case "updateSalesField": {
        const id = Number(msg.id);
        const field = String(msg.field);
        const date = String(msg.date ?? todayStr());
        if (field !== "sold_qty" && field !== "refund_qty" && field !== "note") {
          log("❌不支持的字段：" + field);
          break;
        }
        if (field === "sold_qty" || field === "refund_qty") {
          const n = Math.floor(Number(msg.value));
          if (!Number.isFinite(n) || n < 0) {
            log("❌卖出/退款需为非负整数");
            break;
          }
          const lk = requireMonthUnlocked(date);
          if (lk) {
            log(`❌${lk} 已月结锁定，不能改销售记录（去“分析·月报”解锁）`);
            break;
          }
          db.updateSalesField(id, field, n);
          log(`✏️已改 ${field === "sold_qty" ? "卖出" : "退款"}→ ${n}`);
        } else {
          db.updateSalesField(id, "note", String(msg.value ?? ""));
          log("✏️已改备注");
        }
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
        ctx.postToWebview({
          type: "monthBuilt",
          month,
          snapshot,
          settle: settle ?? null,
          prevEndStock: Number(db.getSettle(prevMonth(month))?.end_stock || 0),
          endStockAuto: round2(db.sumStockCost()),
        });
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
        const purchase = Number(msg.purchaseCost ?? 0);
        const extra = Number(msg.extraExpense ?? 0);
        const startStock = Number(msg.startStock ?? 0);
        const endStock = round2(db.sumStockCost());
        const vals = [income, purchase, extra, startStock];
        if (!vals.every(Number.isFinite) || vals.some((v) => v < 0)) {
            log("❌到账/进货/杂项/期初需为非负数");
          break;
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
        ctx.postToWebview({
          type: "monthBuilt",
          month,
          snapshot: snap,
          settle: db.getSettle(month),
          prevEndStock: Number(db.getSettle(prevMonth(month))?.end_stock || 0),
          endStockAuto: round2(db.sumStockCost()),
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
        await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
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
        await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
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
      case "openImageFile": {
        const code = String(msg.code ?? "");
        const dir = imageDir();
        if (!dir) {
          log("❌未配置图片根目录");
          break;
        }
        const folder = path.join(dir, code);
        if (!fs.existsSync(folder)) {
          log(`⚠️${code} 没有图片文件夹`);
          break;
        }
        try {
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(folder),
          );
        } catch (err: any) {
          log(`⚠️打开图片文件夹失败：${err.message}`);
        }
        break;
      }
      case "deleteImageFile": {
        const code = String(msg.code ?? "");
        const index = Number(msg.index ?? 0);
        const dir = imageDir();
        if (!dir) {
          log("❌未配置图片根目录");
          break;
        }
        const folder = path.join(dir, code);
        const files = listImageFiles(folder);
        const fp = files[index] ? path.join(folder, files[index]) : null;
        if (!fp) {
          log(`⚠️${code} 没有第 ${index + 1} 张图片`);
          break;
        }
        await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
        try {
          fs.unlinkSync(fp);
        } catch (err: any) {
          log(`⚠️删除图片失败：${err.message}`);
          break;
        }
        log(`🗑已删除 ${code} 的第 ${index + 1} 张图片`);
        const files2 = listImageFiles(folder);
        let big0 = "";
        const imgs: string[] = [];
        for (let i = 0; i < files2.length; i++) {
          const fp2 = path.join(folder, files2[i]);
          if (i === 0) {
            try {
              big0 = await readImageToBase64(fp2);
            } catch {
              big0 = "";
            }
          }
          imgs.push(await thumbToBase64(fp2));
        }
        ctx.postToWebview({ type: "imagesLoaded", code, images: imgs, big0 });
        invalidateCover(code);
        loadAll();
        break;
      }
      case "importProducts": {
        await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
        const black: string[] = [];
        let created = 0;
        let updated = 0;
        let skipped = 0;
        // 导入列 = “编号” + 当前可见列∩可写字段（派生列不参与导入；默认可见=旧 8 列格式）
        const IMPORT_WRITABLE = new Set([
          "name",
          "category",
          "series",
          "grade",
          "cost_price",
          "sale_price",
          "purchase_link",
        ]);
        const rawVisSetting = String(getSetting("col_visible_list") || "");
        let rawVis: unknown = [];
        let hasVisConfig = false;
        if (rawVisSetting) {
          hasVisConfig = true;
          try {
            rawVis = JSON.parse(rawVisSetting);
          } catch {
            rawVis = [];
          }
        }
        const visSet = new Set<string>(Array.isArray(rawVis) ? (rawVis as string[]) : []);
        // 只读列（编号）始终参与定位，但只取它自己的字段；导入列 = 可见∩可写
        let importable = IMPORTABLE_FIELD_ORDER.filter((f) =>
          visSet.has(f.key),
        );
        if (importable.length === 0) {
          if (!hasVisConfig) {
            // 从未配置时兜底为完整可写列（=旧 8 列格式），避免第一次用时只导得进编号
            importable = IMPORTABLE_FIELD_ORDER;
          } else {
            // 用户故意只保留编号 → 不导入任何可写字段，只定位/更新编号本身
            importable = [];
          }
        }
        const importFields = ["code"].concat(
          importable.map((f) => f.key),
        );
        const lines = String(msg.text ?? "").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i].trim();
          if (!raw) {
            continue;
          }
          const parts = raw
            .split(/[,;，；\s]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (parts.length === 0) {
            continue;
          }
          if (HEADER_FIRST_COLUMN_RE.test(parts[0])) {
            continue;
          }
          const rawCode = parts[0];
          const mT = rawCode.match(/[Ll](\d{1,4})/);
          const code = canonicalCode(mT ? `L${mT[1]}` : rawCode);
          if (!code) {
            black.push(`行${i + 1}: ${raw}`);
            continue;
          }
          const exist = db.getProductByCode(code);
          if (exist) {
            const has = (key: string) => {
              const idx = importFields.indexOf(key);
              return idx >= 0 && idx < parts.length;
            };
            const getv = (key: string) => {
              const idx = importFields.indexOf(key);
              return idx >= 0 ? String(parts[idx] ?? "") : "";
            };
            const real = (rawv: string): number | null => {
              const v = Number(rawv);
              return Number.isFinite(v) ? v : null;
            };
            let touched = 0;
            for (const key of ["name", "category", "series", "purchase_link"]) {
              if (has(key)) {
                db.updateProductField(exist.id, key, normText(key as "name" | "category" | "series" | "purchase_link", getv(key)).value);
                touched++;
              }
            }
            const gradeRaw = has("grade") ? real(getv("grade")) : null;
            const costRaw = has("cost_price") ? real(getv("cost_price")) : null;
            const saleRaw = has("sale_price") ? real(getv("sale_price")) : null;
            const gradeOk = gradeRaw !== null && gradeRaw >= 0 && gradeRaw <= 99;
            const costOk = costRaw !== null && costRaw >= 0;
            const gradeChange = gradeOk && gradeRaw !== exist.grade;
            const costChange = costOk && round2(costRaw as number) !== exist.cost_price;
            const effGrade = gradeOk ? (gradeRaw as number) : exist.grade;
            const effCost = costOk ? round2(costRaw as number) : exist.cost_price;
            if (gradeChange) {
              db.updateProductField(exist.id, "grade", gradeRaw);
              touched++;
            }
            if (costChange) {
              db.updateProductField(exist.id, "cost_price", round2(costRaw as number));
              touched++;
            }
            // 售价：填了 >0 → 手动价；否则非自定义且（售价列可见 或 等级/进价有变）→ 按规则重算
            const manualSale = saleRaw !== null && saleRaw > 0 ? round2(saleRaw) : null;
            if (manualSale !== null) {
              db.updateProductField(exist.id, "sale_price", manualSale);
              db.updateProductField(exist.id, "price_manual", 1);
              touched++;
            } else if (
              effGrade !== 0 &&
              (gradeChange ||
                costChange ||
                (importFields.includes("sale_price") && exist.price_manual !== 1))
            ) {
              if (db.ensureRule(effGrade)) {
                log(`ℹ️等级 ${effGrade} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
              }
              const rule = db.getRules().find((r) => r.grade === effGrade);
              const next = calcPrice(effCost, rule);
              if (exist.sale_price !== next || exist.price_manual !== 0) {
                touched++;
              }
              db.updateProductField(exist.id, "sale_price", next);
              db.updateProductField(exist.id, "price_manual", 0);
            }
            if (touched > 0) {
              updated++;
            } else {
              skipped++;
            }
            continue;
          }
          const get = (key: string) => {
            const idx = importFields.indexOf(key);
            return idx >= 0 ? String(parts[idx] ?? "") : "";
          };
          const name = normText("name", get("name")).value || code;
          const category = normText("category", get("category")).value;
          const series = normText("series", get("series")).value;
          const gradeRaw = Math.floor(Number(get("grade") || 1));
          const grade = Number.isFinite(gradeRaw) && gradeRaw >= 0 && gradeRaw <= 99 ? gradeRaw : 1;
          const costRaw = Number(get("cost_price") || 0);
          const cost = Number.isFinite(costRaw) && costRaw >= 0 ? round2(costRaw) : 0;
          const saleRaw = Number(get("sale_price") || 0);
          const link = normText("purchase_link", get("purchase_link")).value;
          const manual = Number.isFinite(saleRaw) && saleRaw > 0 ? round2(saleRaw) : 0;
          const custom = grade === 0;
          if (!custom && db.ensureRule(grade)) {
            log(`ℹ️等级 ${grade} 无规则，已自动创建默认规则（cost*1.5 → +0.88）`);
          }
          const rule = custom
            ? undefined
            : db.getRules().find((r) => r.grade === grade);
          db.addProduct({
            code,
            name: name || code,
            category,
            series,
            grade,
            cost_price: cost,
            sale_price: custom || manual > 0 ? manual : calcPrice(cost, rule),
            price_manual: custom || manual > 0 ? 1 : 0,
            purchase_link: link,
            status: 0,
            remark: "",
            stock_manual: 0,
          });
          created++;
        }
        log(
          `📥商品导入：新增 ${created} 个，更新 ${updated} 个（编号已存在）` +
            (skipped ? `，无变更 ${skipped} 个` : "") +
            (black.length ? `，无法解析 ${black.length} 行` : ""),
        );
        for (const b of black) {
          log(`  ⚠️${b}`);
        }
        ctx.postToWebview({ type: "productsImported", ok: true, created, updated, skipped, bad: black });
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
      case "exportProducts": {
        const dir = await ctx.selectFolder("选择导出目录");
        if (!dir) {
          ctx.postToWebview({ type: "exportCancelled" });
          break;
        }
        try {
          const all = db.getProducts();
          let list = all;
          if (Array.isArray(msg.codes) && msg.codes.length) {
            const byCode = new Map(all.map((p) => [p.code, p]));
list = (msg.codes as string[])
              .map((code) => byCode.get(code))
              .filter((p): p is Product => !!p);
          }
          const stockTotals = db.getStockTotals();
          const saleTotals = db.getSaleTotals();
          const gradeLabel = new Map(
            db.getRules().map((r) => [String(r.grade), r.label || `等级${r.grade}`]),
          );
          let rawVis: unknown;
          try {
            rawVis = JSON.parse(String(getSetting("col_visible_list") || "[]"));
          } catch {
            rawVis = [];
          }
          const vis = new Set<string>(Array.isArray(rawVis) ? (rawVis as string[]) : []);
          let cols = PRODUCT_FIELD_ORDER.filter((f) => vis.has(f.key));
          if (cols.length === 0) {
            cols = [{ key: "code", label: "编号" }];
          }
          const valOf = (p: Product, key: string): any => {
            const sale = saleTotals.get(p.id) || { sold: 0, refund: 0 };
            switch (key) {
              case "grade":
                return gradeLabel.get(String(p.grade)) || `等级${p.grade}`;
              case "status":
                return p.status === 1 ? "已下架" : "在售";
              case "netTotal":
                return sale.sold - sale.refund;
              case "stockTotal":
                return stockTotals.get(p.id) || 0;
              case "soldTotal":
                return sale.sold;
              case "cost_price":
              case "sale_price":
                return Number((p as any)[key] ?? 0);
              default:
                return (p as any)[key] ?? "";
            }
          };
          const aoa: any[][] = [cols.map((c) => c.label)];
          for (const p of list) {
            aoa.push(cols.map((c) => valOf(p, c.key)));
          }
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "商品清单");
          const outFile = path.join(dir, `商品清单_${fileStamp()}.xlsx`);
          await fs.promises.writeFile(outFile, XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
          log(`✅商品清单已导出（${list.length}条）：${outFile}`);
          ctx.postToWebview({
            type: "exportDone",
            kind: "products",
            path: outFile,
            count: list.length,
            filtered: msg.filtered ? 1 : 0,
          });
        } catch (err: any) {
          log(`❌导出商品清单失败：${err.message}`);
          ctx.postToWebview({ type: "dbOpError", message: `导出商品失败：${err.message}` });
        }
        break;
      }
      case "exportSales": {
        const dir = await ctx.selectFolder("选择导出目录");
        if (!dir) {
          ctx.postToWebview({ type: "exportCancelled" });
          break;
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
          ctx.postToWebview({
            type: "exportDone",
            kind: "sales",
            path: outFile,
            count: rows.length,
          });
        } catch (err: any) {
          log(`❌导出销售流水失败：${err.message}`);
          ctx.postToWebview({ type: "dbOpError", message: `导出销售失败：${err.message}` });
        }
        break;
      }
      case "exportSettles": {
        const dir = await ctx.selectFolder("选择导出目录");
        if (!dir) {
          ctx.postToWebview({ type: "exportCancelled" });
          break;
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
          ctx.postToWebview({
            type: "exportDone",
            kind: "settles",
            path: outFile,
            count: settles.length,
          });
        } catch (err: any) {
          log(`❌导出月度结算失败：${err.message}`);
          ctx.postToWebview({ type: "dbOpError", message: `导出月报失败：${err.message}` });
        }
        break;
      }
      case "exportLivePlan": {
        const dir = await ctx.selectFolder("选择导出目录");
        if (!dir) {
          ctx.postToWebview({ type: "exportCancelled" });
          break;
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
          ctx.postToWebview({
            type: "exportDone",
            kind: "live",
            path: outFile,
            count: plan.length,
          });
        } catch (err: any) {
          log(`❌导出排品清单失败：${err.message}`);
          ctx.postToWebview({ type: "dbOpError", message: `导出排品失败：${err.message}` });
        }
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
          await preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log);
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
      case "revealFile": {
        try {
          const fp = String(msg.path ?? "");
          if (fp) {
            await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fp));
          }
        } catch (err: any) {
          log(`❌定位文件失败：${err.message}`);
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

