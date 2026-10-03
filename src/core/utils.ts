import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

/**
 * 关掉 libvips 的全局缓存 —— **这一行是「图片删不掉（EBUSY）」的官方解药**。
 *
 * 症状：某张图只要在画册/列表里显示过（= 生成过缩略图），接下来几小时都删不掉，
 * 报 `EBUSY: resource busy or locked`。手机删不掉、VS Code 也删不掉、重启服务才好
 * —— 因为缓存是跟着进程走的，进程一退全清空，看起来就像"重启能治百病"。
 *
 * 原因：libvips 默认会**缓存输入文件**（默认最多 20 个打开的句柄 + 50MB/100 条），
 * 缓存里那条还在，共享盘上的文件句柄就不放。Windows/SMB 上这个句柄不带
 * FILE_SHARE_DELETE，于是谁都删不掉。sharp 作者的原话（写进了项目 issue 模板）：
 *   "The default behaviour of libvips is to cache input files, which can lead to
 *    EBUSY or EPERM errors on Windows. Use `sharp.cache(false)` to switch this off."
 *
 * 实测（2026-10-03，仓库在 Z: 共享盘上，探针=能否改名）：
 *   · sharp(文件路径)                 → EBUSY，等 5 秒仍锁   ← 元凶
 *   · sharp.cache({ files: 0 })       → **仍 EBUSY**（这条民间偏方没用，别再试）
 *   · sharp.cache(false)              → 不锁 ✅
 *   · sharp(读到内存的 Buffer)         → 不锁 ✅（备选；既然 cache(false) 零代价，用不着它）
 * 注意：以上只在**网络盘**上复现，本地 NTFS 盘上 libvips 读完真就放了。别把
 * 本地盘的结论外推到共享盘 —— 我第一次就是这么查错的。
 *
 * 代价：实测下来**没有可测的代价**（2026-10-03，Z: 共享盘，真实商品图，各跑两遍取第二遍）：
 *   · 5 张不同的图并发各缩 1 次：234ms（缓存开） vs 244ms（关）
 *   · 同一张图并发缩 10 次：     830ms vs 910ms
 *   · 同一张图出 3 种尺寸：       320ms vs 315ms
 *   · 同一张图**串行**缩 20 次：   74.1ms/次 vs 73.9ms/次  ← 连"缓存最容易生效"的场景都一样
 *   原因：我们的用法是 resize + webp 编码，大头在编码，libvips 缓存省下的那点解码根本看不出来。
 *   另注：早先量到过「33ms → 192ms」，那是只解不编的微基准，不能代表真实用法，别再引用。
 * 退路：真发现批量出图/星标总览变慢，再换 Buffer 方案（把字节读进内存再喂 sharp）。
 *
 * 放在模块顶层而不放函数里：这是**进程级**开关，且必须在任何 sharp 干活之前生效；
 * 本文件是所有"拿磁盘路径开 sharp"的唯一入口（有防回归测试守着），放这里不会漏。
 */
sharp.cache(false);

/** 造 sharp job 的入口，由 withSharpFile 注入；登记过的 job 会在回调结束时统一 destroy */
export type SharpFileOpener = (file: string, opts?: sharp.SharpOptions) => sharp.Sharp;

/**
 * 打开**磁盘上的图片**跑一段 sharp 处理，回调结束就 destroy，不等 GC。
 *
 * 先说清它能做什么、不能做什么（本地 NTFS 盘上量过，**共享盘上结论不同**，见下）：
 * libvips 只在**读输入**的那一小段时间里占着源文件，一读完就放开。所以
 *   - 管线跑完之后源文件一定删得掉 —— destroy 与否都一样；
 *   - 管线在飞的时候源文件删不掉（EBUSY）—— destroy 缩短不了这个窗口，那是「正在读」。
 * destroy 的真实作用是**立刻回收 job 对象本身**（C++ 侧对象 + 解码缓存那一格），
 * 而不是解锁文件；星标总览一次要开几十个 job，不回收就得等 GC 那一轮才还。
 *
 * ⚠️ 上面那段**只在本地盘成立**。在 SMB 共享盘上，libvips 的输入缓存会把文件句柄
 * 一直扣着（详见本文件顶部 `sharp.cache(false)` 的注释），表现就是"看图一时爽、删图删不掉"。
 * 那道锁跟 destroy 无关，是进程级的，靠顶上那行 `sharp.cache(false)` 治。
 * 它的第二个作用更值钱：把「拿磁盘路径开 sharp 就得登记回收」这条规矩收在一处，
 * 以后新写代码的人不用记得 destroy，也不会写出第四种花样。
 *
 * 用法：`await withSharpFile((f) => f(src).resize(...).toBuffer())`。
 * 只管**文件路径**入参：由 Buffer 构造的 job 不碰磁盘，destroy 掉纯浪费。
 * 回调里可以开多个 job（用 Set 兜住），也允许直接 return 一个 sharp 的 promise。
 */
export async function withSharpFile<T>(
  run: (input: SharpFileOpener) => T | Promise<T>,
): Promise<T> {
  const jobs = new Set<sharp.Sharp>();
  const input: SharpFileOpener = (file, opts) => {
    const job = opts ? sharp(file, opts) : sharp(file);
    jobs.add(job);
    return job;
  };
  try {
    return await run(input);
  } finally {
    for (const job of jobs) {
      job.destroy();
    }
    jobs.clear();
  }
}

/** 读取本地图片，原生fs转base64 dataUrl */
export async function readImageToBase64(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  // 每种后缀都显式列出，别靠默认兜底：data URL 里的标签是接收方唯一的判据，
  // 标错会渲染成一张打不开的图。早先漏了 .gif，GIF 会掉进默认的 image/jpeg。
  let mime = "image/jpeg";
  if (ext === ".png") {mime = "image/png";}
  else if (ext === ".webp") {mime = "image/webp";}
  else if (ext === ".bmp") {mime = "image/bmp";}
  else if (ext === ".gif") {mime = "image/gif";}
  else if (ext === ".jpg" || ext === ".jpeg") {mime = "image/jpeg";}
  return `data:${mime};base64,${buf.toString("base64")}`;
}
