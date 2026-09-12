import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const fields = db.prepare('SELECT * FROM custom_fields WHERE workspace_id = ? ORDER BY name ASC').all(workspaceId);
    return ctx.json({ data: fields.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const {
      name,
      description = '',
      fieldType = 'TEXT',
      required = 0,
      defaultValue = '',
      options = [],
    } = await ctx.req.json();

    if (!name) return ctx.json({ error: 'Field name is required.' }, 400);

    const fieldId = randomUUID();
    db.prepare(`
      INSERT INTO custom_fields (id, workspace_id, name, description, field_type, required, default_value, options, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fieldId,
      workspaceId,
      name,
      description,
      fieldType,
      required ? 1 : 0,
      defaultValue,
      JSON.stringify(options),
      user.$id
    );

    return ctx.json({
      success: true,
      data: {
        id: fieldId,
        name,
        fieldType,
        required,
      },
    });
  })
  .get('/values/:taskId', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const values = db.prepare(`
      SELECT v.*, f.name as field_name, f.field_type, f.options
      FROM task_custom_field_values v
      JOIN custom_fields f ON v.custom_field_id = f.id
      WHERE v.task_id = ?
    `).all(taskId);
    return ctx.json({ data: values.map(formatDoc) });
  })
  .post('/values/:taskId', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const { customFieldId, fieldValue } = await ctx.req.json();

    if (!customFieldId) return ctx.json({ error: 'customFieldId is required.' }, 400);

    db.prepare(`
      INSERT INTO task_custom_field_values (task_id, custom_field_id, field_value)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id, custom_field_id) DO UPDATE SET field_value = excluded.field_value
    `).run(taskId, customFieldId, typeof fieldValue === 'object' ? JSON.stringify(fieldValue) : String(fieldValue));

    return ctx.json({ success: true, taskId, customFieldId });
  });

export default app;
