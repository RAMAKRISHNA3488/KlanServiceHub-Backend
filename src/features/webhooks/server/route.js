import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const hooks = db.prepare('SELECT id, workspace_id, name, url, events, status, created_at FROM webhooks WHERE workspace_id = ?').all(workspaceId);
    return ctx.json({
      data: hooks.map((h) => ({
        ...formatDoc(h),
        events: JSON.parse(h.events || '[]'),
      })),
    });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const { name, url, events = ['ISSUE_CREATED', 'ISSUE_UPDATED', 'ISSUE_STATUS_CHANGED'] } = await ctx.req.json();

    if (!name || !url) return ctx.json({ error: 'Webhook name and URL are required.' }, 400);

    const webhookId = randomUUID();
    const secret = `whsec_${randomUUID().replace(/-/g, '')}`;

    db.prepare(`
      INSERT INTO webhooks (id, workspace_id, name, url, events, secret, status)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).run(webhookId, workspaceId, name, url, JSON.stringify(events), secret);

    return ctx.json({
      success: true,
      data: {
        id: webhookId,
        name,
        url,
        events,
        secret,
      },
    });
  })
  .post('/:webhookId/test', sessionMiddleware, async (ctx) => {
    const { webhookId } = ctx.req.param();
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId);
    if (!hook) return ctx.json({ error: 'Webhook not found.' }, 404);

    const deliveryId = randomUUID();
    db.prepare(`
      INSERT INTO webhook_deliveries (id, webhook_id, event, status, response_code, payload)
      VALUES (?, ?, 'PING_TEST', 'SUCCESS', 200, '{"event":"PING_TEST","timestamp":"${new Date().toISOString()}"}')
    `).run(deliveryId, webhookId);

    return ctx.json({ success: true, deliveryId, status: 'SUCCESS', responseCode: 200 });
  });

export default app;
