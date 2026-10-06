import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  .get('/:taskId', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const sql = `
      SELECT w.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar
      FROM work_logs w
      JOIN users u ON w.user_id = u.id
      WHERE w.task_id = ?
      ORDER BY w.started_at DESC
    `;
    const worklogs = await d1All(sql, [taskId], d1);

    return ctx.json({ data: worklogs.map(formatDoc) });
  })
  .post('/:taskId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { taskId } = ctx.req.param();
    const {
      timeSpentSeconds,
      startedAt = new Date().toISOString(),
      description = '',
      strategy = 'AUTO_ADJUST', // AUTO_ADJUST, LEAVE_UNCHANGED, MANUAL_UPDATE
      newRemainingSeconds = null,
    } = await ctx.req.json();

    if (!timeSpentSeconds || timeSpentSeconds <= 0) {
      return ctx.json({ error: 'Valid time spent in seconds is required.' }, 400);
    }

    const d1 = ctx.env?.DB || getD1Database();
    const task = await d1First('SELECT * FROM tasks WHERE id = ?', [taskId], d1);
    if (!task) return ctx.json({ error: 'Issue not found.' }, 404);

    const worklogId = randomUUID();
    await d1Run(`
      INSERT INTO work_logs (id, task_id, user_id, time_spent_seconds, started_at, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [worklogId, taskId, user.$id, timeSpentSeconds, startedAt, description], d1);

    // Calculate time tracking updates
    const currentSpent = task.time_spent_seconds || 0;
    const currentRemaining = task.remaining_estimate_seconds || task.original_estimate_seconds || 0;

    const nextSpent = currentSpent + timeSpentSeconds;
    let nextRemaining = currentRemaining;

    if (strategy === 'AUTO_ADJUST') {
      nextRemaining = Math.max(0, currentRemaining - timeSpentSeconds);
    } else if (strategy === 'MANUAL_UPDATE' && newRemainingSeconds !== null) {
      nextRemaining = Math.max(0, newRemainingSeconds);
    }

    await d1Run(`
      UPDATE tasks 
      SET time_spent_seconds = ?, remaining_estimate_seconds = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [nextSpent, nextRemaining, taskId], d1);

    try {
      logActivity({
        workspaceId: task.workspace_id,
        projectId: task.project_id,
        taskId,
        userId: user.$id,
        action: 'WORK_LOGGED',
        details: `Logged ${Math.round(timeSpentSeconds / 3600 * 10) / 10}h on ${task.key || 'issue'}: "${description}"`,
      });
    } catch (e) {}

    return ctx.json({
      success: true,
      data: {
        id: worklogId,
        taskId,
        timeSpentSeconds,
        totalTimeSpentSeconds: nextSpent,
        remainingEstimateSeconds: nextRemaining,
      },
    });
  })
  .delete('/item/:worklogId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { worklogId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const log = await d1First('SELECT * FROM work_logs WHERE id = ?', [worklogId], d1);
    if (!log) return ctx.json({ error: 'Work log not found.' }, 404);

    await d1Run('DELETE FROM work_logs WHERE id = ?', [worklogId], d1);

    // Adjust spent time
    await d1Run(`
      UPDATE tasks 
      SET time_spent_seconds = MAX(0, time_spent_seconds - ?), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [log.time_spent_seconds, log.task_id], d1);

    return ctx.json({ success: true });
  });

export default app;
