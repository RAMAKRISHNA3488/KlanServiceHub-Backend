import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity, d1All, d1First, d1Run, getD1Database } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const fields = await d1All('SELECT * FROM custom_fields WHERE workspace_id = ? ORDER BY name ASC', [workspaceId], d1);
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
    const d1 = ctx.env?.DB || getD1Database();

    if (!name) return ctx.json({ error: 'Field name is required.' }, 400);

    const fieldId = randomUUID();
    await d1Run(`
      INSERT INTO custom_fields (id, workspace_id, name, description, field_type, required, default_value, options, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      fieldId,
      workspaceId,
      name,
      description,
      fieldType,
      required ? 1 : 0,
      defaultValue,
      JSON.stringify(options),
      user.$id
    ], d1);

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
    const d1 = ctx.env?.DB || getD1Database();
    const values = await d1All(`
      SELECT v.*, f.name as field_name, f.field_type, f.options
      FROM task_custom_field_values v
      JOIN custom_fields f ON v.custom_field_id = f.id
      WHERE v.task_id = ?
    `, [taskId], d1);
    return ctx.json({ data: values.map(formatDoc) });
  })
  .post('/values/:taskId', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const { customFieldId, fieldValue } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!customFieldId) return ctx.json({ error: 'customFieldId is required.' }, 400);

    await d1Run(`
      INSERT INTO task_custom_field_values (task_id, custom_field_id, field_value)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id, custom_field_id) DO UPDATE SET field_value = excluded.field_value
    `, [taskId, customFieldId, typeof fieldValue === 'object' ? JSON.stringify(fieldValue) : String(fieldValue)], d1);

    return ctx.json({ success: true, taskId, customFieldId });
  });

export default app;
