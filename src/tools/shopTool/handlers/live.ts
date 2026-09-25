import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { Handler, HandlerCtx } from "./types.js";
import { LivePlanRow, Product } from "../db.js";
import { canonicalCode } from "../pricing.js";
import { firstImageFile } from "../images.js";
import { renderLiveGrid, renderStarOverviewBuffer, renderStarOverviewGrid, StarLabelOptions } from "../liveGrid.js";

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
  const parseLabels = (msg: any): StarLabelOptions => {
    const rawFs = Number(msg?.labels?.fontSize);
    return {
      code: msg?.labels?.code !== false,
      costPrice: msg?.labels?.costPrice === true,
      salePrice: msg?.labels?.salePrice !== false,
      fontSize: Number.isFinite(rawFs) && rawFs > 0 ? Math.min(50, Math.max(1, Math.round(rawFs))) : 0,
    };
  };
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
    // 自动排版最多 10×10=100 款/张，超出自动拆多张：单张画布 ≤10240px，
    // 避免超过 sharp 像素上限（0x3FFF²）导致「Input image exceeds pixel limit」
    const side = Math.min(10, Math.max(3, Math.ceil(Math.sqrt(rows.length))));
    const cap = side * side;
    const chunks: Array<{ rows: StarRow[]; cols: number; rowsN: number }> = [];
    for (let i = 0; i < rows.length; i += cap) {
      chunks.push({ rows: rows.slice(i, i + cap), cols: side, rowsN: side });
    }
    return chunks;
  };

  // 星标总览图：先出第 1 张预览 → 前端翻页时按需单页渲染（renderStarOverviewPage）
  const renderPagePreview = async (
    chunk: { rows: StarRow[]; cols: number; rowsN: number },
    labels: StarLabelOptions,
    pageNo: number,
    total: number,
  ): Promise<{ name: string; data: string }> => {
    const buf = await renderStarOverviewBuffer(chunk.rows, chunk.cols, chunk.rowsN, labels, { preview: true });
    const small = await sharp(buf, { limitInputPixels: false })
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return {
      name: `星标总览_${total}款_第${pageNo + 1}张.jpg`,
      data: `data:image/jpeg;base64,${small.toString("base64")}`,
    };
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

    // 星标总览图：先出第 1 张预览 → 前端翻页时按需单页渲染（renderStarOverviewPage）
    async previewStarOverview(msg) {
      const rows = buildStarRows();
      if (!rows) {
        post({ type: "starOverviewPreview", total: 0, pageCount: 0, previews: [] });
        return;
      }
      const g = resolveGrid(msg);
      const labels = parseLabels(msg);
      db.setSetting("star_label_options", JSON.stringify(labels));
      const chunks = chunksOf(rows, g.cols, g.rows);
      const total = rows.length;
      const previews: Array<{ name: string; data: string }> = [];
      if (chunks.length > 0) {
        try {
          const first = await renderPagePreview(chunks[0], labels, 0, total);
          previews.push(first);
        } catch (err: any) {
          log(`⚠️第 1 张预览失败：${err.message}`);
        }
      }
      post({
        type: "starOverviewPreview",
        total,
        pageCount: chunks.length,
        previews,
        cols: g.cols || 0,
        rows: g.rows || 0,
      });
    },

    // 前端翻页：单页按需渲染（预览低分辨率），失败也回传，前端遮罩可显示并重试
    async renderStarOverviewPage(msg) {
      const rows = buildStarRows();
      if (!rows) {
        post({ type: "starOverviewPagePreview", page: Number(msg?.page ?? 0), token: String(msg?.token ?? ""), error: "当前没有星标商品" });
        return;
      }
      const g = resolveGrid(msg);
      const labels = parseLabels(msg);
      const page = Number(msg?.page ?? 0);
      const token = String(msg?.token ?? "");
      const chunks = chunksOf(rows, g.cols, g.rows);
      if (page < 0 || page >= chunks.length) {
        log(`⚠️第 ${page + 1} 张超出总览范围（共 ${chunks.length} 张）`);
        post({ type: "starOverviewPagePreview", page, token, error: "页码超出范围" });
        return;
      }
      try {
        const preview = await renderPagePreview(chunks[page], labels, page, rows.length);
        post({ type: "starOverviewPagePreview", page, token, preview });
      } catch (err: any) {
        log(`⚠️第 ${page + 1} 张渲染失败：${err.message}`);
        post({ type: "starOverviewPagePreview", page, token, error: err.message });
      }
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
      post({ type: "starOverviewProgress", page: 0, total, name: "", ok: true });
      for (const [i, chunk] of chunksOf(rows, g.cols, g.rows).entries()) {
        const fileName = `星标总览_${total}款_第${i + 1}张_${localYmd()}.jpg`;
        try {
          files.push(await renderStarOverviewGrid(chunk.rows, outDir, fileName, chunk.cols, chunk.rowsN, labels));
          post({ type: "starOverviewProgress", page: i + 1, total, name: fileName, ok: true });
        } catch (err: any) {
          log(`❌第 ${i + 1} 张生成失败：${err.message}`);
          post({ type: "starOverviewProgress", page: i + 1, total, name: fileName, ok: false });
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