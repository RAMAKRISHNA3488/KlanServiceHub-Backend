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
import { db, formatDoc, ensureWorkspaceDefaults } from '../../../db.js';

const app = new Hono()
  .get('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');

    const rows = db.prepare(`
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

    db.prepare(`
      INSERT INTO workspaces (id, name, user_id, image_id, image_url, invite_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workspaceId, name, user.$id, imageId, imageUrl, inviteCode);

    db.prepare(`
      INSERT INTO members (id, workspace_id, user_id, role)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), workspaceId, user.$id, MemberRole.ADMIN);

    ensureWorkspaceDefaults(workspaceId, user.$id);

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);

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

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);

    if (!workspace) {
      return ctx.json({ error: 'Workspace not found.' }, 404);
    }

    return ctx.json({ data: formatDoc(workspace) });
  })
  .get('/:workspaceId/info', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    const workspace = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(workspaceId);

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

    if (!member || member.role !== MemberRole.ADMIN) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    let imageUrl = typeof image === 'string' && image.length > 0 ? image : (image === '' ? null : undefined);
    let imageId = undefined;

    if (image instanceof File) {
      const buffer = Buffer.from(await image.arrayBuffer());
      imageUrl = `data:${image.type};base64,${buffer.toString('base64')}`;
      imageId = randomUUID();
    }

    if (name && imageUrl !== undefined) {
      db.prepare('UPDATE workspaces SET name = ?, image_id = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, imageId || null, imageUrl, workspaceId);
    } else if (name) {
      db.prepare('UPDATE workspaces SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, workspaceId);
    } else if (imageUrl !== undefined) {
      db.prepare('UPDATE workspaces SET image_id = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(imageId || null, imageUrl, workspaceId);
    }

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);

    return ctx.json({ data: formatDoc(workspace) });
  })
  .delete('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      return ctx.json({ error: 'Workspace not found.' }, 404);
    }

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    const isOwner = workspace.user_id === user.$id;
    const isAdmin = member && (
      member.role === MemberRole.ADMIN ||
      member.role === 'ADMIN' ||
      member.organization_role === 'COMPANY_OWNER' ||
      member.organization_role === 'COMPANY_ADMIN'
    );

    if (!isOwner && !isAdmin) {
      return ctx.json({ error: 'Unauthorized: Only an admin or workspace owner can delete this workspace.' }, 401);
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
  .post('/:workspaceId/resetInviteCode', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    const member = await getMember({
      workspaceId,
      userId: user.$id,
    });

    if (!member || member.role !== MemberRole.ADMIN) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    const newCode = generateInviteCode(6);
    db.prepare('UPDATE workspaces SET invite_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newCode, workspaceId);

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);

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

      const member = await getMember({
        workspaceId,
        userId: user.$id,
      });

      if (member) {
        return ctx.json({ error: 'Already a member.' }, 400);
      }

      const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);

      if (!workspace || workspace.invite_code !== code) {
        return ctx.json({ error: 'Invalid invite code.' }, 400);
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

    const member = await getMember({
      workspaceId,
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
      const row = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? ${whereClause}`).get(workspaceId, ...params);
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
