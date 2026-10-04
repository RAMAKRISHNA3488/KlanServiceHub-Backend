import { Hono } from 'hono';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    const tokens = db.prepare(`
      SELECT 
        t.id, t.name, t.token_prefix, t.scopes, t.expires_at, t.last_used_at, t.created_at,
        u.name as creator_name, u.email as creator_email
      FROM api_tokens t
      JOIN users u ON t.user_id = u.id
      WHERE t.workspace_id = ?
      ORDER BY t.created_at DESC
    `).all(workspaceId);

    return ctx.json({
      data: tokens.map((t) => ({
        ...formatDoc(t),
        scopes: JSON.parse(t.scopes || '["*"]'),
      })),
    });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, scopes = ['*'], expiresDays = 90 } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SECURITY_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing SECURITY_MANAGE permission.' }, 403);
    }

    if (!name) {
      return ctx.json({ error: 'Token name is required.' }, 400);
    }

    const secretRandom = randomBytes(24).toString('hex');
    const cleartextToken = `klanservicehub_live_${secretRandom}`;
    const tokenPrefix = `klanservicehub_live_${secretRandom.substring(0, 6)}...`;
    const tokenHash = createHash('sha256').update(cleartextToken).digest('hex');

    const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString();
    const id = randomUUID();

    db.prepare(`
      INSERT INTO api_tokens (id, workspace_id, user_id, name, token_prefix, token_hash, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, workspaceId, actor.$id, name, tokenPrefix, tokenHash, JSON.stringify(scopes), expiresAt);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_API_TOKEN',
      entityType: 'API_TOKEN',
      entityId: id,
      details: { name, tokenPrefix, scopes },
    });

    // Return cleartextToken ONCE to the user
    return ctx.json({
      data: {
        id,
        name,
        tokenPrefix,
        cleartextToken,
        scopes,
        expiresAt,
      },
    });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SECURITY_MANAGE' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    const token = db.prepare('SELECT name FROM api_tokens WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!token) return ctx.json({ error: 'Token not found.' }, 404);

    db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'REVOKE_API_TOKEN',
      entityType: 'API_TOKEN',
      entityId: id,
      details: `Revoked API token ${token.name}`,
    });

    return ctx.json({ success: true });
  });

export default app;
