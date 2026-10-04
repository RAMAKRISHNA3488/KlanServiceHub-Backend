import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { getMember } from '../../members/utils.js';
import { createTaskSchema } from '../schema.js';
import { TaskStatus } from '../types.js';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, logActivity, createNotification, triggerAutomations } from '../../../db.js';
import { broadcastWorkspaceEvent } from '../../../lib/events.js';
import { getNextTaskKeyForProject } from '../../../lib/issue-key.js';

function attachAssigneesToTasks(tasks) {
  if (!tasks || tasks.length === 0) return tasks;
  const taskIds = tasks.map((t) => t.$id || t.id).filter(Boolean);
  if (taskIds.length === 0) return tasks;

  const placeholders = taskIds.map(() => '?').join(',');
  let assigneeRows = [];
  try {
    assigneeRows = db.prepare(`
      SELECT ta.task_id, m.id as member_id, m.role as member_role, m.workspace_id as member_workspace_id, m.user_id,
             u.name as user_name, u.email as user_email, u.avatar_url as user_avatar
      FROM task_assignees ta
      JOIN members m ON ta.member_id = m.id
      JOIN users u ON m.user_id = u.id
      WHERE ta.task_id IN (${placeholders})
    `).all(...taskIds);
  } catch (err) {}

  const assigneesByTaskId = {};
  for (const row of assigneeRows) {
    if (!assigneesByTaskId[row.task_id]) {
      assigneesByTaskId[row.task_id] = [];
    }
    assigneesByTaskId[row.task_id].push({
      $id: row.member_id,
      id: row.member_id,
      role: row.member_role,
      workspaceId: row.member_workspace_id,
      userId: row.user_id,
      name: row.user_name,
      email: row.user_email,
      avatarUrl: row.user_avatar,
    });
  }

  for (const task of tasks) {
    const taskId = task.$id || task.id;
    const taskAssignees = assigneesByTaskId[taskId] || [];
    if (taskAssignees.length > 0) {
      task.assignees = taskAssignees;
      task.assigneeIds = taskAssignees.map((a) => a.$id);
      task.assignee = taskAssignees[0];
    } else if (task.assignee) {
      task.assignees = [task.assignee];
      task.assigneeIds = [task.assignee.$id || task.assignee.id];
    } else {
      task.assignees = [];
      task.assigneeIds = [];
      task.assignee = null;
    }
  }

  return tasks;
}

function attachAssigneesToTask(task) {
  if (!task) return task;
  const taskId = task.$id || task.id;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT m.id as member_id, m.role as member_role, m.workspace_id as member_workspace_id, m.user_id,
             u.name as user_name, u.email as user_email, u.avatar_url as user_avatar
      FROM task_assignees ta
      JOIN members m ON ta.member_id = m.id
      JOIN users u ON m.user_id = u.id
      WHERE ta.task_id = ?
    `).all(taskId);
  } catch (err) {}

  if (rows.length > 0) {
    task.assignees = rows.map((r) => ({
      $id: r.member_id,
      id: r.member_id,
      role: r.member_role,
      workspaceId: r.member_workspace_id,
      userId: r.user_id,
      name: r.user_name,
      email: r.user_email,
      avatarUrl: r.user_avatar,
    }));
    task.assigneeIds = task.assignees.map((a) => a.$id);
    task.assignee = task.assignees[0];
  } else if (task.assignee) {
    task.assignees = [task.assignee];
    task.assigneeIds = [task.assignee.$id || task.assignee.id];
  } else {
    task.assignees = [];
    task.assigneeIds = [];
    task.assignee = null;
  }
  return task;
}

const app = new Hono()
  .get('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');
    const projectId = ctx.req.query('projectId');
    const assigneeId = ctx.req.query('assigneeId');
    const status = ctx.req.query('status');
    const search = ctx.req.query('search');
    const dueDate = ctx.req.query('dueDate');
    const sprintId = ctx.req.query('sprintId');
    const issueType = ctx.req.query('issueType');

    if (!workspaceId) {
      return ctx.json({ error: 'Workspace ID required' }, 400);
    }

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    let query = `
      SELECT t.*, 
             p.id as p_id, p.name as p_name, p.key as p_key, p.image_url as p_image_url, p.workspace_id as p_workspace_id,
             m.id as m_id, m.role as m_role, m.workspace_id as m_workspace_id, m.user_id as m_user_id,
             u.name as u_name, u.email as u_email, u.avatar_url as u_avatar,
             ru.name as rep_name, ru.email as rep_email, ru.avatar_url as rep_avatar
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN members m ON t.assignee_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN users ru ON t.reporter_id = ru.id
      WHERE t.workspace_id = ?
    `;

    const params = [workspaceId];

    if (projectId) {
      query += ' AND t.project_id = ?';
      params.push(projectId);
    }
    if (assigneeId) {
      query += ' AND (t.assignee_id = ? OR t.id IN (SELECT task_id FROM task_assignees WHERE member_id = ?))';
      params.push(assigneeId, assigneeId);
    }
    if (status) {
      query += ' AND t.status = ?';
      params.push(status);
    }
    if (sprintId) {
      query += ' AND t.sprint_id = ?';
      params.push(sprintId);
    }
    if (issueType) {
      query += ' AND t.issue_type = ?';
      params.push(issueType);
    }
    if (dueDate) {
      query += ' AND date(t.due_date) = date(?)';
      params.push(dueDate);
    }
    if (search) {
      query += ' AND (t.name LIKE ? OR t.key LIKE ? OR t.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY t.position ASC, t.created_at DESC';

    const rows = db.prepare(query).all(...params);

    const documents = rows.map((row) => {
      const task = formatDoc(row);
      task.project = {
        $id: row.p_id,
        name: row.p_name,
        key: row.p_key || 'PROJ',
        imageUrl: row.p_image_url,
        workspaceId: row.p_workspace_id,
      };
      task.assignee = row.m_id
        ? {
            $id: row.m_id,
            role: row.m_role,
            workspaceId: row.m_workspace_id,
            userId: row.m_user_id,
            name: row.u_name,
            email: row.u_email,
            avatarUrl: row.u_avatar,
          }
        : null;
      task.reporter = row.reporter_id
        ? {
            id: row.reporter_id,
            name: row.rep_name,
            email: row.rep_email,
            avatarUrl: row.rep_avatar,
          }
        : null;
      task.labels = JSON.parse(row.labels || '[]');
      task.storyPoints = row.story_points || 1;
      task.issueType = row.issue_type || 'Task';
      task.priority = row.priority || 'MEDIUM';
      return task;
    });

    attachAssigneesToTasks(documents);

    return ctx.json({
      data: {
        documents,
        total: documents.length,
      },
    });
  })
  .get('/my-work', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.query('workspaceId');

    const memberRows = db.prepare('SELECT id, workspace_id FROM members WHERE user_id = ?').all(user.$id);
    const memberIds = memberRows.map((m) => m.id);

    if (memberIds.length === 0) {
      return ctx.json({
        data: {
          assignedToMe: [],
          reportedByMe: [],
          recentUpdates: [],
          watchedIssues: [],
        },
      });
    }

    const placeholders = memberIds.map(() => '?').join(',');

    // Assigned to Me
    const assigned = db.prepare(`
      SELECT t.*, p.key as project_key, p.name as project_name
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      WHERE (t.assignee_id IN (${placeholders}) OR t.id IN (SELECT task_id FROM task_assignees WHERE member_id IN (${placeholders}))) ${workspaceId ? 'AND t.workspace_id = ?' : ''}
      AND t.status != 'DONE'
      ORDER BY t.updated_at DESC
      LIMIT 20
    `).all(...(workspaceId ? [...memberIds, ...memberIds, workspaceId] : [...memberIds, ...memberIds]));

    // Reported by Me
    const reported = db.prepare(`
      SELECT t.*, p.key as project_key, p.name as project_name
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      WHERE t.reporter_id = ? ${workspaceId ? 'AND t.workspace_id = ?' : ''}
      ORDER BY t.created_at DESC
      LIMIT 20
    `).all(...(workspaceId ? [user.$id, workspaceId] : [user.$id]));

    // Watched by Me
    const watched = db.prepare(`
      SELECT t.*, p.key as project_key, p.name as project_name
      FROM task_watchers w
      JOIN tasks t ON w.task_id = t.id
      JOIN projects p ON t.project_id = p.id
      WHERE w.user_id = ? ${workspaceId ? 'AND t.workspace_id = ?' : ''}
      ORDER BY t.updated_at DESC
      LIMIT 20
    `).all(...(workspaceId ? [user.$id, workspaceId] : [user.$id]));

    return ctx.json({
      data: {
        assignedToMe: attachAssigneesToTasks(assigned.map(formatDoc)),
        reportedByMe: attachAssigneesToTasks(reported.map(formatDoc)),
        watchedIssues: attachAssigneesToTasks(watched.map(formatDoc)),
      },
    });
  })
  .post('/bulk-update', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const { tasks = [] } = body;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return ctx.json({ data: [] });
    }

    const updatedTasks = [];
    let workspaceId = null;

    for (const item of tasks) {
      const taskId = item.$id || item.id;
      if (!taskId) continue;

      const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!existingTask) continue;

      workspaceId = existingTask.workspace_id;

      let newStatus = item.status || existingTask.status;
      // Normalization of status strings (e.g. 'CODE REVIEW' -> 'IN_REVIEW')
      const clean = String(newStatus).toUpperCase().replace(/\s+/g, '_');
      if (clean === 'CODE_REVIEW' || clean === 'IN_REVIEW') newStatus = 'IN_REVIEW';
      else if (clean === 'IN_PROGRESS') newStatus = 'IN_PROGRESS';
      else if (clean === 'DONE') newStatus = 'DONE';
      else if (clean === 'BACKLOG') newStatus = 'BACKLOG';
      else newStatus = 'TODO';

      const newPosition = item.position !== undefined ? Number(item.position) : existingTask.position;

      // Restriction: Only Admins / Workspace Owners can move tasks to DONE
      if (newStatus === 'DONE' && existingTask.status !== 'DONE') {
        const member = await getMember({ workspaceId: existingTask.workspace_id, userId: user.$id });
        const workspace = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(existingTask.workspace_id);
        const isOwner = workspace && workspace.user_id === user.$id;
        const isAdmin = isOwner || (member && (member.role === 'ADMIN' || member.organization_role === 'COMPANY_OWNER' || member.organization_role === 'COMPANY_ADMIN'));

        if (!isAdmin) {
          return ctx.json({ error: 'Permission denied: Only administrators can move issues to DONE.' }, 403);
        }
      }

      db.prepare(`
        UPDATE tasks 
        SET status = ?, position = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newStatus, newPosition, taskId);

      if (newStatus !== existingTask.status) {
        db.prepare(`
          INSERT INTO task_history (id, task_id, user_id, field_name, old_value, new_value)
          VALUES (?, ?, ?, 'status', ?, ?)
        `).run(randomUUID(), taskId, user.$id, existingTask.status, newStatus);

        logActivity({
          workspaceId: existingTask.workspace_id,
          projectId: existingTask.project_id,
          taskId,
          userId: user.$id,
          action: 'ISSUE_STATUS_CHANGED',
          details: `Moved ${existingTask.key || 'issue'} to ${newStatus}`,
        });
      }

      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (updated) {
        updatedTasks.push(formatDoc(updated));
      }
    }

    if (workspaceId && updatedTasks.length > 0) {
      broadcastWorkspaceEvent(workspaceId, 'TASKS_BULK_UPDATED', {
        count: updatedTasks.length,
        tasks: updatedTasks,
      });
    }

    return ctx.json({ data: updatedTasks[0] || { workspaceId } });
  })
  .get('/:taskId', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const currentUser = ctx.get('user');

    const row = db.prepare(`
      SELECT t.*, 
             p.id as p_id, p.name as p_name, p.key as p_key, p.image_url as p_image_url, p.workspace_id as p_workspace_id,
             m.id as m_id, m.role as m_role, m.workspace_id as m_workspace_id, m.user_id as m_user_id,
             u.name as u_name, u.email as u_email, u.avatar_url as u_avatar,
             ru.name as rep_name, ru.email as rep_email, ru.avatar_url as rep_avatar
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN members m ON t.assignee_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN users ru ON t.reporter_id = ru.id
      WHERE t.id = ?
    `).get(taskId);

    if (!row) {
      return ctx.json({ error: 'Task not found.' }, 404);
    }

    const task = formatDoc(row);
    task.project = {
      $id: row.p_id,
      name: row.p_name,
      key: row.p_key || 'PROJ',
      imageUrl: row.p_image_url,
      workspaceId: row.p_workspace_id,
    };
    task.assignee = row.m_id
      ? {
          $id: row.m_id,
          role: row.m_role,
          workspaceId: row.m_workspace_id,
          userId: row.m_user_id,
          name: row.u_name,
          email: row.u_email,
          avatarUrl: row.u_avatar,
        }
      : null;
    task.reporter = row.reporter_id
      ? {
          id: row.reporter_id,
          name: row.rep_name,
          email: row.rep_email,
          avatarUrl: row.rep_avatar,
        }
      : null;
    task.labels = JSON.parse(row.labels || '[]');
    task.storyPoints = row.story_points || 1;
    task.issueType = row.issue_type || 'Task';
    task.priority = row.priority || 'MEDIUM';

    // Subtasks
    const subtasks = db.prepare('SELECT * FROM tasks WHERE parent_task_id = ?').all(taskId);
    task.subtasks = subtasks.map(formatDoc);

    // Comments
    const comments = db.prepare(`
      SELECT c.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar
      FROM task_comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.task_id = ?
      ORDER BY c.created_at ASC
    `).all(taskId);
    task.comments = comments.map(formatDoc);

    attachAssigneesToTask(task);

    return ctx.json({ data: task });
  })
  .post('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const body = await ctx.req.json();

    const {
      name,
      status = 'TODO',
      workspaceId,
      projectId,
      dueDate,
      assigneeId = null,
      assigneeIds = null,
      description = '',
      issueType = 'Task',
      priority = 'MEDIUM',
      sprintId = null,
      storyPoints = 1,
      labels = [],
      epicId = null,
      parentTaskId = null,
      originalEstimateHours = 0,
    } = body;

    if (!name || !workspaceId || !projectId) {
      return ctx.json({ error: 'Name, workspaceId, and projectId are required.' }, 400);
    }

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    // Auto-generate project-wise unique Jira issue key (e.g. SW-1, IE-2, KLAN-101)
    const key = getNextTaskKeyForProject(projectId);

    const highestPos = db.prepare(`
      SELECT MAX(position) as max_pos FROM tasks WHERE status = ? AND workspace_id = ?
    `).get(status, workspaceId);

    const newPosition = highestPos && highestPos.max_pos ? highestPos.max_pos + 1000 : 1000;
    const taskId = randomUUID();
    const dueDateStr = dueDate ? (dueDate instanceof Date ? dueDate.toISOString() : dueDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    let targetAssigneeIds = [];
    if (Array.isArray(assigneeIds) && assigneeIds.length > 0) {
      targetAssigneeIds = assigneeIds.filter(Boolean);
    } else if (assigneeId) {
      targetAssigneeIds = Array.isArray(assigneeId) ? assigneeId.filter(Boolean) : [assigneeId];
    }
    const primaryAssigneeId = targetAssigneeIds[0] || member.$id || member.id;
    if (targetAssigneeIds.length === 0 && primaryAssigneeId) {
      targetAssigneeIds = [primaryAssigneeId];
    }

    db.prepare(`
      INSERT INTO tasks (
        id, key, name, description, status, priority, issue_type, workspace_id, project_id,
        assignee_id, reporter_id, sprint_id, story_points, labels, epic_id, parent_task_id,
        original_estimate_hours, due_date, position
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      key,
      name,
      description || null,
      status,
      priority,
      issueType,
      workspaceId,
      projectId,
      primaryAssigneeId,
      user.$id,
      sprintId || null,
      Number(storyPoints) || 1,
      JSON.stringify(labels || []),
      epicId || null,
      parentTaskId || null,
      Number(originalEstimateHours) || 0,
      dueDateStr,
      newPosition
    );

    try {
      const insertAssigneeStmt = db.prepare('INSERT OR IGNORE INTO task_assignees (id, task_id, member_id) VALUES (?, ?, ?)');
      for (const mId of targetAssigneeIds) {
        insertAssigneeStmt.run(randomUUID(), taskId, mId);

        const assignedMember = db.prepare('SELECT user_id FROM members WHERE id = ?').get(mId);
        if (assignedMember && assignedMember.user_id !== user.$id) {
          createNotification({
            workspaceId,
            userId: assignedMember.user_id,
            title: `Assigned to ${key}`,
            message: `${user.name} assigned you to ${key}: "${name}"`,
            link: `/workspaces/${workspaceId}/tasks/${taskId}`,
            type: 'ASSIGNMENT',
          });
        }
      }
    } catch (err) {}

    logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'CREATE_ISSUE',
      entityType: 'ISSUE',
      entityId: taskId,
      details: { key, name, issueType, priority },
    });

    triggerAutomations({
      workspaceId,
      triggerEvent: 'ON_ISSUE_CREATED',
      context: { key, name, priority, status },
    });

    if (priority === 'CRITICAL' || priority === 'HIGHEST') {
      triggerAutomations({
        workspaceId,
        triggerEvent: 'ON_PRIORITY_CRITICAL',
        context: { key, name, priority },
      });
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    return ctx.json({ data: attachAssigneesToTask(formatDoc(task)) });
  })
  .patch('/:taskId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const body = await ctx.req.json();
    const { taskId } = ctx.req.param();

    const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!existingTask) {
      return ctx.json({ error: 'Task not found.' }, 404);
    }

    const member = await getMember({
      workspaceId: existingTask.workspace_id,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    const {
      name,
      status,
      description,
      projectId,
      dueDate,
      assigneeId,
      assigneeIds,
      priority,
      issueType,
      sprintId,
      storyPoints,
      labels,
      epicId,
      loggedHours,
      originalEstimateHours,
    } = body;

    // Restriction: Only Admins / Workspace Owners can move tasks to DONE
    if (status !== undefined && status === 'DONE' && existingTask.status !== 'DONE') {
      const workspace = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(existingTask.workspace_id);
      const isOwner = workspace && workspace.user_id === user.$id;
      const isAdmin = isOwner || (member && (member.role === 'ADMIN' || member.organization_role === 'COMPANY_OWNER' || member.organization_role === 'COMPANY_ADMIN'));

      if (!isAdmin) {
        return ctx.json({ error: 'Permission denied: Only administrators can move issues to DONE.' }, 403);
      }
    }

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (projectId !== undefined) { updates.push('project_id = ?'); params.push(projectId); }
    if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
    if (issueType !== undefined) { updates.push('issue_type = ?'); params.push(issueType); }
    if (sprintId !== undefined) { updates.push('sprint_id = ?'); params.push(sprintId || null); }
    if (storyPoints !== undefined) { updates.push('story_points = ?'); params.push(Number(storyPoints)); }
    if (labels !== undefined) { updates.push('labels = ?'); params.push(JSON.stringify(labels)); }
    if (epicId !== undefined) { updates.push('epic_id = ?'); params.push(epicId || null); }
    if (loggedHours !== undefined) { updates.push('logged_hours = logged_hours + ?'); params.push(Number(loggedHours)); }
    if (originalEstimateHours !== undefined) { updates.push('original_estimate_hours = ?'); params.push(Number(originalEstimateHours)); }
    if (dueDate !== undefined) {
      updates.push('due_date = ?');
      params.push(dueDate ? (dueDate instanceof Date ? dueDate.toISOString() : dueDate) : existingTask.due_date);
    }

    if (assigneeIds !== undefined || assigneeId !== undefined) {
      let targetAssigneeIds = null;
      if (assigneeIds !== undefined) {
        targetAssigneeIds = Array.isArray(assigneeIds) ? assigneeIds.filter(Boolean) : (assigneeIds ? [assigneeIds] : []);
      } else if (assigneeId !== undefined) {
        targetAssigneeIds = Array.isArray(assigneeId) ? assigneeId.filter(Boolean) : (assigneeId ? [assigneeId] : []);
      }

      if (targetAssigneeIds !== null) {
        const primaryAssigneeId = targetAssigneeIds[0] || null;
        updates.push('assignee_id = ?');
        params.push(primaryAssigneeId);

        try {
          db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(taskId);
          const insertAssigneeStmt = db.prepare('INSERT OR IGNORE INTO task_assignees (id, task_id, member_id) VALUES (?, ?, ?)');
          for (const mId of targetAssigneeIds) {
            insertAssigneeStmt.run(randomUUID(), taskId, mId);

            const assignedMember = db.prepare('SELECT user_id FROM members WHERE id = ?').get(mId);
            if (assignedMember && assignedMember.user_id !== user.$id) {
              createNotification({
                workspaceId: existingTask.workspace_id,
                userId: assignedMember.user_id,
                title: `Assigned to ${existingTask.key || 'issue'}`,
                message: `${user.name} assigned you to ${existingTask.key || 'issue'}: "${existingTask.name}"`,
                link: `/workspaces/${existingTask.workspace_id}/tasks/${taskId}`,
                type: 'ASSIGNMENT',
              });
            }
          }
        } catch (err) {}
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(taskId);
      db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    if (status && status !== existingTask.status) {
      if (status === 'DONE') {
        triggerAutomations({
          workspaceId: existingTask.workspace_id,
          triggerEvent: 'ON_STATUS_CHANGE_TO_DONE',
          context: { key: existingTask.key, name: existingTask.name },
        });
      }
    }

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    return ctx.json({ data: attachAssigneesToTask(formatDoc(updated)) });
  })
  .post('/bulk-update', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { tasks } = await ctx.req.json();

    if (!tasks || tasks.length === 0) {
      return ctx.json({ data: { updatedTasks: [], workspaceId: '' } });
    }

    const firstTask = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(tasks[0].$id || tasks[0].id);
    if (!firstTask) {
      return ctx.json({ error: 'Task not found.' }, 404);
    }

    const updateStmt = db.prepare('UPDATE tasks SET status = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const updatedTasks = [];

    for (const task of tasks) {
      const id = task.$id || task.id;
      updateStmt.run(task.status, task.position, id);
      const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (t) updatedTasks.push(formatDoc(t));
    }

    return ctx.json({ data: { updatedTasks, workspaceId: firstTask.workspace_id } });
  })
  .get('/:taskId/comments', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const comments = db.prepare(`
      SELECT c.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar
      FROM task_comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.task_id = ?
      ORDER BY c.created_at ASC
    `).all(taskId);
    return ctx.json({ data: comments.map(formatDoc) });
  })
  .post('/:taskId/comments', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { taskId } = ctx.req.param();
    const { content } = await ctx.req.json();

    if (!content) return ctx.json({ error: 'Comment content is required.' }, 400);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO task_comments (id, task_id, user_id, content)
      VALUES (?, ?, ?, ?)
    `).run(id, taskId, user.$id, content);

    const task = db.prepare('SELECT key, workspace_id, reporter_id, assignee_id FROM tasks WHERE id = ?').get(taskId);
    if (task && task.reporter_id && task.reporter_id !== user.$id) {
      createNotification({
        workspaceId: task.workspace_id,
        userId: task.reporter_id,
        title: `Comment on ${task.key || 'Issue'}`,
        message: `${user.name} commented: "${content.substring(0, 60)}..."`,
        link: `/workspaces/${task.workspace_id}/tasks/${taskId}`,
        type: 'MENTION',
      });
    }

    return ctx.json({ success: true, id, content });
  })
  .delete('/:taskId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { taskId } = ctx.req.param();

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      return ctx.json({ error: 'Task not found.' }, 404);
    }

    const member = await getMember({
      workspaceId: task.workspace_id,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    const isAdmin = member.role === 'ADMIN' || member.role === 'OWNER' || user.role === 'ADMIN';
    if (!isAdmin) {
      return ctx.json({ error: 'Only admins can delete tickets.' }, 403);
    }

    // Clean up dependent child records
    try { db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(taskId); } catch (e) {}
    db.prepare('DELETE FROM task_history WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_comments WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_links WHERE source_task_id = ? OR target_task_id = ?').run(taskId, taskId);
    db.prepare('DELETE FROM task_watchers WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

    logActivity({
      workspaceId: task.workspace_id,
      projectId: task.project_id,
      taskId,
      userId: user.$id,
      action: 'ISSUE_DELETED',
      details: `Admin deleted ${task.key || 'issue'}: ${task.name}`,
    });

    broadcastWorkspaceEvent(task.workspace_id, 'TASK_DELETED', {
      taskId,
      key: task.key,
      deletedBy: user.name,
    });

    return ctx.json({ success: true, data: formatDoc(task) });
  })
  .get('/:taskId/history', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const history = db.prepare(`
      SELECT h.*, u.name as changed_by_name, u.email as changed_by_email, u.avatar_url as changed_by_avatar
      FROM task_history h
      JOIN users u ON h.user_id = u.id
      WHERE h.task_id = ?
      ORDER BY h.created_at DESC
    `).all(taskId);
    return ctx.json({ data: history.map(formatDoc) });
  })
  .post('/:taskId/transitions', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { taskId } = ctx.req.param();
    const { toStatus, comment = '' } = await ctx.req.json();

    if (!toStatus) return ctx.json({ error: 'toStatus is required.' }, 400);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) return ctx.json({ error: 'Issue not found.' }, 404);

    const fromStatus = task.status;

    // Record transition in tasks table
    db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toStatus, taskId);

    // Record in task_history
    db.prepare(`
      INSERT INTO task_history (id, task_id, user_id, field_name, old_value, new_value)
      VALUES (?, ?, ?, 'status', ?, ?)
    `).run(randomUUID(), taskId, user.$id, fromStatus, toStatus);

    // Record activity
    logActivity({
      workspaceId: task.workspace_id,
      projectId: task.project_id,
      taskId,
      userId: user.$id,
      action: 'ISSUE_STATUS_CHANGED',
      details: `Moved ${task.key || 'issue'} from ${fromStatus} to ${toStatus}`,
    });

    // Post comment if provided
    if (comment.trim()) {
      db.prepare('INSERT INTO task_comments (id, task_id, user_id, content) VALUES (?, ?, ?, ?)').run(
        randomUUID(),
        taskId,
        user.$id,
        comment.trim()
      );
    }

    broadcastWorkspaceEvent(task.workspace_id, 'ISSUE_STATUS_CHANGED', {
      taskId,
      key: task.key,
      fromStatus,
      toStatus,
      changedBy: user.name,
    });

    return ctx.json({ success: true, fromStatus, toStatus });
  })
  .get('/:taskId/attachments', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const attachments = db.prepare(`
      SELECT a.*, u.name as uploader_name, u.email as uploader_email
      FROM task_attachments a
      JOIN users u ON a.user_id = u.id
      WHERE a.task_id = ?
      ORDER BY a.created_at DESC
    `).all(taskId);
    return ctx.json({ data: attachments.map(formatDoc) });
  })
  .post('/:taskId/attachments', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { taskId } = ctx.req.param();
    const { fileName, fileUrl, fileSize = 0, fileType = 'application/octet-stream' } = await ctx.req.json();

    if (!fileName || !fileUrl) return ctx.json({ error: 'fileName and fileUrl are required.' }, 400);

    const attachmentId = randomUUID();
    db.prepare(`
      INSERT INTO task_attachments (id, task_id, user_id, file_name, file_url, file_size, file_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(attachmentId, taskId, user.$id, fileName, fileUrl, fileSize, fileType);

    db.prepare(`
      INSERT INTO task_history (id, task_id, user_id, field_name, old_value, new_value)
      VALUES (?, ?, ?, 'attachment', null, ?)
    `).run(randomUUID(), taskId, user.$id, fileName);

    return ctx.json({ success: true, id: attachmentId, fileName, fileUrl });
  })
  .delete('/:taskId/attachments/:attachmentId', sessionMiddleware, async (ctx) => {
    const { attachmentId } = ctx.req.param();
    db.prepare('DELETE FROM task_attachments WHERE id = ?').run(attachmentId);
    return ctx.json({ success: true });
  })
  .get('/:taskId/links', sessionMiddleware, async (ctx) => {
    const { taskId } = ctx.req.param();
    const links = db.prepare(`
      SELECT l.*, t.key as target_key, t.name as target_name, t.status as target_status, t.priority as target_priority,
             u.name as created_by_name
      FROM task_links l
      JOIN tasks t ON (l.target_task_id = t.id OR (l.source_task_id = t.id AND l.target_task_id = ?))
      JOIN users u ON l.created_by = u.id
      WHERE l.source_task_id = ? OR l.target_task_id = ?
    `).all(taskId, taskId, taskId);
    return ctx.json({ data: links.map(formatDoc) });
  })
  .post('/:taskId/links', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { taskId } = ctx.req.param();
    const { targetTaskId, relationshipType = 'relates to' } = await ctx.req.json();

    if (!targetTaskId) return ctx.json({ error: 'targetTaskId is required.' }, 400);

    const linkId = randomUUID();
    db.prepare(`
      INSERT INTO task_links (id, source_task_id, target_task_id, relationship_type, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(linkId, taskId, targetTaskId, relationshipType, user.$id);

    return ctx.json({ success: true, id: linkId });
  })
  .delete('/:taskId/links/:linkId', sessionMiddleware, async (ctx) => {
    const { linkId } = ctx.req.param();
    db.prepare('DELETE FROM task_links WHERE id = ?').run(linkId);
    return ctx.json({ success: true });
  })
  .post('/:taskId/watch', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { taskId } = ctx.req.param();
    db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(taskId, user.$id);
    return ctx.json({ success: true, watching: true });
  })
  .delete('/:taskId/watch', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { taskId } = ctx.req.param();
    db.prepare('DELETE FROM task_watchers WHERE task_id = ? AND user_id = ?').run(taskId, user.$id);
    return ctx.json({ success: true, watching: false });
  });

export default app;
