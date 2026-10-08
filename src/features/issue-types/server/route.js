import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const seedDefaultIssueTypes = async (workspaceId, d1) => {
  const defaultIssueTypes = [
    { name: 'Epic', icon: 'zap', color: '#8B5CF6', description: 'A big body of work that can be broken down into stories and tasks' },
    { name: 'Story', icon: 'bookmark', color: '#10B981', description: 'A user requirement or functional enhancement' },
    { name: 'Task', icon: 'check-square', color: '#3B82F6', description: 'A general task that needs to be performed' },
    { name: 'Bug', icon: 'alert-circle', color: '#EF4444', description: 'A problem which impairs or prevents system functions' },
    { name: 'Sub-task', icon: 'list', color: '#6B7280', description: 'A piece of work required to complete another task' },
    { name: 'Improvement', icon: 'trending-up', color: '#F59E0B', description: 'An improvement to an existing feature' },
    { name: 'Change Request', icon: 'file-text', color: '#EC4899', description: 'A formal proposal for system alteration' },
  ];

  for (const it of defaultIssueTypes) {
    await d1Run(`
      INSERT INTO issue_types (id, workspace_id, name, icon, color, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [randomUUID(), workspaceId, it.name, it.icon, it.color, it.description], d1);
  }
};

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    let issueTypes = await d1All('SELECT * FROM issue_types WHERE workspace_id = ? ORDER BY created_at ASC', [workspaceId], d1);

    if (!issueTypes || issueTypes.length === 0) {
      await seedDefaultIssueTypes(workspaceId, d1);
      issueTypes = await d1All('SELECT * FROM issue_types WHERE workspace_id = ? ORDER BY created_at ASC', [workspaceId], d1);
    }

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
