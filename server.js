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
app.use(express.json());

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

// Kapag may nag-login/signup: kung wala pa sa table, idagdag bilang 'customer'.
// Ibabalik ang user_id at role ng email. Ang 'admin' ay manual lang ang pag-set sa database.
app.post('/api/users/sync', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const name = (req.body.name || '').trim() || email;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const [result] = await db.query(
      "INSERT IGNORE INTO users (name, email, role) VALUES (?, ?, 'customer')",
      [name, email]
    );
    if (result.affectedRows > 0) {
      console.log(`[USER ADDED] ${email} (customer)`);
    }

    const [rows] = await db.query(
      'SELECT user_id, name, email, role FROM users WHERE email = ?',
      [email]
    );

    console.log(`[LOGIN CHECK] ${email} -> ${rows[0].role}`);
    res.json(rows[0]);
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

    console.log(`✅ Order #${id} status -> ${status}`);
    res.json({ success: true, id, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// =====================================================
// START SERVER
// =====================================================
app.post('/api/users/sync', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const name = (req.body.name || '').trim() || email;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const [rows] = await db.query(
      'SELECT user_id, name, email, role FROM users WHERE email = ?',
      [email]
    );

    if (rows.length > 0) {
      return res.json(rows[0]);
    }

    const [result] = await db.query(
      "INSERT INTO users (name, email, role) VALUES (?, ?, 'customer')",
      [name, email]
    );

    res.json({ user_id: result.insertId, name, email, role: 'customer' });
  } catch (err) {
    console.error('users/sync error:', err);
    res.status(500).json({ message: err.message });
  }
});
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});