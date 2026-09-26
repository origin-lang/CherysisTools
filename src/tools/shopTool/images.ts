import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
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

// 封面缩略图边长：画册卡片可显示到数百像素宽且高 DPI 屏幕下需乘 2，160 会被放大变糊；
// 提到 512 直接变锐。缓存文件名带尺寸版本，改大后旧 160px 缓存自动失效重建。
export const COVER_THUMB = 512;

// 缩略图缓存目录名。刻意放各人自己的本机目录（VS Code globalStorage）而不是共享数据目录：
// 缓存键里带绝对源路径，各人在共享盘上的盘符映射写法不同（Z:\ vs Y:\），共用一份缓存时
// 每次都会判定失效并互相覆写，纯粹白折腾。缓存随时可重建，放本机没有一致性代价。
const THUMB_DIRNAME = "shop_thumbs";

function thumbRoot(cacheDir: string): string {
  return path.join(cacheDir, THUMB_DIRNAME);
}

function safeCode(code: string): string {
  return String(code || "").replace(/[^\w.-]/g, "_");
}

/**
 * 缓存文件名。fileName 省略时是「封面」那一枚（{code}@512）；给了文件名则按文件单独存
 * （{code}~{文件名哈希}@512），用哈希而不是序号：删掉第 1 张后第 2 张会顶到序号 1，
 * 序号会张冠李戴，哈希则天然稳定。
 */
function thumbName(code: string, fileName?: string): string {
  const base = safeCode(code);
  if (!fileName) {
    return `${base}@${COVER_THUMB}`;
  }
  const h = crypto.createHash("sha1").update(String(fileName)).digest("hex").slice(0, 8);
  return `${base}~${h}@${COVER_THUMB}`;
}

type CacheEntry = { thumbPath: string; metaPath: string };

function cacheEntry(cacheDir: string, name: string): CacheEntry | null {
  if (!cacheDir) {
    return null;
  }
  const root = thumbRoot(cacheDir);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    return null;
  }
  const file = `${name}.webp`;
  return { thumbPath: path.join(root, file), metaPath: path.join(root, `${file}.json`) };
}

function fileFingerprint(src: string): string {
  try {
    const st = fs.statSync(src);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return "";
  }
}

/** 命中返回 base64（不含 data: 前缀），未命中/校验不过返回 null */
function readCache(entry: CacheEntry, src: string): string | null {
  if (!cacheValid(entry, src)) {
    return null;
  }
  try {
    return fs.readFileSync(entry.thumbPath).toString("base64");
  } catch {
    return null;
  }
}

/** 缓存是否可用：源路径一致 + 源图指纹（mtime+大小）没变 + 缩略图文件还在 */
function cacheValid(entry: CacheEntry, src: string): boolean {
  try {
    const meta = JSON.parse(fs.readFileSync(entry.metaPath, "utf-8")) as {
      src?: string;
      key?: string;
    };
    return (
      meta.src === src && meta.key === fileFingerprint(src) && fs.existsSync(entry.thumbPath)
    );
  } catch {
    /* 无缓存或缓存头不匹配 */
    return false;
  }
}

function writeCache(entry: CacheEntry, src: string, data: string): void {
  // thumbToBase64 在 sharp 失败时会回退成原图 base64（jpeg/png...），那不是缩略图，别写进缓存
  if (!data.startsWith("data:image/webp")) {
    return;
  }
  try {
    fs.writeFileSync(entry.thumbPath, Buffer.from(data.split(",")[1], "base64"));
    fs.writeFileSync(entry.metaPath, JSON.stringify({ src, key: fileFingerprint(src) }));
  } catch {
    /* 写缓存失败忽略 */
  }
}

/** 把单张图缩成 webp base64 小图；失败时回退原图 base64 */
export async function thumbToBase64(src: string, size = COVER_THUMB): Promise<string> {
  let job: sharp.Sharp | undefined;
  try {
    job = sharp(src);
    const out = await job
      .resize(size, size, { fit: "cover" })
      .webp({ quality: 80 })
      .toBuffer();
    return "data:image/webp;base64," + out.toString("base64");
  } catch {
    try {
      return await readImageToBase64(src);
    } catch {
      return "";
    }
  } finally {
    // libvips 会把打开的源文件句柄挂在 job 上，等到 GC 才关。Windows/SMB 上
    // 「刚生成过缩略图就删原图」会因此撞 EBUSY，所以这里立刻关掉，不等 GC。
    job?.destroy();
  }
}

/**
 * 512 缩略图 base64，走本机磁盘缓存。fileName 省略 = 商品封面那一枚；
 * 给了文件名 = 图库里具体某张（抽屉、图库缩略图），与封面分开缓存互不覆盖。
 */
export async function thumbToCachedBase64(
  src: string,
  cacheDir: string,
  code: string,
  fileName?: string,
): Promise<string> {
  const entry = cacheEntry(cacheDir, thumbName(code, fileName));
  if (entry) {
    const hit = readCache(entry, src);
    if (hit !== null) {
      return "data:image/webp;base64," + hit;
    }
  }
  const data = await thumbToBase64(src);
  if (entry) {
    writeCache(entry, src, data);
  }
  return data;
}

/**
 * 星标总览「预览」用的那一枚：等比缩到 512、**不裁剪**，与封面缩略图分开存。
 *
 * 为什么不复用封面那一枚：封面是 cover 裁成正方形（画册卡片要方图），而星标总览的格子
 * 是按原图比例摆的。喂裁过的图会让**预览和最终导出的图长得不一样**（边缘被切掉），
 * 用户看着预览满意、导出后才发现构图变了。
 *
 * 为什么值得单独存一份：预览每次改排版/翻页都要重拼一张图，原来每格都从共享盘拉原图
 * 再解码（4000px 的 JPEG 单张几十毫秒，9~25 格就是好几秒）。走本机 512 小图后
 * 稳定在几百毫秒；边长 512 > 预览格最大边 360，缩下来看不出差别。
 */
export const PREVIEW_THUMB = 512;

function previewThumbName(code: string): string {
  return `${safeCode(code)}@p${PREVIEW_THUMB}`;
}

/** 等比缩到 PREVIEW_THUMB 的 webp base64；sharp 失败时回退原图 base64（调用方据此放弃写缓存） */
async function previewThumbToBase64(src: string): Promise<string> {
  try {
    const out = await sharp(src)
      .resize(PREVIEW_THUMB, PREVIEW_THUMB, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return "data:image/webp;base64," + out.toString("base64");
  } catch {
    try {
      return await readImageToBase64(src);
    } catch {
      return "";
    }
  }
}

/**
 * 取星标总览预览用的**本机小图路径**，没命中时按 build 分两种走法：
 *
 * - `build=false`（预览用）：命中就返回；没命中返回 null，让调用方**这次仍用原图**，
 *   同时在后台把小图缩好写进缓存。所以**第一次预览不会比原来更慢**（原来也是读原图），
 *   第二次起才走本机几十 KB —— 改排版、翻页、反复开关弹窗这些都是热的。
 * - `build=true`：没命中就现缩并返回，调用方确定要拿到这张小图时用。
 *
 * 两种走法都不碰共享盘上的原图之外的东西；返回 null 时调用方回退用原图，行为与优化前一致。
 */
export function previewThumbPath(
  src: string,
  cacheDir: string,
  code: string,
  build = false,
): Promise<string | null> {
  const entry = cacheEntry(cacheDir, previewThumbName(code));
  if (!entry) {
    return Promise.resolve(null);
  }
  if (cacheValid(entry, src)) {
    return Promise.resolve(entry.thumbPath);
  }
  const make = async (): Promise<string | null> => {
    const data = await previewThumbToBase64(src);
    if (!data.startsWith("data:image/webp")) {
      return null;
    }
    writeCache(entry, src, data);
    return entry.thumbPath;
  };
  if (build) {
    return make();
  }
  // 不 await：这一次的预览不等它，下次进来看得见就命中了
  void make().catch(() => undefined);
  return Promise.resolve(null);
}

/**
 * 清掉某编号的全部缩略图缓存（封面 + 预览 + 图库里每张）。改编号、删图、清空图片、删商品时调用：
 * 缓存目录在本机，不会自动同步给别人，所以必须按前缀一次删净，别只删封面那一枚。
 */
export function pruneCodeThumbs(cacheDir: string, code: string): void {
  if (!cacheDir) {
    return;
  }
  const root = thumbRoot(cacheDir);
  const base = safeCode(code);
  try {
    for (const f of fs.readdirSync(root)) {
      const isWebp = f.endsWith(".webp") || f.endsWith(".webp.json");
      // `@` 后面是尺寸/用途版本号（512 封面、p512 预览…），加新版本自动一起清干净
      const isVersioned = f.startsWith(`${base}@`) && isWebp;
      const isPerFile = f.startsWith(`${base}~`) && isWebp;
      if (isVersioned || isPerFile) {
        try {
          fs.rmSync(path.join(root, f), { force: true });
        } catch {
          /* 忽略单个删除失败 */
        }
      }
    }
  } catch {
    /* 目录不存在则无事可做 */
  }
}

/**
 * 清掉 mtime 超过 keepDays 的旧缩略图。改过编号的商品，旧编号那几枚缓存再也没人会用到
 * （库里已不存在该编号），留着只是各占一点磁盘；顺带兜住任何漏网的残留。
 */
export function pruneOldThumbs(cacheDir: string, keepDays = 30): void {
  if (!cacheDir) {
    return;
  }
  const root = thumbRoot(cacheDir);
  const cutoff = Date.now() - keepDays * 86400000;
  try {
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith(".webp") && !f.endsWith(".webp.json")) {
        continue;
      }
      const fp = path.join(root, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          fs.rmSync(fp, { force: true });
        }
      } catch {
        /* 忽略单个 stat/删除失败 */
      }
    }
  } catch {
    /* 目录不存在则无事可做 */
  }
}
