const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');
require('dotenv').config();

const app = express();

// CORS configuration for Vercel Frontend
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const PORT = process.env.PORT || 10000;

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'active', message: 'RewardRush Backend is Running Live' });
});

// 1. REGISTER USER
app.post('/api/auth/register', async (req, res) => {
  const { phone, password, deviceId } = req.body;

  if (!/^[6-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid 10-digit mobile number' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ success: false, message: 'Password must be at least 4 characters' });
  }

  try {
    const deviceCheck = await pool.query('SELECT COUNT(*) FROM users WHERE device_id = $1', [deviceId]);
    if (parseInt(deviceCheck.rows[0].count) >= 2) {
      return res.status(403).json({ success: false, message: 'Device limit reached: Max 2 numbers allowed per device.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (phone, password, device_id, points) 
       VALUES ($1, $2, $3, 100) 
       RETURNING id, phone, points, daily_task_count, last_active_date`,
      [phone, hashedPassword, deviceId]
    );

    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: 'Account already exists. Please login.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. LOGIN USER
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found. Please register.' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid password. Try again.' });
    }

    const today = new Date().toISOString().split('T')[0];
    const lastActive = new Date(user.last_active_date).toISOString().split('T')[0];
    if (today !== lastActive) {
      await pool.query('UPDATE users SET daily_task_count = 0, last_active_date = CURRENT_DATE WHERE id = $1', [user.id]);
      user.daily_task_count = 0;
    }

    const { password: _, ...userSafe } = user;
    res.status(200).json({ success: true, user: userSafe });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. COMPLETE TASK
app.post('/api/tasks/complete', async (req, res) => {
  const { userId, taskId, points } = req.body;

  try {
    const userRes = await pool.query('SELECT daily_task_count FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    if (userRes.rows[0].daily_task_count >= 12) {
      return res.status(403).json({ success: false, message: 'Daily limit of 12 tasks reached!' });
    }

    await pool.query('BEGIN');
    await pool.query(
      'INSERT INTO task_completions (user_id, task_id, points_earned) VALUES ($1, $2, $3)',
      [userId, taskId, points]
    );

    const updateRes = await pool.query(
      `UPDATE users 
       SET points = points + $1, daily_task_count = daily_task_count + 1 
       WHERE id = $2 
       RETURNING id, phone, points, daily_task_count`,
      [points, userId]
    );
    await pool.query('COMMIT');

    res.status(200).json({ success: true, user: updateRes.rows[0] });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. RECHARGE REQUEST
app.post('/api/store/recharge', async (req, res) => {
  const { userId, phone, operator } = req.body;

  try {
    const userRes = await pool.query('SELECT points FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    if (userRes.rows[0].points < 4900) {
      return res.status(400).json({ success: false, message: 'Insufficient balance. Need 4,900 points.' });
    }

    await pool.query('BEGIN');
    await pool.query('UPDATE users SET points = points - 4900 WHERE id = $1', [userId]);
    await pool.query(
      'INSERT INTO recharges (user_id, phone, operator, amount) VALUES ($1, $2, $3, 49)',
      [userId, phone, operator]
    );
    await pool.query('COMMIT');

    res.status(200).json({ success: true, message: '₹49 Recharge request logged successfully' });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 RewardRush Backend running on port ${PORT}`);
});
