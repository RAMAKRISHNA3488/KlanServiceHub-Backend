import { zValidator } from '@hono/zod-validator';
import { endOfMonth, startOfMonth, subMonths } from 'date-fns';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { getMember } from '../../members/utils.js';
import { createProjectSchema, updateProjectSchema } from '../schema.js';
import { TaskStatus } from '../../tasks/types.js';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, getD1Database, d1First, d1All } from '../../../db.js';
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

    const d1 = ctx.env?.DB || getD1Database();

    // Auto-generate unique project key if not provided
    let existingProjects = [];
    if (d1) {
      try {
        const res = await d1.prepare('SELECT key FROM projects WHERE workspace_id = ?').bind(workspaceId).all();
        existingProjects = res.results || [];
      } catch (e) {}
    }
    if (existingProjects.length === 0) {
      existingProjects = db.prepare('SELECT key FROM projects WHERE workspace_id = ?').all(workspaceId);
    }
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

    if (d1) {
      try {
        await d1.prepare(`
          INSERT INTO projects (id, name, key, workspace_id, image_id, image_url, category)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(projectId, name, key, workspaceId, imageId, imageUrl, category || 'Software').run();
      } catch (e) {
        console.error('[D1_CREATE_PROJECT_ERROR]:', e);
      }
    }

    db.prepare(`
      INSERT INTO projects (id, name, key, workspace_id, image_id, image_url, category)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, name, key, workspaceId, imageId, imageUrl, category || 'Software');

    let project = null;
    if (d1) {
      try {
        project = await d1.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
      } catch (e) {}
    }
    if (!project) {
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    }

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

      const d1 = ctx.env?.DB || getD1Database();
      let rows = [];
      if (d1) {
        try {
          const res = await d1.prepare(`
            SELECT * FROM projects 
            WHERE workspace_id = ? 
            ORDER BY created_at DESC
          `).bind(workspaceId).all();
          rows = res.results || [];
        } catch (e) {
          console.error('[D1_GET_PROJECTS_ERROR]:', e);
        }
      }

      if (rows.length === 0) {
        rows = db.prepare(`
          SELECT * FROM projects 
          WHERE workspace_id = ? 
          ORDER BY created_at DESC
        `).all(workspaceId);
      }

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
    const d1 = ctx.env?.DB || getD1Database();

    let project = null;
    if (d1) {
      try {
        project = await d1.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
      } catch (e) {}
    }
    if (!project) {
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    }

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
    const d1 = ctx.env?.DB || getD1Database();

    let project = null;
    if (d1) {
      try {
        project = await d1.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
      } catch (e) {}
    }
    if (!project) {
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    }

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
      if (d1) {
        try {
          await d1.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).bind(...params, projectId).run();
        } catch (e) {
          console.error('[D1_PATCH_PROJECT_ERROR]:', e);
        }
      }
      db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params, projectId);
    }

    let updated = null;
    if (d1) {
      try {
        updated = await d1.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
      } catch (e) {}
    }
    if (!updated) {
      updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    }

    return ctx.json({ data: formatDoc(updated) });
  })
  .delete('/:projectId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    let project = null;
    if (d1) {
      try {
        project = await d1.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
      } catch (e) {}
    }
    if (!project) {
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    }

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

    if (d1) {
      try {
        await d1.prepare('DELETE FROM tasks WHERE project_id = ?').bind(projectId).run();
        await d1.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();
      } catch (e) {}
    }

    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    return ctx.json({ data: { $id: project.id, workspaceId: project.workspace_id } });
  })
  .get('/:projectId/analytics', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { projectId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const project = await d1First('SELECT * FROM projects WHERE id = ?', [projectId], d1);

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

    const countTasks = async (whereClause = '', params = []) => {
      const sql = `SELECT COUNT(*) as count FROM tasks WHERE project_id = ? ${whereClause}`;
      const row = await d1First(sql, [projectId, ...params], d1);
      return Number(row?.count || 0);
    };

    // 1. Total tasks & trend
    const taskCount = await countTasks();
    const thisMonthTasks = await countTasks("AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')");
    const lastMonthTasks = await countTasks("AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '-1 month')");
    const taskDifference = thisMonthTasks - lastMonthTasks;

    // 2. Assigned tasks & trend
    const assignedTaskCount = await countTasks("AND ((assignee_id IS NOT NULL AND assignee_id != '') OR id IN (SELECT task_id FROM task_assignees))");
    const thisMonthAssigned = await countTasks("AND ((assignee_id IS NOT NULL AND assignee_id != '') OR id IN (SELECT task_id FROM task_assignees)) AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')");
    const lastMonthAssigned = await countTasks("AND ((assignee_id IS NOT NULL AND assignee_id != '') OR id IN (SELECT task_id FROM task_assignees)) AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '-1 month')");
    const assignedTaskDifference = thisMonthAssigned - lastMonthAssigned;

    // 3. Completed tasks & trend
    const completedTaskCount = await countTasks("AND UPPER(status) IN ('DONE', 'COMPLETED', 'RESOLVED')");
    const thisMonthCompleted = await countTasks("AND UPPER(status) IN ('DONE', 'COMPLETED', 'RESOLVED') AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')");
    const lastMonthCompleted = await countTasks("AND UPPER(status) IN ('DONE', 'COMPLETED', 'RESOLVED') AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now', '-1 month')");
    const completedTaskDifference = thisMonthCompleted - lastMonthCompleted;

    // 4. Incomplete tasks & trend
    const incompleteTaskCount = Math.max(0, taskCount - completedTaskCount);
    const thisMonthIncomplete = await countTasks("AND UPPER(status) NOT IN ('DONE', 'COMPLETED', 'RESOLVED') AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')");
    const lastMonthIncomplete = await countTasks("AND UPPER(status) NOT IN ('DONE', 'COMPLETED', 'RESOLVED') AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '-1 month')");
    const incompleteTaskDifference = thisMonthIncomplete - lastMonthIncomplete;

    // 5. Overdue tasks & trend
    const overdueTaskCount = await countTasks("AND UPPER(status) NOT IN ('DONE', 'COMPLETED', 'RESOLVED') AND due_date IS NOT NULL AND trim(due_date) != '' AND datetime(due_date) < datetime('now')");
    const thisMonthOverdue = await countTasks("AND UPPER(status) NOT IN ('DONE', 'COMPLETED', 'RESOLVED') AND due_date IS NOT NULL AND trim(due_date) != '' AND datetime(due_date) < datetime('now') AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')");
    const lastMonthOverdue = await countTasks("AND UPPER(status) NOT IN ('DONE', 'COMPLETED', 'RESOLVED') AND due_date IS NOT NULL AND trim(due_date) != '' AND datetime(due_date) < datetime('now') AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '-1 month')");
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
