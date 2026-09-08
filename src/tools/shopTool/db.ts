import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";

export interface Product {
  id: number;
  code: string;
  name: string;
  category: string;
  series: string;
  grade: number;
  cost_price: number;
  sale_price: number;
  price_manual: number;
  purchase_link: string;
  status: number;
  remark: string;
  created_at: string;
}

export interface SaleRule {
  grade: number;
  label: string;
  expr: string;
  tail_mode: string;
  tail_value: string;
}

export interface StockIn {
  id: number;
  product_id: number;
  qty: number;
  date: string;
  remark: string;
}

export interface SalesRecord {
  id: number;
  product_id: number;
  date: string;
  sold_qty: number;
  refund_qty: number;
  cost_price: number;
  note: string;
  code?: string;
  name?: string;
}

export interface MonthlySettle {
  month: string;
  income_amount: number;
  extra_expense: number;
  goods_cost: number;
  sold_total: number;
  refund_total: number;
  profit: number;
  locked: number;
  created_at: string;
  updated_at: string;
}

export interface SettleSnapshot {
  sold_total: number;
  refund_total: number;
  goods_cost: number;
}

export interface LivePlanRow {
  group_no: number;
  slot_no: number;
  code: string;
}

export interface StockGroupRow {
  product_id: number;
  qty: number;
}

export interface SaleGroupRow {
  product_id: number;
  sold: number;
  refund: number;
}

export interface StockInRow {
  id: number;
  product_id: number;
  qty: number;
  date: string;
  remark: string;
  code?: string;
  name?: string;
}

export const DEFAULT_SEED_RULES: SaleRule[] = [
  { grade: 1, label: "一级", expr: "cost+10", tail_mode: "raw", tail_value: "" },
  { grade: 2, label: "二级", expr: "cost*1.5", tail_mode: "p88", tail_value: "" },
  { grade: 3, label: "三级", expr: "cost*2", tail_mode: "p88", tail_value: "" },
];

export interface ShopDB {
  getProducts(): Product[];
  getProductByCode(code: string): Product | undefined;
  getProductById(id: number): Product | undefined;
  addProduct(p: Omit<Product, "id" | "created_at">): number;
  updateProductField(id: number, field: string, value: any): void;
  deleteProduct(id: number): void;
  getRules(): SaleRule[];
  replaceRules(rules: SaleRule[]): void;
  ensureRule(grade: number): boolean;
  addStockIn(s: Omit<StockIn, "id">): number;
  deleteStockIn(id: number): void;
  getStockIns(): StockInRow[];
  getStockGroups(): StockGroupRow[];
  getSaleGroups(): SaleGroupRow[];
  getStockTotals(): Map<number, number>;
  getSaleTotals(): Map<number, { sold: number; refund: number }>;
  getSales(date?: string): SalesRecord[];
  getSalesRange(from: string, to: string): SalesRecord[];
  upsertSale(r: {
    product_id: number;
    date: string;
    sold_qty: number;
    refund_qty: number;
    cost_price: number;
    note: string;
    mode: "overwrite" | "accumulate" | "skip";
  }): "created" | "updated" | "skipped";
  deleteSales(ids: number[]): void;
  salesTrend(by: "month" | "day", month?: string, productId?: number): Array<{ period: string; sold: number; refund: number }>;
  getSettleMonths(): MonthlySettle[];
  getSettle(month: string): MonthlySettle | undefined;
  snapshotMonth(month: string): SettleSnapshot;
  saveSettle(m: Omit<MonthlySettle, "created_at" | "updated_at">): void;
  deleteSettle(month: string): void;
  setLock(month: string, locked: number): void;
  getSetting(key: string): string;
  setSetting(key: string, value: string): void;
  getLiveStars(): string[];
  replaceLiveStars(codes: string[]): void;
  getLivePlan(): LivePlanRow[];
  replaceLivePlan(plan: LivePlanRow[]): void;
  getDBFilePath(): string;
  backupDB(destPath: string): Promise<void>;
  restoreDB(srcPath: string, storageDir: string): void;
  close(): void;
}

let db: Database.Database | null = null;
let dbPath: string | null = null;

// 库存合计 / 销量合计聚合缓存：首次懒加载全量 GROUP BY，之后在各写入路径增量维护，
// 避免每次「改一个字段」都全表聚合。
interface AggTotals {
  loaded: boolean;
  stock: Map<number, number>;
  sale: Map<number, { sold: number; refund: number }>;
}
let aggCache: AggTotals = { loaded: false, stock: new Map(), sale: new Map() };

function resetAggCache(): void {
  aggCache = { loaded: false, stock: new Map(), sale: new Map() };
}

export function closeDB(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    db = null;
    dbPath = null;
  }
  resetAggCache();
}

export function getDBPath(): string {
  if (!dbPath) {
    throw new Error("数据库尚未初始化");
  }
  return dbPath;
}

export function initDB(storageDir: string): boolean {
  if (db) {
    return false;
  }
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  const p = path.join(storageDir, "shop.db");
  const isNew = !fs.existsSync(p);
  db = new Database(p);
  dbPath = p;
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      series TEXT NOT NULL DEFAULT '',
      grade INTEGER NOT NULL DEFAULT 1,
      cost_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      price_manual INTEGER NOT NULL DEFAULT 0,
      purchase_link TEXT NOT NULL DEFAULT '',
      status INTEGER NOT NULL DEFAULT 0,
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS sale_rules (
      grade INTEGER PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      expr TEXT NOT NULL DEFAULT 'cost*1.5',
      tail_mode TEXT NOT NULL DEFAULT 'raw',
      tail_value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_in (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      date TEXT NOT NULL,
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_stock_in_product ON stock_in(product_id);
    CREATE TABLE IF NOT EXISTS sales_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      sold_qty INTEGER NOT NULL DEFAULT 0,
      refund_qty INTEGER NOT NULL DEFAULT 0,
      cost_price REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_date_product ON sales_record(date, product_id);
    CREATE INDEX IF NOT EXISTS idx_sales_product ON sales_record(product_id);
    CREATE TABLE IF NOT EXISTS monthly_settle (
      month TEXT PRIMARY KEY,
      income_amount REAL NOT NULL DEFAULT 0,
      extra_expense REAL NOT NULL DEFAULT 0,
      goods_cost REAL NOT NULL DEFAULT 0,
      sold_total INTEGER NOT NULL DEFAULT 0,
      refund_total INTEGER NOT NULL DEFAULT 0,
      profit REAL NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS live_star (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS live_plan (
      group_no INTEGER NOT NULL,
      slot_no INTEGER NOT NULL,
      code TEXT NOT NULL,
      PRIMARY KEY (group_no, slot_no)
    );
  `);
  if (isNew) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO sale_rules (grade, label, expr, tail_mode, tail_value) VALUES (@grade, @label, @expr, @tail_mode, @tail_value)",
    );
    for (const r of DEFAULT_SEED_RULES) {
      ins.run(r);
    }
    const setIns = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    setIns.run("image_dir", "");
    setIns.run("name_template", "{name}{series}{grade}{code}");
    setIns.run("stock_alert", "0");
    setIns.run("col_visible", "");
  }
  return true;
}

function core(): Database.Database {
  if (!db) {
    throw new Error("数据库尚未初始化");
  }
  return db;
}

function nowStr(): string {
  return new Date().toISOString();
}

function isValidSqliteFile(fp: string): boolean {
  try {
    const fd = fs.openSync(fp, "r");
    const buf = Buffer.alloc(16);
    try {
      fs.readSync(fd, buf, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buf.slice(0, 16).equals(Buffer.from("SQLite format 3\0"));
  } catch {
    return false;
  }
}

function mapProduct(r: any): Product {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    series: r.series,
    grade: r.grade,
    cost_price: r.cost_price,
    sale_price: r.sale_price,
    price_manual: r.price_manual,
    purchase_link: r.purchase_link,
    status: r.status,
    remark: r.remark,
    created_at: r.created_at,
  };
}

function mapSales(r: any): SalesRecord {
  return {
    id: r.id,
    product_id: r.product_id,
    date: r.date,
    sold_qty: r.sold_qty,
    refund_qty: r.refund_qty,
    cost_price: r.cost_price,
    note: r.note,
    code: r.code,
    name: r.name,
  };
}

export function getDB(): ShopDB {
  const c = core();
  const cachedProducts = new Map<number, Product>();
  const loadProducts = (): Product[] => {
    const rows = c.prepare("SELECT * FROM products ORDER BY code").all() as any[];
    const list = rows.map(mapProduct);
    cachedProducts.clear();
    for (const p of list) {
      cachedProducts.set(p.id, p);
    }
    return list;
  };
  const pInsert = c.prepare(`
    INSERT INTO products (code, name, category, series, grade, cost_price, sale_price, price_manual, purchase_link, status, remark, created_at)
    VALUES (@code, @name, @category, @series, @grade, @cost_price, @sale_price, @price_manual, @purchase_link, @status, @remark, @created_at)
  `);
  const pDelete = c.prepare("DELETE FROM products WHERE id = ?");
  const sByCode = c.prepare("SELECT * FROM products WHERE code = ?");
  const sById = c.prepare("SELECT * FROM products WHERE id = ?");
  const stockInInsert = c.prepare(`
    INSERT INTO stock_in (product_id, qty, date, remark, created_at)
    VALUES (@product_id, @qty, @date, @remark, @created_at)
  `);
  const stockInDelete = c.prepare("DELETE FROM stock_in WHERE id = ?");
  const stockInGet = c.prepare("SELECT * FROM stock_in WHERE id = ?");
  const productSalesDel = c.prepare("DELETE FROM sales_record WHERE product_id = ?");
  const productStockDel = c.prepare("DELETE FROM stock_in WHERE product_id = ?");
  const saleById = c.prepare("SELECT * FROM sales_record WHERE id = ?");
  const stockInsList = c.prepare(`
    SELECT s.*, p.code, p.name FROM stock_in s
    JOIN products p ON p.id = s.product_id
    ORDER BY s.date DESC, s.id DESC
  `);
  const stockGroupStmt = c.prepare(`
    SELECT product_id, SUM(qty) AS qty FROM stock_in GROUP BY product_id
  `);
  const saleGroupStmt = c.prepare(`
    SELECT product_id, SUM(sold_qty) AS sold, SUM(refund_qty) AS refund FROM sales_record GROUP BY product_id
  `);
  const pFieldStmts = new Map<string, Database.Statement>();
  for (const f of [
    "code",
    "name",
    "category",
    "series",
    "grade",
    "cost_price",
    "sale_price",
    "price_manual",
    "purchase_link",
    "status",
    "remark",
  ]) {
    pFieldStmts.set(f, c.prepare(`UPDATE products SET ${f} = @value WHERE id = @id`));
  }
  const ensureAggLoaded = () => {
    if (aggCache.loaded) {
      return;
    }
    const stock = new Map<number, number>();
    for (const r of stockGroupStmt.all() as any[]) {
      stock.set(Number(r.product_id), Number(r.qty || 0));
    }
    const sale = new Map<number, { sold: number; refund: number }>();
    for (const r of saleGroupStmt.all() as any[]) {
      sale.set(Number(r.product_id), {
        sold: Number(r.sold || 0),
        refund: Number(r.refund || 0),
      });
    }
    aggCache = { loaded: true, stock, sale };
  };
  const salesInsert = c.prepare(`
    INSERT INTO sales_record (product_id, date, sold_qty, refund_qty, cost_price, note)
    VALUES (@product_id, @date, @sold_qty, @refund_qty, @cost_price, @note)
  `);
  const salesByDateProduct = c.prepare("SELECT * FROM sales_record WHERE date = ? AND product_id = ?");
  const salesUpdate = c.prepare(`
    UPDATE sales_record SET sold_qty = @sold_qty, refund_qty = @refund_qty, cost_price = @cost_price, note = @note
    WHERE date = @date AND product_id = @product_id
  `);
  const salesDateAll = c.prepare(`
    SELECT s.*, p.code, p.name FROM sales_record s
    JOIN products p ON p.id = s.product_id
    WHERE s.date = ? ORDER BY p.code
  `);
  const salesAll = c.prepare(`
    SELECT s.*, p.code, p.name FROM sales_record s
    JOIN products p ON p.id = s.product_id
    ORDER BY s.date DESC, p.code
  `);
  const salesRange = c.prepare(`
    SELECT s.*, p.code, p.name FROM sales_record s
    JOIN products p ON p.id = s.product_id
    WHERE s.date >= ? AND s.date <= ?
    ORDER BY s.date, p.code
  `);
  const salesDel = c.prepare("DELETE FROM sales_record WHERE id = ?");
  const trendMonth = c.prepare(`
    SELECT substr(date, 1, 7) AS period, SUM(sold_qty) AS sold, SUM(refund_qty) AS refund
    FROM sales_record WHERE (? IS NULL OR product_id = ?)
    GROUP BY period ORDER BY period
  `);
  const trendDay = c.prepare(`
    SELECT date AS period, SUM(sold_qty) AS sold, SUM(refund_qty) AS refund
    FROM sales_record WHERE date LIKE ? AND (? IS NULL OR product_id = ?)
    GROUP BY date ORDER BY date
  `);
  const rulesList = c.prepare("SELECT * FROM sale_rules ORDER BY grade");
  const rulesDelete = c.prepare("DELETE FROM sale_rules");
  const rulesInsert = c.prepare(`
    INSERT OR REPLACE INTO sale_rules (grade, label, expr, tail_mode, tail_value)
    VALUES (@grade, @label, @expr, @tail_mode, @tail_value)
  `);
  const monthList = c.prepare("SELECT * FROM monthly_settle ORDER BY month");
  const monthGet = c.prepare("SELECT * FROM monthly_settle WHERE month = ?");
  const monthInsert = c.prepare(`
    INSERT INTO monthly_settle (month, income_amount, extra_expense, goods_cost, sold_total, refund_total, profit, locked, created_at, updated_at)
    VALUES (@month, @income_amount, @extra_expense, @goods_cost, @sold_total, @refund_total, @profit, @locked, @created_at, @updated_at)
  `);
  const monthUpdate = c.prepare(`
    UPDATE monthly_settle SET income_amount = @income_amount, extra_expense = @extra_expense,
      goods_cost = @goods_cost, sold_total = @sold_total, refund_total = @refund_total,
      profit = @profit, locked = @locked, updated_at = @updated_at WHERE month = @month
  `);
  const monthDelete = c.prepare("DELETE FROM monthly_settle WHERE month = ?");
  const monthLock = c.prepare("UPDATE monthly_settle SET locked = ?, updated_at = ? WHERE month = ?");
  const settingGet = c.prepare("SELECT value FROM settings WHERE key = ?");
  const settingSet = c.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const liveStarsList = c.prepare("SELECT code FROM live_star ORDER BY code");
  const liveStarsDel = c.prepare("DELETE FROM live_star");
  const liveStarsIns = c.prepare("INSERT OR IGNORE INTO live_star (code, created_at) VALUES (@code, @created_at)");
  const liveStarsByCode = c.prepare("SELECT code FROM live_star WHERE code = ?");
  const liveStarsOneDel = c.prepare("DELETE FROM live_star WHERE code = ?");
  const livePlanList = c.prepare("SELECT group_no, slot_no, code FROM live_plan ORDER BY group_no, slot_no");
  const livePlanDel = c.prepare("DELETE FROM live_plan");
  const livePlanIns = c.prepare("INSERT OR REPLACE INTO live_plan (group_no, slot_no, code) VALUES (@group_no, @slot_no, @code)");
  const liveStarDelByCode = c.prepare("DELETE FROM live_star WHERE code = ?");
  const livePlanDelByCode = c.prepare("DELETE FROM live_plan WHERE code = ?");
  const monthSnapshotSales = c.prepare(`
    SELECT SUM(sold_qty) AS sold, SUM(refund_qty) AS refund, SUM((sold_qty - refund_qty) * cost_price) AS cost
    FROM sales_record WHERE date LIKE ?
  `);

  return {
    getProducts: loadProducts,
    getProductByCode(code: string): Product | undefined {
      const r = sByCode.get(code) as any;
      return r ? mapProduct(r) : undefined;
    },
    getProductById(id: number): Product | undefined {
      const r = sById.get(id) as any;
      return r ? mapProduct(r) : undefined;
    },
    addProduct(p: Omit<Product, "id" | "created_at">): number {
      const info = pInsert.run({ ...p, created_at: nowStr() });
      return Number(info.lastInsertRowid);
    },
    updateProductField(id, field, value) {
      const stmt = pFieldStmts.get(field);
      if (!stmt) {
        throw new Error(`不允许的字段: ${field}`);
      }
      stmt.run({ value, id });
    },
    deleteProduct(id) {
      const p = sById.get(id) as any;
      const code = p ? String(p.code) : "";
      const tx = c.transaction(() => {
        productSalesDel.run(id);
        productStockDel.run(id);
        pDelete.run(id);
        if (code) {
          liveStarDelByCode.run(code);
          livePlanDelByCode.run(code);
        }
      });
      tx();
      if (aggCache.loaded) {
        aggCache.stock.delete(id);
        aggCache.sale.delete(id);
      }
    },
    getRules(): SaleRule[] {
      return (rulesList.all() as any[]).map((r) => ({
        grade: r.grade,
        label: r.label,
        expr: r.expr,
        tail_mode: r.tail_mode,
        tail_value: r.tail_value,
      }));
    },
    replaceRules(rules) {
      const tx = c.transaction(() => {
        rulesDelete.run();
        for (const r of rules) {
          rulesInsert.run(r);
        }
      });
      tx();
    },
    ensureRule(grade) {
      const g = Math.floor(Number(grade));
      if (!Number.isFinite(g) || g < 1 || g > 99) {
        return false;
      }
      const exists = (rulesList.all() as any[]).some((r) => Number(r.grade) === g);
      if (exists) {
        return false;
      }
      rulesInsert.run({
        grade: g,
        label: "等级" + g,
        expr: "cost*1.5",
        tail_mode: "p88",
        tail_value: "",
      });
      return true;
    },
    addStockIn(s) {
      const info = stockInInsert.run({ ...s, created_at: nowStr() });
      if (aggCache.loaded) {
        aggCache.stock.set(
          s.product_id,
          (aggCache.stock.get(s.product_id) || 0) + s.qty,
        );
      }
      return Number(info.lastInsertRowid);
    },
    deleteStockIn(id) {
      const r = stockInGet.get(id) as any;
      stockInDelete.run(id);
      if (r && aggCache.loaded) {
        const key = Number(r.product_id);
        const next = (aggCache.stock.get(key) || 0) - Number(r.qty || 0);
        if (next <= 0) {
          aggCache.stock.delete(key);
        } else {
          aggCache.stock.set(key, next);
        }
      }
    },
    getStockIns(): StockInRow[] {
      return (stockInsList.all() as any[]).map((r) => ({
        id: r.id,
        product_id: r.product_id,
        qty: r.qty,
        date: r.date,
        remark: r.remark,
        code: r.code,
        name: r.name,
      }));
    },
    getStockGroups(): StockGroupRow[] {
      return (stockGroupStmt.all() as any[]).map((r) => ({
        product_id: r.product_id,
        qty: Number(r.qty || 0),
      }));
    },
    getSaleGroups(): SaleGroupRow[] {
      return (saleGroupStmt.all() as any[]).map((r) => ({
        product_id: r.product_id,
        sold: Number(r.sold || 0),
        refund: Number(r.refund || 0),
      }));
    },
    getStockTotals(): Map<number, number> {
      ensureAggLoaded();
      return new Map(aggCache.stock);
    },
    getSaleTotals(): Map<number, { sold: number; refund: number }> {
      ensureAggLoaded();
      return new Map(aggCache.sale);
    },
    getSales(date?: string): SalesRecord[] {
      const rows = (date ? salesDateAll.all(date) : salesAll.all()) as any[];
      return rows.map(mapSales);
    },
    getSalesRange(from: string, to: string): SalesRecord[] {
      return (salesRange.all(from, to) as any[]).map(mapSales);
    },
    upsertSale(r): "created" | "updated" | "skipped" {
      const existing = salesByDateProduct.get(r.date, r.product_id) as any;
      if (existing) {
        if (r.mode === "skip") {
          return "skipped";
        }
        const deltaSold = r.sold_qty - existing.sold_qty;
        const deltaRefund = r.refund_qty - existing.refund_qty;
        if (r.mode === "accumulate") {
          salesUpdate.run({
            sold_qty: existing.sold_qty + r.sold_qty,
            refund_qty: existing.refund_qty + r.refund_qty,
            cost_price: r.cost_price,
            note: r.note,
            date: r.date,
            product_id: r.product_id,
          });
        } else {
          salesUpdate.run({
            sold_qty: r.sold_qty,
            refund_qty: r.refund_qty,
            cost_price: r.cost_price,
            note: r.note,
            date: r.date,
            product_id: r.product_id,
          });
        }
        if (aggCache.loaded) {
          const t = aggCache.sale.get(r.product_id) || { sold: 0, refund: 0 };
          t.sold += deltaSold;
          t.refund += deltaRefund;
          aggCache.sale.set(r.product_id, t);
        }
        return "updated";
      }
      salesInsert.run(r);
      if (aggCache.loaded) {
        const t = aggCache.sale.get(r.product_id) || { sold: 0, refund: 0 };
        t.sold += r.sold_qty;
        t.refund += r.refund_qty;
        aggCache.sale.set(r.product_id, t);
      }
      return "created";
    },
    deleteSales(ids) {
      const tx = c.transaction(() => {
        for (const id of ids) {
          const r = saleById.get(id) as any;
          salesDel.run(id);
          if (r && aggCache.loaded) {
            const key = Number(r.product_id);
            const t = aggCache.sale.get(key) || { sold: 0, refund: 0 };
            t.sold -= Number(r.sold_qty || 0);
            t.refund -= Number(r.refund_qty || 0);
            if (t.sold <= 0 && t.refund <= 0) {
              aggCache.sale.delete(key);
            } else {
              aggCache.sale.set(key, t);
            }
          }
        }
      });
      tx();
    },
    salesTrend(by, month, productId): Array<{ period: string; sold: number; refund: number }> {
      const pid = productId ?? null;
      const rows =
        by === "day"
          ? (trendDay.all(`${month}%`, pid, pid) as any[])
          : (trendMonth.all(pid, pid) as any[]);
      return rows.map((r) => ({
        period: r.period,
        sold: Number(r.sold || 0),
        refund: Number(r.refund || 0),
      }));
    },
    getSettleMonths(): MonthlySettle[] {
      return (monthList.all() as any[]).map((r) => ({ ...r }));
    },
    getSettle(month): MonthlySettle | undefined {
      const r = monthGet.get(month) as any;
      return r ? { ...r } : undefined;
    },
    snapshotMonth(month): SettleSnapshot {
      const r = monthSnapshotSales.get(`${month}%`) as any;
      return {
        sold_total: Number(r?.sold || 0),
        refund_total: Number(r?.refund || 0),
        goods_cost: Number(r?.cost || 0),
      };
    },
    saveSettle(m) {
      const existing = monthGet.get(m.month) as any;
      const row = {
        ...m,
        updated_at: nowStr(),
        created_at: existing ? existing.created_at : nowStr(),
      };
      if (existing) {
        monthUpdate.run(row);
      } else {
        monthInsert.run(row);
      }
    },
    deleteSettle(month) {
      monthDelete.run(month);
    },
    setLock(month, locked) {
      monthLock.run(locked, nowStr(), month);
    },
    getSetting(key): string {
      const r = settingGet.get(key) as any;
      return r ? String(r.value) : "";
    },
    setSetting(key, value) {
      settingSet.run(key, value);
    },
    getLiveStars(): string[] {
      return (liveStarsList.all() as any[]).map((r) => String(r.code));
    },
    replaceLiveStars(codes) {
      const tx = c.transaction(() => {
        liveStarsDel.run();
        for (const code of codes) {
          if (code) {
            liveStarsIns.run({ code, created_at: nowStr() });
          }
        }
      });
      tx();
    },
    getLivePlan(): LivePlanRow[] {
      return (livePlanList.all() as any[]).map((r) => ({
        group_no: Number(r.group_no),
        slot_no: Number(r.slot_no),
        code: String(r.code),
      }));
    },
    replaceLivePlan(plan) {
      const tx = c.transaction(() => {
        livePlanDel.run();
        for (const r of plan) {
          const g = Number(r.group_no);
          const s = Number(r.slot_no);
          if (!Number.isInteger(g) || g < 1 || !Number.isInteger(s) || s < 0 || s > 9) {
            continue;
          }
          const code = String(r.code ?? "").trim();
          if (s === 0) {
            livePlanIns.run({ group_no: g, slot_no: s, code: "" });
            continue;
          }
          if (!code) {
            continue;
          }
          livePlanIns.run({ group_no: g, slot_no: s, code });
        }
      });
      tx();
    },
    getDBFilePath(): string {
      return getDBPath();
    },
    async backupDB(destPath: string): Promise<void> {
      const c = core();
      const dir = path.dirname(destPath);
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await c.backup(destPath);
    },
    restoreDB(srcPath: string, storageDir: string): void {
      const target = getDBPath();
      const src = path.resolve(srcPath);
      if (target.toLowerCase() === src.toLowerCase()) {
        throw new Error("目标文件就是当前数据库，不能自我恢复（请换一份备份文件）");
      }
      const tmp = path.join(path.dirname(target), `shop.db.restore.${Date.now()}.tmp`);
      try {
        fs.copyFileSync(src, tmp);
        if (!isValidSqliteFile(tmp)) {
          throw new Error("所选文件不是有效的 SQLite 数据库文件");
        }
        // 用只读连接确认是本工具的库（含 products 表），避免把别人的库換进来
        let probe: Database.Database | null = null;
        try {
          probe = new Database(tmp, { readonly: true });
          const row = probe.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='products'",
          ).get();
          if (!row) {
            throw new Error("所选备份不是本工具的数据库（缺少 products 表）");
          }
        } finally {
          if (probe) {
            try {
              probe.close();
            } catch {
              /* 忽略 */
            }
          }
        }
        // 关闭当前连接，清掉旧 WAL/SHM，再原子替换，避免旧 WAL 回放到新库上
        closeDB();
        for (const f of [target + "-wal", target + "-shm"]) {
          try {
            if (fs.existsSync(f)) {
              fs.rmSync(f, { force: true });
            }
          } catch {
            /* 忽略 */
          }
        }
        fs.renameSync(tmp, target);
        const ok = initDB(storageDir);
        if (!ok) {
          db = null;
          throw new Error("数据库文件已替换，但重新打开连接失败");
        }
      } catch (err) {
        if (fs.existsSync(tmp)) {
          try {
            fs.rmSync(tmp, { force: true });
          } catch {
            /* 忽略 */
          }
        }
        if (!db) {
          try {
            initDB(storageDir);
          } catch {
            /* 忽略 */
          }
        }
        throw err;
      }
    },
    close() {
      closeDB();
    },
  };
}