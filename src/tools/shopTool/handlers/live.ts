import * as vscode from "vscode";
import * as fs from "fs";
import { Handler, HandlerCtx } from "./types.js";
import { LivePlanRow, Product } from "../db.js";
import { canonicalCode } from "../pricing.js";
import { firstImageFile } from "../images.js";
import { renderLiveGrid } from "../liveGrid.js";

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
  };
}