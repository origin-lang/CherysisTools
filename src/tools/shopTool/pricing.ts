import { SaleRule } from "./db.js";

export function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function fileStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 编号统一规范：L + 数字 3 位补零，范围 1~9999。L7→L007、L76→L076、L1044 不变 */
export function canonicalCode(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/[【】\[\]（）()#\s_\-\u3000]/g, "");
  let digits: string | null = null;
  let m = s.match(/^[Ll](\d{1,4})$/);
  if (m) {
    digits = m[1];
  } else {
    m = s.match(/^(\d{1,4})$/);
    if (m) {
      digits = m[1];
    }
  }
  if (!digits) {
    return null;
  }
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    return null;
  }
  // 统一 3 位补零：L7→L007、L76→L076、L999→L999、L1044→L1044（最多 4 位）
  return `L${String(n).padStart(3, "0")}`;
}

export function extractCodeToken(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const direct = canonicalCode(s);
  if (direct) {
    return direct;
  }
  const m = s.match(/[Ll](\d{1,4})/);
  if (m) {
    return canonicalCode(`L${m[1]}`);
  }
  return null;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 售价公式求值：只允许 cost 与数字 + - * / ( ) 空格；非法/异常一律返回 null（调用方回退成本价） */
export function applyExpr(cost: number, expr: string): number | null {
  const e = String(expr ?? "").replace(/cost/gi, `(${cost})`);
  if (!/^[0-9+\-*/().\s]+$/.test(e)) {
    return null;
  }
  try {
    const v = new Function(`return (${e});`)() as number;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function calcPrice(cost: number, rule: SaleRule | undefined): number {
  let v = rule ? applyExpr(cost, rule.expr) : null;
  if (v === null) {
    v = cost;
  }
  v = round2(v);
  const mode = rule?.tail_mode ?? "raw";
  const tail = String(rule?.tail_value ?? "").trim();
  switch (mode) {
    case "round":
      return Math.round(v);
    case "p99":
      return Math.floor(v) + 0.99;
    case "p88":
      return Math.floor(v) + 0.88;
    case "custom": {
      if (!tail || !/^\d{1,2}$/.test(tail)) {
        return v;
      }
      const dec = Number(tail) / Math.pow(10, tail.length);
      return round2(Math.floor(v) + dec);
    }
    default:
      return v;
  }
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function normalizeRule(r: any): SaleRule {
  return {
    grade: Number(r.grade),
    label: String(r.label ?? ("等级" + r.grade)),
    expr: String(r.expr ?? "cost"),
    tail_mode: String(r.tail_mode ?? "raw"),
    tail_value: String(r.tail_value ?? ""),
  };
}