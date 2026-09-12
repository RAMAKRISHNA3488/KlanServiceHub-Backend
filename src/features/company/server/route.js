import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, ensureWorkspaceDefaults } from '../../../db.js';
import { hasPermission, getUserPermissions } from '../../../lib/permissions.js';

const app = new Hono()
  .post('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { name, domainSlug = '', industry = '', companySize = '', country = 'India' } = await ctx.req.json();

    if (!name) return ctx.json({ error: 'Company name is required.' }, 400);

    const workspaceId = randomUUID();
    const inviteCode = randomUUID().substring(0, 8).toUpperCase();
    const slug = domainSlug || name.toLowerCase().replace(/[^a-z0-9]/g, '-');

    db.prepare(`
      INSERT INTO workspaces (id, name, user_id, invite_code, domain_slug, industry, company_size, country, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).run(workspaceId, name, user.$id, inviteCode, slug, industry, companySize, country);

    db.prepare(`
      INSERT INTO members (id, workspace_id, user_id, role, status, organization_role)
      VALUES (?, ?, ?, 'ADMIN', 'ACTIVE', 'COMPANY_OWNER')
    `).run(randomUUID(), workspaceId, user.$id);

    ensureWorkspaceDefaults(workspaceId, user.$id);

    // Update user's onboarding status
    db.prepare("UPDATE users SET onboarding_status = 'ORGANIZATION_CREATED' WHERE id = ?").run(user.$id);

    logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'CREATE_ORGANIZATION',
      entityType: 'COMPANY',
      entityId: workspaceId,
      details: { name, slug, industry },
    });

    return ctx.json({
      data: {
        id: workspaceId,
        $id: workspaceId,
        name,
        domainSlug: slug,
        inviteCode,
      },
    });
  })
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    ensureWorkspaceDefaults(workspaceId, user.$id);

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      return ctx.json({ error: 'Company not found.' }, 404);
    }

    const member = db.prepare('SELECT * FROM members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, user.$id);
    if (!member && workspace.user_id !== user.$id) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    const owner = db.prepare('SELECT id, name, email, avatar_url FROM users WHERE id = ?').get(workspace.user_id);
    const permissions = getUserPermissions({ workspaceId, userId: user.$id });
    const isOwner = workspace.user_id === user.$id;

    // Company Stats
    const userCount = db.prepare('SELECT COUNT(*) as c FROM members WHERE workspace_id = ?').get(workspaceId).c;
    const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects WHERE workspace_id = ?').get(workspaceId).c;
    const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?').get(workspaceId).c;
    const teamCount = db.prepare('SELECT COUNT(*) as c FROM teams WHERE workspace_id = ?').get(workspaceId).c;

    const subscription = db.prepare('SELECT * FROM subscriptions WHERE workspace_id = ?').get(workspaceId);

    return ctx.json({
      data: {
        ...formatDoc(workspace),
        isOwner,
        owner,
        permissions,
        stats: {
          userCount,
          projectCount,
          taskCount,
          teamCount,
        },
        subscription: subscription ? formatDoc(subscription) : null,
      },
    });
  })
  .get('/:workspaceId/permissions', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    const workspace = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) return ctx.json({ error: 'Company not found.' }, 404);

    const isOwner = workspace.user_id === user.$id;
    const permissions = getUserPermissions({ workspaceId, userId: user.$id });

    return ctx.json({
      isOwner,
      permissions,
      allPermissions: db.prepare('SELECT * FROM permissions ORDER BY category, code').all(),
    });
  })
  .patch('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const body = await ctx.req.json();

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      return ctx.json({ error: 'Company not found.' }, 404);
    }

    if (!hasPermission({ workspaceId, userId: user.$id, permissionCode: 'COMPANY_SETTINGS_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing COMPANY_SETTINGS_MANAGE permission.' }, 403);
    }

    const {
      name = workspace.name,
      description = workspace.description,
      website = workspace.website,
      email = workspace.email,
      phone = workspace.phone,
      address = workspace.address,
      timezone = workspace.timezone,
      language = workspace.language,
      date_format = workspace.date_format,
      currency = workspace.currency,
      image_url = workspace.image_url,
      industry = workspace.industry,
      company_size = workspace.company_size,
      country = workspace.country,
    } = body;

    db.prepare(`
      UPDATE workspaces 
      SET name = ?, description = ?, website = ?, email = ?, phone = ?, 
          address = ?, timezone = ?, language = ?, date_format = ?, currency = ?, 
          image_url = ?, industry = ?, company_size = ?, country = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, description, website, email, phone, address, timezone, language, date_format, currency, image_url, industry, company_size, country, workspaceId);

    logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'UPDATE_COMPANY_PROFILE',
      entityType: 'COMPANY',
      entityId: workspaceId,
      details: { name, website, email, timezone, language },
    });

    const updated = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    return ctx.json({ data: formatDoc(updated) });
  })
  .post('/:workspaceId/transfer-ownership', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { newOwnerUserId, password } = await ctx.req.json();

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) return ctx.json({ error: 'Company not found.' }, 404);

    if (workspace.user_id !== user.$id) {
      return ctx.json({ error: 'Forbidden: Only current Company Owner can transfer ownership.' }, 403);
    }

    const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.$id);
    if (!password || !bcrypt.compareSync(password, currentUser.password_hash)) {
      return ctx.json({ error: 'Invalid password. Please re-enter your password to authorize transfer.' }, 400);
    }

    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(newOwnerUserId);
    if (!targetUser) return ctx.json({ error: 'Target user not found.' }, 404);

    // 1. Update workspace owner
    db.prepare('UPDATE workspaces SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newOwnerUserId, workspaceId);

    // 2. Update new owner role to COMPANY_OWNER
    db.prepare("UPDATE members SET organization_role = 'COMPANY_OWNER', role = 'ADMIN' WHERE workspace_id = ? AND user_id = ?").run(workspaceId, newOwnerUserId);

    // 3. Update old owner role to COMPANY_ADMIN
    db.prepare("UPDATE members SET organization_role = 'COMPANY_ADMIN', role = 'ADMIN' WHERE workspace_id = ? AND user_id = ?").run(workspaceId, user.$id);

    logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'TRANSFER_COMPANY_OWNERSHIP',
      entityType: 'COMPANY',
      entityId: workspaceId,
      details: `Transferred ownership from ${user.name} to ${targetUser.name} (${targetUser.email})`,
    });

    return ctx.json({ success: true, newOwnerId: newOwnerUserId, newOwnerName: targetUser.name });
  })
  .patch('/:workspaceId/status', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { status } = await ctx.req.json();

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) return ctx.json({ error: 'Company not found.' }, 404);

    if (workspace.user_id !== user.$id) {
      return ctx.json({ error: 'Forbidden: Only the Company Owner can change company status.' }, 403);
    }

    db.prepare('UPDATE workspaces SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, workspaceId);

    logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'UPDATE_COMPANY_STATUS',
      entityType: 'COMPANY',
      entityId: workspaceId,
      details: `Company status changed to ${status}`,
    });

    return ctx.json({ success: true, status });
  })
  .delete('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) return ctx.json({ error: 'Company not found.' }, 404);

    const member = db.prepare('SELECT * FROM members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, user.$id);
    const isOwner = workspace.user_id === user.$id;
    const isAdmin = member && (
      member.role === 'ADMIN' ||
      member.organization_role === 'COMPANY_OWNER' ||
      member.organization_role === 'COMPANY_ADMIN'
    );

    if (!isOwner && !isAdmin) {
      return ctx.json({ error: 'Forbidden: Only an Admin or Company Owner can delete this company.' }, 403);
    }

    const tablesToClean = [
      'tasks', 'projects', 'members', 'roles', 'user_roles', 'role_permissions',
      'groups', 'group_members', 'teams', 'team_members', 'team_projects',
      'issue_types', 'workflows', 'workflow_statuses', 'workflow_transitions',
      'sprints', 'boards', 'releases', 'activities', 'custom_fields',
      'task_custom_field_values', 'task_history', 'task_comments', 'task_watchers',
      'task_links', 'work_logs', 'saved_filters', 'issue_type_schemes', 'priority_schemes',
      'sla_definitions', 'sla_records', 'webhooks', 'webhook_deliveries',
      'user_favorites', 'user_recent_items', 'outbox_events', 'release_trains',
      'team_capacities', 'calendar_events', 'project_milestones', 'project_risks',
      'project_decisions', 'approval_requests', 'change_requests', 'service_requests',
      'customer_organizations', 'assets', 'service_dependencies', 'environments',
      'deployments', 'portfolios', 'portfolio_projects', 'initiatives',
      'strategic_goals', 'automations', 'automation_logs', 'notifications',
      'notification_preferences', 'integrations', 'integration_logs', 'api_tokens',
      'security_policies', 'audit_logs', 'subscriptions', 'invoices', 'backups', 'invitations'
    ];

    for (const table of tablesToClean) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
      } catch (e) {}
    }

    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    return ctx.json({ data: { id: workspaceId, $id: workspaceId, success: true } });
  });

export default app;
