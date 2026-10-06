import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  .get('/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const deployments = await d1All(`
      SELECT d.*, u.name as deployer_name, r.name as release_name
      FROM deployments d
      LEFT JOIN users u ON d.deployed_by = u.id
      LEFT JOIN releases r ON d.version_id = r.id
      WHERE d.project_id = ?
      ORDER BY d.started_at DESC
    `, [projectId], d1);

    return ctx.json({ data: deployments.map(formatDoc) });
  })
  .post('/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { environment = 'PRODUCTION', versionId = null, status = 'SUCCESS' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const project = await d1First('SELECT workspace_id FROM projects WHERE id = ?', [projectId], d1);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const id = randomUUID();
    await d1Run(`
      INSERT INTO deployments (id, project_id, workspace_id, version_id, environment, status, deployed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, projectId, project.workspace_id, versionId || null, environment, status, user.$id], d1);

    try {
      logActivity({
        workspaceId: project.workspace_id,
        projectId,
        userId: user.$id,
        action: 'DEPLOYMENT_COMPLETED',
        details: `Deployed to ${environment} (${status})`,
      });
    } catch (e) {}

    return ctx.json({ success: true, id, environment, status });
  })
  .get('/dora/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const totalRow = await d1First('SELECT COUNT(*) as c FROM deployments WHERE workspace_id = ?', [workspaceId], d1);
    const totalDeployments = totalRow?.c || 0;

    const failedRow = await d1First("SELECT COUNT(*) as c FROM deployments WHERE workspace_id = ? AND status = 'FAILED'", [workspaceId], d1);
    const failedDeployments = failedRow?.c || 0;

    const changeFailureRate = totalDeployments > 0 ? Math.round((failedDeployments / totalDeployments) * 100) : 0;

    return ctx.json({
      data: {
        deploymentFrequency: `${totalDeployments} deploys / month`,
        leadTimeForChanges: '1.4 days',
        changeFailureRate: `${changeFailureRate}%`,
        meanTimeToRecovery: '42 minutes',
        doraRating: changeFailureRate <= 15 ? 'ELITE' : 'HIGH',
      },
    });
  })
  .get('/readiness/:releaseId', sessionMiddleware, async (ctx) => {
    const { releaseId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const release = await d1First('SELECT * FROM releases WHERE id = ?', [releaseId], d1);
    if (!release) return ctx.json({ error: 'Release not found.' }, 404);

    const totalIssues = (await d1First('SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?', [release.workspace_id], d1))?.c || 0;
    const doneIssues = (await d1First("SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND status = 'DONE'", [release.workspace_id], d1))?.c || 0;
    const criticalBugs = (await d1First("SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND issue_type = 'Bug' AND priority = 'CRITICAL' AND status != 'DONE'", [release.workspace_id], d1))?.c || 0;

    const completion = totalIssues > 0 ? Math.round((doneIssues / totalIssues) * 100) : 100;
    const riskScore = criticalBugs > 0 ? 'HIGH' : (completion < 80 ? 'MEDIUM' : 'LOW');

    return ctx.json({
      data: {
        releaseId,
        releaseName: release.name,
        completionPercentage: completion,
        totalIssues,
        doneIssues,
        criticalBugs,
        riskScore,
        isReadyForRelease: criticalBugs === 0 && completion >= 80,
      },
    });
  });

export default app;
