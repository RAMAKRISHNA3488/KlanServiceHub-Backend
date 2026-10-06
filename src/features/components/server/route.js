import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logAudit, logActivity } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/project/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const components = await d1All(`
      SELECT c.*, u.name as lead_name, u.email as lead_email
      FROM project_components c
      LEFT JOIN users u ON c.lead_id = u.id
      WHERE c.project_id = ?
      ORDER BY c.name ASC
    `, [projectId], d1);

    return ctx.json({ data: components.map(formatDoc) });
  })
  .post('/project/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { name, description = '', leadId = null, defaultAssignee = 'PROJECT_LEAD' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!name) return ctx.json({ error: 'Component name is required.' }, 400);

    const project = await d1First('SELECT workspace_id FROM projects WHERE id = ?', [projectId], d1);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const allowed = await hasPermission({ workspaceId: project.workspace_id, userId: user.$id, permissionCode: 'PROJECT_UPDATE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    const componentId = randomUUID();
    await d1Run(`
      INSERT INTO project_components (id, project_id, workspace_id, name, description, lead_id, default_assignee)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [componentId, projectId, project.workspace_id, name, description, leadId || null, defaultAssignee], d1);

    try {
      logActivity({
        workspaceId: project.workspace_id,
        projectId,
        userId: user.$id,
        action: 'COMPONENT_CREATED',
        details: `Created component "${name}"`,
      });
    } catch (e) {}

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
    const d1 = ctx.env?.DB || getD1Database();

    const component = await d1First('SELECT * FROM project_components WHERE id = ?', [componentId], d1);
    if (!component) return ctx.json({ error: 'Component not found.' }, 404);

    const allowed = await hasPermission({ workspaceId: component.workspace_id, userId: user.$id, permissionCode: 'PROJECT_UPDATE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    await d1Run(`
      UPDATE project_components
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          lead_id = COALESCE(?, lead_id),
          default_assignee = COALESCE(?, default_assignee)
      WHERE id = ?
    `, [name ?? null, description ?? null, leadId ?? null, defaultAssignee ?? null, componentId], d1);

    return ctx.json({ success: true });
  })
  .delete('/:componentId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { componentId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const component = await d1First('SELECT * FROM project_components WHERE id = ?', [componentId], d1);
    if (!component) return ctx.json({ error: 'Component not found.' }, 404);

    const allowed = await hasPermission({ workspaceId: component.workspace_id, userId: user.$id, permissionCode: 'PROJECT_UPDATE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    await d1Run('DELETE FROM project_components WHERE id = ?', [componentId], d1);
    return ctx.json({ success: true });
  });

export default app;
