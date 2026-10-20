import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logActivity } from '../../../db.js';

let tablesEnsured = false;
async function ensurePortfolioTables(d1) {
  if (!d1) return;
  try {
    await d1Run(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        owner_id TEXT,
        category TEXT DEFAULT 'Cloud Infrastructure',
        status TEXT DEFAULT 'ON_TRACK',
        progress_percent INTEGER DEFAULT 50,
        budget_allocated INTEGER DEFAULT 250000,
        budget_spent INTEGER DEFAULT 120000,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, [], d1);

    await d1Run(`
      CREATE TABLE IF NOT EXISTS initiatives (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        portfolio_id TEXT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        target_date DATETIME,
        status TEXT DEFAULT 'IN_PROGRESS',
        health_status TEXT DEFAULT 'ON_TRACK',
        progress_percent INTEGER DEFAULT 45,
        priority TEXT DEFAULT 'P1',
        owner_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, [], d1);

    await d1Run(`
      CREATE TABLE IF NOT EXISTS strategic_goals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        target_date DATETIME,
        status TEXT DEFAULT 'ON_TRACK',
        key_result TEXT DEFAULT '',
        progress_percent INTEGER DEFAULT 60,
        owner_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, [], d1);

    const alterCols = [
      'ALTER TABLE portfolios ADD COLUMN description TEXT DEFAULT ""',
      'ALTER TABLE portfolios ADD COLUMN category TEXT DEFAULT "General"',
      'ALTER TABLE portfolios ADD COLUMN status TEXT DEFAULT "ON_TRACK"',
      'ALTER TABLE portfolios ADD COLUMN progress_percent INTEGER DEFAULT 0',
      'ALTER TABLE portfolios ADD COLUMN budget_allocated INTEGER DEFAULT 0',
      'ALTER TABLE portfolios ADD COLUMN budget_spent INTEGER DEFAULT 0',
      'ALTER TABLE portfolios ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP',
      'ALTER TABLE initiatives ADD COLUMN health_status TEXT DEFAULT "ON_TRACK"',
      'ALTER TABLE initiatives ADD COLUMN progress_percent INTEGER DEFAULT 0',
      'ALTER TABLE initiatives ADD COLUMN priority TEXT DEFAULT "P1"',
      'ALTER TABLE initiatives ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP',
      'ALTER TABLE strategic_goals ADD COLUMN key_result TEXT DEFAULT ""',
      'ALTER TABLE strategic_goals ADD COLUMN progress_percent INTEGER DEFAULT 0'
    ];
    for (const sql of alterCols) {
      try {
        await d1Run(sql, [], d1);
      } catch (e) {}
    }
    tablesEnsured = true;
  } catch (err) {
    console.error('ensurePortfolioTables error:', err);
  }
}

const app = new Hono()
  // 1. Executive Portfolio Telemetry & Overview
  .get('/:workspaceId/overview', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    const portfolios = await d1All(`
      SELECT 
        p.*, 
        u.name as owner_name,
        (SELECT COUNT(*) FROM initiatives i WHERE i.portfolio_id = p.id) as initiatives_count
      FROM portfolios p
      LEFT JOIN users u ON p.owner_id = u.id
      WHERE p.workspace_id = ?
      ORDER BY p.name ASC
    `, [workspaceId], d1);

    const initiatives = await d1All(`
      SELECT i.*, p.name as portfolio_name
      FROM initiatives i
      LEFT JOIN portfolios p ON i.portfolio_id = p.id
      WHERE i.workspace_id = ?
      ORDER BY i.created_at DESC
    `, [workspaceId], d1);

    const goals = await d1All(`
      SELECT * FROM strategic_goals WHERE workspace_id = ? ORDER BY created_at DESC
    `, [workspaceId], d1);

    const totalPortfolios = portfolios.length;
    const totalInitiatives = initiatives.length;
    const totalGoals = goals.length;

    const onTrackInitiatives = initiatives.filter(i => (i.health_status || 'ON_TRACK') === 'ON_TRACK').length;
    const atRiskInitiatives = initiatives.filter(i => i.health_status === 'AT_RISK').length;
    const offTrackInitiatives = initiatives.filter(i => i.health_status === 'OFF_TRACK').length;
    const completedInitiatives = initiatives.filter(i => i.status === 'COMPLETED' || i.health_status === 'COMPLETED').length;

    const healthScore = totalInitiatives > 0 
      ? Math.round(((onTrackInitiatives + completedInitiatives) / totalInitiatives) * 100) 
      : 100;

    const avgProgress = totalInitiatives > 0 
      ? Math.round(initiatives.reduce((sum, i) => sum + (Number(i.progress_percent) || 0), 0) / totalInitiatives)
      : (totalPortfolios > 0 ? Math.round(portfolios.reduce((sum, p) => sum + (Number(p.progress_percent) || 0), 0) / totalPortfolios) : 0);

    const totalBudgetAllocated = portfolios.reduce((sum, p) => sum + (Number(p.budget_allocated) || 0), 0);
    const totalBudgetSpent = portfolios.reduce((sum, p) => sum + (Number(p.budget_spent) || 0), 0);

    // Dynamic Target Horizon calculation from active initiatives and goals
    let latestTargetDate = null;
    for (const item of [...initiatives, ...goals]) {
      if (item.target_date) {
        const d = new Date(item.target_date);
        if (!isNaN(d.getTime()) && (!latestTargetDate || d > latestTargetDate)) {
          latestTargetDate = d;
        }
      }
    }
    let targetHorizon = '';
    if (latestTargetDate) {
      const q = Math.floor(latestTargetDate.getMonth() / 3) + 1;
      targetHorizon = `Q${q} ${latestTargetDate.getFullYear()}`;
    } else {
      const now = new Date();
      const q = Math.floor(now.getMonth() / 3) + 1;
      targetHorizon = `Q${q} ${now.getFullYear()}`;
    }

    return ctx.json({
      data: {
        totalPortfolios,
        totalInitiatives,
        totalGoals,
        healthScore,
        avgProgress,
        totalBudgetAllocated,
        totalBudgetSpent,
        onTrackInitiatives,
        atRiskInitiatives,
        offTrackInitiatives,
        completedInitiatives,
        targetHorizon
      }
    });
  })

  // 2. Portfolios list with initiatives count and owner
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    const portfolios = await d1All(`
      SELECT 
        p.*, 
        u.name as owner_name,
        (SELECT COUNT(*) FROM initiatives i WHERE i.portfolio_id = p.id) as initiatives_count
      FROM portfolios p
      LEFT JOIN users u ON p.owner_id = u.id
      WHERE p.workspace_id = ?
      ORDER BY p.name ASC
    `, [workspaceId], d1);

    return ctx.json({ data: portfolios.map(formatDoc) });
  })

  // 3. Register a new Strategic Portfolio
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { 
      name, 
      description = '', 
      category = 'Cloud Infrastructure',
      budget_allocated = 250000,
      budget_spent = 0,
      status = 'ON_TRACK',
      progress_percent = 0
    } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    if (!name || !name.trim()) {
      return ctx.json({ error: 'Portfolio name is required.' }, 400);
    }

    const id = randomUUID();
    const cleanName = name.trim();

    await d1Run(`
      INSERT INTO portfolios (
        id, workspace_id, name, description, owner_id, 
        category, status, progress_percent, budget_allocated, budget_spent,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id, workspaceId, cleanName, description, user.$id,
      category, status, Number(progress_percent) || 0,
      Number(budget_allocated) || 250000, Number(budget_spent) || 0
    ], d1);

    await logActivity({
      workspaceId,
      actorId: user.$id,
      actorName: user.name || 'Executive',
      action: 'CREATED_PORTFOLIO',
      targetId: id,
      targetName: cleanName,
      details: `Created strategic portfolio "${cleanName}" in category ${category}`,
    }, d1);

    return ctx.json({ success: true, id, name: cleanName }, 201);
  })

  // 4. Update Portfolio
  .patch('/:workspaceId/portfolios/:portfolioId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, portfolioId } = ctx.req.param();
    const body = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    const portfolio = await d1First(`SELECT * FROM portfolios WHERE id = ? AND workspace_id = ?`, [portfolioId, workspaceId], d1);
    if (!portfolio) return ctx.json({ error: 'Portfolio not found.' }, 404);

    const name = body.name !== undefined ? body.name.trim() : portfolio.name;
    const description = body.description !== undefined ? body.description : portfolio.description;
    const category = body.category !== undefined ? body.category : portfolio.category;
    const status = body.status !== undefined ? body.status : portfolio.status;
    const progress_percent = body.progress_percent !== undefined ? Number(body.progress_percent) : portfolio.progress_percent;
    const budget_allocated = body.budget_allocated !== undefined ? Number(body.budget_allocated) : portfolio.budget_allocated;
    const budget_spent = body.budget_spent !== undefined ? Number(body.budget_spent) : portfolio.budget_spent;

    await d1Run(`
      UPDATE portfolios SET
        name = ?, description = ?, category = ?, status = ?,
        progress_percent = ?, budget_allocated = ?, budget_spent = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?
    `, [name, description, category, status, progress_percent, budget_allocated, budget_spent, portfolioId, workspaceId], d1);

    return ctx.json({ success: true, id: portfolioId, name });
  })

  // 5. Delete Portfolio
  .delete('/:workspaceId/portfolios/:portfolioId', sessionMiddleware, async (ctx) => {
    const { workspaceId, portfolioId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    await d1Run(`DELETE FROM initiatives WHERE portfolio_id = ? AND workspace_id = ?`, [portfolioId, workspaceId], d1);
    await d1Run(`DELETE FROM portfolios WHERE id = ? AND workspace_id = ?`, [portfolioId, workspaceId], d1);

    return ctx.json({ success: true, message: 'Portfolio removed.' });
  })

  // 6. Initiatives List
  .get('/:workspaceId/initiatives', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    const initiatives = await d1All(`
      SELECT 
        i.*, 
        p.name as portfolio_name,
        u.name as owner_name
      FROM initiatives i
      LEFT JOIN portfolios p ON i.portfolio_id = p.id
      LEFT JOIN users u ON i.owner_id = u.id
      WHERE i.workspace_id = ?
      ORDER BY 
        CASE i.health_status
          WHEN 'OFF_TRACK' THEN 1
          WHEN 'AT_RISK' THEN 2
          WHEN 'ON_TRACK' THEN 3
          ELSE 4
        END,
        i.created_at DESC
    `, [workspaceId], d1);

    return ctx.json({ data: initiatives.map(formatDoc) });
  })

  // 7. Create Initiative
  .post('/:workspaceId/initiatives', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { 
      name, 
      description = '', 
      targetDate = null, 
      portfolioId = null,
      priority = 'P1',
      health_status = 'ON_TRACK',
      progress_percent = 0,
      status = 'IN_PROGRESS'
    } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    if (!name || !name.trim()) {
      return ctx.json({ error: 'Initiative name is required.' }, 400);
    }

    const id = randomUUID();
    const cleanName = name.trim();

    await d1Run(`
      INSERT INTO initiatives (
        id, workspace_id, portfolio_id, name, description, 
        target_date, status, health_status, progress_percent, 
        priority, owner_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id, workspaceId, portfolioId || null, cleanName, description,
      targetDate || '2026-12-31', status, health_status, Number(progress_percent) || 0,
      priority, user.$id
    ], d1);

    await logActivity({
      workspaceId,
      actorId: user.$id,
      actorName: user.name || 'Executive',
      action: 'CREATED_INITIATIVE',
      targetId: id,
      targetName: cleanName,
      details: `Created strategic initiative "${cleanName}" (${health_status})`,
    }, d1);

    return ctx.json({ success: true, id, name: cleanName }, 201);
  })

  // 8. Update Initiative
  .patch('/:workspaceId/initiatives/:initiativeId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, initiativeId } = ctx.req.param();
    const body = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    const init = await d1First(`SELECT * FROM initiatives WHERE id = ? AND workspace_id = ?`, [initiativeId, workspaceId], d1);
    if (!init) return ctx.json({ error: 'Initiative not found.' }, 404);

    const name = body.name !== undefined ? body.name.trim() : init.name;
    const description = body.description !== undefined ? body.description : init.description;
    const portfolio_id = body.portfolioId !== undefined ? body.portfolioId : init.portfolio_id;
    const target_date = body.targetDate !== undefined ? body.targetDate : init.target_date;
    const status = body.status !== undefined ? body.status : init.status;
    const health_status = body.health_status !== undefined ? body.health_status : init.health_status;
    const progress_percent = body.progress_percent !== undefined ? Number(body.progress_percent) : init.progress_percent;
    const priority = body.priority !== undefined ? body.priority : init.priority;

    await d1Run(`
      UPDATE initiatives SET
        name = ?, description = ?, portfolio_id = ?, target_date = ?,
        status = ?, health_status = ?, progress_percent = ?, priority = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?
    `, [name, description, portfolio_id, target_date, status, health_status, progress_percent, priority, initiativeId, workspaceId], d1);

    return ctx.json({ success: true, id: initiativeId, name, progress_percent, health_status });
  })

  // 9. Delete Initiative
  .delete('/:workspaceId/initiatives/:initiativeId', sessionMiddleware, async (ctx) => {
    const { workspaceId, initiativeId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    await d1Run(`DELETE FROM initiatives WHERE id = ? AND workspace_id = ?`, [initiativeId, workspaceId], d1);
    return ctx.json({ success: true, message: 'Initiative removed.' });
  })

  // 10. Strategic Goals List
  .get('/:workspaceId/goals', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    const goals = await d1All(`
      SELECT g.*, u.name as owner_name
      FROM strategic_goals g
      LEFT JOIN users u ON g.owner_id = u.id
      WHERE g.workspace_id = ?
      ORDER BY g.created_at ASC
    `, [workspaceId], d1);

    return ctx.json({ data: goals.map(formatDoc) });
  })

  // 11. Create Strategic Goal
  .post('/:workspaceId/goals', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { 
      name, 
      description = '', 
      targetDate = '2026-12-31', 
      key_result = '', 
      progress_percent = 0,
      status = 'ON_TRACK' 
    } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    if (!name || !name.trim()) return ctx.json({ error: 'Goal name is required.' }, 400);

    const id = randomUUID();
    const cleanName = name.trim();

    await d1Run(`
      INSERT INTO strategic_goals (
        id, workspace_id, name, description, target_date, 
        status, key_result, progress_percent, owner_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      id, workspaceId, cleanName, description, targetDate,
      status, key_result, Number(progress_percent) || 0, user.$id
    ], d1);

    return ctx.json({ success: true, id, name: cleanName }, 201);
  })

  // 12. Seed Executive Blueprint Sample Data
  .post('/:workspaceId/seed-sample', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensurePortfolioTables(d1);

    // Clean existing
    await d1Run(`DELETE FROM strategic_goals WHERE workspace_id = ?`, [workspaceId], d1);
    await d1Run(`DELETE FROM initiatives WHERE workspace_id = ?`, [workspaceId], d1);
    await d1Run(`DELETE FROM portfolios WHERE workspace_id = ?`, [workspaceId], d1);

    const p1Id = randomUUID();
    const p2Id = randomUUID();
    const p3Id = randomUUID();

    const samplePortfolios = [
      {
        id: p1Id,
        name: 'Cloud Infrastructure Modernization',
        description: 'Multi-region AWS & Cloudflare migration, D1 SQLite clustering, and automated zero-downtime rollouts',
        category: 'Cloud Infrastructure',
        status: 'ON_TRACK',
        progress_percent: 74,
        budget_allocated: 600000,
        budget_spent: 450000,
      },
      {
        id: p2Id,
        name: 'AI & Autonomous Agentic Platform',
        description: 'LLM-powered ticket routing, predictive CMDB topology anomaly detection, and automated incident resolution',
        category: 'AI & Machine Learning',
        status: 'ON_TRACK',
        progress_percent: 52,
        budget_allocated: 500000,
        budget_spent: 280000,
      },
      {
        id: p3Id,
        name: 'Enterprise Trust, Compliance & Security',
        description: 'SOC2 Type II certification, GDPR/DPDP consent governance, automated audit logging, and RBAC matrix',
        category: 'Security & Governance',
        status: 'ON_TRACK',
        progress_percent: 92,
        budget_allocated: 200000,
        budget_spent: 180000,
      }
    ];

    for (const p of samplePortfolios) {
      await d1Run(`
        INSERT INTO portfolios (
          id, workspace_id, name, description, owner_id, 
          category, status, progress_percent, budget_allocated, budget_spent,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        p.id, workspaceId, p.name, p.description, user.$id,
        p.category, p.status, p.progress_percent, p.budget_allocated, p.budget_spent
      ], d1);
    }

    const sampleInitiatives = [
      {
        id: randomUUID(),
        portfolio_id: p1Id,
        name: 'Cloudflare Workers Edge API Gateway Migration',
        description: 'Transition monolithic routing to sub-50ms global Anycast edge workers with DDoS protection',
        target_date: '2026-11-15',
        status: 'COMPLETED',
        health_status: 'COMPLETED',
        progress_percent: 100,
        priority: 'P0'
      },
      {
        id: randomUUID(),
        portfolio_id: p1Id,
        name: 'D1 Multi-AZ Database Clustering & Auto-Migration',
        description: 'Idempotent schema evolution and low-latency read replica synchronization across EU/US',
        target_date: '2026-12-01',
        status: 'IN_PROGRESS',
        health_status: 'ON_TRACK',
        progress_percent: 85,
        priority: 'P0'
      },
      {
        id: randomUUID(),
        portfolio_id: p1Id,
        name: 'Automated Blue/Green Rollback Orchestration',
        description: 'Zero-touch automated rollbacks triggered upon DORA change failure rate breaches',
        target_date: '2026-12-20',
        status: 'IN_PROGRESS',
        health_status: 'ON_TRACK',
        progress_percent: 45,
        priority: 'P1'
      },
      {
        id: randomUUID(),
        portfolio_id: p2Id,
        name: 'Predictive CMDB Topology Blast Radius Modeling',
        description: 'Deep neural dependency graph to forecast upstream outage cascade prior to production release',
        target_date: '2026-11-30',
        status: 'IN_PROGRESS',
        health_status: 'ON_TRACK',
        progress_percent: 70,
        priority: 'P1'
      },
      {
        id: randomUUID(),
        portfolio_id: p2Id,
        name: 'Autonomous ITSM Ticket Triage & Resolution Bot',
        description: 'Auto-classify incoming customer service desk tickets and draft root-cause summaries',
        target_date: '2026-12-15',
        status: 'IN_PROGRESS',
        health_status: 'AT_RISK',
        progress_percent: 35,
        priority: 'P1'
      },
      {
        id: randomUUID(),
        portfolio_id: p3Id,
        name: 'SOC2 Type II Continuous Audit Evidence Collector',
        description: 'Automated cryptographic logging of admin access, session expirations, and permission changes',
        target_date: '2026-11-10',
        status: 'COMPLETED',
        health_status: 'COMPLETED',
        progress_percent: 100,
        priority: 'P0'
      },
      {
        id: randomUUID(),
        portfolio_id: p3Id,
        name: 'GDPR / DPDP Privacy & Consent Enforcement Portal',
        description: '100% full-width glassmorphic consent management and 50-event FIFO activity policy',
        target_date: '2026-11-25',
        status: 'IN_PROGRESS',
        health_status: 'ON_TRACK',
        progress_percent: 90,
        priority: 'P0'
      }
    ];

    for (const init of sampleInitiatives) {
      await d1Run(`
        INSERT INTO initiatives (
          id, workspace_id, portfolio_id, name, description, 
          target_date, status, health_status, progress_percent, 
          priority, owner_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        init.id, workspaceId, init.portfolio_id, init.name, init.description,
        init.target_date, init.status, init.health_status, init.progress_percent,
        init.priority, user.$id
      ], d1);
    }

    const sampleGoals = [
      {
        id: randomUUID(),
        name: 'Attain 99.99% Global Uptime Across All Core Services',
        description: 'Eliminate single points of failure via multi-region Edge CDN and automated health telemetry',
        key_result: 'Zero critical downtime incidents in Q4 2026',
        progress_percent: 88,
        status: 'ON_TRACK',
        target_date: '2026-12-31'
      },
      {
        id: randomUUID(),
        name: 'Achieve Google Cloud DORA Elite Performance Rating',
        description: 'Multiple daily releases, sub-1-day lead time, and sub-1-hour mean time to recovery',
        key_result: 'Maintain DORA Elite rating with < 5% change failure rate',
        progress_percent: 95,
        status: 'ON_TRACK',
        target_date: '2026-12-31'
      },
      {
        id: randomUUID(),
        name: 'Zero-Defect Security & Compliance Posture',
        description: 'Attain SOC2 Type II audit report with 100% adherence to encryption standards',
        key_result: 'Pass third-party penetration test and audit verification',
        progress_percent: 92,
        status: 'ON_TRACK',
        target_date: '2026-11-30'
      }
    ];

    for (const g of sampleGoals) {
      await d1Run(`
        INSERT INTO strategic_goals (
          id, workspace_id, name, description, target_date, 
          status, key_result, progress_percent, owner_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [
        g.id, workspaceId, g.name, g.description, g.target_date,
        g.status, g.key_result, g.progress_percent, user.$id
      ], d1);
    }

    await logActivity({
      workspaceId,
      actorId: user.$id,
      actorName: user.name || 'Executive',
      action: 'SEEDED_PORTFOLIO',
      targetId: workspaceId,
      targetName: 'Strategic Programs',
      details: 'Seeded 3 strategic portfolios, 7 initiatives, and 3 enterprise OKR goals',
    }, d1);

    return ctx.json({
      success: true,
      message: 'Executive strategic portfolio, initiatives, and OKR blueprint seeded.',
      portfoliosCount: samplePortfolios.length,
      initiativesCount: sampleInitiatives.length,
      goalsCount: sampleGoals.length
    });
  })

  // Global search & home (backward compatibility)
  .get('/global', sessionMiddleware, async (ctx) => {
    const workspaceId = ctx.req.query('workspaceId');
    const query = ctx.req.query('q') || '';
    const d1 = ctx.env?.DB || getD1Database();

    if (!workspaceId) return ctx.json({ error: 'workspaceId is required.' }, 400);

    const pattern = `%${query}%`;
    const issues = await d1All(`
      SELECT id, key, name, status, priority, issue_type FROM tasks
      WHERE workspace_id = ? AND (key LIKE ? OR name LIKE ? OR description LIKE ?)
      LIMIT 10
    `, [workspaceId, pattern, pattern, pattern], d1);

    const projects = await d1All(`
      SELECT id, key, name FROM projects
      WHERE workspace_id = ? AND (key LIKE ? OR name LIKE ?)
      LIMIT 5
    `, [workspaceId, pattern, pattern], d1);

    return ctx.json({
      data: {
        issues: issues.map(formatDoc),
        projects: projects.map(formatDoc),
        totalMatches: issues.length + projects.length
      }
    });
  })
  .get('/home', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');
    const d1 = ctx.env?.DB || getD1Database();

    const recentProjects = await d1All(`
      SELECT p.* FROM projects p
      JOIN members m ON p.workspace_id = m.workspace_id
      WHERE m.user_id = ? ${workspaceId ? 'AND p.workspace_id = ?' : ''}
      ORDER BY p.created_at DESC LIMIT 5
    `, workspaceId ? [user.$id, workspaceId] : [user.$id], d1);

    return ctx.json({
      data: {
        recentProjects: recentProjects.map(formatDoc)
      }
    });
  });

export default app;
