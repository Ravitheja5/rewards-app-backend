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
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'rewardrush_admin_2026';

app.get('/', (req, res) => {
  res.json({ status: 'active', message: 'RewardRush Production Engine Active' });
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
    const referralCode = 'RR' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const result = await pool.query(
      `INSERT INTO users (phone, password, device_id, points, referral_code, daily_task_count, last_active_date) 
       VALUES ($1, $2, $3, 100, $4, 0, CURRENT_DATE) 
       RETURNING id, phone, points, daily_task_count, referral_code`,
      [phone, hashedPassword, deviceId || 'dev_default', referralCode]
    );

    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: 'Account already exists. Please login.' });
    }
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
    res.status(500).json({ success: false, message: 'Database error: ' + err.message });
  }
});

// 3. DAILY CHECK-IN STREAK (Retention Booster)
app.post('/api/user/daily-checkin', async (req, res) => {
  const { userId } = req.body;

  try {
    const userRes = await pool.query('SELECT points, last_active_date FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    const user = userRes.rows[0];
    const today = new Date().toISOString().split('T')[0];
    const lastActive = user.last_active_date ? new Date(user.last_active_date).toISOString().split('T')[0] : '';

    if (today === lastActive) {
      return res.status(400).json({ success: false, message: 'Already claimed today! Check back tomorrow.' });
    }

    const updated = await pool.query(
      `UPDATE users 
       SET points = points + 20, last_active_date = CURRENT_DATE, daily_task_count = 0 
       WHERE id = $1 
       RETURNING id, phone, points, daily_task_count`,
      [userId]
    );

    res.json({ success: true, message: '🎉 Daily Check-in Bonus +20 pts added!', user: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. COMPLETE TASK (Anti-Spam & Limit Guard)
app.post('/api/tasks/complete', async (req, res) => {
  const { userId, taskId, points } = req.body;

  try {
    const userRes = await pool.query('SELECT daily_task_count, points FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    if (userRes.rows[0].daily_task_count >= 12) {
      return res.status(403).json({ success: false, message: 'Daily limit of 12 tasks reached for today!' });
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

// 5. STORE REDEMPTION
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
      'INSERT INTO recharges (user_id, phone, operator, amount, status) VALUES ($1, $2, $3, 49, $4)',
      [userId, phone, operator, 'Pending']
    );
    await pool.query('COMMIT');

    res.status(200).json({ success: true, message: 'Recharge request placed successfully' });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. ADMIN APIS (View & Manage Recharges)
app.get('/api/admin/recharges', async (req, res) => {
  const token = req.headers['admin-secret'];
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized Admin Access' });
  }

  try {
    const recharges = await pool.query(
      `SELECT r.*, u.phone as account_phone 
       FROM recharges r 
       JOIN users u ON r.user_id = u.id 
       ORDER BY r.requested_at DESC LIMIT 50`
    );
    res.json({ success: true, data: recharges.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/recharge/status', async (req, res) => {
  const token = req.headers['admin-secret'];
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized Admin Access' });
  }

  const { id, status } = req.body;
  try {
    await pool.query('UPDATE recharges SET status = $1 WHERE id = $2', [status, id]);
    res.json({ success: true, message: `Recharge marked as ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Production server running on port ${PORT}`);
});
