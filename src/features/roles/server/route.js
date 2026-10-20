import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, SYSTEM_PERMISSIONS, d1All, d1First, d1Run, getD1Database } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

// Additional enterprise permission items for Deployments, CMDB & ITSM
export const EXTENDED_PERMISSIONS = [
  ...SYSTEM_PERMISSIONS,
  { code: 'DEPLOYMENT_TRIGGER', name: 'Trigger Deployments', category: 'DEPLOYMENT', description: 'Deploy releases to staging and production' },
  { code: 'DEPLOYMENT_ROLLBACK', name: 'Rollback Deployments', category: 'DEPLOYMENT', description: 'Execute zero-downtime rollbacks for production' },
  { code: 'DORA_METRICS_VIEW', name: 'View DORA Metrics', category: 'DEPLOYMENT', description: 'Inspect DORA 4-Key delivery benchmarks' },
  { code: 'CMDB_ASSET_MANAGE', name: 'Manage CMDB Assets', category: 'CMDB', description: 'Register, edit, and decommission configuration items' },
  { code: 'CMDB_TOPOLOGY_VIEW', name: 'View Infrastructure Topology', category: 'CMDB', description: 'View dependency graphs and blast radius models' },
  { code: 'ITSM_TICKET_MANAGE', name: 'Manage Service Desk Tickets', category: 'ITSM', description: 'Triage, assign, and resolve customer service tickets' },
  { code: 'ITSM_SLA_CONFIGURE', name: 'Configure SLA Policies', category: 'ITSM', description: 'Set service level agreement targets and breach rules' },
];

let tablesEnsured = false;
async function ensureRolesTables(d1, workspaceId = null) {
  if (!d1) return;
  try {
    await d1Run(`
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        is_system INTEGER DEFAULT 0,
        color TEXT DEFAULT '#4f46e5',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, [], d1);

    await d1Run(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id TEXT NOT NULL,
        permission_code TEXT NOT NULL,
        PRIMARY KEY (role_id, permission_code)
      )
    `, [], d1);

    await d1Run(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workspace_id, user_id, role_id)
      )
    `, [], d1);

    // Seed default enterprise roles if workspaceId given and has 0 roles
    if (workspaceId) {
      const existing = await d1First(`SELECT COUNT(*) as c FROM roles WHERE workspace_id = ?`, [workspaceId], d1);
      if ((existing?.c || 0) === 0) {
        await seedDefaultWorkspaceRoles(d1, workspaceId);
      }
    }

    tablesEnsured = true;
  } catch (err) {
    console.error('ensureRolesTables error:', err);
  }
}

async function seedDefaultWorkspaceRoles(d1, workspaceId) {
  const defaultRoles = [
    {
      id: randomUUID(),
      name: 'Company Owner',
      description: 'Superuser sovereignty over entire organization, billing, governance, and RBAC policies.',
      is_system: 1,
      color: '#dc2626',
      all: true
    },
    {
      id: randomUUID(),
      name: 'Company Admin',
      description: 'Full administrative control over day-to-day operations, members, projects, and integrations.',
      is_system: 1,
      color: '#7c3aed',
      perms: EXTENDED_PERMISSIONS.filter(p => !['COMPANY_DELETE', 'COMPANY_OWNERSHIP_TRANSFER'].includes(p.code)).map(p => p.code)
    },
    {
      id: randomUUID(),
      name: 'Project Lead',
      description: 'Engineering manager and squad lead controlling roadmaps, sprint lifecycles, and releases.',
      is_system: 1,
      color: '#2563eb',
      perms: [
        'PROJECT_VIEW', 'PROJECT_UPDATE', 'PROJECT_MEMBER_MANAGE', 'ISSUE_CREATE', 'ISSUE_VIEW', 'ISSUE_UPDATE',
        'ISSUE_DELETE', 'ISSUE_ASSIGN', 'ISSUE_COMMENT', 'BOARD_VIEW', 'BOARD_UPDATE', 'BOARD_MANAGE',
        'SPRINT_CREATE', 'SPRINT_VIEW', 'SPRINT_START', 'SPRINT_COMPLETE', 'DEPLOYMENT_TRIGGER', 'DORA_METRICS_VIEW',
        'CMDB_TOPOLOGY_VIEW', 'REPORT_VIEW', 'DASHBOARD_VIEW', 'DASHBOARD_CREATE'
      ]
    },
    {
      id: randomUUID(),
      name: 'Senior Developer',
      description: 'Software engineer building features, managing board tickets, and deploying staging builds.',
      is_system: 1,
      color: '#059669',
      perms: [
        'PROJECT_VIEW', 'ISSUE_CREATE', 'ISSUE_VIEW', 'ISSUE_UPDATE', 'ISSUE_ASSIGN', 'ISSUE_COMMENT',
        'ISSUE_ATTACHMENT', 'ISSUE_LINK', 'BOARD_VIEW', 'SPRINT_VIEW', 'DEPLOYMENT_TRIGGER', 'DORA_METRICS_VIEW',
        'CMDB_TOPOLOGY_VIEW', 'DASHBOARD_VIEW'
      ]
    },
    {
      id: randomUUID(),
      name: 'Quality Assurance (QA)',
      description: 'Test engineer verifying issue acceptance, tracking bugs, and approving release readiness.',
      is_system: 1,
      color: '#d97706',
      perms: [
        'PROJECT_VIEW', 'ISSUE_CREATE', 'ISSUE_VIEW', 'ISSUE_UPDATE', 'ISSUE_COMMENT', 'ISSUE_ATTACHMENT',
        'BOARD_VIEW', 'SPRINT_VIEW', 'DORA_METRICS_VIEW', 'DASHBOARD_VIEW'
      ]
    },
    {
      id: randomUUID(),
      name: 'DevOps & SRE Engineer',
      description: 'Site reliability and infrastructure engineer managing CMDB topology, deployments, and rollbacks.',
      is_system: 1,
      color: '#0891b2',
      perms: [
        'PROJECT_VIEW', 'DEPLOYMENT_TRIGGER', 'DEPLOYMENT_ROLLBACK', 'DORA_METRICS_VIEW', 'CMDB_ASSET_MANAGE',
        'CMDB_TOPOLOGY_VIEW', 'AUDIT_LOG_VIEW', 'INTEGRATION_VIEW', 'INTEGRATION_MANAGE', 'DASHBOARD_VIEW'
      ]
    },
    {
      id: randomUUID(),
      name: 'ITSM Support Agent',
      description: 'Customer support specialist triaging customer service requests and meeting SLA targets.',
      is_system: 1,
      color: '#4f46e5',
      perms: [
        'PROJECT_VIEW', 'ISSUE_VIEW', 'ISSUE_CREATE', 'ISSUE_COMMENT', 'ITSM_TICKET_MANAGE', 'ITSM_SLA_CONFIGURE',
        'DASHBOARD_VIEW'
      ]
    },
    {
      id: randomUUID(),
      name: 'Read-Only Viewer',
      description: 'Observer or external compliance auditor with view-only permissions.',
      is_system: 1,
      color: '#6b7280',
      perms: ['PROJECT_VIEW', 'ISSUE_VIEW', 'BOARD_VIEW', 'DORA_METRICS_VIEW', 'CMDB_TOPOLOGY_VIEW', 'DASHBOARD_VIEW']
    }
  ];

  for (const role of defaultRoles) {
    await d1Run(`
      INSERT INTO roles (id, workspace_id, name, description, is_system, color)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [role.id, workspaceId, role.name, role.description, role.is_system, role.color], d1);

    const permsToAdd = role.all ? EXTENDED_PERMISSIONS.map(p => p.code) : (role.perms || []);
    for (const code of permsToAdd) {
      await d1Run(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
        VALUES (?, ?)
      `, [role.id, code], d1);
    }
  }
}

const app = new Hono()
  // 1. Full RBAC Permission Matrix & Stats Endpoint
  .get('/:workspaceId/matrix', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    const roles = await d1All(`
      SELECT * FROM roles 
      WHERE workspace_id = ?
      ORDER BY is_system DESC, created_at ASC
    `, [workspaceId], d1);

    const rolesWithPerms = await Promise.all(
      roles.map(async (role) => {
        const perms = await d1All(`
          SELECT permission_code FROM role_permissions WHERE role_id = ?
        `, [role.id], d1);

        const countRow = await d1First(`
          SELECT COUNT(*) as c FROM user_roles WHERE role_id = ? AND workspace_id = ?
        `, [role.id, workspaceId], d1);

        return {
          ...formatDoc(role),
          permissions: role.name === 'Company Owner' ? EXTENDED_PERMISSIONS.map(p => p.code) : perms.map((p) => p.permission_code),
          userCount: countRow?.c || 0,
        };
      })
    );

    // Group permissions by category
    const categoriesMap = {};
    for (const p of EXTENDED_PERMISSIONS) {
      if (!categoriesMap[p.category]) {
        categoriesMap[p.category] = [];
      }
      categoriesMap[p.category].push(p);
    }

    const totalAssignedUsers = (await d1First(`
      SELECT COUNT(DISTINCT user_id) as c FROM user_roles WHERE workspace_id = ?
    `, [workspaceId], d1))?.c || 0;

    const ownersCount = rolesWithPerms.find(r => r.name === 'Company Owner')?.userCount || 1;
    const adminsCount = rolesWithPerms.find(r => r.name === 'Company Admin')?.userCount || 0;

    // Dynamic Least-Privilege Compliance Score
    const nonOwnerRoles = rolesWithPerms.filter(r => r.name !== 'Company Owner');
    const totalGrantedNonOwner = nonOwnerRoles.reduce((sum, r) => sum + (r.permissions ? r.permissions.length : 0), 0);
    const maxPotentialPerms = nonOwnerRoles.length * EXTENDED_PERMISSIONS.length;
    const grantRatio = maxPotentialPerms > 0 ? (totalGrantedNonOwner / maxPotentialPerms) : 0.2;
    const securityPostureScore = Math.max(50, Math.min(100, Math.round(100 - (grantRatio * 40))));

    return ctx.json({
      data: {
        roles: rolesWithPerms,
        categories: categoriesMap,
        allPermissions: EXTENDED_PERMISSIONS,
        stats: {
          totalRoles: rolesWithPerms.length,
          totalPermissions: EXTENDED_PERMISSIONS.length,
          totalAssignedUsers,
          ownersCount,
          adminsCount,
          securityPostureScore
        }
      }
    });
  })

  // 2. Toggle single permission for a role in real-time
  .post('/:workspaceId/toggle-permission', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { roleId, permissionCode, granted } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    const role = await d1First('SELECT * FROM roles WHERE id = ? AND workspace_id = ?', [roleId, workspaceId], d1);
    if (!role) return ctx.json({ error: 'Role not found.' }, 404);

    if (role.name === 'Company Owner') {
      return ctx.json({ error: 'Company Owner permissions are immutable and protected.' }, 400);
    }

    if (granted) {
      await d1Run(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
        VALUES (?, ?)
      `, [roleId, permissionCode], d1);
    } else {
      await d1Run(`
        DELETE FROM role_permissions 
        WHERE role_id = ? AND permission_code = ?
      `, [roleId, permissionCode], d1);
    }

    return ctx.json({
      success: true,
      roleId,
      permissionCode,
      granted: Boolean(granted)
    });
  })

  // 3. List workspace members with their assigned roles
  .get('/:workspaceId/members', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    const members = await d1All(`
      SELECT 
        m.id as member_id,
        m.user_id,
        m.role as legacy_role,
        u.name,
        u.email,
        r.id as role_id,
        r.name as role_name,
        r.color as role_color
      FROM members m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.workspace_id = m.workspace_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE m.workspace_id = ?
      ORDER BY u.name ASC
    `, [workspaceId], d1);

    return ctx.json({ data: members.map(formatDoc) });
  })

  // 4. Assign user to role
  .post('/:workspaceId/assign-user', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { userId, roleId } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    if (!userId || !roleId) {
      return ctx.json({ error: 'userId and roleId are required.' }, 400);
    }

    const role = await d1First(`SELECT name FROM roles WHERE id = ? AND workspace_id = ?`, [roleId, workspaceId], d1);
    if (!role) return ctx.json({ error: 'Target role not found.' }, 404);

    // Remove existing role assignments in this workspace for this user
    await d1Run(`DELETE FROM user_roles WHERE workspace_id = ? AND user_id = ?`, [workspaceId, userId], d1);

    const id = randomUUID();
    await d1Run(`
      INSERT INTO user_roles (id, workspace_id, user_id, role_id)
      VALUES (?, ?, ?, ?)
    `, [id, workspaceId, userId, roleId], d1);

    return ctx.json({ success: true, message: `Assigned user to ${role.name}` });
  })

  // 5. Standard GET roles for workspace (backward compatibility)
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    const roles = await d1All(`
      SELECT * FROM roles 
      WHERE workspace_id = ?
      ORDER BY is_system DESC, created_at ASC
    `, [workspaceId], d1);

    const rolesWithPerms = await Promise.all(
      roles.map(async (role) => {
        const perms = await d1All(`
          SELECT permission_code FROM role_permissions WHERE role_id = ?
        `, [role.id], d1);

        const countRow = await d1First(`
          SELECT COUNT(*) as c FROM user_roles WHERE role_id = ? AND workspace_id = ?
        `, [role.id, workspaceId], d1);

        return {
          ...formatDoc(role),
          permissions: role.name === 'Company Owner' ? EXTENDED_PERMISSIONS.map(p => p.code) : perms.map((p) => p.permission_code),
          userCount: countRow?.c || 0,
        };
      })
    );

    return ctx.json({
      data: {
        roles: rolesWithPerms,
        allPermissions: EXTENDED_PERMISSIONS,
      },
    });
  })

  // 6. Create custom role
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', permissions = [], color = '#4f46e5' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    if (!name || !name.trim()) {
      return ctx.json({ error: 'Role name is required.' }, 400);
    }

    const cleanName = name.trim();
    const existing = await d1First('SELECT id FROM roles WHERE workspace_id = ? AND name = ?', [workspaceId, cleanName], d1);
    if (existing) {
      return ctx.json({ error: 'A role with this name already exists in this workspace.' }, 400);
    }

    const roleId = randomUUID();
    await d1Run(`
      INSERT INTO roles (id, workspace_id, name, description, is_system, color)
      VALUES (?, ?, ?, ?, 0, ?)
    `, [roleId, workspaceId, cleanName, description, color], d1);

    for (const code of permissions) {
      await d1Run(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
        VALUES (?, ?)
      `, [roleId, code], d1);
    }

    return ctx.json({ data: { id: roleId, name: cleanName, description, permissions, color } }, 201);
  })

  // 7. Update batch role permissions
  .put('/:workspaceId/:roleId/permissions', sessionMiddleware, async (ctx) => {
    const { workspaceId, roleId } = ctx.req.param();
    const { permissions = [] } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    const role = await d1First('SELECT * FROM roles WHERE id = ? AND workspace_id = ?', [roleId, workspaceId], d1);
    if (!role) return ctx.json({ error: 'Role not found.' }, 404);

    if (role.name === 'Company Owner') {
      return ctx.json({ error: 'Company Owner permissions cannot be modified.' }, 400);
    }

    await d1Run('DELETE FROM role_permissions WHERE role_id = ?', [roleId], d1);

    for (const code of permissions) {
      await d1Run(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
        VALUES (?, ?)
      `, [roleId, code], d1);
    }

    return ctx.json({ success: true, permissions });
  })

  // 8. Delete custom role
  .delete('/:workspaceId/:roleId', sessionMiddleware, async (ctx) => {
    const { workspaceId, roleId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    const role = await d1First('SELECT * FROM roles WHERE id = ? AND workspace_id = ?', [roleId, workspaceId], d1);
    if (!role) return ctx.json({ error: 'Role not found.' }, 404);

    if (role.is_system) {
      return ctx.json({ error: 'System roles cannot be deleted.' }, 400);
    }

    await d1Run('DELETE FROM user_roles WHERE role_id = ?', [roleId], d1);
    await d1Run('DELETE FROM role_permissions WHERE role_id = ?', [roleId], d1);
    await d1Run('DELETE FROM roles WHERE id = ?', [roleId], d1);

    return ctx.json({ success: true, message: `Role ${role.name} deleted.` });
  })

  // 9. Reset / Seed enterprise standard RBAC matrix
  .post('/:workspaceId/seed-sample', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureRolesTables(d1, workspaceId);

    // Clean existing custom roles & permissions (keep user_roles intact where possible)
    await d1Run(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE workspace_id = ?)`, [workspaceId], d1);
    await d1Run(`DELETE FROM roles WHERE workspace_id = ?`, [workspaceId], d1);

    await seedDefaultWorkspaceRoles(d1, workspaceId);

    return ctx.json({
      success: true,
      message: 'Enterprise 8-Role standard RBAC Matrix seeded successfully.'
    });
  });

export default app;
