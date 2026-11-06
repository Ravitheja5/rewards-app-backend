const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction && !process.env.DATABASE_URL.includes('localhost') 
    ? { rejectUnauthorized: false } 
    : false
});

const initDb = async () => {
  if (!process.env.DATABASE_URL) return;

  try {
    // FRESH CLEAN DATABASE (Drop previous corrupted records)
    await pool.query(`
      DROP TABLE IF EXISTS task_completions CASCADE;
      DROP TABLE IF EXISTS recharges CASCADE;
      DROP TABLE IF EXISTS users CASCADE;

      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(15) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        device_id VARCHAR(100) NOT NULL,
        points INTEGER DEFAULT 100,
        daily_task_count INTEGER DEFAULT 0,
        last_active_date DATE DEFAULT CURRENT_DATE,
        referral_code VARCHAR(30) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE task_completions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        task_id VARCHAR(50) NOT NULL,
        points_earned INTEGER NOT NULL,
        completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE recharges (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        phone VARCHAR(15) NOT NULL,
        operator VARCHAR(20) NOT NULL,
        amount INTEGER DEFAULT 49,
        status VARCHAR(20) DEFAULT 'Pending',
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ All old users wiped. Fresh production schema initialized successfully.');
  } catch (err) {
    console.error('❌ Table init error:', err.message);
  }
};

initDb();

module.exports = pool;
