import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const issueTypes = db.prepare('SELECT * FROM issue_types WHERE workspace_id = ? ORDER BY created_at ASC').all(workspaceId);
    return ctx.json({ data: issueTypes.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, icon = 'bookmark', color = '#4F46E5', description = '' } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'PROJECT_EDIT' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO issue_types (id, workspace_id, name, icon, color, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, workspaceId, name, icon, color, description);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_ISSUE_TYPE',
      entityType: 'ISSUE_TYPE',
      entityId: id,
      details: { name, color },
    });

    return ctx.json({ data: { id, name, icon, color, description } });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'PROJECT_EDIT' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    db.prepare('DELETE FROM issue_types WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
    return ctx.json({ success: true });
  });

export default app;
