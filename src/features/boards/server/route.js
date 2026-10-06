import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, d1All, d1First, d1Run } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const boards = await d1All('SELECT * FROM boards WHERE workspace_id = ? ORDER BY created_at ASC', [workspaceId]);
    return ctx.json({ data: boards.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, type = 'KANBAN', projectId = null, config = '{}' } = await ctx.req.json();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'BOARD_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing BOARD_MANAGE permission.' }, 403);
    }

    const id = randomUUID();
    await d1Run(`
      INSERT INTO boards (id, workspace_id, project_id, name, type, config)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, workspaceId, projectId, name, type, typeof config === 'string' ? config : JSON.stringify(config)]);

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

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'BOARD_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing BOARD_MANAGE permission.' }, 403);
    }

    const current = await d1First('SELECT * FROM boards WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
    if (!current) {
      return ctx.json({ error: 'Board not found' }, 404);
    }

    const updatedName = name !== undefined ? name : current.name;
    const updatedType = type !== undefined ? type : current.type;
    const updatedProjectId = projectId !== undefined ? projectId : current.project_id;
    const updatedConfig = config !== undefined ? (typeof config === 'string' ? config : JSON.stringify(config)) : current.config;

    await d1Run(`
      UPDATE boards
      SET name = ?, type = ?, project_id = ?, config = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?
    `, [updatedName, updatedType, updatedProjectId, updatedConfig, id, workspaceId]);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_BOARD',
      entityType: 'BOARD',
      entityId: id,
      details: { name: updatedName, type: updatedType },
    });

    const updated = await d1First('SELECT * FROM boards WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
    return ctx.json({ data: formatDoc(updated) });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'BOARD_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing BOARD_MANAGE permission.' }, 403);
    }

    await d1Run('DELETE FROM boards WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
    return ctx.json({ success: true });
  });

export default app;
