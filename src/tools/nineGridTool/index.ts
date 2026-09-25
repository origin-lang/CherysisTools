import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import sharp from "sharp";
import { ToolDefinition } from "../../core/toolRegistry.js";
import { readImageToBase64 } from "../../core/utils.js";

const IMG_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);

const IMPORT_MIME_EXT: Record<string, string> = {
  jpg: ".jpg",
  jpeg: ".jpg",
  png: ".png",
  gif: ".gif",
  webp: ".webp",
  bmp: ".bmp",
};
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

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
  category: "utility",
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
        const dir = await ctx.selectFolder("选择九宫格拼图输出目录");
        if (!dir) {
          log("❌未选择输出目录，已取消");
          break;
        }
        ctx.postToWebview({ type: "setOutputDir", path: dir });
        try {
          const outFile = await handleNineGridMergeFromList(imgPaths, dir);
          log(`✅拼图完成，输出文件：${outFile}`);
          try {
            await vscodeCommandsReveal(outFile);
          } catch (err) {
            log(`⚠自动打开输出文件夹失败：${(err as Error).message}`);
          }
        } catch (err: any) {
          log(`❌拼图异常：${err.message}`);
        }
        break;
      }
      case "importImages": {
        const items: Array<{ name?: string; data?: string }> = Array.isArray(
          msg.items,
        )
          ? msg.items
          : [];
        if (!items.length) {
          break;
        }
        const importDir = path.join(ctx.storageDir, "nineGridTool_import");
        fs.mkdirSync(importDir, { recursive: true });
        const paths: string[] = [];
        const base64s: string[] = [];
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        let seq = 0;
        for (const it of items) {
          const data = String(it?.data ?? "");
          const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec(data);
          if (!m) {
            continue;
          }
          const ext = IMPORT_MIME_EXT[m[1].toLowerCase()] || ".png";
          const bytes = Buffer.from(m[2], "base64");
          if (!bytes.length) {
            continue;
          }
          if (bytes.length > MAX_IMPORT_BYTES) {
            log(
              `⚠️跳过超大图片（${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 25MB）`,
            );
            continue;
          }
          const target = path.join(importDir, `import_${stamp}_${seq++}${ext}`);
          try {
            fs.writeFileSync(target, bytes);
            paths.push(target);
            base64s.push(data);
          } catch (err: any) {
            log(`⚠️写入失败：${err.message}`);
          }
        }
        if (!paths.length) {
          log("❌导入的图片写入失败");
          break;
        }
        if (msg.intent === "label") {
          ctx.postToWebview({
            type: "setLabelImage",
            path: paths[0],
            base64: base64s[0],
          });
          log(`✅已导入序号大图：${paths[0]}`);
          break;
        }
        const rawIdx = Number(msg.targetIdx);
        const targetIdx =
          Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < 9 ? rawIdx : -1;
        ctx.postToWebview({ type: "importedImagePaths", paths, targetIdx });
        log(`✅已导入 ${paths.length} 张图片`);
        break;
      }
      case "dropLabelUri": {
        const uris: unknown[] = Array.isArray(msg.uris) ? msg.uris : [];
        let done = false;
        for (const u of uris) {
          const uri = String(u ?? "").trim();
          if (!uri) {
            continue;
          }
          let fsPath = "";
          try {
            fsPath = vscode.Uri.parse(uri).fsPath;
          } catch {
            continue;
          }
          if (!fsPath || !fs.existsSync(fsPath)) {
            continue;
          }
          const ext = path.extname(fsPath).toLowerCase();
          if (!IMG_EXTS.has(ext)) {
            continue;
          }
          ctx.postToWebview({ type: "setLabelImage", path: fsPath });
          done = true;
          break;
        }
        if (!done) {
          log("❌拖入的文件不是支持的图片格式");
        }
        break;
      }
      case "dropImageUris": {
        const uris: unknown[] = Array.isArray(msg.uris) ? msg.uris : [];
        const paths: string[] = [];
        for (const u of uris) {
          const uri = String(u ?? "").trim();
          if (!uri) {
            continue;
          }
          let fsPath = "";
          try {
            fsPath = vscode.Uri.parse(uri).fsPath;
          } catch {
            continue;
          }
          if (!fsPath || !fs.existsSync(fsPath)) {
            continue;
          }
          const ext = path.extname(fsPath).toLowerCase();
          if (IMG_EXTS.has(ext)) {
            paths.push(fsPath);
          }
        }
        if (!paths.length) {
          log("❌拖入的文件都不是支持的图片格式");
          break;
        }
        const uriMap: Record<string, string> = {};
        for (const fp of paths) {
          uriMap[fp] = await readImageToBase64(fp);
        }
        const rawIdx = Number(msg.targetIdx);
        const targetIdx =
          Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < 9 ? rawIdx : -1;
        ctx.postToWebview({
          type: "importedImagePaths",
          paths,
          uriMap,
          targetIdx,
        });
        log(`✅拖入 ${paths.length} 张图片`);
        break;
      }
      case "runLabel": {
        ctx.postToWebview({ type: "clearLog" });
        log("▶开始执行图片添加序号");
        const srcPath = msg.srcPath;
        const startNum = Number(msg.startNum);
        if (!srcPath || !fs.existsSync(srcPath)) {
          log("❌失败：请先选择有效九宫格图片");
          break;
        }
        if (isNaN(startNum) || startNum < 1) {
          log("❌失败：起始编号必须是≥1整数");
          break;
        }
        const dir = await ctx.selectFolder("选择序号生成输出目录");
        if (!dir) {
          log("❌未选择输出目录，已取消");
          break;
        }
        ctx.postToWebview({ type: "setOutputDir", path: dir });
        try {
          const outFile = await handleNineGridLabel(srcPath, startNum, dir);
          log(`✅序号生成完成，输出文件：${outFile}`);
          try {
            await vscodeCommandsReveal(outFile);
          } catch (err) {
            log(`⚠自动打开输出文件夹失败：${(err as Error).message}`);
          }
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
