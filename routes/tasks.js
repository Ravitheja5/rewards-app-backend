const express = require('express');
const router = express.Router();

module.exports = function(pool) {
  // 1. Task Start: Records start timestamp
  router.post('/api/tasks/start', async (req, res) => {
    const { user_id, task_id } = req.body;
    if (!user_id || !task_id) {
      return res.status(400).json({ error: 'Missing user_id or task_id' });
    }

    try {
      // Find internal user ID
      const userRes = await pool.query(
        'SELECT id FROM users WHERE id::text = $1 OR RIGHT(phone, 10) = RIGHT($1, 10) LIMIT 1',
        [String(user_id)]
      );
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const uId = userRes.rows[0].id;

      // Check if already completed today
      const checkRes = await pool.query(
        'SELECT status FROM task_completions WHERE user_id = $1 AND task_id = $2 AND created_date = CURRENT_DATE',
        [uId, task_id]
      );

      if (checkRes.rows.length > 0 && checkRes.rows[0].status === 'completed') {
        return res.status(400).json({ error: 'Task already completed today' });
      }

      // Upsert start session
      await pool.query(
        `INSERT INTO task_completions (user_id, task_id, started_at, status, created_date)
         VALUES ($1, $2, NOW(), 'in_progress', CURRENT_DATE)
         ON CONFLICT (user_id, task_id, created_date)
         DO UPDATE SET started_at = NOW(), status = 'in_progress' WHERE task_completions.status != 'completed'`,
        [uId, task_id]
      );

      return res.status(200).json({ success: true, message: 'Task session started' });
    } catch (err) {
      console.error('[Task Start Error]:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 2. Task Claim: Validates 60s watch time on server
  router.post('/api/tasks/claim', async (req, res) => {
    const { user_id, task_id, points = 38 } = req.body;
    const REQUIRED_SECONDS = 55; // 5s buffer for network latency

    if (!user_id || !task_id) {
      return res.status(400).json({ error: 'Missing user_id or task_id' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const userRes = await client.query(
        'SELECT id, points FROM users WHERE id::text = $1 OR RIGHT(phone, 10) = RIGHT($1, 10) FOR UPDATE',
        [String(user_id)]
      );
      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      const uId = userRes.rows[0].id;

      const taskRes = await client.query(
        'SELECT id, started_at, status FROM task_completions WHERE user_id = $1 AND task_id = $2 AND created_date = CURRENT_DATE FOR UPDATE',
        [uId, task_id]
      );

      if (taskRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Task was not started properly' });
      }

      const task = taskRes.rows[0];
      if (task.status === 'completed') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Task already claimed today' });
      }

      // Elapsed seconds calculation
      const now = new Date();
      const started = new Date(task.started_at);
      const elapsedSec = (now.getTime() - started.getTime()) / 1000;

      if (elapsedSec < REQUIRED_SECONDS) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: `Please watch the entire video. ${Math.ceil(REQUIRED_SECONDS - elapsedSec)} seconds remaining.`
        });
      }

      // Credit points to user
      const pointsToAdd = parseInt(points, 10) || 38;
      await client.query(
        'UPDATE users SET points = points + $1 WHERE id = $2',
        [pointsToAdd, uId]
      );

      // Mark task completed
      await client.query(
        'UPDATE task_completions SET status = $1, completed_at = NOW(), points_awarded = $2 WHERE id = $3',
        ['completed', pointsToAdd, task.id]
      );

      await client.query('COMMIT');
      return res.status(200).json({
        success: true,
        pointsAwarded: pointsToAdd,
        message: 'Points credited successfully'
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Task Claim Error]:', err.message);
      return res.status(500).json({ error: 'Transaction failure' });
    } finally {
      client.release();
    }
  });

  // 3. User Task Status: Get today completed task IDs
  router.get('/api/tasks/status/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const statusRes = await pool.query(
        \`SELECT task_id, status FROM task_completions 
         JOIN users ON users.id = task_completions.user_id 
         WHERE (users.id::text = $1 OR RIGHT(users.phone, 10) = RIGHT($1, 10))
         AND task_completions.created_date = CURRENT_DATE AND task_completions.status = 'completed'\`,
        [String(userId)]
      );
      const completedTaskIds = statusRes.rows.map(r => r.task_id);
      return res.status(200).json({ completedTaskIds });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
