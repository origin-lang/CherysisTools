import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { readImageToBase64, withSharpFile } from "../../core/utils.js";

export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"]);
export const UPLOAD_FILTER: Record<string, string[]> = {
  图片: ["jpg", "jpeg", "png", "bmp", "webp", "gif"],
};

/**
 * stat 不到 mtime 时的哨兵。取极大**有限**值而不是 Infinity：两个哨兵相减是 NaN，
 * 而 NaN 参与排序会直接毁掉确定性（同组比较全判「相等」，顺序取决于 V8 当时的实现）。
 */
const NO_MTIME = Number.MAX_SAFE_INTEGER;

const mtimeOf = (fp: string): number => {
  try {
    return fs.statSync(fp).mtimeMs;
  } catch {
    return NO_MTIME;
  }
};

/**
 * 文件名比较：只在「加入时间完全相同」时作回落。
 *
 * 为什么必须是确定性的（不能改成随机）：`deleteImageFile` 与 `getFullImage` 都是**在请求
 * 到达时重新读一次目录**、再按下标取文件（handlers/image.ts 里两处），前端按下标发请求。
 * 同一份夹子两次读出不同顺序，就意味着用户看到的第 2 张和实际删掉的第 2 张不是同一张。
 */
const byName = (a: string, b: string): number => {
  const na = Number((a.match(/(\d+)/) || ["", "0"])[1]);
  const nb = Number((b.match(/(\d+)/) || ["", "0"])[1]);
  return na - nb || a.localeCompare(b);
};

/**
 * 图片夹里的图片，按**加入文件夹的时间**升序（最早上传的排第 1，也就是封面那一张）。
 *
 * 为什么不用文件名：夹子里的图不一定是扩展自己放进去的——同事可以直接把文件拖进共享盘的
 * 夹子，叫什么都行。原先按「文件名第一段数字 + 字母序」排，对 `{编号}_{时间戳}.jpg` 恰好
 * 等价于时间序，对这种外来文件就只能排出一个任意顺序，于是「哪张是封面」变成一件看名字猜的事。
 */
export function listImageFiles(dir: string): string[] {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  } catch {
    files = [];
  }
  // 一张图时顺序无从谈起，直接返回：绝大多数商品夹就属于这种，于是零额外 stat
  if (files.length < 2) {
    return files;
  }
  // 先 stat 完再排，不在比较函数里 stat：放比较函数里会变成 O(n log n) 次 stat，
  // 共享盘上每次都是一趟 SMB 往返
  const times = new Map<string, number>();
  for (const f of files) {
    times.set(f, mtimeOf(path.join(dir, f)));
  }
  files.sort((a, b) => times.get(a)! - times.get(b)! || byName(a, b));
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

/**
 * 共享缩略图缓存目录名（放在 cherysis.storageDir 里，也就是共享盘上那份数据目录里）。
 *
 * 为什么要有第二份缓存：本机那份（shop_thumbs）只有在**每台机器自己**上才有，客机第一次
 * 看某个编号的封面时，本机缓存是空的，只能去共享盘读**原图**——一张手机拍的 JPEG 好几 MB，
 * 一次开面板要读几十张，SMB 带宽就卡在这儿。共享缓存里存的是同一张图的 512px webp（几十 KB），
 * 谁先缩好放进去，后面所有机器都直接读小图。
 *
 * 目录名刻意跟本机那份不一样：没另配 cherysis.storageDir 时 storageDir 就等于本机默认目录，
 * 两者会落在同一个父目录下，同名就变成同一份缓存互相覆盖（两边的 meta 格式不同，见 sharedEntry）。
 */
const SHARED_THUMB_DIRNAME = "shop_thumbs_shared";

/**
 * 共享缩略图缓存根目录；返回空串 = 不启用共享缓存。
 *
 * 只在「另配了数据存储目录」时启用：没配的时候 storageDir 就是本机默认目录，压根没有第二台
 * 机器会读到它，多存一份只是白占磁盘。配了（哪怕配的是本机别的盘）就启用——是缓存，
 * 不是共享时最坏也就是占点地方，没有一致性代价。
 */
export function sharedThumbRoot(storageDir: string, defaultStorageDir: string): string {
  if (!storageDir || !defaultStorageDir) {
    return "";
  }
  try {
    if (path.resolve(storageDir) === path.resolve(defaultStorageDir)) {
      return "";
    }
  } catch {
    return "";
  }
  return path.join(storageDir, SHARED_THUMB_DIRNAME);
}

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
  return fingerprints(src).local;
}

/**
 * 一次 stat 出两个指纹，省掉第二趟共享盘 stat（每次 stat 在网络盘上都是一趟往返）。
 *
 * - `local`：沿用原来的精确 mtimeMs（改了格式等于把所有人现存的缩略图缓存一次性作废，
 *   客机下次开面板就得把原图重读一遍——正是这次要避免的事，所以本机这份不动）。
 * - `shared`：mtime 取整到毫秒。这份 meta 要跨机器比对，整数比浮点稳（不同机器的
 *   SMB 客户端把同一个时间戳换算成 mtimeMs 时，末几位理论上可能有表示差异）；
 *   毫秒内的改动照旧由 getCover 的「图片夹 mtime」那道闸兜住。
 */
function fingerprints(src: string): { local: string; shared: string } {
  try {
    const st = fs.statSync(src);
    return { local: `${st.mtimeMs}|${st.size}`, shared: `${Math.round(st.mtimeMs)}|${st.size}` };
  } catch {
    return { local: "", shared: "" };
  }
}

/** 命中返回 base64（不含 data: 前缀），未命中/校验不过返回 null。fp 可传已经算好的指纹，省一趟 stat */
function readCache(entry: CacheEntry, src: string, fp?: string): string | null {
  if (!cacheValid(entry, src, fp)) {
    return null;
  }
  try {
    return fs.readFileSync(entry.thumbPath).toString("base64");
  } catch {
    return null;
  }
}

/** 缓存是否可用：源路径一致 + 源图指纹（mtime+大小）没变 + 缩略图文件还在 */
function cacheValid(entry: CacheEntry, src: string, fp?: string): boolean {
  try {
    const meta = JSON.parse(fs.readFileSync(entry.metaPath, "utf-8")) as {
      src?: string;
      key?: string;
    };
    return (
      meta.src === src &&
      meta.key === (fp ?? fileFingerprint(src)) &&
      fs.existsSync(entry.thumbPath)
    );
  } catch {
    /* 无缓存或缓存头不匹配 */
    return false;
  }
}

function writeCache(entry: CacheEntry, src: string, data: string, fp?: string): void {
  // thumbToBase64 在 sharp 失败时会回退成原图 base64（jpeg/png...），那不是缩略图，别写进缓存
  if (!data.startsWith("data:image/webp")) {
    return;
  }
  try {
    fs.writeFileSync(entry.thumbPath, Buffer.from(data.split(",")[1], "base64"));
    fs.writeFileSync(entry.metaPath, JSON.stringify({ src, key: fp ?? fileFingerprint(src) }));
  } catch {
    /* 写缓存失败忽略 */
  }
}

// ===== 共享缩略图缓存（跨机器共用的那一份，见 SHARED_THUMB_DIRNAME）=====

/**
 * 共享缓存的落点。create=false 时**不建目录**：只读机、只是来判断「这张缩好没有」的调用，
 * 不该因为看一眼就在共享盘上创建文件夹。
 */
function sharedEntry(root: string, name: string, create = false): CacheEntry | null {
  if (!root) {
    return null;
  }
  if (create) {
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch {
      return null;
    }
  }
  const file = `${name}.webp`;
  return { thumbPath: path.join(root, file), metaPath: path.join(root, `${file}.json`) };
}

/**
 * 读共享缓存里的缩略图。meta 只认真实指纹，**不认绝对源路径**：
 * 同一张图在各人机器上的盘符写法不一样（Z:\商品图片 vs Y:\商品图片，
 * 名字也可能不是这个），把绝对路径写进 meta 就等于永远不命中、还互相盖。
 *
 * 指纹对不上、meta 缺失、webp 不在，一律当没命中（调用方退回本机缓存/原图，行为与没有共享层时一致）。
 */
function readSharedCache(entry: CacheEntry, fp: string): string | null {
  if (!fp) {
    return null;
  }
  try {
    const meta = JSON.parse(fs.readFileSync(entry.metaPath, "utf-8")) as { key?: string };
    if (meta.key !== fp) {
      return null;
    }
    return fs.readFileSync(entry.thumbPath).toString("base64");
  } catch {
    return null;
  }
}

/**
 * 写共享缓存。顺序是「webp 先落地、meta 后写」，中间不能被换过来：
 * 别人可能正在读，先落 meta 会让它拿着新指纹读到旧图（画出别人的图，比慢一点糟得多）；
 * 先落 webp 则最坏是「新图 + 旧 meta」，读的人发现指纹对不上，重缩一张就完事。
 *
 * 先写临时文件再改名：另一台机器可能正好读到一半，半张 webp 解不出来。
 */
function writeSharedCache(entry: CacheEntry, fp: string, data: string): void {
  if (!fp || !data.startsWith("data:image/webp")) {
    return;
  }
  const tmp = `${entry.thumbPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(entry.thumbPath), { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(data.split(",")[1], "base64"));
    fs.renameSync(tmp, entry.thumbPath);
    fs.writeFileSync(entry.metaPath, JSON.stringify({ key: fp }));
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件没清掉就算了，下次同名会覆盖 */
    }
  }
}

/**
 * 共享缓存里这张图的小图是否已经缩好。**只看 meta、不读 webp**：预生成时用它跳过已完成的，
 * 重复点「生成共享缩略图」就只是把几千个 meta 扫一遍，不会把几千张图再从共享盘读回来。
 */
export function sharedThumbReady(
  src: string,
  root: string,
  code: string,
  fileName?: string,
): boolean {
  const entry = sharedEntry(root, thumbName(code, fileName));
  if (!entry) {
    return false;
  }
  const fp = fingerprints(src).shared;
  if (!fp) {
    return false;
  }
  try {
    const meta = JSON.parse(fs.readFileSync(entry.metaPath, "utf-8")) as { key?: string };
    return meta.key === fp;
  } catch {
    return false;
  }
}

/** 把单张图缩成 webp base64 小图；失败时回退原图 base64 */
export async function thumbToBase64(src: string, size = COVER_THUMB): Promise<string> {
  try {
    const out = await withSharpFile((f) =>
      f(src)
        .resize(size, size, { fit: "cover" })
        .webp({ quality: 80 })
        .toBuffer(),
    );
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
 * 共享缩略图缓存参数。root 用 sharedThumbRoot() 算（空串 = 不启用）；
 * writable=false 表示只读模式：共享缓存**照读不误**，但一张都不往里写。
 */
export type SharedThumbCache = {
  root: string;
  writable?: boolean;
};

/**
 * 512 缩略图 base64，走本机磁盘缓存。fileName 省略 = 商品封面那一枚；
 * 给了文件名 = 图库里具体某张（抽屉、图库缩略图），与封面分开缓存互不覆盖。
 *
 * 三级查找，顺序就是「便宜 → 贵」：
 *   ① 本机缓存（一次 stat + 读几十 KB，最便宜）
 *   ② 共享缓存（一次 stat + 读几十 KB，但走网络）
 *   ③ 读原图现缩（一次 stat + 读几 MB 原图 + 解码，最贵）
 * 命中 ② 时顺手回填 ①：同一台机器第二次看这张图，连共享盘那一趟都省了。
 * 没有 shared（未配数据存储目录）时行为与加这层之前完全一致。
 */
export async function thumbToCachedBase64(
  src: string,
  cacheDir: string,
  code: string,
  fileName?: string,
  shared?: SharedThumbCache,
): Promise<string> {
  return cachedWebp(src, cacheDir, thumbName(code, fileName), () => thumbToBase64(src), shared);
}

/**
 * 详情页封面要用的「中号图」：等比缩到 MID_SIZE、**不裁剪**。
 *
 * 为什么非得再来一档：封面以前直接用原图（size=full），而手机拍的原图实测 7.9MB，
 * 详情页那个封面在屏幕上也就几百像素宽 —— 等于每次进详情都拉一整张原图下来看个缩略。
 * 1024 宽在手机上看不出差别，体积却小一个数量级。
 *
 * 为什么不直接用 512 那档：512 是 cover 裁成**正方形**的（画册卡片要方图），
 * 当封面看会把上下/左右裁掉一截，构图不对。这一档是 inside 等比缩，完整保留原图。
 *
 * 缓存名带 @m1024，与 512 那档各存各的，互不覆盖。
 */
export const MID_SIZE = 1024;

function midName(code: string, fileName?: string): string {
  const base = safeCode(code);
  if (!fileName) {
    return `${base}@m${MID_SIZE}`;
  }
  const h = crypto.createHash("sha1").update(String(fileName)).digest("hex").slice(0, 8);
  return `${base}~${h}@m${MID_SIZE}`;
}

/** 等比缩到 MID_SIZE 的 webp base64；sharp 失败时回退原图 base64 */
async function midToBase64(src: string): Promise<string> {
  try {
    const out = await withSharpFile((f) =>
      f(src)
        .resize(MID_SIZE, MID_SIZE, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer(),
    );
    return "data:image/webp;base64," + out.toString("base64");
  } catch {
    try {
      return await readImageToBase64(src);
    } catch {
      return "";
    }
  }
}

export async function midToCachedBase64(
  src: string,
  cacheDir: string,
  code: string,
  fileName?: string,
  shared?: SharedThumbCache,
): Promise<string> {
  return cachedWebp(src, cacheDir, midName(code, fileName), () => midToBase64(src), shared);
}

/**
 * 三级缓存（本机 → 共享 → 现缩）的公共骨架，上面两档尺寸共用。
 * make 只在**都没命中**时才跑，也就是"真正该付代价"的那一次。
 */
async function cachedWebp(
  src: string,
  cacheDir: string,
  name: string,
  make: () => Promise<string>,
  shared?: SharedThumbCache,
): Promise<string> {
  // 指纹只算一次：本机缓存和共享缓存都要用它，各算一次就是两趟共享盘 stat
  const fp = fingerprints(src);
  const entry = cacheEntry(cacheDir, name);
  if (entry) {
    const hit = readCache(entry, src, fp.local);
    if (hit !== null) {
      return "data:image/webp;base64," + hit;
    }
  }
  const root = shared?.root ?? "";
  if (root) {
    const sEntry = sharedEntry(root, name);
    if (sEntry) {
      const hit = readSharedCache(sEntry, fp.shared);
      if (hit !== null) {
        if (entry) {
          writeCache(entry, src, "data:image/webp;base64," + hit, fp.local);
        }
        return "data:image/webp;base64," + hit;
      }
    }
  }
  const data = await make();
  if (entry) {
    writeCache(entry, src, data, fp.local);
  }
  if (root && shared?.writable !== false) {
    const sEntry = sharedEntry(root, name, true);
    if (sEntry) {
      writeSharedCache(sEntry, fp.shared, data);
    }
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
    const out = await withSharpFile((f) =>
      f(src)
        .resize(PREVIEW_THUMB, PREVIEW_THUMB, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer(),
    );
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
 * 正在后台缩缩略图的活儿。星标总览预览（build=false 那条路）会把没命中的那几张
 * 丢到后台慢慢缩，一次能同时飞十几个。
 *
 * 为什么要登记：这些活儿读的是**共享盘上的原图**，而 libvips 读输入的那一小段时间里
 * 源文件是删不掉的（win32 上实测 EBUSY）。所以「刚跑完星标总览 → 立刻删原图」撞的
 * 就是这些没 await 的读。删图前先把它们等完（见 drainInflightThumbs）就绕开了。
 * 注意这跟 sharp 的 job 活多久没关系 —— 管线跑完句柄就放了，问题只在「还在读」。
 */
const inflightThumbs = new Set<Promise<unknown>>();

/**
 * 等后台缩略图全部做完，最多等 maxMs 毫秒。
 * 上限是必须的：共享盘断连时那些 promise 可能永远不落地，删除不能被它拖死。
 * 只等进入这一刻已在飞的那些（快照），不等期间新起的。
 */
export async function drainInflightThumbs(maxMs = 3000): Promise<void> {
  if (inflightThumbs.size === 0) {
    return;
  }
  await Promise.race([
    Promise.allSettled([...inflightThumbs]),
    new Promise((r) => setTimeout(r, maxMs)),
  ]);
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
  // 不 await：这一次的预览不等它，下次进来看得见就命中了。
  // 但要登记进 inflightThumbs —— 它正在读共享盘上的原图，删图前得等它读完。
  const job = make().catch(() => undefined);
  inflightThumbs.add(job);
  void job.finally(() => inflightThumbs.delete(job));
  return Promise.resolve(null);
}

/**
 * 清掉某个缩略图根目录下属于该编号的全部缓存（封面 + 预览 + 图库里每张）。
 * 根目录由调用方给：本机那份传 thumbRoot(cacheDir)，共享那份传 sharedThumbRoot(...)。
 */
export function pruneThumbRoot(root: string, code: string): void {
  if (!root) {
    return;
  }
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
 * 清掉某编号的全部**本机**缩略图缓存（封面 + 预览 + 图库里每张）。改编号、删图、清空图片、
 * 删商品时调用：缓存目录在本机，不会自动同步给别人，所以必须按前缀一次删净，别只删封面那一枚。
 * 共享那份由调用方另外调 pruneThumbRoot(sharedThumbRoot(...)) —— 会不会写共享盘取决于是不是只读机。
 */
export function pruneCodeThumbs(cacheDir: string, code: string): void {
  if (!cacheDir) {
    return;
  }
  pruneThumbRoot(thumbRoot(cacheDir), code);
}

/**
 * 清掉某个缩略图根目录下 mtime 超过 keepDays 的旧缩略图。改过编号的商品，旧编号那几枚缓存
 * 再也没人会用到（库里已不存在该编号），留着只是各占一点磁盘；顺带兜住任何漏网的残留。
 * 也扫 .tmp：共享缓存写一半失败留下的临时文件没人会再碰它。
 */
export function pruneThumbRootByAge(root: string, keepDays: number): void {
  if (!root) {
    return;
  }
  const cutoff = Date.now() - keepDays * 86400000;
  try {
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith(".webp") && !f.endsWith(".webp.json") && !f.endsWith(".tmp")) {
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

/** 按天数清本机缩略图缓存；keepDays 的取舍见 pruneThumbRootByAge */
export function pruneOldThumbs(cacheDir: string, keepDays = 30): void {
  if (!cacheDir) {
    return;
  }
  pruneThumbRootByAge(thumbRoot(cacheDir), keepDays);
}
