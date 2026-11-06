const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const DEFAULT_CPX_IPS = ['188.40.3.73', '159.69.213.109', '144.76.103.111'];

function getWhitelistedIps() {
  if (process.env.CPX_ALLOWED_IPS) {
    return process.env.CPX_ALLOWED_IPS.split(',').map(s => s.trim());
  }
  return DEFAULT_CPX_IPS;
}

function verifyCpxHash(transId, incomingHash, appSecret) {
  if (!transId || !incomingHash || !appSecret) return false;
  
  const expectedHash = crypto
    .createHash('md5')
    .update(`${transId}-${appSecret}`)
    .digest('hex');

  const incomingBuffer = Buffer.from(String(incomingHash).toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expectedHash.toLowerCase(), 'utf8');

  if (incomingBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(incomingBuffer, expectedBuffer);
}

function verifyIpMiddleware(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress || '';
  const cleanIp = clientIp.replace(/^.*:/, '').trim();

  if (process.env.NODE_ENV === 'test') {
    return next();
  }

  const allowedIps = getWhitelistedIps();
  if (allowedIps.includes(cleanIp) || allowedIps.includes(clientIp)) {
    return next();
  }

  console.warn(`[CPX Security] Blocked unauthorized IP: ${clientIp} (${cleanIp})`);
  return res.status(403).send('Forbidden: Invalid origin IP');
}

module.exports = function (pool) {
  router.all('/api/webhooks/cpx', verifyIpMiddleware, async (req, res) => {
    const params = req.method === 'POST' ? { ...req.query, ...req.body } : req.query;

    const {
      status,
      trans_id,
      user_id,
      subid_1,
      amount_usd,
      amount_local,
      offer_id,
      hash,
      ip_click,
      type
    } = params;

    const APP_SECRET = process.env.CPX_APP_SECRET;
    if (!APP_SECRET) {
      console.error('[CPX Critical] CPX_APP_SECRET environment variable is missing.');
      return res.status(500).send('Configuration Error');
    }

    const CURRENCY_FACTOR = Number(process.env.CPX_CURRENCY_FACTOR || 4900);
    const BONUS_FACTOR = Number(process.env.CPX_BONUS_FACTOR || 8800);

    if (!trans_id || !hash || status === undefined) {
      return res.status(400).send('ERROR: Missing mandatory parameters');
    }

    if (!verifyCpxHash(trans_id, hash, APP_SECRET)) {
      console.error(`[CPX Security] Hash mismatch for transaction: ${trans_id}`);
      return res.status(401).send('ERROR: Invalid security hash');
    }

    const resolvedUserId = parseInt(user_id || subid_1, 10);
    if (!resolvedUserId || isNaN(resolvedUserId)) {
      return res.status(400).send('ERROR: Invalid user_id parameter');
    }

    const isCancellation = String(status) === '2';
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const userRes = await client.query(
        'SELECT id, phone, points FROM users WHERE id = $1 FOR UPDATE',
        [resolvedUserId]
      );

      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send('ERROR: User not found');
      }

      const user = userRes.rows[0];

      const transRes = await client.query(
        'SELECT * FROM cpx_transactions WHERE trans_id = $1 FOR UPDATE',
        [trans_id]
      );

      if (isCancellation) {
        if (transRes.rows.length === 0) {
          await client.query(
            `INSERT INTO cpx_transactions 
             (trans_id, user_id, event_type, status, amount_usd, points_awarded, is_reversed, reversed_at, raw_payload)
             VALUES ($1, $2, 'reversed_untracked', 2, 0, 0, TRUE, NOW(), $3)`,
            [trans_id, user.id, JSON.stringify(params)]
          );
          await client.query('COMMIT');
          return res.status(200).send('OK');
        }

        const existingRecord = transRes.rows[0];
        if (existingRecord.is_reversed || existingRecord.status === 2) {
          await client.query('COMMIT');
          return res.status(200).send('OK');
        }

        const pointsToDeduct = existingRecord.points_awarded;
        await client.query(
          'UPDATE users SET points = points - $1 WHERE id = $2',
          [pointsToDeduct, existingRecord.user_id]
        );

        await client.query(
          `UPDATE cpx_transactions 
           SET status = 2, is_reversed = TRUE, reversed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [existingRecord.id]
        );

        await client.query('COMMIT');
        return res.status(200).send('OK');
      }

      if (transRes.rows.length > 0) {
        await client.query('COMMIT');
        return res.status(200).send('OK');
      }

      const usdVal = parseFloat(amount_usd || 0);
      const isBonusEvent = type === 'bonus' || type === 'screenout_bonus';
      const factor = isBonusEvent ? BONUS_FACTOR : CURRENCY_FACTOR;
      const pointsToCredit = Math.round(usdVal * factor);

      if (pointsToCredit > 0) {
        await client.query(
          'UPDATE users SET points = points + $1 WHERE id = $2',
          [pointsToCredit, user.id]
        );
      }

      await client.query(
        `INSERT INTO cpx_transactions 
         (trans_id, user_id, event_type, status, amount_usd, amount_local, points_awarded, offer_id, ip_click, raw_payload)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
        [
          trans_id,
          user.id,
          type || (isBonusEvent ? 'bonus' : 'complete'),
          usdVal,
          parseFloat(amount_local || 0),
          pointsToCredit,
          offer_id || null,
          ip_click || null,
          JSON.stringify(params)
        ]
      );

      await client.query('COMMIT');
      return res.status(200).send('OK');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[CPX Database Error]', err);
      return res.status(500).send('ERROR: Database transaction failed');
    } finally {
      client.release();
    }
  });

  router.get('/api/admin/cpx/metrics', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET || 'admin123'}`) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
      const metrics = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 1 AND event_type != 'bonus') AS total_completions,
          COUNT(*) FILTER (WHERE status = 1 AND event_type = 'bonus') AS total_bonuses,
          COUNT(*) FILTER (WHERE status = 2 OR is_reversed = TRUE) AS total_reversals,
          COALESCE(SUM(amount_usd) FILTER (WHERE status = 1), 0) AS gross_revenue_usd,
          COALESCE(SUM(points_awarded) FILTER (WHERE status = 1), 0) AS total_points_issued,
          COALESCE(SUM(points_awarded) FILTER (WHERE status = 2), 0) AS total_points_reversed
        FROM cpx_transactions;
      `);

      const recentLedger = await pool.query(`
        SELECT t.id, t.trans_id, t.user_id, u.phone, t.event_type, t.status, t.amount_usd, t.points_awarded, t.is_reversed, t.created_at
        FROM cpx_transactions t
        LEFT JOIN users u ON t.user_id = u.id
        ORDER BY t.id DESC
        LIMIT 25;
      `);

      res.json({
        success: true,
        metrics: metrics.rows[0],
        ledger: recentLedger.rows
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
};
