import { Hono } from 'hono';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const action = ctx.req.query('action');
    const entityType = ctx.req.query('entityType');
    const search = ctx.req.query('search');

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'AUDIT_VIEW' })) {
      return ctx.json({ error: 'Forbidden: Missing AUDIT_VIEW permission.' }, 403);
    }

    let query = 'SELECT * FROM audit_logs WHERE workspace_id = ?';
    const params = [workspaceId];

    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }

    if (entityType) {
      query += ' AND entity_type = ?';
      params.push(entityType);
    }

    if (search) {
      query += ' AND (actor_name LIKE ? OR details LIKE ? OR action LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT 100';

    const logs = db.prepare(query).all(...params);

    return ctx.json({ data: logs.map(formatDoc) });
  })
  .get('/:workspaceId/export', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'AUDIT_VIEW' })) {
      return ctx.json({ error: 'Forbidden: Missing AUDIT_VIEW permission.' }, 403);
    }

    const logs = db.prepare('SELECT * FROM audit_logs WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId);

    // Generate CSV string
    const headers = ['ID', 'Timestamp', 'Actor Name', 'Action', 'Entity Type', 'Entity ID', 'IP Address', 'Details'];
    const rows = logs.map((l) => [
      l.id,
      l.created_at,
      `"${(l.actor_name || '').replace(/"/g, '""')}"`,
      l.action,
      l.entity_type,
      l.entity_id || '',
      l.ip_address || '',
      `"${(l.details || '').replace(/"/g, '""')}"`,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

    ctx.header('Content-Type', 'text/csv');
    ctx.header('Content-Disposition', `attachment; filename="audit_logs_${workspaceId}.csv"`);
    return ctx.text(csvContent);
  });

export default app;
