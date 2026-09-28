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
  drainInflightThumbs,
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
    } else {
      log(`⚠️清空 ${code} 图片夹只成功 ${r.ok}/${r.total} 张（${r.lastErr?.message || ""}）`);
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
      h.invalidateCover(code);
      h.loadAll();
    },

    /**
     * 批量清空：一次收一批商品编号，逐个清空，只在最后 loadAll() 一次。
     *
     * 不做成「webview 连发 N 条 clearImages」是有原因的：每条都会 loadAll()，
     * 而 loadAll() 是把整张商品表重读一遍重推 webview（见 §loadAll 注释），
     * 勾 50 个就是读 50 趟全库、外加刷新 50 次封面缓存——共享盘上这是几十秒的等待，
     * 而且中途每一条都往日志里写一行，最后用户看到 50 行「已清空」不知道哪几个真成了。
     * 这里改成逐个清、汇总成**一条**日志，失败的编号单独列出来。
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
      h.loadAll();

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
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target));
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
        return;
      }
      // 刻意不 preOpBackup：删图只动文件系统、一个字节都不写数据库，
      // 备份出来的库跟操作前一模一样，纯白等一次共享盘整库拷贝（实测 4 秒）。
      // 本机的备份也不留——真要找回误删的图，去共享盘上的图片夹里翻原件。
      // 先把后台缩缩略图的活儿等完：星标总览预览会往后台扔十几个「读原图」的任务，
      // 不等就删的话正好撞上人家在读（libvips 读输入期间源文件是锁着的），这就是
      // 「谁跑过星标总览谁就删不掉」的成因。上限 3 秒，断连的共享盘拖不死删除。
      await drainInflightThumbs();
      try {
        await unlinkWithRetry(fp, unlinkFile);
      } catch (err: any) {
        // 失败也要把磁盘的真实情况推回前端，否则列表/图库停在「还在」的状态，
        // 用户分不清到底删掉没有
        log(busyHint(`删不掉 ${code} 的第 ${index + 1} 张图片`, err, fp));
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