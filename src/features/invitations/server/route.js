import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, createNotification, ensureWorkspaceDefaults, d1All, d1First, d1Run } from '../../../db.js';
import { broadcastWorkspaceEvent } from '../../../lib/events.js';
import { sendInvitationEmail } from '../../../lib/mail.js';

const app = new Hono()
  .get('/token/:token', async (ctx) => {
    const { token } = ctx.req.param();

    const invite = await d1First(`
      SELECT i.*, w.name as organization_name, w.image_url as organization_image,
             u.name as inviter_name, u.email as inviter_email,
             p.name as project_name
      FROM invitations i
      JOIN workspaces w ON i.organization_id = w.id
      JOIN users u ON i.invited_by = u.id
      LEFT JOIN projects p ON i.project_id = p.id
      WHERE i.token_hash = ?
    `, [token]);

    if (!invite) {
      return ctx.json({ error: 'Invitation not found or invalid link.' }, 404);
    }

    if (new Date(invite.expires_at) < new Date() && invite.status === 'PENDING') {
      await d1Run("UPDATE invitations SET status = 'EXPIRED' WHERE id = ?", [invite.id]);
      invite.status = 'EXPIRED';
    }

    // Check if user already exists
    const existingUser = await d1First('SELECT id, name, email FROM users WHERE email = ?', [invite.email.toLowerCase()]);

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

    const invite = await d1First('SELECT * FROM invitations WHERE token_hash = ?', [token]);
    if (!invite) {
      return ctx.json({ error: 'Invitation not found.' }, 404);
    }

    if (invite.status !== 'PENDING') {
      return ctx.json({ error: `This invitation is already ${invite.status.toLowerCase()}.` }, 400);
    }

    if (new Date(invite.expires_at) < new Date()) {
      await d1Run("UPDATE invitations SET status = 'EXPIRED' WHERE id = ?", [invite.id]);
      return ctx.json({ error: 'This invitation has expired.' }, 400);
    }

    // Create or activate organization membership
    const existingMember = await d1First('SELECT id FROM members WHERE workspace_id = ? AND user_id = ?', [invite.organization_id, user.$id]);
    if (!existingMember) {
      const memberId = randomUUID();
      const memberRole = invite.organization_role === 'COMPANY_ADMIN' ? 'ADMIN' : 'MEMBER';

      await d1Run(`
        INSERT INTO members (id, workspace_id, user_id, role, status, organization_role)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?)
      `, [memberId, invite.organization_id, user.$id, memberRole, invite.organization_role || 'MEMBER']);

      // Assign system role in roles table
      const systemRole = await d1First('SELECT id FROM roles WHERE workspace_id = ? AND name = ?', [
        invite.organization_id,
        invite.organization_role === 'COMPANY_ADMIN' ? 'Company Admin' : (invite.organization_role === 'USER_ACCESS_ADMIN' ? 'User Access Admin' : 'Developer')
      ]);
      if (systemRole) {
        await d1Run(`
          INSERT OR IGNORE INTO user_roles (id, workspace_id, user_id, role_id)
          VALUES (?, ?, ?, ?)
        `, [randomUUID(), invite.organization_id, user.$id, systemRole.id]);
      }
    }

    // If project assigned, add project membership
    if (invite.project_id) {
      const projectRole = await d1First('SELECT id FROM roles WHERE workspace_id = ? AND name = ?', [invite.organization_id, 'Developer']);
      if (projectRole) {
        await d1Run(`
          INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_id)
          VALUES (?, ?, ?, ?)
        `, [randomUUID(), invite.project_id, user.$id, projectRole.id]);
      }
    }

    // Mark invitation accepted
    await d1Run("UPDATE invitations SET status = 'ACCEPTED' WHERE id = ?", [invite.id]);

    // Update user onboarding status
    await d1Run("UPDATE users SET onboarding_status = 'ONBOARDING_COMPLETED' WHERE id = ?", [user.$id]);

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
    const invite = await d1First('SELECT id, organization_id, invited_by FROM invitations WHERE token_hash = ?', [token]);
    if (!invite) return ctx.json({ error: 'Invitation not found.' }, 404);

    await d1Run("UPDATE invitations SET status = 'DECLINED' WHERE id = ?", [invite.id]);
    return ctx.json({ success: true });
  })
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const invites = await d1All(`
      SELECT i.*, u.name as inviter_name, p.name as project_name
      FROM invitations i
      JOIN users u ON i.invited_by = u.id
      LEFT JOIN projects p ON i.project_id = p.id
      WHERE i.organization_id = ?
      ORDER BY i.created_at DESC
    `, [workspaceId]);

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
      const tempPassword = (item.password && String(item.password).trim().length >= 6)
        ? String(item.password).trim()
        : `Klan#${randomBytes(3).toString('hex').toUpperCase()}`;
      const passwordHash = bcrypt.hashSync(tempPassword, 10);

      // Ensure user exists in users table with credentials
      let userRecord = await d1First('SELECT * FROM users WHERE email = ?', [cleanEmail], ctx.env?.DB);
      let recipientUserId;

      if (!userRecord) {
        recipientUserId = randomUUID();
        await d1Run(`
          INSERT INTO users (id, name, email, password_hash, status, onboarding_status)
          VALUES (?, ?, ?, ?, 'ACTIVE', 'COMPLETED')
        `, [recipientUserId, item.name || cleanEmail.split('@')[0], cleanEmail, passwordHash], ctx.env?.DB);
      } else {
        recipientUserId = userRecord.id;
        if (!userRecord.password_hash || item.password) {
          await d1Run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, recipientUserId], ctx.env?.DB);
        }
      }

      // Ensure membership record exists
      const existingMember = await d1First('SELECT id FROM members WHERE workspace_id = ? AND user_id = ?', [workspaceId, recipientUserId], ctx.env?.DB);
      if (!existingMember) {
        await d1Run(`
          INSERT INTO members (id, workspace_id, user_id, role, status)
          VALUES (?, ?, ?, ?, 'ACTIVE')
        `, [randomUUID(), workspaceId, recipientUserId, item.organizationRole || 'MEMBER'], ctx.env?.DB);
      }

      const token = randomBytes(24).toString('hex');
      const inviteId = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
      const orgRole = item.organizationRole || 'MEMBER';
      const projId = item.projectId || null;
      const projRole = item.projectRole || 'MEMBER';

      await d1Run(`
        INSERT INTO invitations (id, organization_id, email, invited_by, organization_role, project_id, project_role, token_hash, status, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `, [inviteId, workspaceId, cleanEmail, user.$id, orgRole, projId, projRole, token, expiresAt], ctx.env?.DB);

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

      const workspace = await d1First('SELECT name FROM workspaces WHERE id = ?', [workspaceId], ctx.env?.DB);
      const project = projId ? await d1First('SELECT name FROM projects WHERE id = ?', [projId], ctx.env?.DB) : null;
      const frontendUrl = ctx.env?.FRONTEND_URL || process.env.FRONTEND_URL || 'https://klanservicehub-frontend.klanservicehub.workers.dev';
      const fullInviteUrl = `${frontendUrl}/invite/${token}`;
      const loginUrl = `${frontendUrl}/sign-in`;

      await sendInvitationEmail({
        to: cleanEmail,
        inviterName: user.name || 'A team member',
        organizationName: workspace?.name || 'Workspace',
        projectName: project?.name,
        role: projRole || orgRole,
        inviteUrl: fullInviteUrl,
        password: tempPassword,
        loginUrl,
        env: ctx.env,
      });

      results.push({
        id: inviteId,
        email: cleanEmail,
        token,
        inviteUrl: `/invite/${token}`,
        fullInviteUrl,
        tempPassword,
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
  .post('/:workspaceId/:id/resend', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();

    const invite = await d1First('SELECT * FROM invitations WHERE id = ? AND organization_id = ?', [id, workspaceId], ctx.env?.DB);
    if (!invite) {
      return ctx.json({ error: 'Invitation not found.' }, 404);
    }

    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await d1Run("UPDATE invitations SET token_hash = ?, expires_at = ?, status = 'PENDING' WHERE id = ?", [token, expiresAt, id], ctx.env?.DB);

    const workspace = await d1First('SELECT name FROM workspaces WHERE id = ?', [workspaceId], ctx.env?.DB);
    const frontendUrl = ctx.env?.FRONTEND_URL || process.env.FRONTEND_URL || 'https://klanservicehub-frontend.klanservicehub.workers.dev';
    const fullInviteUrl = `${frontendUrl}/invite/${token}`;

    const mailResult = await sendInvitationEmail({
      to: invite.email,
      inviterName: user.name || 'A team member',
      organizationName: workspace?.name || 'Workspace',
      role: invite.project_role || invite.organization_role || 'Member',
      inviteUrl: fullInviteUrl,
      env: ctx.env,
    });

    return ctx.json({
      success: true,
      message: mailResult.success
        ? `Invitation re-sent successfully to ${invite.email}`
        : `Invitation updated, but email delivery status: ${mailResult.error || 'simulated'}`,
      emailSent: mailResult.success,
      inviteUrl: fullInviteUrl,
    });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const { workspaceId, id } = ctx.req.param();
    await d1Run("UPDATE invitations SET status = 'REVOKED' WHERE id = ?", [id], ctx.env?.DB);
    return ctx.json({ success: true });
  });

export default app;
