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
  getSetting: (key: string) => string;
  /** 生效的商品图片根目录：本机 VS Code 设置优先，回落共享库里的旧值（解析见 ../imageDir.ts） */
  imageDir: () => string;
  /** 商品封面 base64 按需下发缓存（image/getCover 读写，product 删除时作废） */
  coverCache: Map<string, string>;
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
}