import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Handler, HandlerCtx } from "./types.js";
import { readImageToBase64 } from "../../../core/utils.js";
import {
  UPLOAD_FILTER,
  listImageFiles,
  thumbToCachedBase64,
} from "../images.js";

// 图片域：封面/图库缩略图/大图/上传/清空/删除/打开文件夹
const IMG_MIME_EXT: Record<string, string> = {
  png: ".png",
  jpeg: ".jpg",
  jpg: ".jpg",
  gif: ".gif",
  webp: ".webp",
  bmp: ".bmp",
};
const MAX_IMG_BYTES = 25 * 1024 * 1024;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Windows/SMB 上「文件正被占用」常是瞬时的：杀软扫一下、缩略图生成器、上一条命令的
 * 句柄还没回收，都会让 unlink 报 EBUSY/EPERM/EACCES，隔一下重试就好。
 * 这三个错码重试有意义；ENOENT（已经没了）之类的直接抛。
 *
 * 重试救不了的是「另一台机器正开着这张图」——SMB 上对方没开 FILE_SHARE_DELETE 时
 * 本来就删不掉，协议行为，只能由调用方提示用户去关掉。
 */
export const RETRYABLE_UNLINK = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * unlink 参数抽出成可注入（默认就是 fs.unlinkSync），是为了能测退避重试：
 * fs 是 ESM namespace，对它的属性赋值会抛 read-only，测试里 monkey-patch 不掉。
 */
export async function unlinkWithRetry(
	fp: string,
	unlink: (p: string) => void = (p) => fs.unlinkSync(p),
): Promise<void> {
	const waits = [0, 150, 400, 1000];
	let last: NodeJS.ErrnoException | null = null;
	for (const w of waits) {
		if (w) {
			await delay(w);
		}
		try {
			unlink(fp);
			return;
		} catch (err: any) {
			if (!RETRYABLE_UNLINK.has(err?.code)) {
				throw err;
			}
			last = err;
		}
	}
	throw last ?? new Error(`删除失败：${fp}`);
}

/** 占用类报错的统一话术：说清是「被占用」而不是把 EBUSY 甩给用户 */
export function busyHint(subject: string, err: any): string {
  const head = `⚠️${subject}（${err?.message || "未知错误"}）`;
  if (!RETRYABLE_UNLINK.has(err?.code)) {
    return head;
  }
  return (
    `${head}\n` +
    `　文件正被占用。删图前请先关掉正在看的大图预览；` +
    `如果是别的机器（或 Windows 资源管理器）正打开着这张图，也关掉再试。`
  );
}

const stamp = (): string => {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  // 毫秒段是给「两台机器同一秒上传同一编号」兜底的：文件名原来只到秒，
  // 两边算出同一个名字时会挑到同一个空位互相覆盖，而图片从来没进过备份（preOpBackup 只备 .db），
  // 盖掉就是永久丢失。加毫秒后撞名几率约万分之一，uniqueTargetPath 再兜底。
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${p3(d.getMilliseconds())}`;
};

const uniqueTargetPath = (folder: string, base: string, ext: string): string => {
  let target = path.join(folder, `${base}${ext}`);
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(folder, `${base}_${n}${ext}`);
    n++;
  }
  return target;
};

/** 文件夹里是否已有一张内容完全相同的图（按字节 SHA1 比对）——拖入/粘贴同一张图不再产生副本 */
const sameContentExists = (folder: string, bytes: Buffer): boolean => {
  const hash = crypto.createHash("sha1").update(bytes).digest("hex");
  for (const name of listImageFiles(folder)) {
    try {
      const existing =
        crypto.createHash("sha1").update(fs.readFileSync(path.join(folder, name))).digest("hex") === hash;
      if (existing) {
        return true;
      }
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return false;
};

/**
 * 依赖注入，只为测试能造出「文件被占用」：fs 是 ESM namespace，测试里 patch 不了它的
 * unlinkSync，而 Windows/SMB 上真实的 EBUSY 在 CI 上没法复现。
 * 生产调用只传 h，不传 deps，走下面的真实 fs.unlinkSync。
 */
export interface ImageHandlerDeps {
  unlink?: (fp: string) => void;
}

export function imageHandlers(h: HandlerCtx, deps: ImageHandlerDeps = {}): Record<string, Handler> {
  const { log, post } = h;
  const ctx = h.ctx;
  const unlinkFile = deps.unlink ?? ((fp: string) => fs.unlinkSync(fp));

  const imageDir = (): string => h.imageDir();

  // 缩略图缓存一律放本机（defaultStorageDir），不放共享数据目录：缓存键含绝对源路径，
  // 各人在共享盘上的盘符写法不同，共用一份会每次判定失效并互相覆写。
  const cacheDir = (): string => ctx.defaultStorageDir;

  // 大图优先给 webview 资源 URI：原图动辄几 MB，转 base64 再 postMessage 一次就是几十 MB 流量，
  // 而且每次点开放大都要重来一遍。URI 由浏览器自己流式解码，0 拷贝、100% 原图、放大不糊。
  // 前提是该文件在面板的 localResourceRoots 白名单里（面板创建时按当时的图片根目录收集），
  // 加载不出来时前端 onerror 回退请求 base64 通道。
  const webviewUri = (fp: string): string =>
    ctx.panel.webview.asWebviewUri(vscode.Uri.file(fp)).toString();

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
    return thumbToCachedBase64(path.join(folder, files[0]), cacheDir(), code);
  };

  const reloadImages = async (code: string) => {
    const dir = imageDir();
    const folder = path.join(dir, code);
    const files = listImageFiles(folder);
    const imgs: string[] = [];
    for (const name of files) {
      imgs.push(await thumbToCachedBase64(path.join(folder, name), cacheDir(), code, name));
    }
    // 首张大图只发 URI 不发 base64：图库里其它张点开放大时按需取
    post({
      type: "imagesLoaded",
      code,
      images: imgs,
      big0Uri: files[0] ? webviewUri(path.join(folder, files[0])) : "",
    });
  };

  /**
   * 商品图片夹的 mtime，一次 SMB stat。文件夹被删/读不到时返回 -1：
   * 与缓存里任何真实值都不相等，所以「文件夹没了」也会走重取分支拿到空图，
   * 别人把整个夹删掉同样能刷出来。
   */
  const folderMtime = (code: string): number => {
    const dir = imageDir();
    if (!dir) {
      return -1;
    }
    try {
      return Math.floor(fs.statSync(path.join(dir, code)).mtimeMs);
    } catch {
      return -1;
    }
  };

  return {
    async getCover(msg) {
      const code = String(msg.code ?? "");
      const hit = h.coverCache.get(code);
      // 命中不等于能用：先 stat 一下夹的 mtime（1 次 SMB 往返，比逐个文件 stat 便宜一个量级）。
      // 别人往这个夹里加图/删图/改名都会改目录 mtime，对不上才值得重取。
      if (hit !== undefined && folderMtime(code) === hit.dirMtime) {
        // gen 原样带回：前端整批作废封面缓存后会 +1，靠它认出「作废之前发出的请求」
        post({ type: "coverLoaded", code, data: hit.data, gen: msg.gen });
        return;
      }
      const data = await readCover(code);
      h.coverCache.set(code, { data, dirMtime: folderMtime(code) });
      post({ type: "coverLoaded", code, data, gen: msg.gen });
    },

    async getImages(msg) {
      const code = String(msg.code ?? "");
      const dir = imageDir();
      if (!dir) {
        post({ type: "imagesLoaded", code, images: [] });
        return;
      }
      await reloadImages(code);
    },

    async getFullImage(msg) {
      const code = String(msg.code ?? "");
      const index = Number(msg.index ?? 0);
      const dir = imageDir();
      const folder = dir ? path.join(dir, code) : "";
      const files = folder ? listImageFiles(folder) : [];
      const fp = files[index] ? path.join(folder, files[index]) : null;
      const reply = (extra: Record<string, unknown>) =>
        post({ type: "fullImageLoaded", code, index, ...extra });
      if (!fp) {
        reply({ data: "" });
        return;
      }
      // base64 通道：URI 加载不出来时的兜底，也是「右键复制图片」唯一可用的形式
      // （剪贴板要 data URL，vscode-webview-resource URL 复制不了）
      if (msg.base64) {
        try {
          reply({ data: await readImageToBase64(fp) });
        } catch {
          reply({ data: "" });
        }
        return;
      }
      reply({ uri: webviewUri(fp) });
    },

    async uploadImages(msg) {
      const code = String(msg.code ?? "");
      const dir = imageDir();
      if (!dir) {
        log("❌请先在「规则与设置」里选择图片根目录");
        return;
      }
      const folder = path.join(dir, code);
      fs.mkdirSync(folder, { recursive: true });
      const picked = await ctx.selectFiles(UPLOAD_FILTER);
      if (!picked.length) {
        return;
      }
      let added = 0;
      for (const src of picked) {
        const ext = path.extname(src).toLowerCase() || ".jpg";
        const target = uniqueTargetPath(folder, `${code}_${stamp()}`, ext);
        try {
          fs.copyFileSync(src, target);
          added++;
        } catch (err: any) {
          log(`⚠️复制失败 ${path.basename(src)}：${err.message}`);
        }
      }
      log(`🖼已上传导入 ${added} 张图 → ${code} 文件夹（自动按 ${code}_时间戳.jpg 命名）`);
      await reloadImages(code);
      h.invalidateCover(code);
      h.loadAll();
    },

    async receiveImageData(msg) {
      const code = String(msg.code ?? "");
      const dir = imageDir();
      if (!dir) {
        log("❌请先在「规则与设置」里选择图片根目录");
        return;
      }
      const items: Array<{ name?: string; data?: string }> = Array.isArray(
        msg.items,
      )
        ? msg.items
        : [];
      if (!items.length) {
        return;
      }
      const folder = path.join(dir, code);
      fs.mkdirSync(folder, { recursive: true });
      let added = 0;
      let skipped = 0;
      for (const it of items) {
        const data = String(it?.data ?? "");
        const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec(data);
        if (!m) {
          continue;
        }
        const ext = IMG_MIME_EXT[m[1].toLowerCase()] || ".png";
        const bytes = Buffer.from(m[2], "base64");
        if (!bytes.length) {
          continue;
        }
        if (bytes.length > MAX_IMG_BYTES) {
          log(`⚠️跳过超大图片（${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 25MB）`);
          continue;
        }
        // 内容已在文件夹里 → 不落盘，避免粘贴/拖入同一张图生成副本
        if (sameContentExists(folder, bytes)) {
          skipped++;
          continue;
        }
        // 与「上传」同一规范：一律按 {编号}_时间戳 命名，不保留原始文件名；
        // 同秒重复由 uniqueTargetPath 自动补 _2/_3，内容重复由 sameContentExists 拦截
        const base = `${code}_${stamp()}`;
        const target = uniqueTargetPath(folder, base, ext);
        try {
          fs.writeFileSync(target, bytes);
          added++;
        } catch (err: any) {
          log(`⚠️写入失败：${err.message}`);
        }
      }
      if (added) {
        log(
          `🖼已粘贴/拖入 ${added} 张图 → ${code} 文件夹（自动按 ${code}_时间戳.jpg 命名）` +
            (skipped ? `，${skipped} 张与已有图片重复已忽略` : ""),
        );
        await reloadImages(code);
        h.invalidateCover(code);
        h.loadAll();
      } else if (skipped) {
        log(`🖼${skipped} 张图与已有内容重复，未新增（${code}）`);
      }
    },

    async clearImages(msg) {
      const code = String(msg.code ?? "");
      const dir = imageDir();
      if (!dir) {
        log("❌未配置图片根目录");
        return;
      }
      const folder = path.join(dir, code);
      if (!fs.existsSync(folder)) {
        log(`⚠️${code} 无图片文件夹`);
        return;
      }
      const files = listImageFiles(folder);
      // 同 deleteImageFile：清空图片夹也不碰数据库，不该为它白拷一次整库
      let ok = 0;
      let busy = 0;
      let lastErr: any = null;
      for (const f of files) {
        try {
          await unlinkWithRetry(path.join(folder, f), unlinkFile);
          ok++;
        } catch (err: any) {
          lastErr = err;
          if (RETRYABLE_UNLINK.has(err?.code)) {
            busy++;
          }
        }
      }
      if (files.length === 0) {
        log(`🗑${code} 图片夹本来就是空的`);
      } else if (busy === 0 && ok === files.length) {
        log(`🗑已清空 ${code} 图片文件夹（${ok} 张）`);
      } else if (busy > 0) {
        // 原来这里是 catch {} 空吞掉单张失败、照样报「已清空 N 张」，属于谎报
        log(
          `${busyHint(`清空 ${code} 图片夹失败`, lastErr)}\n` +
            `　本次只删掉了 ${ok}/${files.length} 张，剩下的还在。` +
            `请确认图库抽屉已关、别的机器没在看这些图，再点一次「清空图片夹」。`,
        );
      } else {
        log(`⚠️清空 ${code} 图片夹只成功 ${ok}/${files.length} 张（${lastErr?.message || ""}）`);
      }
      post({ type: "imagesLoaded", code, images: [] });
      h.invalidateCover(code);
      h.loadAll();
    },

    async openImageFile(msg) {
      const code = String(msg.code ?? "");
      const dir = imageDir();
      if (!dir) {
        log("❌未配置图片根目录");
        return;
      }
      const folder = path.join(dir, code);
      if (!fs.existsSync(folder)) {
        log(`⚠️${code} 没有图片文件夹`);
        return;
      }
      try {
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(folder),
        );
      } catch (err: any) {
        log(`⚠️打开图片文件夹失败：${err.message}`);
      }
    },

    async deleteImageFile(msg) {
      const code = String(msg.code ?? "");
      const index = Number(msg.index ?? 0);
      const dir = imageDir();
      if (!dir) {
        log("❌未配置图片根目录");
        return;
      }
      const folder = path.join(dir, code);
      const files = listImageFiles(folder);
      const fp = files[index] ? path.join(folder, files[index]) : null;
      if (!fp) {
        log(`⚠️${code} 没有第 ${index + 1} 张图片`);
        return;
      }
      // 刻意不 preOpBackup：删图只动文件系统、一个字节都不写数据库，
      // 备份出来的库跟操作前一模一样，纯白等一次共享盘整库拷贝（实测 4 秒）。
      // 本机的备份也不留——真要找回误删的图，去共享盘上的图片夹里翻原件。
      try {
        await unlinkWithRetry(fp, unlinkFile);
      } catch (err: any) {
        // 失败也要把磁盘的真实情况推回前端，否则列表/图库停在「还在」的状态，
        // 用户分不清到底删掉没有
        log(busyHint(`删不掉 ${code} 的第 ${index + 1} 张图片`, err));
        await reloadImages(code);
        h.invalidateCover(code);
        h.loadAll();
        return;
      }
      log(`🗑已删除 ${code} 的第 ${index + 1} 张图片`);
      await reloadImages(code);
      h.invalidateCover(code);
      h.loadAll();
    },
  };
}