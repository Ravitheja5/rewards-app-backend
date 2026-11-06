const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const CPX_WHITELISTED_IPS = [
  '188.40.3.73',
  '159.69.213.109',
  '144.76.103.111',
  '157.90.97.92',
  '127.0.0.1',
  '::1'
];

function verifyCpxHash(transId, incomingHash, appSecret) {
  if (!transId || !incomingHash || !appSecret) return false;
  const expectedHash = crypto.createHash('md5').update(`${transId}-${appSecret}`).digest('hex');
  const incomingBuffer = Buffer.from(String(incomingHash).toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expectedHash.toLowerCase(), 'utf8');
  if (incomingBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(incomingBuffer, expectedBuffer);
}

// IP Middleware: Allows CPX test callbacks & whitelisted IPs
function checkIpOrPayload(req, res, next) {
  const clientIp = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').replace(/^.*:/, '').trim();

  // Allow whitelisted CPX servers
  if (CPX_WHITELISTED_IPS.includes(clientIp)) {
    return next();
  }

  // Allow test calls that contain mandatory CPX test parameters
  const params = { ...req.query, ...req.body };
  if (params.trans_id && params.status !== undefined) {
    return next();
  }

  console.warn(`[CPX Security Alert] Blocked IP without valid params: ${clientIp}`);
  return res.status(403).send('Forbidden: IP not authorized');
}

module.exports = function(pool) {
  router.all('/api/webhooks/cpx', checkIpOrPayload, async (req, res) => {
    const params = { ...req.query, ...req.body };
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
    const CURRENCY_FACTOR = Number(process.env.CPX_CURRENCY_FACTOR || 4900);
    const BONUS_FACTOR = Number(process.env.CPX_BONUS_FACTOR || 8800);

    if (!trans_id || status === undefined) {
      return res.status(400).send('ERROR: Missing trans_id or status');
    }

    if (APP_SECRET && hash) {
      if (!verifyCpxHash(trans_id, hash, APP_SECRET)) {
        console.error(`[CPX Security] Hash mismatch for trans_id: ${trans_id}`);
        return res.status(401).send('ERROR: Invalid security hash');
      }
    }

    const cleanUser = String(user_id || subid_1 || '').trim();
    if (!cleanUser) {
      return res.status(400).send('ERROR: Missing user identifier');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Match user by id OR phone
      const userRes = await client.query(
        'SELECT id, phone, points FROM users WHERE id::text = $1 OR RIGHT(phone, 10) = RIGHT($1, 10) FOR UPDATE',
        [cleanUser]
      );

      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send('ERROR: User not found');
      }

      const user = userRes.rows[0];
      const isCancellation = String(status) === '2';

      const transRes = await client.query(
        'SELECT * FROM cpx_transactions WHERE trans_id = $1 FOR UPDATE',
        [trans_id]
      );

      // Handle Reversal (status = 2)
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

        const existing = transRes.rows[0];
        if (existing.is_reversed || existing.status === 2) {
          await client.query('COMMIT');
          return res.status(200).send('OK');
        }

        const toDeduct = existing.points_awarded;
        await client.query(
          'UPDATE users SET points = GREATEST(0, points - $1) WHERE id = $2',
          [toDeduct, existing.user_id]
        );

        await client.query(
          `UPDATE cpx_transactions 
           SET status = 2, is_reversed = TRUE, reversed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [existing.id]
        );

        await client.query('COMMIT');
        return res.status(200).send('OK');
      }

      // Idempotency: if already processed, return OK
      if (transRes.rows.length > 0) {
        await client.query('COMMIT');
        return res.status(200).send('OK');
      }

      // Calculate Points
      const usdVal = parseFloat(amount_usd || 0);
      const isBonus = type === 'bonus' || type === 'screenout_bonus';
      const factor = isBonus ? BONUS_FACTOR : CURRENCY_FACTOR;
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
          type || (isBonus ? 'bonus' : 'complete'),
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
      console.error('[CPX Webhook Error]', err);
      return res.status(500).send('ERROR: Transaction failure');
    } finally {
      client.release();
    }
  });

  return router;
};
