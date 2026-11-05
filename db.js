const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const initDb = async () => {
  const query = `
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
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      task_id VARCHAR(50) NOT NULL,
      points_earned INTEGER NOT NULL,
      completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recharges (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      phone VARCHAR(15) NOT NULL,
      operator VARCHAR(20) NOT NULL,
      amount INTEGER DEFAULT 49,
      status VARCHAR(20) DEFAULT 'Processing',
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(query);
    console.log('✅ PostgreSQL Schema & Tables initialized successfully in quizcoins');
  } catch (err) {
    console.error('❌ Table init error:', err);
  }
};

initDb();

module.exports = pool;
