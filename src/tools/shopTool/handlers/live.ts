import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { Handler, HandlerCtx } from "./types.js";
import { LivePlanRow, Product } from "../db.js";
import { canonicalCode } from "../pricing.js";
import { firstImageFile } from "../images.js";
import { renderLiveGrid, renderStarOverviewGrid } from "../liveGrid.js";

function localYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// 直播域：选品星标、排品九宫格、星标/排品开关与生成
export function liveHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log, post } = h;
  const ctx = h.ctx;

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

    // 星标商品封面拼总览图：自动密度（≤9 用 3×3，再多按 4×4/5×5…），超过一张自动分页
    async renderStarOverview() {
      const dir = String(h.getSetting("image_dir") || "").trim();
      if (!dir || !fs.existsSync(dir)) {
        log("❌未设置有效的图片根目录（规则与设置里选）");
        return;
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
          };
        });
      if (rows.length === 0) {
        log("❌还没有打星标的商品（列表/画册点 ⭐，或右键商品行标记）");
        return;
      }
      let outDir = String(h.getSetting("live_out_dir") || "").trim();
      if (outDir && fs.existsSync(outDir)) {
        const ok = await ctx.confirm(`星标总览将输出到：${outDir}`, "点「取消」改为另选输出目录");
        if (!ok) {
          outDir = "";
        }
      }
      if (!outDir) {
        const picked = await ctx.selectFolder("选择星标总览输出目录");
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
      const side = Math.max(3, Math.ceil(Math.sqrt(rows.length)));
      const cap = side * side;
      const files: string[] = [];
      const total = rows.length;
      for (let i = 0; i < total; i += cap) {
        const chunk = rows.slice(i, i + cap);
        const fileName = `星标总览_${total}款_第${files.length + 1}张_${localYmd()}.jpg`;
        try {
          files.push(await renderStarOverviewGrid(chunk, outDir, fileName, side));
        } catch (err: any) {
          log(`❌第 ${files.length + 1} 张生成失败：${err.message}`);
        }
      }
      if (files.length === 0) {
        return;
      }
      const previews: Array<{ name: string; data: string }> = [];
      for (const f of files) {
        try {
          const buf = await sharp(f)
            .resize({ width: 900, withoutEnlargement: true })
            .jpeg({ quality: 82 })
            .toBuffer();
          previews.push({
            name: path.basename(f),
            data: `data:image/jpeg;base64,${buf.toString("base64")}`,
          });
        } catch {
          /* 单张预览失败跳过 */
        }
      }
      try {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outDir));
      } catch {
        /* 忽略打开失败 */
      }
      log(`🖼星标总览：${total} 款，已生成 ${files.length} 张 → ${outDir}`);
      post({ type: "starOverviewDone", dir: outDir, count: files.length, previews });
    },

    openStarOutDir() {
      const dir = String(h.getSetting("live_out_dir") || "").trim();
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