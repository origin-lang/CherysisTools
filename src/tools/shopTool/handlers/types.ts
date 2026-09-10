import { ToolContext } from "../../../core/toolContext.js";
import { ShopDB } from "../db.js";

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
  imageDir: () => string;
  /** 商品封面 base64 按需下发缓存（image/getCover 读写，product 删除时作废） */
  coverCache: Map<string, string>;
  invalidateCover: (code: string) => void;
  removeImageFolder: (code: string) => boolean;
  /** 全量刷新前端（初始加载/恢复数据库后使用） */
  loadAll: () => void;
  /** 差量下发更动/删除的商品行（替代高频操作后的全量刷新） */
  postProductsDelta: (ids: number[], removed?: number[]) => void;
  refreshSales: (date: string) => void;
  postStockIns: () => void;
  postLiveState: () => void;
  preOpBackup: () => Promise<void>;
}