require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const app = express();

// Puwedeng maraming URL sa CORS_ORIGIN, paghiwalayin ng kuwit
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const devOrigins = ['http://localhost:5173', 'http://localhost:5174'];
app.use(cors({ origin: [...new Set([...devOrigins, ...allowedOrigins])] }));
app.use(express.json({ limit: '5mb' })); // may kasamang larawan (avatar)

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'kaye_store',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

db.getConnection()
  .then((conn) => {
    console.log('✅ Database Connected');
    conn.release();
  })
  .catch((err) => console.error('❌ Database connection failed:', err.message));

// =====================================================
// USERS TABLE: dagdag na columns (avatar + delivery address)
// Kusang idinadagdag kung wala pa, hindi mo na kailangang mag-SQL.
// =====================================================
const USER_EXTRA_COLUMNS = {
  avatar: 'MEDIUMTEXT NULL',
  addr_name: 'VARCHAR(100) NULL',
  addr_phone: 'VARCHAR(30) NULL',
  addr_street: 'VARCHAR(255) NULL',
  addr_city: 'VARCHAR(100) NULL',
  addr_province: 'VARCHAR(100) NULL',
  addr_zip: 'VARCHAR(10) NULL'
};

const usersReady = (async () => {
  try {
    const [cols] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
    );
    const existing = new Set(cols.map((c) => c.COLUMN_NAME.toLowerCase()));
    for (const [name, def] of Object.entries(USER_EXTRA_COLUMNS)) {
      if (!existing.has(name)) {
        await db.query(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
        console.log(`🛠 users.${name} column added`);
      }
    }
  } catch (err) {
    console.error('❌ users columns check failed:', err.message);
  }
})();

// =====================================================
// NOTIFICATIONS: table (kusang ginagawa kung wala pa) + helpers
// =====================================================
const notificationsReady = db
  .query(`
    CREATE TABLE IF NOT EXISTS notifications (
      notification_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(150) NOT NULL,
      message VARCHAR(500) NOT NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'general',
      order_id INT NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_notif_user (user_id, created_at)
    )
  `)
  .catch((err) => console.error('❌ notifications table failed:', err.message));

// Hindi kailanman nagbabato ng error para hindi masira ang order
const notify = async (userId, title, message, type = 'general', orderId = null) => {
  try {
    await notificationsReady;
    if (!userId) return;
    await db.query(
      'INSERT INTO notifications (user_id, title, message, type, order_id) VALUES (?, ?, ?, ?, ?)',
      [userId, title, message, type, orderId]
    );
  } catch (err) {
    console.error('❌ notify failed:', err.message);
  }
};

const notifyAdmins = async (title, message, type, orderId) => {
  try {
    const [admins] = await db.query("SELECT user_id FROM users WHERE role = 'admin'");
    for (const a of admins) {
      await notify(a.user_id, title, message, type, orderId);
    }
  } catch (err) {
    console.error('❌ notifyAdmins failed:', err.message);
  }
};

// =====================================================
// FIREBASE TOKEN + ROLE CHECK (CC 106 #3)
// =====================================================
const ENFORCE_AUTH = process.env.ENFORCE_AUTH === 'true';

let verifyToken = (req, res, next) => next();
let adminOnly = (req, res, next) => next();

if (ENFORCE_AUTH) {
  const admin = require('firebase-admin');
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./serviceAccountKey.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

  verifyToken = async (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'No token provided' });
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      const email = (decoded.email || '').toLowerCase();
      const [rows] = await db.query('SELECT role FROM users WHERE email = ?', [email]);
      req.user = { uid: decoded.uid, email, role: rows[0]?.role || 'customer' };
      next();
    } catch (err) {
      res.status(401).json({ message: 'Invalid or expired token' });
    }
  };

  adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Admins only' });
    }
    next();
  };
}
console.log(`🔐 Auth enforcement: ${ENFORCE_AUTH ? 'ON' : 'OFF'}`);

// =====================================================
// PRODUCTS API
// =====================================================
const SELECT_PRODUCT = `
  SELECT product_id AS id, product_name AS name, category, price, stock, image, description
  FROM products
`;
const toProduct = (row) => ({ ...row, price: Number(row.price) });

app.get('/', (req, res) => {
  res.send('<h1>Kaye Store API is running</h1><p>Try <a href="/api/data">/api/data</a></p>');
});

app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: process.env.DB_NAME || 'kaye_store' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Get all products
const getProducts = async (req, res) => {
  try {
    const [rows] = await db.query(SELECT_PRODUCT);
    res.json(rows.map(toProduct));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
};
app.get('/api/data', getProducts);
app.get('/api/products', getProducts);

// Add product
const addProduct = async (req, res) => {
  try {
    console.log('Received POST request:', req.body);
    const {
      name,
      category = 'uncategorized',
      price,
      stock = 0,
      image = null,
      description = null
    } = req.body;

    if (!name || price === undefined || isNaN(price) || Number(price) < 0) {
      return res.status(400).json({ message: 'Valid name and price are required' });
    }

    const [result] = await db.query(
      "INSERT INTO products (product_name, category, price, stock, image, description) VALUES (?, ?, ?, ?, ?, ?)",
      [name, category, parseFloat(price), Number(stock), image, description]
    );

    const newProduct = {
      id: result.insertId,
      name,
      category,
      price: parseFloat(price),
      stock: Number(stock),
      image,
      description
    };
    console.log('✅ Product added:', newProduct);
    res.status(201).json(newProduct);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
};
app.post('/api/data', verifyToken, adminOnly, addProduct);
app.post('/api/products', verifyToken, adminOnly, addProduct);

// Update product
app.put('/api/products/:id', verifyToken, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.query(`${SELECT_PRODUCT} WHERE product_id = ?`, [id]);

    if (rows.length === 0) {
      console.log(`[EDIT FAILED] product id ${id} not found`);
      return res.status(404).json({ message: 'Product not found' });
    }

    const { name, category, price, stock, image, description } = req.body;
    await db.query(
      "UPDATE products SET product_name=?, category=?, price=?, stock=?, image=?, description=? WHERE product_id=?",
      [name, category, parseFloat(price), Number(stock), image, description, id]
    );

    const updated = { id, name, category, price: Number(price), stock, image, description };
    console.log('✅ Product updated:', updated);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// Delete product
app.delete('/api/products/:id', verifyToken, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await db.query("DELETE FROM products WHERE product_id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }
    console.log(`✅ Product deleted: id ${id}`);
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// =====================================================
// USERS API (role: admin / customer)
// =====================================================

const SELECT_USER = `
  SELECT user_id, name, email, role, avatar,
         addr_name, addr_phone, addr_street, addr_city, addr_province, addr_zip
  FROM users
`;

// Hugis ng user na inaasahan ng frontend
const toUserPayload = (row) => {
  const address = {
    name: row.addr_name || '',
    phone: row.addr_phone || '',
    street: row.addr_street || '',
    city: row.addr_city || '',
    province: row.addr_province || '',
    zip: row.addr_zip || ''
  };
  return {
    user_id: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatar: row.avatar || null,
    address: Object.values(address).some(Boolean) ? address : null
  };
};

// Kapag may nag-login/signup: kung wala pa sa table, idagdag bilang 'customer'.
// Ibabalik ang user_id at role ng email. Ang 'admin' ay manual lang ang pag-set sa database.
app.post('/api/users/sync', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const name = (req.body.name || '').trim() || email;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    await usersReady;

    const [result] = await db.query(
      "INSERT IGNORE INTO users (name, email, role) VALUES (?, ?, 'customer')",
      [name, email]
    );
    if (result.affectedRows > 0) {
      console.log(`[USER ADDED] ${email} (customer)`);
    }

    const [rows] = await db.query(`${SELECT_USER} WHERE email = ?`, [email]);

    console.log(`[LOGIN CHECK] ${email} -> ${rows[0].role}`);
    res.json(toUserPayload(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// I-save ang larawan (avatar) at/o delivery address ng user
app.put('/api/users/profile', verifyToken, async (req, res) => {
  try {
    await usersReady;

    const email = (req.user?.email || req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const sets = [];
    const values = [];

    if ('avatar' in req.body) {
      const avatar = req.body.avatar;
      const valid =
        avatar === null ||
        (typeof avatar === 'string' && avatar.startsWith('data:image/') && avatar.length <= 2000000);
      if (!valid) {
        return res.status(400).json({ message: 'Invalid image' });
      }
      sets.push('avatar = ?');
      values.push(avatar);
    }

    if (req.body.address && typeof req.body.address === 'object') {
      const a = req.body.address;
      const clip = (v, n) => String(v ?? '').trim().slice(0, n);
      sets.push('addr_name = ?', 'addr_phone = ?', 'addr_street = ?', 'addr_city = ?', 'addr_province = ?', 'addr_zip = ?');
      values.push(clip(a.name, 100), clip(a.phone, 30), clip(a.street, 255), clip(a.city, 100), clip(a.province, 100), clip(a.zip, 10));
    }

    if (sets.length === 0) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    const [existing] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE email = ?`, [...values, email]);

    const [rows] = await db.query(`${SELECT_USER} WHERE email = ?`, [email]);
    console.log(`[PROFILE SAVED] ${email}`);
    res.json(toUserPayload(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// =====================================================
// ORDERS API
// =====================================================

// Get orders by user ID
app.get('/api/orders/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const [orders] = await db.query(
      "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC",
      [userId]
    );
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get single order with items
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const [orders] = await db.query("SELECT * FROM orders WHERE order_id = ?", [orderId]);
    if (orders.length === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }
    
    const [items] = await db.query(
      "SELECT oi.*, p.product_name FROM order_items oi JOIN products p ON oi.product_id = p.product_id WHERE oi.order_id = ?",
      [orderId]
    );
    
    res.json({ ...orders[0], items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create new order
app.post('/api/orders', async (req, res) => {
  try {
    const { 
      user_id, total, status = 'Pending', payment = 'COD',
      ship_name, ship_phone, ship_street, ship_brgy, ship_city, items 
    } = req.body;
    
    if (!user_id || !ship_name || !ship_phone || !ship_street || !ship_brgy || !ship_city || !items || items.length === 0) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    const [orderResult] = await db.query(
      "INSERT INTO orders (user_id, total, status, payment, ship_name, ship_phone, ship_street, ship_brgy, ship_city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [user_id, total, status, payment, ship_name, ship_phone, ship_street, ship_brgy, ship_city]
    );
    
    const order_id = orderResult.insertId;
    
    for (const item of items) {
      await db.query(
        "INSERT INTO order_items (order_id, product_id, qty, price) VALUES (?, ?, ?, ?)",
        [order_id, item.product_id, item.qty, item.price]
      );

      // Bawasan ang stock ng product para hindi bumalik ang dating stock pag nag-refresh
      await db.query(
        "UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE product_id = ?",
        [item.qty, item.product_id]
      );
    }

    // Notification: sa customer (natanggap na) at sa admin (may bagong order)
    const totalText = Number(total || 0).toFixed(2);
    await notify(
      user_id,
      'Order received 🛒',
      `Your order #${order_id} (₱${totalText}) has been placed. We will update you once it is being prepared.`,
      'order_placed',
      order_id
    );
    await notifyAdmins(
      'New order 🧾',
      `${ship_name} placed order #${order_id} (₱${totalText}).`,
      'new_order',
      order_id
    );

    console.log(`✅ Order created: #${order_id}`);
    res.status(201).json({ success: true, order_id });
  } catch (err) {
    console.error('❌ Error creating order:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Hugis ng order na inaasahan ng frontend (Orders.jsx, AdminOrders.jsx)
const ORDER_STATUSES = ['Pending', 'Processing', 'Out for Delivery', 'Delivered'];

const toOrder = (row, items) => ({
  id: row.order_id,
  userId: row.user_id,
  items: items.map((i) => ({
    productId: i.product_id,
    qty: i.qty,
    price: Number(i.price)
  })),
  total: Number(row.total),
  address: {
    name: row.ship_name,
    phone: row.ship_phone,
    street: row.ship_street,
    brgy: row.ship_brgy,
    city: row.ship_city
  },
  payment: row.payment,
  status: row.status,
  date: new Date(row.created_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }),
  createdAt: new Date(row.created_at).toISOString()
});

// Get orders: admin = lahat, customer = sarili lang
// (kapag ENFORCE_AUTH=true, galing sa Firebase token ang email; kung hindi, sa ?email=)
app.get('/api/orders', verifyToken, async (req, res) => {
  try {
    const email = (req.user?.email || req.query.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const [users] = await db.query('SELECT user_id, role FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.json([]);
    }

    const [orders] =
      users[0].role === 'admin'
        ? await db.query('SELECT * FROM orders ORDER BY order_id ASC')
        : await db.query('SELECT * FROM orders WHERE user_id = ? ORDER BY order_id ASC', [users[0].user_id]);

    if (orders.length === 0) {
      return res.json([]);
    }

    const [items] = await db.query(
      'SELECT * FROM order_items WHERE order_id IN (?)',
      [orders.map((o) => o.order_id)]
    );

    res.json(
      orders.map((o) => toOrder(o, items.filter((i) => i.order_id === o.order_id)))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// Update order status (admin lang)
app.put('/api/orders/:id/status', verifyToken, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;

    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const [result] = await db.query('UPDATE orders SET status = ? WHERE order_id = ?', [status, id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Notification sa customer tungkol sa bagong status ng order niya
    const [orderRows] = await db.query('SELECT user_id FROM orders WHERE order_id = ?', [id]);
    if (orderRows.length > 0) {
      const STATUS_TEXT = {
        Pending: 'is pending',
        Processing: 'is now being prepared',
        'Out for Delivery': 'is out for delivery',
        Delivered: 'has been delivered. Thank you for shopping!'
      };
      await notify(
        orderRows[0].user_id,
        'Order update 📦',
        `Your order #${id} ${STATUS_TEXT[status] || `is now ${status}`}.`,
        'order_status',
        id
      );
    }

    console.log(`✅ Order #${id} status -> ${status}`);
    res.json({ success: true, id, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// =====================================================
// CART API (naka-save sa database: cart_items)
// =====================================================

const getUserIdByEmail = async (email) => {
  const [rows] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
  return rows.length ? rows[0].user_id : null;
};

// Kunin ang cart ng user
app.get('/api/cart', verifyToken, async (req, res) => {
  try {
    const email = (req.user?.email || req.query.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const userId = await getUserIdByEmail(email);
    if (!userId) {
      return res.json([]);
    }

    const [rows] = await db.query(
      'SELECT product_id, qty FROM cart_items WHERE user_id = ? ORDER BY cart_id ASC',
      [userId]
    );
    res.json(rows.map((r) => ({ productId: r.product_id, qty: r.qty })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// I-save ang buong cart ng user (pinapalitan ang dating laman)
app.put('/api/cart', verifyToken, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const email = (req.user?.email || req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const userId = await getUserIdByEmail(email);
    if (!userId) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Linisin ang items: valid lang at walang doble ng product
    const merged = new Map();
    for (const item of Array.isArray(req.body.items) ? req.body.items : []) {
      const productId = Number(item.productId);
      const qty = Math.floor(Number(item.qty));
      if (productId > 0 && qty > 0) {
        merged.set(productId, (merged.get(productId) || 0) + qty);
      }
    }

    await conn.beginTransaction();
    await conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId]);
    if (merged.size > 0) {
      await conn.query(
        'INSERT INTO cart_items (user_id, product_id, qty) VALUES ?',
        [[...merged].map(([productId, qty]) => [userId, productId, qty])]
      );
    }
    await conn.commit();

    res.json({ success: true, count: merged.size });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// =====================================================
// NOTIFICATIONS API
// =====================================================

// Kunin ang notifications ng user (pinakabago muna)
app.get('/api/notifications', verifyToken, async (req, res) => {
  try {
    await notificationsReady;

    const email = (req.user?.email || req.query.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const userId = await getUserIdByEmail(email);
    if (!userId) {
      return res.json([]);
    }

    const [rows] = await db.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY notification_id DESC LIMIT 100',
      [userId]
    );

    res.json(
      rows.map((n) => ({
        id: n.notification_id,
        title: n.title,
        message: n.message,
        type: n.type,
        orderId: n.order_id,
        isRead: Boolean(n.is_read),
        createdAt: new Date(n.created_at).toISOString()
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// I-mark na nabasa: isa (may id) o lahat (walang id)
app.put('/api/notifications/read', verifyToken, async (req, res) => {
  try {
    await notificationsReady;

    const email = (req.user?.email || req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const userId = await getUserIdByEmail(email);
    if (!userId) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (req.body.id !== undefined) {
      await db.query(
        'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND notification_id = ?',
        [userId, Number(req.body.id)]
      );
    } else {
      await db.query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});