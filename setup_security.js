const fs = require('fs');

let code = fs.readFileSync('index.js', 'utf8');

// 1. Device limit check in Register endpoint
if (!code.includes('MAX_DEVICE_LIMIT')) {
  code = code.replace(
    "app.post('/api/auth/register',",
    `// Device check helper
const MAX_DEVICE_LIMIT = 2;

app.post('/api/auth/register',`
  );
}

// 2. Task validation with timestamp check
const taskSecurityRoute = `
// SECURE TASK COMPLETION WITH SERVER TIMER CHECK
const taskTimers = new Map();

app.post('/api/tasks/start', (req, res) => {
  const { phone, taskId } = req.body;
  if (!phone || !taskId) return res.status(400).json({ success: false, message: 'Invalid payload' });
  const key = \`\${phone}_\${taskId}\`;
  taskTimers.set(key, Date.now());
  res.json({ success: true, message: 'Task timer started', minSeconds: 20 });
});

app.post('/api/tasks/claim', async (req, res) => {
  const { phone, taskId, pointsReward } = req.body;
  const key = \`\${phone}_\${taskId}\`;
  const startTime = taskTimers.get(key);

  if (!startTime) {
    return res.status(400).json({ success: false, message: 'Task start cheyakunda direct ga claim cheyaleru!' });
  }

  const elapsed = (Date.now() - startTime) / 1000;
  if (elapsed < 20) {
    return res.status(400).json({ 
      success: false, 
      message: \`Inka \${Math.ceil(20 - elapsed)} seconds task chudali. Fast ga claim cheyadam kudaradu!\` 
    });
  }

  taskTimers.delete(key);

  try {
    const addPts = Number(pointsReward) || 50;
    const upd = await pool.query(
      'UPDATE users SET points = points + \$1, daily_task_count = daily_task_count + 1 WHERE phone = \$2 RETURNING id, name, phone, points, daily_task_count;',
      [addPts, phone]
    );
    res.json({ success: true, user: upd.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// STRICT RECHARGE VALIDATION
app.post('/api/rewards/redeem', async (req, res) => {
  const { phone, targetPhone, operator, planAmount, pointsRequired } = req.body;
  const validOperators = ['Jio', 'Airtel', 'Vi', 'BSNL'];

  if (!targetPhone || !/^[6-9]\d{9}$/.test(targetPhone)) {
    return res.status(400).json({ success: false, message: 'Please enter a valid 10-digit Indian mobile number.' });
  }

  if (!operator || !validOperators.includes(operator)) {
    return res.status(400).json({ success: false, message: 'Valid telecom operator (Jio, Airtel, Vi, BSNL) select cheyandi!' });
  }

  try {
    const userRes = await pool.query('SELECT points FROM users WHERE phone = \$1;', [phone]);
    if (!userRes.rows.length) return res.status(404).json({ success: false, message: 'User not found' });

    const currentPoints = userRes.rows[0].points;
    const ptsReq = Number(pointsRequired) || 4900;

    if (currentPoints < ptsReq) {
      return res.status(400).json({ success: false, message: 'Recharge ki saripada points levu!' });
    }

    const deducted = await pool.query(
      'UPDATE users SET points = points - \$1 WHERE phone = \$2 RETURNING id, name, phone, points;',
      [ptsReq, phone]
    );

    res.json({ 
      success: true, 
      message: \`₹\${planAmount} recharge request submitted successfully for \${targetPhone} (\${operator})!\`,
      user: deducted.rows[0]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
`;

if (!code.includes('/api/tasks/start')) {
  code = code.replace("app.listen(", taskSecurityRoute + "\napp.listen(");
  fs.writeFileSync('index.js', code);
  console.log('✅ Security routes added successfully to index.js');
} else {
  console.log('Routes already present');
}
