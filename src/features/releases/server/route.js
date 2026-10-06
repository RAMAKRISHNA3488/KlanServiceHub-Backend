import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, d1All, d1First, d1Run, getD1Database } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const projectId = ctx.req.query('projectId');
    const d1 = ctx.env?.DB || getD1Database();

    let query = 'SELECT * FROM releases WHERE workspace_id = ?';
    const params = [workspaceId];
    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }
    query += ' ORDER BY created_at DESC';

    const releases = await d1All(query, params, d1);

    const releasesWithStats = await Promise.all(releases.map(async (rel) => {
      const tasks = await d1All('SELECT status FROM tasks WHERE release_id = ?', [rel.id], d1);
      const total = tasks.length;
      const done = tasks.filter((t) => t.status === 'DONE').length;
      return {
        ...formatDoc(rel),
        totalIssues: total,
        completedIssues: done,
        progressPercent: total > 0 ? Math.round((done / total) * 100) : 0,
      };
    }));

    return ctx.json({ data: releasesWithStats });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', projectId = null, releaseDate = null } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!name) return ctx.json({ error: 'Release name is required.' }, 400);

    const id = randomUUID();
    await d1Run(`
      INSERT INTO releases (id, workspace_id, project_id, name, description, release_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'UNRELEASED')
    `, [id, workspaceId, projectId, name, description, releaseDate], d1);

    await logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_RELEASE',
      entityType: 'RELEASE',
      entityId: id,
      details: { name },
    });

    return ctx.json({ data: { id, name, status: 'UNRELEASED' } });
  })
  .patch('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, id } = ctx.req.param();
    const { name, description, status, releaseDate } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    await d1Run(`
      UPDATE releases 
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          status = COALESCE(?, status),
          release_date = COALESCE(?, release_date)
      WHERE id = ? AND workspace_id = ?
    `, [name ?? null, description ?? null, status ?? null, releaseDate ?? null, id, workspaceId], d1);

    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const { workspaceId, id } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await d1Run('DELETE FROM releases WHERE id = ? AND workspace_id = ?', [id, workspaceId], d1);
    return ctx.json({ success: true });
  });

export default app;
