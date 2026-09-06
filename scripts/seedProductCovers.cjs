const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const sharp = require("sharp");

const DEFAULT_DB = path.join(
  process.env.APPDATA,
  "Code",
  "User",
  "globalStorage",
  "faye.cherysis",
  "shop.db",
);

const dbPath = process.argv[2] || DEFAULT_DB;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".avif"]);

function coverSvg(code, color) {
  return `<svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="400" fill="${color}"/>
    <text x="200" y="150" text-anchor="middle" font-family="Arial, sans-serif" font-size="88" font-weight="700" fill="#ffffff">${code}</text>
    <text x="200" y="300" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" fill="rgba(255,255,255,0.85)">测试商品封面</text>
  </svg>`;
}

function hueColor(n) {
  const h = (n * 47) % 360;
  const s = 45;
  const l = 58;
  return `hsl(${h}, ${s}%, ${l}%)`;
}

const db = new Database(dbPath, { readonly: true });
const dir = String(db.prepare("SELECT value FROM settings WHERE key = 'image_dir'").get()?.value || "").trim();
const codes = db
  .prepare("SELECT code FROM products ORDER BY code")
  .all()
  .map((r) => String(r.code));
db.close();

if (!dir) {
  console.log("❌ settings.image_dir 为空，先在扩展里设置商品图片目录。");
  process.exit(1);
}
if (!fs.existsSync(dir)) {
  console.log(`❌ 图片目录不存在：${dir}`);
  process.exit(1);
}

let created = 0;
let skipped = 0;
let failed = 0;
const t0 = Date.now();

(async () => {
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const folder = path.join(dir, code);
    if (fs.existsSync(folder)) {
      const files = fs.readdirSync(folder).filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
      if (files.length > 0) {
        skipped++;
        continue;
      }
    }
    try {
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
      const n = Number(code.replace(/[^0-9]/g, "")) || 0;
      const svg = coverSvg(code, hueColor(n));
      const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
      fs.writeFileSync(path.join(folder, `${code}_1.jpg`), buf);
      created++;
    } catch (err) {
      failed++;
      console.log(`✗ ${code}: ${err.message}`);
    }
    if (created % 100 === 0 && created > 0) {
      console.log(`  …已生成 ${created}/${codes.length}`);
    }
  }

  const dt = Date.now() - t0;
  console.log(`✅ 完成：总 ${codes.length}｜新生成 ${created}｜已有跳过 ${skipped}｜失败 ${failed}`);
  console.log(`   图片目录：${dir}`);
  console.log(`   耗时：${dt} ms`);
})();