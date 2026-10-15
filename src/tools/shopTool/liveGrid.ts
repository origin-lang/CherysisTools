import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { withSharpFile } from "../../core/utils.js";

// 本文件里凡是拿**磁盘路径**开 sharp 的地方都走 withSharpFile（结束即 destroy 句柄）。
// 星标总览 / 九宫格会把几十张原图解码一遍，句柄不关的话「刚跑完总览就删原图」必撞 EBUSY。
// 剩下那两处裸调用是「新建一张空白画布」，不碰磁盘句柄，不需要。

// 落盘文件名的时间戳：精确到秒（YYYYMMDD-HHMMSS）。
// 只到日的话，同一天把同一组重生成一次就直接覆盖掉上一张 —— 调排版、改格子再出一次图，
// 旧图没了，新旧也没法比。秒级足够把同一天的多次生成区分开。
export function localStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function emptyCellSvg(w: number, h: number): string {
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#ffffff"/>
  </svg>`;
}

function labelSvg(w: number, h: number, text: string): string {
  const fs = Math.max(16, Math.round(Math.min(w, h) * 0.08));
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="${Math.round(h * 0.93)}" font-family="'Consolas','Segoe UI',monospace" font-weight="500" font-size="${fs}" fill="#ffffff" stroke="#000000" stroke-width="${Math.max(6, Math.round(fs * 0.18))}" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle" dominant-baseline="bottom">${text}</text>
  </svg>`;
}

// 星标总览图：根据 labels 选项在底部压一行文字，白字黑描边。
// labels.fontSize>0 时字号＝占格子边长的百分比（0=按格子自动缩放）。
// 预览(每格≤360px)与生成(每格≤1024px)两者的字/格相对比例完全一致，所见即所得。
export type StarLabelOptions = {
  code: boolean;
  costPrice: boolean;
  salePrice: boolean;
  fontSize: number;
};

function starLabelSvg(
  w: number,
  h: number,
  code: string,
  price: number,
  costPrice: number,
  labels: StarLabelOptions,
): string {
  const parts: string[] = [];
  if (labels.code && code) parts.push(code);
  if (labels.costPrice && costPrice > 0) parts.push(`¥${costPrice}`);
  if (labels.salePrice && price > 0) parts.push(`¥${price}`);
  if (parts.length === 0) return "";
  const text = parts.join(" ");
  const multi = parts.length > 1;
  const pct = labels.fontSize > 0 ? Math.min(50, labels.fontSize) : 0;
  const fs =
    pct > 0
      ? Math.max(14, Math.round((Math.min(w, h) * pct) / 100))
      : Math.max(20, Math.round(Math.min(w, h) * (multi ? 0.09 : 0.12)));
  const stroke = Math.max(4, Math.round(fs * 0.3));
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="${Math.round(h * 0.93)}" font-family="'Consolas','Segoe UI',monospace" font-weight="900" font-size="${fs}" fill="#ffffff" stroke="#000000" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle" dominant-baseline="bottom">${text}</text>
  </svg>`;
}

/**
 * 读原图的并发上限。九宫格一组 9 张、星标总览一页最多 100 格，原来是**串行**一个个读：
 * 共享盘上每张要等它读完+解码完才开始下一张（客机实测单张约 3 秒 → 一组要 27 秒）。
 * 并发之后墙钟时间按并发数下降，但要压着用，不是越大越好：
 *   - 每多一路就多一份 libvips 解码的瞬时内存（4000px 的 JPEG 解码时能占几十 MB）；
 *   - 共享盘上同时开太多流会把别人的读写挤慢，弱 NAS 还容易超时；
 *   - libvips 自己是多线程的，路数太多等于把 CPU 核数超订一倍。
 * 3 是「比串行快一个量级」和「别把机器和共享盘吃爆」之间的折中；要调就动这一个数。
 */
const IMG_READ_CONCURRENCY = 3;

/**
 * 按并发上限处理一批项，**结果严格按输入下标归位**——拼图位置全靠它，顺序绝不能乱。
 * 单项抛错不往外冒（那一格记成 undefined），由调用方决定怎么占位：
 * 一格读不到就不该毁掉整张图（九宫格原来正是整组失败，星标总览一直有灰底兜底）。
 */
async function mapCellsLimited<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const out = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      try {
        out[i] = await run(items[i], i);
      } catch {
        out[i] = undefined;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return out;
}

/** 九宫格 / 长图共用的格子尺寸探测：取第一张有图商品等比 clamp（长边 ≤ maxEdge、短边 ≥ minEdge）。
 *  抽出来是因为长图必须**所有组用同一个格子尺寸** —— 一组一组各探各的，拼出来就会高低不齐。 */
async function probeTileSize(
  cells: Array<{ code: string; img: string | null }>,
  maxEdge: number,
  minEdge: number,
): Promise<{ w: number; h: number }> {
  let w = 300;
  let h = 300;
  const firstImg = cells.find((c) => c.img);
  if (firstImg?.img) {
    try {
      const meta = await withSharpFile((f) => f(firstImg.img as string).metadata());
      const sw = meta.width || 0;
      const sh = meta.height || 0;
      if (sw > 40 && sh > 40) {
        const scale = Math.min(maxEdge / sw, maxEdge / sh, 1);
        w = Math.max(minEdge, Math.round(sw * scale));
        h = Math.max(minEdge, Math.round(sh * scale));
      }
    } catch {
      /* 尺寸读取失败用默认 */
    }
  }
  return { w, h };
}

/**
 * 单组 3×3 拼图（**内存版**，不落盘）：写文件的 renderLiveGrid 与拼长图的 renderLiveLongImage
 * 都走这一份 —— 标注口径、缺图占位、并发读图只有一处实现，两个产物才不会慢慢长歪。
 */
async function buildLiveGroupJpeg(
  cells: Array<{ code: string; img: string | null }>,
  groupNo: number,
  tileW: number,
  tileH: number,
  labelMode: "num" | "code" | "both" | "none",
  quality: number,
): Promise<Buffer> {
  // 先把 9 张图**并发**读出来（读是唯一的大头：共享盘上单张要等几秒），顺序靠下标保住；
  // 拼图层是内存操作，仍旧按格子顺序走。
  const inputs = await mapCellsLimited(cells, IMG_READ_CONCURRENCY, async (cell) => {
    if (!cell?.img) {
      return null; // 缺图：交给下面走灰底
    }
    return await withSharpFile((f) =>
      f(cell.img as string)
        .resize(tileW, tileH, { fit: "fill" })
        .toBuffer(),
    );
  });
  const layers: Parameters<sharp.Sharp["composite"]>[0] = [];
  const startNum = (groupNo - 1) * 9 + 1;
  for (let idx = 0; idx < 9; idx++) {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const cell = cells[idx];
    // 读失败/缺图的那一格白底占位，别的格子照常出图。
    // 原来是「读不到就整组抛错失败」——网络抖一下一组白跑，比少一格糟得多。
    const input = inputs[idx] ?? Buffer.from(emptyCellSvg(tileW, tileH), "utf-8");
    layers.push({
      input,
      left: col * tileW,
      top: row * tileH,
    });
    if (labelMode !== "none" && cell?.code) {
      const num = `${startNum + idx}号`;
      const text = labelMode === "code" ? cell.code : labelMode === "both" ? `${num} ${cell.code}` : num;
      layers.push({
        input: Buffer.from(labelSvg(tileW, tileH, text), "utf-8"),
        left: col * tileW,
        top: row * tileH,
      });
    }
  }
  return await sharp({
    create: {
      width: tileW * 3,
      height: tileH * 3,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(layers)
    .jpeg({ quality })
    .toBuffer();
}

// 直播排品九宫格：cells 长度 9，每项 { code, img }；缺图/缺码显示白底占位。
// labelMode：num＝底部标「N号」；code＝标商品真实编号；both＝「N号 编号」两段同标；none＝不标任何文字。
// tile 尺寸按第一张有图商品等比 clamp（长边 ≤1024、短边 ≥256），避免 canvas 超 sharp 像素上限。
export async function renderLiveGrid(
  cells: Array<{ code: string; img: string | null }>,
  outDir: string,
  groupNo: number,
  labelMode: "num" | "code" | "both" | "none" = "num",
): Promise<string> {
  const { w: tileW, h: tileH } = await probeTileSize(cells, 1024, 256);
  const buf = await buildLiveGroupJpeg(cells, groupNo, tileW, tileH, labelMode, 95);
  const startNum = (groupNo - 1) * 9 + 1;
  const endNum = startNum + 8;
  const outFile = path.join(outDir, `${startNum}号-${endNum}号_${localStamp()}.jpg`);
  fs.writeFileSync(outFile, buf);
  return outFile;
}

/**
 * 直播排品「长图」（2026-10-15 新增）：把**所有组竖着拼成一张** jpg。
 * 排版跟 HTML 样品一样（每组一张白卡：顶部组号条 + 3×3 格子 + 底部白字黑边标注，
 * 组间留灰底缝），但产物是一张图 —— 能直接发群里/发客户，不用转网址。
 *
 * 与九宫格 jpg（每组一个文件）刻意的差别：
 *   · 格子缩到长边 ≤640（跟 HTML 样品内嵌那档一样）：1024 档下 10 组 90 格的解码内存要 300MB+，
 *     而长图是"一屏看全、发给人"的东西，640 已经够清楚；顺手把成图压在几 MB
 *   · 组号条上写「第 N 组」+ 该组的序号范围（1号 – 9号），一眼能对上九宫格的文件名
 *   · 组数极多时长图会顶到 JPEG 的 65500px 上限 → 整体等比缩一档，排版口径不变
 */
export type LiveLongGroup = {
  groupNo: number;
  cells: Array<{ code: string; img: string | null }>;
};

export async function renderLiveLongImage(
  groups: LiveLongGroup[],
  outDir: string,
  opts: { labelMode: "num" | "code" | "both" | "none"; quality?: number },
): Promise<string> {
  const labelMode = opts.labelMode;
  const quality = opts.quality && opts.quality > 0 ? opts.quality : 82;
  const { w, h } = await probeTileSize(groups.flatMap((g) => g.cells), 640, 256);

  // 版式：PAD 外白边、HEAD 组号条、GAP 组间缝（跟 .workbuddy/tmp/to-long-image.cjs 同一套比例）
  let tileW = w;
  let tileH = h;
  let head = Math.max(40, Math.round(h * 0.14));
  let gap = Math.max(12, Math.round(h * 0.035));
  const PAD = 20;
  const rowsPerGroup = 3;
  const estimate = (): number =>
    PAD * 2 + groups.length * (head + rowsPerGroup * tileH) + gap * Math.max(0, groups.length - 1);
  // JPEG 单边上限 65500（留点余量到 60000）；超了就把格子、组号条、缝一起等比缩
  if (groups.length > 0 && estimate() > 60000) {
    const k = 60000 / estimate();
    tileW = Math.max(1, Math.round(tileW * k));
    tileH = Math.max(1, Math.round(tileH * k));
    head = Math.max(24, Math.round(head * k));
    gap = Math.max(8, Math.round(gap * k));
  }
  const W = tileW * 3;

  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const layers: Parameters<sharp.Sharp["composite"]>[0] = [];
  let y = PAD;
  for (const g of groups) {
    const startNum = (g.groupNo - 1) * 9 + 1;
    const endNum = startNum + 8;
    const cardH = head + rowsPerGroup * tileH;
    const headFs = Math.max(14, Math.round(head * 0.34));
    const subFs = Math.max(11, Math.round(head * 0.26));
    // 卡面 + 组号条：白底圆角卡，顶部一条浅灰标题带（跟 HTML 样品那张卡长得一样）
    layers.push({
      input: Buffer.from(
        `<svg width="${W}" height="${cardH}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${W}" height="${cardH}" rx="${Math.round(head * 0.2)}" fill="#ffffff" stroke="#e3e6ea"/>
        <rect x="1" y="1" width="${W - 2}" height="${head - 2}" rx="${Math.round(head * 0.2)}" fill="#fafbfc"/>
        <text x="${Math.round(head * 0.28)}" y="${Math.round(head * 0.68)}" font-family="'Microsoft YaHei','Segoe UI',sans-serif" font-size="${headFs}" fill="#1f2329">第 ${g.groupNo} 组</text>
        <text x="${W - Math.round(head * 0.28)}" y="${Math.round(head * 0.68)}" text-anchor="end" font-family="'Microsoft YaHei','Segoe UI',sans-serif" font-size="${subFs}" fill="#8a9099">${startNum}号 – ${endNum}号</text>
        </svg>`,
        "utf-8",
      ),
      left: 0,
      top: y,
    });
    const groupBuf = await buildLiveGroupJpeg(g.cells, g.groupNo, tileW, tileH, labelMode, 95);
    layers.push({ input: groupBuf, left: 0, top: y + head });
    y += cardH + gap;
  }

  const canvasH = Math.max(1, y - gap + PAD);
  const outFile = path.join(outDir, `直播排品长图_${localStamp()}.jpg`);
  await sharp({
    create: {
      width: W,
      height: canvasH,
      channels: 3,
      background: { r: 246, g: 247, b: 249 },
    },
  })
    .composite(layers)
    .jpeg({ quality })
    .toFile(outFile);
  return outFile;
}

/**
 * 直播排品「HTML 样品」（2026-10-14 新增）——**自包含**的单个 html：每格封面按 base64 内嵌，
 * 不引用任何外部文件、不需要服务在跑。商家要把它丢到别的平台转成网址给用户访问，
 * 所以"自包含"是硬要求：拷到哪、传到哪都不能掉图。
 *
 * 口径与 renderLiveGrid（jpg 版）**逐条对齐** —— 两套产物长得不一样就没意义了：
 *   · 每组 3×3；**序号跨组连续**：第 N 组第 1 格 = (N-1)*9+1 号
 *   · labelMode：num＝「N号」/ code＝真编号 / both＝「N号 编号」/ none＝不标
 *   · 有编号但目录里没图 = 白底 + 照标文字；空格子（没编号）= 纯白什么都不画
 *   · 格子长宽比取**第一张有图商品**的比例（跟 jpg 同一算法），图片 object-fit: fill 铺满
 *
 * 与 jpg 的差别只有两处，都是刻意的：
 *   ① 内嵌的图先缩到 embedWidth（默认 640）再编码 —— 直接嵌原图，几十款就是几十 MB，
 *      平台上传/手机打开都会崩；样品页看的是"有哪些货、什么样子"，640 足够清楚
 *   ② 手机上自适应（3 列 CSS grid + clamp 字号），电脑上也能直接打印
 */
export type LiveHtmlGroup = {
  groupNo: number;
  cells: Array<{ code: string; img: string | null }>;
};

export async function renderLiveHtml(
  groups: LiveHtmlGroup[],
  opts: {
    labelMode: "num" | "code" | "both" | "none";
    title?: string;
    embedWidth?: number;
    quality?: number;
  },
): Promise<string> {
  const labelMode = opts.labelMode;
  const embedWidth = opts.embedWidth && opts.embedWidth > 0 ? opts.embedWidth : 640;
  const quality = opts.quality && opts.quality > 0 ? opts.quality : 80;
  const title = String(opts.title || "直播排品");

  // 格子比例：跟 jpg 一样取第一张有图的商品（长边 ≤1024、短边 ≥256 那套 clamp 也照搬）
  let tileW = 300;
  let tileH = 300;
  const firstImg = groups.flatMap((g) => g.cells).find((c) => c.img);
  if (firstImg?.img) {
    try {
      const meta = await withSharpFile((f) => f(firstImg.img as string).metadata());
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (w > 40 && h > 40) {
        const MAX_EDGE = 1024;
        const MIN_EDGE = 256;
        const scale = Math.min(MAX_EDGE / w, MAX_EDGE / h, 1);
        tileW = Math.max(MIN_EDGE, Math.round(w * scale));
        tileH = Math.max(MIN_EDGE, Math.round(h * scale));
      }
    } catch {
      /* 尺寸读不到就用 1:1 */
    }
  }

  // 全部格子的图**并发**缩图 + base64（顺序靠下标保住：格子位置全靠它）
  const flat = groups.flatMap((g) => g.cells);
  const datas = await mapCellsLimited(flat, IMG_READ_CONCURRENCY, async (cell) => {
    if (!cell?.img) {
      return null;
    }
    const buf = await withSharpFile((f) =>
      f(cell.img as string)
        .resize({ width: embedWidth, withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer(),
    );
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  });

  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const totalSlots = flat.filter((c) => c.code).length;
  const blocks: string[] = [];
  let cursor = 0;
  for (const g of groups) {
    const startNum = (g.groupNo - 1) * 9 + 1;
    const cells: string[] = [];
    for (let i = 0; i < g.cells.length; i++) {
      const cell = g.cells[i];
      const data = datas[cursor++];
      let label = "";
      if (labelMode !== "none" && cell?.code) {
        const num = `${startNum + i}号`;
        label =
          labelMode === "code"
            ? cell.code
            : labelMode === "both"
              ? `${num} ${cell.code}`
              : num;
      }
      const img = data ? `<img src="${data}" alt="${esc(cell?.code || "")}" />` : "";
      const cap = label ? `<figcaption>${esc(label)}</figcaption>` : "";
      cells.push(`<figure>${img}${cap}</figure>`);
    }
    blocks.push(
      `<section class="grp"><h2>第 ${g.groupNo} 组<span class="nums">${startNum}号 – ${startNum + 8}号</span></h2>` +
        `<div class="grid">${cells.join("")}</div></section>`,
    );
  }

  const when = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  })();

  // 样式全内联在这一个文件里（平台只收一个文件，不能有 css/js 外链）；
  // 底部标注照 jpg 那套：白字 + 黑描边（-webkit-text-stroke，非 WebKit 退化成 text-shadow）
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f6f7f9;color:#1f2329;font:15px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:16px 16px 0}
h1{margin:0;font-size:19px}
.meta{margin:6px 0 0;color:#8a9099;font-size:13px}
.grp{margin:14px;background:#fff;border:1px solid #e3e6ea;border-radius:12px;overflow:hidden}
h2{display:flex;justify-content:space-between;gap:8px;margin:0;padding:10px 12px;font-size:14px;font-weight:500;background:#fafbfc;border-bottom:1px solid #e3e6ea}
h2 .nums{color:#8a9099;font-weight:400}
.grid{display:grid;grid-template-columns:repeat(3,1fr)}
figure{position:relative;margin:0;aspect-ratio:${tileW}/${tileH};background:#fff}
figure img{display:block;width:100%;height:100%;object-fit:fill}
figcaption{position:absolute;left:0;right:0;bottom:2%;text-align:center;font:500 clamp(12px,3.4vw,22px)/1.2 "Consolas","Segoe UI",monospace;color:#fff;-webkit-text-stroke:3px #000;paint-order:stroke fill;text-shadow:0 0 2px rgba(0,0,0,.6),0 0 4px rgba(0,0,0,.4)}
@media print{body{background:#fff}.grp{margin:0 0 10px;border-radius:0;break-inside:avoid}}
</style>
</head>
<body>
<header>
<h1>${esc(title)}</h1>
<p class="meta">共 ${groups.length} 组 · ${totalSlots} 款 · 生成于 ${when}</p>
</header>
${blocks.join("\n")}
</body>
</html>
`;
}

// 星标封面总览图：自定义排版 cols×rows（每格封面 + 编号/售价标签）。
// 内存版：预览用（不落盘）；写文件版 renderStarOverviewGrid 复用它。
// opts.preview=true 时按低分辨率排版（每格最长边 ≤360），预览快且不落盘；
// 生成默认全分辨率（≤1024）。任一单图解码失败只占位，不拖垮整张。
export async function renderStarOverviewBuffer(
  rows: Array<{ code: string; img: string | null; price: number; costPrice: number }>,
  cols: number,
  rowsN: number,
  labels: StarLabelOptions,
  opts?: { preview?: boolean; imgFor?: (code: string, src: string | null) => Promise<string | null> },
): Promise<Buffer> {
  // 预览时 imgFor 给的是本机 512 等比小图（见 images.ts 的 previewThumbPath），省掉每格都从
  // 共享盘拉原图再解码。取不到就回退 cell.img，行为与原来一致。导出写盘那条路不传 imgFor，
  // 永远用原图 —— 预览快不能牺牲成品清晰度。
  const srcOf = async (code: string, src: string | null): Promise<string | null> => {
    if (!opts?.imgFor) {
      return src;
    }
    return (await opts.imgFor(code, src)) || src;
  };
  // 兜底 clamp：防止传入超大排版把 create 画布顶爆（10×10 上限 ≈10240px 生成 / ≈3600px 预览）
  cols = Math.min(10, Math.max(1, Math.round(cols) || 1));
  rowsN = Math.min(10, Math.max(1, Math.round(rowsN) || 1));
  const MAX_EDGE = opts?.preview ? 360 : 1024;
  const MIN_EDGE = opts?.preview ? 180 : 256;
  let tileW = 300;
  let tileH = 300;
  // 探尺寸也走同一张图：小图等比缩放、边长 512 > 预览格上限 360，算出来的格子尺寸与原图一致
  const firstRow = rows.find((r) => r.img);
  const probeSrc = firstRow ? await srcOf(firstRow.code, firstRow.img) : null;
  if (probeSrc) {
    try {
      const meta = await withSharpFile((f) => f(probeSrc as string).metadata());
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (w > 40 && h > 40) {
        const scale = Math.min(MAX_EDGE / w, MAX_EDGE / h, 1);
        tileW = Math.max(MIN_EDGE, Math.round(w * scale));
        tileH = Math.max(MIN_EDGE, Math.round(h * scale));
      }
    } catch {
      /* 尺寸读取失败用默认 */
    }
  }
  const canvasW = tileW * cols;
  const canvasH = tileH * rowsN;
  // 同一套取舍：读图并发（一页最多 100 格，串行时这里是几十秒到几分钟的大头），
  // 结果按下标归位；单格取不到/解码失败就灰底占位（原来就是这个口径，只是挪进了并发任务里）
  const inputs = await mapCellsLimited(rows, IMG_READ_CONCURRENCY, async (cell) => {
    const src = cell.img ? await srcOf(cell.code, cell.img) : null;
    if (!src) {
      return Buffer.from(emptyCellSvg(tileW, tileH), "utf-8");
    }
    try {
      // limitInputPixels:false 让超大源图也能 resize；失败则该格灰底占位
      return await withSharpFile((f) =>
        f(src, { limitInputPixels: false })
          .resize(tileW, tileH, { fit: "fill" })
          .toBuffer(),
      );
    } catch {
      return Buffer.from(emptyCellSvg(tileW, tileH), "utf-8");
    }
  });
  const layers: Parameters<sharp.Sharp["composite"]>[0] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const cell = rows[idx];
    layers.push({
      input: inputs[idx] ?? Buffer.from(emptyCellSvg(tileW, tileH), "utf-8"),
      left: col * tileW,
      top: row * tileH,
    });
    if (cell.code) {
      const svg = starLabelSvg(tileW, tileH, cell.code, cell.price, cell.costPrice, labels);
      if (svg) {
        layers.push({
          input: Buffer.from(svg, "utf-8"),
          left: col * tileW,
          top: row * tileH,
        });
      }
    }
  }
  return await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(layers)
    .jpeg({ quality: 95 })
    .toBuffer();
}

// 写文件版：内存渲染结果落盘到 outDir/fileName
export async function renderStarOverviewGrid(
  rows: Array<{ code: string; img: string | null; price: number; costPrice: number }>,
  outDir: string,
  fileName: string,
  cols: number,
  rowsN: number,
  labels: StarLabelOptions,
): Promise<string> {
  const buf = await renderStarOverviewBuffer(rows, cols, rowsN, labels);
  const outFile = path.join(outDir, fileName);
  fs.writeFileSync(outFile, buf);
  return outFile;
}