import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import sharp from "sharp";
import { ToolDefinition } from "../../core/toolRegistry.js";
import { readImageToBase64 } from "../../core/utils.js";

const IMG_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);

/** 九宫格拼图：传入9张图片完整路径数组，输出拼接大图 */
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

/** 给已经拼好的九宫格大图绘制底部序号 */
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
  const fontSize = Math.min(cellW, cellH) * 0.15;
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
      <text x="50%" y="${svgH * 0.92}" font-family="'Consolas','Segoe UI',monospace" font-weight="900" font-size="${fontSize * 0.96}" fill="#ffffff" stroke="#000000" stroke-width="35" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle" dominant-baseline="bottom">${text}</text>
      </svg>`;
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

/** 原地顺时针旋转90度 */
export async function rotateImageInPlace(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.rotate_tmp_${Date.now()}${path.extname(filePath)}`,
  );
  try {
    await sharp(filePath).rotate(90).toFile(tempPath);
    await fs.promises.unlink(filePath);
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
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

/** 读取文件夹下所有图片文件路径 */
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

export const nineGridTool: ToolDefinition = {
  toolName: "nineGridTool",
  title: "🧩九宫格工具箱",
  fragmentPath: "tools/nineGridTool/fragment.html",
  clientScriptPath: "tools/nineGridTool/client.js",
  async handleMessage(msg, ctx) {
    const log = ctx.log;
    switch (msg.type) {
      case "openLoadImageFolder": {
        const dir = await ctx.selectFolder();
        if (!dir) {
          break;
        }
        const imgPaths = await scanImageFiles(dir);
        const uriMap: Record<string, string> = {};
        for (const fp of imgPaths) {
          uriMap[fp] = await readImageToBase64(fp);
        }
        ctx.postToWebview({ type: "addImagePaths", paths: imgPaths, uriMap });
        break;
      }
      case "openSelectImages": {
        const paths = await ctx.selectFiles({
          图片: ["jpg", "jpeg", "png", "bmp", "webp"],
        });
        if (!paths.length) {
          break;
        }
        const uriMap: Record<string, string> = {};
        for (const fp of paths) {
          uriMap[fp] = await readImageToBase64(fp);
        }
        ctx.postToWebview({ type: "addImagePaths", paths, uriMap });
        break;
      }
      case "selectOutputFolder": {
        const dir = await ctx.selectFolder();
        if (dir) {
          ctx.postToWebview({ type: "setOutputDir", path: dir });
        }
        break;
      }
      case "openMergeOutputFolder": {
        const outDir = msg.outDir?.trim();
        if (!outDir) {
          ctx.log("请先选择输出文件夹");
          break;
        }
        try {
          await vscodeCommandsReveal(outDir);
        } catch (err) {
          ctx.log(`文件夹打开失败：${(err as Error).message}`);
        }
        break;
      }
      case "selectLabelOutDir": {
        const dir = await ctx.selectFolder();
        if (dir) {
          ctx.postToWebview({ type: "setLabelOutDir", path: dir });
        }
        break;
      }
      case "openLabelOutputFolder": {
        const targetDir = msg.targetDir?.trim();
        if (!targetDir) {
          ctx.log("请先选择输出文件夹");
          break;
        }
        try {
          await vscodeCommandsReveal(targetDir);
        } catch (err) {
          ctx.log(`文件夹打开失败：${(err as Error).message}`);
        }
        break;
      }
      case "selectLabelImage": {
        const filePath = await ctx.selectFile({
          图片: ["jpg", "jpeg", "png", "bmp", "webp"],
        });
        if (!filePath) {
          break;
        }
        const base64Url = await readImageToBase64(filePath);
        ctx.postToWebview({
          type: "setLabelImage",
          path: filePath,
          base64: base64Url,
        });
        break;
      }
      case "rotateImage": {
        const idx = msg.idx;
        const grid = msg.grid;
        const fp = grid[idx];
        if (!fp) {
          ctx.log("⚠旋转：当前格子没有图片");
          break;
        }
        try {
          await rotateImageInPlace(fp);
          const newBase64 = await readImageToBase64(fp);
          const msgText = `✅旋转完成: ${fp}`;
          ctx.postToWebview({
            type: "rotatedCellUpdate",
            idx,
            filePath: fp,
            newBase64,
          });
          log(msgText);
        } catch (err: any) {
          log(`❌旋转失败：${String(err)}`);
        }
        break;
      }
      case "runMerge": {
        ctx.postToWebview({ type: "clearLog" });
        log("▶开始执行九宫格拼图");
        const imgPaths: string[] = msg.grid.filter(
          (x: string | null): x is string => x !== null,
        );
        if (imgPaths.length !== 9) {
          log("❌失败：网格必须填满9张图片");
          break;
        }
        if (!msg.outDir || !fs.existsSync(msg.outDir)) {
          log("❌失败：请选择有效输出文件夹");
          break;
        }
        try {
          const outFile = await handleNineGridMergeFromList(
            imgPaths,
            msg.outDir,
          );
          log(`✅拼图完成，输出文件：${outFile}`);
        } catch (err: any) {
          log(`❌拼图异常：${err.message}`);
        }
        break;
      }
      case "runLabel": {
        ctx.postToWebview({ type: "clearLog" });
        log("▶开始执行图片添加序号");
        const srcPath = msg.srcPath;
        const startNum = Number(msg.startNum);
        const outDir = msg.outDir;
        if (!srcPath || !fs.existsSync(srcPath)) {
          log("❌失败：请先选择有效九宫格图片");
          break;
        }
        if (isNaN(startNum) || startNum < 1) {
          log("❌失败：起始编号必须是≥1整数");
          break;
        }
        try {
          const outFile = await handleNineGridLabel(srcPath, startNum, outDir);
          log(`✅序号生成完成，输出文件：${outFile}`);
        } catch (err: any) {
          log(`❌序号生成异常：${err.message}`);
        }
        break;
      }
    }
  },
};

/** 通过 vscode 命令在系统文件管理器中显示 */
async function vscodeCommandsReveal(dir: string): Promise<void> {
  const uri = vscode.Uri.file(dir);
  await vscode.commands.executeCommand("revealFileInOS", uri);
}
