const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.json({ status: 'active', message: 'Finora Rewards Backend is Running' });
});

// Auth Register
app.post('/api/auth/register', async (req, res) => {
  const { phone, password, deviceId } = req.body;
  if (!phone || !password) return res.status(400).json({ success: false, message: 'Missing fields' });

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (phone, password, device_id, points) 
       VALUES ($1, $2, $3, 100) 
       RETURNING id, phone, points, daily_task_count`,
      [phone, hashedPassword, deviceId || 'unknown']
    );
    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: 'Account already exists. Please login.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Auth Login
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found. Please register.' });
    }
    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid password' });

    const { password: _, ...userSafe } = user;
    res.json({ success: true, user: userSafe });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
