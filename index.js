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
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'admin-secret']
}));

app.use(express.json());

const PORT = process.env.PORT || 10000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'rewardrush_admin_2026';

app.get('/', (req, res) => {
  res.json({ status: 'active', message: 'RewardRush Production API Ready' });
});

const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{8,16}$/;

// 1. REGISTER
app.post('/api/auth/register', async (req, res) => {
  const { name, phone, password, deviceId } = req.body;

  if (!name || name.trim().length < 2) {
    return res.status(400).json({ success: false, message: 'Please enter a valid full name.' });
  }

  if (!/^[6-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number.' });
  }

  if (!password || !strongPasswordRegex.test(password)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Password must be 8-16 characters and contain uppercase, lowercase, number, and special char (@$!%*?&#).' 
    });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const referralCode = 'RR' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const result = await pool.query(
      `INSERT INTO users (name, phone, password, device_id, points, referral_code) 
       VALUES ($1, $2, $3, $4, 100, $5) 
       RETURNING id, name, phone, points, daily_task_count, referral_code`,
      [name.trim(), phone, hashedPassword, deviceId || 'device_default', referralCode]
    );

    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: 'Mobile number already registered. Please login.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ success: false, message: 'Mobile number and password required' });
  }

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
    const lastActive = user.last_active_date ? new Date(user.last_active_date).toISOString().split('T')[0] : '';
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

// 3. DAILY CHECKIN
app.post('/api/user/daily-checkin', async (req, res) => {
  const { userId } = req.body;
  try {
    const userRes = await pool.query('SELECT points, last_active_date FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    const user = userRes.rows[0];
    const today = new Date().toISOString().split('T')[0];
    const lastActive = user.last_active_date ? new Date(user.last_active_date).toISOString().split('T')[0] : '';

    if (today === lastActive) {
      return res.status(400).json({ success: false, message: 'Already claimed today! Come back tomorrow.' });
    }

    const updated = await pool.query(
      `UPDATE users 
       SET points = points + 25, last_active_date = CURRENT_DATE 
       WHERE id = $1 
       RETURNING id, name, phone, points, daily_task_count`,
      [userId]
    );

    res.json({ success: true, message: '🎉 +25 Points added for Daily Streak!', user: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. TASK COMPLETE (Ad Tasks with Anti-Spam Rate Limit)
app.post('/api/tasks/complete', async (req, res) => {
  const { userId, taskId, points, clientStartedAt } = req.body;

  try {
    const userRes = await pool.query('SELECT daily_task_count, points FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    if (userRes.rows[0].daily_task_count >= 130) {
      return res.status(403).json({ success: false, message: 'Daily task limit of 130 tasks reached for today!' });
    }

    // Minimum verification interval enforcement
    if (clientStartedAt && Date.now() - clientStartedAt < 12000) {
      return res.status(400).json({ success: false, message: 'Task verification failed. Full timer must complete.' });
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
       RETURNING id, name, phone, points, daily_task_count`,
      [points, userId]
    );
    await pool.query('COMMIT');

    res.status(200).json({ success: true, user: updateRes.rows[0] });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. vCOMMISSION S2S POSTBACK WEBHOOK
app.get('/api/postback/vcommission', async (req, res) => {
  const { sub1, aff_sub, click_id, payout, status, campaign_id } = req.query;
  const userId = sub1 || aff_sub;

  if (!userId) {
    return res.status(400).send('ERROR: Missing User ID parameter');
  }

  try {
    const pointsToAdd = payout ? Math.round(parseFloat(payout) * 10) : 1000;

    await pool.query('BEGIN');
    const updateRes = await pool.query(
      `UPDATE users 
       SET points = points + $1 
       WHERE id = $2 
       RETURNING id, points`,
      [pointsToAdd, userId]
    );

    if (updateRes.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('User not found');
    }

    await pool.query(
      `INSERT INTO task_completions (user_id, task_id, points_earned) 
       VALUES ($1, $2, $3)`,
      [userId, `vcomm_${campaign_id || click_id || 'conversion'}`, pointsToAdd]
    );

    await pool.query('COMMIT');
    return res.status(200).send('OK');
  } catch (err) {
    await pool.query('ROLLBACK');
    return res.status(500).send('Database Error');
  }
});

// 6. STORE RECHARGE REQUEST
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

    res.status(200).json({ 
      success: true, 
      message: 'Recharge request submitted successfully. Processing time: 2 to 6 hours.' 
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. ADMIN STATS & RECHARGES
app.get('/api/admin/recharges', async (req, res) => {
  const token = req.headers['admin-secret'];
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const recharges = await pool.query(
      `SELECT r.*, u.name as user_name, u.phone as account_phone 
       FROM recharges r 
       JOIN users u ON r.user_id = u.id 
       ORDER BY r.requested_at DESC LIMIT 100`
    );

    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM recharges WHERE status = 'Pending') as pending_recharges,
        (SELECT COUNT(*) FROM recharges WHERE status = 'Completed') as completed_recharges
    `);

    res.json({ success: true, stats: stats.rows[0], data: recharges.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. ADMIN RECHARGE STATUS UPDATE
app.post('/api/admin/recharge/status', async (req, res) => {
  const token = req.headers['admin-secret'];
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
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
  console.log(`Server listening on port ${PORT}`);
});
