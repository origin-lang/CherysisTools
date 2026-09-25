import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

function localYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function greyCellSvg(w: number, h: number): string {
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#d6d6d6"/>
  <text x="50%" y="50%" fill="#8a8a8a" font-size="${Math.round(h / 8)}" font-family="'Segoe UI',sans-serif" text-anchor="middle" dominant-baseline="middle">无图</text>
  </svg>`;
}

function labelSvg(w: number, h: number, text: string): string {
  const fs = Math.max(24, Math.round(Math.min(w, h) * 0.13));
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="${Math.round(h * 0.93)}" font-family="'Consolas','Segoe UI',monospace" font-weight="900" font-size="${fs}" fill="#ffffff" stroke="#000000" stroke-width="${Math.max(14, Math.round(fs * 0.32))}" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle" dominant-baseline="bottom">${text}</text>
  </svg>`;
}

// 星标总览图：根据 labels 选项在底部压一行文字，白字黑描�?
// labels.fontSize>0 时用固定字号（格子坐标系像素），否则按格子自�?
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
  const fs =
    labels.fontSize > 0
      ? Math.max(14, Math.round(labels.fontSize))
      : Math.max(20, Math.round(Math.min(w, h) * (multi ? 0.09 : 0.12)));
  const stroke = Math.max(10, Math.round(fs * 0.3));
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="${Math.round(h * 0.93)}" font-family="'Consolas','Segoe UI',monospace" font-weight="900" font-size="${fs}" fill="#ffffff" stroke="#000000" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle" dominant-baseline="bottom">${text}</text>
  </svg>`;
}

// 直播排品九宫格：cells 长度 9，每�?{ code, img }；缺�?缺码显示灰底占位�?
// tile 尺寸按第一张有图商品等�?clamp（长�?�?024、短�?�?56），避免 canvas �?sharp 像素上限�?
export async function renderLiveGrid(
  cells: Array<{ code: string; img: string | null }>,
  outDir: string,
  groupNo: number,
): Promise<string> {
  let tileW = 300;
  let tileH = 300;
  const firstImg = cells.find((c) => c.img);
  if (firstImg) {
    try {
      const meta = await sharp(firstImg.img!).metadata();
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
      /* 尺寸读取失败用默�?*/
    }
  }
  const canvasW = tileW * 3;
  const canvasH = tileH * 3;
  const layers: Parameters<sharp.Sharp["composite"]>[0] = [];
  const startNum = (groupNo - 1) * 9 + 1;
  for (let idx = 0; idx < 9; idx++) {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const cell = cells[idx];
    let input: Buffer;
    if (cell.img) {
      input = await sharp(cell.img).resize(tileW, tileH, { fit: "fill" }).toBuffer();
    } else {
      input = Buffer.from(greyCellSvg(tileW, tileH), "utf-8");
    }
    layers.push({
      input,
      left: col * tileW,
      top: row * tileH,
    });
    if (cell.code) {
      const text = `${startNum + idx}号`;
      layers.push({
        input: Buffer.from(labelSvg(tileW, tileH, text), "utf-8"),
        left: col * tileW,
        top: row * tileH,
      });
    }
  }
  const endNum = startNum + 8;
  const outFile = path.join(outDir, `${startNum}�?${endNum}号_${localYmd()}.jpg`);
  await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(layers)
    .jpeg({ quality: 95 })
    .toFile(outFile);
  return outFile;
}

// 星标封面总览图：自定义排�?cols×rows（每格封�?+ 编号/售价标签�?
// 内存版：预览用（不落盘）；写文件�?renderStarOverviewGrid 复用�?
// opts.preview=true 时按低分辨率排版（每格最长边 �?60），预览快且不落盘；
// 生成默认全分辨率（≤1024）。任一单图解码失败只占位，不拖垮整张�?
export async function renderStarOverviewBuffer(
  rows: Array<{ code: string; img: string | null; price: number; costPrice: number }>,
  cols: number,
  rowsN: number,
  labels: StarLabelOptions,
  opts?: { preview?: boolean },
): Promise<Buffer> {
  // 兜底 clamp：防止传入超大排版把 create 画布顶爆�?0×10 上限 �?0240px 生成 / �?600px 预览�?
  cols = Math.min(10, Math.max(1, Math.round(cols) || 1));
  rowsN = Math.min(10, Math.max(1, Math.round(rowsN) || 1));
  const MAX_EDGE = opts?.preview ? 360 : 1024;
  const MIN_EDGE = opts?.preview ? 180 : 256;
  let tileW = 300;
  let tileH = 300;
  const firstImg = rows.find((r) => r.img);
  if (firstImg) {
    try {
      const meta = await sharp(firstImg.img!).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (w > 40 && h > 40) {
        const scale = Math.min(MAX_EDGE / w, MAX_EDGE / h, 1);
        tileW = Math.max(MIN_EDGE, Math.round(w * scale));
        tileH = Math.max(MIN_EDGE, Math.round(h * scale));
      }
    } catch {
      /* 尺寸读取失败用默�?*/
    }
  }
  const canvasW = tileW * cols;
  const canvasH = tileH * rowsN;
  const layers: Parameters<sharp.Sharp["composite"]>[0] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const cell = rows[idx];
    let input: Buffer;
    if (cell.img) {
      try {
        // limitInputPixels:false 让超大源图也�?resize；失败则该格灰底占位
        input = await sharp(cell.img, { limitInputPixels: false })
          .resize(tileW, tileH, { fit: "fill" })
          .toBuffer();
      } catch {
        input = Buffer.from(greyCellSvg(tileW, tileH), "utf-8");
      }
    } else {
      input = Buffer.from(greyCellSvg(tileW, tileH), "utf-8");
    }
    layers.push({
      input,
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