// 一次性小工具：给 .ps1 加 UTF-8 BOM。
// 为什么需要：Windows PowerShell 5.1（就是 powershell.exe，双击 .cmd 时用的那个）
// 读无 BOM 的 UTF-8 文件时按 ANSI 解，中文全成乱码 → 解析报 Unexpected token。
// PowerShell 7（pwsh）默认 UTF-8 所以看不出问题 —— 这正是"我这能跑、你那不行"的经典来源。
// 用法：node scripts/fix-ps1-bom.cjs [文件…]（不给参数就处理 scripts 下所有 .ps1）
const fs = require("fs");
const path = require("path");

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs
      .readdirSync(path.join(__dirname))
      .filter((f) => f.endsWith(".ps1"))
      .map((f) => path.join(__dirname, f));

let n = 0;
for (const t of targets) {
  const s = fs.readFileSync(t, "utf8");
  if (s.startsWith("\uFEFF")) {
    console.log(`已有 BOM：${t}`);
    continue;
  }
  fs.writeFileSync(t, "\uFEFF" + s, "utf8");
  console.log(`加好 BOM：${t}`);
  n++;
}
console.log(`完成（改了 ${n} 个文件）`);
