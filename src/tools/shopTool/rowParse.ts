import { extractCodeToken } from "./pricing.js";

// 导入/粘贴时的表头关键词：首列命中即视为表头行整行跳过（pasteSales 与 importProducts 共用）
const HEADER_FIRST_COLUMN_RE = /^(编号|名称|商品|code|id|品类|类别|分类|系列|等级|成本|进价|售价|数量|库存|状态|采购|备注)/i;

/** 按 逗号/分号/空白 拆分一行为单元格（连续分隔符视为一个、空白单元格剔除） */
export function splitCells(raw: string): string[] {
  return raw
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 首列是否像表头：命中则整行跳过 */
export function isHeaderRow(parts: string[]): boolean {
  return parts.length > 0 && HEADER_FIRST_COLUMN_RE.test(parts[0]);
}

/** 从首列单元格提取商品编号：整格匹配优先（L007 / 76），其次格内 Lxxx 片段 */
export function codeFromCell(cell: string): string | null {
  return extractCodeToken(cell);
}