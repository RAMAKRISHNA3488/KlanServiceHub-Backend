import { Hono } from 'hono';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const limit = parseInt(ctx.req.query('limit') || '50', 10);

    const activities = db.prepare(`
      SELECT a.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar,
             p.name as project_name, p.key as project_key,
             t.key as task_key, t.name as task_name
      FROM activities a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN projects p ON a.project_id = p.id
      LEFT JOIN tasks t ON a.task_id = t.id
      WHERE a.workspace_id = ?
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(workspaceId, limit);

    return ctx.json({ data: activities.map(formatDoc) });
  })
  .get('/:workspaceId/project/:projectId', sessionMiddleware, async (ctx) => {
    const { workspaceId, projectId } = ctx.req.param();
    const limit = parseInt(ctx.req.query('limit') || '50', 10);

    const activities = db.prepare(`
      SELECT a.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar,
             t.key as task_key, t.name as task_name
      FROM activities a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN tasks t ON a.task_id = t.id
      WHERE a.workspace_id = ? AND a.project_id = ?
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(workspaceId, projectId, limit);

    return ctx.json({ data: activities.map(formatDoc) });
  })
  .get('/:workspaceId/issue/:taskId', sessionMiddleware, async (ctx) => {
    const { workspaceId, taskId } = ctx.req.param();

    const activities = db.prepare(`
      SELECT a.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar
      FROM activities a
      JOIN users u ON a.user_id = u.id
      WHERE a.workspace_id = ? AND a.task_id = ?
      ORDER BY a.created_at DESC
    `).all(workspaceId, taskId);

    return ctx.json({ data: activities.map(formatDoc) });
  });

export default app;
