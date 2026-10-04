import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    const filters = db.prepare(`
      SELECT f.*, u.name as owner_name
      FROM saved_filters f
      JOIN users u ON f.owner_id = u.id
      WHERE f.workspace_id = ? AND (f.owner_id = ? OR f.visibility = 'COMPANY')
      ORDER BY f.created_at DESC
    `).all(workspaceId, user.$id);

    return ctx.json({ data: filters.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', jqlQuery, visibility = 'PRIVATE', projectId = null } = await ctx.req.json();

    if (!name || !jqlQuery) return ctx.json({ error: 'Name and JQL query are required.' }, 400);

    const filterId = randomUUID();
    db.prepare(`
      INSERT INTO saved_filters (id, workspace_id, owner_id, name, description, jql_query, visibility, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(filterId, workspaceId, user.$id, name, description, jqlQuery, visibility, projectId || null);

    return ctx.json({
      success: true,
      data: {
        id: filterId,
        name,
        jqlQuery,
        visibility,
      },
    });
  })
  .delete('/item/:filterId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { filterId } = ctx.req.param();

    db.prepare('DELETE FROM saved_filters WHERE id = ? AND owner_id = ?').run(filterId, user.$id);
    return ctx.json({ success: true });
  })
  .get('/search/jql', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');
    const jql = ctx.req.query('jql') || '';
    const page = parseInt(ctx.req.query('page') || '1', 10);
    const pageSize = parseInt(ctx.req.query('pageSize') || '50', 10);
    const offset = (page - 1) * pageSize;

    if (!workspaceId) return ctx.json({ error: 'workspaceId is required.' }, 400);

    let whereClauses = ['t.workspace_id = ?'];
    let params = [workspaceId];

    // Safe AST / Token Parser for JQL: e.g. project = ECOM AND status = "IN_PROGRESS" AND assignee = currentUser()
    const tokens = jql.split(/\s+AND\s+/i);

    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;

      // project = XYZ or project = "XYZ"
      const projMatch = trimmed.match(/^project\s*=\s*['"]?([a-zA-Z0-9_-]+)['"]?$/i);
      if (projMatch) {
        whereClauses.push('(p.key = ? OR p.name = ?)');
        params.push(projMatch[1].toUpperCase(), projMatch[1]);
        continue;
      }

      // status = XYZ
      const statusMatch = trimmed.match(/^status\s*=\s*['"]?([a-zA-Z0-9_\s-]+)['"]?$/i);
      if (statusMatch) {
        whereClauses.push('t.status = ?');
        params.push(statusMatch[1]);
        continue;
      }

      // priority = XYZ
      const priorityMatch = trimmed.match(/^priority\s*=\s*['"]?([a-zA-Z0-9_\s-]+)['"]?$/i);
      if (priorityMatch) {
        whereClauses.push('t.priority = ?');
        params.push(priorityMatch[1].toUpperCase());
        continue;
      }

      // assignee = currentUser()
      if (/^assignee\s*=\s*currentUser\(\)$/i.test(trimmed)) {
        whereClauses.push('u.id = ?');
        params.push(user.$id);
        continue;
      }

      // issueType = XYZ
      const typeMatch = trimmed.match(/^type\s*=\s*['"]?([a-zA-Z0-9_\s-]+)['"]?$/i);
      if (typeMatch) {
        whereClauses.push('t.issue_type = ?');
        params.push(typeMatch[1]);
        continue;
      }
    }

    const whereSql = whereClauses.join(' AND ');

    const countRow = db.prepare(`
      SELECT COUNT(*) as total
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN members m ON t.assignee_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      WHERE ${whereSql}
    `).get(...params);

    const rows = db.prepare(`
      SELECT t.*, p.key as project_key, p.name as project_name, u.name as assignee_name, u.email as assignee_email
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN members m ON t.assignee_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      WHERE ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    return ctx.json({
      data: {
        issues: rows.map(formatDoc),
        total: countRow?.total || 0,
        page,
        pageSize,
        hasNext: (offset + rows.length) < (countRow?.total || 0),
      },
    });
  });

export default app;
