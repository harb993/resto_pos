const { app } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');

/**
 * The app writes every timestamp with SQLite's datetime('now','localtime'), and the
 * analytics queries window on local time to match. toISOString() returns UTC, so
 * seeding with it shifted mock data by the machine's offset and pushed orders near
 * midnight into the wrong day. Format in local time instead.
 */
function localDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function localDate(d) {
  return localDateTime(d).substring(0, 10);
}

app.whenReady().then(() => {
  try {
    const dbPath = path.join(__dirname, 'dist', 'win-unpacked', 'data', 'restaurant.db');
    const db = new Database(dbPath);

    console.log('Connected to DB:', dbPath);

    db.exec(`
      DELETE FROM order_items;
      DELETE FROM stock_transactions WHERE reason IN ('sale', 'waste', 'restock');
      DELETE FROM orders;
      DELETE FROM expenses;
      DELETE FROM salaries;
      DELETE FROM shifts;
      DELETE FROM workers;
    `);

    db.prepare("INSERT INTO workers (full_name, role_title, is_active) VALUES ('سعيد محمد', 'طباخ', 1)").run();
    db.prepare("INSERT INTO workers (full_name, role_title, is_active) VALUES ('محمود علي', 'مساعد', 1)").run();
    db.prepare("INSERT INTO workers (full_name, role_title, is_active) VALUES ('أحمد حسن', 'عامل نظافة', 1)").run();
    const workers = db.prepare('SELECT * FROM workers').all();

    const users = db.prepare("SELECT * FROM users WHERE role = 'cashier'").all();
    if (users.length === 0) throw new Error('No cashier found');
    const cashierId = users[0].user_id;

    const owners = db.prepare("SELECT * FROM users WHERE role = 'owner'").all();
    const ownerId = owners[0].user_id;

    const menuItems = db.prepare("SELECT * FROM menu_items WHERE is_active = 1").all();

    console.log('Generating Orders...');
    const insertOrder = db.prepare(`
      INSERT INTO orders (cashier_id, subtotal, tax, discount, total_amount, payment_type, status, order_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOrderItem = db.prepare(`
      INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, unit_cost)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertStockTxn = db.prepare(`
      INSERT INTO stock_transactions (menu_item_id, change_amount, reason, related_order_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const now = new Date();
    for (let i = 0; i < 30; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      
      const ordersToday = Math.floor(Math.random() * 20) + 10;
      for (let j = 0; j < ordersToday; j++) {
        const hour = Math.floor(Math.random() * 12) + 12;
        const min = Math.floor(Math.random() * 60);
        date.setHours(hour, min, 0);
        const dateStr = localDateTime(date);

        const itemsCount = Math.floor(Math.random() * 4) + 1;
        let subtotal = 0;
        const items = [];
        
        for (let k = 0; k < itemsCount; k++) {
          const item = menuItems[Math.floor(Math.random() * menuItems.length)];
          const qty = Math.floor(Math.random() * 3) + 1;
          subtotal += item.price * qty;
          items.push({ item, qty });
        }

        const tax = subtotal * 0.14;
        const total = subtotal + tax;

        let status = 'completed';
        if (Math.random() < 0.05) status = 'voided';

        const orderRes = insertOrder.run(cashierId, subtotal, tax, 0, total, Math.random() > 0.8 ? 'card' : 'cash', status, 'dine_in', dateStr);
        const orderId = orderRes.lastInsertRowid;

        if (status === 'completed') {
          for (const { item, qty } of items) {
            insertOrderItem.run(orderId, item.item_id, qty, item.price, item.cost_price);
            insertStockTxn.run(item.item_id, -qty, 'sale', orderId, cashierId, dateStr);
          }
        }
      }

      const isMorning = Math.random() > 0.5;
      const shiftDate = localDate(date);
      const dateStrOuter = localDateTime(date);
      db.prepare("INSERT INTO shifts (cashier_id, shift_date, start_time, end_time, set_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        cashierId, shiftDate, isMorning ? '09:00' : '17:00', isMorning ? '17:00' : '01:00', ownerId, dateStrOuter
      );
      
      const expCat = ['ingredients', 'utilities', 'maintenance', 'delivery', 'other'][Math.floor(Math.random() * 5)];
      const expAmt = Math.floor(Math.random() * 500) + 100;
      db.prepare("INSERT INTO expenses (category, description, amount, recorded_by, expense_date, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        expCat, 'مصروفات دورية للتجربة', expAmt, ownerId, shiftDate, dateStrOuter
      );
    }

    console.log('Generating Salaries...');
    for (const w of workers) {
      db.prepare("INSERT INTO salaries (worker_id, amount, pay_period_start, pay_period_end, paid_on, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        w.worker_id, 4000, '2026-07-01', '2026-07-31', '2026-08-01', ownerId, '2026-08-01 10:00:00'
      );
    }

    console.log('Database successfully seeded with realistic mock data!');
    db.close();
  } catch (err) {
    console.error(err);
  } finally {
    app.quit();
  }
});
