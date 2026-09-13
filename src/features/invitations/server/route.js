import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, createNotification, ensureWorkspaceDefaults } from '../../../db.js';
import { broadcastWorkspaceEvent } from '../../../lib/events.js';
import { sendInvitationEmail } from '../../../lib/mail.js';
import { getFrontendUrl } from '../../../lib/config.js';

const app = new Hono()
  .get('/token/:token', async (ctx) => {
    const { token } = ctx.req.param();

    const invite = db.prepare(`
      SELECT i.*, w.name as organization_name, w.image_url as organization_image,
             u.name as inviter_name, u.email as inviter_email,
             p.name as project_name
      FROM invitations i
      JOIN workspaces w ON i.organization_id = w.id
      JOIN users u ON i.invited_by = u.id
      LEFT JOIN projects p ON i.project_id = p.id
      WHERE i.token_hash = ?
    `).get(token);

    if (!invite) {
      return ctx.json({ error: 'Invitation not found or invalid link.' }, 404);
    }

    if (new Date(invite.expires_at) < new Date() && invite.status === 'PENDING') {
      db.prepare("UPDATE invitations SET status = 'EXPIRED' WHERE id = ?").run(invite.id);
      invite.status = 'EXPIRED';
    }

    // Check if user already exists
    const existingUser = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(invite.email.toLowerCase());

    return ctx.json({
      data: {
        id: invite.id,
        email: invite.email,
        organizationId: invite.organization_id,
        organizationName: invite.organization_name,
        organizationImage: invite.organization_image,
        organizationRole: invite.organization_role,
        projectId: invite.project_id,
        projectName: invite.project_name,
        projectRole: invite.project_role,
        inviterName: invite.inviter_name,
        status: invite.status,
        expiresAt: invite.expires_at,
        userExists: !!existingUser,
      },
    });
  })
  .post('/token/:token/accept', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { token } = ctx.req.param();

    const invite = db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(token);
    if (!invite) {
      return ctx.json({ error: 'Invitation not found.' }, 404);
    }

    if (invite.status !== 'PENDING') {
      return ctx.json({ error: `This invitation is already ${invite.status.toLowerCase()}.` }, 400);
    }

    if (new Date(invite.expires_at) < new Date()) {
      db.prepare("UPDATE invitations SET status = 'EXPIRED' WHERE id = ?").run(invite.id);
      return ctx.json({ error: 'This invitation has expired.' }, 400);
    }

    // Create or activate organization membership
    const existingMember = db.prepare('SELECT id FROM members WHERE workspace_id = ? AND user_id = ?').get(invite.organization_id, user.$id);
    if (!existingMember) {
      const memberId = randomUUID();
      const memberRole = invite.organization_role === 'COMPANY_ADMIN' ? 'ADMIN' : 'MEMBER';

      db.prepare(`
        INSERT INTO members (id, workspace_id, user_id, role, status, organization_role)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?)
      `).run(memberId, invite.organization_id, user.$id, memberRole, invite.organization_role || 'MEMBER');

      // Assign system role in roles table
      const systemRole = db.prepare('SELECT id FROM roles WHERE workspace_id = ? AND name = ?').get(
        invite.organization_id,
        invite.organization_role === 'COMPANY_ADMIN' ? 'Company Admin' : (invite.organization_role === 'USER_ACCESS_ADMIN' ? 'User Access Admin' : 'Developer')
      );
      if (systemRole) {
        db.prepare(`
          INSERT OR IGNORE INTO user_roles (id, workspace_id, user_id, role_id)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), invite.organization_id, user.$id, systemRole.id);
      }
    }

    // If project assigned, add project membership
    if (invite.project_id) {
      const projectRole = db.prepare('SELECT id FROM roles WHERE workspace_id = ? AND name = ?').get(invite.organization_id, 'Developer');
      if (projectRole) {
        db.prepare(`
          INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_id)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), invite.project_id, user.$id, projectRole.id);
      }
    }

    // Mark invitation accepted
    db.prepare("UPDATE invitations SET status = 'ACCEPTED' WHERE id = ?").run(invite.id);

    // Update user onboarding status
    db.prepare("UPDATE users SET onboarding_status = 'ONBOARDING_COMPLETED' WHERE id = ?").run(user.$id);

    logAudit({
      workspaceId: invite.organization_id,
      actorId: user.$id,
      actorName: user.name,
      action: 'ACCEPT_INVITATION',
      entityType: 'USER',
      entityId: user.$id,
      details: { email: invite.email, role: invite.organization_role },
    });

    createNotification({
      workspaceId: invite.organization_id,
      userId: invite.invited_by,
      title: 'Invitation Accepted',
      message: `${user.name} (${invite.email}) joined your organization.`,
      link: `/workspaces/${invite.organization_id}/users-admin`,
      type: 'SYSTEM',
    });

    broadcastWorkspaceEvent(invite.organization_id, 'InvitationAcceptedEvent', {
      userId: user.$id,
      name: user.name,
      email: user.email,
      role: invite.organization_role,
    });

    return ctx.json({
      success: true,
      workspaceId: invite.organization_id,
      projectId: invite.project_id,
    });
  })
  .post('/token/:token/decline', async (ctx) => {
    const { token } = ctx.req.param();
    const invite = db.prepare('SELECT id, organization_id, invited_by FROM invitations WHERE token_hash = ?').get(token);
    if (!invite) return ctx.json({ error: 'Invitation not found.' }, 404);

    db.prepare("UPDATE invitations SET status = 'DECLINED' WHERE id = ?").run(invite.id);
    return ctx.json({ success: true });
  })
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const invites = db.prepare(`
      SELECT i.*, u.name as inviter_name, p.name as project_name
      FROM invitations i
      JOIN users u ON i.invited_by = u.id
      LEFT JOIN projects p ON i.project_id = p.id
      WHERE i.organization_id = ?
      ORDER BY i.created_at DESC
    `).all(workspaceId);

    return ctx.json({ data: invites.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const body = await ctx.req.json();

    // Support both batch invitations array: { invitations: [...] } and single invite: { email, ... }
    const items = Array.isArray(body.invitations)
      ? body.invitations
      : [body];

    const results = [];

    for (const item of items) {
      const email = item.email;
      if (!email) continue;

      const cleanEmail = email.toLowerCase().trim();
      const token = randomBytes(24).toString('hex');
      const inviteId = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
      const orgRole = item.organizationRole || 'MEMBER';
      const projId = item.projectId || null;
      const projRole = item.projectRole || 'MEMBER';

      db.prepare(`
        INSERT INTO invitations (id, organization_id, email, invited_by, organization_role, project_id, project_role, token_hash, status, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `).run(inviteId, workspaceId, cleanEmail, user.$id, orgRole, projId, projRole, token, expiresAt);

      logAudit({
        workspaceId,
        actorId: user.$id,
        actorName: user.name,
        action: 'INVITE_USER',
        entityType: 'INVITATION',
        entityId: inviteId,
        details: `Invited ${cleanEmail} as ${orgRole}`,
      });

      broadcastWorkspaceEvent(workspaceId, 'UserInvitedEvent', {
        email: cleanEmail,
        invitedBy: user.name,
        role: orgRole,
      });

      const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId);
      const project = projId ? db.prepare('SELECT name FROM projects WHERE id = ?').get(projId) : null;
      const frontendUrl = getFrontendUrl(ctx);
      const fullInviteUrl = `${frontendUrl}/invite/${token}`;

      await sendInvitationEmail({
        to: cleanEmail,
        inviterName: user.name || 'A team member',
        organizationName: workspace?.name || 'Workspace',
        projectName: project?.name,
        role: projRole || orgRole,
        inviteUrl: fullInviteUrl,
      });

      results.push({
        id: inviteId,
        email: cleanEmail,
        token,
        inviteUrl: `/invite/${token}`,
        expiresAt,
      });
    }

    if (results.length === 0) {
      return ctx.json({ error: 'Valid email is required.' }, 400);
    }

    return ctx.json({
      success: true,
      data: results.length === 1 ? results[0] : results,
      invitations: results,
    });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const { workspaceId, id } = ctx.req.param();
    db.prepare("UPDATE invitations SET status = 'REVOKED' WHERE id = ? AND organization_id = ?").run(id, workspaceId);
    return ctx.json({ success: true });
  });

export default app;
