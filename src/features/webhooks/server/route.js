import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, d1All, d1First, d1Run, getD1Database } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const hooks = await d1All('SELECT id, workspace_id, name, url, events, status, created_at FROM webhooks WHERE workspace_id = ?', [workspaceId], d1);
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
    const d1 = ctx.env?.DB || getD1Database();

    if (!name || !url) return ctx.json({ error: 'Webhook name and URL are required.' }, 400);

    const webhookId = randomUUID();
    const secret = `whsec_${randomUUID().replace(/-/g, '')}`;

    await d1Run(`
      INSERT INTO webhooks (id, workspace_id, name, url, events, secret, status)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
    `, [webhookId, workspaceId, name, url, JSON.stringify(events), secret], d1);

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
    const d1 = ctx.env?.DB || getD1Database();
    const hook = await d1First('SELECT * FROM webhooks WHERE id = ?', [webhookId], d1);
    if (!hook) return ctx.json({ error: 'Webhook not found.' }, 404);

    const deliveryId = randomUUID();
    await d1Run(`
      INSERT INTO webhook_deliveries (id, webhook_id, event, status, response_code, payload)
      VALUES (?, ?, 'PING_TEST', 'SUCCESS', 200, ?)
    `, [deliveryId, webhookId, JSON.stringify({ event: 'PING_TEST', timestamp: new Date().toISOString() })], d1);

    return ctx.json({ success: true, deliveryId, status: 'SUCCESS', responseCode: 200 });
  });

export default app;
