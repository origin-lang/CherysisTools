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

// 星标总览图：每格底下压一行「编号」（大）+「¥售价」（小），白字黑描边
function starLabelSvg(w: number, h: number, code: string, price: number): string {
  const fs = Math.max(22, Math.round(Math.min(w, h) * 0.12));
  const ps = Math.max(16, Math.round(fs * 0.62));
  const stroke = Math.max(12, Math.round(fs * 0.3));
  const priceText = price ? `¥${price}` : "";
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="${Math.round(h * 0.68)}" font-family="'Consolas','Segoe UI',monospace" font-weight="900" font-size="${fs}" fill="#ffffff" stroke="#000000" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle" dominant-baseline="middle">${code}</text>
  ${priceText ? `<text x="50%" y="${Math.round(h * 0.97)}" font-family="'Consolas','Segoe UI',monospace" font-weight="700" font-size="${ps}" fill="#ffe14d" stroke="#000000" stroke-width="${Math.max(8, Math.round(ps * 0.26))}" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle" dominant-baseline="bottom">${priceText}</text>` : ""}
  </svg>`;
}

// 直播排品九宫格：cells 长度 9，每项 { code, img }；缺图/缺码显示灰底占位。
// tile 尺寸按第一张有图商品等比 clamp（长边 ≤1024、短边 ≥256），避免 canvas 超 sharp 像素上限。
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
      /* 尺寸读取失败用默认 */
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
  const outFile = path.join(outDir, `${startNum}号-${endNum}号_${localYmd()}.jpg`);
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

// 星标封面总览图：方阵自动密度（传入侧边数 side），每格封面 + 编号/售价标签
export async function renderStarOverviewGrid(
  rows: Array<{ code: string; img: string | null; price: number }>,
  outDir: string,
  fileName: string,
  side: number,
): Promise<string> {
  let tileW = 300;
  let tileH = 300;
  const firstImg = rows.find((r) => r.img);
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
      /* 尺寸读取失败用默认 */
    }
  }
  const canvasW = tileW * side;
  const canvasH = tileH * side;
  const layers: Parameters<sharp.Sharp["composite"]>[0] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const col = idx % side;
    const row = Math.floor(idx / side);
    const cell = rows[idx];
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
      layers.push({
        input: Buffer.from(starLabelSvg(tileW, tileH, cell.code, cell.price), "utf-8"),
        left: col * tileW,
        top: row * tileH,
      });
    }
  }
  const outFile = path.join(outDir, fileName);
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