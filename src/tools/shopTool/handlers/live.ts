import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { Handler, HandlerCtx } from "./types.js";
import { LivePlanRow, Product } from "../db.js";
import { canonicalCode } from "../pricing.js";
import { firstImageFile, previewThumbPath } from "../images.js";
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
  // 拆成两步是有意的：starSelection 只读库不碰图片目录，starRowsOf 才去列文件夹。
  // 共享盘上一次 readdir 几十毫秒，预览只要当前这一页，没必要为出第 1 张把几十个星标
  // 编号的目录全列一遍（改一次排版/翻一页就重来一次，纯浪费）。
  type StarRow = { code: string; img: string | null; price: number; costPrice: number };
  /** 星标编号 + 顺带查出来的商品行。products 是无缓存全表读，共享盘上一次几十毫秒，
   *  一次请求里只读一次：这里查出来的 Map 直接透给 starRowsOf，别再读第二遍。 */
  type StarSelection = { codes: string[]; byCode: Map<string, Product> };

  const starSelection = (): StarSelection => {
    const byCode = new Map<string, Product>();
    const dir = h.imageDir();
    if (!dir || !fs.existsSync(dir)) {
      log("❌未设置有效的图片根目录（规则与设置里选）");
      return { codes: [], byCode };
    }
    const stars = db.getLiveStars();
    for (const p of db.getProducts()) {
      byCode.set(p.code, p);
    }
    const codes = stars.filter((code) => byCode.has(code)).sort();
    if (codes.length === 0) {
      log("❌还没有打星标的商品（列表/画册点 ⭐，或右键商品行标记）");
    }
    return { codes, byCode };
  };

  // 每行一次 readdir（{图片根目录}/{编号} 里最早一张当封面）
  const starRowsOf = (codes: string[], byCode: Map<string, Product>): StarRow[] => {
    const dir = h.imageDir();
    return codes.map((code) => {
      const p = byCode.get(code);
      return {
        code,
        img: dir ? firstImageFile(dir, code) : null,
        price: Number(p?.sale_price || 0),
        costPrice: Number(p?.cost_price || 0),
      };
    });
  };
  const parseLabels = (msg: any): StarLabelOptions => {
    const rawFs = Number(msg?.labels?.fontSize);
    return {
      code: msg?.labels?.code !== false,
      costPrice: msg?.labels?.costPrice === true,
      salePrice: msg?.labels?.salePrice !== false,
      fontSize: Number.isFinite(rawFs) && rawFs > 0 ? Math.min(50, Math.max(1, Math.round(rawFs))) : 0,
    };
  };
  // 没记过排版时的默认档。自动档按款数开方，星标 60 款就是首屏 8×8=64 格，
  // 每格从共享盘拉一张 4.5MB 原图 ≈ 290MB（512 缩略图缓存只救第二次，首次必走原图）。
  // 3×3 只读 9 张，是数量级的差别；想要一屏塞满的人显式选「自动（智能）」。
  const DEFAULT_GRID = { cols: 3, rows: 3 };
  // 排版解析：0/0＝自动（方形）；否则每张固定 cols×rows，末页留空
  const resolveGrid = (msg: any): { cols: number; rows: number } => {
    const clamp = (n: number) => Math.min(10, Math.max(1, Math.round(n) || 1));
    // 前端显式点了「自动（智能）」：必须在这里就停住。否则 cols/rows 是 0/0，
    // 会掉到下面「上次记的固定排版」那档，自动档从此选不到（历史行为就是个坑）。
    if (msg?.auto === true) {
      return { cols: 0, rows: 0 };
    }
    const mc = Number(msg?.cols);
    const mr = Number(msg?.rows);
    if (mc > 0 && mr > 0) {
      return { cols: clamp(mc), rows: clamp(mr) };
    }
    // 只有上次用的也是固定排版才回落；记的是 auto 就继续保持自动
    if (db.getSetting("star_grid_mode") !== "auto") {
      const sc = Number(db.getSetting("star_grid_cols") || "0");
      const sr = Number(db.getSetting("star_grid_rows") || "0");
      if (sc > 0 && sr > 0) {
        return { cols: clamp(sc), rows: clamp(sr) };
      }
    }
    return { ...DEFAULT_GRID };
  };
  // 分页：按编号切，不按行切 —— 切完再按需解析那一页的图片
  const chunksOf = (
    codes: string[],
    cols: number,
    rowsN: number,
  ): Array<{ codes: string[]; cols: number; rowsN: number }> => {
    if (cols > 0 && rowsN > 0) {
      const cap = cols * rowsN;
      const chunks: Array<{ codes: string[]; cols: number; rowsN: number }> = [];
      for (let i = 0; i < codes.length; i += cap) {
        chunks.push({ codes: codes.slice(i, i + cap), cols, rowsN });
      }
      return chunks;
    }
    // 自动排版最多 10×10=100 款/张，超出自动拆多张：单张画布 ≤10240px，
    // 避免超过 sharp 像素上限（0x3FFF²）导致「Input image exceeds pixel limit」
    const side = Math.min(10, Math.max(3, Math.ceil(Math.sqrt(codes.length))));
    const cap = side * side;
    const chunks: Array<{ codes: string[]; cols: number; rowsN: number }> = [];
    for (let i = 0; i < codes.length; i += cap) {
      chunks.push({ codes: codes.slice(i, i + cap), cols: side, rowsN: side });
    }
    return chunks;
  };

  // 星标总览图：先出第 1 张预览 → 前端翻页时按需单页渲染（renderStarOverviewPage）
  const renderPagePreview = async (
    chunk: { codes: string[]; cols: number; rowsN: number },
    byCode: Map<string, Product>,
    labels: StarLabelOptions,
    pageNo: number,
    total: number,
  ): Promise<{ name: string; data: string }> => {
    const buf = await renderStarOverviewBuffer(starRowsOf(chunk.codes, byCode), chunk.cols, chunk.rowsN, labels, {
      preview: true,
      // 每格换成本机 512 等比小图：共享盘上原图动辄几 MB，9~25 格逐张拉+解码能到好几秒，
      // 而预览格子最大才 360px，喂本机小图看不出差别，还顺带让改排版/翻页变成纯本地操作。
      imgFor: (code, src) => previewThumbPath(src || "", ctx.defaultStorageDir, code),
    });
    const small = await sharp(buf, { limitInputPixels: false })
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return {
      name: `星标总览_${total}款_第${pageNo + 1}张.jpg`,
      data: `data:image/jpeg;base64,${small.toString("base64")}`,
    };
  };

  // 九宫格生成的进度回传：前端据此把按钮置灰并显示「第 n/N 组」。
  // 硬规矩：generateLiveGrid 的每一条退出路径都必须发一条终态
  // （done / error / cancelled），否则前端会一直卡在「生成中」，按钮再也点不动。
  const gridStatus = (
    phase: "start" | "dialog" | "running" | "done" | "error" | "cancelled",
    extra: Record<string, unknown> = {},
  ): void => {
    post({ type: "liveGridStatus", phase, ...extra });
  };

  // generateLiveGrid 整体跑在这里收口：handler 里任何一处抛出（读库、建目录、渲染、写文件…）
  // 都要补一条终态 —— toolRegistry 的兜底 catch 只写日志，前端按钮会永远停在「生成中」点不动。
  const runGridJob = async (job: () => Promise<void>): Promise<void> => {
    try {
      await job();
    } catch (err: any) {
      log(`❌生成九宫格出错：${err?.message ?? err}`);
      gridStatus("error", { text: "生成过程出错，已中止" });
    }
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

    generateLiveGrid(msg) {
      return runGridJob(async () => {
        const rawPlan = Array.isArray(msg.plan) ? (msg.plan as any[]) : [];
        const plan: LivePlanRow[] = rawPlan.map((r) => ({
          group_no: Number(r.group_no),
          slot_no: Number(r.slot_no),
          code: String(r.code ?? ""),
        }));
        db.replaceLivePlan(plan);
        const dir = h.imageDir();
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
          gridStatus("error", { text: "没有可生成的格子" });
          return;
        }
        gridStatus("start");
        let outDir = String(h.getSetting("live_out_dir") || "").trim();
        while (true) {
          // 原生对话框是模态的，网页这边看着像卡住，所以进循环先报一次在等什么
          gridStatus("dialog", {
            text: outDir ? `确认输出目录：${outDir}` : "请选择输出目录…",
          });
          let validDir = false;
          if (outDir) {
            try {
              validDir = fs.statSync(outDir).isDirectory();
            } catch {
              validDir = false;
            }
          }
          if (!validDir) {
            const picked = await ctx.selectFolder("选择直播排品九宫格输出目录");
            if (!picked) {
              log("❌未选择输出目录，已取消");
              gridStatus("cancelled", { text: "未选择输出目录" });
              return;
            }
            outDir = picked;
            db.setSetting("live_out_dir", outDir);
            h.postLiveState();
          }
          const action = await ctx.chooseAction(
            "确认生成九宫格",
            outDir,
            ["确定生成", "更换目录", "取消"],
          );
          if (action === "确定生成") {
            break;
          }
          if (action !== "更换目录") {
            log("❌已取消生成");
            gridStatus("cancelled", { text: "已取消生成" });
            return;
          }
          outDir = "";
        }
        if (!fs.existsSync(outDir)) {
          try {
            fs.mkdirSync(outDir, { recursive: true });
          } catch (err: any) {
            log(`❌创建输出目录失败：${err.message}`);
            gridStatus("error", { text: "创建输出目录失败" });
            return;
          }
        }
        const onlyGroups = Array.isArray(msg.groups) ? new Set((msg.groups as any[]).map(Number)) : null;
        const labelMode: "num" | "code" | "none" =
          msg.labelMode === "code" || msg.labelMode === "none" ? msg.labelMode : "num";
        let groupNos = [...groups.keys()].sort((a, b) => a - b);
        if (onlyGroups) {
          groupNos = groupNos.filter((g) => onlyGroups.has(g));
        }
        if (groupNos.length === 0) {
          log("❌没有可生成的组");
          gridStatus("error", { text: "没有可生成的组" });
          return;
        }
        const files: string[] = [];
        for (const [i, g] of groupNos.entries()) {
          const slots = groups.get(g)!;
          const cells: Array<{ code: string; img: string | null }> = [];
          for (let s = 1; s <= 9; s++) {
            const code = slots.get(s) ?? "";
            cells.push({ code, img: code ? firstImageFile(dir, code) : null });
          }
          gridStatus("running", { group: g, done: i, total: groupNos.length });
          try {
            files.push(await renderLiveGrid(cells, outDir, g, labelMode));
            gridStatus("running", { group: g, done: i + 1, total: groupNos.length, ok: true });
          } catch (err: any) {
            log(`❌第 ${g} 组生成失败：${err.message}`);
            gridStatus("running", { group: g, done: i + 1, total: groupNos.length, ok: false });
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
        gridStatus("done", { count: files.length, dir: outDir });
        h.postLiveState();
      });
    },

    // 星标总览图：先出第 1 张预览 → 前端翻页时按需单页渲染（renderStarOverviewPage）
    async previewStarOverview(msg) {
      const sel = starSelection();
      if (sel.codes.length === 0) {
        post({ type: "starOverviewPreview", total: 0, pageCount: 0, previews: [] });
        return;
      }
      const g = resolveGrid(msg);
      const labels = parseLabels(msg);
      db.setSetting("star_label_options", JSON.stringify(labels));
      const chunks = chunksOf(sel.codes, g.cols, g.rows);
      const total = sel.codes.length;
      const previews: Array<{ name: string; data: string }> = [];
      if (chunks.length > 0) {
        try {
          const first = await renderPagePreview(chunks[0], sel.byCode, labels, 0, total);
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
        // 回传「现在是自动档」：cols/rows 为 0 只在前端才认得出是自动，
        // 光看一对 0 分不清「自动方阵」和「回落默认 3×3」，标题会写错。
        auto: g.cols === 0 && g.rows === 0,
      });
    },

    // 前端翻页：单页按需渲染（预览低分辨率），失败也回传，前端遮罩可显示并重试
    async renderStarOverviewPage(msg) {
      const sel = starSelection();
      if (sel.codes.length === 0) {
        post({ type: "starOverviewPagePreview", page: Number(msg?.page ?? 0), token: String(msg?.token ?? ""), error: "当前没有星标商品" });
        return;
      }
      const g = resolveGrid(msg);
      const labels = parseLabels(msg);
      const page = Number(msg?.page ?? 0);
      const token = String(msg?.token ?? "");
      const chunks = chunksOf(sel.codes, g.cols, g.rows);
      if (page < 0 || page >= chunks.length) {
        log(`⚠️第 ${page + 1} 张超出总览范围（共 ${chunks.length} 张）`);
        post({ type: "starOverviewPagePreview", page, token, error: "页码超出范围" });
        return;
      }
      try {
        const preview = await renderPagePreview(chunks[page], sel.byCode, labels, page, sel.codes.length);
        post({ type: "starOverviewPagePreview", page, token, preview });
      } catch (err: any) {
        log(`⚠️第 ${page + 1} 张渲染失败：${err.message}`);
        post({ type: "starOverviewPagePreview", page, token, error: err.message });
      }
    },

    // 预览确认后才落盘（每次弹文件夹选择器 → 写文件 → 打开输出目录）
    async generateStarOverview(msg) {
      const sel = starSelection();
      if (sel.codes.length === 0) {
        post({ type: "starOverviewCancelled" });
        return;
      }
      const g = resolveGrid(msg);
      const labels = parseLabels(msg);
      // 弹窗里选过排版 → 记住（含「选了自动」这件事本身），下次预览/生成直接用
      if (msg?.auto === true) {
        db.setSetting("star_grid_mode", "auto");
      } else if (Number(msg?.cols) > 0 && Number(msg?.rows) > 0) {
        db.setSetting("star_grid_cols", String(g.cols));
        db.setSetting("star_grid_rows", String(g.rows));
        db.setSetting("star_grid_mode", "fixed");
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
      const chunks = chunksOf(sel.codes, g.cols, g.rows);
      const pages = chunks.length;
      post({ type: "starOverviewProgress", page: 0, total: pages, name: "", ok: true });
      for (const [i, chunk] of chunks.entries()) {
        const fileName = `星标总览_${sel.codes.length}款_第${i + 1}张_${localYmd()}.jpg`;
        try {
          // 写盘用原图（不传 imgFor）：预览可以拿小图糊弄，成品必须清楚
          files.push(await renderStarOverviewGrid(starRowsOf(chunk.codes, sel.byCode), outDir, fileName, chunk.cols, chunk.rowsN, labels));
          post({ type: "starOverviewProgress", page: i + 1, total: pages, name: fileName, ok: true });
        } catch (err: any) {
          log(`❌第 ${i + 1} 张生成失败：${err.message}`);
          post({ type: "starOverviewProgress", page: i + 1, total: pages, name: fileName, ok: false });
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
      log(`🖼星标总览：${sel.codes.length} 款，已生成 ${files.length} 张 → ${outDir}`);
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