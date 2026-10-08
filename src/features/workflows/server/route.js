import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const seedDefaultWorkflow = async (workspaceId, d1) => {
  const workflowId = randomUUID();
  await d1Run(`
    INSERT INTO workflows (id, workspace_id, name, description, is_default)
    VALUES (?, ?, ?, ?, 1)
  `, [workflowId, workspaceId, 'Standard Software Development Workflow', 'Default enterprise workflow for software development lifecycle'], d1);

  const statuses = [
    { name: 'BACKLOG', category: 'TODO', color: '#94A3B8', position: 0 },
    { name: 'TODO', category: 'TODO', color: '#3B82F6', position: 1 },
    { name: 'IN_PROGRESS', category: 'IN_PROGRESS', color: '#F59E0B', position: 2 },
    { name: 'CODE_REVIEW', category: 'IN_PROGRESS', color: '#8B5CF6', position: 3 },
    { name: 'TESTING', category: 'IN_PROGRESS', color: '#06B6D4', position: 4 },
    { name: 'DONE', category: 'DONE', color: '#10B981', position: 5 },
  ];

  for (const s of statuses) {
    await d1Run(`
      INSERT INTO workflow_statuses (id, workflow_id, name, category, color, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [randomUUID(), workflowId, s.name, s.category, s.color, s.position], d1);
  }

  return workflowId;
};

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    let workflows = await d1All('SELECT * FROM workflows WHERE workspace_id = ?', [workspaceId], d1);

    if (!workflows || workflows.length === 0) {
      await seedDefaultWorkflow(workspaceId, d1);
      workflows = await d1All('SELECT * FROM workflows WHERE workspace_id = ?', [workspaceId], d1);
    }

    const workflowsWithDetails = [];
    for (const wf of workflows) {
      const statuses = await d1All(`
        SELECT * FROM workflow_statuses WHERE workflow_id = ? ORDER BY position ASC
      `, [wf.id], d1);

      const transitions = await d1All(`
        SELECT * FROM workflow_transitions WHERE workflow_id = ?
      `, [wf.id], d1);

      workflowsWithDetails.push({
        ...formatDoc(wf),
        statuses: statuses.map(formatDoc),
        transitions: transitions.map(formatDoc),
      });
    }

    return ctx.json({ data: workflowsWithDetails });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', statuses = [] } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    const workflowId = randomUUID();
    await d1Run(`
      INSERT INTO workflows (id, workspace_id, name, description, is_default)
      VALUES (?, ?, ?, ?, 0)
    `, [workflowId, workspaceId, name, description], d1);

    let pos = 0;
    for (const s of statuses) {
      await d1Run(`
        INSERT INTO workflow_statuses (id, workflow_id, name, category, color, position)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [randomUUID(), workflowId, s.name, s.category || 'IN_PROGRESS', s.color || '#3B82F6', pos++], d1);
    }

    try {
      logAudit({
        workspaceId,
        actorId: actor.$id,
        actorName: actor.name,
        action: 'CREATE_WORKFLOW',
        entityType: 'WORKFLOW',
        entityId: workflowId,
        details: { name, statusesCount: statuses.length },
      });
    } catch (e) {}

    return ctx.json({ data: { id: workflowId, name } });
  })
  .patch('/:workspaceId/:workflowId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId } = ctx.req.param();
    const { name, description } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' }, d1);
    if (!allowed) {
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
      await d1Run(`UPDATE workflows SET ${updates.join(', ')} WHERE id = ? AND workspace_id = ?`, params, d1);
    }

    try {
      logAudit({
        workspaceId,
        actorId: actor.$id,
        actorName: actor.name,
        action: 'UPDATE_WORKFLOW',
        entityType: 'WORKFLOW',
        entityId: workflowId,
        details: { name, description },
      });
    } catch (e) {}

    return ctx.json({ success: true });
  })
  .post('/:workspaceId/:workflowId/statuses', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId } = ctx.req.param();
    const { name, category = 'IN_PROGRESS', color = '#3B82F6' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    const maxRow = await d1First('SELECT MAX(position) as m FROM workflow_statuses WHERE workflow_id = ?', [workflowId], d1);
    const maxPos = maxRow?.m || 0;
    const statusId = randomUUID();

    await d1Run(`
      INSERT INTO workflow_statuses (id, workflow_id, name, category, color, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [statusId, workflowId, name.toUpperCase().replace(/\s+/g, '_'), category, color, maxPos + 1], d1);

    return ctx.json({ success: true, statusId });
  })
  .patch('/:workspaceId/:workflowId/statuses/:statusId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId, statusId } = ctx.req.param();
    const { name, category, color, position } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' }, d1);
    if (!allowed) {
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
      await d1Run(`UPDATE workflow_statuses SET ${updates.join(', ')} WHERE id = ? AND workflow_id = ?`, params, d1);
    }

    return ctx.json({ success: true });
  })
  .put('/:workspaceId/:workflowId/reorder', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId } = ctx.req.param();
    const { statusIds = [] } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    let index = 0;
    for (const id of statusIds) {
      await d1Run('UPDATE workflow_statuses SET position = ? WHERE id = ? AND workflow_id = ?', [index++, id, workflowId], d1);
    }

    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/:workflowId/statuses/:statusId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, workflowId, statusId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'WORKFLOW_MANAGE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden: Missing WORKFLOW_MANAGE permission.' }, 403);
    }

    await d1Run('DELETE FROM workflow_statuses WHERE id = ? AND workflow_id = ?', [statusId, workflowId], d1);
    return ctx.json({ success: true });
  });

export default app;
