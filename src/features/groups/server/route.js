import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, d1All, d1First, d1Run, getD1Database } from '../../../db.js';

const defaultEnterpriseGroups = [
  {
    name: 'klanservicehub-administrators',
    description: 'System administrators with unrestricted global configuration, permission management, and directory control privileges.',
    is_default: 0,
    is_system: 1,
    group_type: 'SYSTEM',
    role_mapping: 'ADMIN',
  },
  {
    name: 'klanservicehub-software-users',
    description: 'Standard software development members with full access to project backlogs, agile boards, sprints, and task tracking.',
    is_default: 1,
    is_system: 1,
    group_type: 'SYSTEM',
    role_mapping: 'MEMBER',
  },
  {
    name: 'klanservicehub-servicemanagement-users',
    description: 'Customer service, IT support agents, and incident response personnel managing customer tickets and SLA queues.',
    is_default: 0,
    is_system: 1,
    group_type: 'SYSTEM',
    role_mapping: 'MEMBER',
  },
  {
    name: 'engineering-core',
    description: 'Core software engineers, architects, and DevOps contributors across all development squads.',
    is_default: 1,
    is_system: 0,
    group_type: 'SECURITY',
    role_mapping: 'DEVELOPER',
  },
  {
    name: 'product-managers',
    description: 'Product owners, technical business analysts, and strategic roadmap coordinators.',
    is_default: 0,
    is_system: 0,
    group_type: 'CUSTOM',
    role_mapping: 'PROJECT_MANAGER',
  },
  {
    name: 'qa-and-testers',
    description: 'Quality assurance specialists, automation test engineers, and release gatekeepers.',
    is_default: 0,
    is_system: 0,
    group_type: 'CUSTOM',
    role_mapping: 'TESTER',
  },
];

async function seedDefaultGroupsIfEmpty(workspaceId, d1) {
  const existingCount = await d1First('SELECT COUNT(*) as count FROM groups WHERE workspace_id = ?', [workspaceId], d1);
  if (existingCount && existingCount.count > 0) return;

  const members = await d1All('SELECT user_id, role FROM members WHERE workspace_id = ?', [workspaceId], d1);

  for (const item of defaultEnterpriseGroups) {
    const groupId = randomUUID();
    await d1Run(`
      INSERT INTO groups (id, workspace_id, name, description, is_default, is_system, group_type, role_mapping)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [groupId, workspaceId, item.name, item.description, item.is_default, item.is_system, item.group_type, item.role_mapping], d1);

    // Auto-populate members into standard groups
    for (const m of members) {
      if (item.name === 'klanservicehub-administrators' && (m.role === 'ADMIN' || m.role === 'OWNER')) {
        await d1Run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, m.user_id], d1);
      } else if (item.name === 'klanservicehub-software-users' || item.name === 'engineering-core') {
        await d1Run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, m.user_id], d1);
      }
    }
  }
}

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    await seedDefaultGroupsIfEmpty(workspaceId, d1);

    const groups = await d1All(`
      SELECT g.*, COUNT(gm.user_id) as member_count
      FROM groups g
      LEFT JOIN group_members gm ON g.id = gm.group_id
      WHERE g.workspace_id = ?
      GROUP BY g.id
      ORDER BY g.is_system DESC, g.name ASC
    `, [workspaceId], d1);

    return ctx.json({ data: groups.map(formatDoc) });
  })
  .get('/:workspaceId/directory/stats', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    await seedDefaultGroupsIfEmpty(workspaceId, d1);

    const ws = await d1First('SELECT id, name, domain_slug FROM workspaces WHERE id = ?', [workspaceId], d1);

    const groupStats = await d1First(`
      SELECT 
        COUNT(DISTINCT g.id) as total_groups,
        COUNT(DISTINCT CASE WHEN g.is_default = 1 THEN g.id END) as default_groups,
        COUNT(DISTINCT CASE WHEN g.is_system = 1 THEN g.id END) as system_groups
      FROM groups g
      WHERE g.workspace_id = ?
    `, [workspaceId], d1);

    const uniqueUsersInGroups = await d1First(`
      SELECT COUNT(DISTINCT gm.user_id) as assigned_users
      FROM group_members gm
      JOIN groups g ON gm.group_id = g.id
      WHERE g.workspace_id = ?
    `, [workspaceId], d1);

    const totalWorkspaceMembers = await d1First(`
      SELECT COUNT(DISTINCT user_id) as total_members
      FROM members
      WHERE workspace_id = ? AND status = 'ACTIVE'
    `, [workspaceId], d1);

    const domainRulesCount = await d1First(`
      SELECT COUNT(*) as count FROM group_domain_rules WHERE workspace_id = ?
    `, [workspaceId], d1);

    return ctx.json({
      data: {
        workspaceName: ws?.name || 'Workspace',
        domainSlug: ws?.domain_slug || '',
        totalGroups: groupStats?.total_groups || 0,
        defaultGroups: groupStats?.default_groups || 0,
        systemGroups: groupStats?.system_groups || 0,
        assignedUsers: uniqueUsersInGroups?.assigned_users || 0,
        totalMembers: totalWorkspaceMembers?.total_members || 0,
        domainRulesCount: domainRulesCount?.count || 0,
        directoryStatus: 'ACTIVE_SYNCED',
        directoryType: 'Cloud Identity Directory (SCIM / SSO Ready)',
      },
    });
  })
  .get('/:workspaceId/domain-rules', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const rules = await d1All(`
      SELECT r.id, r.workspace_id, r.domain, r.group_id, r.created_at, g.name as group_name
      FROM group_domain_rules r
      JOIN groups g ON r.group_id = g.id
      WHERE r.workspace_id = ?
      ORDER BY r.created_at DESC
    `, [workspaceId], d1);

    return ctx.json({ data: rules.map(formatDoc) });
  })
  .post('/:workspaceId/domain-rules', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { domain, groupId } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!domain || !domain.trim()) return ctx.json({ error: 'Domain is required.' }, 400);
    if (!groupId) return ctx.json({ error: 'Target Group is required.' }, 400);

    const cleanDomain = domain.trim().toLowerCase().replace(/^@/, '');

    const id = randomUUID();
    await d1Run(`
      INSERT OR REPLACE INTO group_domain_rules (id, workspace_id, domain, group_id)
      VALUES (?, ?, ?, ?)
    `, [id, workspaceId, cleanDomain, groupId], d1);

    await logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'CREATE_DOMAIN_RULE',
      entityType: 'GROUP_RULE',
      entityId: id,
      details: { domain: cleanDomain, groupId },
    });

    return ctx.json({ success: true, data: { id, domain: cleanDomain, groupId } });
  })
  .delete('/:workspaceId/domain-rules/:ruleId', sessionMiddleware, async (ctx) => {
    const { workspaceId, ruleId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await d1Run('DELETE FROM group_domain_rules WHERE id = ? AND workspace_id = ?', [ruleId, workspaceId], d1);
    return ctx.json({ success: true });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const {
      name,
      description = '',
      is_default = 0,
      group_type = 'CUSTOM',
      role_mapping = 'MEMBER',
      memberIds = [],
    } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!name || !name.trim()) return ctx.json({ error: 'Group name is required.' }, 400);

    const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-');
    const existing = await d1First('SELECT id FROM groups WHERE workspace_id = ? AND name = ?', [workspaceId, cleanName], d1);
    if (existing) {
      return ctx.json({ error: `A group named "${cleanName}" already exists in this workspace.` }, 400);
    }

    const id = randomUUID();
    await d1Run(`
      INSERT INTO groups (id, workspace_id, name, description, is_default, is_system, group_type, role_mapping)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `, [id, workspaceId, cleanName, description.trim(), is_default ? 1 : 0, group_type, role_mapping], d1);

    if (Array.isArray(memberIds) && memberIds.length > 0) {
      for (const uid of memberIds) {
        if (uid) {
          await d1Run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [id, uid], d1);
        }
      }
    }

    await logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'CREATE_GROUP',
      entityType: 'GROUP',
      entityId: id,
      details: { name: cleanName, description, memberCount: memberIds.length },
    });

    return ctx.json({ data: { id, name: cleanName, description, is_default, group_type, role_mapping } });
  })
  .patch('/:workspaceId/:groupId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, groupId } = ctx.req.param();
    const { name, description, is_default, group_type, role_mapping } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    const existing = await d1First('SELECT * FROM groups WHERE id = ? AND workspace_id = ?', [groupId, workspaceId], d1);
    if (!existing) return ctx.json({ error: 'Group not found.' }, 404);

    let updatedName = existing.name;
    if (name && name.trim()) {
      updatedName = name.trim().toLowerCase().replace(/\s+/g, '-');
    }

    const updatedDesc = description !== undefined ? description : existing.description;
    const updatedDefault = is_default !== undefined ? (is_default ? 1 : 0) : existing.is_default;
    const updatedType = group_type || existing.group_type || 'CUSTOM';
    const updatedRole = role_mapping || existing.role_mapping || 'MEMBER';

    await d1Run(`
      UPDATE groups 
      SET name = ?, description = ?, is_default = ?, group_type = ?, role_mapping = ?
      WHERE id = ? AND workspace_id = ?
    `, [updatedName, updatedDesc, updatedDefault, updatedType, updatedRole, groupId, workspaceId], d1);

    await logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'UPDATE_GROUP',
      entityType: 'GROUP',
      entityId: groupId,
      details: { name: updatedName },
    });

    return ctx.json({ success: true, data: { id: groupId, name: updatedName, description: updatedDesc } });
  })
  .get('/:workspaceId/:groupId/members', sessionMiddleware, async (ctx) => {
    const { groupId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const members = await d1All(`
      SELECT 
        u.id, 
        u.name, 
        u.email, 
        u.avatar_url, 
        u.job_title, 
        u.department, 
        u.status,
        m.role as organization_role,
        gm.created_at as joined_group_at
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      LEFT JOIN groups g ON gm.group_id = g.id
      LEFT JOIN members m ON m.workspace_id = g.workspace_id AND m.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY u.name ASC
    `, [groupId], d1);

    return ctx.json({ data: members.map(formatDoc) });
  })
  .post('/:workspaceId/:groupId/members', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, groupId } = ctx.req.param();
    const body = await ctx.req.json();
    const userIds = Array.isArray(body.userIds) ? body.userIds : (body.userId ? [body.userId] : []);
    const d1 = ctx.env?.DB || getD1Database();

    if (userIds.length === 0) {
      return ctx.json({ error: 'At least one user must be selected.' }, 400);
    }

    let addedCount = 0;
    for (const uid of userIds) {
      if (uid) {
        await d1Run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, uid], d1);
        addedCount++;
      }
    }

    await logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'ADD_GROUP_MEMBERS',
      entityType: 'GROUP',
      entityId: groupId,
      details: { addedCount },
    });

    return ctx.json({ success: true, addedCount });
  })
  .delete('/:workspaceId/:groupId/members/:userId', sessionMiddleware, async (ctx) => {
    const { groupId, userId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await d1Run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId], d1);
    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/:groupId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { groupId, workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const group = await d1First('SELECT * FROM groups WHERE id = ? AND workspace_id = ?', [groupId, workspaceId], d1);
    if (!group) return ctx.json({ error: 'Group not found.' }, 404);

    if (group.is_system === 1 && group.name === 'klanservicehub-administrators') {
      return ctx.json({ error: 'The core system group "klanservicehub-administrators" cannot be deleted.' }, 400);
    }

    await d1Run('DELETE FROM group_members WHERE group_id = ?', [groupId], d1);
    await d1Run('DELETE FROM groups WHERE id = ? AND workspace_id = ?', [groupId, workspaceId], d1);

    await logAudit({
      workspaceId,
      actorId: user.$id,
      actorName: user.name,
      action: 'DELETE_GROUP',
      entityType: 'GROUP',
      entityId: groupId,
      details: { name: group.name },
    });

    return ctx.json({ success: true });
  });

export default app;
