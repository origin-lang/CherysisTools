import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";

/** 合作关系类型 */
export const RELATIONSHIPS = ["待评估", "进行中", "已终止"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** 订单状态 */
export const ORDER_STATUSES = [
  "已下单",
  "已签收",
  "待退款",
  "待退货",
  "已结束",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 供应商档案 */
export interface Supplier {
  id: number;
  name: string;
  free_shipping: number; // 0 否 / 1 是
  relationship: string;
  quality_desc: string;
}

/** 采购订单 */
export interface Order {
  id: number;
  order_no: string;
  supplier_id: number;
  supplier_name?: string; // 关联查询时填充
  pay_amount: number | null;
  receive_time: string | null;
  deadline: string | null;
  paid_amount: number | null;
  status: string;
}

/** 数据层接口：将来迁移到云(如Supabase)时，实现同一接口即可替换 */
export interface ProcurementDB {
  getSuppliers(): Supplier[];
  addSupplier(s: Omit<Supplier, "id">): number;
  updateSupplier(s: Supplier): void;
  deleteSupplier(id: number): void;
  getOrders(): Order[];
  addOrder(o: Omit<Order, "id">): number;
  updateOrder(o: Order): void;
  deleteOrder(id: number): void;
  /** 整库快照还原：清空两表后按原 id 回插（撤销用），原子执行 */
  restoreAll(suppliers: Supplier[], orders: Order[]): void;
}

let db: Database.Database | null = null;
let dbPath: string | null = null;

/** 关闭并释放当前数据库连接 */
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
}

/** 当前数据库文件路径 */
export function getDBPath(): string {
  if (!dbPath) {
    throw new Error("数据库尚未初始化");
  }
  return dbPath;
}

/** 初始化数据库，返回是否首次创建 */
export function initDB(storageDir: string): boolean {
  if (db) {return false;}
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  const p = path.join(storageDir, "procurement.db");
  const isNew = !fs.existsSync(p);
  db = new Database(p);
  dbPath = p;
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      free_shipping INTEGER NOT NULL DEFAULT 0,
      relationship TEXT NOT NULL DEFAULT '待评估',
      quality_desc TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL,
      supplier_id INTEGER NOT NULL,
      pay_amount REAL,
      receive_time TEXT,
      deadline TEXT,
      paid_amount REAL,
      status TEXT NOT NULL DEFAULT '已下单',
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );
  `);
  // 订单编号唯一索引；历史数据若已有重复编号则跳过（唯一性由导入逻辑兜底），不阻塞初始化
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no)");
  } catch {
    /* 已有重复编号的历史库：暂不建索引，导入时靠代码去重 */
  }
  return isNew;
}

export function getDB(): ProcurementDB {
  if (!db) {
    throw new Error("数据库尚未初始化");
  }
  return new SqliteProcurementDB(db);
}

/** 校验供应商名称唯一（除 excludeId 外） */
function assertNameUnique(d: Database.Database, name: string, excludeId?: number): void {
  const row = d
    .prepare("SELECT id FROM suppliers WHERE name=? AND id != ?")
    .get(name, excludeId ?? -1) as { id: number } | undefined;
  if (row) {
    throw new Error(`厂商「${name}」已存在，不能重复`);
  }
}

/** SQLite 实现 */
class SqliteProcurementDB implements ProcurementDB {
  constructor(private d: Database.Database) {}

  getSuppliers(): Supplier[] {
    const rows = this.d
      .prepare("SELECT * FROM suppliers ORDER BY id DESC")
      .all() as Supplier[];
    return rows;
  }

  addSupplier(s: Omit<Supplier, "id">): number {
    assertNameUnique(this.d, s.name);
    const info = this.d
      .prepare(
        "INSERT INTO suppliers (name, free_shipping, relationship, quality_desc) VALUES (?, ?, ?, ?)",
      )
      .run(s.name, s.free_shipping, s.relationship, s.quality_desc);
    return Number(info.lastInsertRowid);
  }

  updateSupplier(s: Supplier): void {
    assertNameUnique(this.d, s.name, s.id);
    this.d
      .prepare(
        "UPDATE suppliers SET name=?, free_shipping=?, relationship=?, quality_desc=? WHERE id=?",
      )
      .run(s.name, s.free_shipping, s.relationship, s.quality_desc, s.id);
  }

  deleteSupplier(id: number): void {
    // 有订单关联的供应商不允许直接删除
    const cnt = this.d
      .prepare("SELECT COUNT(*) AS c FROM orders WHERE supplier_id=?")
      .get(id) as { c: number };
    if (cnt.c > 0) {
      throw new Error("该供应商存在关联订单，无法删除");
    }
    this.d.prepare("DELETE FROM suppliers WHERE id=?").run(id);
  }

  getOrders(): Order[] {
    const rows = this.d
      .prepare(
        `SELECT o.*, s.name AS supplier_name
         FROM orders o LEFT JOIN suppliers s ON o.supplier_id = s.id
         ORDER BY o.id DESC`,
      )
      .all() as Order[];
    return rows;
  }

  addOrder(o: Omit<Order, "id">): number {
    const info = this.d
      .prepare(
        `INSERT INTO orders (order_no, supplier_id, pay_amount, receive_time, deadline, paid_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.order_no,
        o.supplier_id,
        o.pay_amount,
        o.receive_time,
        o.deadline,
        o.paid_amount,
        o.status,
      );
    return Number(info.lastInsertRowid);
  }

  updateOrder(o: Order): void {
    this.d
      .prepare(
        `UPDATE orders SET order_no=?, supplier_id=?, pay_amount=?, receive_time=?, deadline=?, paid_amount=?, status=? WHERE id=?`,
      )
      .run(
        o.order_no,
        o.supplier_id,
        o.pay_amount,
        o.receive_time,
        o.deadline,
        o.paid_amount,
        o.status,
        o.id,
      );
  }

  deleteOrder(id: number): void {
    this.d.prepare("DELETE FROM orders WHERE id=?").run(id);
  }

  restoreAll(suppliers: Supplier[], orders: Order[]): void {
    const restore = this.d.transaction(() => {
      this.d.prepare("DELETE FROM orders").run();
      this.d.prepare("DELETE FROM suppliers").run();
      const insS = this.d.prepare(
        "INSERT INTO suppliers (id, name, free_shipping, relationship, quality_desc) VALUES (?, ?, ?, ?, ?)",
      );
      for (const s of suppliers) {
        insS.run(s.id, s.name, s.free_shipping, s.relationship, s.quality_desc);
      }
      const insO = this.d.prepare(
        "INSERT INTO orders (id, order_no, supplier_id, pay_amount, receive_time, deadline, paid_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const o of orders) {
        insO.run(
          o.id,
          o.order_no,
          o.supplier_id,
          o.pay_amount,
          o.receive_time,
          o.deadline,
          o.paid_amount,
          o.status,
        );
      }
    });
    restore();
  }
}

/** 生成新的订单编号 */
export function genOrderNo(db: ProcurementDB, prefix = "ORD"): string {
  const orders = db.getOrders();
  let max = 0;
  for (const o of orders) {
    const m = o.order_no.match(/(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) {max = n;}
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

/** 自动签收：返回签收时间与截止时间(7天后) */
export function autoReceiptDates(): {
  receive_time: string;
  deadline: string;
} {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const deadline = new Date(now);
  deadline.setDate(deadline.getDate() + 7);
  return { receive_time: fmt(now), deadline: fmt(deadline) };
}
