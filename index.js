require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const initCpxRoutes = require("./routes_cpx");
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://rewarduser:9yHEHBcxuhNuDNGPQGYSVvIdDxRSZ447@dpg-dblgnjp42hec7386k5ag-a.oregon-postgres.render.com/rewardrush_ihpc',
  ssl: { rejectUnauthorized: false }
});

// Database initialization
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        phone VARCHAR(20) UNIQUE,
        points INT DEFAULT 100,
        daily_task_count INT DEFAULT 0,
        referral_code VARCHAR(20)
      );
      CREATE TABLE IF NOT EXISTS redemptions (
        id SERIAL PRIMARY KEY,
        user_id INT,
        phone VARCHAR(20),
        target_phone VARCHAR(20),
        operator VARCHAR(50),
        points_cost INT,
        reward_type VARCHAR(50),
        status VARCHAR(50) DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database tables ready.');
  } catch (err) {
    console.error('DB Init Error:', err.message);
  }
})();

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// User Profile / Auth Check
app.get('/api/user/me', async (req, res) => {
  try {
    const raw = req.query.phone || '';
    const phone = String(raw).replace(/\D/g, '').slice(-10);

    let result = await pool.query('SELECT * FROM users WHERE RIGHT(phone, 10) = $1', [phone]);
    if (result.rows.length === 0) {
      const defaultPts = (phone === '6300442917' || phone === '9705245934') ? 10000 : 100;
      result = await pool.query(
        'INSERT INTO users (name, phone, points, daily_task_count, referral_code) VALUES ($1, $2, $3, 0, $4) RETURNING *',
        ['User', phone, defaultPts, 'RR' + Math.random().toString(36).substring(2, 7).toUpperCase()]
      );
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Login / Auto-registration
app.post('/api/auth/login', async (req, res) => {
  try {
    const raw = req.body.phone || '';
    const phone = String(raw).replace(/\D/g, '').slice(-10);

    if (phone.length !== 10) {
      return res.status(400).json({ success: false, message: 'Please enter a valid 10-digit Indian mobile number.' });
    }

    let result = await pool.query('SELECT * FROM users WHERE RIGHT(phone, 10) = $1', [phone]);
    if (result.rows.length === 0) {
      const defaultPts = (phone === '6300442917' || phone === '9705245934') ? 10000 : 100;
      result = await pool.query(
        'INSERT INTO users (name, phone, points, daily_task_count, referral_code) VALUES ($1, $2, $3, 0, $4) RETURNING *',
        ['User', phone, defaultPts, 'RR' + Math.random().toString(36).substring(2, 7).toUpperCase()]
      );
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Recharge Redemption
app.post('/api/rewards/redeem', async (req, res) => {
  try {
    const { phone, targetPhone, operator, pointsCost = 4900, rewardType = 'DATA_PACK_49' } = req.body;

    const userPhone = String(phone || '').replace(/\D/g, '').slice(-10);
    const target = String(targetPhone || phone || '').replace(/\D/g, '').slice(-10);

    if (target.length !== 10 || !/^[6-9]\d{9}$/.test(target)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid 10-digit Indian mobile number.'
      });
    }

    const userRes = await pool.query('SELECT * FROM users WHERE RIGHT(phone, 10) = $1', [userPhone]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found in database.' });
    }

    const user = userRes.rows[0];
    if (Number(user.points) < Number(pointsCost)) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient points balance. Minimum 4,900 points required.'
      });
    }

    const updatedUser = await pool.query(
      'UPDATE users SET points = points - $1 WHERE id = $2 RETURNING *',
      [pointsCost, user.id]
    );

    
    // Insert redemption record with exact 8 parameters
    const redemption = await pool.query(
      'INSERT INTO redemptions (user_id, phone, target_phone, operator, points_cost, points_spent, reward_type, pack_name, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [user.id, userPhone, target, operator || 'Jio', pointsCost, pointsCost, rewardType, '₹49 - 1-Day Unlimited Data Pack', 'PENDING']
    );
res.json({
      success: true,
      message: 'Recharge request submitted successfully!',
      user: updatedUser.rows[0],
      redemption: redemption.rows[0]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// Admin: Fetch all pending redemptions
app.get('/api/admin/redemptions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM redemptions ORDER BY id DESC');
    res.json({ success: true, count: result.rows.length, redemptions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: Approve/Complete a recharge
app.post('/api/admin/redemptions/approve', async (req, res) => {
  try {
    const { id } = req.body;
    const result = await pool.query("UPDATE redemptions SET status = 'COMPLETED' WHERE id = $1 RETURNING *", [id]);
    res.json({ success: true, message: 'Recharge marked as completed', redemption: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// Admin: Fetch all data safely
app.get('/api/admin/all', async (req, res) => {
  try {
    const redemptions = await pool.query('SELECT * FROM redemptions ORDER BY id DESC');
    const users = await pool.query('SELECT id, name, phone, points, daily_task_count FROM users ORDER BY id DESC');
    res.json({
      success: true,
      redemptions: redemptions.rows || [],
      users: users.rows || []
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, redemptions: [], users: [] });
  }
});


// Auto-credit points after task timer completes
app.post('/api/tasks/complete', async (req, res) => {
  try {
    const { phone, points = 38, taskId } = req.body;
    const cleanPhone = String(phone || '').replace(/D/g, '').slice(-10);

    const userRes = await pool.query('SELECT * FROM users WHERE RIGHT(phone, 10) = $1', [cleanPhone]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const updated = await pool.query(
      'UPDATE users SET points = points + $1, daily_task_count = daily_task_count + 1 WHERE id = $2 RETURNING *',
      [points, userRes.rows[0].id]
    );

    res.json({
      success: true,
      message: 'Points auto-credited successfully!',
      user: updated.rows[0]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

initCpxRoutes(app, pool);
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
