import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  // ==========================================
  // 1. Milestones
  // ==========================================
  .get('/milestones/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const milestones = await d1All(`
      SELECT m.*, u.name as owner_name
      FROM project_milestones m
      LEFT JOIN users u ON m.owner_id = u.id
      WHERE m.project_id = ?
      ORDER BY m.target_date ASC
    `, [projectId], d1);
    return ctx.json({ data: milestones.map(formatDoc) });
  })
  .post('/milestones/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { name, description = '', targetDate, status = 'PLANNED' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!name || !targetDate) return ctx.json({ error: 'Milestone name and targetDate are required.' }, 400);

    const project = await d1First('SELECT workspace_id FROM projects WHERE id = ?', [projectId], d1);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const id = randomUUID();
    await d1Run(`
      INSERT INTO project_milestones (id, project_id, workspace_id, name, description, target_date, status, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, projectId, project.workspace_id, name, description, targetDate, status, user.$id], d1);

    return ctx.json({ success: true, id, name, targetDate, status });
  })
  .patch('/milestones/item/:milestoneId', sessionMiddleware, async (ctx) => {
    const { milestoneId } = ctx.req.param();
    const { status, name, description, targetDate } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const existing = await d1First('SELECT * FROM project_milestones WHERE id = ?', [milestoneId], d1);
    if (!existing) return ctx.json({ error: 'Milestone not found.' }, 404);

    const updatedStatus = status || existing.status;
    const updatedName = name || existing.name;
    const updatedDesc = description !== undefined ? description : existing.description;
    const updatedTarget = targetDate || existing.target_date;

    await d1Run(`
      UPDATE project_milestones
      SET status = ?, name = ?, description = ?, target_date = ?
      WHERE id = ?
    `, [updatedStatus, updatedName, updatedDesc, updatedTarget, milestoneId], d1);

    return ctx.json({ success: true, id: milestoneId, status: updatedStatus });
  })
  .delete('/milestones/item/:milestoneId', sessionMiddleware, async (ctx) => {
    const { milestoneId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await d1Run('DELETE FROM project_milestones WHERE id = ?', [milestoneId], d1);
    return ctx.json({ success: true, id: milestoneId });
  })

  // ==========================================
  // 2. Project Health Engine (Project & Workspace level)
  // ==========================================
  .get('/health/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const project = await d1First('SELECT * FROM projects WHERE id = ?', [projectId], d1);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const openTasks = (await d1First("SELECT COUNT(*) as c FROM tasks WHERE project_id = ? AND status != 'DONE'", [projectId], d1))?.c || 0;
    const completedTasks = (await d1First("SELECT COUNT(*) as c FROM tasks WHERE project_id = ? AND status = 'DONE'", [projectId], d1))?.c || 0;
    const totalTasks = openTasks + completedTasks;

    const criticalBugs = (await d1First(`
      SELECT COUNT(*) as c FROM tasks 
      WHERE project_id = ? AND issue_type = 'Bug' AND priority IN ('CRITICAL', 'HIGHEST', 'P0') AND status != 'DONE'
    `, [projectId], d1))?.c || 0;

    const openRisks = (await d1First(`
      SELECT COUNT(*) as c FROM project_risks WHERE project_id = ? AND status = 'OPEN' AND severity IN ('HIGH', 'CRITICAL')
    `, [projectId], d1))?.c || 0;

    const pendingApprovals = (await d1First(`
      SELECT COUNT(*) as c FROM approval_requests WHERE project_id = ? AND status = 'PENDING'
    `, [projectId], d1))?.c || 0;

    let overallHealth = 'GREEN';
    const issuesList = [];

    if (criticalBugs > 0) {
      overallHealth = 'RED';
      issuesList.push(`${criticalBugs} critical blocking bugs detected`);
    }
    if (openRisks > 0) {
      if (overallHealth === 'GREEN') overallHealth = 'AMBER';
      issuesList.push(`${openRisks} high-severity open risks logged`);
    }
    if (pendingApprovals > 2) {
      if (overallHealth === 'GREEN') overallHealth = 'AMBER';
      issuesList.push(`${pendingApprovals} change approvals pending sign-off`);
    }

    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 100;

    return ctx.json({
      data: {
        projectId,
        projectName: project.name,
        overallHealth,
        completionRate,
        totalTasks,
        openTasks,
        completedTasks,
        criticalBugs,
        openRisks,
        pendingApprovals,
        reasons: issuesList,
      },
    });
  })
  .get('/health-workspace/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const openTasks = (await d1First("SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND status != 'DONE'", [workspaceId], d1))?.c || 0;
    const completedTasks = (await d1First("SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND status = 'DONE'", [workspaceId], d1))?.c || 0;
    const totalTasks = openTasks + completedTasks;

    const criticalBugs = (await d1First(`
      SELECT COUNT(*) as c FROM tasks 
      WHERE workspace_id = ? AND issue_type = 'Bug' AND priority IN ('CRITICAL', 'HIGHEST', 'P0') AND status != 'DONE'
    `, [workspaceId], d1))?.c || 0;

    const openRisks = (await d1First(`
      SELECT COUNT(*) as c FROM project_risks WHERE workspace_id = ? AND status = 'OPEN' AND severity IN ('HIGH', 'CRITICAL')
    `, [workspaceId], d1))?.c || 0;

    const pendingApprovals = (await d1First(`
      SELECT COUNT(*) as c FROM approval_requests WHERE workspace_id = ? AND status = 'PENDING'
    `, [workspaceId], d1))?.c || 0;

    let overallHealth = 'GREEN';
    const issuesList = [];

    if (criticalBugs > 0) {
      overallHealth = 'RED';
      issuesList.push(`${criticalBugs} critical blocking bugs detected`);
    }
    if (openRisks > 0) {
      if (overallHealth === 'GREEN') overallHealth = 'AMBER';
      issuesList.push(`${openRisks} high-severity open risks across projects`);
    }
    if (pendingApprovals > 3) {
      if (overallHealth === 'GREEN') overallHealth = 'AMBER';
      issuesList.push(`${pendingApprovals} approval requests pending sign-off`);
    }

    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 100;

    return ctx.json({
      data: {
        workspaceId,
        overallHealth,
        completionRate,
        totalTasks,
        openTasks,
        completedTasks,
        criticalBugs,
        openRisks,
        pendingApprovals,
        reasons: issuesList,
      },
    });
  })

  // ==========================================
  // 3. Risks & Risk Matrix
  // ==========================================
  .get('/risks/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const risks = await d1All(`
      SELECT r.*, u.name as owner_name
      FROM project_risks r
      LEFT JOIN users u ON r.owner_id = u.id
      WHERE r.project_id = ?
      ORDER BY r.created_at DESC
    `, [projectId], d1);
    return ctx.json({ data: risks.map(formatDoc) });
  })
  .post('/risks/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { title, description = '', probability = 'MEDIUM', impact = 'MEDIUM', mitigation = '', dueDate = null } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!title) return ctx.json({ error: 'Risk title is required.' }, 400);

    const project = await d1First('SELECT workspace_id FROM projects WHERE id = ?', [projectId], d1);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    let severity = 'MEDIUM';
    if (probability === 'HIGH' && impact === 'HIGH') severity = 'CRITICAL';
    else if (probability === 'HIGH' || impact === 'HIGH') severity = 'HIGH';
    else if (probability === 'LOW' && impact === 'LOW') severity = 'LOW';

    const id = randomUUID();
    await d1Run(`
      INSERT INTO project_risks (id, project_id, workspace_id, title, description, probability, impact, severity, mitigation, status, owner_id, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `, [id, projectId, project.workspace_id, title, description, probability, impact, severity, mitigation, user.$id, dueDate], d1);

    return ctx.json({ success: true, id, title, severity, probability, impact });
  })
  .patch('/risks/item/:riskId', sessionMiddleware, async (ctx) => {
    const { riskId } = ctx.req.param();
    const { status, mitigation, probability, impact } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const existing = await d1First('SELECT * FROM project_risks WHERE id = ?', [riskId], d1);
    if (!existing) return ctx.json({ error: 'Risk item not found.' }, 404);

    const updatedProb = probability || existing.probability;
    const updatedImpact = impact || existing.impact;
    let severity = existing.severity;

    if (probability || impact) {
      if (updatedProb === 'HIGH' && updatedImpact === 'HIGH') severity = 'CRITICAL';
      else if (updatedProb === 'HIGH' || updatedImpact === 'HIGH') severity = 'HIGH';
      else if (updatedProb === 'LOW' && updatedImpact === 'LOW') severity = 'LOW';
      else severity = 'MEDIUM';
    }

    const updatedStatus = status || existing.status;
    const updatedMitigation = mitigation !== undefined ? mitigation : existing.mitigation;

    await d1Run(`
      UPDATE project_risks
      SET status = ?, mitigation = ?, probability = ?, impact = ?, severity = ?
      WHERE id = ?
    `, [updatedStatus, updatedMitigation, updatedProb, updatedImpact, severity, riskId], d1);

    return ctx.json({ success: true, id: riskId, status: updatedStatus, severity });
  })
  .delete('/risks/item/:riskId', sessionMiddleware, async (ctx) => {
    const { riskId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await d1Run('DELETE FROM project_risks WHERE id = ?', [riskId], d1);
    return ctx.json({ success: true, id: riskId });
  })

  // ==========================================
  // 4. Decisions & ADRs (Architecture Decision Records)
  // ==========================================
  .get('/decisions/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const decisions = await d1All(`
      SELECT d.*, u.name as decided_by_name
      FROM project_decisions d
      LEFT JOIN users u ON d.decided_by = u.id
      WHERE d.project_id = ?
      ORDER BY d.decided_at DESC
    `, [projectId], d1);
    return ctx.json({ data: decisions.map(formatDoc) });
  })
  .post('/decisions/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { title, decision, reason = '', description = '' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!title || !decision) return ctx.json({ error: 'Title and decision are required.' }, 400);

    const project = await d1First('SELECT workspace_id FROM projects WHERE id = ?', [projectId], d1);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const id = randomUUID();
    await d1Run(`
      INSERT INTO project_decisions (id, project_id, workspace_id, title, description, decision, reason, decided_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED')
    `, [id, projectId, project.workspace_id, title, description, decision, reason, user.$id], d1);

    return ctx.json({ success: true, id, title, decision });
  })
  .delete('/decisions/item/:decisionId', sessionMiddleware, async (ctx) => {
    const { decisionId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await d1Run('DELETE FROM project_decisions WHERE id = ?', [decisionId], d1);
    return ctx.json({ success: true, id: decisionId });
  })

  // ==========================================
  // 5. Change Approvals & Gatekeeping Engine
  // ==========================================
  .get('/approvals/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const { projectId } = ctx.req.query();
    const d1 = ctx.env?.DB || getD1Database();

    let query = `
      SELECT a.*, 
             u.name as requester_name, 
             u.email as requester_email,
             app.name as approver_name,
             p.name as project_name
      FROM approval_requests a
      LEFT JOIN users u ON a.requested_by = u.id
      LEFT JOIN users app ON a.approver_id = app.id
      LEFT JOIN projects p ON a.project_id = p.id
      WHERE a.workspace_id = ?
    `;
    const params = [workspaceId];

    if (projectId && projectId !== 'ALL') {
      query += ' AND (a.project_id = ? OR a.project_id IS NULL)';
      params.push(projectId);
    }

    query += ' ORDER BY a.created_at DESC';

    const approvals = await d1All(query, params, d1);
    return ctx.json({ data: approvals.map(formatDoc) });
  })
  .post('/approvals/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { resourceType, resourceId, reason = '', projectId = null, title = '' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!resourceType || !resourceId) return ctx.json({ error: 'resourceType and resourceId are required.' }, 400);

    const fullReason = title ? `[${title}] ${reason}` : reason;
    const id = randomUUID();
    await d1Run(`
      INSERT INTO approval_requests (id, workspace_id, project_id, resource_type, resource_id, requested_by, status, reason)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `, [id, workspaceId, projectId, resourceType, resourceId, user.$id, fullReason], d1);

    await logActivity(
      workspaceId,
      user,
      'SUBMITTED_APPROVAL_REQUEST',
      `Submitted change approval request for ${resourceType} (${resourceId})`,
      d1
    ).catch(() => {});

    return ctx.json({ success: true, id, resourceType, status: 'PENDING' });
  })
  .patch('/approvals/item/:approvalId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { approvalId } = ctx.req.param();
    const { status, reviewNotes = '' } = await ctx.req.json(); // APPROVED, REJECTED
    const d1 = ctx.env?.DB || getD1Database();

    const existing = await d1First('SELECT * FROM approval_requests WHERE id = ?', [approvalId], d1);
    if (!existing) return ctx.json({ error: 'Approval request not found.' }, 404);

    const updatedReason = reviewNotes
      ? `${existing.reason || ''} [Verdict Notes by ${user.name || 'Admin'}: ${reviewNotes}]`
      : existing.reason;

    await d1Run(`
      UPDATE approval_requests
      SET status = ?, approver_id = ?, reason = ?, decided_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [status, user.$id, updatedReason, approvalId], d1);

    await logActivity(
      existing.workspace_id,
      user,
      `APPROVAL_${status}`,
      `${status === 'APPROVED' ? 'Approved' : 'Rejected'} change request ${existing.resource_type} (${existing.resource_id})`,
      d1
    ).catch(() => {});

    return ctx.json({ success: true, status, id: approvalId });
  })
  .delete('/approvals/item/:approvalId', sessionMiddleware, async (ctx) => {
    const { approvalId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await d1Run('DELETE FROM approval_requests WHERE id = ?', [approvalId], d1);
    return ctx.json({ success: true, id: approvalId });
  });

export default app;
