import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    const workflows = db.prepare('SELECT * FROM workflows WHERE workspace_id = ?').all(workspaceId);

    const workflowsWithDetails = workflows.map((wf) => {
      const statuses = db.prepare(`
        SELECT * FROM workflow_statuses WHERE workflow_id = ? ORDER BY position ASC
      `).all(wf.id);

      const transitions = db.prepare(`
        SELECT * FROM workflow_transitions WHERE workflow_id = ?
      `).all(wf.id);

      return {
        ...formatDoc(wf),
        statuses: statuses.map(formatDoc),
        transitions: transitions.map(formatDoc),
      };
    });

    return ctx.json({ data: workflowsWithDetails });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', statuses = [] } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    const workflowId = randomUUID();
    db.prepare(`
      INSERT INTO workflows (id, workspace_id, name, description, is_default)
      VALUES (?, ?, ?, ?, 0)
    `).run(workflowId, workspaceId, name, description);

    let pos = 0;
    for (const s of statuses) {
      db.prepare(`
        INSERT INTO workflow_statuses (id, workflow_id, name, category, color, position)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), workflowId, s.name, s.category || 'IN_PROGRESS', s.color || '#3B82F6', pos++);
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_WORKFLOW',
      entityType: 'WORKFLOW',
      entityId: workflowId,
      details: { name, statusesCount: statuses.length },
    });

    return ctx.json({ data: { id: workflowId, name } });
  })
  .patch('/:workspaceId/:workflowId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId } = ctx.req.param();
    const { name, description } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    const updates = [];
    const params = [];
    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description);
    }

    if (updates.length > 0) {
      params.push(workflowId, workspaceId);
      db.prepare(`UPDATE workflows SET ${updates.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...params);
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_WORKFLOW',
      entityType: 'WORKFLOW',
      entityId: workflowId,
      details: { name, description },
    });

    return ctx.json({ success: true });
  })
  .post('/:workspaceId/:workflowId/statuses', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId } = ctx.req.param();
    const { name, category = 'IN_PROGRESS', color = '#3B82F6' } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    const maxPos = db.prepare('SELECT MAX(position) as m FROM workflow_statuses WHERE workflow_id = ?').get(workflowId)?.m || 0;
    const statusId = randomUUID();

    db.prepare(`
      INSERT INTO workflow_statuses (id, workflow_id, name, category, color, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(statusId, workflowId, name.toUpperCase().replace(/\s+/g, '_'), category, color, maxPos + 1);

    return ctx.json({ success: true, statusId });
  })
  .patch('/:workspaceId/:workflowId/statuses/:statusId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId, statusId } = ctx.req.param();
    const { name, category, color, position } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    const updates = [];
    const params = [];
    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name.toUpperCase().replace(/\s+/g, '_'));
    }
    if (category !== undefined) {
      updates.push('category = ?');
      params.push(category);
    }
    if (color !== undefined) {
      updates.push('color = ?');
      params.push(color);
    }
    if (position !== undefined) {
      updates.push('position = ?');
      params.push(position);
    }

    if (updates.length > 0) {
      params.push(statusId, workflowId);
      db.prepare(`UPDATE workflow_statuses SET ${updates.join(', ')} WHERE id = ? AND workflow_id = ?`).run(...params);
    }

    return ctx.json({ success: true });
  })
  .put('/:workspaceId/:workflowId/reorder', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId } = ctx.req.param();
    const { statusIds = [] } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    statusIds.forEach((id, index) => {
      db.prepare('UPDATE workflow_statuses SET position = ? WHERE id = ? AND workflow_id = ?').run(index, id, workflowId);
    });

    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/:workflowId/statuses/:statusId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId, statusId } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    db.prepare('DELETE FROM workflow_statuses WHERE id = ? AND workflow_id = ?').run(statusId, workflowId);
    return ctx.json({ success: true });
  });

export default app;
