import * as fs from "fs";
import * as path from "path";
import { withSharpFile } from "../core/utils.js";

/**
 * 直播排品「成品」的只读访问（2026-10-17 晚，手机版 A 档：**只看**）。
 *
 * 为什么单独一个模块：手机要能看已经生成好的九宫格图和 HTML 样品，而生成那套
 * （`handlers/live.ts`）是走 /api/invoke 的，它不负责把文件发出去。这里只做三件事：
 * **列目录 / 缩略图 / 取原文件**，一个字节都不写业务数据。
 *
 * ⭐ 三条硬规矩（改这个文件之前先读）：
 *
 * 1. **名字只认纯文件名**（`isSafeArtifactName`）。这个目录里能放任意成品文件，
 *    参数一旦能带 `../`，等于把整台机器开放下载 —— 这是本模块唯一的高危面。
 *    所以：先 basename 比对，再 path.resolve 做前缀二次校验，两道都过才给路径。
 *
 * 2. **列表只给缩略图**。九宫格成品一张 300KB~1.5MB，外网（Cloudflare 隧道）实测
 *    1~1.5 秒/张、原图 3~6 秒 —— 一屏挂 6 张原图就是十几 MB、等半分钟。
 *    缩略图 480px webp ≈ 40~60KB，跟商品封面同一量级。
 *
 * 3. **缩略图缓存的文件名带 mtime**。重新生成过的成品 mtime 变了 → 缓存键变了 →
 *    不会拿到上一批的旧图（这个坑在商品缩略图上踩过）。
 */

export type ArtifactKind = "grid" | "html";

export interface Artifact {
  name: string;
  kind: ArtifactKind;
  size: number;
  mtime: number;
}

const GRID_EXT = new Set([".jpg", ".jpeg", ".png"]);
const HTML_EXT = new Set([".html", ".htm"]);

/**
 * 这个文件算不算"本功能的成品"（jpg/png/html）。
 * ⚠️ 删除接口的**唯一门槛**就是它：那个目录里还躺着进货单导出的 xlsx
 * （`进货单_2026-10-15_….xlsx`），要是按"删目录里所有文件"实现，他的进货单就没了。
 * 所以删除只能按这个白名单走，**永远不许**用"列目录全部删掉"。
 */
export function isArtifactName(name: string): boolean {
  const ext = path.extname(String(name || "")).toLowerCase();
  return GRID_EXT.has(ext) || HTML_EXT.has(ext);
}

/** 只认纯文件名；任何分隔符、`..`、空字节一律拒绝 */
export function isSafeArtifactName(name: string): boolean {
  const s = String(name === undefined || name === null ? "" : name);
  if (!s || s.length > 200) {
    return false;
  }
  if (s.includes("/") || s.includes("\\") || s.includes("..") || s.includes("\0")) {
    return false;
  }
  // "." 的 basename 还是 "."，上面几条都拦不住（resolveArtifact 会用"等于根目录"兜，
  // 但这里就该是 false —— 它不是一个文件）
  if (s === ".") {
    return false;
  }
  // 再核一遍 basename（Windows 上 `C:x` 这类也能骗过 isAbsolute）
  return s === path.basename(s);
}

/** 把「目录 + 名字」解成绝对路径；不合法/越界一律 null */
export function resolveArtifact(dir: string, name: string): string | null {
  if (!dir || !isSafeArtifactName(name)) {
    return null;
  }
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  // basename 那条已经挡住 `..`；这条是双保险（大小写、盘符之类的花样）
  if (full === root || !full.startsWith(root + path.sep)) {
    return null;
  }
  return full;
}

/** 列成品：只认图片和 html，新的排前面（他要的多半是"刚生成的那批"） */
export function listArtifacts(dir: string, limit = 200): Artifact[] {
  if (!dir) {
    return [];
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // 目录不在 / 读不了 —— 当空，别让手机端弹一堆错
  }
  const out: Artifact[] = [];
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    const kind: ArtifactKind | null = GRID_EXT.has(ext) ? "grid" : HTML_EXT.has(ext) ? "html" : null;
    if (!kind) {
      continue;
    }
    try {
      const st = fs.statSync(path.join(dir, n));
      if (!st.isFile()) {
        continue;
      }
      out.push({ name: n, kind, size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

/** 缩略图缓存路径：带 mtime，重新生成的成品不会命中旧缓存 */
export function thumbCachePath(cacheDir: string, name: string, mtime: number): string {
  // ⚠️ 不能只靠"把非单词字符换成下划线"：成品名全是中文（`九宫格_1.jpg` / `长图_1.jpg`），
  //    压完都变成 `__1.jpg` —— 同批生成的两个文件 mtime 挨得极近，就会共用一张缩略图
  //    （列表里一张是九宫格、点开是长图）。所以名字另算一个短哈希钉住它。
  const safe = name.replace(/[^\w.\-]+/g, "_").slice(-40);
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  }
  return path.join(cacheDir, "live-thumbs", `${mtime}-${h.toString(36)}-${safe}.webp`);
}

/**
 * 拿列表用的缩略图（有就复用，没有就现缩）。返回文件路径；缩不出来返回 ""。
 * 缩不出来不该让整行消失 —— 调用方会把原图直接流回去（慢，但比一片空白强）。
 */
export async function ensureThumb(
  src: string,
  cacheDir: string,
  name: string,
  mtime: number,
  size = 480,
): Promise<string> {
  const out = thumbCachePath(cacheDir, name, mtime);
  try {
    if (fs.statSync(out).size > 0) {
      return out;
    }
  } catch {
    /* 没缓存，往下走 */
  }
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const buf = await withSharpFile((f) =>
      f(src)
        // auto-orient 跟商品缩略图同一条理由：重编码会把 EXIF 丢掉，不先转正就是歪的
        .rotate()
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer(),
    );
    fs.writeFileSync(out, buf);
    return out;
  } catch {
    return "";
  }
}

/** 原文件的 Content-Type（只认能预览的几种；其余一律当二进制附件） */
export function mimeOf(name: string): string {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (GRID_EXT.has(ext)) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}
