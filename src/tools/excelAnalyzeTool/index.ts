import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as XLSX from "xlsx";
import { exec } from "child_process";
import { ToolDefinition } from "../../core/toolRegistry.js";

/** 已加载的原始数据（跨消息保留） */
let loadedFile: {
  filePath: string;
  columns: string[];
  rows: Record<string, any>[];
} | undefined;

/** 判断是否为空 (null 或 undefined) */
function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

export type AggType = "sum" | "count" | "mean";
export type ChartType = "bar" | "line" | "pie";
export type InvalidMode = "success_only" | "fail_only" | "separate" | "merge_other";

/** 一条分组规则，regex 非空才生效 */
export interface GroupRule {
  name: string;
  regex: string;
}

/** 带注释的正则（仅用于校验，不用于分组名） */
interface CompiledRule {
  name: string;
  re: RegExp;
}

export interface StatRow {
  xName: string;
  value: number;
}

/** 读取 Excel/CSV 文件，返回第一张工作表的列名与行数据 */
function readFileData(filePath: string): { columns: string[]; rows: Record<string, any>[] } {
  const wb = XLSX.readFile(filePath);
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) {
    throw new Error("文件中没有工作表");
  }
  const ws = wb.Sheets[firstSheet];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true }) as Array<
    Record<string, any>
  >;
  if (!rawRows.length) {
    throw new Error("文件中没有数据行");
  }
  const columns = Object.keys(rawRows[0]);
  return { columns, rows: rawRows };
}

/** 核心统计：多分组规则(带优先级)清洗 + 聚合 + 匹配结果处理策略 */
export function analyzeRows(
  rows: Record<string, any>[],
  xCol: string,
  yCol: string,
  rules: GroupRule[],
  aggType: AggType,
  invalidMode: InvalidMode,
): StatRow[] {
  // 仅保留非空正则的规则，并预编译，保持优先级顺序（前在前）
  const effectiveRules = rules
    .filter((rg) => rg.regex.trim() !== "")
    .map((rg) => ({ name: rg.name, re: new RegExp(rg.regex) }));

  interface WorkRow {
    key: string | null;
    ok: boolean;
    y: number | null;
  }

  const work: WorkRow[] = [];
  for (const r of rows) {
    const xVal = r[xCol];
    const s = isNullish(xVal) ? null : String(xVal);

    // 无规则 / 单规则保持原逻辑；多规则按优先级取第一条命中
    let ok = true;
    let key: string | null;
    if (effectiveRules.length === 0) {
      // 未填任何正则：原文作为标签，恒为匹配成功
      key = s === null ? "" : s;
      ok = true;
    } else {
      let matched = false;
      let extracted: string | null = null;
      if (s !== null) {
        for (const rg of effectiveRules) {
          const m = rg.re.exec(s);
          if (m) {
            matched = true;
            extracted = m.length >= 2 ? m[1] : m[0];
            break; // 命中规则即不再参与后续分组
          }
        }
      }
      ok = matched;
      // 命中的走提取分组；未命中的走之前的逻辑（原文作为标签）
      key = matched ? extracted : s;
    }

    // Y 值：sum/mean 需要数值
    let y: number | null = null;
    if (aggType !== "count") {
      const v = r[yCol];
      if (!isNullish(v) && v !== "") {
        const num = Number(v);
        y = isNaN(num) ? null : num;
      }
    }
    work.push({ key, ok, y });
  }

  // sum/mean：丢弃 Y 缺失/非数字的行（与 pandas dropna 一致）
  let filtered = work;
  if (aggType !== "count") {
    filtered = work.filter((w) => !isNullish(w.y));
  }

  const sumMap = new Map<string, number>();
  const countMap = new Map<string, number>();

  for (const w of filtered) {
    let k: string;
    if (invalidMode === "merge_other" && !w.ok) {
      k = "其他";
    } else if (w.key === null || w.key === undefined) {
      k = "";
    } else {
      k = w.key;
    }

    if (invalidMode === "success_only" && !w.ok) {
      continue;
    }
    if (invalidMode === "fail_only" && w.ok) {
      continue;
    }

    if (aggType === "count") {
      sumMap.set(k, (sumMap.get(k) || 0) + 1);
    } else {
      sumMap.set(k, (sumMap.get(k) || 0) + w.y!);
      countMap.set(k, (countMap.get(k) || 0) + 1);
    }
  }

  const results: StatRow[] = [];
  for (const [k, v] of sumMap.entries()) {
    let value = v;
    if (aggType === "mean") {
      value = v / (countMap.get(k) || 1);
    }
    results.push({ xName: k, value });
  }
  results.sort((a, b) => b.value - a.value);
  return results;
}

/** 导出统计表格为 Excel */
async function exportStatToExcel(statRows: StatRow[], xHeader: string, yHeader: string, outFile: string) {
  const aoa: (string | number)[][] = [["序号", xHeader, yHeader]];
  statRows.forEach((r, i) => {
    aoa.push([i + 1, r.xName, Math.round(r.value * 100) / 100]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "统计结果");
  XLSX.writeFile(wb, outFile);
}

function genTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
}

export const excelAnalyzeTool: ToolDefinition = {
  toolName: "excelAnalyzeTool",
  title: "📊Excel清洗统计绘图",
  fragmentPath: "tools/excelAnalyzeTool/fragment.html",
  clientScriptPath: "tools/excelAnalyzeTool/client.js",
  async handleMessage(msg, ctx) {
    switch (msg.type) {
      case "selectFile": {
        const fp = await ctx.selectFile({
          数据文件: ["xlsx", "xls", "csv"],
        });
        if (!fp) {
          break;
        }
        try {
          const data = readFileData(fp);
          loadedFile = { filePath: fp, columns: data.columns, rows: data.rows };
          ctx.postToWebview({
            type: "fileLoaded",
            filePath: fp,
            columns: data.columns,
            rowCount: data.rows.length,
          });
        } catch (err: any) {
          ctx.log(`❌读取文件失败：${err.message}`);
        }
        break;
      }
      case "runAnalysis": {
        ctx.postToWebview({ type: "clearLog" });
        if (!loadedFile) {
          ctx.log("⚠请先选择Excel/CSV文件");
          break;
        }
        const xCol: string = msg.xCol;
        const yCol: string = msg.yCol;
        // 多分组规则：数组 [{name, regex}]，按优先级从前到后匹配
        const rules: GroupRule[] = Array.isArray(msg.rules)
          ? msg.rules.map((r: any) => ({
              name: typeof r?.name === "string" ? r.name : "",
              regex: typeof r?.regex === "string" ? r.regex : "",
            }))
          : [];
        const aggType: AggType = msg.aggType;
        const chartType: ChartType = msg.chartType;
        const invalidMode: InvalidMode = msg.invalidMode;

        if (!xCol) {
          ctx.log("⚠请选择【X轴原始列】");
          break;
        }
        if (!yCol) {
          ctx.log("⚠请选择【Y轴数值列】");
          break;
        }
        try {
          const statRows = analyzeRows(
            loadedFile.rows,
            xCol,
            yCol,
            rules,
            aggType,
            invalidMode,
          );
          const aggLabel = aggType === "sum" ? "求和" : aggType === "mean" ? "平均值" : "计数";
          const valueHeader = `${yCol}·${aggLabel}`;
          ctx.postToWebview({
            type: "analysisResult",
            statRows,
            xHeader: xCol,
            yHeader: valueHeader,
            chartType,
            rowCount: loadedFile.rows.length,
          });
        } catch (err: any) {
          ctx.log(`❌分析异常：${err.message}`);
        }
        break;
      }
      case "selectOutFolder": {
        const dir = await ctx.selectFolder();
        if (dir) {
          ctx.postToWebview({ type: "outFolderSelected", path: dir });
        }
        break;
      }
      case "openTargetFolder": {
        const target = (msg.targetPath ?? "").trim();
        if (!target) {
          ctx.log("⚠请先选择或在输入框填写导出文件夹");
          break;
        }
        await new Promise<void>((resolve) => {
          // explorer 即便成功打开也会返回非零退出码，故仅凭 stderr 判断是否真失败
          exec(`explorer "${target}"`, {}, (_err, _stdout, stderr) => {
            if (stderr.trim()) {
              ctx.log(`❌打开文件夹失败：${stderr.trim()}`);
            } else {
              ctx.log(`✅已打开文件夹：${target}`);
            }
            resolve();
          });
        });
        break;
      }
      case "exportExcel": {
        const outDir: string = msg.outDir?.trim() ?? "";
        const statRows: StatRow[] = msg.statRows ?? [];
        const xHeader: string = msg.xHeader ?? "X标签";
        const yHeader: string = msg.yHeader ?? "聚合数值";
        if (!outDir || !fs.existsSync(outDir)) {
          ctx.log("⚠请先选择有效的输出文件夹");
          break;
        }
        if (!statRows.length) {
          ctx.log("⚠没有可导出的统计结果，请先执行分析");
          break;
        }
        try {
          const ts = genTimestamp();
          const outFile = path.join(outDir, `统计分析结果_${ts}.xlsx`);
          await exportStatToExcel(statRows, xHeader, yHeader, outFile);
          ctx.log(`✅统计表格已导出：${outFile}`);
        } catch (err: any) {
          ctx.log(`❌导出Excel异常：${err.message}`);
        }
        break;
      }
      case "saveChart": {
        const outDir: string = msg.outDir?.trim() ?? "";
        const dataUrl: string = msg.dataUrl ?? "";
        if (!outDir || !fs.existsSync(outDir)) {
          ctx.log("⚠请先选择有效的输出文件夹");
          break;
        }
        if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
          ctx.log("⚠没有可保存的图表，请先执行分析");
          break;
        }
        try {
          const buf = Buffer.from(
            dataUrl.replace(/^data:image\/png;base64,/, ""),
            "base64",
          );
          const ts = genTimestamp();
          const outFile = path.join(outDir, `统计分析图表_${ts}.png`);
          await fsp.writeFile(outFile, buf);
          ctx.log(`✅图表已保存：${outFile}`);
        } catch (err: any) {
          ctx.log(`❌保存图表异常：${err.message}`);
        }
        break;
      }
    }
  },
};
