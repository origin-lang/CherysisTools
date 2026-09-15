import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Handler, HandlerCtx } from "./types.js";
import { readImageToBase64 } from "../../../core/utils.js";
import {
  UPLOAD_FILTER,
  listImageFiles,
  coverThumbToBase64,
  thumbToBase64,
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
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
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

export function imageHandlers(h: HandlerCtx): Record<string, Handler> {
  const { log, post } = h;
  const ctx = h.ctx;

  const imageDir = (): string => String(h.getSetting("image_dir") || "").trim();

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

  const reloadImages = async (code: string) => {
    const dir = imageDir();
    const folder = path.join(dir, code);
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
    post({ type: "imagesLoaded", code, images: imgs, big0 });
  };

  return {
    async getCover(msg) {
      const code = String(msg.code ?? "");
      let data = h.coverCache.get(code);
      if (data === undefined) {
        data = await readCover(code);
        h.coverCache.set(code, data);
      }
      post({ type: "coverLoaded", code, data });
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
      if (!dir) {
        post({ type: "fullImageLoaded", code, index, data: "" });
        return;
      }
      const folder = path.join(dir, code);
      const files = listImageFiles(folder);
      const fp = files[index] ? path.join(folder, files[index]) : null;
      if (!fp) {
        post({ type: "fullImageLoaded", code, index, data: "" });
        return;
      }
      try {
        const data = await readImageToBase64(fp);
        post({ type: "fullImageLoaded", code, index, data });
      } catch {
        post({ type: "fullImageLoaded", code, index, data: "" });
      }
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
        const originName = it?.name
          ? path.basename(it.name).replace(/\.[^.]+$/, "")
          : "";
        const base = (originName || `${code}_${stamp()}`).replace(
          /[\\/:*?"<>|]/g,
          "_",
        );
        const target = uniqueTargetPath(folder, base, ext);
        try {
          fs.writeFileSync(target, bytes);
          added++;
        } catch (err: any) {
          log(`⚠️写入失败：${err.message}`);
        }
      }
      if (added) {
        log(`🖼已粘贴/拖入 ${added} 张图 → ${code} 文件夹`);
        await reloadImages(code);
        h.invalidateCover(code);
        h.loadAll();
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