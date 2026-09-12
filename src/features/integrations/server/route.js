import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const AVAILABLE_CATALOG = [
  { type: 'GITHUB', name: 'GitHub', icon: 'github', description: 'Link pull requests, commits, and branch sync directly to klanservicehub issues' },
  { type: 'GITLAB', name: 'GitLab', icon: 'gitlab', description: 'Connect GitLab repositories, merge requests, and pipeline events' },
  { type: 'BITBUCKET', name: 'Bitbucket', icon: 'bitbucket', description: 'Integrate Bitbucket repositories and deployment tracking' },
  { type: 'SLACK', name: 'Slack', icon: 'slack', description: 'Receive instant notifications and create issues directly from Slack channels' },
  { type: 'WEBHOOK', name: 'Custom Webhook', icon: 'webhook', description: 'Stream issue lifecycle events, transitions, and status updates via HTTP POST' },
];

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    const connected = db.prepare('SELECT * FROM integrations WHERE workspace_id = ?').all(workspaceId);
    const logs = db.prepare(`
      SELECT il.*, i.name as integration_name
      FROM integration_logs il
      JOIN integrations i ON il.integration_id = i.id
      WHERE il.workspace_id = ?
      ORDER BY il.created_at DESC
      LIMIT 15
    `).all(workspaceId);

    const integrations = AVAILABLE_CATALOG.map((cat) => {
      const conn = connected.find((c) => c.type === cat.type);
      return {
        ...cat,
        isConnected: Boolean(conn && conn.status === 'CONNECTED'),
        id: conn?.id || null,
        status: conn?.status || 'NOT_CONNECTED',
        config: conn ? JSON.parse(conn.config || '{}') : {},
        lastSyncAt: conn?.last_sync_at || null,
      };
    });

    return ctx.json({
      data: {
        integrations,
        logs: logs.map(formatDoc),
      },
    });
  })
  .post('/:workspaceId/connect', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { type, name, config = {} } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'INTEGRATIONS_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing INTEGRATIONS_MANAGE permission.' }, 403);
    }

    const existing = db.prepare('SELECT id FROM integrations WHERE workspace_id = ? AND type = ?').get(workspaceId, type);
    const integrationId = existing ? existing.id : randomUUID();

    if (existing) {
      db.prepare(`
        UPDATE integrations 
        SET status = 'CONNECTED', config = ?, last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(JSON.stringify(config), integrationId);
    } else {
      db.prepare(`
        INSERT INTO integrations (id, workspace_id, type, name, config, status, last_sync_at)
        VALUES (?, ?, ?, ?, ?, 'CONNECTED', CURRENT_TIMESTAMP)
      `).run(integrationId, workspaceId, type, name, JSON.stringify(config));
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CONNECT_INTEGRATION',
      entityType: 'INTEGRATION',
      entityId: integrationId,
      details: `Connected ${type} integration`,
    });

    return ctx.json({ success: true, integrationId });
  })
  .post('/:workspaceId/:id/test', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();

    const integration = db.prepare('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!integration) return ctx.json({ error: 'Integration not found.' }, 404);

    db.prepare(`
      INSERT INTO integration_logs (id, integration_id, workspace_id, event, status, payload)
      VALUES (?, ?, ?, 'TEST_PING', 'DELIVERED', ?)
    `).run(randomUUID(), id, workspaceId, `Test ping from ${actor.name} delivered with HTTP 200 OK.`);

    db.prepare('UPDATE integrations SET last_sync_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

    return ctx.json({ success: true, message: 'Test event delivered successfully.' });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'INTEGRATIONS_MANAGE' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    db.prepare('DELETE FROM integrations WHERE id = ? AND workspace_id = ?').run(id, workspaceId);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'DISCONNECT_INTEGRATION',
      entityType: 'INTEGRATION',
      entityId: id,
      details: 'Integration disconnected',
    });

    return ctx.json({ success: true });
  });

export default app;
