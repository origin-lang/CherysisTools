import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { Handler, HandlerCtx } from "./types.js";
import { LivePlanRow, Product } from "../db.js";
import { canonicalCode } from "../pricing.js";
import { firstImageFile } from "../images.js";
import { renderLiveGrid, renderStarOverviewBuffer, renderStarOverviewGrid } from "../liveGrid.js";

function localYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// 直播域：选品星标、排品九宫格、星标/排品开关与生成
export function liveHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;
  const ctx = h.ctx;

  // 星标总览图＝「先预览，点生成才落盘」：两份 handler 共用解析星标行/分页逻辑
  const buildStarRows = () => {
    const dir = String(h.getSetting("image_dir") || "").trim();
    if (!dir || !fs.existsSync(dir)) {
      log("❌未设置有效的图片根目录（规则与设置里选）");
      return null;
    }
    const stars = db.getLiveStars();
    const byCode = new Map<string, Product>();
    for (const p of db.getProducts()) {
      byCode.set(p.code, p);
    }
    const rows = stars
      .filter((code) => byCode.has(code))
      .sort()
      .map((code) => {
        const p = byCode.get(code)!;
        return {
          code,
          img: firstImageFile(dir, code),
          price: Number(p.sale_price || 0),
          costPrice: Number(p.cost_price || 0),
        };
      });
    if (rows.length === 0) {
      log("❌还没有打星标的商品（列表/画册点 ⭐，或右键商品行标记）");
      return null;
    }
    return rows as Array<{ code: string; img: string | null; price: number; costPrice: number }>;
  };

  type StarRow = { code: string; img: string | null; price: number; costPrice: number };
  const parseLabels = (msg: any): { code: boolean; costPrice: boolean; salePrice: boolean } => ({
    code: msg?.labels?.code !== false,
    costPrice: msg?.labels?.costPrice === true,
    salePrice: msg?.labels?.salePrice !== false,
  });
  // 排版解析：0/缺省＝自动（方形）；否则每张固定 cols×rows，末页留空
  const resolveGrid = (msg: any): { cols: number; rows: number } => {
    const fromMsg =
      Number(msg?.cols) > 0 && Number(msg?.rows) > 0
        ? { cols: Number(msg.cols), rows: Number(msg.rows) }
        : null;
    const fromSettings =
      Number(db.getSetting("star_grid_cols") || "0") > 0 &&
      Number(db.getSetting("star_grid_rows") || "0") > 0
        ? { cols: Number(db.getSetting("star_grid_cols")), rows: Number(db.getSetting("star_grid_rows")) }
        : null;
    const g = fromMsg ?? fromSettings;
    if (!g) {
      return { cols: 0, rows: 0 };
    }
    return { cols: Math.min(10, Math.max(1, g.cols)), rows: Math.min(10, Math.max(1, g.rows)) };
  };
  const chunksOf = (
    rows: StarRow[],
    cols: number,
    rowsN: number,
  ): Array<{ rows: StarRow[]; cols: number; rowsN: number }> => {
    if (cols > 0 && rowsN > 0) {
      const cap = cols * rowsN;
      const chunks: Array<{ rows: StarRow[]; cols: number; rowsN: number }> = [];
      for (let i = 0; i < rows.length; i += cap) {
        chunks.push({ rows: rows.slice(i, i + cap), cols, rowsN });
      }
      return chunks;
    }
    const side = Math.max(3, Math.ceil(Math.sqrt(rows.length)));
    const cap = side * side;
    const chunks: Array<{ rows: StarRow[]; cols: number; rowsN: number }> = [];
    for (let i = 0; i < rows.length; i += cap) {
      chunks.push({ rows: rows.slice(i, i + cap), cols: side, rowsN: side });
    }
    return chunks;
  };

  return {
    toggleLiveStar(msg) {
      const code = canonicalCode(String(msg.code ?? ""));
      if (!code) {
        log("❌编号格式错误");
        return;
      }
      const set = new Set(db.getLiveStars());
      const adding = !set.has(code);
      if (adding) {
        set.add(code);
      } else {
        set.delete(code);
      }
      db.replaceLiveStars([...set]);
      h.postLiveState();
      log(adding ? `⭐已选 ${code}` : `☆已取消 ${code}`);
    },

    setLiveStars(msg) {
      const codes = Array.isArray(msg.codes) ? (msg.codes as unknown[]) : [];
      const valid = new Set(db.getProducts().map((p) => p.code));
      const set = new Set<string>();
      for (const raw of codes) {
        const c = canonicalCode(raw);
        if (c && valid.has(c)) {
          set.add(c);
        }
      }
      db.replaceLiveStars([...set].sort());
      h.postLiveState();
    },

    clearLiveStars() {
      db.replaceLiveStars([]);
      h.postLiveState();
      log("🗑已取消全部星标");
    },

    saveLivePlan(msg) {
      const raw = Array.isArray(msg.plan) ? (msg.plan as any[]) : [];
      db.replaceLivePlan(
        raw.map((r) => ({
          group_no: Number(r.group_no),
          slot_no: Number(r.slot_no),
          code: String(r.code ?? ""),
        })),
      );
      h.postLiveState();
    },

    clearLivePlan() {
      db.replaceLivePlan([]);
      h.postLiveState();
      log("🗑已清空排品格子（已选商品保留）");
    },

    async pickLiveOutDir() {
      const dir = await ctx.selectFolder("选择直播排品九宫格输出目录");
      if (!dir) {
        return;
      }
      db.setSetting("live_out_dir", dir);
      log(`📁直播排品输出目录：${dir}`);
      h.postLiveState();
    },

    async generateLiveGrid(msg) {
      const rawPlan = Array.isArray(msg.plan) ? (msg.plan as any[]) : [];
      const plan: LivePlanRow[] = rawPlan.map((r) => ({
        group_no: Number(r.group_no),
        slot_no: Number(r.slot_no),
        code: String(r.code ?? ""),
      }));
      db.replaceLivePlan(plan);
      const dir = String(h.getSetting("image_dir") || "").trim();
      const products = db.getProducts();
      const byCode = new Map<string, Product>();
      for (const p of products) {
        byCode.set(p.code, p);
      }
      const groups = new Map<number, Map<number, string>>();
      for (const r of plan) {
        if (!byCode.has(r.code)) {
          continue;
        }
        let slots = groups.get(r.group_no);
        if (!slots) {
          slots = new Map();
          groups.set(r.group_no, slots);
        }
        slots.set(r.slot_no, r.code);
      }
      if (groups.size === 0) {
        log("❌先填至少一个排品格子再生成");
        return;
      }
      let outDir = String(h.getSetting("live_out_dir") || "").trim();
      if (outDir && fs.existsSync(outDir)) {
        const ok = await ctx.confirm(`直播排品将输出到：${outDir}`, "点「取消」改为另选输出目录");
        if (!ok) {
          outDir = "";
        }
      }
      if (!outDir) {
        const picked = await ctx.selectFolder("选择直播排品九宫格输出目录");
        if (!picked) {
          log("❌未选择输出目录，已取消");
          return;
        }
        outDir = picked;
        db.setSetting("live_out_dir", outDir);
      }
      if (!fs.existsSync(outDir)) {
        try {
          fs.mkdirSync(outDir, { recursive: true });
        } catch (err: any) {
          log(`❌创建输出目录失败：${err.message}`);
          return;
        }
      }
      const onlyGroups = Array.isArray(msg.groups) ? new Set((msg.groups as any[]).map(Number)) : null;
      let groupNos = [...groups.keys()].sort((a, b) => a - b);
      if (onlyGroups) {
        groupNos = groupNos.filter((g) => onlyGroups.has(g));
      }
      if (groupNos.length === 0) {
        log("❌没有可生成的组");
        return;
      }
      const files: string[] = [];
      for (const g of groupNos) {
        const slots = groups.get(g)!;
        const cells: Array<{ code: string; img: string | null }> = [];
        for (let s = 1; s <= 9; s++) {
          const code = slots.get(s) ?? "";
          cells.push({ code, img: code ? firstImageFile(dir, code) : null });
        }
        try {
          files.push(await renderLiveGrid(cells, outDir, g));
        } catch (err: any) {
          log(`❌第 ${g} 组生成失败：${err.message}`);
        }
      }
      try {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outDir));
      } catch {
        /* 忽略打开失败 */
      }
      log(
        `🖼直播九宫格完成 ${files.length} 张（${groupNos.map((g) => `第${g}组`).join(" ")}）`,
      );
      post({ type: "liveGenerated", dir: outDir, count: files.length });
      h.postLiveState();
    },

    // 星标总览图：两组 handler 逻辑见工厂顶部 buildStarRows/chunksOf
    async previewStarOverview(msg) {
      const rows = buildStarRows();
      if (!rows) {
        return;
      }
      const g = resolveGrid(msg);
      const labels = parseLabels(msg);
      db.setSetting("star_label_options", JSON.stringify(labels));
      const previews: Array<{ name: string; data: string }> = [];
      const total = rows.length;
      for (const [i, chunk] of chunksOf(rows, g.cols, g.rows).entries()) {
        try {
          const buf = await renderStarOverviewBuffer(chunk.rows, chunk.cols, chunk.rowsN, labels);
          const small = await sharp(buf)
            .resize({ width: 900, withoutEnlargement: true })
            .jpeg({ quality: 82 })
            .toBuffer();
          previews.push({
            name: `星标总览_${total}款_第${i + 1}张.jpg`,
            data: `data:image/jpeg;base64,${small.toString("base64")}`,
          });
        } catch (err: any) {
          log(`⚠️第 ${i + 1} 张预览失败：${err.message}`);
        }
      }
      post({
        type: "starOverviewPreview",
        total,
        count: previews.length,
        previews,
        cols: g.cols || 0,
        rows: g.rows || 0,
      });
    },

    // 预览确认后才落盘（每次弹文件夹选择器 → 写文件 → 打开输出目录）
    async generateStarOverview(msg) {
      const rows = buildStarRows();
      if (!rows) {
        return;
      }
      const g = resolveGrid(msg);
      const labels = parseLabels(msg);
      // 弹窗里选过排版 → 记住，下次预览/生成直接用
      if (Number(msg?.cols) > 0 && Number(msg?.rows) > 0) {
        db.setSetting("star_grid_cols", String(g.cols));
        db.setSetting("star_grid_rows", String(g.rows));
      }
      db.setSetting("star_label_options", JSON.stringify(labels));
      const outDir = await ctx.selectFolder("选择星标总览输出目录");
      if (!outDir) {
        log("❌未选择输出目录，已取消");
        post({ type: "starOverviewCancelled" });
        return;
      }
      if (!fs.existsSync(outDir)) {
        try {
          fs.mkdirSync(outDir, { recursive: true });
        } catch (err: any) {
          log(`❌创建输出目录失败：${err.message}`);
          post({ type: "starOverviewCancelled" });
          return;
        }
      }
      const files: string[] = [];
      const total = rows.length;
      for (const [i, chunk] of chunksOf(rows, g.cols, g.rows).entries()) {
        const fileName = `星标总览_${total}款_第${i + 1}张_${localYmd()}.jpg`;
        try {
          files.push(await renderStarOverviewGrid(chunk.rows, outDir, fileName, chunk.cols, chunk.rowsN, labels));
        } catch (err: any) {
          log(`❌第 ${i + 1} 张生成失败：${err.message}`);
        }
      }
      if (files.length === 0) {
        post({ type: "starOverviewCancelled" });
        return;
      }
      try {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outDir));
      } catch {
        /* 忽略打开失败 */
      }
      log(`🖼星标总览：${total} 款，已生成 ${files.length} 张 → ${outDir}`);
      post({ type: "starOverviewDone", dir: outDir, count: files.length });
    },

    openStarOutDir(msg) {
      const dir =
        String(msg?.dir || "").trim() ||
        String(h.getSetting("live_out_dir") || "").trim();
      if (!dir || !fs.existsSync(dir)) {
        log("❌还没生成过总览图/九宫格（未设置输出目录）");
        return;
      }
      try {
        vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
      } catch {
        /* 忽略打开失败 */
      }
    },
  };
}