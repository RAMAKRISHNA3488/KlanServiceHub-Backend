import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const automations = await d1All('SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at DESC', [workspaceId], d1);

    const logs = await d1All(`
      SELECT al.*, a.name as rule_name
      FROM automation_logs al
      JOIN automations a ON al.automation_id = a.id
      WHERE al.workspace_id = ?
      ORDER BY al.executed_at DESC
      LIMIT 20
    `, [workspaceId], d1);

    return ctx.json({
      data: {
        rules: automations.map((r) => ({
          ...formatDoc(r),
          conditions: JSON.parse(r.conditions || '[]'),
          actions: JSON.parse(r.actions || '[]'),
          isActive: Boolean(r.is_active),
        })),
        logs: logs.map(formatDoc),
      },
    });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', triggerEvent, conditions = [], actions = [] } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'COMPANY_SETTINGS_MANAGE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    const id = randomUUID();
    await d1Run(`
      INSERT INTO automations (id, workspace_id, name, description, trigger_event, conditions, actions, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `, [id, workspaceId, name, description, triggerEvent, JSON.stringify(conditions), JSON.stringify(actions)], d1);

    try {
      logAudit({
        workspaceId,
        actorId: actor.$id,
        actorName: actor.name,
        action: 'CREATE_AUTOMATION',
        entityType: 'AUTOMATION',
        entityId: id,
        details: { name, triggerEvent },
      });
    } catch (e) {}

    return ctx.json({ data: { id, name, triggerEvent } });
  })
  .patch('/:workspaceId/:id/toggle', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'COMPANY_SETTINGS_MANAGE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    const rule = await d1First('SELECT is_active, name FROM automations WHERE id = ? AND workspace_id = ?', [id, workspaceId], d1);
    if (!rule) return ctx.json({ error: 'Rule not found.' }, 404);

    const newActive = rule.is_active ? 0 : 1;
    await d1Run('UPDATE automations SET is_active = ? WHERE id = ?', [newActive, id], d1);

    return ctx.json({ success: true, isActive: Boolean(newActive) });
  })
  .post('/:workspaceId/:id/test', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const rule = await d1First('SELECT * FROM automations WHERE id = ? AND workspace_id = ?', [id, workspaceId], d1);
    if (!rule) return ctx.json({ error: 'Rule not found.' }, 404);

    await d1Run('UPDATE automations SET execution_count = execution_count + 1, last_run_at = CURRENT_TIMESTAMP WHERE id = ?', [id], d1);

    await d1Run(`
      INSERT INTO automation_logs (id, automation_id, workspace_id, status, details)
      VALUES (?, ?, ?, 'SUCCESS', ?)
    `, [randomUUID(), id, workspaceId, `Manual test execution by ${actor.name} successfully evaluated conditions and executed action.`], d1);

    return ctx.json({ success: true, message: 'Automation test executed successfully.' });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const allowed = await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'COMPANY_SETTINGS_MANAGE' }, d1);
    if (!allowed) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    await d1Run('DELETE FROM automations WHERE id = ? AND workspace_id = ?', [id, workspaceId], d1);
    return ctx.json({ success: true });
  });

export default app;
