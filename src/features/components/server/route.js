import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, logActivity } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/project/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const components = db.prepare(`
      SELECT c.*, u.name as lead_name, u.email as lead_email
      FROM project_components c
      LEFT JOIN users u ON c.lead_id = u.id
      WHERE c.project_id = ?
      ORDER BY c.name ASC
    `).all(projectId);

    return ctx.json({ data: components.map(formatDoc) });
  })
  .post('/project/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { name, description = '', leadId = null, defaultAssignee = 'PROJECT_LEAD' } = await ctx.req.json();

    if (!name) return ctx.json({ error: 'Component name is required.' }, 400);

    const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(projectId);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    if (!hasPermission({ workspaceId: project.workspace_id, userId: user.$id, permissionCode: 'PROJECT_UPDATE' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    const componentId = randomUUID();
    db.prepare(`
      INSERT INTO project_components (id, project_id, workspace_id, name, description, lead_id, default_assignee)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(componentId, projectId, project.workspace_id, name, description, leadId || null, defaultAssignee);

    logActivity({
      workspaceId: project.workspace_id,
      projectId,
      userId: user.$id,
      action: 'COMPONENT_CREATED',
      details: `Created component "${name}"`,
    });

    return ctx.json({
      success: true,
      data: {
        id: componentId,
        projectId,
        name,
        description,
        leadId,
        defaultAssignee,
      },
    });
  })
  .put('/:componentId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { componentId } = ctx.req.param();
    const { name, description, leadId, defaultAssignee } = await ctx.req.json();

    const component = db.prepare('SELECT * FROM project_components WHERE id = ?').get(componentId);
    if (!component) return ctx.json({ error: 'Component not found.' }, 404);

    if (!hasPermission({ workspaceId: component.workspace_id, userId: user.$id, permissionCode: 'PROJECT_UPDATE' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    db.prepare(`
      UPDATE project_components
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          lead_id = COALESCE(?, lead_id),
          default_assignee = COALESCE(?, default_assignee)
      WHERE id = ?
    `).run(name ?? null, description ?? null, leadId ?? null, defaultAssignee ?? null, componentId);

    return ctx.json({ success: true });
  })
  .delete('/:componentId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { componentId } = ctx.req.param();

    const component = db.prepare('SELECT * FROM project_components WHERE id = ?').get(componentId);
    if (!component) return ctx.json({ error: 'Component not found.' }, 404);

    if (!hasPermission({ workspaceId: component.workspace_id, userId: user.$id, permissionCode: 'PROJECT_UPDATE' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    db.prepare('DELETE FROM project_components WHERE id = ?').run(componentId);
    return ctx.json({ success: true });
  });

export default app;
