import * as fs from "fs";
import * as path from "path";
// 只导入类型：@types/vscode 提供类型，编译后不产生 require（服务端进程里没有 vscode 模块）
import type * as vscode from "vscode";
import type { ToolContext } from "../core/toolContext.js";
import type { ServerConfig } from "./config.js";

/**
 * 网页版这一侧的宿主实现：handler 只认 ToolContext，这里把它接到 HTTP 上。
 *
 * 与 VS Code 宿主逐条对应：
 *   postToWebview → 收进本次请求的 posts 数组，随 /api/invoke 的响应回到浏览器
 *   log           → 收进本次请求的 logs 数组（前端自己插进日志区）
 *   prefs         → 服务端的一个 JSON 文件（本机偏好；浏览器自己的布局偏好在 localStorage）
 *   imageUrl      → 该文件在本服务上的图片地址
 *   revealInOS    → 做不到，改成把路径写进日志（用户自己按路径去找）
 *   selectFolder/selectFile/selectFiles → 浏览器不允许列服务器目录，一律拒绝并说明
 *   confirm/chooseAction → 网页版这一版没有对话框通道，一律「否/取消」并说明
 *                          （所以手机版只做不需要确认框的动作：新建/改字段/改库存/上下架/上传图）
 */

/** 一次请求收集到的东西：posts 按序回给浏览器，logs 进日志区 */
export type HostSink = { posts: any[]; logs: string[] };

/** 服务端本机偏好：一个 JSON 文件，读写都在这里，进程内加一层缓存 */
export class PrefsStore {
  private cache: Record<string, unknown> | null = null;

  constructor(private readonly file: string) {}

  private load(): Record<string, unknown> {
    if (this.cache) {
      return this.cache;
    }
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Record<string, unknown>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  get<T>(key: string, def: T): T {
    const v = this.load()[key];
    return v === undefined || v === null ? def : (v as T);
  }

  update(key: string, value: unknown): void {
    const all = this.load();
    all[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(all, null, 2), "utf-8");
    } catch {
      /* 写不进去也不该把业务带崩：下次重启退回文件里的旧值 */
    }
  }

  /** vscode.Memento 要求有 keys()，补上（服务端用不到，但接口要齐） */
  keys(): string[] {
    return Object.keys(this.load());
  }
}

export function createHttpHost(
  cfg: ServerConfig,
  sink: HostSink,
  prefs: PrefsStore,
): ToolContext {
  const note = (text: string): void => {
    sink.logs.push(text);
  };

  return {
    // 服务端没有面板；这两个字段只是类型占位（handler 已不直接碰它们——
    // 图片地址走 imageUrl，见 src/core/toolContext.ts 的注释）
    panel: {} as unknown as vscode.WebviewPanel,
    extensionUri: {} as unknown as vscode.Uri,

    storageDir: cfg.storageDir,
    // 服务端的「本机目录」就是 cacheDir：缩略图缓存与偏好都放这儿，绝不指向共享盘
    defaultStorageDir: cfg.cacheDir,
    prefs: {
      // vscode.Memento 的 get 是两个重载（带/不带默认值），这里用一个可选默认值同时满足两者
      get<T>(key: string, def?: T): T | undefined {
        return prefs.get<T | undefined>(key, def);
      },
      update(key: string, value: unknown): Promise<void> {
        prefs.update(key, value);
        return Promise.resolve();
      },
      keys(): readonly string[] {
        return prefs.keys();
      },
    },

    postToWebview(msg: any) {
      sink.posts.push(msg);
    },
    log(text: string) {
      sink.logs.push(text);
    },

    async selectFolder(): Promise<string | undefined> {
      note("ℹ️网页版没有「选择本机文件夹」这个能力（浏览器不允许列服务器目录）：目录请在服务端配置里指定");
      return undefined;
    },
    async selectFile(): Promise<string | undefined> {
      note("ℹ️网页版不能选服务器上的文件：请改用上传");
      return undefined;
    },
    async selectFiles(): Promise<string[]> {
      note("ℹ️网页版不能选服务器上的文件：请改用上传（手机可直接拍照）");
      return [];
    },
    async confirm(message: string, detail?: string): Promise<boolean> {
      note(`ℹ️网页版这一版没有确认框通道，已按「取消」处理：${message}${detail ? `（${detail}）` : ""}`);
      return false;
    },
    async chooseAction(message: string): Promise<string | undefined> {
      note(`ℹ️网页版这一版没有对话框通道，已按「取消」处理：${message}`);
      return undefined;
    },

    /**
     * 本机文件路径 → 本服务的图片地址。
     * 只接受图片根目录**里面**的文件（`..` 逃出去的一律不给地址），
     * 与服务端 /api/image 的校验是同一条规矩。
     */
    imageUrl(fp: string): string {
      if (!cfg.imageDir) {
        return "";
      }
      const rel = path.relative(cfg.imageDir, fp);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        return "";
      }
      const parts = rel.split(path.sep);
      const code = parts.shift() || "";
      const name = parts.join("/");
      return `/api/image?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}&size=full`;
    },

    async revealInOS(fp: string): Promise<void> {
      // 浏览器打不开资源管理器：把路径写进日志，用户照着去找（或自己拷走）
      note(`📂文件在服务器上：${fp}`);
    },
    async pickStorageDir(): Promise<void> {
      note("ℹ️网页版的存储目录是服务端配置（cherysis-server.config.json / 命令行参数），改完重启服务生效");
    },
  };
}
