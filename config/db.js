require('dotenv').config();
const mysql = require('mysql2/promise');

const db = mysql.createPool({
  uri: process.env.DB_CONNECTION_STRING,
  connectionLimit: 10
});

async function testConnection() {
  try {
    const connection = await db.getConnection();
    console.log('✅ Connected to TiDB Cloud successfully!');
    connection.release();
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}
testConnection();

module.exports = db;