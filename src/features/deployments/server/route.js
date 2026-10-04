import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  .get('/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();
    const deployments = db.prepare(`
      SELECT d.*, u.name as deployer_name, r.name as release_name
      FROM deployments d
      LEFT JOIN users u ON d.deployed_by = u.id
      LEFT JOIN releases r ON d.version_id = r.id
      WHERE d.project_id = ?
      ORDER BY d.started_at DESC
    `).all(projectId);

    return ctx.json({ data: deployments.map(formatDoc) });
  })
  .post('/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const { environment = 'PRODUCTION', versionId = null, status = 'SUCCESS' } = await ctx.req.json();

    const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(projectId);
    if (!project) return ctx.json({ error: 'Project not found.' }, 404);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO deployments (id, project_id, workspace_id, version_id, environment, status, deployed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, project.workspace_id, versionId || null, environment, status, user.$id);

    logActivity({
      workspaceId: project.workspace_id,
      projectId,
      userId: user.$id,
      action: 'DEPLOYMENT_COMPLETED',
      details: `Deployed to ${environment} (${status})`,
    });

    return ctx.json({ success: true, id, environment, status });
  })
  .get('/dora/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    const totalDeployments = db.prepare(`
      SELECT COUNT(*) as c FROM deployments WHERE workspace_id = ?
    `).get(workspaceId).c;

    const failedDeployments = db.prepare(`
      SELECT COUNT(*) as c FROM deployments WHERE workspace_id = ? AND status = 'FAILED'
    `).get(workspaceId).c;

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
    const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
    if (!release) return ctx.json({ error: 'Release not found.' }, 404);

    const totalIssues = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?').get(release.workspace_id).c;
    const doneIssues = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND status = 'DONE'").get(release.workspace_id).c;
    const criticalBugs = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ? AND issue_type = 'Bug' AND priority = 'CRITICAL' AND status != 'DONE'").get(release.workspace_id).c;

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
