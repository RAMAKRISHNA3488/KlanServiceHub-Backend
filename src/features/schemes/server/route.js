import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/issue-types/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const schemes = db.prepare('SELECT * FROM issue_type_schemes WHERE workspace_id = ?').all(workspaceId);
    return ctx.json({
      data: schemes.map((s) => ({
        ...formatDoc(s),
        issueTypes: JSON.parse(s.issue_types || '[]'),
      })),
    });
  })
  .post('/issue-types/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const { name, description = '', defaultIssueType = 'Task', issueTypes = ['Epic', 'Story', 'Task', 'Bug', 'Sub-task'] } = await ctx.req.json();

    if (!name) return ctx.json({ error: 'Scheme name is required.' }, 400);

    const schemeId = randomUUID();
    db.prepare(`
      INSERT INTO issue_type_schemes (id, workspace_id, name, description, default_issue_type, issue_types)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(schemeId, workspaceId, name, description, defaultIssueType, JSON.stringify(issueTypes));

    return ctx.json({
      success: true,
      data: {
        id: schemeId,
        name,
        defaultIssueType,
        issueTypes,
      },
    });
  })
  .get('/priorities/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const schemes = db.prepare('SELECT * FROM priority_schemes WHERE workspace_id = ?').all(workspaceId);
    return ctx.json({
      data: schemes.map((s) => ({
        ...formatDoc(s),
        priorities: JSON.parse(s.priorities || '[]'),
      })),
    });
  })
  .post('/priorities/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const { name, description = '', defaultPriority = 'MEDIUM', priorities = ['LOWEST', 'LOW', 'MEDIUM', 'HIGH', 'HIGHEST', 'CRITICAL'] } = await ctx.req.json();

    if (!name) return ctx.json({ error: 'Priority scheme name is required.' }, 400);

    const schemeId = randomUUID();
    db.prepare(`
      INSERT INTO priority_schemes (id, workspace_id, name, description, default_priority, priorities)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(schemeId, workspaceId, name, description, defaultPriority, JSON.stringify(priorities));

    return ctx.json({
      success: true,
      data: {
        id: schemeId,
        name,
        defaultPriority,
        priorities,
      },
    });
  });

export default app;
