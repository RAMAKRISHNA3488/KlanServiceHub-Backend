import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const issueTypes = await d1All('SELECT * FROM issue_types WHERE workspace_id = ? ORDER BY created_at ASC', [workspaceId], d1);
    return ctx.json({ data: issueTypes.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, icon = 'bookmark', color = '#4F46E5', description = '' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'PROJECT_EDIT' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    const id = randomUUID();
    await d1Run(`
      INSERT INTO issue_types (id, workspace_id, name, icon, color, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, workspaceId, name, icon, color, description], d1);

    try {
      logAudit({
        workspaceId,
        actorId: actor.$id,
        actorName: actor.name,
        action: 'CREATE_ISSUE_TYPE',
        entityType: 'ISSUE_TYPE',
        entityId: id,
        details: { name, color },
      });
    } catch (e) {}

    return ctx.json({ data: { id, name, icon, color, description } });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'PROJECT_EDIT' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    await d1Run('DELETE FROM issue_types WHERE id = ? AND workspace_id = ?', [id, workspaceId], d1);
    return ctx.json({ success: true });
  });

export default app;
