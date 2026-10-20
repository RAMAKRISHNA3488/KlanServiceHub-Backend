import { zValidator } from '@hono/zod-validator';
import { endOfMonth, startOfMonth, subMonths } from 'date-fns';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { MemberRole } from '../../members/types.js';
import { getMember } from '../../members/utils.js';
import { TaskStatus } from '../../tasks/types.js';
import { createWorkspaceSchema, updateWorkspaceSchema } from '../schema.js';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { generateInviteCode } from '../../../lib/utils.js';
import { db, formatDoc, ensureWorkspaceDefaults, getD1Database, d1First, d1All } from '../../../db.js';

const app = new Hono()
  .get('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const d1 = ctx.env?.DB || getD1Database();

    let rows = [];
    if (d1) {
      try {
        const res = await d1.prepare(`
          SELECT w.*, 
                 m.role as user_role, 
                 m.organization_role,
                 (SELECT COUNT(*) FROM members WHERE workspace_id = w.id) as member_count,
                 (SELECT COUNT(*) FROM projects WHERE workspace_id = w.id) as project_count,
                 (SELECT COUNT(*) FROM tasks WHERE workspace_id = w.id) as task_count
          FROM workspaces w
          JOIN members m ON w.id = m.workspace_id
          WHERE m.user_id = ?
          ORDER BY w.created_at DESC
        `).bind(user.$id).all();
        rows = res.results || [];
      } catch (err) {
        console.error('[D1_WORKSPACES_GET_ERROR]:', err);
      }
    }

    if (rows.length === 0) {
      rows = db.prepare(`
        SELECT w.*, 
               m.role as user_role, 
               m.organization_role,
               (SELECT COUNT(*) FROM members WHERE workspace_id = w.id) as member_count,
               (SELECT COUNT(*) FROM projects WHERE workspace_id = w.id) as project_count,
               (SELECT COUNT(*) FROM tasks WHERE workspace_id = w.id) as task_count
        FROM workspaces w
        JOIN members m ON w.id = m.workspace_id
        WHERE m.user_id = ?
        ORDER BY w.created_at DESC
      `).all(user.$id);
    }

    const documents = rows.map((row) => {
      const doc = formatDoc(row);
      doc.userRole = row.user_role || 'MEMBER';
      doc.organizationRole = row.organization_role || 'MEMBER';
      doc.isOwner = row.user_id === user.$id;
      doc.isAdmin = row.user_id === user.$id || row.user_role === 'ADMIN' || row.organization_role === 'COMPANY_OWNER' || row.organization_role === 'COMPANY_ADMIN';
      doc.memberCount = row.member_count || 1;
      doc.projectCount = row.project_count || 0;
      doc.taskCount = row.task_count || 0;
      return doc;
    });

    return ctx.json({
      data: {
        documents,
        total: documents.length,
      },
    });
  })
  .post('/', zValidator('form', createWorkspaceSchema), sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { name, image } = ctx.req.valid('form');

    let imageUrl = typeof image === 'string' && image.length > 0 ? image : null;
    let imageId = null;

    if (image instanceof File) {
      const buffer = Buffer.from(await image.arrayBuffer());
      imageUrl = `data:${image.type};base64,${buffer.toString('base64')}`;
      imageId = randomUUID();
    }

    const workspaceId = randomUUID();
    const inviteCode = generateInviteCode(6);
    const d1 = ctx.env?.DB || getD1Database();

    if (d1) {
      try {
        await d1.prepare(`
          INSERT INTO workspaces (id, name, user_id, image_id, image_url, invite_code)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(workspaceId, name, user.$id, imageId, imageUrl, inviteCode).run();

        await d1.prepare(`
          INSERT INTO members (id, workspace_id, user_id, role)
          VALUES (?, ?, ?, ?)
        `).bind(randomUUID(), workspaceId, user.$id, MemberRole.ADMIN).run();
      } catch (e) {
        console.error('[D1_CREATE_WORKSPACE_ERROR]:', e);
      }
    }

    db.prepare(`
      INSERT INTO workspaces (id, name, user_id, image_id, image_url, invite_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workspaceId, name, user.$id, imageId, imageUrl, inviteCode);

    db.prepare(`
      INSERT INTO members (id, workspace_id, user_id, role)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), workspaceId, user.$id, MemberRole.ADMIN);

    ensureWorkspaceDefaults(workspaceId, user.$id);

    let workspace = null;
    if (d1) {
      try {
        workspace = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
      } catch (e) {}
    }
    if (!workspace) {
      workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    }

    return ctx.json({ data: formatDoc(workspace) });
  })
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    ensureWorkspaceDefaults(workspaceId, user.$id);

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    const d1 = ctx.env?.DB || getD1Database();
    let workspace = null;
    if (d1) {
      try {
        workspace = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
      } catch (e) {
        console.error('[D1_GET_WORKSPACE_ERROR]:', e);
      }
    }
    if (!workspace) {
      workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    }

    if (!workspace) {
      return ctx.json({ error: 'Workspace not found.' }, 404);
    }

    return ctx.json({ data: formatDoc(workspace) });
  })
  .get('/:workspaceId/info', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    let workspace = null;
    if (d1) {
      try {
        workspace = await d1.prepare('SELECT id, name FROM workspaces WHERE id = ?').bind(workspaceId).first();
      } catch (e) {}
    }
    if (!workspace) {
      workspace = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(workspaceId);
    }

    if (!workspace) {
      return ctx.json({ error: 'Workspace not found.' }, 404);
    }

    return ctx.json({
      data: {
        $id: workspace.id,
        name: workspace.name,
      },
    });
  })
  .patch('/:workspaceId', sessionMiddleware, zValidator('form', updateWorkspaceSchema), async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, image } = ctx.req.valid('form');

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    const d1 = ctx.env?.DB || getD1Database();
    let workspace = null;
    if (d1) {
      try {
        workspace = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
      } catch (e) {}
    }
    if (!workspace) {
      workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    }

    const isOwner = workspace && workspace.user_id === user.$id;
    const isAdmin = member && (
      member.role === MemberRole.ADMIN ||
      member.role === 'ADMIN' ||
      member.organization_role === 'COMPANY_OWNER' ||
      member.organization_role === 'COMPANY_ADMIN'
    );

    if (!isOwner && !isAdmin) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    let imageUrl = typeof image === 'string' && image.length > 0 ? image : (image === '' ? null : undefined);
    let imageId = undefined;

    if (image instanceof File) {
      const buffer = Buffer.from(await image.arrayBuffer());
      imageUrl = `data:${image.type};base64,${buffer.toString('base64')}`;
      imageId = randomUUID();
    }

    if (d1) {
      try {
        if (name && imageUrl !== undefined) {
          await d1.prepare('UPDATE workspaces SET name = ?, image_id = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(name, imageId || null, imageUrl, workspaceId).run();
        } else if (name) {
          await d1.prepare('UPDATE workspaces SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(name, workspaceId).run();
        } else if (imageUrl !== undefined) {
          await d1.prepare('UPDATE workspaces SET image_id = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(imageId || null, imageUrl, workspaceId).run();
        }
      } catch (e) {
        console.error('[D1_PATCH_WORKSPACE_ERROR]:', e);
      }
    }

    if (name && imageUrl !== undefined) {
      db.prepare('UPDATE workspaces SET name = ?, image_id = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, imageId || null, imageUrl, workspaceId);
    } else if (name) {
      db.prepare('UPDATE workspaces SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, workspaceId);
    } else if (imageUrl !== undefined) {
      db.prepare('UPDATE workspaces SET image_id = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(imageId || null, imageUrl, workspaceId);
    }

    let updatedWorkspace = null;
    if (d1) {
      try {
        updatedWorkspace = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
      } catch (e) {}
    }
    if (!updatedWorkspace) {
      updatedWorkspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    }

    return ctx.json({ data: formatDoc(updatedWorkspace) });
  })
  .delete('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    let workspace = null;
    if (d1) {
      try {
        workspace = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
      } catch (e) {}
    }
    if (!workspace) {
      workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    }

    if (!workspace) {
      return ctx.json({ error: 'Workspace not found.' }, 404);
    }

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member && workspace.user_id !== user.$id) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    let memberCountNum = 1;
    if (d1) {
      try {
        const mc = await d1.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').bind(workspaceId).first();
        if (mc) memberCountNum = mc.count;
      } catch (e) {}
    } else {
      const mc = db.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').get(workspaceId);
      if (mc) memberCountNum = mc.count;
    }

    const isOwner = workspace.user_id === user.$id;
    const isAdmin = member && (
      member.role === MemberRole.ADMIN ||
      member.role === 'ADMIN' ||
      member.organization_role === 'COMPANY_OWNER' ||
      member.organization_role === 'COMPANY_ADMIN'
    );

    // If regular member in a multi-member workspace, leave the workspace instead of full purge
    if (!isOwner && !isAdmin && memberCountNum > 1) {
      if (d1) {
        try {
          await d1.prepare('DELETE FROM members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, user.$id).run();
        } catch (e) {}
      }
      try {
        db.prepare('DELETE FROM members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, user.$id);
      } catch (e) {}

      return ctx.json({ data: { $id: workspaceId, id: workspaceId, success: true, left: true } });
    }

    const tablesToClean = [
      'tasks', 'projects', 'members', 'roles', 'user_roles', 'role_permissions',
      'groups', 'group_members', 'teams', 'team_members', 'team_projects',
      'issue_types', 'workflows', 'workflow_statuses', 'workflow_transitions',
      'sprints', 'boards', 'releases', 'activities', 'custom_fields',
      'task_custom_field_values', 'task_history', 'task_comments', 'task_watchers',
      'task_links', 'work_logs', 'saved_filters', 'issue_type_schemes', 'priority_schemes',
      'sla_definitions', 'sla_records', 'webhooks', 'webhook_deliveries',
      'user_favorites', 'user_recent_items', 'outbox_events', 'release_trains',
      'team_capacities', 'calendar_events', 'project_milestones', 'project_risks',
      'project_decisions', 'approval_requests', 'change_requests', 'service_requests',
      'customer_organizations', 'assets', 'service_dependencies', 'environments',
      'deployments', 'portfolios', 'portfolio_projects', 'initiatives',
      'strategic_goals', 'automations', 'automation_logs', 'notifications',
      'notification_preferences', 'integrations', 'integration_logs', 'api_tokens',
      'security_policies', 'audit_logs', 'subscriptions', 'invoices', 'backups', 'invitations'
    ];

    if (d1) {
      for (const table of tablesToClean) {
        try {
          await d1.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(workspaceId).run();
        } catch (e) {}
      }
      try {
        await d1.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspaceId).run();
      } catch (e) {}
    }

    for (const table of tablesToClean) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
      } catch (e) {
        // Ignore if table doesn't exist in current environment
      }
    }

    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);

    return ctx.json({ data: { $id: workspaceId, id: workspaceId, success: true } });
  })
  .post('/:workspaceId/leave', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'You are not a member of this workspace.' }, 404);
    }

    let memberCountNum = 1;
    if (d1) {
      try {
        const mc = await d1.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').bind(workspaceId).first();
        if (mc) memberCountNum = mc.count;
      } catch (e) {}
    } else {
      const mc = db.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').get(workspaceId);
      if (mc) memberCountNum = mc.count;
    }

    if (memberCountNum <= 1) {
      if (d1) {
        try {
          await d1.prepare('DELETE FROM members WHERE workspace_id = ?').bind(workspaceId).run();
          await d1.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspaceId).run();
        } catch (e) {}
      }
      try {
        db.prepare('DELETE FROM members WHERE workspace_id = ?').run(workspaceId);
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      } catch (e) {}
      return ctx.json({ data: { $id: workspaceId, success: true, removed: true } });
    }

    if (d1) {
      try {
        await d1.prepare('DELETE FROM members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, user.$id).run();
      } catch (e) {}
    }
    try {
      db.prepare('DELETE FROM members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, user.$id);
    } catch (e) {}

    return ctx.json({ data: { $id: workspaceId, success: true } });
  })
  .post('/:workspaceId/resetInviteCode', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member || member.role !== MemberRole.ADMIN) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    const newCode = generateInviteCode(6);
    if (d1) {
      try {
        await d1.prepare('UPDATE workspaces SET invite_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(newCode, workspaceId).run();
      } catch (e) {}
    }
    db.prepare('UPDATE workspaces SET invite_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newCode, workspaceId);

    let workspace = null;
    if (d1) {
      try {
        workspace = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
      } catch (e) {}
    }
    if (!workspace) {
      workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    }

    return ctx.json({ data: formatDoc(workspace) });
  })
  .post(
    '/:workspaceId/join',
    sessionMiddleware,
    zValidator(
      'json',
      z.object({
        code: z.string(),
      }),
    ),
    async (ctx) => {
      const { workspaceId } = ctx.req.param();
      const { code } = ctx.req.valid('json');
      const user = ctx.get('user');
      const d1 = ctx.env?.DB || getD1Database();

      const member = await getMember({
        workspaceId,
        userId: user.$id,
      });

      if (member) {
        return ctx.json({ error: 'Already a member.' }, 400);
      }

      let workspace = null;
      if (d1) {
        try {
          workspace = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
        } catch (e) {}
      }
      if (!workspace) {
        workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
      }

      if (!workspace || workspace.invite_code !== code) {
        return ctx.json({ error: 'Invalid invite code.' }, 400);
      }

      if (d1) {
        try {
          await d1.prepare(`
            INSERT INTO members (id, workspace_id, user_id, role)
            VALUES (?, ?, ?, ?)
          `).bind(randomUUID(), workspaceId, user.$id, MemberRole.MEMBER).run();
        } catch (e) {}
      }

      db.prepare(`
        INSERT INTO members (id, workspace_id, user_id, role)
        VALUES (?, ?, ?, ?)
      `).run(randomUUID(), workspaceId, user.$id, MemberRole.MEMBER);

      return ctx.json({ data: formatDoc(workspace) });
    },
  )
  .get('/:workspaceId/analytics', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    const countTasks = async (whereClause = '', params = []) => {
      const sql = `SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? ${whereClause}`;
      const row = await d1First(sql, [workspaceId, ...params], d1);
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
