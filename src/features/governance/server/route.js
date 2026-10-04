import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  // Milestones
  .get('/milestones/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const milestones = db.prepare(`
      SELECT m.*, u.name as owner_name
      FROM project_milestones m
      LEFT JOIN users u ON m.owner_id = u.id
      WHERE m.project_id = ?
      ORDER BY m.target_date ASC
    `).all(projectId);
    return ctx.json({ data: milestones.map(formatDoc) });
  })
  .post('/milestones/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { name, description = '', targetDate, status = 'PLANNED' } = await ctx.req.json();

    if (!name || !targetDate) return ctx.json({ error: 'Milestone name and targetDate are required.' }, 400);

    const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(projectId);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO project_milestones (id, project_id, workspace_id, name, description, target_date, status, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, project.workspace_id, name, description, targetDate, status, user.$id);

    return ctx.json({ success: true, id, name, targetDate, status });
  })

  // Project Health Engine
  .get('/health/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const openTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE project_id = ? AND status != 'DONE'").get(projectId).c;
    const completedTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE project_id = ? AND status = 'DONE'").get(projectId).c;
    const totalTasks = openTasks + completedTasks;

    const criticalBugs = db.prepare(`
      SELECT COUNT(*) as c FROM tasks 
      WHERE project_id = ? AND issue_type = 'Bug' AND priority IN ('CRITICAL', 'HIGHEST') AND status != 'DONE'
    `).get(projectId).c;

    const openRisks = db.prepare(`
      SELECT COUNT(*) as c FROM project_risks WHERE project_id = ? AND status = 'OPEN' AND severity IN ('HIGH', 'CRITICAL')
    `).get(projectId).c;

    let overallHealth = 'GREEN';
    const issuesList = [];

    if (criticalBugs > 0) {
      overallHealth = 'RED';
      issuesList.push(`${criticalBugs} critical blocking bugs detected`);
    }
    if (openRisks > 0) {
      if (overallHealth === 'GREEN') overallHealth = 'AMBER';
      issuesList.push(`${openRisks} high severity open risks logged`);
    }

    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 100;

    return ctx.json({
      data: {
        projectId,
        overallHealth,
        completionRate,
        totalTasks,
        openTasks,
        completedTasks,
        criticalBugs,
        openRisks,
        reasons: issuesList,
      },
    });
  })

  // Risks
  .get('/risks/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const risks = db.prepare('SELECT * FROM project_risks WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
    return ctx.json({ data: risks.map(formatDoc) });
  })
  .post('/risks/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { title, description = '', probability = 'MEDIUM', impact = 'MEDIUM', mitigation = '' } = await ctx.req.json();

    if (!title) return ctx.json({ error: 'Risk title is required.' }, 400);

    const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(projectId);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    let severity = 'MEDIUM';
    if (probability === 'HIGH' && impact === 'HIGH') severity = 'CRITICAL';
    else if (probability === 'HIGH' || impact === 'HIGH') severity = 'HIGH';
    else if (probability === 'LOW' && impact === 'LOW') severity = 'LOW';

    const id = randomUUID();
    db.prepare(`
      INSERT INTO project_risks (id, project_id, workspace_id, title, description, probability, impact, severity, mitigation, status, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `).run(id, projectId, project.workspace_id, title, description, probability, impact, severity, mitigation, user.$id);

    return ctx.json({ success: true, id, title, severity, probability, impact });
  })

  // Decisions
  .get('/decisions/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const decisions = db.prepare(`
      SELECT d.*, u.name as decided_by_name
      FROM project_decisions d
      JOIN users u ON d.decided_by = u.id
      WHERE d.project_id = ?
      ORDER BY d.decided_at DESC
    `).all(projectId);
    return ctx.json({ data: decisions.map(formatDoc) });
  })
  .post('/decisions/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { title, decision, reason = '' } = await ctx.req.json();

    if (!title || !decision) return ctx.json({ error: 'Title and decision are required.' }, 400);

    const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(projectId);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO project_decisions (id, project_id, workspace_id, title, decision, reason, decided_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED')
    `).run(id, projectId, project.workspace_id, title, decision, reason, user.$id);

    return ctx.json({ success: true, id, title, decision });
  })

  // Approvals
  .get('/approvals/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const approvals = db.prepare(`
      SELECT a.*, u.name as requester_name
      FROM approval_requests a
      JOIN users u ON a.requested_by = u.id
      WHERE a.workspace_id = ?
      ORDER BY a.created_at DESC
    `).all(workspaceId);
    return ctx.json({ data: approvals.map(formatDoc) });
  })
  .post('/approvals/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { resourceType, resourceId, reason = '' } = await ctx.req.json();

    if (!resourceType || !resourceId) return ctx.json({ error: 'resourceType and resourceId are required.' }, 400);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO approval_requests (id, workspace_id, resource_type, resource_id, requested_by, status, reason)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(id, workspaceId, resourceType, resourceId, user.$id, reason);

    return ctx.json({ success: true, id, resourceType, status: 'PENDING' });
  })
  .patch('/approvals/item/:approvalId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { approvalId } = ctx.req.param();
    const { status } = await ctx.req.json(); // APPROVED, REJECTED

    db.prepare(`
      UPDATE approval_requests
      SET status = ?, approver_id = ?, decided_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, user.$id, approvalId);

    return ctx.json({ success: true, status });
  });

export default app;
