import * as fs from "fs";
import * as path from "path";

/** 读取本地图片，原生fs转base64 dataUrl */
export async function readImageToBase64(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let mime = "image/jpeg";
  if (ext === ".png") {mime = "image/png";}
  else if (ext === ".webp") {mime = "image/webp";}
  else if (ext === ".bmp") {mime = "image/bmp";}
  return `data:${mime};base64,${buf.toString("base64")}`;
}
