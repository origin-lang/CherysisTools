import { round2 } from "./pricing.js";

export interface ProductFieldSpec {
  key: string;
  label: string;
  /** 文本字段：最大长度 */
  max?: number;
  /** 文本字段：不允许空格 */
  noSpace?: boolean;
  /** 文本字段：必填 */
  required?: boolean;
  /** 数值字段类型 */
  kind?: "money" | "int" | "grade";
  /** 不参与列显示（如 remark，可写但作为隐藏列） */
  hidden?: boolean;
}

// 商品字段规格主表：字段顺序、标签、文本长度/空格/必填、数值类型，一处定义多处使用。
// 与前端 client-core.js 的 FIELD_SPECS 保持一致（结构相同时两条防线同时生效）。
export const PRODUCT_FIELDS: ProductFieldSpec[] = [
  { key: "code", label: "编号" },
  { key: "name", label: "名称", max: 100, noSpace: true, required: true },
  { key: "category", label: "品类", max: 50, noSpace: true },
  { key: "series", label: "系列", max: 50, noSpace: true },
  { key: "grade", label: "等级", kind: "grade" },
  { key: "cost_price", label: "进价", kind: "money" },
  { key: "sale_price", label: "售价", kind: "money" },
  { key: "stockTotal", label: "库存", kind: "int" },
  { key: "soldTotal", label: "累计售出", kind: "int" },
  { key: "netTotal", label: "累计净售", kind: "int" },
  { key: "status", label: "状态" },
  { key: "purchase_link", label: "采购链接", max: 500, noSpace: true },
  { key: "remark", label: "备注", max: 200, hidden: true },
];

// 商品字段的固定显示顺序（与前端 client-core.js PRODUCT_FIELDS 保持一致；隐藏列不参与）
export const PRODUCT_FIELD_ORDER: Array<{ key: string; label: string }> = PRODUCT_FIELDS.filter(
  (f) => !f.hidden,
);

// 可写字段子集（派生列不参与导入/导出写回）
export const IMPORTABLE_FIELD_ORDER: Array<{ key: string; label: string }> = PRODUCT_FIELDS.filter(
  (f) =>
    ["name", "category", "series", "grade", "cost_price", "sale_price", "purchase_link"].includes(
      f.key,
    ),
);

type TextFieldKey = "name" | "category" | "series" | "purchase_link" | "remark";

function specOf(key: string): ProductFieldSpec | undefined {
  return PRODUCT_FIELDS.find((f) => f.key === key);
}

// 字段规整：name 必填无空格；category/series/purchase_link 无空格；文字超长截断；金额 round2；库存整数。
// 与前端 sanitizeProductField（client-core.js）同规则，这里是入库前最后一道拦截。
export function normText(
  field: TextFieldKey,
  raw: unknown,
  opts?: { required?: boolean },
): { ok: boolean; msg: string; value: string; truncated: boolean } {
  const spec = specOf(field);
  const label = spec?.label ?? field;
  let s = String(raw ?? "").trim();
  const required = opts?.required ?? spec?.required ?? false;
  if (required && !s) {
    return { ok: false, msg: `${label}不能为空`, value: s, truncated: false };
  }
  if (spec?.noSpace && /\s/.test(s)) {
    return { ok: false, msg: `${label}不能包含空格`, value: s, truncated: false };
  }
  const truncated = s.length > (spec?.max ?? Number.POSITIVE_INFINITY);
  if (truncated) {
    s = s.slice(0, spec?.max ?? s.length);
  }
  return { ok: true, msg: "", value: s, truncated };
}

export function normMoney(
  field: "cost_price" | "sale_price",
  raw: unknown,
): { ok: boolean; msg: string; value: number } {
  const n = Number(raw ?? 0);
  const label = specOf(field)?.label ?? field;
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, msg: `${label}需为 ≥0 的数字`, value: 0 };
  }
  return { ok: true, msg: "", value: round2(n) };
}

export function normGrade(raw: unknown): { ok: boolean; msg: string; value: number } {
  const n = Number(raw ?? 1);
  if (n === 0) {
    return { ok: true, msg: "", value: 0 };
  }
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    return { ok: false, msg: "等级需为 0（自定义）或 1-99 的整数", value: n };
  }
  return { ok: true, msg: "", value: n };
}

export function normInt(field: string, raw: unknown): { ok: boolean; msg: string; value: number } {
  const n = Number(raw ?? 0);
  const label = specOf(field)?.label ?? field;
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, msg: `${label}需为非负整数`, value: n };
  }
  return { ok: true, msg: "", value: n };
}