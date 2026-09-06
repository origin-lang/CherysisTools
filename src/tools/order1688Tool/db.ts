import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";

export interface OrderItemRow {
  id: number;
  order_id: number;
  huohao: string;
  name: string;
  spec: string;
  qty: number | null;
  price: number | null;
}

export interface OrderRecord {
  id: number;
  order_no: string;
  collect_date: string;
  order_time: string;
  supplier: string;
  pay_amount: number | null;
  created_at: string;
  items: OrderItemRow[];
}

export interface NewOrder {
  order_no: string;
  collect_date: string;
  order_time: string;
  supplier: string;
  pay_amount: number | null;
  items: Array<Pick<OrderItemRow, "huohao" | "name" | "spec" | "qty" | "price">>;
}

export interface Order1688DB {
  addOrder(o: NewOrder): "added" | "skipped";
  hasOrder(orderNo: string): boolean;
  getOrders(): OrderRecord[];
  deleteOrders(ids: number[]): void;
  countOrders(): number;
  close(): void;
}

let db: Database.Database | null = null;

export function closeDB(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    db = null;
  }
}

export function initDB(storageDir: string): boolean {
  if (db) {
    return false;
  }
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  const p = path.join(storageDir, "order1688.db");
  db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      collect_date TEXT NOT NULL DEFAULT '',
      order_time TEXT NOT NULL DEFAULT '',
      supplier TEXT NOT NULL DEFAULT '',
      pay_amount REAL,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      huohao TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      spec TEXT NOT NULL DEFAULT '',
      qty INTEGER,
      price REAL
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  `);
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

export function getDB(): Order1688DB {
  const c = core();
  const orderGet = c.prepare("SELECT 1 FROM orders WHERE order_no = ?");
  const orderInsert = c.prepare(`
    INSERT INTO orders (order_no, collect_date, order_time, supplier, pay_amount, created_at)
    VALUES (@order_no, @collect_date, @order_time, @supplier, @pay_amount, @created_at)
  `);
  const itemInsert = c.prepare(`
    INSERT INTO order_items (order_id, huohao, name, spec, qty, price)
    VALUES (@order_id, @huohao, @name, @spec, @qty, @price)
  `);
  const ordersList = c.prepare("SELECT * FROM orders ORDER BY collect_date DESC, id DESC");
  const itemsByOrder = c.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id");

  const addOrderInTx = c.transaction((o: NewOrder): "added" | "skipped" => {
    const exist = orderGet.get(o.order_no) as any;
    if (exist) {
      return "skipped";
    }
    const info = orderInsert.run({
      order_no: o.order_no,
      collect_date: o.collect_date,
      order_time: o.order_time,
      supplier: o.supplier,
      pay_amount: o.pay_amount,
      created_at: nowStr(),
    });
    const orderId = Number(info.lastInsertRowid);
    for (const it of o.items) {
      itemInsert.run({
        order_id: orderId,
        huohao: it.huohao,
        name: it.name,
        spec: it.spec,
        qty: it.qty,
        price: it.price,
      });
    }
    return "added";
  });

  const deleteOrdersTx = c.transaction((ids: number[]) => {
    const delItems = c.prepare("DELETE FROM order_items WHERE order_id = ?");
    const delOrder = c.prepare("DELETE FROM orders WHERE id = ?");
    for (const id of ids) {
      delItems.run(id);
      delOrder.run(id);
    }
  });

  return {
    addOrder(o) {
      return addOrderInTx(o);
    },
    hasOrder(orderNo) {
      return !!orderGet.get(orderNo);
    },
    getOrders(): OrderRecord[] {
      const rows = ordersList.all() as any[];
      return rows.map((r) => ({
        id: r.id,
        order_no: r.order_no,
        collect_date: r.collect_date,
        order_time: r.order_time,
        supplier: r.supplier,
        pay_amount: r.pay_amount,
        created_at: r.created_at,
        items: (itemsByOrder.all(r.id) as any[]).map((it) => ({
          id: it.id,
          order_id: it.order_id,
          huohao: it.huohao,
          name: it.name,
          spec: it.spec,
          qty: it.qty,
          price: it.price,
        })),
      }));
    },
    deleteOrders(ids) {
      if (ids.length === 0) {
        return;
      }
      deleteOrdersTx(ids);
    },
    countOrders() {
      const r = c.prepare("SELECT COUNT(*) AS n FROM orders").get() as any;
      return Number(r?.n || 0);
    },
    close() {
      closeDB();
    },
  };
}