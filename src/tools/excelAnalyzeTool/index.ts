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

/** 多 Y 列统计行：data[i] 与 yCols[i] 一一对应 */
export interface MultiStatRow {
  xName: string;
  data: number[];
}

/** 数值列读取：空串/非数字返回 null（不参与 sum/mean） */
export function numOrNull(v: unknown): number | null {
  if (isNullish(v) || v === "") {
    return null;
  }
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** 核心统计（多 Y 列）：多分组规则(带优先级)清洗 + 逐列聚合 + 匹配结果处理策略
 *  计数与 Y 列无关，data 各列都是行数；sum/mean 按列 dropna（一行多列全缺才跳过该行） */
export function analyzeRowsMulti(
  rows: Record<string, any>[],
  xCol: string,
  yCols: string[],
  rules: GroupRule[],
  aggType: AggType,
  invalidMode: InvalidMode,
): MultiStatRow[] {
  // 仅保留非空正则的规则，并预编译，保持优先级顺序（前在前）
  const effectiveRules = rules
    .filter((rg) => rg.regex.trim() !== "")
    .map((rg) => ({ name: rg.name, re: new RegExp(rg.regex) }));
  const needNum = aggType !== "count";
  const nCols = yCols.length;

  interface Bucket {
    count: number;
    sums: number[];
    counts: number[];
  }
  const buckets = new Map<string, Bucket>();

  for (const r of rows) {
    const xVal = r[xCol];
    const s = isNullish(xVal) ? null : String(xVal);

    // 无规则 / 多规则按优先级取第一条命中
    let ok = true;
    let key: string | null;
    if (effectiveRules.length === 0) {
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
      key = matched ? extracted : s;
    }

    // Y 值：sum/mean 按列取值；一行所有列都缺则整行跳过（与单列 dropna 语义一致）
    const vals: (number | null)[] = [];
    if (needNum) {
      for (let c = 0; c < nCols; c++) {
        vals.push(numOrNull(r[yCols[c]]));
      }
      if (vals.every((v) => v === null)) {
        continue;
      }
    }

    if (invalidMode === "success_only" && !ok) {
      continue;
    }
    if (invalidMode === "fail_only" && ok) {
      continue;
    }
    let k: string;
    if (invalidMode === "merge_other" && !ok) {
      k = "其他";
    } else if (key === null || key === undefined) {
      k = "";
    } else {
      k = key;
    }

    let b = buckets.get(k);
    if (!b) {
      b = { count: 0, sums: new Array(nCols).fill(0), counts: new Array(nCols).fill(0) };
      buckets.set(k, b);
    }
    b.count++;
    if (needNum) {
      for (let c = 0; c < nCols; c++) {
        const v = vals[c];
        if (v !== null) {
          b.sums[c] += v;
          b.counts[c]++;
        }
      }
    }
  }

  const results: MultiStatRow[] = [];
  for (const [k, b] of buckets.entries()) {
    results.push({
      xName: k,
      data:
        aggType === "count"
          ? new Array(nCols).fill(b.count)
          : b.sums.map((s, c) => (aggType === "mean" ? s / (b.counts[c] || 1) : s)),
    });
  }
  // 保持单列时代习惯：按第一列聚合值降序
  results.sort((a, b) => (b.data[0] || 0) - (a.data[0] || 0));
  return results;
}

/** 单 Y 列版本（内部委托多列实现），保留导出签名便于单测/兼容 */
export function analyzeRows(
  rows: Record<string, any>[],
  xCol: string,
  yCol: string,
  rules: GroupRule[],
  aggType: AggType,
  invalidMode: InvalidMode,
): StatRow[] {
  return analyzeRowsMulti(rows, xCol, [yCol], rules, aggType, invalidMode).map((m) => ({
    xName: m.xName,
    value: m.data[0],
  }));
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

/** 导出统计表格为 Excel（多 Y 列：序号 + X + 每个 Y 列各一列） */
async function exportStatToExcel(statRows: MultiStatRow[], xHeader: string, yHeaders: string[], outFile: string) {
  const aoa: (string | number)[][] = [["序号", xHeader, ...yHeaders]];
  statRows.forEach((r, i) => {
    aoa.push([i + 1, r.xName, ...r.data.map((v) => Math.round(v * 100) / 100)]);
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

/** 在资源管理器中打开目标文件夹（explorer 即便成功也返回非零码，故仅凭 stderr 判断失败） */
function openFolderInExplorer(target: string, log: (text: string) => void): Promise<void> {
  return new Promise((resolve) => {
    exec(`explorer "${target}"`, {}, (_err, _stdout, stderr) => {
      if (stderr.trim()) {
        log(`❌打开文件夹失败：${stderr.trim()}`);
      } else {
        log(`✅已打开文件夹：${target}`);
      }
      resolve();
    });
  });
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
        // 多 Y 列：优先取 msg.yCols 数组，兼容旧的单列 msg.yCol
        const yCols: string[] = Array.isArray(msg.yCols)
          ? msg.yCols.filter((c: any) => typeof c === "string" && c.trim() !== "")
          : [];
        if (yCols.length === 0 && typeof msg.yCol === "string" && msg.yCol.trim() !== "") {
          yCols.push(msg.yCol.trim());
        }
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
        // 计数与 Y 列无关，不需要选列；其余聚合方式必须勾选至少一个 Y 列
        if (aggType !== "count" && yCols.length === 0) {
          ctx.log("⚠请至少勾选一个【Y轴数值列】");
          break;
        }
        try {
          const effYCols = aggType === "count" ? ["计数"] : yCols;
          const aggLabel = aggType === "sum" ? "求和" : aggType === "mean" ? "平均值" : "计数";
          const yHeaders = effYCols.map((y) => (aggType === "count" ? "计数" : `${y}·${aggLabel}`));
          const statRows = analyzeRowsMulti(
            loadedFile.rows,
            xCol,
            effYCols,
            rules,
            aggType,
            invalidMode,
          );
          ctx.postToWebview({
            type: "analysisResult",
            statRows,
            xHeader: xCol,
            yHeaders,
            yCols: effYCols,
            chartType,
            rowCount: loadedFile.rows.length,
          });
        } catch (err: any) {
          ctx.log(`❌分析异常：${err.message}`);
        }
        break;
      }
      case "exportExcel": {
        const statRows: MultiStatRow[] = msg.statRows ?? [];
        const xHeader: string = msg.xHeader ?? "X标签";
        const yHeaders: string[] = Array.isArray(msg.yHeaders) && msg.yHeaders.length
          ? msg.yHeaders
          : ["聚合数值"];
        if (!statRows.length) {
          ctx.log("⚠没有可导出的统计结果，请先执行分析");
          break;
        }
        const dir = await ctx.selectFolder();
        if (!dir) {
          ctx.log("❌已取消导出（未选择文件夹）");
          break;
        }
        try {
          const ts = genTimestamp();
          const outFile = path.join(dir, `统计分析结果_${ts}.xlsx`);
          await exportStatToExcel(statRows, xHeader, yHeaders, outFile);
          ctx.log(`✅统计表格已导出：${outFile}`);
          await openFolderInExplorer(dir, (t) => ctx.log(t));
        } catch (err: any) {
          ctx.log(`❌导出Excel异常：${err.message}`);
        }
        break;
      }
      case "saveChart": {
        const dataUrl: string = msg.dataUrl ?? "";
        if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
          ctx.log("⚠没有可保存的图表，请先执行分析");
          break;
        }
        const dir = await ctx.selectFolder();
        if (!dir) {
          ctx.log("❌已取消导出（未选择文件夹）");
          break;
        }
        try {
          const buf = Buffer.from(
            dataUrl.replace(/^data:image\/png;base64,/, ""),
            "base64",
          );
          const ts = genTimestamp();
          const outFile = path.join(dir, `统计分析图表_${ts}.png`);
          await fsp.writeFile(outFile, buf);
          ctx.log(`✅图表已保存：${outFile}`);
          await openFolderInExplorer(dir, (t) => ctx.log(t));
        } catch (err: any) {
          ctx.log(`❌保存图表异常：${err.message}`);
        }
        break;
      }
    }
  },
};
