const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('./db');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.json({ status: 'active', message: 'RewardRush Backend is Running Live' });
});

// 1. REGISTER
app.post('/api/auth/register', async (req, res) => {
  const { phone, password, deviceId } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ success: false, message: 'Phone and password are required' });
  }

  if (!/^[6-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number' });
  }

  try {
    const deviceCheck = await pool.query('SELECT COUNT(*) FROM users WHERE device_id = $1', [deviceId || 'dev_default']);
    if (parseInt(deviceCheck.rows[0].count) >= 2) {
      return res.status(403).json({ success: false, message: 'Device limit reached: Max 2 numbers per device.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Auto-generate unique referral code (e.g., RR9421A)
    const referralCode = 'RR' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const result = await pool.query(
      `INSERT INTO users (phone, password, device_id, points, referral_code) 
       VALUES ($1, $2, $3, 100, $4) 
       RETURNING id, phone, points, daily_task_count, referral_code`,
      [phone, hashedPassword, deviceId || 'dev_default', referralCode]
    );

    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: 'Account already exists. Please login.' });
    }
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Database error: ' + err.message });
  }
});

// 2. LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ success: false, message: 'Enter mobile and password' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found. Please register first.' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid password. Try again.' });
    }

    const { password: _, ...userSafe } = user;
    res.status(200).json({ success: true, user: userSafe });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Database error: ' + err.message });
  }
});

// 3. COMPLETE TASK
app.post('/api/tasks/complete', async (req, res) => {
  const { userId, taskId, points } = req.body;

  try {
    const userRes = await pool.query('SELECT daily_task_count, points FROM users WHERE id = $1', [userId]);
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

// 4. RECHARGE
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

    res.status(200).json({ success: true, message: 'Recharge request placed' });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
