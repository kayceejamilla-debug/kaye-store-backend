const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

let products = [
  { id: 1, name: "Ligo Sardines in Tomato Sauce", category: "canned goods", price: 27.0, stock: 40 },
  { id: 2, name: "Oishi Spicy Seafood Curls", category: "snacks", price: 8.05, stock: 4 },
  { id: 3, name: "Lucky Me Chicken na Chicken", category: "noodles", price: 19.65, stock: 60 },
  { id: 4, name: "Coca-Cola 1 Liter", category: "beverages", price: 69.5, stock: 25 },
  { id: 5, name: "Safeguard Bar Soap Pink", category: "personal care", price: 50.5, stock: 2 },
  { id: 6, name: "Surf Fabric Conditioner", category: "laundry", price: 10.06, stock: 80 }
];

app.get('/', (req, res) => {
  res.send('<h1>Kaye Store API is running</h1><p>Try <a href="/api/data">/api/data</a></p>');
});

app.get('/api/data', (req, res) => {
  res.json(products);
});

app.post('/api/data', (req, res) => {
  console.log('Received POST request:', req.body);

  const { name, price } = req.body;
  const nextId = products.length ? Math.max(...products.map(p => p.id)) + 1 : 1;

  const newProduct = {
    id: nextId,
    name: name,
    category: "uncategorized",
    price: parseFloat(price),
    stock: 0
  };

  products.push(newProduct);
  console.log('Product added:', newProduct);
  res.status(201).json(newProduct);
});

// EDIT
app.put('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const exists = products.some(p => p.id === id);

  if (!exists) {
    console.log(`[EDIT FAILED] product id ${id} not found`);
    return res.status(404).json({ message: 'Product not found' });
  }

  console.log(`[EDIT] product id ${id}:`, req.body);
  products = products.map(p => (p.id === id ? { ...p, ...req.body, id } : p));
  res.json(products.find(p => p.id === id));
});

// DELETE
app.delete('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const product = products.find(p => p.id === id);

  if (!product) {
    console.log(`[DELETE FAILED] product id ${id} not found`);
    return res.status(404).json({ message: 'Product not found' });
  }

  console.log(`[DELETE] product id ${id}: ${product.name}`);
  products = products.filter(p => p.id !== id);
  res.json({ message: 'Products deleted', id });
});

// ✏️ BINAGO: JSON format ang display sa terminal
function cleanProduct(p) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    price: p.price,
    stock: p.stock,
  };
}

app.post('/api/log', (req, res) => {
  const { action, product, remaining } = req.body;

  if (action === 'delete') {
    console.log('\n[DELETE] Product Deleted');
    console.log(JSON.stringify(remaining.map(cleanProduct), null, 2));
  } else {
    const label = { add: '[ADD]', edit: '[EDIT]' }[action] || action;
    console.log(`\n${label}`);
    console.log(JSON.stringify(cleanProduct(product), null, 2));
  }

  res.json({ ok: true });
});


const PORT = 8080;
app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`)
});