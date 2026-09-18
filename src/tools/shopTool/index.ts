import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ToolDefinition } from "../../core/toolRegistry.js";
import { ToolContext } from "../../core/toolContext.js";
import { getDB, initDB, ShopDB, ShopDBSnapshot } from "./db.js";
import { canonicalCode, fileStamp, todayStr } from "./pricing.js";
import { coverThumbCachePaths } from "./images.js";
import { Handler, HandlerCtx } from "./handlers/types.js";
import { productHandlers } from "./handlers/product.js";
import { salesHandlers } from "./handlers/sales.js";
import { settleHandlers } from "./handlers/settle.js";
import { imageHandlers } from "./handlers/image.js";
import { impexpHandlers } from "./handlers/impexp.js";
import { liveHandlers } from "./handlers/live.js";
import { settingsHandlers } from "./handlers/settings.js";

// 自动备份：每日首次启动自动留档（shop_auto_*），破坏性操作前追加留档（shop_pre_*）；两类各自独立配额剪除，只保留最新 N 份，不无限累积。
const AUTO_BACKUP_KEEP = 14;
const PRE_BACKUP_KEEP = 20;
let lastAutoBackupCheckDate = "";
const backupDir = (storageDir: string): string => path.join(storageDir, "backups");

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

// 撤销/重做快照栈（仅内存，面板重开/网页重载即清）：每条 = 某次改动「之前」的整库快照 + 动作描述
const UNDO_LIMIT = 20;
const REDO_LIMIT = 20;
const undoStack: Array<{ snap: ShopDBSnapshot; desc: string }> = [];
const redoStack: Array<{ snap: ShopDBSnapshot; desc: string }> = [];

export const shopTool: ToolDefinition = {
  toolName: "shopTool",
  category: "system",
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
    const state: { current: ShopDB } = { current: getDB() };

    await maybeAutoBackup(ctx.storageDir, ctx.defaultStorageDir, log);

    if (!codeMigrated) {
      codeMigrated = true;
      try {
        for (const p of state.current.getProducts()) {
          const padded = canonicalCode(p.code);
          if (padded && padded !== p.code) {
            state.current.updateProductField(p.id, "code", padded);
          }
        }
        const dir = String(state.current.getSetting("image_dir") || "").trim();
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

    const getSetting = (key: string): string => state.current.getSetting(key);
    const imageDir = (): string => String(getSetting("image_dir") || "").trim();
    const stockAlert = (): number => {
      const v = Number(getSetting("stock_alert") || 0);
      return Number.isFinite(v) ? v : 0;
    };

    // 商品封面用 base64 按需下发（与放大看图的 lightbox 同一机制），
    // 不依赖 webview 资源白名单，任意图片目录、上传/清空后都能即时生效
    const coverCache = new Map<string, string>();
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

    const postLiveState = () => {
      ctx.postToWebview({
        type: "liveState",
        stars: state.current.getLiveStars(),
        plan: state.current.getLivePlan(),
        outDir: getSetting("live_out_dir"),
      });
    };

    // 撤销/重做可用性回推（前端据此控制按钮灰显）
    const postUndoState = (restored = false) => {
      ctx.postToWebview({
        type: "undoState",
        undoAvailable: undoStack.length > 0,
        redoAvailable: redoStack.length > 0,
        restored,
      });
    };

    // 改动成功后推进撤销栈（失败的路由到 handleMessage 顶部统一报错，不污染栈）
    const pushUndo = (snap: ShopDBSnapshot, desc: string) => {
      undoStack.push({ snap, desc });
      if (undoStack.length > UNDO_LIMIT) {
        undoStack.shift();
      }
      // 产生新改动即作废重做分支
      redoStack.length = 0;
      postUndoState();
    };

    const refreshAfterRestore = () => {
      h.loadAll();
      h.refreshSales(todayStr());
      h.postStockIns();
    };

    const loadAll = () => {
      ctx.postToWebview({
        type: "productsLoaded",
        products: state.current.getProductsWithTotals(),
        stockAlert: stockAlert(),
      });
      ctx.postToWebview({ type: "rulesLoaded", rules: state.current.getRules() });
      ctx.postToWebview({
        type: "settingsLoaded",
        settings: {
          image_dir: imageDir(),
          name_template: getSetting("name_template"),
          stock_alert: stockAlert(),
          sales_deduct_stock: String(getSetting("sales_deduct_stock") || "1"),
          row_height: String(getSetting("row_height") || "8"),
          font_size: String(getSetting("font_size") || "13"),
          col_visible_list: getSetting("col_visible_list"),
          col_visible_gallery: getSetting("col_visible_gallery"),
          col_image_list: getSetting("col_image_list"),
          col_image_gallery: getSetting("col_image_gallery"),
          import_fields: getSetting("import_fields"),
          import_mode: getSetting("import_mode"),
          export_fields: getSetting("export_fields"),
        },
      });
      ctx.postToWebview({ type: "settlesLoaded", settles: state.current.getSettleMonths() });
      postLiveState();
      postUndoState();
    };

    const postProductsDelta = (ids: number[], removed: number[] = []) => {
      ctx.postToWebview({
        type: "productsDelta",
        products: state.current.getProductsWithTotals(ids),
        removed,
      });
    };

    // 各域 handler 共享的运行上下文：h.db 为 getter，始终指向当前连接，
    // importDB 恢复旧库后经 setDB 整体切换，读写错误或不一致都落在同一处。
    const h: HandlerCtx = {
      ctx,
      get db() {
        return state.current;
      },
      setDB(d) {
        state.current = d;
      },
      log,
      post: (m) => ctx.postToWebview(m),
      getSetting,
      coverCache,
      invalidateCover,
      removeImageFolder,
      loadAll,
      postProductsDelta,
      refreshSales: (date) =>
        ctx.postToWebview({
          type: "salesLoaded",
          date,
          sales: state.current.getSales(date),
        }),
      postStockIns: () =>
        ctx.postToWebview({
          type: "stockInsLoaded",
          rows: state.current.getStockIns(),
        }),
      postLiveState,
      preOpBackup: () => preOpBackup(ctx.storageDir, ctx.defaultStorageDir, log),
      snapshot: () => state.current.snapshotAll(),
      pushUndo,
      resetUndo: () => {
        undoStack.length = 0;
        redoStack.length = 0;
        postUndoState();
      },
    };

    // 表驱动分发：单一入口，按消息类型路由到对应域的 handler。
    const handlers: Record<string, Handler> = {
      ...settingsHandlers(h),
      ...productHandlers(h),
      ...salesHandlers(h),
      ...imageHandlers(h),
      ...settleHandlers(h),
      ...liveHandlers(h),
      ...impexpHandlers(h),

      // ===== 撤销 / 重做 =====
      undoRequest() {
        const item = undoStack.pop();
        if (!item) {
          log("⚠没有可撤销的操作");
          postUndoState();
          return;
        }
        try {
          // 把当前状态压入重做栈，之后可「重做」抵销这次撤销
          redoStack.push({ snap: state.current.snapshotAll(), desc: item.desc });
          if (redoStack.length > REDO_LIMIT) {
            redoStack.shift();
          }
          state.current.restoreAll(item.snap);
          log(`↩ 已撤销：${item.desc}`);
        } catch (err: any) {
          undoStack.push(item);
          log(`❌撤销失败：${err.message}`);
        }
        refreshAfterRestore();
        postUndoState(true);
      },

      redoRequest() {
        const item = redoStack.pop();
        if (!item) {
          log("⚠没有可重做的操作");
          postUndoState();
          return;
        }
        try {
          // 重新执行后，当前状态也压入撤销栈，可再「撤销」回退到这里
          undoStack.push({ snap: state.current.snapshotAll(), desc: item.desc });
          if (undoStack.length > UNDO_LIMIT) {
            undoStack.shift();
          }
          state.current.restoreAll(item.snap);
          log(`↪ 已重做：${item.desc}`);
        } catch (err: any) {
          redoStack.push(item);
          log(`❌重做失败：${err.message}`);
        }
        refreshAfterRestore();
        postUndoState(true);
      },
    };
    const fn = handlers[msg.type];
    if (!fn) {
      log(`❌未处理的消息类型:${msg.type}`);
      return;
    }
    try {
      await fn(msg, h);
    } catch (err: any) {
      const text = String(err?.message ?? err ?? "未知错误");
      log(`❌操作失败：${text}`);
      ctx.postToWebview({ type: "dbOpError", message: text });
    }
  },
};