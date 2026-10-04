import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const boards = db.prepare('SELECT * FROM boards WHERE workspace_id = ? ORDER BY created_at ASC').all(workspaceId);
    return ctx.json({ data: boards.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, type = 'KANBAN', projectId = null, config = '{}' } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'BOARD_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing BOARD_MANAGE permission.' }, 403);
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO boards (id, workspace_id, project_id, name, type, config)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, workspaceId, projectId, name, type, typeof config === 'string' ? config : JSON.stringify(config));

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_BOARD',
      entityType: 'BOARD',
      entityId: id,
      details: { name, type },
    });

    return ctx.json({ data: { id, name, type } });
  })
  .patch('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();
    const { name, type, projectId, config } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'BOARD_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing BOARD_MANAGE permission.' }, 403);
    }

    const current = db.prepare('SELECT * FROM boards WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!current) {
      return ctx.json({ error: 'Board not found' }, 404);
    }

    const updatedName = name !== undefined ? name : current.name;
    const updatedType = type !== undefined ? type : current.type;
    const updatedProjectId = projectId !== undefined ? projectId : current.project_id;
    const updatedConfig = config !== undefined ? (typeof config === 'string' ? config : JSON.stringify(config)) : current.config;

    db.prepare(`
      UPDATE boards
      SET name = ?, type = ?, project_id = ?, config = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?
    `).run(updatedName, updatedType, updatedProjectId, updatedConfig, id, workspaceId);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_BOARD',
      entityType: 'BOARD',
      entityId: id,
      details: { name: updatedName, type: updatedType },
    });

    const updated = db.prepare('SELECT * FROM boards WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return ctx.json({ data: formatDoc(updated) });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'BOARD_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing BOARD_MANAGE permission.' }, 403);
    }

    db.prepare('DELETE FROM boards WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
    return ctx.json({ success: true });
  });

export default app;
