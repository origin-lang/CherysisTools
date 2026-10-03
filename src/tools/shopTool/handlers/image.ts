import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Handler, HandlerCtx, runLongTask } from "./types.js";
import { readImageToBase64 } from "../../../core/utils.js";
import {
  UPLOAD_FILTER,
  IMAGE_EXTS,
  listImageFiles,
  thumbToCachedBase64,
  drainInflightThumbs,
  sharedThumbReady,
  sharedThumbRoot,
  pruneThumbRoot,
  SharedThumbCache,
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

/**
 * 大图请求里的 `name` 来自 webview，拼进 path.join 就是一条任意路径，`../../x` 能逃出
 * 商品夹读到别人的文件。只认「同目录下的纯文件名」。真正的取值还会在调用处再过一遍
 * listImageFiles 的白名单（文件可能刚被别人删掉）。
 */
const isPlainImageName = (n: string): boolean =>
  !!n && n !== "." && n !== ".." && !/[\\/]/.test(n) && !n.startsWith(".");

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 扫目录的并发数：与读原图同一套取舍（IMG_READ_CONCURRENCY=3），这里目录小得多，可以放宽到 8 */
const DIR_SCAN_CONCURRENCY = 8;

/** 并发跑但**结果按输入下标归位**，调用方依赖位置对应（拼图那类逻辑就靠这个） */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

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
	waits: number[] = [0, 150, 400, 1000],
): Promise<void> {
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

/**
 * 占用探针：把文件在**同目录内**改名一下再改回来。
 *
 * 为什么这个探针能自证：Windows 上 rename 和 unlink 走的是同一个 DELETE 权限检查，
 * 共享盘上更是同一套 SMB 语义。所以
 *   - rename 也失败 → 那一刻确实有别人开着它（锁），不是权限/路径/只读的问题；
 *   - rename 成功   → 那一刻没有锁，能改名就能删除，直接再点一次删除即可。
 * 同一目录内改名，字节内容与 mtime 都不变，只是极短时间内换了个名字。
 */
function probeLock(fp: string): { locked: boolean; detail: string } {
  const probe = path.join(path.dirname(fp), `.lockprobe_${path.basename(fp)}`);
  try {
    fs.renameSync(fp, probe);
  } catch (err: any) {
    return { locked: true, detail: err?.code || String(err?.message || err) };
  }
  try {
    fs.renameSync(probe, fp);
    return { locked: false, detail: "" };
  } catch (err: any) {
    // 改走了却没能改回来：文件没丢，只是名字变了。如实说出来，别默默吞掉。
    return { locked: false, detail: `没能改回原名，现在叫 ${probe}（${err?.code || err}）` };
  }
}

/**
 * 删图专用的「等后台读完 → 再删」。
 *
 * 为什么要比 clearImages 那套更耐心：夹里**第一张 = 封面**，列表 / 画册 / 详情页每翻一页
 * 都在读它，本进程自己刚读完、句柄还没回收的概率远高于后面几张 —— 表现就是
 * 「第一张总是删不掉，删第二张反而一次成功」。所以第一轮先等 8 秒（原来统一只等 3 秒，
 * 后台一张缩略图在共享盘上就要 1~3 秒，3 秒根本等不完）；等完再失败说明期间又有新的
 * 后台任务把它读上了，再等一轮短的。两轮都失败才认输。
 *
 * 只等**进入这一刻**已在飞的任务（drainInflightThumbs 的语义），期间新起的不等，
 * 所以不会被人一直翻页无限拖住。
 */
const DELETE_DRAIN_MS = [8000, 3000];

async function unlinkForDelete(fp: string, unlink: (p: string) => void): Promise<void> {
  let last: any = null;
  for (const maxMs of DELETE_DRAIN_MS) {
    await drainInflightThumbs(maxMs);
    try {
      await unlinkWithRetry(fp, unlink, [0, 250, 800, 1500]);
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

/**
 * 图片的「心跳」：往库里写一个时间戳。
 *
 * 为什么非得写库：图片活在共享盘的**文件系统**里，增删改一个字节都不碰数据库。而各端判断
 * 「有没有变化」全靠 `PRAGMA data_version`（只有**别的连接**提交过才变），所以 A 端删了图、
 * B 端永远发现不了 —— 表现就是「这边删了，那边还显示旧图」，连刷新页面都救不了。
 *
 * 写这一行之后，两端**现成的** 3 秒巡检立刻就能看见它：VS Code 面板自动重刷，网页端收到
 * SSE 的 changed 会自动重读并换掉图片 URL 版本号。等于不新建任何通道就补上了图片同步。
 *
 * 成本是一次单行写入（比删图时"整库备份 4 秒"便宜两个数量级），且刻意**不走 preOpBackup**
 * —— 那道 4 秒是为了回滚**数据**，图片改动没数据可回滚，白等。
 * 连续传十几张图会写十几次，所以做了 2 秒节流（末尾补一次）。
 */
const IMG_STAMP_KEY = "image_stamp";
const IMG_STAMP_THROTTLE_MS = 2000;
let lastImgStampAt = 0;
let imgStampTimer: ReturnType<typeof setTimeout> | null = null;

function bumpImageStamp(h: HandlerCtx): void {
  const write = () => {
    imgStampTimer = null;
    lastImgStampAt = Date.now();
    // 不 await：这只是个通知，写失败（只读模式 / 库正忙）也不该拖住图片操作本身
    void Promise.resolve(h.setSetting(IMG_STAMP_KEY, String(lastImgStampAt))).catch(() => undefined);
  };
  const gap = Date.now() - lastImgStampAt;
  if (gap >= IMG_STAMP_THROTTLE_MS) {
    write();
    return;
  }
  if (imgStampTimer) {
    return;
  }
  imgStampTimer = setTimeout(write, IMG_STAMP_THROTTLE_MS - gap);
}

/** 占用类报错的统一话术：说清是「被占用」而不是把 EBUSY 甩给用户 */
export function busyHint(subject: string, err: any, fp?: string): string {
  const head = `⚠️${subject}（${err?.message || "未知错误"}）`;
  if (!RETRYABLE_UNLINK.has(err?.code)) {
    return head;
  }
  const lines = [
    head,
    `　文件正被占用。删图前请先关掉正在看的大图预览；` +
      `如果是别的机器（或 Windows 资源管理器）正打开着这张图，也关掉再试。`,
  ];
  const name = fp ? path.basename(fp) : "";
  if (name) {
    const probe = probeLock(fp as string);
    lines.push(
      probe.locked
        ? `　自证：改名探针**也失败**了（${probe.detail}）→ 确实是锁，不是权限或路径问题。`
        : `　自证：改名探针**成功**了${probe.detail ? `（${probe.detail}）` : ""}` +
            ` → 此刻已经没有锁（能改名就能删除），直接再点一次删除即可。`,
    );
    lines.push(
      `　最可能是这三类占用者之一：` +
        `① 本机 VS Code 正显示着这张大图，Chromium 攥着句柄 → 关掉大图浮层；` +
        `② 本机照片查看器 / 资源管理器预览窗格正开着它；` +
        `③ 共享盘那台提供方机器上有会话正开着它（对方没开 FILE_SHARE_DELETE，协议如此，重试无解）。`,
    );
    lines.push(
      `　查是谁占着（两条命令直接粘）：` +
        `本机 → handle.exe -nobanner "${name}"` +
        `　共享提供方那台机器（PowerShell）→ ` +
        `Get-SmbOpenFile | Where-Object { $_.Path -like "*${name}*" }`,
    );
  }
  return lines.join("\n");
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

/**
 * clearOneFolder 的返回值。busy 与 failed 分开是因为两者的下一步动作不一样：
 * busy 是「另一台机器开着这些图」，重试或让对方关掉才行；failed 是权限/路径这类
 * 本机问题，重试没意义。合成一档的话日志只能给一句套话，等于把两种病都当绝症。
 */
type ClearResult = {
  outcome: "cleared" | "empty" | "nofolder" | "busy" | "failed";
  ok: number;
  total: number;
  lastErr: any;
  firstBusy: string | null;
};

/**
 * 「生成共享缩略图」的并发度：瓶颈在共享盘带宽和 libvips 解码，4 路实测够把千兆网吃满；
 * 再往上对总时长没什么帮助，反而会跟同时在看图的人抢带宽。
 */
const BUILD_SHARED_CONCURRENCY = 4;

/** 同一时间只允许一次预生成：连点两下不该起两个任务把共享盘打满 */
let buildSharedRunning = false;

type BuildJob = { code: string; src: string; fileName?: string };

/**
 * 把所有商品的封面 + 图库每张缩略图预先缩进共享缓存。主机上点一次，客机第一次打开某个商品
 * 就能直接读到几十 KB 的小图，而不是从共享盘拉几 MB 的原图现缩。
 *
 * 封面那一轮先跑：列表和画册只看封面，先让「翻商品」快起来；图库（点开详情才看）排后面。
 * 已经在共享缓存里、且指纹对得上的直接跳过（只看 meta 不读图），所以重复点也只是扫一遍。
 */
async function runBuildSharedThumbs(root: string, imgDir: string, h: HandlerCtx): Promise<void> {
  const startedAt = Date.now();
  const products = h.db.getProducts();
  const folders: Array<{ code: string; files: string[] }> = [];
  for (const p of products) {
    const files = listImageFiles(path.join(imgDir, p.code));
    if (files.length) {
      folders.push({ code: p.code, files });
    }
  }
  if (folders.length === 0) {
    h.log("ℹ没有可生成的图片（所有商品夹都是空的）");
    return;
  }
  const covers: BuildJob[] = folders.map((f) => ({
    code: f.code,
    src: path.join(imgDir, f.code, f.files[0]),
  }));
  const rest: BuildJob[] = [];
  for (const f of folders) {
    for (const name of f.files) {
      rest.push({ code: f.code, src: path.join(imgDir, f.code, name), fileName: name });
    }
  }
  const queue = [...covers, ...rest];
  const total = queue.length;
  h.log(
    `🖼开始生成共享缩略图：${folders.length} 个有图商品 / ${total} 张（先跑 ${covers.length} 张封面）→ ${root}`,
  );
  let next = 0;
  let made = 0;
  let skipped = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue[next++];
      if (!job) {
        return;
      }
      if (sharedThumbReady(job.src, root, job.code, job.fileName)) {
        skipped++;
      } else {
        try {
          const data = await thumbToCachedBase64(
            job.src,
            h.ctx.defaultStorageDir,
            job.code,
            job.fileName,
            { root, writable: true },
          );
          if (data) {
            made++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
      const done = made + skipped + failed;
      // 每 50 张报一次：这个循环可能跑几分钟，不报进度用户不知道它到底在动没有
      if (done % 50 === 0 && done < total) {
        h.log(`…共享缩略图 ${done}/${total}（新生成 ${made}、已有 ${skipped}、失败 ${failed}）`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BUILD_SHARED_CONCURRENCY, total) }, () => worker()),
  );
  const secs = Math.round((Date.now() - startedAt) / 1000);
  h.log(
    `✅共享缩略图完成：新生成 ${made} 张、已有 ${skipped} 张、失败 ${failed} 张（共 ${total} 张，用时 ${secs} 秒）`,
  );
}

export function imageHandlers(h: HandlerCtx, deps: ImageHandlerDeps = {}): Record<string, Handler> {
  const { log, post } = h;
  const ctx = h.ctx;
  const unlinkFile = deps.unlink ?? ((fp: string) => fs.unlinkSync(fp));

  const imageDir = (): string => h.imageDir();

  // 缩略图缓存一律放本机（defaultStorageDir），不放共享数据目录：缓存键含绝对源路径，
  // 各人在共享盘上的盘符写法不同，共用一份会每次判定失效并互相覆写。
  const cacheDir = (): string => ctx.defaultStorageDir;

  // 第二级：共享盘上的那份缩略图（客机第一次看图时不用读原图，见 images.ts SHARED_THUMB_DIRNAME）。
  // 只在另配了 cherysis.storageDir 时才有（没配就没人会来读，白占磁盘）。
  const sharedRoot = (): string => sharedThumbRoot(ctx.storageDir, ctx.defaultStorageDir);

  /**
   * 传给 thumbToCachedBase64 的共享层参数。只读模式给它 writable:false：
   * 共享缓存照读（正是只读机最需要的加速），但一张都不往共享盘上写 —— 只读模式的承诺就是
   * 「不碰共享盘」，缓存再小也是写。
   */
  const sharedOpts = (): SharedThumbCache | undefined => {
    const root = sharedRoot();
    return root ? { root, writable: !h.readOnly() } : undefined;
  };

  // 大图优先给宿主提供的图片 URL（VS Code 是 webview 资源 URI）：原图动辄几 MB，
  // 转 base64 再 postMessage 一次就是几十 MB 流量，而且每次点开放大都要重来一遍。
  // URI 由浏览器自己流式解码，0 拷贝、100% 原图、放大不糊。
  // VS Code 侧的前提是该文件在面板的 localResourceRoots 白名单里；
  // 加载不出来时前端 onerror 回退请求 base64 通道。
  const webviewUri = (fp: string): string => ctx.imageUrl(fp);

  /** 批量日志里报编号只列前几个：勾 200 个商品全列出来，日志面板直接没法看了 */
  const sampleCodes = (codes: string[]): string =>
    codes.length <= 6 ? codes.join("、") : `${codes.slice(0, 6).join("、")}…`;

  /**
   * 清空**一个**商品的图片夹，删的是共享盘上的真文件。
   *
   * 单个和批量两个入口共用这一份，理由是措辞必须一致：单个版曾经有个 bug 是 catch {}
   * 空吞掉单张失败、照样报「已清空 N 张」，属于谎报（有测试钉着）。批量版要是另写一遍
   * 循环，同一个谎报就会在第二个入口原样重演。
   *
   * 只删文件、不碰数据库，调用方也不用为它 preOpBackup（备份的是 shop.db，对图零信息量）。
   */
  const clearOneFolder = async (code: string): Promise<ClearResult> => {
    const dir = imageDir();
    const folder = path.join(dir as string, code);
    if (!fs.existsSync(folder)) {
      return { outcome: "nofolder", ok: 0, total: 0, lastErr: null, firstBusy: null };
    }
    const files = listImageFiles(folder);
    let ok = 0;
    let busy = 0;
    let lastErr: any = null;
    let firstBusy: string | null = null;
    for (const f of files) {
      const fp = path.join(folder, f);
      try {
        await unlinkWithRetry(fp, unlinkFile);
        ok++;
      } catch (err: any) {
        lastErr = err;
        if (RETRYABLE_UNLINK.has(err?.code)) {
          busy++;
          firstBusy ??= fp;
        }
      }
    }
    const r = { ok, total: files.length, lastErr, firstBusy };
    if (files.length === 0) return { ...r, outcome: "empty" };
    if (busy === 0 && ok === files.length) return { ...r, outcome: "cleared" };
    // busy 单独一档：它要说的是「另一台机器正开着这些图」，跟「权限/路径不对」不是一回事
    if (busy > 0) return { ...r, outcome: "busy" };
    return { ...r, outcome: "failed" };
  };

  /** 单个入口的日志：一个夹一次，把话说全（含被占用的排查提示） */
  /**
   * 操作失败时给用户的一行**红字提示**。
   *
   * 为什么不能只写日志：日志区是排查用的，默认收在页面底部，普通用户根本不看 ——
   * 结果就是「点了删除，弹了个成功提示，图还在那儿」，看着像前端撒谎。
   * 而且前端原来只能靠**扫日志字符串**（找"删不掉"）判成败，改一句文案就失灵。
   * 这里改成后端显式发一条 `toast`（bad: true 走红样式），成败有据可依。
   * 详细的自证信息（谁占着、怎么查）仍然写进日志，两条路各管一层。
   */
  const failToast = (text: string): void => {
    post({ type: "toast", text: `⚠️${text}`, bad: true });
  };

  const logClearOne = (code: string, r: ClearResult): void => {
    if (r.outcome === "nofolder") {
      log(`⚠️${code} 无图片文件夹`);
    } else if (r.outcome === "empty") {
      log(`🗑${code} 图片夹本来就是空的`);
    } else if (r.outcome === "cleared") {
      log(`🗑已清空 ${code} 图片文件夹（${r.ok} 张）`);
    } else if (r.outcome === "busy") {
      // 原来这里是 catch {} 空吞掉单张失败、照样报「已清空 N 张」，属于谎报
      log(
        `${busyHint(`清空 ${code} 图片夹失败`, r.lastErr, r.firstBusy ?? undefined)}\n` +
          `　本次只删掉了 ${r.ok}/${r.total} 张，剩下的还在。` +
          `请确认图库抽屉已关、别的机器没在看这些图，再点一次「清空图片夹」。`,
      );
      failToast(`清空 ${code} 图片夹只删掉 ${r.ok}/${r.total} 张`);
    } else {
      log(`⚠️清空 ${code} 图片夹只成功 ${r.ok}/${r.total} 张（${r.lastErr?.message || ""}）`);
      failToast(`清空 ${code} 图片夹只删掉 ${r.ok}/${r.total} 张`);
    }
  };

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
    return thumbToCachedBase64(path.join(folder, files[0]), cacheDir(), code, undefined, sharedOpts());
  };

  const reloadImages = async (code: string) => {
    const dir = imageDir();
    const folder = path.join(dir, code);
    const files = listImageFiles(folder);
    const imgs: string[] = [];
    for (const name of files) {
      imgs.push(
        await thumbToCachedBase64(path.join(folder, name), cacheDir(), code, name, sharedOpts()),
      );
    }
    // 首张大图只发 URI 不发 base64：图库里其它张点开放大时按需取
    // names 与 images 严格同序。前端拿文件名当每张图的身份，删掉第 1 张后第 2 张顶到
    // 序号 0 也不会张冠李戴（用序号当身份时，那正是「删完大图还是旧的」那个 bug）
    post({
      type: "imagesLoaded",
      code,
      images: imgs,
      names: files,
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
        post({ type: "imagesLoaded", code, images: [], names: [] });
        return;
      }
      await reloadImages(code);
    },

    /**
     * 统计每个编号有几张图（给「筛出还没传图的商品」用）。
     *
     * 为什么不塞进 loadAll：图片是**按编号文件夹**放在 imageDir 里的，不在数据库里，
     * 要知道有没有图就得读目录。共享盘上一次 readdir 就是一趟 SMB 往返，
     * 而 loadAll 是每次刷新、每次改完数据都要走的 —— 128 个编号扫一遍会明显拖慢日常操作。
     * 所以做成独立消息：只有前端真的要用这个筛选时才来要一次，算完自己缓存。
     *
     * 并发数与 images.ts 读原图同理：瓶颈是往返不是 CPU，串行在共享盘上要等死。
     */
    async loadImageStats(msg) {
      const dir = imageDir();
      const codes: string[] = Array.isArray(msg.codes) ? (msg.codes as unknown[]).map((c) => String(c)) : [];
      const stats: Record<string, number> = {};
      if (dir && codes.length) {
        await mapLimited(codes, DIR_SCAN_CONCURRENCY, async (code) => {
          try {
            const files = await fs.promises.readdir(path.join(dir, code));
            stats[code] = files.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase())).length;
          } catch {
            stats[code] = 0; // 没这个夹、或读不到，都按「没图」算 —— 这正是要找出来补图的
          }
        });
      }
      post({ type: "imageStatsLoaded", stats });
    },

    async getFullImage(msg) {
      const code = String(msg.code ?? "");
      const dir = imageDir();
      const folder = dir ? path.join(dir, code) : "";
      const idx = Number(msg.index ?? 0);
      const rawName = typeof msg.name === "string" ? msg.name : "";
      const files = folder ? listImageFiles(folder) : [];
      // 传了 name 就以它为准：文件名才是这张图的身份，序号会因前面几张被删而错位。
      // 传了但不老实（带分隔符、以点开头）就当这张取不到，**不**退回 index——退回等于
      // 「点第 3 张返回第 1 张」，正是这里要根除的那类错位。
      const name = rawName ? (isPlainImageName(rawName) ? rawName : null) : files[idx];
      const fp = folder && name && files.includes(name) ? path.join(folder, name) : null;
      const reply = (extra: Record<string, unknown>) =>
        post({ type: "fullImageLoaded", code, index: idx, name: name ?? "", ...extra });
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
      bumpImageStamp(h); // 让别的端也知道这个夹子动过（详见 bumpImageStamp 的注释）
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
        bumpImageStamp(h);
      } else if (skipped) {
        log(`🖼${skipped} 张图与已有内容重复，未新增（${code}）`);
      }
    },

    async clearImages(msg) {
      const code = String(msg.code ?? "");
      if (!imageDir()) {
        log("❌未配置图片根目录");
        return;
      }
      if (!isPlainImageName(code)) {
        log(`⚠️商品编号不合法：${code}`);
        return;
      }
      // 同 deleteImageFile：清空图片夹也不碰数据库，不该为它白拷一次整库
      // 先把后台缩缩略图的活儿等完：它们正在读的就是这个夹里的原图，读的时候删不掉
      await drainInflightThumbs();
      const r = await clearOneFolder(code);
      logClearOne(code, r);
      post({ type: "imagesLoaded", code, images: [], names: [] });
      bumpImageStamp(h);
      h.invalidateCover(code);
    },

    /**
     * 批量清空：一次收一批商品编号，逐个清空。
     *
     * 不做成「webview 连发 N 条 clearImages」是有原因的：那会让 webview 收到 N 轮封面
     * 作废通知，共享盘上每次重新取图都要走一趟目录，勾 50 个就是 50 趟；
     * 而且中途每一条都往日志里写一行，最后用户看到 50 行「已清空」不知道哪几个真成了。
     * 这里改成逐个清、汇总成**一条**日志，失败的编号单独列出来。
     * 单个 clearImages 同样不重载整表：封面作废走 coverInvalidated，前端自己重取那一格。
     */
    async clearImagesBatch(msg) {
      const dir = imageDir();
      if (!dir) {
        log("❌未配置图片根目录");
        return;
      }
      const raw: string[] = Array.isArray(msg.codes) ? msg.codes : [];
      // 去重 + 只认纯单段编号：code 会被拼进 path.join(dir, code)，`../x` 能逃出图片根目录。
      // 这跟 isPlainImageName 是同一条道理，那条守的是夹内的 name，这里守的是夹名 code。
      const codes = [...new Set(raw.map((c) => String(c)).filter(isPlainImageName))];
      const rejected = raw.length - codes.length;
      if (codes.length === 0) {
        log(rejected > 0 ? "⚠️没有合法的商品编号可清空" : "⚠️没有勾选商品");
        return;
      }
      // 队列是全局的：等一次就够，后面每个夹子都不会再有后台缩略图在读
      await drainInflightThumbs();
      const done: string[] = [];
      const empty: string[] = [];
      const noFolder: string[] = [];
      const stuck: { code: string; ok: number; total: number; lastErr: any; firstBusy: string | null }[] = [];
      for (const code of codes) {
        const r = await clearOneFolder(code);
        // 逐个推：灯箱开着的话它按 code 认领，合并成一条它就不知道该刷哪一格了。
        // 没删到东西的（空夹/没夹）也要推——夹可能是刚被别人删的，覆盖缓存照样得作废。
        post({ type: "imagesLoaded", code, images: [], names: [] });
        h.invalidateCover(code);
        if (r.outcome === "cleared") done.push(code);
        else if (r.outcome === "empty") empty.push(code);
        else if (r.outcome === "nofolder") noFolder.push(code);
        else stuck.push({ code, ok: r.ok, total: r.total, lastErr: r.lastErr, firstBusy: r.firstBusy });
      }

      // ---- 汇总成一条，别让勾 50 个变成日志里 50 行 ----
      const lines: string[] = [];
      if (done.length) {
        lines.push(`🗑已清空 ${done.length} 个商品的图片文件夹：${sampleCodes(done)}`);
      }
      if (stuck.length) {
        const brief = stuck
          .slice(0, 5)
          .map((s) => `${s.code}（只删掉 ${s.ok}/${s.total} 张）`)
          .join("、");
        const more = stuck.length > 5 ? `，…等 ${stuck.length} 个` : "";
        const first = stuck[0];
        lines.push(
          `⚠️${stuck.length} 个没清干净：${brief}${more}\n` +
            `　最常见的原因是图库抽屉没关、或另一台机器正看着这些图。关掉之后对这几个再点一次即可。` +
            (first.firstBusy ? `\n　${busyHint("被占用的文件", first.lastErr, first.firstBusy)}` : ""),
        );
      }
      if (empty.length) {
        lines.push(`·${empty.length} 个图片夹本来就是空的：${sampleCodes(empty)}`);
      }
      if (noFolder.length) {
        lines.push(`·${noFolder.length} 个没有图片文件夹：${sampleCodes(noFolder)}`);
      }
      if (rejected > 0) {
        lines.push(`·另有 ${rejected} 个编号不合法，已跳过`);
      }
      log(lines.join("\n"));
      bumpImageStamp(h);
    },

    async openImageFile(msg) {
      const code = String(msg.code ?? "");
      const dir = imageDir();
      if (!dir) {
        log("❌未配置图片根目录");
        return;
      }
      const folder = path.join(dir, code);
      // 夹还没建时也把用户送到能落手的地方：reveal 图片根目录，而不是一句「没有图片文件夹」
      // 就什么都不做。灯箱里一张图都没有时右键菜单只剩「打开图片文件夹」这一项，它不能是死路。
      // 保持只读（不 mkdir）：共享盘上要不要建这个目录，不该由一次右键菜单替用户决定。
      const target = fs.existsSync(folder) ? folder : dir;
      try {
        await ctx.revealInOS(target);
        if (target !== folder) {
          log(`📂${code} 还没有图片文件夹，已打开图片根目录（图放进 ${code} 子夹即可，或在灯箱里点上传）`);
        }
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
      // 同 getFullImage：优先按文件名删（前端弹菜单时就知道这张叫什么）。序号只在
      // 收不到 name 时兜底——别人在这期间删掉前面一张，序号就已经指到别的文件了，
      // 那样会删掉用户没点的那张。
      const rawName = typeof msg.name === "string" ? msg.name : "";
      const name = rawName ? (isPlainImageName(rawName) ? rawName : null) : files[index];
      const fp = folder && name && files.includes(name) ? path.join(folder, name) : null;
      if (!fp) {
        log(`⚠️${code} 没有第 ${index + 1} 张图片`);
        // 也是失败：用户点了删除、结果什么都没发生，不提示就成了「点了没反应」
        failToast(`${code} 已经没有第 ${index + 1} 张图了，没删成（可能刚被别台机器删掉）`);
        return;
      }
      // 刻意不 preOpBackup：删图只动文件系统、一个字节都不写数据库，
      // 备份出来的库跟操作前一模一样，纯白等一次共享盘整库拷贝（实测 4 秒）。
      // 本机的备份也不留——真要找回误删的图，去共享盘上的图片夹里翻原件。
      // 删图前先把后台读原图的活儿等完（详见 unlinkForDelete：夹里第一张是封面，
      // 被读得最多，锁也最久，这里的等待是按删图单独放宽过的）
      try {
        await unlinkForDelete(fp, unlinkFile);
      } catch (err: any) {
        // 失败也要把磁盘的真实情况推回前端，否则列表/图库停在「还在」的状态，
        // 用户分不清到底删掉没有
        log(busyHint(`删不掉 ${code} 的第 ${index + 1} 张图片`, err, fp));
        await reloadImages(code);
        h.invalidateCover(code);
        failToast(`删不掉 ${code} 的第 ${index + 1} 张图片（多半正被占用），图还在，稍等再试`);
        return;
      }
      log(`🗑已删除 ${code} 的第 ${index + 1} 张图片`);
      await reloadImages(code);
      h.invalidateCover(code);
      bumpImageStamp(h); // 同上：删图不写库的话，别的端永远看不到
    },

    /**
     * 删封面图：列表/画册里右键封面直接删掉「当前当封面那张」。
     *
     * 为什么不复用 deleteImageFile（那个是给灯箱按名字删指定那张的）：封面 = 夹里
     * listImageFiles 排序后的第一张（跟 getCover 的 readCover 同一口径），这个知识
     * 在后台。前端菜单只知道「这个商品有封面」，不知道它叫什么——按序号发过去的话，
     * 从弹菜单到请求到达之间夹子被别台机器动过，序号就指到别的文件上了。
     * 所以这里由后台自己认「第一张是谁」再删，不收 name/index。
     *
     * 只删一张不动数据库、不做整库备份（同 deleteImageFile 的取舍）。
     */
    async deleteCoverImage(msg) {
      const code = String(msg.code ?? "");
      const dir = imageDir();
      if (!dir) {
        log("❌未配置图片根目录");
        return;
      }
      const folder = path.join(dir, code);
      const files = listImageFiles(folder);
      if (files.length === 0) {
        log(`ℹ${code} 本来就没有图片，无需删除`);
        return;
      }
      const fp = path.join(folder, files[0]);
      // 封面就是夹里第一张，同 deleteImageFile：等后台读完再删（这里同样放宽了等待）
      try {
        await unlinkForDelete(fp, unlinkFile);
      } catch (err: any) {
        // 失败也把磁盘现状推回去，否则列表/画册停在「还有图」的状态，用户分不清删掉没有
        log(busyHint(`删不掉 ${code} 的封面图`, err, fp));
        await reloadImages(code);
        h.invalidateCover(code);
        failToast(`删不掉 ${code} 的封面图（多半正被占用），图还在，稍等再试`);
        return;
      }
      log(`🗑已删除 ${code} 的封面图${files.length > 1 ? "（下一张自动顶上来当封面）" : ""}`);
      await reloadImages(code);
      h.invalidateCover(code);
      bumpImageStamp(h);
    },

    /**
     * 主机上的「生成共享缩略图」：把全部商品的封面 + 图库小图预先缩进共享缓存，
     * 客机第一次打开某个商品就直接读几十 KB 的小图（见 images.ts SHARED_THUMB_DIRNAME）。
     *
     * 刻意不 await：上千张图要从共享盘读原图现缩，跑起来几分钟，卡在 handler 里这段时间
     * 整个面板的消息都排在这后面。改成后台跑 + 日志报进度（日志区就在页面底部，看得见）。
     * 只读模式由 index.ts 的 WRITE_ACTIONS 在入口拦下（它要写共享盘），这里不用再判一次。
     */
    buildSharedThumbs() {
      const root = sharedRoot();
      if (!root) {
        log(
          "⚠️没有可共享的缓存位置：本机用的就是 VS Code 默认存储目录。先到「规则与设置 → 数据库备份/恢复」点「📁 更换…」，把数据目录指到共享盘（各台机器指同一份），再来生成",
        );
        return;
      }
      const dir = imageDir();
      if (!dir) {
        log("⚠️未配置商品图片根目录，无法生成缩略图");
        return;
      }
      if (buildSharedRunning) {
        log("ℹ共享缩略图正在生成中，不用重复点（进度看下面几行）");
        return;
      }
      buildSharedRunning = true;
      // 交给宿主（runLongTask 是长活儿的唯一入口）：VS Code 立刻跑（与以前一字不差），
      // 网页版进服务端队列（同一时刻只跑一个重活），排队与进度走 SSE。
      // 这里**故意不 await**（与改之前一样）：上千张图要跑几分钟，卡在 handler 里会把
      // 后面的消息全堵住 —— 进度是靠日志/SSE 报的。
      void runLongTask(h, "生成共享缩略图", () =>
        runBuildSharedThumbs(root, dir, h)
          .catch((err: any) => log(`❌生成共享缩略图失败：${err?.message ?? err}`))
          .finally(() => {
            buildSharedRunning = false;
          }),
      );
    },
  };
}