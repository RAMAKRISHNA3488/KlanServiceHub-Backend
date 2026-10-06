import { Hono } from 'hono';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, formatDoc, getD1Database } from '../../../db.js';

const app = new Hono()
  .get('/global', sessionMiddleware, async (ctx) => {
    const workspaceId = ctx.req.query('workspaceId');
    const query = ctx.req.query('q') || '';
    const d1 = ctx.env?.DB || getD1Database();

    if (!workspaceId) return ctx.json({ error: 'workspaceId is required.' }, 400);

    const pattern = `%${query}%`;

    const issues = await d1All(`
      SELECT id, key, name, status, priority, issue_type FROM tasks
      WHERE workspace_id = ? AND (key LIKE ? OR name LIKE ? OR description LIKE ?)
      LIMIT 10
    `, [workspaceId, pattern, pattern, pattern], d1);

    const projects = await d1All(`
      SELECT id, key, name FROM projects
      WHERE workspace_id = ? AND (key LIKE ? OR name LIKE ?)
      LIMIT 5
    `, [workspaceId, pattern, pattern], d1);

    const users = await d1All(`
      SELECT u.id, u.name, u.email, u.avatar_url FROM users u
      JOIN members m ON u.id = m.user_id
      WHERE m.workspace_id = ? AND (u.name LIKE ? OR u.email LIKE ?)
      LIMIT 5
    `, [workspaceId, pattern, pattern], d1);

    return ctx.json({
      data: {
        issues: issues.map(formatDoc),
        projects: projects.map(formatDoc),
        users: users.map(formatDoc),
        totalMatches: issues.length + projects.length + users.length,
      },
    });
  })
  .get('/home', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');
    const d1 = ctx.env?.DB || getD1Database();

    const recentProjects = await d1All(`
      SELECT p.* FROM projects p
      JOIN members m ON p.workspace_id = m.workspace_id
      WHERE m.user_id = ? ${workspaceId ? 'AND p.workspace_id = ?' : ''}
      ORDER BY p.created_at DESC LIMIT 5
    `, workspaceId ? [user.$id, workspaceId] : [user.$id], d1);

    const assignedTasks = await d1All(`
      SELECT t.*, p.key as project_key, p.name as project_name
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      JOIN members m ON t.assignee_id = m.id
      WHERE m.user_id = ? ${workspaceId ? 'AND t.workspace_id = ?' : ''} AND t.status != 'DONE'
      ORDER BY t.updated_at DESC LIMIT 10
    `, workspaceId ? [user.$id, workspaceId] : [user.$id], d1);

    return ctx.json({
      data: {
        recentProjects: recentProjects.map(formatDoc),
        assignedTasks: assignedTasks.map(formatDoc),
        pendingApprovalsCount: 0,
      },
    });
  });

export default app;
