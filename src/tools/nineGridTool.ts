import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import sharp from "sharp";

export type LogCallback = (msg: string) => void;
const IMG_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);

/**
 * 九宫格拼图：传入9张图片完整路径数组，输出拼接大图
 * @param imgPaths 正好9个图片路径
 * @param outDir 输出文件夹
 */
export async function handleNineGridMergeFromList(
  imgPaths: string[],
  outDir: string,
) {
  const meta0 = await sharp(imgPaths[0]).metadata();
  const tileW = meta0.width ?? 300;
  const tileH = meta0.height ?? 300;
  const outW = tileW * 3;
  const outH = tileH * 3;

  const compositeList: Parameters<sharp.Sharp["composite"]>[0] = [];
  for (let idx = 0; idx < 9; idx++) {
    const fp = imgPaths[idx];
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const tileBuf = await sharp(fp)
      .resize(tileW, tileH, { fit: "fill" })
      .toBuffer();
    compositeList.push({
      input: tileBuf,
      left: col * tileW,
      top: row * tileH,
    });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outDir, `ninegrid_${timestamp}.jpg`);
  await sharp({
    create: {
      width: outW,
      height: outH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(compositeList)
    .jpeg({ quality: 95 })
    .toFile(outFile);

  return outFile;
}

/**
 * 给已经拼好的九宫格大图绘制底部序号
 * @param srcFile 原图路径
 * @param startNum 起始编号
 * @param outDir 可选输出目录，不传则输出到原图同目录
 */
export async function handleNineGridLabel(
  srcFile: string,
  startNum: number,
  outDir: string | undefined,
) {
  const meta = await sharp(srcFile).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const cellW = w / 3;
  const cellH = h / 3;
  // const fontSize = Math.min(cellW, cellH) * 0.12;
  const fontSize = Math.min(cellW, cellH) * 0.22;
  const compositeList: Parameters<sharp.Sharp["composite"]>[0] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const idx = row * 3 + col;
      const num = startNum + idx;
      const text = `${num}号`;
      const cellLeft = col * cellW;
      const svgW = cellW;
      const svgH = cellH;
      const svgText = `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
      <!--上层白色字，轻微缩小，留出黑边 -->
      <text x="50%" y="${svgH * 0.92}" font-family="Arial, 'Segoe UI', sans-serif" font-weight="900" font-size="${fontSize * 0.96}" fill="#ffffff" text-anchor="middle" dominant-baseline="bottom">${text}</text>
      </svg>`;

      // const svgText = `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="${svgH * 0.93}" font-size="${fontSize}" fill="#000000" stroke="#000000" stroke-width="2" text-anchor="middle" dominant-baseline="bottom">${text}</text><text x="50%" y="${svgH * 0.93}" font-size="${fontSize}" fill="#ffffff" text-anchor="middle" dominant-baseline="bottom">${text}</text></svg>`;
      const svgBuf = Buffer.from(svgText, "utf-8");
      compositeList.push({
        input: svgBuf,
        left: Math.round(cellLeft),
        top: Math.round(row * cellH),
      });
    }
  }

  let outFile: string;
  if (outDir && fs.existsSync(outDir)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    outFile = path.join(outDir, `ninegrid_labeled_${timestamp}.jpg`);
  } else {
    const base = path.basename(srcFile, path.extname(srcFile));
    outFile = path.join(path.dirname(srcFile), `${base}_labeled.jpg`);
  }

  await sharp(srcFile)
    .composite(compositeList)
    .jpeg({ quality: 95 })
    .toFile(outFile);

  return outFile;
}

/**
 * 生成缩略图base64，用于webview预览
 */
export async function createThumbnailBase64(
  filePath: string,
  size: number,
): Promise<string | null> {
  try {
    const buf = await sharp(filePath)
      .resize(size, size, { fit: "inside" })
      .jpeg({ quality: 70 })
      .toBuffer();
    return buf.toString("base64");
  } catch {
    return null;
  }
}

/**
 * 原地顺时针旋转90度，磁盘流式处理，不把完整图片读入内存
 * 使用临时中转文件，规避sharp不允许输入输出同文件限制
 */
export async function rotateImageInPlace(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  // 同目录生成临时文件
  const tempPath = path.join(
    dir,
    `.rotate_tmp_${Date.now()}${path.extname(filePath)}`,
  );

  try {
    // sharp直接磁盘读取，输出到临时文件，不走node内存大buffer
    await sharp(filePath).rotate(90).toFile(tempPath);

    // 旋转成功，删除原始文件
    await fs.promises.unlink(filePath);
    // 将临时文件重命名为原始文件名
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    // 异常清理临时文件，保护原图
    try {
      if (
        await fs.promises
          .access(tempPath)
          .then(() => true)
          .catch(() => false)
      ) {
        await fs.promises.unlink(tempPath);
      }
    } catch {
      /* 忽略清理异常 */
    }
    throw err;
  }
}

/**
 * 读取文件夹下所有图片文件路径
 */
export async function scanImageFiles(folderPath: string): Promise<string[]> {
  const entries = await fsp.readdir(folderPath, { withFileTypes: true });
  const imgPaths: string[] = [];
  for (const e of entries) {
    if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMG_EXTS.has(ext)) {
        imgPaths.push(path.join(folderPath, e.name));
      }
    }
  }
  return imgPaths;
}
