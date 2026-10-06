import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity, d1All, d1First, d1Run, getD1Database } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const slas = await d1All('SELECT * FROM sla_definitions WHERE workspace_id = ?', [workspaceId], d1);
    return ctx.json({ data: slas.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const { name, targetMinutes = 240, calendar = 'BUSINESS_HOURS', priority = 'HIGH', projectId = null } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!name) return ctx.json({ error: 'SLA name is required.' }, 400);

    const slaId = randomUUID();
    await d1Run(`
      INSERT INTO sla_definitions (id, workspace_id, project_id, name, target_minutes, calendar, priority, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `, [slaId, workspaceId, projectId || null, name, targetMinutes, calendar, priority], d1);

    return ctx.json({
      success: true,
      data: {
        id: slaId,
        name,
        targetMinutes,
        calendar,
        priority,
      },
    });
  })
  .get('/records/:taskId', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const records = await d1All(`
      SELECT r.*, d.name as sla_name, d.calendar
      FROM sla_records r
      JOIN sla_definitions d ON r.sla_id = d.id
      WHERE r.task_id = ?
    `, [taskId], d1);
    return ctx.json({ data: records.map(formatDoc) });
  });

export default app;
