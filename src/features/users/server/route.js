import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, createNotification, d1All, d1First, d1Run } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';
import { sendInvitationEmail } from '../../../lib/mail.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    const members = await d1All(`
      SELECT 
        m.id as member_id,
        m.role as legacy_role,
        m.status as member_status,
        m.created_at as joined_at,
        u.id as user_id,
        u.name,
        u.email,
        u.phone,
        u.job_title,
        u.department,
        u.avatar_url,
        u.status as user_status
      FROM members m
      JOIN users u ON m.user_id = u.id
      WHERE m.workspace_id = ?
      ORDER BY m.created_at ASC
    `, [workspaceId]);

    const workspace = await d1First('SELECT user_id FROM workspaces WHERE id = ?', [workspaceId]);

    const userList = await Promise.all(
      members.map(async (m) => {
        // Fetch assigned roles
        const roles = await d1All(`
          SELECT r.id, r.name, r.description, r.is_system
          FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.workspace_id = ? AND ur.user_id = ?
        `, [workspaceId, m.user_id]);

        // Fetch assigned teams
        const teams = await d1All(`
          SELECT t.id, t.name
          FROM team_members tm
          JOIN teams t ON tm.team_id = t.id
          WHERE t.workspace_id = ? AND tm.user_id = ?
        `, [workspaceId, m.user_id]);

        const isOwner = workspace && workspace.user_id === m.user_id;

        return {
          id: m.user_id,
          memberId: m.member_id,
          name: m.name,
          email: m.email,
          phone: m.phone || '',
          jobTitle: m.job_title || 'Team Member',
          department: m.department || 'Engineering',
          avatarUrl: m.avatar_url,
          status: m.member_status || 'ACTIVE',
          isOwner,
          roles: roles.length > 0 ? roles : [{ name: isOwner ? 'Company Owner' : m.legacy_role === 'ADMIN' ? 'Company Admin' : 'Developer' }],
          teams,
          joinedAt: m.joined_at,
        };
      })
    );

    return ctx.json({ data: userList });
  })
  .post('/:workspaceId/invite', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { email, name, roleName = 'Developer', jobTitle = 'Software Engineer', department = 'Engineering' } = await ctx.req.json();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'USER_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing USER_MANAGE permission.' }, 403);
    }

    if (!email) {
      return ctx.json({ error: 'Email is required.' }, 400);
    }

    const cleanEmail = email.toLowerCase().trim();
    let user = await d1First('SELECT * FROM users WHERE email = ?', [cleanEmail]);
    let userId;

    if (!user) {
      userId = randomUUID();
      const defaultHash = bcrypt.hashSync('Password@123', 10);
      await d1Run(`
        INSERT INTO users (id, name, email, password_hash, job_title, department)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, name || cleanEmail.split('@')[0], cleanEmail, defaultHash, jobTitle, department]);
    } else {
      userId = user.id;
    }

    // Check if already in workspace
    const existingMember = await d1First('SELECT id FROM members WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
    if (!existingMember) {
      const memberId = randomUUID();
      await d1Run(`
        INSERT INTO members (id, workspace_id, user_id, role, status)
        VALUES (?, ?, ?, 'MEMBER', 'ACTIVE')
      `, [memberId, workspaceId, userId]);
    }

    // Find or assign role
    const role = await d1First('SELECT id FROM roles WHERE workspace_id = ? AND name = ?', [workspaceId, roleName]);
    if (role) {
      await d1Run(`
        INSERT OR REPLACE INTO user_roles (id, workspace_id, user_id, role_id)
        VALUES (?, ?, ?, ?)
      `, [randomUUID(), workspaceId, userId, role.id]);
    }

    // Create invitation record with token
    const token = randomBytes(24).toString('hex');
    const inviteId = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const orgRole = roleName === 'Company Admin' ? 'COMPANY_ADMIN' : 'MEMBER';

    await d1Run(`
      INSERT INTO invitations (id, organization_id, email, invited_by, organization_role, token_hash, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `, [inviteId, workspaceId, cleanEmail, actor.$id, orgRole, token, expiresAt]);

    // Fetch workspace details for email
    const workspace = await d1First('SELECT name FROM workspaces WHERE id = ?', [workspaceId]);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const fullInviteUrl = `${frontendUrl}/invite/${token}`;

    // Send real invitation email via Gmail SMTP
    const mailResult = await sendInvitationEmail({
      to: cleanEmail,
      inviterName: actor.name || 'Company Owner',
      organizationName: workspace?.name || 'Company Workspace',
      role: roleName,
      inviteUrl: fullInviteUrl,
    });

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'INVITE_USER',
      entityType: 'USER',
      entityId: userId,
      details: `Invited user ${cleanEmail} with role ${roleName} (Email sent: ${mailResult.success})`,
    });

    createNotification({
      workspaceId,
      userId,
      title: 'Welcome to Organization',
      message: `You were invited to the company by ${actor.name} as ${roleName}.`,
    });

    return ctx.json({
      success: true,
      userId,
      emailSent: mailResult.success,
      inviteUrl: fullInviteUrl,
      message: mailResult.success
        ? `Invitation email sent to ${cleanEmail}`
        : `User added, but email delivery encountered an issue: ${mailResult.error || 'Check SMTP configuration'}`,
    });
  })
  .patch('/:workspaceId/:userId/status', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, userId } = ctx.req.param();
    const { status } = await ctx.req.json(); // ACTIVE, SUSPENDED, DEACTIVATED

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'USER_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing USER_MANAGE permission.' }, 403);
    }

    const workspace = await d1First('SELECT user_id FROM workspaces WHERE id = ?', [workspaceId]);
    if (workspace && workspace.user_id === userId) {
      return ctx.json({ error: 'Cannot change status of Company Owner.' }, 400);
    }

    await d1Run('UPDATE members SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND user_id = ?', [status, workspaceId, userId]);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CHANGE_USER_STATUS',
      entityType: 'USER',
      entityId: userId,
      details: `User status changed to ${status}`,
    });

    return ctx.json({ success: true, status });
  })
  .patch('/:workspaceId/:userId/role', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, userId } = ctx.req.param();
    const { roleId } = await ctx.req.json();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'ROLE_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing ROLE_MANAGE permission.' }, 403);
    }

    const workspace = await d1First('SELECT user_id FROM workspaces WHERE id = ?', [workspaceId]);
    if (workspace && workspace.user_id === userId) {
      return ctx.json({ error: 'Cannot reassign Company Owner role.' }, 400);
    }

    const role = await d1First('SELECT name FROM roles WHERE id = ? AND workspace_id = ?', [roleId, workspaceId]);
    if (!role) {
      return ctx.json({ error: 'Role not found.' }, 404);
    }

    // Delete existing roles and assign new one
    await d1Run('DELETE FROM user_roles WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
    await d1Run(`
      INSERT INTO user_roles (id, workspace_id, user_id, role_id)
      VALUES (?, ?, ?, ?)
    `, [randomUUID(), workspaceId, userId, roleId]);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CHANGE_USER_ROLE',
      entityType: 'USER',
      entityId: userId,
      details: `Assigned role ${role.name} to user`,
    });

    return ctx.json({ success: true, roleName: role.name });
  })
  .patch('/:workspaceId/:userId/profile', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, userId } = ctx.req.param();
    const { name, phone, job_title, department, avatar_url } = await ctx.req.json();

    if (actor.$id !== userId && !await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'USER_MANAGE' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    await d1Run(`
      UPDATE users 
      SET name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          job_title = COALESCE(?, job_title),
          department = COALESCE(?, department),
          avatar_url = COALESCE(?, avatar_url),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [name ?? null, phone ?? null, job_title ?? null, department ?? null, avatar_url ?? null, userId]);

    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/:userId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, userId } = ctx.req.param();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'USER_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing USER_MANAGE permission.' }, 403);
    }

    const workspace = await d1First('SELECT user_id FROM workspaces WHERE id = ?', [workspaceId]);
    if (workspace && workspace.user_id === userId) {
      return ctx.json({ error: 'Cannot remove Company Owner from workspace.' }, 400);
    }

    await d1Run('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
    await d1Run('DELETE FROM user_roles WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'REMOVE_USER',
      entityType: 'USER',
      entityId: userId,
      details: 'User removed from workspace',
    });

    return ctx.json({ success: true });
  })
  .post('/:workspaceId/:userId/reassign-and-remove', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, userId } = ctx.req.param();
    const { reassignToUserId } = await ctx.req.json();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'USER_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing USER_MANAGE permission.' }, 403);
    }

    const workspace = await d1First('SELECT user_id FROM workspaces WHERE id = ?', [workspaceId]);
    if (workspace && workspace.user_id === userId) {
      return ctx.json({ error: 'Cannot remove Company Owner from workspace.' }, 400);
    }

    const userMember = await d1First('SELECT id FROM members WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
    const targetMember = reassignToUserId
      ? await d1First('SELECT id FROM members WHERE workspace_id = ? AND user_id = ?', [workspaceId, reassignToUserId])
      : null;

    let reassignedCount = 0;
    if (userMember && targetMember) {
      await d1Run(`
        UPDATE tasks 
        SET assignee_id = ? 
        WHERE workspace_id = ? AND assignee_id = ?
      `, [targetMember.id, workspaceId, userMember.id]);
      reassignedCount = 1;
    }

    // Set member status to DEACTIVATED
    await d1Run("UPDATE members SET status = 'DEACTIVATED' WHERE workspace_id = ? AND user_id = ?", [workspaceId, userId]);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'DEACTIVATE_USER_WITH_REASSIGNMENT',
      entityType: 'USER',
      entityId: userId,
      details: `Deactivated user and reassigned ${reassignedCount} tasks to new assignee.`,
    });

    return ctx.json({ success: true, reassignedTasksCount: reassignedCount });
  });

export default app;
