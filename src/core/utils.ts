import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

/** 造 sharp job 的入口，由 withSharpFile 注入；登记过的 job 会在回调结束时统一 destroy */
export type SharpFileOpener = (file: string, opts?: sharp.SharpOptions) => sharp.Sharp;

/**
 * 打开**磁盘上的图片**跑一段 sharp 处理，回调结束就 destroy，不等 GC。
 *
 * 先说清它能做什么、不能做什么（这点在 win32 上量过，别再按「句柄等 GC」去理解）：
 * libvips 只在**读输入**的那一小段时间里占着源文件，一读完就放开。所以
 *   - 管线跑完之后源文件一定删得掉 —— destroy 与否都一样；
 *   - 管线在飞的时候源文件删不掉（EBUSY）—— destroy 缩短不了这个窗口，那是「正在读」。
 * destroy 的真实作用是**立刻回收 job 对象本身**（C++ 侧对象 + 解码缓存那一格），
 * 而不是解锁文件；星标总览一次要开几十个 job，不回收就得等 GC 那一轮才还。
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
