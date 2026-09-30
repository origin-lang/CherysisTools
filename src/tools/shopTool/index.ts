import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ToolDefinition } from "../../core/toolRegistry.js";
import { getDB, initDB, ShopDB, ShopDBSnapshot } from "./db.js";
import { canonicalCode, fileStamp, todayStr } from "./pricing.js";
import { pruneCodeThumbs, pruneOldThumbs } from "./images.js";
import { resolveImageDir, effectiveImageDir } from "./imageDir.js";
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
// 一次留档最多等这么久。健康时是毫秒级，但共享盘断连时 mkdirSync/backup 会一直挂到
// SMB 超时（几十秒），不能让它把删除、导入甚至面板启动整段卡死。到点就放弃本次留档。
export const BACKUP_TIMEOUT_MS = 5000;
// 留档先写 .tmp、成功才改名。放弃/断连留下的半截文件因此永远顶着 .tmp 后缀，
// 既不会被 pruneBackups 的 .db 配额算进去、也不会被 importDB 的选文件框误选成一份「备份」，
// pruneStaleBackupTmps 再按天回收。
const BACKUP_TMP_SUFFIX = ".tmp";
const BACKUP_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let lastAutoBackupCheckDate = "";
// 旧缩略图清理的日期戳：扫目录按天一次，别每条 webview 消息都重扫
let lastThumbPruneDate = "";
// 图片根目录异常提示只在这个 VS Code 会话里说一次（开关面板不重复刷）
let imageDirWarned = false;
const backupDir = (storageDir: string): string => path.join(storageDir, "backups");

async function backupToDir(storageDir: string, prefix: string): Promise<string | null> {
  try {
    fs.mkdirSync(backupDir(storageDir), { recursive: true });
  } catch {
    return null;
  }
  const file = path.join(backupDir(storageDir), `${prefix}_${fileStamp()}.db`);
  const tmp = `${file}${BACKUP_TMP_SUFFIX}`;
  try {
    await getDB().backupDB(tmp);
  } catch {
    removeQuietly(tmp);
    return null;
  }
  // 改名失败 = 这份留档不可信，宁可没有也别留个半截 .db 冒充备份
  try {
    fs.renameSync(tmp, file);
  } catch {
    removeQuietly(tmp);
    return null;
  }
  return file;
}

function removeQuietly(fp: string): void {
  try {
    fs.unlinkSync(fp);
  } catch {
    // SQLite 正开着这个文件时 Windows 会 EBUSY，清不掉是正常的，交给 pruneStaleBackupTmps 按天回收
  }
}

// 回收残留的 .tmp：超时/断连放弃的留档当场可能删不掉（见 removeQuietly），这里按天兜底扫一次。
function pruneStaleBackupTmps(storageDir: string): void {
  try {
    const dir = backupDir(storageDir);
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(BACKUP_TMP_SUFFIX)) {
        continue;
      }
      const p = path.join(dir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > BACKUP_TMP_MAX_AGE_MS) {
          removeQuietly(p);
        }
      } catch {
        /* 单个 stat 失败就跳过 */
      }
    }
  } catch {
    /* 目录不存在则无事可做 */
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

// 某目录今天是否已留过自动备份：备份文件名 shop_auto_YYYYMMDD_HHMMSS.db（见 fileStamp），
// 命中即跳过。判据落在各人自己可写的目录上，而非共享库——放共享库里会变成「谁先打开谁打戳，
// 别人当天全部跳过」，各机 C 盘的异地备份就再也不会产生。
function hasAutoBackupToday(storageDir: string, stamp: string): boolean {
  const prefix = "shop_auto_";
  try {
    return fs
      .readdirSync(backupDir(storageDir))
      .some(
        (f) =>
          f.startsWith(prefix) && f.slice(prefix.length, prefix.length + 8) === stamp,
      );
  } catch {
    return false;
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

const BACKUP_TIMED_OUT = true;
const BACKUP_FINISHED = false;

/**
 * 给一段留档工作套上时间上限（见 BACKUP_TIMEOUT_MS）。
 * 输掉的那一支不会被取消（SQLite 没有安全的中止点），但它必须 catch 干净：
 * 否则它稍后 reject 会变成 unhandledRejection，把整个扩展宿主掀掉。
 * 返回 false = 在时限内做完（不论成败）；true = 超时放弃。
 * 超时的语义是「这次没留成档」，不是「操作失败」——调用方记完日志要照常往下走。
 * maxMs 仅供测试注入，生产走 BACKUP_TIMEOUT_MS。
 */
export async function withBackupTimeout(
  work: () => Promise<void>,
  maxMs: number = BACKUP_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (async () => {
    try {
      await work();
    } catch {
      /* 具体失败原因由 work 内部自己记日志，这里只保证不外泄 */
    }
  })();
  const outcome = await Promise.race([
    run.then(() => BACKUP_FINISHED),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(BACKUP_TIMED_OUT), maxMs);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
	return outcome === BACKUP_TIMED_OUT;
}

async function maybeAutoBackup(storageDir: string, defaultStorageDir: string, log: (s: string) => void): Promise<void> {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  if (lastAutoBackupCheckDate === stamp) {
    return;
  }
  // 先打戳再干活：超时/失败都不重试，免得共享盘断连时每次开面板都去捶它
  lastAutoBackupCheckDate = stamp;
  const timedOut = await withBackupTimeout(async () => {
    const okFiles: string[] = [];
    const failDirs: string[] = [];
    let skipped = 0;
    try {
      for (const dir of backupTargetDirs(storageDir, defaultStorageDir)) {
        if (hasAutoBackupToday(dir, stamp)) {
          skipped++;
          continue;
        }
        const file = await backupToDir(dir, "shop_auto");
        if (file) {
          okFiles.push(file);
          pruneBackups(dir, "shop_auto_", AUTO_BACKUP_KEEP);
          // 残留 .tmp 跟着每日备份一起收，不在每条消息/每次操作前多扫一遍目录
          pruneStaleBackupTmps(dir);
        } else {
          failDirs.push(dir);
        }
      }
      if (okFiles.length === 0) {
        if (skipped > 0) {
          return;
        }
        log("⚠️每日自动备份失败");
        return;
      }
      if (failDirs.length === 0) {
        log(`✅每日自动备份完成（${okFiles.length} 份）${okFiles.join(" | ")}`);
      } else {
        log(`⚠️每日自动备份部分成功（${failDirs.length} 个目录失败）${okFiles.join(" | ")}`);
      }
    } catch (err: any) {
      log(`⚠️每日自动备份失败：${err.message}`);
    }
  });
  if (timedOut) {
    log(`⚠️每日自动备份超过 ${BACKUP_TIMEOUT_MS / 1000} 秒（共享盘可能断连），已跳过`);
  }
}

async function preOpBackup(storageDir: string, defaultStorageDir: string, log: (s: string) => void): Promise<void> {
  const okFiles: string[] = [];
  const timedOut = await withBackupTimeout(async () => {
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
  });
  if (timedOut) {
    // 关键：留档超时不是操作失败。要撤销就按提示走，跨会话的兜底另有每日自动备份。
    log(`⚠️操作前自动留档超过 ${BACKUP_TIMEOUT_MS / 1000} 秒（共享盘可能断连），已跳过；本次操作仍可撤销`);
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
/** 撤销项额外记下拍照时的 data_version：撤销前发现它变了 = 期间别人提交过，要先确认 */
type UndoItem = { snap: ShopDBSnapshot; desc: string; dv: number };
const undoStack: UndoItem[] = [];
const redoStack: UndoItem[] = [];

// 商品封面 base64 的内存缓存（顺带记下商品图片夹当时的 mtime）。必须放模块级常驻：
// 放进 handleMessage 里等于每个消息一个空 Map，getCover（handlers/image.ts）每次都要重新
// readdir/解码共享盘文件夹，「手动🔄看别人换的图」靠 mtime 的快路径也永远走不到。
// 跨消息常驻后：夹子没被动过 → 一次 statSync 命中即回，不再碰 readdir 和缩略图文件。
const coverCache = new Map<string, { data: string; dirMtime: number }>();

/**
 * 存本机（VS Code globalState，C 盘 state.vscdb）的偏好键。
 *
 * 同一份 shop.db 被多人共享时，下面这些在各人机器上本就该各不相同：
 * 输出目录是别人机器上的路径、字号行高是个人审美、字段显隐是各自的屏幕宽窄、
 * 导入导出勾了哪些列因人而异。存进库里就是「全组一份、最后改的人覆盖所有人」——
 * 你把字号调大，同事那边也跟着变大。（跟当年的 image_dir 一个毛病。）
 *
 * 代价：库里那些旧值从此无人读，留在原处不删（删了反而让「谁改的」无从追溯）。
 *
 * 导出供测试断言用——「个人偏好不进共享库」这条得能测。
 */
export const LOCAL_PREF_KEYS = new Set([
  // 显示
  "row_height",
  "font_size",
  "col_visible_list",
  "col_visible_gallery",
  "col_image_list",
  "col_image_gallery",
  "col_show_ops",
  // 直播排品 / 星标总览
  "live_out_dir",
  "live_grid_label",
  "star_label_options",
  "star_grid_mode",
  "star_grid_cols",
  "star_grid_rows",
  // 导入导出
  "import_fields",
  "import_mode",
  "export_fields",
]);

/** 留在共享库里的设置项：全组共用的业务规则，必须一致，改动要有记录 */
const SHARED_SETTING_KEYS = new Set([
  "name_template",
  "stock_alert",
  "sales_deduct_stock",
]);

/**
 * 只读模式下要拦下的消息类型：一切会写共享库或改共享盘图片的入口。
 *
 * 推荐的用法是「一台机器写，其他机器看」（见 docs/shopTool-manual.md §7.5/§7.6）。
 * 共享盘是 SMB/SQLite：多个人同时写会互抢排他锁，写事务在网络上失败就是
 * `disk I/O error`。所以让读的那几台直接别写，比事后补救便宜得多。
 *
 * 放行的：所有读、🔄 刷新、全部导出、🔄 从备份恢复以外的库操作、
 * 九宫格与星标总览的预览/生成（输出到各人本机的 live_out_dir，不碰库）。
 * 换数据库目录（pickStorageDir）也放行——它只改本机配置，不写库，
 * 而且点错了还需要能换回来。
 */
const WRITE_ACTIONS = new Set([
  // 商品
  "addProduct",
  "updateProductField",
  "setStockQty",
  "deleteProduct",
  "setStatus",
  "saveRules",
  "setProductsStatus",
  "setProductsStock",
  "setProductsField",
  "deleteProducts",
  "addStockIn",
  "delStockIn",
  "commitImportProducts",
  // 销售
  "saveSale",
  "pasteSales",
  "deleteSales",
  "updateSalesField",
  // 结算
  "monthBuild",
  "saveSettle",
  "lockSettle",
  "unlockSettle",
  "deleteSettle",
  // 图片（写共享盘上的图片文件）
  "uploadImages",
  "receiveImageData",
  "clearImages",
  "clearImagesBatch",
  "deleteImageFile",
  "deleteCoverImage",
  // 直播排品（live_plan / live_star 落库）
  "toggleLiveStar",
  "setLiveStars",
  "clearLiveStars",
  "saveLivePlan",
  "clearLivePlan",
  // 撤销 / 重做（整库回退）
  "undoRequest",
  "redoRequest",
  // 从备份恢复 = 整库替换
  "importDB",
]);

/**
 * 丢弃撤销/重做快照。换数据库目录时必须调：快照是「整库 SELECT 出来的行」，
 * 里面存的是旧库的行 id / 主键值，restoreAll 会照着写回当时的表——库换了以后
 * 这些 id 指向的是新库里毫不相干的商品，一撤销就把新库写烂了。
 */
export function resetShopUndoRedo(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

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
      const dir = effectiveImageDir(resolveImageDir(getDB().getSetting("image_dir")));
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
    // 缩略图缓存清理跟着备份触发：都是「本机目录维护」性质，同一处做。
    // 每天只扫一次目录——这条消息每条 webview 消息都会走一遍，重复扫几千个文件会拖慢面板。
    const thumbPruneStamp = todayStr();
    if (thumbPruneStamp !== lastThumbPruneDate) {
      lastThumbPruneDate = thumbPruneStamp;
      pruneOldThumbs(ctx.defaultStorageDir);
    }

    // 图片根目录搬去 VS Code 设置后，面板里那一行是只读展示、不能改；
    // 这里的日志是「打开面板时立刻知道本机配没配/配得对不对」的地方。
    // 只在「没配 / 配了但不可用」时说一次，正常情况不刷屏。改配置的即时反馈走通知（见 extension.ts）。
    if (!imageDirWarned) {
      imageDirWarned = true;
      const img = resolveImageDir(state.current.getSetting("image_dir"));
      if (img.configBroken) {
        log(`⚠本机设置里填的图片根目录不可用，已忽略：${img.dir || "（空）"}（需绝对路径且真实存在）`);
      } else if (!img.dir) {
        log("ℹ尚未设置商品图片根目录，本机无法显示/上传/删除图片。执行命令「Cherysis:设置商品图片根目录」设置一次。");
      } else if (!img.valid) {
        log(`⚠商品图片根目录不可用：${img.dir}（可能是别人机器上的路径，或共享盘没挂上/被改名）`);
      }
    }

    if (!codeMigrated) {
      codeMigrated = true;
      try {
        for (const p of state.current.getProducts()) {
          const padded = canonicalCode(p.code);
          if (padded && padded !== p.code) {
            state.current.updateProductField(p.id, "code", padded);
          }
        }
        const dir = effectiveImageDir(resolveImageDir(state.current.getSetting("image_dir")));
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

    /**
     * 设置项读入口：17 个个人偏好键读本机 globalState，其余读共享库。
     * 各 handler 一律走这里（或 h.getSetting），别再直接 db.getSetting，
     * 否则会绕过这道分流、又写/读到共享盘上去。
     */
    const getSetting = (key: string): string => {
      if (LOCAL_PREF_KEYS.has(key)) {
        const v = ctx.prefs.get(key, "");
        return v === undefined || v === null ? "" : String(v);
      }
      return state.current.getSetting(key);
    };
    /** 设置项写入口，与 getSetting 同一套分流。本机键落 globalState，不碰共享盘 */
    const setSetting = async (key: string, value: string): Promise<void> => {
      if (LOCAL_PREF_KEYS.has(key)) {
        await ctx.prefs.update(key, value);
        return;
      }
      state.current.setSetting(key, value);
    };
    /** 本机只读开关：true 时 WRITE_ACTIONS 里那些消息一律不执行（见顶部注释） */
    const readOnly = (): boolean => ctx.prefs.get<boolean>("readOnly", false) === true;

    // 图片根目录走 imageDir.ts：本机 VS Code 设置优先，库里旧值只作回落。
    // 各 handler 统一用 h.imageDir()，别再直接读 image_dir，否则会绕过解析。
    // 再经 effectiveImageDir 过滤：路径不可用时给空串，让上层按「没配」处理，而不是拼出一串 ENOENT 路径。
    const imageDir = (): string => effectiveImageDir(resolveImageDir(getSetting("image_dir")));
    const stockAlert = (): number => {
      const v = Number(getSetting("stock_alert") || 0);
      return Number.isFinite(v) ? v : 0;
    };

    // 商品封面用 base64 按需下发（放大看图的大图另走 webview 资源 URI，见 handlers/image.ts）。
    // 缩略图磁盘缓存在本机 defaultStorageDir，改编号/删图时按编号前缀一次删净。
    // 内存那份 coverCache 是模块级常驻（见文件顶部），此处的 invalidateCover 只负责
    // 按编号清一条 + 清本机缩略图文件 + 通知前端该编号封面作废。
    const invalidateCover = (code: string) => {
      coverCache.delete(code);
      pruneCodeThumbs(ctx.defaultStorageDir, code);
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

    // 改商品编号时把图片文件夹一并改名，作为「改号是否保存」的前置条件（原子化）：
    // 文件夹没搬成 → 返回 conflict/error，调用方应取消本次改号（图片不能滞留在旧编号下）。
    // 三档护栏（绝不删/合并真实图片）：
    // 1) 旧夹不存在 → noop（本就无图）；2) 目标不存在 → 整夹改名 → moved；3) 目标为空 → 拆壳再挪 → moved；
    // 目标非空 → conflict（两边都不动，弹窗+日志强提示）；改名本身失败 → error。
    const renameImageFolder = (
      fromCode: string,
      toCode: string,
    ): "moved" | "noop" | "conflict" | "error" => {
      if (!fromCode || !toCode || fromCode === toCode) {
        return "noop";
      }
      const dir = imageDir();
      if (!dir) {
        // 未配置图片根目录 = 无商品图片文件夹可搬，视为 noop（允许改号）
        return "noop";
      }
      const from = path.join(dir, fromCode);
      const to = path.join(dir, toCode);
      if (!fs.existsSync(from)) {
        return "noop";
      }
      if (fs.existsSync(to)) {
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(to);
        } catch {
          entries = [];
        }
        if (entries.length === 0) {
          try {
            fs.rmdirSync(to);
          } catch (err: any) {
            log(`⚠️目标空文件夹 ${to} 删除失败，跳过图片文件夹改名（${err?.message ?? err}）`);
            return "error";
          }
        } else {
          log(`⚠️⚠️编号 ${fromCode} → ${toCode} 改号取消：${toCode} 已有图片文件夹（${entries.length} 项），为避免合并/覆盖图片，本次改号未保存；请先清空 ${toCode} 文件夹后再改`);
          ctx.postToWebview({
            type: "alert",
            title: "改号未保存：图片文件夹冲突",
            text:
              `商品编号 ${fromCode} → ${toCode} 未保存：${toCode} 已存在图片文件夹（${entries.length} 项内容），为避免合并/覆盖图片，本次改号已取消。` +
              `\n\n请先清空 ${toCode} 文件夹（或把里面的内容移走），然后把编号重新改成 ${toCode}，图片文件夹就会自动同步。`,
          });
          return "conflict";
        }
      }
      try {
        fs.renameSync(from, to);
      } catch (err: any) {
        log(`⚠️图片文件夹改名失败 ${from} → ${to}（${err?.message ?? err}）；本次改号已取消，图片需手工迁移`);
        return "error";
      }
      invalidateCover(fromCode);
      // 夹内以旧编号_ 开头的文件名同步改成新编号前缀，保持「文件夹内容=新编号」一致；
      // 只碰字面前缀命中的直接文件，原始文件名/子目录不动；撞名或占用只记日志，不中断。
      let renamedFiles = 0;
      const fromPrefix = `${fromCode}_`;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(to, { withFileTypes: true });
      } catch (err: any) {
        log(`⚠️读取 ${to} 失败，跳过夹内文件名同步（${err?.message ?? err}）`);
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.startsWith(fromPrefix)) {
          continue;
        }
        const nextName = toCode + e.name.slice(fromCode.length);
        const nextPath = path.join(to, nextName);
        if (fs.existsSync(nextPath)) {
          log(`⚠️夹内文件名同步跳过：${to}\\${nextName} 已存在（${e.name} 保持原名）`);
          continue;
        }
        try {
          fs.renameSync(path.join(to, e.name), nextPath);
          renamedFiles++;
        } catch (err: any) {
          log(`⚠️夹内文件名同步失败：${e.name}（${err?.message ?? err}）`);
        }
      }
      log(
        `🖼图片文件夹已随改号改名：${fromCode} → ${toCode}` +
          (renamedFiles ? `，夹内 ${renamedFiles} 个前缀文件名已同步` : ""),
      );
      return "moved";
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
    const currentDataVersion = (): number => {
      try {
        return state.current.dataVersion();
      } catch {
        return -1;
      }
    };
    const pushUndo = (snap: ShopDBSnapshot, desc: string) => {
      undoStack.push({ snap, desc, dv: currentDataVersion() });
      if (undoStack.length > UNDO_LIMIT) {
        undoStack.shift();
      }
      // 产生新改动即作废重做分支
      redoStack.length = 0;
      postUndoState();
    };

    /**
     * 撤销/重做是「整库回退到某个快照」，所以快照之后任何人（别的机器）提交的改动都会被一起抹掉。
     * 快照上记了拍照时的 data_version：撤销前发现它变了，就说明期间有别人提交过，先问一句。
     * 一个人写的时候它不会变，所以这个确认框正常情况下根本不出现；两个以上的人写才会响。
     */
    const confirmExternalWrite = async (item: UndoItem | undefined, verb: string): Promise<boolean> => {
      if (!item || item.dv < 0) {
        return true;
      }
      const now = currentDataVersion();
      if (now < 0 || now === item.dv) {
        return true;
      }
      return ctx.confirm(
        `${verb}：${item.desc}`,
        `你按下这个操作之后，数据库被别的机器改过。${verb}会把整库回退到那次改动之前，`
          + `期间别人提交的内容会一起被撤掉。\n\n`
          + `如果这几秒里只有你一个人在写，看到这个提示说明状态判断异常，可以直接确定。`,
      );
    };

    const refreshAfterRestore = () => {
      h.loadAll();
      h.refreshSales(todayStr());
      h.postStockIns();
    };

    // 面板里那一行只读展示用：当前库路径 + shop.db 大小/最后修改时间。
    // stat 拿不到就报 undefined，前端显示「（未创建）」——共享盘没挂上时别假装正常。
    const dbFileStat = (): { size: number; mtimeMs: number } | null => {
      try {
        const st = fs.statSync(path.join(ctx.storageDir, "shop.db"));
        return { size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    };

    const loadAll = () => {
      // 共享库那边一次读出 settings 全表：原来这里连着 16 次 getSetting，
      // 在共享盘上就是 16 次网络往返。本机偏好从 globalState 读，不占往返。
      const cfg = state.current.getSettingsMap();
      const setting = (k: string): string => cfg[k] ?? "";
      /** 本机偏好：没设过就给 def（各调用点自己带默认值） */
      const pref = (k: string, def = ""): string => {
        const v = ctx.prefs.get(k, def);
        return v === undefined || v === null ? def : String(v);
      };
      ctx.postToWebview({
        type: "productsLoaded",
        products: state.current.getProductsWithTotals(),
        stockAlert: stockAlert(),
      });
      ctx.postToWebview({ type: "rulesLoaded", rules: state.current.getRules() });
      ctx.postToWebview({
        type: "settingsLoaded",
        // 本机只读开关（存 globalState）：放在 settings 外面，它是模式不是设置项
        readOnly: readOnly(),
        settings: {
          // —— 共享库：全组共用的业务规则 ——
          name_template: setting("name_template"),
          stock_alert: stockAlert(),
          sales_deduct_stock: setting("sales_deduct_stock") || "1",
          // —— 本机偏好：globalState，各人各设，不写共享盘 ——
          row_height: pref("row_height", "8"),
          font_size: pref("font_size", "13"),
          col_visible_list: pref("col_visible_list"),
          col_visible_gallery: pref("col_visible_gallery"),
          col_image_list: pref("col_image_list"),
          col_image_gallery: pref("col_image_gallery"),
          col_show_ops: pref("col_show_ops", "1"),
          live_grid_label: pref("live_grid_label"),
          // 以前从没下发过，前端却在 starOvOpenMask 里读它 → 存下的标注选项永远回填不进去
          star_label_options: pref("star_label_options"),
          import_fields: pref("import_fields"),
          import_mode: pref("import_mode"),
          export_fields: pref("export_fields"),
          // 只读展示用，不进 allowedKeys：路径是本机/全组的环境配置，不该被面板改写
          db_path: ctx.storageDir,
          db_stat: dbFileStat(),
        },
      });
      ctx.postToWebview({ type: "settlesLoaded", settles: state.current.getSettleMonths() });
      postLiveState();
      postUndoState();
    };

    /** 只切本机偏好用：只回 17 个本机键，不触发整库重载（共享盘上那是几十次网络往返） */
    const postLocalPrefs = () => {
      const pref = (k: string, def = ""): string => {
        const v = ctx.prefs.get(k, def);
        return v === undefined || v === null ? def : String(v);
      };
      ctx.postToWebview({
        type: "localPrefsLoaded",
        settings: {
          row_height: pref("row_height", "8"),
          font_size: pref("font_size", "13"),
          col_visible_list: pref("col_visible_list"),
          col_visible_gallery: pref("col_visible_gallery"),
          col_image_list: pref("col_image_list"),
          col_image_gallery: pref("col_image_gallery"),
          col_show_ops: pref("col_show_ops", "1"),
          live_grid_label: pref("live_grid_label"),
          star_label_options: pref("star_label_options"),
          import_fields: pref("import_fields"),
          import_mode: pref("import_mode"),
          export_fields: pref("export_fields"),
        },
      });
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
      setSetting,
      readOnly,
      localPrefKey: (key: string) => LOCAL_PREF_KEYS.has(key),
      postLocalPrefs,
      imageDir,
      coverCache,
      invalidateCover,
      removeImageFolder,
      renameImageFolder,
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
      async undoRequest() {
        if (undoStack.length === 0) {
          log("⚠没有可撤销的操作");
          postUndoState();
          return;
        }
        if (!(await confirmExternalWrite(undoStack[undoStack.length - 1], "撤销"))) {
          log("↪ 已取消撤销");
          return;
        }
        const item = undoStack.pop() as UndoItem;
        try {
          // 把当前状态压入重做栈，之后可「重做」抵销这次撤销
          redoStack.push({ snap: state.current.snapshotAll(), desc: item.desc, dv: currentDataVersion() });
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

      async redoRequest() {
        if (redoStack.length === 0) {
          log("⚠没有可重做的操作");
          postUndoState();
          return;
        }
        if (!(await confirmExternalWrite(redoStack[redoStack.length - 1], "重做"))) {
          log("↪ 已取消重做");
          return;
        }
        const item = redoStack.pop() as UndoItem;
        try {
          // 重新执行后，当前状态也压入撤销栈，可再「撤销」回退到这里
          undoStack.push({ snap: state.current.snapshotAll(), desc: item.desc, dv: currentDataVersion() });
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
    // 只读闸门：整个分发的唯一入口，在这里拦。前端把写按钮灰显只是给人看的，
    // 这里是真正不执行 —— 共享盘上多机同写会互抢排他锁，写事务在网络上失败
    // 就是那句 `disk I/O error`（见顶部 WRITE_ACTIONS 注释）。
    if (readOnly()) {
      // saveSettings 一条消息带一个键：共享规则拦，本机偏好放行（只读机照样能调自己的字号/字段显隐）
      const blocked =
        WRITE_ACTIONS.has(msg.type)
        || (msg.type === "saveSettings" && SHARED_SETTING_KEYS.has(String(msg.key ?? "")));
      if (blocked) {
        log("🔒 只读模式：这一步会写共享库，已拦下。要改数据请先在顶栏点 🔓 解除只读");
        return;
      }
    }
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