import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  .get('/:taskId', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const worklogs = db.prepare(`
      SELECT w.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar
      FROM work_logs w
      JOIN users u ON w.user_id = u.id
      WHERE w.task_id = ?
      ORDER BY w.started_at DESC
    `).all(taskId);

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

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) return ctx.json({ error: 'Issue not found.' }, 404);

    const worklogId = randomUUID();
    db.prepare(`
      INSERT INTO work_logs (id, task_id, user_id, time_spent_seconds, started_at, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(worklogId, taskId, user.$id, timeSpentSeconds, startedAt, description);

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

    db.prepare(`
      UPDATE tasks 
      SET time_spent_seconds = ?, remaining_estimate_seconds = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextSpent, nextRemaining, taskId);

    logActivity({
      workspaceId: task.workspace_id,
      projectId: task.project_id,
      taskId,
      userId: user.$id,
      action: 'WORK_LOGGED',
      details: `Logged ${Math.round(timeSpentSeconds / 3600 * 10) / 10}h on ${task.key || 'issue'}: "${description}"`,
    });

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

    const log = db.prepare('SELECT * FROM work_logs WHERE id = ?').get(worklogId);
    if (!log) return ctx.json({ error: 'Work log not found.' }, 404);

    db.prepare('DELETE FROM work_logs WHERE id = ?').run(worklogId);

    // Adjust spent time
    db.prepare(`
      UPDATE tasks 
      SET time_spent_seconds = MAX(0, time_spent_seconds - ?), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(log.time_spent_seconds, log.task_id);

    return ctx.json({ success: true });
  });

export default app;
