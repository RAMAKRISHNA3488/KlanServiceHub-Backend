import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit } from '../../../db.js';

const defaultEnterpriseGroups = [
  {
    name: 'jira-administrators',
    description: 'System administrators with unrestricted global configuration, permission management, and directory control privileges.',
    is_default: 0,
    is_system: 1,
    group_type: 'SYSTEM',
    role_mapping: 'ADMIN',
  },
  {
    name: 'jira-software-users',
    description: 'Standard software development members with full access to project backlogs, agile boards, sprints, and task tracking.',
    is_default: 1,
    is_system: 1,
    group_type: 'SYSTEM',
    role_mapping: 'MEMBER',
  },
  {
    name: 'jira-servicemanagement-users',
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

function seedDefaultGroupsIfEmpty(workspaceId) {
  const existingCount = db.prepare('SELECT COUNT(*) as count FROM groups WHERE workspace_id = ?').get(workspaceId);
  if (existingCount && existingCount.count > 0) return;

  const members = db.prepare('SELECT user_id, role FROM members WHERE workspace_id = ?').all(workspaceId);

  for (const item of defaultEnterpriseGroups) {
    const groupId = randomUUID();
    db.prepare(`
      INSERT INTO groups (id, workspace_id, name, description, is_default, is_system, group_type, role_mapping)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(groupId, workspaceId, item.name, item.description, item.is_default, item.is_system, item.group_type, item.role_mapping);

    // Auto-populate members into standard groups
    for (const m of members) {
      if (item.name === 'jira-administrators' && (m.role === 'ADMIN' || m.role === 'OWNER')) {
        db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(groupId, m.user_id);
      } else if (item.name === 'jira-software-users' || item.name === 'engineering-core') {
        db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(groupId, m.user_id);
      }
    }
  }
}

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    seedDefaultGroupsIfEmpty(workspaceId);

    const groups = db.prepare(`
      SELECT g.*, COUNT(gm.user_id) as member_count
      FROM groups g
      LEFT JOIN group_members gm ON g.id = gm.group_id
      WHERE g.workspace_id = ?
      GROUP BY g.id
      ORDER BY g.is_system DESC, g.name ASC
    `).all(workspaceId);

    return ctx.json({ data: groups.map(formatDoc) });
  })
  .get('/:workspaceId/directory/stats', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    seedDefaultGroupsIfEmpty(workspaceId);

    const ws = db.prepare('SELECT id, name, domain_slug FROM workspaces WHERE id = ?').get(workspaceId);

    const groupStats = db.prepare(`
      SELECT 
        COUNT(DISTINCT g.id) as total_groups,
        COUNT(DISTINCT CASE WHEN g.is_default = 1 THEN g.id END) as default_groups,
        COUNT(DISTINCT CASE WHEN g.is_system = 1 THEN g.id END) as system_groups
      FROM groups g
      WHERE g.workspace_id = ?
    `).get(workspaceId);

    const uniqueUsersInGroups = db.prepare(`
      SELECT COUNT(DISTINCT gm.user_id) as assigned_users
      FROM group_members gm
      JOIN groups g ON gm.group_id = g.id
      WHERE g.workspace_id = ?
    `).get(workspaceId);

    const totalWorkspaceMembers = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as total_members
      FROM members
      WHERE workspace_id = ? AND status = 'ACTIVE'
    `).get(workspaceId);

    const domainRulesCount = db.prepare(`
      SELECT COUNT(*) as count FROM group_domain_rules WHERE workspace_id = ?
    `).get(workspaceId);

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

    const rules = db.prepare(`
      SELECT r.id, r.workspace_id, r.domain, r.group_id, r.created_at, g.name as group_name
      FROM group_domain_rules r
      JOIN groups g ON r.group_id = g.id
      WHERE r.workspace_id = ?
      ORDER BY r.created_at DESC
    `).all(workspaceId);

    return ctx.json({ data: rules.map(formatDoc) });
  })
  .post('/:workspaceId/domain-rules', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { domain, groupId } = await ctx.req.json();

    if (!domain || !domain.trim()) return ctx.json({ error: 'Domain is required.' }, 400);
    if (!groupId) return ctx.json({ error: 'Target Group is required.' }, 400);

    const cleanDomain = domain.trim().toLowerCase().replace(/^@/, '');

    const id = randomUUID();
    db.prepare(`
      INSERT OR REPLACE INTO group_domain_rules (id, workspace_id, domain, group_id)
      VALUES (?, ?, ?, ?)
    `).run(id, workspaceId, cleanDomain, groupId);

    logAudit({
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
    db.prepare('DELETE FROM group_domain_rules WHERE id = ? AND workspace_id = ?').run(ruleId, workspaceId);
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

    if (!name || !name.trim()) return ctx.json({ error: 'Group name is required.' }, 400);

    const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-');
    const existing = db.prepare('SELECT id FROM groups WHERE workspace_id = ? AND name = ?').get(workspaceId, cleanName);
    if (existing) {
      return ctx.json({ error: `A group named "${cleanName}" already exists in this workspace.` }, 400);
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO groups (id, workspace_id, name, description, is_default, is_system, group_type, role_mapping)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, workspaceId, cleanName, description.trim(), is_default ? 1 : 0, group_type, role_mapping);

    if (Array.isArray(memberIds) && memberIds.length > 0) {
      for (const uid of memberIds) {
        if (uid) {
          db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, uid);
        }
      }
    }

    logAudit({
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

    const existing = db.prepare('SELECT * FROM groups WHERE id = ? AND workspace_id = ?').get(groupId, workspaceId);
    if (!existing) return ctx.json({ error: 'Group not found.' }, 404);

    let updatedName = existing.name;
    if (name && name.trim()) {
      updatedName = name.trim().toLowerCase().replace(/\s+/g, '-');
    }

    const updatedDesc = description !== undefined ? description : existing.description;
    const updatedDefault = is_default !== undefined ? (is_default ? 1 : 0) : existing.is_default;
    const updatedType = group_type || existing.group_type || 'CUSTOM';
    const updatedRole = role_mapping || existing.role_mapping || 'MEMBER';

    db.prepare(`
      UPDATE groups 
      SET name = ?, description = ?, is_default = ?, group_type = ?, role_mapping = ?
      WHERE id = ? AND workspace_id = ?
    `).run(updatedName, updatedDesc, updatedDefault, updatedType, updatedRole, groupId, workspaceId);

    logAudit({
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
    const members = db.prepare(`
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
    `).all(groupId);

    return ctx.json({ data: members.map(formatDoc) });
  })
  .post('/:workspaceId/:groupId/members', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, groupId } = ctx.req.param();
    const body = await ctx.req.json();
    const userIds = Array.isArray(body.userIds) ? body.userIds : (body.userId ? [body.userId] : []);

    if (userIds.length === 0) {
      return ctx.json({ error: 'At least one user must be selected.' }, 400);
    }

    let addedCount = 0;
    for (const uid of userIds) {
      if (uid) {
        db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(groupId, uid);
        addedCount++;
      }
    }

    logAudit({
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
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/:groupId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { groupId, workspaceId } = ctx.req.param();

    const group = db.prepare('SELECT * FROM groups WHERE id = ? AND workspace_id = ?').get(groupId, workspaceId);
    if (!group) return ctx.json({ error: 'Group not found.' }, 404);

    if (group.is_system === 1 && group.name === 'jira-administrators') {
      return ctx.json({ error: 'The core system group "jira-administrators" cannot be deleted.' }, 400);
    }

    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
    db.prepare('DELETE FROM groups WHERE id = ? AND workspace_id = ?').run(groupId, workspaceId);

    logAudit({
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
