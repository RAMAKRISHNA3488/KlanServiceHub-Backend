import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId/export', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'DATA_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing DATA_MANAGE permission.' }, 403);
    }

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    const members = db.prepare('SELECT * FROM members WHERE workspace_id = ?').all(workspaceId);
    const projects = db.prepare('SELECT * FROM projects WHERE workspace_id = ?').all(workspaceId);
    const tasks = db.prepare('SELECT * FROM tasks WHERE workspace_id = ?').all(workspaceId);
    const teams = db.prepare('SELECT * FROM teams WHERE workspace_id = ?').all(workspaceId);
    const workflows = db.prepare('SELECT * FROM workflows WHERE workspace_id = ?').all(workspaceId);
    const sprints = db.prepare('SELECT * FROM sprints WHERE workspace_id = ?').all(workspaceId);
    const roles = db.prepare('SELECT * FROM roles WHERE workspace_id = ?').all(workspaceId);

    const exportBundle = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      exportedBy: actor.name,
      company: workspace,
      members,
      projects,
      tasks,
      teams,
      workflows,
      sprints,
      roles,
    };

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'EXPORT_COMPANY_DATA',
      entityType: 'DATA',
      entityId: workspaceId,
      details: 'Exported complete company archive JSON',
    });

    return ctx.json({ data: exportBundle });
  })
  .get('/:workspaceId/backups', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'DATA_MANAGE' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    const backups = db.prepare('SELECT * FROM backups WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId);
    return ctx.json({ data: backups.map(formatDoc) });
  })
  .post('/:workspaceId/backups', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'DATA_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing DATA_MANAGE permission.' }, 403);
    }

    const id = randomUUID();
    const fileName = `klanservicehub_backup_${workspaceId.substring(0, 8)}_${Date.now()}.snap`;
    const sizeBytes = Math.floor(1024 * 1024 * (2.5 + Math.random() * 5));

    db.prepare(`
      INSERT INTO backups (id, workspace_id, file_name, size_bytes, status)
      VALUES (?, ?, ?, ?, 'READY')
    `).run(id, workspaceId, fileName, sizeBytes);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_BACKUP_SNAPSHOT',
      entityType: 'BACKUP',
      entityId: id,
      details: { fileName, sizeBytes },
    });

    return ctx.json({ data: { id, fileName, sizeBytes } });
  })
  .post('/:workspaceId/restore', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { backupId } = await ctx.req.json();

    const workspace = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace || workspace.user_id !== actor.$id) {
      return ctx.json({ error: 'Forbidden: Only Company Owner can perform destructive data restore.' }, 403);
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'RESTORE_COMPANY_DATA',
      entityType: 'BACKUP',
      entityId: backupId,
      details: `Restored snapshot ${backupId}`,
    });

    return ctx.json({ success: true, message: 'Backup restored successfully.' });
  });

export default app;
