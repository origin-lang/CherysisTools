import { ToolContext } from "../../../core/toolContext.js";
import { ShopDB, ShopDBSnapshot } from "../db.js";

export type Handler = (msg: any, h: HandlerCtx) => Promise<void> | void;

/** 商品店铺管理消息处理器运行上下文：由 index.ts 装配，各域 handler 共享 */
export interface HandlerCtx {
  ctx: ToolContext;
  /** 当前数据库连接（importDB 恢复后经 setDB 替换） */
  db: ShopDB;
  setDB: (d: ShopDB) => void;
  log: (s: string) => void;
  post: (m: any) => void;
  /** 读设置项：个人偏好键自动走本机 globalState，其余读共享库（分流见 index.ts LOCAL_PREF_KEYS） */
  getSetting: (key: string) => string;
  /** 写设置项，与 getSetting 同一套分流。本机键落 globalState、不碰共享盘，故为异步 */
  setSetting: (key: string, value: string) => Promise<void>;
  /** 本机只读开关：true 时一切写共享库/改共享盘图片的操作都不该执行 */
  readOnly: () => boolean;
  /** 该键是否为个人偏好（走 globalState）而非共享业务规则 */
  localPrefKey: (key: string) => boolean;
  /** 只把 17 个本机偏好键回推前端（不触发整库重载） */
  postLocalPrefs: () => void;
  /** 生效的商品图片根目录：本机 VS Code 设置优先，回落共享库里的旧值（解析见 ../imageDir.ts） */
  imageDir: () => string;
  /**
   * 商品封面 base64 按需下发缓存（image/getCover 读写，product 删除时作废）。
   * 带 dirMtime：命中时先 stat 一下商品图片文件夹的 mtime，对得上才直接复用，
   * 对不上说明别人往这个编号的夹里放过/删过图，必须重取（见 image.ts getCover）。
   */
  coverCache: Map<string, { data: string; dirMtime: number }>;
  invalidateCover: (code: string) => void;
  removeImageFolder: (code: string) => boolean;
  /** 改商品编号时把图片文件夹也一并改名（原子化前置：冲突/失败返回 error，调用方应取消本次改号）；无旧夹则 noop */
  renameImageFolder: (
    fromCode: string,
    toCode: string,
  ) => "moved" | "noop" | "conflict" | "error";
  /** 全量刷新前端（初始加载/恢复数据库后使用） */
  loadAll: () => void;
  /** 差量下发更动/删除的商品行（替代高频操作后的全量刷新） */
  postProductsDelta: (ids: number[], removed?: number[]) => void;
  refreshSales: (date: string) => void;
  postStockIns: () => void;
  postLiveState: () => void;
  preOpBackup: () => Promise<void>;
  /** 抓取当前整库快照（改动「之前」的状态） */
  snapshot: () => ShopDBSnapshot;
  /** 改动成功后提交撤销记录（同时作废重做分支、回推按钮可用性） */
  pushUndo: (snap: ShopDBSnapshot, desc: string) => void;
  /** 清空撤销/重做栈（整库恢复后调用，栈里的快照对不上新库） */
  resetUndo: () => void;
  /**
   * 把"要跑一会儿的活儿"交给宿主（生成共享缩略图 / 生成九宫格）。
   * 装配在 index.ts：宿主实现了就转发给它（网页版=服务端队列），没实现就立刻跑 + 错误进日志。
   * **可选**：测试里那些手写的假 ctx 没有它，靠 runLongTask 兜底。
   * 返回"等它跑完"的 Promise（VS Code）或立刻返回（网页版排队）。
   */
  longTask?: (name: string, run: () => Promise<void>) => void | Promise<void>;
}

/**
 * 长活儿的**唯一入口**：handler 只调这个，别自己 `void xxx()` 开跑。
 *
 * 三档行为，一处收口：
 * - 宿主实现了 `longTask` → 转发。VS Code = 立刻跑（返回"跑完"的 Promise）；
 *   网页版 = 进服务端队列、立刻返回（`/api/invoke` 不阻塞，进度走 SSE）。
 * - 没实现（测试里手写的假 ctx、将来别的宿主）→ **立刻跑并返回它的 Promise**，
 *   与加这个接缝之前的行为一字不差（包括"想等的调用方 await 得到跑完"）。
 */
export function runLongTask(
  h: HandlerCtx,
  name: string,
  run: () => Promise<void>,
): void | Promise<void> {
  return h.longTask ? h.longTask(name, run) : run();
}