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
    // 1. Password column lekapothe direct ga ALTER cheyandi
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id VARCHAR(100) DEFAULT 'dev_legacy';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_task_count INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_date DATE DEFAULT CURRENT_DATE;
    `);

    // 2. Anni tables unnayani verify cheyandi
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(15) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        device_id VARCHAR(100) NOT NULL,
        points INTEGER DEFAULT 100,
        daily_task_count INTEGER DEFAULT 0,
        last_active_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS task_completions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        task_id VARCHAR(50) NOT NULL,
        points_earned INTEGER NOT NULL,
        completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS recharges (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        phone VARCHAR(15) NOT NULL,
        operator VARCHAR(20) NOT NULL,
        amount INTEGER DEFAULT 49,
        status VARCHAR(20) DEFAULT 'Processing',
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ PostgreSQL Schema migrated and verified successfully');
  } catch (err) {
    console.error('❌ Migration / Table init error:', err.message);
  }
};

initDb();

module.exports = pool;
