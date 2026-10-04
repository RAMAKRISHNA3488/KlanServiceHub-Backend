import { Hono } from 'hono';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    const policy = db.prepare('SELECT * FROM security_policies WHERE workspace_id = ?').get(workspaceId);

    // Fetch active user sessions belonging to workspace users
    const sessions = db.prepare(`
      SELECT 
        s.id, s.user_id, s.ip_address, s.user_agent, s.device_info, s.created_at, s.expires_at,
        u.name as user_name, u.email as user_email, u.avatar_url
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      JOIN members m ON m.user_id = u.id
      WHERE m.workspace_id = ?
      ORDER BY s.created_at DESC
      LIMIT 50
    `).all(workspaceId);

    return ctx.json({
      data: {
        policy: policy || {
          min_password_length: 8,
          require_special_char: 1,
          require_numbers: 1,
          session_timeout_mins: 1440,
          mfa_required: 0,
          ip_allowlist: '',
          sso_enabled: 0,
          sso_provider: '',
        },
        activeSessions: sessions.map(formatDoc),
      },
    });
  })
  .put('/:workspaceId/policy', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const body = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SECURITY_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing SECURITY_MANAGE permission.' }, 403);
    }

    const {
      minPasswordLength = 8,
      requireSpecialChar = true,
      requireNumbers = true,
      sessionTimeoutMins = 1440,
      mfaRequired = false,
      ipAllowlist = '',
      ssoEnabled = false,
      ssoProvider = '',
    } = body;

    db.prepare(`
      INSERT OR REPLACE INTO security_policies 
      (workspace_id, min_password_length, require_special_char, require_numbers, session_timeout_mins, mfa_required, ip_allowlist, sso_enabled, sso_provider, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      workspaceId,
      minPasswordLength,
      requireSpecialChar ? 1 : 0,
      requireNumbers ? 1 : 0,
      sessionTimeoutMins,
      mfaRequired ? 1 : 0,
      ipAllowlist,
      ssoEnabled ? 1 : 0,
      ssoProvider
    );

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_SECURITY_POLICY',
      entityType: 'SECURITY',
      entityId: workspaceId,
      details: { minPasswordLength, sessionTimeoutMins, mfaRequired, ssoEnabled },
    });

    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/sessions/:sessionId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, sessionId } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SECURITY_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing SECURITY_MANAGE permission.' }, 403);
    }

    const session = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return ctx.json({ error: 'Session not found.' }, 404);

    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'FORCE_LOGOUT_SESSION',
      entityType: 'SESSION',
      entityId: sessionId,
      details: `Revoked active session for user ${session.user_id}`,
    });

    return ctx.json({ success: true });
  });

export default app;
