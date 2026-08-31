import fs from "fs";
import fsp from "fs/promises";
import path from "path";
// import { exec } from "child_process";
type LogCallback = (msg: string) => void;

import { exec, ExecException } from "child_process";
export function openFolderInExplorer(
  folderPath: string | undefined,
): Promise<void> {
  // 先判断 undefined / null /空字符串
  if (!folderPath || folderPath.trim?.() === "") {
    return Promise.reject(new Error("目标路径为空，请先选择文件夹"));
  }

  return new Promise((resolve, reject) => {
    exec(
      `explorer "${folderPath}"`,
      {},
      (__err: ExecException | null, _stdout: string, stderr: string) => {
        if (stderr.trim()) {
          reject(new Error(stderr));
        } else {
          resolve();
        }
      },
    );
  });
}
export async function runImageBatchTool(
  params: Record<string, any>,
  log: LogCallback,
) {
  const subMode = params.subMode;
  switch (subMode) {
    case "tabMkdir":
      await handleBatchMkdir(params, log);
      break;
    case "tabRename":
      await handleImageRename(params, log);
      break;
    case "tabDist":
      await handleImageDistribute(params, log);
      break;
    case "tabAppend":
      await handleAppendSuffixExport(params, log);
      break;
    default:
      throw new Error(`未知子模式:${subMode}`);
  }
}

/** 1.批量建文件夹 */
async function handleBatchMkdir(p: Record<string, any>, log: LogCallback) {
  const target = p.ib_mk_target?.trim();
  const prefix = p.ib_mk_prefix?.trim() ?? "";
  const start = Number(p.ib_mk_start);
  const end = Number(p.ib_mk_end);
  const digit = Number(p.ib_mk_digit) || 3;
  const clearBefore = !!p.ib_mk_clear_before;
  if (!target || !fs.existsSync(target)) {
    log("[错误] 请选择有效的目标父目录");
    return;
  }
  if (isNaN(start) || isNaN(end)) {
    log("[错误] 起始/结束必须是数字");
    return;
  }
  if (start > end) {
    log("[错误] 起始数字不能大于结束数字");
    return;
  }
  if (clearBefore) {
    log(`开始清空目标目录内内容: ${target}`);
    try {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(target, entry.name);
        if (entry.isFile()) {
          await fsp.unlink(fullPath);
          log(`删除文件: ${entry.name}`);
        } else if (entry.isDirectory()) {
          await fsp.rm(fullPath, { recursive: true, force: true });
          log(`删除子目录: ${entry.name}`);
        }
      }
      log("目标目录清空完成");
    } catch (err: any) {
      log(`[错误] 清空目录失败｜${String(err.message)}`);
      return;
    }
  }
  log(`目标目录:${target}`);
  log(`前缀:[${prefix}] 编号 ${start}~${end} , ${digit}位补零`);
  let created = 0,
    skip = 0;
  for (let n = start; n <= end; n++) {
    const numStr = n.toString().padStart(digit, "0");
    const dirName = `${prefix}${numStr}`;
    const full = path.join(target, dirName);
    if (fs.existsSync(full)) {
      log(`跳过已存在:${dirName}`);
      skip++;
    } else {
      await fsp.mkdir(full);
      log(`创建:${dirName}`);
      created++;
    }
  }
  log(`\n完成! 新建:${created}个，跳过已存在:${skip}个`);
}

const IMG_SUFFIX = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);
/** 2.图片序列重命名 */
export async function handleImageRename(
  p: Record<string, any>,
  log: LogCallback,
) {
  const srcDir = (p.ib_re_src ?? "").trim();
  const outDir = (p.ib_re_out ?? "").trim();
  const basePrefix = (p.ib_re_prefix ?? "").trim();
  const imgOnly = !!p.ib_re_imgonly;
  const overwriteMode = Number(p.ib_re_ov) ?? 0;
  const workMode = Number(p.ib_re_mode) ?? 0;
  const inplaceMode = workMode === 1;

  if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error("请选择有效的原始图片文件夹");
  }
  if (!basePrefix) {
    throw new Error("基础前缀不能为空，例如 L001");
  }
  if (!inplaceMode) {
    if (
      !outDir ||
      !fs.existsSync(outDir) ||
      !fs.statSync(outDir).isDirectory()
    ) {
      throw new Error("复制导出模式，请选择有效的输出文件夹");
    }
    if (path.resolve(srcDir) === path.resolve(outDir)) {
      throw new Error("源文件夹不能与输出文件夹相同！");
    }
  }

  log(`【源目录】${srcDir}`);
  log(`【模式】${inplaceMode ? "原地直接重命名" : "复制导出到输出目录"}`);
  log(`【基础前缀】${basePrefix}`);
  log(`【重名策略】${overwriteMode === 1 ? "覆盖" : "跳过"}`);
  log("--------------------------------------------------");

  if (!inplaceMode) {
    try {
      const entries = await fsp.readdir(outDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const fullPath = path.join(outDir, entry.name);
          await fsp.unlink(fullPath);
          log(`清理旧文件: ${entry.name}`);
        }
      }
    } catch (e: any) {
      throw new Error(`输出目录清理异常：${e.message}`);
    }
  }

  let success = 0;
  let skipFilter = 0;
  let skipDup = 0;
  let fail = 0;
  let seq = 1;
  const fileEntries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of fileEntries) {
    if (entry.isDirectory()) {
      continue;
    }
    const filename = entry.name;
    const srcFull = path.join(srcDir, filename);
    const ext = path.extname(filename).toLowerCase();
    if (imgOnly) {
      if (!IMG_SUFFIX.has(ext)) {
        skipFilter++;
        continue;
      }
    }
    const newName = `${basePrefix}_${seq}${ext}`;
    let targetFull: string;
    if (inplaceMode) {
      targetFull = path.join(srcDir, newName);
    } else {
      targetFull = path.join(outDir, newName);
    }
    if (fs.existsSync(targetFull)) {
      if (overwriteMode !== 1) {
        log(`[重名跳过] → ${newName}`);
        skipDup++;
        seq++;
        continue;
      } else {
        log(`[重名覆盖] → ${newName}`);
      }
    }
    try {
      if (inplaceMode) {
        await fsp.rename(srcFull, targetFull);
        log(`${filename.padEnd(45)} → ${newName}【原地】`);
      } else {
        await fsp.copyFile(srcFull, targetFull);
        log(`${filename.padEnd(45)} → ${newName}`);
      }
      success++;
    } catch (err: any) {
      log(`[失败] ${filename} | ${err.message}`);
      fail++;
    }
    seq++;
  }
  log("\n====================================================");
  log(
    `✅完成 | 成功:${success}  格式过滤跳过:${skipFilter}  重名跳过:${skipDup}  失败:${fail}`,
  );
}

/**3.图片按编号分发 */
async function handleImageDistribute(p: Record<string, any>, log: LogCallback) {
  const srcDir: string = p.ib_dis_src?.trim() ?? "";
  const targetRootDir: string = p.ib_dis_target?.trim() ?? "";
  const overwriteMode: number = Number(p.ib_dis_ov ?? 0);
  const overwrite = overwriteMode === 1;

  if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    log("[错误] 请选择有效的图片源目录");
    return;
  }
  if (
    !targetRootDir ||
    !fs.existsSync(targetRootDir) ||
    !fs.statSync(targetRootDir).isDirectory()
  ) {
    log("[错误] 请选择有效的目标根目录");
    return;
  }
  if (path.normalize(srcDir) === path.normalize(targetRootDir)) {
    log("[错误] 源文件夹与目标根目录不能为同一个目录");
    return;
  }

  log(`【源目录】${srcDir}`);
  log(`【目标根目录】${targetRootDir}`);
  log(`【重名策略】${overwrite ? "直接覆盖" : "跳过文件"}`);
  log("--------------------------------------------------");

  let success = 0;
  let noFolder = 0;
  let skipFile = 0;
  let skipDup = 0;
  let fail = 0;

  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }
    const fileName = entry.name;
    const srcFull = path.join(srcDir, fileName);
    const idx = fileName.indexOf("_");
    if (idx <= 0) {
      log(`[跳过] ${fileName} ：文件名没有找到下划线分隔符`);
      skipFile += 1;
      continue;
    }
    const keyPart = fileName.substring(0, idx);
    const destSubFolder = path.join(targetRootDir, keyPart);
    if (
      !fs.existsSync(destSubFolder) ||
      !fs.statSync(destSubFolder).isDirectory()
    ) {
      log(`[无对应文件夹] ${fileName} ，未找到子目录：${keyPart}`);
      noFolder += 1;
      continue;
    }
    const dstFilePath = path.join(destSubFolder, fileName);
    if (fs.existsSync(dstFilePath)) {
      if (!overwrite) {
        log(`[重名跳过] ${fileName} ，目标目录已存在该文件`);
        skipDup += 1;
        continue;
      } else {
        log(`[重名覆盖] ${fileName}`);
      }
    }
    try {
      await fsp.copyFile(srcFull, dstFilePath);
      log(`${fileName.padEnd(45)} → 放入 ${keyPart}/`);
      success += 1;
    } catch (err: any) {
      log(`[复制失败] ${fileName} ｜ ${String(err.message)}`);
      fail += 1;
    }
  }
  log("\n========================================");
  log(
    `✅分发完成 | 成功复制:${success}  无匹配文件夹:${noFolder}  无下划线跳过:${skipFile}  重名跳过:${skipDup}  失败:${fail}`,
  );
}

/**4.图片追加标识导出 */
async function handleAppendSuffixExport(
  p: Record<string, any>,
  log: LogCallback,
) {
  const srcDir: string = p.ib_ap_src?.trim() ?? "";
  const outDir: string = p.ib_ap_out?.trim() ?? "";
  const appendText: string = p.ib_ap_text?.trim() ?? "";
  const filterImgOnly: boolean = !!p.ib_ap_imgonly;
  const rmSubDirWhenClean: boolean = !!p.ib_ap_rmdir;
  const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);

  if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    log("[错误] 请选择有效的源文件夹");
    return;
  }
  if (!outDir || !fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
    log("[错误] 请选择有效的输出文件夹");
    return;
  }
  if (path.normalize(srcDir) === path.normalize(outDir)) {
    log("[错误] 源文件夹与输出文件夹不能为同一个目录");
    return;
  }
  if (!appendText) {
    log("[错误] 追加标识不能为空");
    return;
  }

  log(`【源目录】${srcDir}`);
  log(`【输出目录】${outDir}`);
  log(`【追加标识】_${appendText}`);
  log("--------------------------------------------------");
  log("开始清理输出目录...");

  try {
    const entries = await fsp.readdir(outDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(outDir, entry.name);
      if (entry.isFile()) {
        await fsp.unlink(fullPath);
        log(`清理旧文件: ${entry.name}`);
      } else if (entry.isDirectory()) {
        if (rmSubDirWhenClean) {
          await fsp.rm(fullPath, { recursive: true, force: true });
          log(`清理旧子文件夹: ${entry.name}`);
        }
      }
    }
  } catch (err: any) {
    log(`[错误] 输出目录清理异常｜${String(err.message)}`);
    return;
  }

  log("\n开始复制生成新文件...");
  let success = 0;
  let skip = 0;
  let fail = 0;
  const srcEntries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of srcEntries) {
    if (entry.isDirectory()) {
      continue;
    }
    const fileName = entry.name;
    const srcFull = path.join(srcDir, fileName);
    const ext = path.extname(fileName).toLowerCase();
    if (filterImgOnly) {
      if (!imageExts.has(ext)) {
        skip += 1;
        continue;
      }
    }
    const baseName = path.basename(fileName, ext);
    const newFileName = `${baseName}_${appendText}${ext}`;
    const dstFull = path.join(outDir, newFileName);
    try {
      await fsp.copyFile(srcFull, dstFull);
      log(`${fileName.padEnd(45)} → ${newFileName}`);
      success += 1;
    } catch (err: any) {
      log(`[失败] ${fileName} ｜ ${String(err.message)}`);
      fail += 1;
    }
  }
  log("\n========================================");
  log(`✅执行完成 | 成功:${success}  跳过:${skip}  失败:${fail}`);
}
