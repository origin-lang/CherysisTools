import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { readImageToBase64 } from "../../core/utils.js";

export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"]);
export const UPLOAD_FILTER: Record<string, string[]> = {
  图片: ["jpg", "jpeg", "png", "bmp", "webp", "gif"],
};

export function listImageFiles(dir: string): string[] {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  } catch {
    files = [];
  }
  files.sort((a, b) => {
    const na = Number((a.match(/(\d+)/) || ["", "0"])[1]);
    const nb = Number((b.match(/(\d+)/) || ["", "0"])[1]);
    return na - nb || a.localeCompare(b);
  });
  return files;
}

export function firstImageFile(dir: string, code: string): string | null {
  const folder = path.join(dir, code);
  const files = listImageFiles(folder);
  if (files.length === 0) {
    return null;
  }
  const fp = path.join(folder, files[0]);
  return fs.existsSync(fp) ? fp : null;
}

export const COVER_THUMB = 160;

export function coverThumbCachePaths(
  storageDir: string,
  code: string,
): { thumbPath: string; metaPath: string } | null {
  if (!storageDir) {
    return null;
  }
  const root = path.join(storageDir, "shop_thumbs");
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    return null;
  }
  return {
    thumbPath: path.join(root, `${code}.webp`),
    metaPath: path.join(root, `${code}.webp.json`),
  };
}

function fileFingerprint(src: string): string {
  try {
    const st = fs.statSync(src);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return "";
  }
}

/** 把单张图缩成 webp base64 小图；失败时回退原图 base64 */
export async function thumbToBase64(src: string, size = COVER_THUMB): Promise<string> {
  try {
    const out = await sharp(src)
      .resize(size, size, { fit: "cover" })
      .webp({ quality: 80 })
      .toBuffer();
    return `data:image/webp;base64,${out.toString("base64")}`;
  } catch {
    try {
      return await readImageToBase64(src);
    } catch {
      return "";
    }
  }
}

/** 商品封面缩略图：磁盘缓存（按 code）+ 源文件指纹校验，命中直接读盘 */
export async function coverThumbToBase64(
  src: string,
  storageDir: string,
  code: string,
): Promise<string> {
  const paths = coverThumbCachePaths(storageDir, code);
  if (paths) {
    try {
      const meta = JSON.parse(fs.readFileSync(paths.metaPath, "utf-8")) as {
        src?: string;
        key?: string;
      };
      if (
        meta.src === src &&
        meta.key === fileFingerprint(src) &&
        fs.existsSync(paths.thumbPath)
      ) {
        return `data:image/webp;base64,${fs.readFileSync(paths.thumbPath).toString("base64")}`;
      }
    } catch {
      /* 无缓存或缓存头不匹配 */
    }
  }
  const data = await thumbToBase64(src);
  if (paths && data.startsWith("data:image/webp")) {
    try {
      fs.writeFileSync(paths.thumbPath, Buffer.from(data.split(",")[1], "base64"));
      fs.writeFileSync(paths.metaPath, JSON.stringify({ src, key: fileFingerprint(src) }));
    } catch {
      /* 写缓存失败忽略 */
    }
  }
  return data;
}