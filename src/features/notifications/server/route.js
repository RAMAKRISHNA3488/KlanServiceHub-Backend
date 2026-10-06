import { Hono } from 'hono';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');
    const d1 = ctx.env?.DB || getD1Database();

    let query = 'SELECT * FROM notifications WHERE user_id = ?';
    const params = [user.$id];
    if (workspaceId) {
      query += ' AND workspace_id = ?';
      params.push(workspaceId);
    }
    query += ' ORDER BY created_at DESC LIMIT 30';

    const notifications = await d1All(query, params, d1);
    const unreadCount = notifications.filter((n) => !n.is_read).length;

    return ctx.json({
      data: {
        notifications: notifications.map(formatDoc),
        unreadCount,
      },
    });
  })
  .patch('/:id/read', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { id } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    await d1Run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, user.$id], d1);
    return ctx.json({ success: true });
  })
  .post('/read-all', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');
    const d1 = ctx.env?.DB || getD1Database();

    if (workspaceId) {
      await d1Run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND workspace_id = ?', [user.$id, workspaceId], d1);
    } else {
      await d1Run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [user.$id], d1);
    }

    return ctx.json({ success: true });
  })
  .get('/preferences', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');
    const d1 = ctx.env?.DB || getD1Database();

    let prefs = null;
    if (workspaceId) {
      prefs = await d1First('SELECT * FROM notification_preferences WHERE user_id = ? AND workspace_id = ?', [user.$id, workspaceId], d1);
    }

    return ctx.json({
      data: prefs || {
        email_alerts: 1,
        in_app_alerts: 1,
        mention_alerts: 1,
        assignment_alerts: 1,
        status_change_alerts: 1,
      },
    });
  })
  .put('/preferences', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, emailAlerts, inAppAlerts, mentionAlerts, assignmentAlerts, statusChangeAlerts } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    await d1Run(`
      INSERT OR REPLACE INTO notification_preferences 
      (user_id, workspace_id, email_alerts, in_app_alerts, mention_alerts, assignment_alerts, status_change_alerts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      user.$id,
      workspaceId,
      emailAlerts ? 1 : 0,
      inAppAlerts ? 1 : 0,
      mentionAlerts ? 1 : 0,
      assignmentAlerts ? 1 : 0,
      statusChangeAlerts ? 1 : 0,
    ], d1);

    return ctx.json({ success: true });
  });

export default app;
