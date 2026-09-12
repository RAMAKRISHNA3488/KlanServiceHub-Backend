import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, triggerAutomations } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const projectId = ctx.req.query('projectId');

    let query = 'SELECT * FROM sprints WHERE workspace_id = ?';
    const params = [workspaceId];
    if (projectId) {
      query += ' AND (project_id = ? OR project_id IS NULL)';
      params.push(projectId);
    }
    query += ' ORDER BY created_at DESC';

    const sprints = db.prepare(query).all(...params);

    const sprintsWithTasks = sprints.map((sprint) => {
      const tasks = db.prepare(`
        SELECT t.*, p.name as project_name, u.name as assignee_name, u.avatar_url as assignee_avatar
        FROM tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN members m ON t.assignee_id = m.id
        LEFT JOIN users u ON m.user_id = u.id
        WHERE t.sprint_id = ?
        ORDER BY t.position ASC
      `).all(sprint.id);

      const totalPoints = tasks.length;
      const completedPoints = tasks.filter((t) => t.status === 'DONE').length;

      return {
        ...formatDoc(sprint),
        tasks: tasks.map(formatDoc),
        taskCount: tasks.length,
        completedCount: completedPoints,
        progressPercent: totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0,
      };
    });

    // Backlog tasks (no sprint_id)
    let backlogQuery = `
      SELECT t.*, p.name as project_name, u.name as assignee_name, u.avatar_url as assignee_avatar
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN members m ON t.assignee_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      WHERE t.workspace_id = ? AND (t.sprint_id IS NULL OR t.sprint_id = '')
    `;
    const backlogParams = [workspaceId];
    if (projectId) {
      backlogQuery += ' AND t.project_id = ?';
      backlogParams.push(projectId);
    }
    backlogQuery += ' ORDER BY t.position ASC';

    const backlogTasks = db.prepare(backlogQuery).all(...backlogParams).map(formatDoc);

    return ctx.json({
      data: {
        sprints: sprintsWithTasks,
        backlog: backlogTasks,
      },
    });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, goal = '', projectId = null, startDate = null, endDate = null, status = 'FUTURE' } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SPRINT_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing SPRINT_MANAGE permission.' }, 403);
    }

    const sprintId = randomUUID();
    const finalStatus = (status || 'FUTURE').toUpperCase();
    db.prepare(`
      INSERT INTO sprints (id, workspace_id, project_id, name, goal, start_date, end_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sprintId, workspaceId, projectId, name, goal, startDate, endDate, finalStatus);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_SPRINT',
      entityType: 'SPRINT',
      entityId: sprintId,
      details: { name, goal, status: finalStatus },
    });

    return ctx.json({ data: { id: sprintId, name, status: finalStatus } });
  })
  .patch('/:workspaceId/:sprintId/start', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, sprintId } = ctx.req.param();
    const { startDate, endDate } = await ctx.req.json().catch(() => ({}));

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SPRINT_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing SPRINT_MANAGE permission.' }, 403);
    }

    db.prepare(`
      UPDATE sprints 
      SET status = 'ACTIVE', 
          start_date = COALESCE(?, start_date, datetime('now')),
          end_date = COALESCE(?, end_date, datetime('now', '+14 days')),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?
    `).run(startDate || null, endDate || null, sprintId, workspaceId);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'START_SPRINT',
      entityType: 'SPRINT',
      entityId: sprintId,
      details: 'Sprint started',
    });

    return ctx.json({ success: true, status: 'ACTIVE' });
  })
  .patch('/:workspaceId/:sprintId/complete', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, sprintId } = ctx.req.param();
    const { moveToSprintId = null } = await ctx.req.json().catch(() => ({}));

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SPRINT_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing SPRINT_MANAGE permission.' }, 403);
    }

    db.prepare(`
      UPDATE sprints 
      SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?
    `).run(sprintId, workspaceId);

    // Move incomplete tasks (status != DONE)
    if (moveToSprintId) {
      db.prepare(`
        UPDATE tasks SET sprint_id = ? WHERE sprint_id = ? AND status != 'DONE'
      `).run(moveToSprintId, sprintId);
    } else {
      db.prepare(`
        UPDATE tasks SET sprint_id = NULL WHERE sprint_id = ? AND status != 'DONE'
      `).run(sprintId);
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'COMPLETE_SPRINT',
      entityType: 'SPRINT',
      entityId: sprintId,
      details: 'Sprint completed',
    });

    return ctx.json({ success: true, status: 'CLOSED' });
  })
  .post('/:workspaceId/move-task', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { taskId, sprintId = null } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'ISSUE_EDIT' })) {
      return ctx.json({ error: 'Forbidden.' }, 403);
    }

    db.prepare('UPDATE tasks SET sprint_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?')
      .run(sprintId, taskId, workspaceId);

    return ctx.json({ success: true, taskId, sprintId });
  })
  .patch('/:workspaceId/:sprintId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, sprintId } = ctx.req.param();
    const { name, goal, startDate, endDate, status, projectId } = await ctx.req.json();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SPRINT_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing SPRINT_MANAGE permission.' }, 403);
    }

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (goal !== undefined) { updates.push('goal = ?'); params.push(goal); }
    if (startDate !== undefined) { updates.push('start_date = ?'); params.push(startDate); }
    if (endDate !== undefined) { updates.push('end_date = ?'); params.push(endDate); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (projectId !== undefined) { updates.push('project_id = ?'); params.push(projectId); }

    if (updates.length === 0) {
      return ctx.json({ error: 'No fields to update.' }, 400);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(sprintId, workspaceId);

    db.prepare(`
      UPDATE sprints 
      SET ${updates.join(', ')} 
      WHERE id = ? AND workspace_id = ?
    `).run(...params);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_SPRINT',
      entityType: 'SPRINT',
      entityId: sprintId,
      details: { name, goal, status, startDate, endDate },
    });

    const updated = db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId);
    return ctx.json({ data: formatDoc(updated) });
  })
  .delete('/:workspaceId/:sprintId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, sprintId } = ctx.req.param();

    if (!hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'SPRINT_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing SPRINT_MANAGE permission.' }, 403);
    }

    // Release all tasks back to backlog
    db.prepare('UPDATE tasks SET sprint_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE sprint_id = ? AND workspace_id = ?')
      .run(sprintId, workspaceId);

    // Delete sprint
    db.prepare('DELETE FROM sprints WHERE id = ? AND workspace_id = ?')
      .run(sprintId, workspaceId);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'DELETE_SPRINT',
      entityType: 'SPRINT',
      entityId: sprintId,
      details: 'Sprint deleted',
    });

    return ctx.json({ success: true, id: sprintId });
  });

export default app;
