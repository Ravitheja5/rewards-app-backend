require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const users = {
  1: { id: 1, phone: '6300442917', points: 350, deviceId: 'dev_primary', createdAt: new Date() }
};
const otps = new Map();
const notifications = [
  { id: 1, userId: 1, title: 'Welcome to RewardRush!', message: 'You received 100 signup bonus points.', date: new Date(), read: false }
];
const redemptions = [];
const processedTxs = new Set();
const deviceAccounts = new Map();

function isValidIndianMobile(phone) {
  const regex = /^[6-9]\d{9}$/;
  if (!regex.test(phone)) return false;
  if (/^(\d)\1{9}$/.test(phone)) return false;
  const fakePatterns = ['9876543210', '9123456789', '8901234567', '7890123456', '6789012345'];
  return !fakePatterns.includes(phone);
}

// --- AUTH ---
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone || !isValidIndianMobile(phone)) {
    return res.status(400).json({ error: 'Valid 10-digit Indian mobile number required' });
  }
  const generatedOtp = '123456';
  otps.set(phone, { otp: generatedOtp, expiresAt: Date.now() + 5 * 60 * 1000 });
  return res.json({ success: true, message: 'OTP sent', otpPreview: generatedOtp });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp, deviceId = 'unknown_device' } = req.body;
  const stored = otps.get(phone);
  if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  otps.delete(phone);

  let existingUser = Object.values(users).find(u => u.phone === phone);
  if (existingUser) {
    return res.json({ success: true, isNewUser: false, user: existingUser });
  }

  const currentDeviceCount = deviceAccounts.get(deviceId) || 0;
  if (currentDeviceCount >= 2 && deviceId !== 'unknown_device') {
    return res.status(403).json({ error: 'Device limit reached (Max 2 accounts per device)' });
  }

  const newId = Object.keys(users).length + 1;
  const newUser = { id: newId, phone, points: 100, deviceId, createdAt: new Date() };
  users[newId] = newUser;
  deviceAccounts.set(deviceId, currentDeviceCount + 1);

  notifications.push({
    id: notifications.length + 1,
    userId: newId,
    title: 'Signup Bonus Added! 🎉',
    message: '100 bonus points credited to your balance.',
    date: new Date(),
    read: false
  });

  return res.json({ success: true, isNewUser: true, user: newUser });
});

// --- REDEEM STORE API ---
app.post('/api/redeem', (req, res) => {
  const { userId, type, rewardTitle, amount, pointsCost, targetValue } = req.body;
  const uid = parseInt(userId, 10);
  const user = users[uid];

  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.points < pointsCost) {
    return res.status(400).json({ 
      error: `Insufficient points! You need ${pointsCost} points, but you have ${user.points} points.` 
    });
  }

  if (!targetValue || targetValue.trim().length === 0) {
    return res.status(400).json({ error: 'Target details required' });
  }

  user.points -= pointsCost;

  const redemptionEntry = {
    id: 'RDM_' + Math.floor(100000 + Math.random() * 900000),
    userId: uid,
    userPhone: user.phone,
    type,
    rewardTitle,
    amount,
    pointsDeducted: pointsCost,
    targetValue: targetValue.trim(),
    status: 'PENDING', // PENDING -> COMPLETED | REJECTED
    createdAt: new Date()
  };

  redemptions.push(redemptionEntry);

  notifications.push({
    id: notifications.length + 1,
    userId: uid,
    title: `${rewardTitle} Request Placed! 🚀`,
    message: `Details received for ${targetValue.trim()}. Processing within 10 minutes!`,
    date: new Date(),
    read: false
  });

  return res.json({ 
    success: true, 
    message: 'Request submitted! Voucher / Data Pack will be sent within 10 minutes.',
    redemption: redemptionEntry,
    newBalance: user.points
  });
});

app.get('/api/redeem/history/:userId', (req, res) => {
  const uid = parseInt(req.params.userId, 10);
  const userHistory = redemptions.filter(r => r.userId === uid).reverse();
  res.json({ success: true, history: userHistory });
});

// --- ADMIN API (Protected by admin pass: admin123) ---
app.get('/api/admin/redemptions', (req, res) => {
  const token = req.headers['x-admin-key'];
  if (token !== 'admin123') return res.status(403).json({ error: 'Unauthorized Admin' });

  // PENDING items top lo vachela sort chestham
  const sorted = [...redemptions].reverse();
  res.json({ success: true, redemptions: sorted });
});

app.post('/api/admin/update-status', (req, res) => {
  const token = req.headers['x-admin-key'];
  if (token !== 'admin123') return res.status(403).json({ error: 'Unauthorized Admin' });

  const { id, status, remarks } = req.body;
  const item = redemptions.find(r => r.id === id);
  if (!item) return res.status(404).json({ error: 'Request not found' });

  item.status = status; // COMPLETED | REJECTED
  item.remarks = remarks || '';
  item.updatedAt = new Date();

  // Refund points if rejected
  if (status === 'REJECTED') {
    const user = users[item.userId];
    if (user) {
      user.points += item.pointsDeducted;
    }
  }

  // Notify user
  notifications.push({
    id: notifications.length + 1,
    userId: item.userId,
    title: status === 'COMPLETED' ? 'Voucher / Pack Dispatched! ✅' : 'Claim Rejected ❌',
    message: status === 'COMPLETED' 
      ? `${item.rewardTitle} sent successfully to ${item.targetValue}. ${remarks ? 'Note: ' + remarks : ''}`
      : `Your request was rejected. Points refunded. Reason: ${remarks || 'Suspicious activity'}`,
    date: new Date(),
    read: false
  });

  res.json({ success: true, item });
});

// User & Notifications
app.get('/api/user/:id', (req, res) => {
  const user = users[req.params.id] || { id: req.params.id, points: 0 };
  res.json(user);
});

app.get('/api/notifications/:userId', (req, res) => {
  const uid = parseInt(req.params.userId, 10);
  const userNotifs = notifications.filter(n => n.userId === uid).reverse();
  res.json({ success: true, notifications: userNotifs });
});

// S2S Postback
app.get('/api/postback/webhook', (req, res) => {
  const { subid, txid, points, payout, token, network = 'affiliate' } = req.query;
  const WEBHOOK_SECRET = process.env.POSTBACK_SECRET || 'rewardrush_secure_postback_2026';

  if (token !== WEBHOOK_SECRET) return res.status(403).send('UNAUTHORIZED_TOKEN');
  if (!subid || !txid) return res.status(400).send('MISSING_SUBID_OR_TXID');
  if (processedTxs.has(txid)) return res.status(200).send('ALREADY_PROCESSED');

  const pointsToCredit = points ? parseInt(points, 10) : Math.round(parseFloat(payout || 0) * 4);
  const uid = parseInt(subid, 10);

  if (!users[uid]) {
    users[uid] = { id: uid, phone: 'auto_created', points: 0, deviceId: 's2s' };
  }
  users[uid].points += pointsToCredit;
  processedTxs.add(txid);

  notifications.push({
    id: notifications.length + 1,
    userId: uid,
    title: 'Task Verified! 🪙',
    message: `You earned +${pointsToCredit} points from ${network}.`,
    date: new Date(),
    read: false
  });

  return res.status(200).send('1');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 RewardRush Backend running on port ${PORT}`);
});
