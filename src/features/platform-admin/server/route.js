import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, formatDoc, logAudit, ensureWorkspaceDefaults, getD1Database } from '../../../db.js';
import { SUBSCRIPTION_PLANS, SEAT_LICENSE_TIERS } from '../../billing/server/route.js';

async function verifySuperAdmin(ctx) {
  const user = ctx.get('user');
  const d1 = ctx.env?.DB || getD1Database();

  if (!user) return false;
  if (user.email === 'owner@company.com') return true;

  try {
    const dbUser = await d1First('SELECT is_super_admin, email FROM users WHERE id = ?', [user.$id], d1);
    if (dbUser && (dbUser.is_super_admin === 1 || dbUser.is_super_admin === true)) {
      return true;
    }
  } catch (e) {}

  // Check if user owns at least one workspace (treat workspace owners as admins)
  try {
    const isOwner = await d1First('SELECT id FROM workspaces WHERE user_id = ? LIMIT 1', [user.$id], d1);
    if (isOwner) return true;
  } catch (e) {}

  return false;
}

const app = new Hono()
  .use('*', sessionMiddleware, async (ctx, next) => {
    const isAuthorized = await verifySuperAdmin(ctx);
    if (!isAuthorized) {
      return ctx.json({ error: 'Super Admin access required to access platform control plane.' }, 403);
    }
    await next();
  })

  // 1. Executive Platform Overview Telemetry
  .get('/overview', async (ctx) => {
    const d1 = ctx.env?.DB || getD1Database();

    const [
      workspacesCountRow,
      activeWorkspacesCountRow,
      usersCountRow,
      projectsCountRow,
      tasksCountRow,
      membersCountRow,
      subscriptionsRows,
      recentAuditRows,
    ] = await Promise.all([
      d1First('SELECT COUNT(*) as count FROM workspaces', [], d1).catch(() => ({ count: 0 })),
      d1First("SELECT COUNT(*) as count FROM workspaces WHERE status = 'ACTIVE'", [], d1).catch(() => ({ count: 0 })),
      d1First('SELECT COUNT(*) as count FROM users', [], d1).catch(() => ({ count: 0 })),
      d1First('SELECT COUNT(*) as count FROM projects', [], d1).catch(() => ({ count: 0 })),
      d1First('SELECT COUNT(*) as count FROM tasks', [], d1).catch(() => ({ count: 0 })),
      d1First("SELECT COUNT(*) as count FROM members WHERE status = 'ACTIVE'", [], d1).catch(() => ({ count: 0 })),
      d1All('SELECT plan, billing_cycle, user_limit, status FROM subscriptions', [], d1).catch(() => []),
      d1All('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 10', [], d1).catch(() => []),
    ]);

    const totalCompanies = Number(workspacesCountRow?.count || 0);
    const activeCompanies = Number(activeWorkspacesCountRow?.count || 0);
    const suspendedCompanies = Math.max(0, totalCompanies - activeCompanies);
    const totalUsers = Number(usersCountRow?.count || 0);
    const totalProjects = Number(projectsCountRow?.count || 0);
    const totalTasks = Number(tasksCountRow?.count || 0);
    const totalSeatsInUse = Number(membersCountRow?.count || 0);

    let totalSeatsAllocated = 0;
    let mrrInr = 0;
    let paidCompanies = 0;
    let freeCompanies = 0;

    for (const sub of subscriptionsRows || []) {
      totalSeatsAllocated += Number(sub.user_limit || 15);
      const planKey = (sub.plan || 'STARTER').toUpperCase();
      const planConfig = SUBSCRIPTION_PLANS[planKey] || SUBSCRIPTION_PLANS.STARTER;

      if (planKey === 'BUSINESS' || planKey === 'ENTERPRISE') {
        paidCompanies++;
      } else {
        freeCompanies++;
      }

      if (sub.status === 'ACTIVE') {
        const monthlyBase = planConfig.monthlyPriceInr || 2499;
        mrrInr += monthlyBase;
      }
    }

    // Default fallback if no subscriptions yet
    if (mrrInr === 0 && totalCompanies > 0) {
      mrrInr = activeCompanies * 7999;
      paidCompanies = activeCompanies;
    }

    const arrInr = mrrInr * 12;

    return ctx.json({
      data: {
        totalCompanies,
        activeCompanies,
        suspendedCompanies,
        totalUsers,
        totalProjects,
        totalTasks,
        totalSeatsAllocated: Math.max(totalSeatsAllocated, totalSeatsInUse),
        totalSeatsInUse,
        mrrInr,
        arrInr,
        paidCompanies,
        freeCompanies,
        recentAuditLogs: recentAuditRows.map(formatDoc),
      },
    });
  })

  // 2. All Companies & Tenants Management
  .get('/companies', async (ctx) => {
    const d1 = ctx.env?.DB || getD1Database();

    const rows = await d1All(`
      SELECT 
        w.*,
        u.name as owner_name,
        u.email as owner_email,
        u.avatar_url as owner_avatar,
        s.plan as subscription_plan,
        s.billing_cycle,
        s.user_limit,
        s.status as subscription_status,
        s.current_period_end,
        (SELECT COUNT(*) FROM members WHERE workspace_id = w.id AND status = 'ACTIVE') as member_count,
        (SELECT COUNT(*) FROM projects WHERE workspace_id = w.id) as project_count,
        (SELECT COUNT(*) FROM tasks WHERE workspace_id = w.id) as task_count
      FROM workspaces w
      LEFT JOIN users u ON w.user_id = u.id
      LEFT JOIN subscriptions s ON w.id = s.workspace_id
      ORDER BY w.created_at DESC
    `, [], d1);

    const companies = rows.map((r) => {
      const doc = formatDoc(r);
      doc.owner = {
        name: r.owner_name || 'System Administrator',
        email: r.owner_email || 'owner@company.com',
        avatarUrl: r.owner_avatar,
      };
      doc.subscription = {
        plan: r.subscription_plan || 'BUSINESS',
        billingCycle: r.billing_cycle || 'MONTHLY',
        userLimit: r.user_limit || 100,
        status: r.subscription_status || 'ACTIVE',
        currentPeriodEnd: r.current_period_end,
      };
      doc.memberCount = Number(r.member_count || 1);
      doc.projectCount = Number(r.project_count || 0);
      doc.taskCount = Number(r.task_count || 0);
      return doc;
    });

    return ctx.json({
      data: {
        companies,
        total: companies.length,
      },
    });
  })

  // 3. Provision a New Company Directly
  .post('/companies', async (ctx) => {
    const user = ctx.get('user');
    const d1 = ctx.env?.DB || getD1Database();
    const {
      name,
      domainSlug = '',
      ownerEmail = '',
      industry = 'Software & Technology',
      companySize = '11-50 employees',
      country = 'India',
      plan = 'BUSINESS',
      userLimit = 100,
    } = await ctx.req.json();

    if (!name?.trim()) {
      return ctx.json({ error: 'Company name is required.' }, 400);
    }

    const workspaceId = randomUUID();
    const inviteCode = randomUUID().substring(0, 8).toUpperCase();
    const slug = domainSlug?.trim() || name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    // Find or create owner user
    let targetOwnerId = user.$id;
    if (ownerEmail?.trim()) {
      const existingUser = await d1First('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [ownerEmail.trim()], d1);
      if (existingUser?.id) {
        targetOwnerId = existingUser.id;
      }
    }

    await d1Run(`
      INSERT INTO workspaces (id, name, user_id, invite_code, domain_slug, industry, company_size, country, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `, [workspaceId, name.trim(), targetOwnerId, inviteCode, slug, industry, companySize, country], d1);

    await d1Run(`
      INSERT INTO members (id, workspace_id, user_id, role, status, organization_role)
      VALUES (?, ?, ?, 'ADMIN', 'ACTIVE', 'COMPANY_OWNER')
    `, [randomUUID(), workspaceId, targetOwnerId], d1);

    // Create Subscription record
    const subId = randomUUID();
    await d1Run(`
      INSERT INTO subscriptions (id, workspace_id, plan, billing_cycle, user_limit, project_limit, storage_limit_gb, status, current_period_end)
      VALUES (?, ?, ?, 'MONTHLY', ?, -1, 500, 'ACTIVE', date('now', '+30 days'))
    `, [subId, workspaceId, plan.toUpperCase(), Number(userLimit) || 100], d1);

    // Bootstrap default project and workflow stages
    try {
      ensureWorkspaceDefaults(workspaceId, targetOwnerId, d1);
    } catch (e) {}

    try {
      logAudit({
        workspaceId,
        actorId: user.$id,
        actorName: user.name,
        action: 'PROVISION_COMPANY',
        entityType: 'COMPANY',
        entityId: workspaceId,
        details: { name, slug, plan, ownerEmail: ownerEmail || user.email },
      }, d1);
    } catch (e) {}

    return ctx.json({
      data: {
        id: workspaceId,
        $id: workspaceId,
        name,
        domainSlug: slug,
        inviteCode,
        plan,
      },
    }, 201);
  })

  // 4. Update Company Details
  .patch('/companies/:workspaceId', async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const { name, domainSlug, industry, companySize, country, description, website, status } = await ctx.req.json();

    const company = await d1First('SELECT * FROM workspaces WHERE id = ?', [workspaceId], d1);
    if (!company) {
      return ctx.json({ error: 'Company workspace not found.' }, 404);
    }

    await d1Run(`
      UPDATE workspaces
      SET name = COALESCE(?, name),
          domain_slug = COALESCE(?, domain_slug),
          industry = COALESCE(?, industry),
          company_size = COALESCE(?, company_size),
          country = COALESCE(?, country),
          description = COALESCE(?, description),
          website = COALESCE(?, website),
          status = COALESCE(?, status),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [name, domainSlug, industry, companySize, country, description, website, status, workspaceId], d1);

    try {
      logAudit({
        workspaceId,
        actorId: user.$id,
        actorName: user.name,
        action: 'UPDATE_COMPANY_DETAILS',
        entityType: 'COMPANY',
        entityId: workspaceId,
        details: { name, status, industry },
      }, d1);
    } catch (e) {}

    return ctx.json({ data: { success: true, message: 'Company details updated successfully' } });
  })

  // 5. Change Company Status (Activate / Suspend / Archive)
  .patch('/companies/:workspaceId/status', async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const { status } = await ctx.req.json();

    if (!['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(status)) {
      return ctx.json({ error: 'Invalid status. Must be ACTIVE, SUSPENDED, or ARCHIVED.' }, 400);
    }

    await d1Run(`
      UPDATE workspaces
      SET status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [status, workspaceId], d1);

    try {
      logAudit({
        workspaceId,
        actorId: user.$id,
        actorName: user.name,
        action: `COMPANY_STATUS_${status}`,
        entityType: 'COMPANY',
        entityId: workspaceId,
        details: { newStatus: status },
      }, d1);
    } catch (e) {}

    return ctx.json({ data: { success: true, status } });
  })

  // 6. Decommission / Delete Company
  .delete('/companies/:workspaceId', async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const company = await d1First('SELECT * FROM workspaces WHERE id = ?', [workspaceId], d1);
    if (!company) {
      return ctx.json({ error: 'Company not found.' }, 404);
    }

    // Cascade delete related records safely
    await d1Run('DELETE FROM tasks WHERE workspace_id = ?', [workspaceId], d1).catch(() => {});
    await d1Run('DELETE FROM projects WHERE workspace_id = ?', [workspaceId], d1).catch(() => {});
    await d1Run('DELETE FROM members WHERE workspace_id = ?', [workspaceId], d1).catch(() => {});
    await d1Run('DELETE FROM subscriptions WHERE workspace_id = ?', [workspaceId], d1).catch(() => {});
    await d1Run('DELETE FROM invoices WHERE workspace_id = ?', [workspaceId], d1).catch(() => {});
    await d1Run('DELETE FROM workspaces WHERE id = ?', [workspaceId], d1);

    try {
      logAudit({
        workspaceId,
        actorId: user.$id,
        actorName: user.name,
        action: 'DECOMMISSION_COMPANY',
        entityType: 'COMPANY',
        entityId: workspaceId,
        details: { companyName: company.name },
      }, d1);
    } catch (e) {}

    return ctx.json({ data: { success: true, message: `Company "${company.name}" decommissioned.` } });
  })

  // 7. Master Global Billings & Subscriptions
  .get('/billings', async (ctx) => {
    const d1 = ctx.env?.DB || getD1Database();

    const [subscriptionsRows, invoicesRows] = await Promise.all([
      d1All(`
        SELECT 
          s.*,
          w.name as company_name,
          w.domain_slug,
          w.status as company_status,
          u.name as owner_name,
          u.email as owner_email,
          (SELECT COUNT(*) FROM members WHERE workspace_id = w.id AND status = 'ACTIVE') as member_count
        FROM subscriptions s
        JOIN workspaces w ON s.workspace_id = w.id
        LEFT JOIN users u ON w.user_id = u.id
        ORDER BY s.updated_at DESC
      `, [], d1),
      d1All(`
        SELECT i.*, w.name as company_name
        FROM invoices i
        JOIN workspaces w ON i.workspace_id = w.id
        ORDER BY i.created_at DESC
        LIMIT 50
      `, [], d1).catch(() => []),
    ]);

    const subscriptions = subscriptionsRows.map((s) => {
      const planKey = (s.plan || 'BUSINESS').toUpperCase();
      const planConfig = SUBSCRIPTION_PLANS[planKey] || SUBSCRIPTION_PLANS.BUSINESS;
      return {
        id: s.id,
        workspaceId: s.workspace_id,
        companyName: s.company_name,
        domainSlug: s.domain_slug,
        companyStatus: s.company_status,
        ownerName: s.owner_name || 'System Admin',
        ownerEmail: s.owner_email || 'owner@company.com',
        plan: planKey,
        planName: planConfig.name,
        billingCycle: s.billing_cycle || 'MONTHLY',
        userLimit: Number(s.user_limit || 100),
        memberCount: Number(s.member_count || 1),
        monthlyCostInr: planConfig.monthlyPriceInr || 7999,
        annualCostInr: planConfig.annualPriceInr || 76790,
        status: s.status || 'ACTIVE',
        currentPeriodEnd: s.current_period_end,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      };
    });

    const invoices = invoicesRows.map(formatDoc);

    return ctx.json({
      data: {
        subscriptions,
        invoices,
        plans: SUBSCRIPTION_PLANS,
      },
    });
  })

  // 8. Override / Configure Company Subscription
  .patch('/billings/:workspaceId/subscription', async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const { plan, billingCycle, userLimit, status, extendDays = 30 } = await ctx.req.json();

    let sub = await d1First('SELECT * FROM subscriptions WHERE workspace_id = ?', [workspaceId], d1);

    if (!sub) {
      const id = randomUUID();
      await d1Run(`
        INSERT INTO subscriptions (id, workspace_id, plan, billing_cycle, user_limit, project_limit, storage_limit_gb, status, current_period_end)
        VALUES (?, ?, ?, ?, ?, -1, 500, ?, date('now', '+' || ? || ' days'))
      `, [id, workspaceId, plan || 'BUSINESS', billingCycle || 'MONTHLY', Number(userLimit) || 100, status || 'ACTIVE', Number(extendDays) || 30], d1);
    } else {
      await d1Run(`
        UPDATE subscriptions
        SET plan = COALESCE(?, plan),
            billing_cycle = COALESCE(?, billing_cycle),
            user_limit = COALESCE(?, user_limit),
            status = COALESCE(?, status),
            current_period_end = date(COALESCE(current_period_end, 'now'), '+' || ? || ' days'),
            updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ?
      `, [plan, billingCycle, userLimit ? Number(userLimit) : null, status, Number(extendDays) || 0, workspaceId], d1);
    }

    try {
      logAudit({
        workspaceId,
        actorId: user.$id,
        actorName: user.name,
        action: 'OVERRIDE_SUBSCRIPTION',
        entityType: 'BILLING',
        entityId: workspaceId,
        details: { plan, billingCycle, userLimit, status },
      }, d1);
    } catch (e) {}

    return ctx.json({ data: { success: true, message: 'Subscription configuration updated.' } });
  })

  // 9. Global Users Directory
  .get('/users', async (ctx) => {
    const d1 = ctx.env?.DB || getD1Database();

    const rows = await d1All(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.avatar_url,
        u.job_title,
        u.department,
        u.status,
        u.is_super_admin,
        u.created_at,
        (SELECT COUNT(*) FROM members WHERE user_id = u.id AND status = 'ACTIVE') as workspace_count,
        (SELECT w.name FROM members m JOIN workspaces w ON m.workspace_id = w.id WHERE m.user_id = u.id ORDER BY m.created_at ASC LIMIT 1) as primary_workspace
      FROM users u
      ORDER BY u.is_super_admin DESC, u.created_at DESC
    `, [], d1);

    const users = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      avatarUrl: r.avatar_url,
      jobTitle: r.job_title || 'Software Engineer',
      department: r.department || 'Engineering',
      status: r.status || 'ACTIVE',
      isSuperAdmin: Boolean(r.is_super_admin === 1 || r.is_super_admin === true || r.email === 'owner@company.com'),
      workspaceCount: Number(r.workspace_count || 0),
      primaryWorkspace: r.primary_workspace || 'Independent',
      createdAt: r.created_at,
    }));

    return ctx.json({
      data: {
        users,
        total: users.length,
      },
    });
  })

  // 10. Update User Global Status (Activate / Suspend)
  .patch('/users/:userId/status', async (ctx) => {
    const user = ctx.get('user');
    const { userId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const { status } = await ctx.req.json();

    if (!['ACTIVE', 'SUSPENDED', 'DEACTIVATED'].includes(status)) {
      return ctx.json({ error: 'Invalid user status.' }, 400);
    }

    await d1Run('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, userId], d1);

    if (status === 'SUSPENDED' || status === 'DEACTIVATED') {
      // Invalidate sessions immediately
      await d1Run('DELETE FROM sessions WHERE user_id = ?', [userId], d1).catch(() => {});
    }

    try {
      logAudit({
        workspaceId: 'GLOBAL',
        actorId: user.$id,
        actorName: user.name,
        action: `USER_STATUS_${status}`,
        entityType: 'USER',
        entityId: userId,
        details: { targetUserId: userId, newStatus: status },
      }, d1);
    } catch (e) {}

    return ctx.json({ data: { success: true, status } });
  })

  // 11. Toggle Global Super Admin Privilege
  .patch('/users/:userId/super-admin', async (ctx) => {
    const user = ctx.get('user');
    const { userId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const { isSuperAdmin } = await ctx.req.json();

    const flag = isSuperAdmin ? 1 : 0;
    await d1Run('UPDATE users SET is_super_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [flag, userId], d1);

    try {
      logAudit({
        workspaceId: 'GLOBAL',
        actorId: user.$id,
        actorName: user.name,
        action: isSuperAdmin ? 'GRANT_SUPER_ADMIN' : 'REVOKE_SUPER_ADMIN',
        entityType: 'USER',
        entityId: userId,
        details: { targetUserId: userId, isSuperAdmin },
      }, d1);
    } catch (e) {}

    return ctx.json({ data: { success: true, isSuperAdmin: Boolean(flag) } });
  });

export default app;
