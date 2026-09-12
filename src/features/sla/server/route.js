import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const slas = db.prepare('SELECT * FROM sla_definitions WHERE workspace_id = ?').all(workspaceId);
    return ctx.json({ data: slas.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const { name, targetMinutes = 240, calendar = 'BUSINESS_HOURS', priority = 'HIGH', projectId = null } = await ctx.req.json();

    if (!name) return ctx.json({ error: 'SLA name is required.' }, 400);

    const slaId = randomUUID();
    db.prepare(`
      INSERT INTO sla_definitions (id, workspace_id, project_id, name, target_minutes, calendar, priority, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).run(slaId, workspaceId, projectId || null, name, targetMinutes, calendar, priority);

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
    const records = db.prepare(`
      SELECT r.*, d.name as sla_name, d.calendar
      FROM sla_records r
      JOIN sla_definitions d ON r.sla_id = d.id
      WHERE r.task_id = ?
    `).all(taskId);
    return ctx.json({ data: records.map(formatDoc) });
  });

export default app;
