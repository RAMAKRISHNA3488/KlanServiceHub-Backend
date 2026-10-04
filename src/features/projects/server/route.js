import { zValidator } from '@hono/zod-validator';
import { endOfMonth, startOfMonth, subMonths } from 'date-fns';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { getMember } from '../../members/utils.js';
import { createProjectSchema, updateProjectSchema } from '../schema.js';
import { TaskStatus } from '../../tasks/types.js';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';
import { generateProjectKey } from '../../../lib/issue-key.js';

const app = new Hono()
  .post('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    let body = {};
    const contentType = ctx.req.header('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await ctx.req.json().catch(() => ({}));
    } else {
      body = await ctx.req.parseBody().catch(() => ({}));
    }

    const { name, image, workspaceId, category } = body;
    let key = body.key;

    if (!name || !workspaceId) {
      return ctx.json({ error: 'Project name and workspaceId are required.' }, 400);
    }

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    // Auto-generate unique project key if not provided
    const existingProjects = db.prepare('SELECT key FROM projects WHERE workspace_id = ?').all(workspaceId);
    const existingKeys = existingProjects.map((p) => p.key).filter(Boolean);

    if (key && typeof key === 'string' && key.trim().length > 0) {
      key = key.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 10);
    } else {
      key = generateProjectKey(name, existingKeys);
    }

    let imageUrl = typeof image === 'string' && image.length > 0 ? image : null;
    let imageId = null;

    if (image instanceof File) {
      const buffer = Buffer.from(await image.arrayBuffer());
      imageUrl = `data:${image.type};base64,${buffer.toString('base64')}`;
      imageId = randomUUID();
    }

    const projectId = randomUUID();

    db.prepare(`
      INSERT INTO projects (id, name, key, workspace_id, image_id, image_url, category)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, name, key, workspaceId, imageId, imageUrl, category || 'Software');

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    return ctx.json({ data: formatDoc(project) });
  })
  .get(
    '/',
    sessionMiddleware,
    zValidator(
      'query',
      z.object({
        workspaceId: z.string(),
      }),
    ),
    async (ctx) => {
      const user = ctx.get('user');
      const { workspaceId } = ctx.req.valid('query');

      const member = await getMember({
        workspaceId,
        userId: user.$id,
      });

      if (!member) {
        return ctx.json({ error: 'Unauthorized.' }, 401);
      }

      const rows = db.prepare(`
        SELECT * FROM projects 
        WHERE workspace_id = ? 
        ORDER BY created_at DESC
      `).all(workspaceId);

      const documents = rows.map(formatDoc);

      return ctx.json({
        data: {
          documents,
          total: documents.length,
        },
      });
    },
  )
  .get('/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    if (!project) {
      return ctx.json({ error: 'Project not found.' }, 404);
    }

    const member = await getMember({
      workspaceId: project.workspace_id,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    return ctx.json({ data: formatDoc(project) });
  })
  .patch('/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();

    let body = {};
    const contentType = ctx.req.header('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await ctx.req.json().catch(() => ({}));
    } else {
      body = await ctx.req.parseBody().catch(() => ({}));
    }

    const { name, image, key, category } = body;

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    if (!project) {
      return ctx.json({ error: 'Project not found.' }, 404);
    }

    const member = await getMember({
      workspaceId: project.workspace_id,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    let imageUrl = typeof image === 'string' && image.length > 0 ? image : (image === '' ? null : undefined);
    let imageId = undefined;

    if (image instanceof File) {
      const buffer = Buffer.from(await image.arrayBuffer());
      imageUrl = `data:${image.type};base64,${buffer.toString('base64')}`;
      imageId = randomUUID();
    }

    const sanitizedKey = key && typeof key === 'string' && key.trim().length > 0
      ? key.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 10)
      : undefined;

    const updates = [];
    const params = [];

    if (name) {
      updates.push('name = ?');
      params.push(name);
    }
    if (sanitizedKey) {
      updates.push('key = ?');
      params.push(sanitizedKey);
    }
    if (category) {
      updates.push('category = ?');
      params.push(category);
    }
    if (imageUrl !== undefined) {
      updates.push('image_id = ?', 'image_url = ?');
      params.push(imageId || null, imageUrl);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params, projectId);
    }

    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    return ctx.json({ data: formatDoc(updated) });
  })
  .delete('/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    if (!project) {
      return ctx.json({ error: 'Project not found.' }, 404);
    }

    const member = await getMember({
      workspaceId: project.workspace_id,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    return ctx.json({ data: { $id: project.id, workspaceId: project.workspace_id } });
  })
  .get('/:projectId/analytics', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    if (!project) {
      return ctx.json({ error: 'Project not found.' }, 404);
    }

    const member = await getMember({
      workspaceId: project.workspace_id,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    const now = new Date();
    const thisMonthStart = startOfMonth(now).toISOString();
    const thisMonthEnd = endOfMonth(now).toISOString();
    const lastMonthStart = startOfMonth(subMonths(now, 1)).toISOString();
    const lastMonthEnd = endOfMonth(subMonths(now, 1)).toISOString();

    const countTasks = (whereClause, params) => {
      const row = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE project_id = ? ${whereClause}`).get(projectId, ...params);
      return row.count;
    };

    const thisMonthTasks = countTasks('AND created_at BETWEEN ? AND ?', [thisMonthStart, thisMonthEnd]);
    const lastMonthTasks = countTasks('AND created_at BETWEEN ? AND ?', [lastMonthStart, lastMonthEnd]);
    const taskCount = thisMonthTasks;
    const taskDifference = taskCount - lastMonthTasks;

    const thisMonthAssigned = countTasks('AND assignee_id = ? AND created_at BETWEEN ? AND ?', [member.$id, thisMonthStart, thisMonthEnd]);
    const lastMonthAssigned = countTasks('AND assignee_id = ? AND created_at BETWEEN ? AND ?', [member.$id, lastMonthStart, lastMonthEnd]);
    const assignedTaskCount = thisMonthAssigned;
    const assignedTaskDifference = assignedTaskCount - lastMonthAssigned;

    const thisMonthIncomplete = countTasks('AND status != ? AND created_at BETWEEN ? AND ?', [TaskStatus.DONE, thisMonthStart, thisMonthEnd]);
    const lastMonthIncomplete = countTasks('AND status != ? AND created_at BETWEEN ? AND ?', [TaskStatus.DONE, lastMonthStart, lastMonthEnd]);
    const incompleteTaskCount = thisMonthIncomplete;
    const incompleteTaskDifference = incompleteTaskCount - lastMonthIncomplete;

    const thisMonthCompleted = countTasks('AND status = ? AND created_at BETWEEN ? AND ?', [TaskStatus.DONE, thisMonthStart, thisMonthEnd]);
    const lastMonthCompleted = countTasks('AND status = ? AND created_at BETWEEN ? AND ?', [TaskStatus.DONE, lastMonthStart, lastMonthEnd]);
    const completedTaskCount = thisMonthCompleted;
    const completedTaskDifference = completedTaskCount - lastMonthCompleted;

    const thisMonthOverdue = countTasks('AND status != ? AND due_date < ? AND created_at BETWEEN ? AND ?', [TaskStatus.DONE, now.toISOString(), thisMonthStart, thisMonthEnd]);
    const lastMonthOverdue = countTasks('AND status != ? AND due_date < ? AND created_at BETWEEN ? AND ?', [TaskStatus.DONE, now.toISOString(), lastMonthStart, lastMonthEnd]);
    const overdueTaskCount = thisMonthOverdue;
    const overdueTaskDifference = overdueTaskCount - lastMonthOverdue;

    return ctx.json({
      data: {
        taskCount,
        taskDifference,
        assignedTaskCount,
        assignedTaskDifference,
        completedTaskCount,
        completedTaskDifference,
        incompleteTaskCount,
        incompleteTaskDifference,
        overdueTaskCount,
        overdueTaskDifference,
      },
    });
  });

export default app;
