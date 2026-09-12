import { Hono } from 'hono';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/global', sessionMiddleware, async (ctx) => {
    const workspaceId = ctx.req.query('workspaceId');
    const query = ctx.req.query('q') || '';

    if (!workspaceId) return ctx.json({ error: 'workspaceId is required.' }, 400);

    const pattern = `%${query}%`;

    const issues = db.prepare(`
      SELECT id, key, name, status, priority, issue_type FROM tasks
      WHERE workspace_id = ? AND (key LIKE ? OR name LIKE ? OR description LIKE ?)
      LIMIT 10
    `).all(workspaceId, pattern, pattern, pattern);

    const projects = db.prepare(`
      SELECT id, key, name FROM projects
      WHERE workspace_id = ? AND (key LIKE ? OR name LIKE ?)
      LIMIT 5
    `).all(workspaceId, pattern, pattern);

    const users = db.prepare(`
      SELECT u.id, u.name, u.email, u.avatar_url FROM users u
      JOIN members m ON u.id = m.user_id
      WHERE m.workspace_id = ? AND (u.name LIKE ? OR u.email LIKE ?)
      LIMIT 5
    `).all(workspaceId, pattern, pattern);

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

    const recentProjects = db.prepare(`
      SELECT p.* FROM projects p
      JOIN members m ON p.workspace_id = m.workspace_id
      WHERE m.user_id = ? ${workspaceId ? 'AND p.workspace_id = ?' : ''}
      ORDER BY p.created_at DESC LIMIT 5
    `).all(...(workspaceId ? [user.$id, workspaceId] : [user.$id]));

    const assignedTasks = db.prepare(`
      SELECT t.*, p.key as project_key, p.name as project_name
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      JOIN members m ON t.assignee_id = m.id
      WHERE m.user_id = ? ${workspaceId ? 'AND t.workspace_id = ?' : ''} AND t.status != 'DONE'
      ORDER BY t.updated_at DESC LIMIT 10
    `).all(...(workspaceId ? [user.$id, workspaceId] : [user.$id]));

    return ctx.json({
      data: {
        recentProjects: recentProjects.map(formatDoc),
        assignedTasks: assignedTasks.map(formatDoc),
        pendingApprovalsCount: 0,
      },
    });
  });

export default app;
