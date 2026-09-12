import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';

export const SEAT_LICENSE_TIERS = {
  SOFTWARE_DEVELOPER: {
    key: 'SOFTWARE_DEVELOPER',
    name: 'KSH Software Developer',
    monthlyPriceInr: 650,
    annualPriceInr: 7020,
    description: 'Full software development: Agile boards, Sprints, Backlogs, Releases, Code repositories & Deployments.',
    color: 'blue',
  },
  SERVICE_AGENT: {
    key: 'SERVICE_AGENT',
    name: 'Service Desk Agent',
    monthlyPriceInr: 1250,
    annualPriceInr: 13500,
    description: 'ITSM & Service Desk agent: Customer request queues, SLA triage, Incident response & Change management.',
    color: 'emerald',
  },
  PORTFOLIO_MANAGER: {
    key: 'PORTFOLIO_MANAGER',
    name: 'Product & Portfolio Lead',
    monthlyPriceInr: 850,
    annualPriceInr: 9180,
    description: 'Executive planning: Cross-project portfolios, Multi-team roadmaps, Capacity planning & Governance.',
    color: 'purple',
  },
  BUSINESS_COLLABORATOR: {
    key: 'BUSINESS_COLLABORATOR',
    name: 'Business Collaborator',
    monthlyPriceInr: 450,
    annualPriceInr: 4860,
    description: 'Standard collaboration: Task assignments, progress updates, time tracking, comments & dashboards.',
    color: 'amber',
  },
  FREE_VIEWER: {
    key: 'FREE_VIEWER',
    name: 'Stakeholder / Free Viewer',
    monthlyPriceInr: 0,
    annualPriceInr: 0,
    description: 'Read-only viewer: Access to shared dashboards, reports, and read-only issue tracking at zero charge.',
    color: 'neutral',
  },
};

export const SUBSCRIPTION_PLANS = {
  STARTER: {
    name: 'Starter Tier',
    monthlyPriceInr: 2499,
    annualPriceInr: 23990,
    userLimit: 15,
    projectLimit: 10,
    storageLimitGb: 50,
    features: [
      'Up to 15 Team Members',
      '10 Active Projects',
      '50 GB Cloud Storage',
      'Scrum & Kanban Agile Boards',
      'Community & Email Support',
    ],
  },
  BUSINESS: {
    name: 'Business Standard',
    monthlyPriceInr: 7999,
    annualPriceInr: 76790,
    userLimit: 100,
    projectLimit: -1,
    storageLimitGb: 500,
    features: [
      'Up to 100 Team Members',
      'Unlimited Projects & Roadmaps',
      '500 GB Secure Cloud Storage',
      'Automations (10,000 runs/month)',
      'Service Management & SLAs',
      'Granular Role-based Access (RBAC)',
      'Priority 24/7 Support',
    ],
  },
  ENTERPRISE: {
    name: 'Enterprise Scale',
    monthlyPriceInr: 24999,
    annualPriceInr: 239990,
    userLimit: 1000,
    projectLimit: -1,
    storageLimitGb: 5000,
    features: [
      'Up to 1,000 Team Members',
      'Unlimited Projects, Portfolios & Goals',
      '5 TB Enterprise Storage',
      'Unlimited Automations & Webhooks',
      'SAML 2.0 Single Sign-On & SCIM Directory',
      '99.99% Guaranteed Uptime SLA',
      'Dedicated Account Manager & GST Compliance',
    ],
  },
};

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    let sub = db.prepare('SELECT * FROM subscriptions WHERE workspace_id = ?').get(workspaceId);
    if (!sub) {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (id, workspace_id, plan, billing_cycle, user_limit, project_limit, storage_limit_gb, currency, status, current_period_end)
        VALUES (?, ?, 'BUSINESS', 'MONTHLY', 100, -1, 500, 'INR', 'ACTIVE', date('now', '+30 days'))
      `).run(id, workspaceId);
      sub = db.prepare('SELECT * FROM subscriptions WHERE workspace_id = ?').get(workspaceId);
    }

    const members = db.prepare(`
      SELECT 
        m.id as member_id,
        m.workspace_id,
        m.user_id,
        m.role,
        m.organization_role,
        m.status,
        m.license_tier,
        m.monthly_cost_inr,
        m.created_at as joined_at,
        u.name,
        u.email,
        u.avatar_url,
        u.job_title,
        u.department,
        w.user_id = u.id as is_owner
      FROM members m
      JOIN users u ON m.user_id = u.id
      JOIN workspaces w ON m.workspace_id = w.id
      WHERE m.workspace_id = ? AND m.status = 'ACTIVE'
      ORDER BY w.user_id = u.id DESC, u.name ASC
    `).all(workspaceId);

    // Compute employee-wise license and cost
    const employeeLicenses = members.map((m) => {
      let tierKey = m.license_tier;
      if (!tierKey || !SEAT_LICENSE_TIERS[tierKey]) {
        if (m.is_owner || m.role === 'ADMIN' || (m.job_title && m.job_title.toLowerCase().includes('dev'))) {
          tierKey = 'SOFTWARE_DEVELOPER';
        } else if (m.job_title && (m.job_title.toLowerCase().includes('support') || m.job_title.toLowerCase().includes('service'))) {
          tierKey = 'SERVICE_AGENT';
        } else if (m.job_title && (m.job_title.toLowerCase().includes('product') || m.job_title.toLowerCase().includes('lead') || m.job_title.toLowerCase().includes('manager'))) {
          tierKey = 'PORTFOLIO_MANAGER';
        } else {
          tierKey = 'SOFTWARE_DEVELOPER';
        }
      }

      const tierInfo = SEAT_LICENSE_TIERS[tierKey] || SEAT_LICENSE_TIERS.SOFTWARE_DEVELOPER;
      const monthlyCost = tierInfo.monthlyPriceInr;

      return {
        memberId: m.member_id,
        userId: m.user_id,
        name: m.name,
        email: m.email,
        avatarUrl: m.avatar_url,
        jobTitle: m.job_title || 'Software Engineer',
        department: m.department || 'Engineering',
        role: m.role,
        organizationRole: m.organization_role,
        isOwner: Boolean(m.is_owner),
        joinedAt: m.joined_at,
        licenseTier: tierKey,
        licenseTierName: tierInfo.name,
        licenseDescription: tierInfo.description,
        licenseColor: tierInfo.color,
        monthlyCostInr: monthlyCost,
        annualCostInr: tierInfo.annualPriceInr,
      };
    });

    const totalAllocatedCostInr = employeeLicenses.reduce((acc, curr) => acc + curr.monthlyCostInr, 0);
    const paidSeatsCount = employeeLicenses.filter((e) => e.monthlyCostInr > 0).length;
    const freeSeatsCount = employeeLicenses.filter((e) => e.monthlyCostInr === 0).length;

    // Group by department
    const departmentBreakdown = {};
    for (const emp of employeeLicenses) {
      const dept = emp.department || 'General';
      if (!departmentBreakdown[dept]) {
        departmentBreakdown[dept] = { department: dept, count: 0, totalCostInr: 0 };
      }
      departmentBreakdown[dept].count += 1;
      departmentBreakdown[dept].totalCostInr += emp.monthlyCostInr;
    }

    // Group by tier
    const tierBreakdown = {};
    for (const [key, t] of Object.entries(SEAT_LICENSE_TIERS)) {
      const assigned = employeeLicenses.filter((e) => e.licenseTier === key);
      tierBreakdown[key] = {
        key,
        name: t.name,
        count: assigned.length,
        monthlyPriceInr: t.monthlyPriceInr,
        totalCostInr: assigned.length * t.monthlyPriceInr,
      };
    }

    const gstRatePercent = 18;
    const gstAmountInr = Math.round(totalAllocatedCostInr * (gstRatePercent / 100));
    const totalWithGstInr = totalAllocatedCostInr + gstAmountInr;

    const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects WHERE workspace_id = ?').get(workspaceId).c;
    const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?').get(workspaceId).c;
    const simulatedStorageGb = Math.max(12, Math.round(taskCount * 0.25 + projectCount * 3));

    let invoices = db.prepare('SELECT * FROM invoices WHERE workspace_id = ? ORDER BY invoice_date DESC').all(workspaceId);
    if (invoices.length === 0) {
      const initialInvId = randomUUID();
      db.prepare(`
        INSERT INTO invoices (id, workspace_id, invoice_number, amount, currency, status, invoice_date)
        VALUES (?, ?, 'INV-2026-001', 7999.00, 'INR', 'PAID', date('now', '-5 days'))
      `).run(initialInvId, workspaceId);
      invoices = db.prepare('SELECT * FROM invoices WHERE workspace_id = ? ORDER BY invoice_date DESC').all(workspaceId);
    }

    return ctx.json({
      data: {
        currency: 'INR',
        currencySymbol: '₹',
        subscription: formatDoc(sub),
        plans: SUBSCRIPTION_PLANS,
        seatLicenseTiers: SEAT_LICENSE_TIERS,
        employeeLicenses,
        costSummary: {
          totalAllocatedCostInr,
          annualAllocatedCostInr: totalAllocatedCostInr * 12,
          paidSeatsCount,
          freeSeatsCount,
          totalSeatsCount: employeeLicenses.length,
          gstRatePercent,
          gstAmountInr,
          totalWithGstInr,
          departmentBreakdown: Object.values(departmentBreakdown),
          tierBreakdown: Object.values(tierBreakdown),
        },
        usage: {
          users: { current: employeeLicenses.length, limit: sub.user_limit },
          projects: { current: projectCount, limit: sub.project_limit },
          storage: { currentGb: simulatedStorageGb, limitGb: sub.storage_limit_gb },
        },
        invoices: invoices.map((inv) => ({
          ...formatDoc(inv),
          currency: 'INR',
          currencySymbol: '₹',
        })),
      },
    });
  })
  .patch('/:workspaceId/members/:memberId/license', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, memberId } = ctx.req.param();
    const { licenseTier } = await ctx.req.json();

    const tierInfo = SEAT_LICENSE_TIERS[licenseTier];
    if (!tierInfo) {
      return ctx.json({ error: 'Invalid license tier specified.' }, 400);
    }

    const member = db.prepare('SELECT id, user_id FROM members WHERE id = ? AND workspace_id = ?').get(memberId, workspaceId);
    if (!member) {
      return ctx.json({ error: 'Member not found in workspace.' }, 404);
    }

    db.prepare(`
      UPDATE members 
      SET license_tier = ?, monthly_cost_inr = ?
      WHERE id = ? AND workspace_id = ?
    `).run(licenseTier, tierInfo.monthlyPriceInr, memberId, workspaceId);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_EMPLOYEE_LICENSE',
      entityType: 'MEMBER_LICENSE',
      entityId: memberId,
      details: { licenseTier, monthlyPriceInr: tierInfo.monthlyPriceInr },
    });

    return ctx.json({
      success: true,
      data: {
        memberId,
        licenseTier,
        licenseTierName: tierInfo.name,
        monthlyCostInr: tierInfo.monthlyPriceInr,
      },
    });
  })
  .post('/:workspaceId/upgrade', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { plan, billingCycle = 'MONTHLY' } = await ctx.req.json();

    const tier = SUBSCRIPTION_PLANS[plan];
    if (!tier) return ctx.json({ error: 'Invalid plan selected.' }, 400);

    const price = billingCycle === 'ANNUAL' ? tier.annualPriceInr : tier.monthlyPriceInr;

    db.prepare(`
      UPDATE subscriptions 
      SET plan = ?, billing_cycle = ?, user_limit = ?, project_limit = ?, storage_limit_gb = ?, currency = 'INR', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ?
    `).run(plan, billingCycle, tier.userLimit, tier.projectLimit, tier.storageLimitGb, workspaceId);

    // Generate new invoice in Indian Rupees
    const invNumber = `INV-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`;
    db.prepare(`
      INSERT INTO invoices (id, workspace_id, invoice_number, amount, currency, status, invoice_date)
      VALUES (?, ?, ?, ?, 'INR', 'PAID', date('now'))
    `).run(randomUUID(), workspaceId, invNumber, price);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_SUBSCRIPTION_PLAN',
      entityType: 'BILLING',
      entityId: workspaceId,
      details: { plan, billingCycle, priceInr: price, currency: 'INR' },
    });

    return ctx.json({ success: true, plan, billingCycle, priceInr: price });
  })
  .post('/:workspaceId/invoices/generate', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    // Calculate current active members' total monthly cost
    const members = db.prepare('SELECT monthly_cost_inr FROM members WHERE workspace_id = ? AND status = \'ACTIVE\'').all(workspaceId);
    const subtotal = members.reduce((acc, m) => acc + (m.monthly_cost_inr || 650), 0);
    const gst = Math.round(subtotal * 0.18);
    const totalAmountInr = subtotal + gst;

    const invNumber = `INV-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`;
    const invId = randomUUID();

    db.prepare(`
      INSERT INTO invoices (id, workspace_id, invoice_number, amount, currency, status, invoice_date)
      VALUES (?, ?, ?, ?, 'INR', 'PAID', date('now'))
    `).run(invId, workspaceId, invNumber, totalAmountInr);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'GENERATE_SEAT_INVOICE',
      entityType: 'INVOICE',
      entityId: invId,
      details: { invoiceNumber: invNumber, amountInr: totalAmountInr, subtotal, gst },
    });

    return ctx.json({
      success: true,
      data: {
        id: invId,
        invoiceNumber: invNumber,
        amount: totalAmountInr,
        currency: 'INR',
        currencySymbol: '₹',
        date: new Date().toISOString(),
      },
    });
  });

export default app;
