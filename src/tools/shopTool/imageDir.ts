import * as fs from "fs";
import * as path from "path";

// 图片根目录是「跟人走」的路径：同一份 shop.db 被多人共享时，写进库里的值是全局一份、
// 最后写入者覆盖所有人。这里改成读各人自己的**本机设置**（VS Code 里是 cherysis.shopTool.imageDir），
// 库里的旧值只当回落用，老用户不改也能继续用。
//
// 「本机设置」由宿主在启动时注入（与 db.ts 的 initDB 同一套路）：VS Code 宿主读写的是
// workspace 配置；将来的网页服务端读写的是服务端配置。所以**这个文件不 import vscode** ——
// 整条 handler 导入链都要能在没有 vscode 的 Node 进程里加载（网页版的前提）。

/** 生效目录的来源：config=本机设置，db=共享库旧值，none=都没配 */
export type ImageDirSource = "config" | "db" | "none";

export type ResolvedImageDir = {
  /** 实际用来拼图片文件夹的路径，空串表示未配置 */
  dir: string;
  source: ImageDirSource;
  /** dir 是否可用（绝对路径且真实存在） */
  valid: boolean;
  /** 本机设置里填了但不可用，已被忽略 */
  configBroken: boolean;
};

/** 本机设置的读写接口，由宿主注入 */
export type ImageDirConfig = {
  /** 读本机设置里填的值（没填返回空串） */
  read(): string;
  /** 这个键的生效作用域，供界面提示「来源：用户/工作区」 */
  scope(): "workspace" | "user" | "default";
  /** 写入本机设置 */
  write(dir: string): Promise<void>;
  /** 清除本机设置，回到共享库里的值 */
  clear(): Promise<void>;
};

/** 没注入时的兜底：当作「本机什么都没设」，一切走库里的旧值（等于加这层之前的行为） */
const NO_CONFIG: ImageDirConfig = {
  read: () => "",
  scope: () => "default",
  write: async () => undefined,
  clear: async () => undefined,
};

let hostConfig: ImageDirConfig | null = null;

/** 宿主启动时调用一次（VS Code: activate；网页服务端: 进程启动） */
export function initImageDirConfig(cfg: ImageDirConfig): void {
  hostConfig = cfg;
}

const config = (): ImageDirConfig => hostConfig ?? NO_CONFIG;

/** 目录是否可用：必须是绝对路径且真实存在，否则视为没配（相对路径在本机 cwd 下无意义） */
export function isValidImageDir(dir: string): boolean {
  if (!dir || !path.isAbsolute(dir)) {
    return false;
  }
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 本机设置里这个键的生效作用域，供界面提示「来源：用户/工作区」 */
export function configScope(): "workspace" | "user" | "default" {
  return config().scope();
}

/**
 * 解析生效的图片根目录：本机设置优先；本机填的不可用（相对路径/目录不存在）时忽略它，
 * 退回库里的共享旧值，并把 configBroken 带回界面提示。
 */
export function resolveImageDir(dbValue: string): ResolvedImageDir {
  const db = String(dbValue || "").trim();
  const cfgDir = String(config().read() || "").trim();
  if (cfgDir) {
    if (isValidImageDir(cfgDir)) {
      return { dir: cfgDir, source: "config", valid: true, configBroken: false };
    }
    return {
      dir: db,
      source: db ? "db" : "none",
      valid: isValidImageDir(db),
      configBroken: true,
    };
  }
  return { dir: db, source: db ? "db" : "none", valid: isValidImageDir(db), configBroken: false };
}

/**
 * 只在目录真能用时返回路径，否则空串。所有真正拿去拼文件路径的地方（拼商品图片文件夹、
 * 列目录、迁移旧文件夹）都必须走这里：库里存的旧值可能是别人机器上的路径、或一个已经被
 * 删掉/改名/未挂载的共享盘，直接拼会得到一串看似正常、实则全是 ENOENT 的路径。
 */
export function effectiveImageDir(r: ResolvedImageDir): string {
  return r.valid ? r.dir : "";
}

/** 写入本机设置（只影响本机；已有的工作区级覆盖仍然优先） */
export function setConfigImageDir(dir: string): Promise<void> {
  return config().write(dir);
}

/** 清除本机设置，回到共享库里的值 */
export function clearConfigImageDir(): Promise<void> {
  return config().clear();
}
