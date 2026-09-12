import { Hono } from 'hono';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');

    let query = 'SELECT * FROM notifications WHERE user_id = ?';
    const params = [user.$id];
    if (workspaceId) {
      query += ' AND workspace_id = ?';
      params.push(workspaceId);
    }
    query += ' ORDER BY created_at DESC LIMIT 30';

    const notifications = db.prepare(query).all(...params);
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

    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, user.$id);
    return ctx.json({ success: true });
  })
  .post('/read-all', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');

    if (workspaceId) {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND workspace_id = ?').run(user.$id, workspaceId);
    } else {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.$id);
    }

    return ctx.json({ success: true });
  })
  .get('/preferences', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');

    let prefs = null;
    if (workspaceId) {
      prefs = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ? AND workspace_id = ?').get(user.$id, workspaceId);
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

    db.prepare(`
      INSERT OR REPLACE INTO notification_preferences 
      (user_id, workspace_id, email_alerts, in_app_alerts, mention_alerts, assignment_alerts, status_change_alerts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.$id,
      workspaceId,
      emailAlerts ? 1 : 0,
      inAppAlerts ? 1 : 0,
      mentionAlerts ? 1 : 0,
      assignmentAlerts ? 1 : 0,
      statusChangeAlerts ? 1 : 0
    );

    return ctx.json({ success: true });
  });

export default app;
