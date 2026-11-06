const crypto = require('crypto');

const CPX_WHITELISTED_IPS = (process.env.CPX_ALLOWED_IPS || '188.40.3.73,159.69.213.109,144.76.103.111,127.0.0.1,::1')
  .split(',')
  .map(ip => ip.trim());

function verifyCpxHash(transId, incomingHash, appSecret) {
  if (!transId || !incomingHash || !appSecret) return false;
  const expectedHash = crypto.createHash('md5').update(`${transId}-${appSecret}`).digest('hex');
  const incomingBuffer = Buffer.from(incomingHash.toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expectedHash.toLowerCase(), 'utf8');
  if (incomingBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(incomingBuffer, expectedBuffer);
}

function checkCpxIp(req, res, next) {
  const clientIp = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').replace('::ffff:', '').trim();
  if (process.env.NODE_ENV !== 'production' || CPX_WHITELISTED_IPS.includes(clientIp)) {
    return next();
  }
  console.warn(`[CPX Security Alert] Unauthorized IP attempt: ${clientIp}`);
  return res.status(403).send('Forbidden: IP not authorized');
}

module.exports = function(app, pool) {
  app.all('/api/webhooks/cpx', checkCpxIp, async (req, res) => {
    const params = { ...req.query, ...req.body };
    const { status, trans_id, user_id, subid_1, amount_usd, amount_local, offer_id, hash, ip_click, type } = params;

    const APP_SECRET = process.env.CPX_APP_SECRET || 'test_secret';
    const CURRENCY_FACTOR = Number(process.env.CPX_CURRENCY_FACTOR || 4900);
    const BONUS_FACTOR = Number(process.env.CPX_BONUS_FACTOR || 8800);

    if (!trans_id || !hash || status === undefined) {
      return res.status(400).send('ERROR: Missing mandatory parameters');
    }

    if (process.env.NODE_ENV === 'production' && !verifyCpxHash(trans_id, hash, APP_SECRET)) {
      console.error(`[CPX Security] Hash mismatch for trans_id: ${trans_id}`);
      return res.status(401).send('ERROR: Invalid security hash');
    }

    const targetPhone = String(user_id || subid_1 || '').replace(/\D/g, '').slice(-10);
    if (!targetPhone || targetPhone.length !== 10) {
      return res.status(400).send('ERROR: Invalid User identifier');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const userRes = await client.query(
        'SELECT id, phone, points FROM users WHERE RIGHT(phone, 10) = $1 FOR UPDATE',
        [targetPhone]
      );

      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send('ERROR: User not found');
      }

      const user = userRes.rows[0];
      const usdVal = parseFloat(amount_usd || 0);
      const isCancellation = String(status) === '2';

      const existingTrans = await client.query(
        'SELECT * FROM cpx_transactions WHERE trans_id = $1 FOR UPDATE',
        [trans_id]
      );

      if (existingTrans.rows.length > 0) {
        const transRecord = existingTrans.rows[0];
        if (transRecord.status === (isCancellation ? 2 : 1)) {
          await client.query('COMMIT');
          return res.status(200).send('OK');
        }

        if (isCancellation && transRecord.status === 1) {
          const pointsToReverse = transRecord.points_awarded;
          await client.query(
            'UPDATE users SET points = GREATEST(0, points - $1) WHERE id = $2',
            [pointsToReverse, user.id]
          );
          await client.query(
            "UPDATE cpx_transactions SET status = 2, event_type = 'reversed', updated_at = NOW() WHERE trans_id = $1",
            [trans_id]
          );
          await client.query('COMMIT');
          return res.status(200).send('OK');
        }
      }

      if (!isCancellation) {
        const isBonus = type === 'bonus' || (usdVal > 0 && usdVal < 0.05);
        const factor = isBonus ? BONUS_FACTOR : CURRENCY_FACTOR;
        const pointsAwarded = Math.round(usdVal * factor);

        if (pointsAwarded > 0) {
          await client.query('UPDATE users SET points = points + $1 WHERE id = $2', [pointsAwarded, user.id]);
          await client.query(
            `INSERT INTO cpx_transactions 
             (trans_id, user_id, phone, event_type, status, amount_usd, amount_local, points_awarded, offer_id, ip_click, raw_payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [trans_id, user.id, user.phone, isBonus ? 'bonus' : 'complete', 1, usdVal, parseFloat(amount_local || 0), pointsAwarded, offer_id || null, ip_click || null, JSON.stringify(params)]
          );
        }
      }

      await client.query('COMMIT');
      return res.status(200).send('OK');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[CPX Webhook Error]', err);
      return res.status(500).send('ERROR: Transaction failure');
    } finally {
      client.release();
    }
  });

  app.get('/api/admin/cpx/stats', async (req, res) => {
    try {
      const stats = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 1 AND event_type = 'complete') as completed_surveys,
          COUNT(*) FILTER (WHERE status = 1 AND event_type = 'bonus') as bonus_events,
          COUNT(*) FILTER (WHERE status = 2) as reversed_surveys,
          COALESCE(SUM(amount_usd) FILTER (WHERE status = 1), 0) as total_usd_revenue,
          COALESCE(SUM(points_awarded) FILTER (WHERE status = 1), 0) as total_points_credited
        FROM cpx_transactions;
      `);
      res.json({ success: true, stats: stats.rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
};
