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

export function imageHandlers(h: HandlerCtx): Record<string, Handler> {
  const { log, post } = h;
  const ctx = h.ctx;

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

  return {
    async getCover(msg) {
      const code = String(msg.code ?? "");
      let data = h.coverCache.get(code);
      if (data === undefined) {
        data = await readCover(code);
        h.coverCache.set(code, data);
      }
      // gen 原样带回：前端整批作废封面缓存后会 +1，靠它认出「作废之前发出的请求」
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
      await h.preOpBackup();
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(folder, f));
        } catch {
          /* 忽略单张删除失败 */
        }
      }
      log(`🗑已清空 ${code} 图片文件夹（${files.length} 张）`);
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
      await h.preOpBackup();
      try {
        fs.unlinkSync(fp);
      } catch (err: any) {
        log(`⚠️删除图片失败：${err.message}`);
        return;
      }
      log(`🗑已删除 ${code} 的第 ${index + 1} 张图片`);
      await reloadImages(code);
      h.invalidateCover(code);
      h.loadAll();
    },
  };
}