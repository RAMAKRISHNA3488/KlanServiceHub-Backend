import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const projectId = ctx.req.query('projectId');

    let query = 'SELECT * FROM releases WHERE workspace_id = ?';
    const params = [workspaceId];
    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }
    query += ' ORDER BY created_at DESC';

    const releases = db.prepare(query).all(...params);

    const releasesWithStats = releases.map((rel) => {
      const tasks = db.prepare('SELECT status FROM tasks WHERE release_id = ?').all(rel.id);
      const total = tasks.length;
      const done = tasks.filter((t) => t.status === 'DONE').length;
      return {
        ...formatDoc(rel),
        totalIssues: total,
        completedIssues: done,
        progressPercent: total > 0 ? Math.round((done / total) * 100) : 0,
      };
    });

    return ctx.json({ data: releasesWithStats });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', projectId = null, releaseDate = null } = await ctx.req.json();

    if (!name) return ctx.json({ error: 'Release name is required.' }, 400);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO releases (id, workspace_id, project_id, name, description, release_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'UNRELEASED')
    `).run(id, workspaceId, projectId, name, description, releaseDate);

    logAudit({
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

    db.prepare(`
      UPDATE releases 
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          status = COALESCE(?, status),
          release_date = COALESCE(?, release_date)
      WHERE id = ? AND workspace_id = ?
    `).run(name ?? null, description ?? null, status ?? null, releaseDate ?? null, id, workspaceId);

    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/:id', sessionMiddleware, async (ctx) => {
    const { workspaceId, id } = ctx.req.param();
    db.prepare('DELETE FROM releases WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
    return ctx.json({ success: true });
  });

export default app;
